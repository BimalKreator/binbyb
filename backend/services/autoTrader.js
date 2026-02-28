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
  const [binanceActualBalance, bybitActualBalance] = await Promise.all([
    binanceManager.getBalance(credentials.binance),
    bybitManager.getBalance(),
  ]);
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
 * Quantity from: tradeNotionalValue = allocatedMargin * leverage, then quantity = tradeNotionalValue / currentTokenPrice.
 * Round down to exchange stepSize; split into chunks if exceeds maxOrderQty.
 * @param {number} allocatedMargin - margin allocated for this trade (baseCapital * capitalPercent/100)
 * @param {number} leverage - user's leverage (e.g. 10)
 * @param {number} currentTokenPrice - mark/current price for the token
 * @param {string} symbol - e.g. BTCUSDT
 * @returns {Promise<{ chunks: string[], stepSize: string | null }>} formatted qty strings per chunk
 */
async function computeQuantityChunks(allocatedMargin, leverage, currentTokenPrice, symbol) {
  if (!Number.isFinite(allocatedMargin) || allocatedMargin <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(currentTokenPrice) || currentTokenPrice <= 0) {
    return { chunks: [], stepSize: null };
  }
  const tradeNotionalValue = allocatedMargin * leverage;
  let quantity = tradeNotionalValue / currentTokenPrice;
  const sym = String(symbol).toUpperCase();

  const [binanceFilters, bybitFilters] = await Promise.all([
    binanceManager.getSymbolFilters(sym),
    bybitManager.getSymbolFilters(sym),
  ]);

  const stepBinance = binanceFilters?.stepSize;
  const stepBybit = bybitFilters?.stepSize;
  let maxBinance = parseFloat(binanceFilters?.maxOrderQty || "0") || Infinity;
  let maxBybit = parseFloat(bybitFilters?.maxOrderQty || "0") || Infinity;
  let maxPerOrder = Math.min(maxBinance, maxBybit);
  if (maxPerOrder <= 0) maxPerOrder = Infinity;

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

  const bannedSet = new Set((settings.bannedTokens || []).map((s) => String(s).toUpperCase()));
  const eligible = rankedTokens.filter((t) => !bannedSet.has(String(t.symbol).toUpperCase()));
  if (eligible.length === 0) return;

  const top = eligible[0];
  const symbol = top.symbol;
  const entryTimeMs = Math.max(0, Number(settings.entryTimeMs) ?? 1000);
  const nextFundingTime = top.nextFundingTime;
  if (nextFundingTime == null || !Number.isFinite(nextFundingTime)) return;
  const now = Date.now();
  const countdownMs = nextFundingTime - now;

  if (countdownMs > entryTimeMs) {
    return; // Silently wait, too early
  }
  const windowEndMs = Math.max(0, entryTimeMs - STRICT_ENTRY_WINDOW_MS);
  if (countdownMs < windowEndMs) {
    console.log(`[AutoTrader] Skipped: ${symbol} missed the strict entry window. Waiting for next cycle.`);
    return;
  }
  if (tradedCycles[symbol] === nextFundingTime) {
    console.log(`[AutoTrader] Skipped: ${symbol} already traded for this cycle. Waiting for next funding.`);
    return;
  }
  const cooldownMs = (settings?.cooldownMinutes ?? 15) * 60 * 1000;
  const lastTrade = await TradeLog.findOne({ symbol }).sort({ exitTime: -1 }).lean();
  if (lastTrade?.exitTime && (Date.now() - new Date(lastTrade.exitTime).getTime()) < cooldownMs) {
    console.log(`[AutoTrader] Cooldown: ${symbol} recently closed. Waiting ${settings?.cooldownMinutes ?? 15} min before re-entry.`);
    return;
  }
  if (countdownMs <= 0) {
    console.log(`[AutoTrader] Skipping: ${symbol} countdown expired (${countdownMs}ms <= 0).`);
    return;
  }

  console.log(`[AutoTrader] Executing trade for ${symbol}...`);

  if (lastEntryTimeBySymbol[top.symbol] && now - lastEntryTimeBySymbol[top.symbol] < ENTRY_BUFFER_MS) {
    return; // buffer: skip
  }

  const allocatedMargin = await getAllocatedMargin(keys);
  if (allocatedMargin <= 0) return;

  const markPrice = top.markPrice ?? 0;
  if (!markPrice || !Number.isFinite(markPrice)) return;

  const levInt = Math.max(1, Math.min(125, Number(settings.leverage) || DEFAULT_LEVERAGE));
  const { chunks } = await computeQuantityChunks(allocatedMargin, levInt, markPrice, top.symbol);
  if (chunks.length === 0) return;

  const { binanceSide, bybitSide } = getSidesFromToken(top);
  const slippagePct = Number.isFinite(settings.entrySlippagePct) ? Math.max(0, Math.min(100, settings.entrySlippagePct)) : 2;

  const [binanceOrderbookPrice, bybitOrderbookPrice] = await Promise.all([
    binanceManager.getOrderbookPrice(top.symbol, binanceSide, slippagePct),
    bybitManager.getOrderbookPrice(top.symbol, bybitSide, slippagePct),
  ]);
  const binancePrice = Number.isFinite(binanceOrderbookPrice) && binanceOrderbookPrice > 0
    ? binanceOrderbookPrice
    : markPrice;
  const bybitPrice = Number.isFinite(bybitOrderbookPrice) && bybitOrderbookPrice > 0
    ? bybitOrderbookPrice
    : markPrice;

  isExecutingTrade = true;
  try {
    for (const qtyStr of chunks) {
      if (!orderCircuitBreaker.canPlaceOrder()) {
        console.error("[AutoTrader] Order circuit breaker: trading paused, skipping entry", top.symbol);
        break;
      }
      const qty = parseFloat(qtyStr);
      if (qty <= 0) continue;
      try {
        // Sequential execution: Bybit first (primary leg), then Binance only if Bybit succeeds.
        let bybitResult;
        try {
          bybitResult = await bybitManager.placeIOCLimitOrder(keys.bybit, top.symbol, bybitSide, qty, bybitPrice, { leverage: levInt });
          orderCircuitBreaker.recordOrderPlaced();
        } catch (e) {
          console.log("[Entry-Logic] Bybit failed, skipping Binance to save fees.", top.symbol, e?.message ?? e);
          break;
        }
        const orderId = bybitResult?.result?.orderId ?? bybitResult?.orderId;
        if (!orderId) {
          console.log("[Entry-Logic] Bybit returned no orderId, skipping Binance to save fees.", top.symbol);
          break;
        }
        const filledQty = await bybitManager.getOrderFilledQty(keys.bybit, orderId);
        const binanceQty = filledQty > 0 ? filledQty : qty;
        if (filledQty > 0 && filledQty < qty) {
          console.log("[AutoTrader] Bybit partial fill", top.symbol, "requested", qty, "filled", filledQty, "- Binance matching", binanceQty);
        }
        if (binanceQty <= 0) {
          console.log("[Entry-Logic] Bybit filled 0, skipping Binance.", top.symbol);
          break;
        }
        await binanceManager.placeIOCLimitOrder(keys.binance, top.symbol, binanceSide, binanceQty, binancePrice, { leverage: levInt });
        orderCircuitBreaker.recordOrderPlaced();
        tradedCycles[symbol] = nextFundingTime;
        console.log(`[AutoTrader] Locked ${symbol} for the current cycle. Will not re-enter until next funding time.`);
        lastEntryTimeBySymbol[top.symbol] = now;
        entryFundingDirectionBySymbol[top.symbol] = { binanceHigher: Number(top.fundingBinance) > Number(top.fundingBybit) };
        console.log("[AutoTrader] Entry", top.symbol, binanceSide, bybitSide, "qty", binanceQty === qty ? qtyStr : String(binanceQty));
      } catch (e) {
        console.error("[AutoTrader] Entry failed", top.symbol, e.message || e);
        break; // no retry — single attempt per chunk to avoid rate limits
      }
    }
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

/** Symbols whose trade lock expiry (nextFundingTime) is still in the future. */
function getCoolingTokens() {
  const now = Date.now();
  return Object.entries(tradedCycles)
    .filter(([, expiry]) => Number(expiry) > now)
    .map(([sym]) => String(sym).toUpperCase());
}

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
