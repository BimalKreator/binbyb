/**
 * Auto trader: capital calculation, quantity rounding/splitting, and entry execution
 * using screener rankedTokens and 2nd-row orderbook pricing.
 */

const Setting = require("../models/Setting");
const TradeLog = require("../models/TradeLog");
const { getDecryptedApiKeys } = require("./apiKeys");
const { binanceManager, bybitManager } = require("./exchanges");
const screener = require("./screener");
const orderCircuitBreaker = require("./orderCircuitBreaker");

const ENTRY_BUFFER_MS = 60 * 1000; // 60 seconds per symbol before re-entry
const STRICT_ENTRY_WINDOW_MS = 120000; // 2-minute window: only enter when countdown in [entryTimeMs - 2min, entryTimeMs]
const DEFAULT_LEVERAGE = 5;

/** Cycle key last executed (to avoid double entry same cycle). */
let lastFiredCycleKey = null;

/** Global execution lock: prevents concurrent trades before DB/WS registers the first. */
let isExecutingTrade = false;

/** Last entry timestamp per symbol to enforce buffer */
const lastEntryTimeBySymbol = {};

/** Cycle lock: symbol -> nextFundingTime. Prevents re-entry after exit until next funding. */
const tradedCycles = {};

/** Entry funding direction per symbol for funding-flip exit: { binanceHigher: boolean } */
const entryFundingDirectionBySymbol = {};

function decimalsFromStep(stepSize) {
  const s = String(stepSize);
  if (!s || s.includes("e")) return 8;
  const i = s.indexOf(".");
  if (i === -1) return 0;
  return s.length - i - 1;
}

/** Round quantity down to stepSize and format string */
function floorToStepSize(quantity, stepSize) {
  const step = parseFloat(stepSize);
  if (!Number.isFinite(step) || step <= 0) return parseFloat(quantity) || 0;
  const q = parseFloat(quantity);
  if (!Number.isFinite(q) || q <= 0) return 0;
  const precision = decimalsFromStep(stepSize);
  const rounded = Math.floor(q / step) * step;
  return parseFloat(rounded.toFixed(precision));
}

/**
 * Base capital = min(Actual Balance Binance, Actual Balance Bybit).
 * Actual Balance = Total Wallet Balance / Equity (NOT Available/Free). No subtraction of margin used.
 * Allocated margin per trade = baseCapital * (capitalPercent / 100). Every trade gets the same size.
 */
async function getAllocatedMargin(credentials) {
  const [binanceRes, bybitRes] = await Promise.all([
    binanceManager.getBalance(credentials.binance),
    bybitManager.getBalance(),
  ]);
  const binanceActualBalance = Number(binanceRes?.balance ?? binanceRes) || 0;
  const bybitActualBalance = Number(bybitRes?.balance ?? bybitRes) || 0;
  const baseCapital = Math.min(
    Number.isFinite(binanceActualBalance) ? binanceActualBalance : 0,
    Number.isFinite(bybitActualBalance) ? bybitActualBalance : 0
  );
  const settings = await Setting.findOne().lean();
  const capitalPercent = Math.max(0, Math.min(100, Number(settings?.capitalPercent) || 0));
  const allocatedMargin = baseCapital * (capitalPercent / 100);
  return allocatedMargin;
}

/**
 * Quantity chunks for a given notional (e.g. for tradeMonitor exit). Not used by runAutoEntry (sweeper uses totalQuantity).
 * @returns {Promise<{ chunks: string[], stepSize: string | null }>}
 */
async function computeQuantityChunks(allocatedMargin, leverage, currentTokenPrice, symbol) {
  if (!Number.isFinite(allocatedMargin) || allocatedMargin <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(currentTokenPrice) || currentTokenPrice <= 0) {
    return { chunks: [], stepSize: null };
  }
  const quantity = (allocatedMargin * leverage) / currentTokenPrice;
  const sym = String(symbol).toUpperCase();
  const [binanceFilters, bybitFilters] = await Promise.all([
    binanceManager.getSymbolFilters(sym),
    bybitManager.getSymbolFilters(sym),
  ]);
  const stepBinance = binanceFilters?.stepSize;
  const stepBybit = bybitFilters?.stepSize;
  let maxBinance = parseFloat(binanceFilters?.maxOrderQty || "0") || Infinity;
  let maxBybit = parseFloat(bybitFilters?.maxOrderQty || "0") || Infinity;
  const maxPerOrder = (maxBinance <= 0 || maxBybit <= 0) ? Infinity : Math.min(maxBinance, maxBybit);
  let qtyValidBoth = quantity;
  if (stepBinance) qtyValidBoth = Math.min(qtyValidBoth, floorToStepSize(quantity, stepBinance));
  if (stepBybit) qtyValidBoth = Math.min(qtyValidBoth, floorToStepSize(quantity, stepBybit));
  if (qtyValidBoth <= 0) return { chunks: [], stepSize: stepBinance || stepBybit };
  const stepSize = stepBinance || stepBybit;
  const precision = stepSize ? decimalsFromStep(stepSize) : 8;
  const chunks = [];
  let remaining = qtyValidBoth;
  while (remaining > 0 && chunks.length < 20) {
    const chunk = Math.min(remaining, maxPerOrder);
    const chunkFloored = stepSize ? floorToStepSize(chunk, stepSize) : chunk;
    if (chunkFloored <= 0) break;
    chunks.push(chunkFloored.toFixed(precision));
    remaining -= chunkFloored;
  }
  return { chunks, stepSize };
}

/**
 * Count symbols that have an open position on both exchanges (arbitrage pairs).
 * Synchronous, in-memory only: uses getLivePositions() (no REST).
 */
function getOpenArbitrageCount() {
  const binanceList = binanceManager.getLivePositions() || [];
  const bybitList = bybitManager.getLivePositions() || [];
  const binanceSymbols = new Set(
    binanceList
      .filter((p) => Math.abs(parseFloat(p?.positionAmt ?? 0) || 0) > 0)
      .map((p) => String(p?.symbol ?? "").toUpperCase())
      .filter(Boolean)
  );
  const bybitSymbols = new Set(
    bybitList
      .filter((p) => Math.abs(parseFloat(p?.positionAmt ?? 0) || 0) > 0)
      .map((p) => String(p?.symbol ?? "").toUpperCase())
      .filter(Boolean)
  );
  return [...binanceSymbols].filter((s) => bybitSymbols.has(s)).length;
}

/**
 * Determine sides from funding: if Binance rate > Bybit rate -> Short Binance & Long Bybit.
 */
function getSidesFromToken(token) {
  const bin = Number(token.fundingBinance);
  const byb = Number(token.fundingBybit);
  const binanceHigher = Number.isFinite(bin) && Number.isFinite(byb) && bin > byb;
  return {
    binanceSide: binanceHigher ? "SELL" : "BUY",
    bybitSide: binanceHigher ? "Buy" : "Sell",
  };
}

function calculateLiveEntrySpread(symbol, binanceSide) {
  const binanceBook = binanceManager.getTopOfBook(symbol);
  const bybitBook = bybitManager.getTopOfBook(symbol);
  if (!binanceBook || !bybitBook) return null;
  if (binanceSide === "SELL") {
    return ((binanceBook.topBidPrice - bybitBook.topAskPrice) / bybitBook.topAskPrice) * 100;
  }
  if (binanceSide === "BUY") {
    return ((bybitBook.topBidPrice - binanceBook.topAskPrice) / binanceBook.topAskPrice) * 100;
  }
  return null;
}

/**
 * Execute one auto entry: top token from screener, orderbook pricing, place IOC on both exchanges.
 * Entry only when autoTradeEnabled and timeRemaining in (0, entryTimeMs].
 */
async function runAutoEntry() {
  if (isExecutingTrade) return;

  const settings = await Setting.findOne().lean();
  if (!settings?.autoTradeEnabled) {
    console.log("[AutoTrader] Blocked: Auto Trade is disabled in settings.");
    return;
  }

  const keys = await getDecryptedApiKeys();
  if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
    return;
  }

  const maxTrades = Math.max(0, Number(settings.maxTrades) || 0);
  const openCount = getOpenArbitrageCount();
  if (openCount >= maxTrades) return;

  const rankedTokens = screener.getRankedTokens();
  if (!rankedTokens || rankedTokens.length === 0) return;

  const allowedIntervals = settings?.allowedIntervals?.length > 0 ? settings.allowedIntervals : [1, 2, 4, 8];
  const bannedSet = new Set((settings.bannedTokens || []).map((s) => String(s).toUpperCase()));
  const eligible = rankedTokens.filter((t) => {
    if (bannedSet.has(String(t.symbol).toUpperCase())) return false;
    const tokenInterval = parseInt(String(t.intervalHours ?? t.interval ?? "8"), 10) || 8;
    if (!allowedIntervals.includes(tokenInterval)) return false;
    return true;
  });
  if (eligible.length === 0) return;

  let selectedToken = null;
  let selectedBinanceSide = null;
  let selectedBybitSide = null;
  const entryTimeMs = Math.max(0, Number(settings.entryTimeMs) ?? 1000);
  const windowEndMs = Math.max(0, entryTimeMs - STRICT_ENTRY_WINDOW_MS);
  const cooldownMs = (settings?.cooldownMinutes ?? 15) * 60 * 1000;
  const minL2Spread = Number(settings?.minL2Spread) ?? 0.15;
  const minFundingSpread = Number(settings?.minFundingSpread) ?? 0.15;
  const now = Date.now();

  // Hunt in the top 10 eligible tokens
  for (const token of eligible.slice(0, 10)) {
    const sym = token.symbol;
    const nextFundingTime = token.nextFundingTime;
    if (nextFundingTime == null || !Number.isFinite(nextFundingTime)) continue;

    const countdownMs = nextFundingTime - now;

    if (countdownMs < windowEndMs) continue; // Missed strict window
    if (tradedCycles[sym] === nextFundingTime) continue; // Already traded
    if (countdownMs <= 0 || countdownMs > entryTimeMs) continue; // Expired or Too early
    if ((token.spreadPctAbs || 0) < minFundingSpread) continue; // Use Absolute gap for bot filter
    if (lastEntryTimeBySymbol[sym] && now - lastEntryTimeBySymbol[sym] < ENTRY_BUFFER_MS) continue;

    // Await inside loop is fine here as it's limited to 10 iterations max
    const lastTrade = await TradeLog.findOne({ symbol: sym }).sort({ exitTime: -1 }).lean();
    if (lastTrade?.exitTime && (Date.now() - new Date(lastTrade.exitTime).getTime()) < cooldownMs) continue;

    const { binanceSide, bybitSide } = getSidesFromToken(token);
    const currentSpread = calculateLiveEntrySpread(sym, binanceSide);

    if (currentSpread === null || currentSpread < minL2Spread) {
      continue; // Keep hunting
    }

    // Found the perfect token!
    selectedToken = token;
    selectedBinanceSide = binanceSide;
    selectedBybitSide = bybitSide;
    break;
  }

  if (!selectedToken) {
    // Silent return if no token in top 10 meets criteria to avoid log spam
    return;
  }

  const top = selectedToken;
  const symbol = top.symbol;
  const binanceSide = selectedBinanceSide;
  const bybitSide = selectedBybitSide;
  const nextFundingTime = top.nextFundingTime;

  const allocatedMargin = await getAllocatedMargin(keys);
  if (allocatedMargin <= 0) return;

  const markPrice = top.markPrice ?? 0;
  if (!markPrice || !Number.isFinite(markPrice)) return;

  const levInt = Math.max(1, Math.min(125, Number(settings.leverage) || DEFAULT_LEVERAGE));
  let totalQuantity = (allocatedMargin * levInt) / markPrice;
  const sym = String(top.symbol).toUpperCase();
  const [binanceFilters, bybitFilters] = await Promise.all([
    binanceManager.getSymbolFilters(sym),
    bybitManager.getSymbolFilters(sym),
  ]);
  const stepSize = binanceFilters?.stepSize || bybitFilters?.stepSize;
  if (stepSize) totalQuantity = floorToStepSize(totalQuantity, stepSize);
  const maxB = parseFloat(binanceFilters?.maxOrderQty || "0") || Infinity;
  const maxY = parseFloat(bybitFilters?.maxOrderQty || "0") || Infinity;
  const maxOrderQty = (maxB <= 0 || maxY <= 0) ? Infinity : Math.min(maxB, maxY);
  if (Number.isFinite(maxOrderQty)) totalQuantity = Math.min(totalQuantity, maxOrderQty);
  if (totalQuantity <= 0) return;

  const cycleKey = `${symbol}_${nextFundingTime}`;
  if (lastFiredCycleKey === cycleKey) return;

  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[AutoTrader] Order circuit breaker: trading paused, skipping entry", top.symbol);
    return;
  }

  isExecutingTrade = true;
  try {
    const finalSpread = calculateLiveEntrySpread(top.symbol, binanceSide);
    if (finalSpread === null || finalSpread < 0) {
        console.warn(`[AutoTrader-Failsafe] Aborting execution for ${top.symbol}! Final L2 Expected Spread dropped below 0 (${finalSpread}%).`);
        isExecutingTrade = false;
        return;
    }

    try {
      await bybitManager.setLeverage(keys.bybit, top.symbol, levInt);
      await binanceManager.setLeverage(keys.binance, top.symbol, levInt);
    } catch (levErr) {
      console.warn("[AutoTrader] setLeverage warning", top.symbol, levErr?.message ?? levErr);
    }
    console.log(`[AutoTrader] Initiating Interleaved Sweep for ${totalQuantity} ${top.symbol}...`);
    let remainingQty = totalQuantity;
    let totalBybitFilled = 0;
    let totalBinanceFilled = 0;
    let maxSweeps = 500;

    while (remainingQty > 0 && maxSweeps > 0) {
      const bybitRes = await bybitManager.executeLiquiditySweep(keys.bybit, top.symbol, bybitSide, remainingQty, levInt, 1);
      const chunkFilled = bybitRes?.totalFilled || 0;

      if (chunkFilled <= 0) {
        console.log(`[AutoTrader] Bybit chunk filled 0. Waiting 100ms for liquidity...`);
        await new Promise((r) => setTimeout(r, 100));
        maxSweeps--;
        continue;
      }

      orderCircuitBreaker.recordOrderPlaced();
      totalBybitFilled += chunkFilled;
      remainingQty -= chunkFilled;

      let binanceRemaining = chunkFilled;
      let binanceFailsafe = 100;
      while (binanceRemaining > 0 && binanceFailsafe > 0) {
        const binanceRes = await binanceManager.executeLiquiditySweep(keys.binance, top.symbol, binanceSide, binanceRemaining, levInt, 5);
        const bFilled = binanceRes?.totalFilled || 0;

        if (bFilled > 0) orderCircuitBreaker.recordOrderPlaced();

        totalBinanceFilled += bFilled;
        binanceRemaining -= bFilled;

        if (binanceRemaining > 0) {
          console.log(`[AutoTrader] Binance partial fill. Remaining: ${binanceRemaining}. Waiting 100ms...`);
          await new Promise((r) => setTimeout(r, 100));
        }
        binanceFailsafe--;
      }

      if (binanceRemaining > 0) {
        console.error("Failsafe reached: Binance failed to match. Aborting outer sweep to prevent imbalance.");
        break;
      }

      maxSweeps--;
    }

    if (totalBybitFilled <= 0) {
      console.log(`[AutoTrader] Sweep failed or 0 filled on Bybit for ${top.symbol}. Aborting.`);
      isExecutingTrade = false;
      return;
    }

    lastFiredCycleKey = cycleKey;
    tradedCycles[symbol] = nextFundingTime;
    lastEntryTimeBySymbol[top.symbol] = Date.now();
    entryFundingDirectionBySymbol[top.symbol] = { binanceHigher: Number(top.fundingBinance) > Number(top.fundingBybit) };
    console.log("[AutoTrader] Entry (liquidity sweep)", top.symbol, binanceSide, bybitSide, "bybitFilled", totalBybitFilled);
  } finally {
    isExecutingTrade = false;
  }
}

/**
 * Start the auto trader loop (e.g. run every 30s when autoTrade is on).
 */
let intervalId = null;

function start(intervalMs = 1000) {
  if (intervalId) return;
  intervalId = setInterval(runAutoEntry, intervalMs);
  console.log("[AutoTrader] Started, interval", intervalMs, "ms");
}

function stop() {
  lastFiredCycleKey = null;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log("[AutoTrader] Stopped.");
}

/** Get entry funding direction for a symbol (for funding-flip exit). Returns { binanceHigher } or null. */
function getEntryFundingDirection(symbol) {
  const key = String(symbol || "").toUpperCase();
  return entryFundingDirectionBySymbol[key] ?? null;
}

/** Clear entry direction when a pair is closed (e.g. by monitor). */
function clearEntryFundingDirection(symbol) {
  const key = String(symbol || "").toUpperCase();
  delete entryFundingDirectionBySymbol[key];
}

/** Symbols whose trade lock expiry is still in the future (same as tradedCycles). */
const getCoolingTokens = () => {
  const now = Date.now();
  return Object.keys(tradedCycles).filter((symbol) => tradedCycles[symbol] > now);
};

module.exports = {
  getAllocatedMargin,
  getTradeCapital: getAllocatedMargin,
  computeQuantityChunks,
  getOpenArbitrageCount,
  getEntryFundingDirection,
  clearEntryFundingDirection,
  getCoolingTokens,
  runAutoEntry,
  start,
  stop,
};
