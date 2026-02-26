/**
 * Auto trader: capital calculation, quantity rounding/splitting, and entry execution
 * using screener rankedTokens and 2nd-row orderbook pricing.
 */

const Setting = require("../models/Setting");
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
 * Capital: Min(Binance_USDT, Bybit_USDT) * (Settings.capitalPercent / 100)
 */
async function getTradeCapital(credentials) {
  const [binanceUSDT, bybitUSDT] = await Promise.all([
    binanceManager.getBalance(credentials.binance),
    bybitManager.getBalance(),
  ]);
  const minBalance = Math.min(
    Number.isFinite(binanceUSDT) ? binanceUSDT : 0,
    Number.isFinite(bybitUSDT) ? bybitUSDT : 0
  );
  const settings = await Setting.findOne().lean();
  const pct = Math.max(0, Math.min(100, Number(settings?.capitalPercent) || 0));
  return minBalance * (pct / 100);
}

/**
 * Quantity = Capital / MarkPrice.
 * Round down to satisfy both exchanges' stepSize; split into chunks if exceeds maxOrderQty.
 * @returns {Promise<{ chunks: string[], stepSize: string | null }>} formatted qty strings per chunk
 */
async function computeQuantityChunks(capital, markPrice, symbol) {
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return { chunks: [], stepSize: null };
  }
  const rawQty = capital / markPrice;
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

  let qtyValidBoth = rawQty;
  if (stepBinance) qtyValidBoth = Math.min(qtyValidBoth, floorToStepSize(rawQty, stepBinance));
  if (stepBybit) qtyValidBoth = Math.min(qtyValidBoth, floorToStepSize(rawQty, stepBybit));
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
 */
async function getOpenArbitrageCount(credentials) {
  const [binanceSymbols, bybitSymbols] = await Promise.all([
    binanceManager.getPositionSymbols(credentials.binance),
    bybitManager.getPositionSymbols(credentials.bybit),
  ]);
  const bybitSet = new Set(bybitSymbols);
  return binanceSymbols.filter((s) => bybitSet.has(s)).length;
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
  const openCount = await getOpenArbitrageCount(keys);
  if (openCount >= maxTrades) return;

  const rankedTokens = screener.getRankedTokens();
  if (!rankedTokens || rankedTokens.length === 0) return;

  const top = rankedTokens[0];
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
  if (countdownMs <= 0) {
    console.log(`[AutoTrader] Skipping: ${symbol} countdown expired (${countdownMs}ms <= 0).`);
    return;
  }

  console.log(`[AutoTrader] Executing trade for ${symbol}...`);

  if (lastEntryTimeBySymbol[top.symbol] && now - lastEntryTimeBySymbol[top.symbol] < ENTRY_BUFFER_MS) {
    return; // buffer: skip
  }

  const capital = await getTradeCapital(keys);
  if (capital <= 0) return;

  const markPrice = top.markPrice ?? 0;
  if (!markPrice || !Number.isFinite(markPrice)) return;

  const { chunks } = await computeQuantityChunks(capital, markPrice, top.symbol);
  if (chunks.length === 0) return;

  const { binanceSide, bybitSide } = getSidesFromToken(top);
  const levInt = Math.max(1, Math.min(125, Number(settings.leverage) || DEFAULT_LEVERAGE));
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
    await bybitManager.setLeverage(keys.bybit, top.symbol, levInt);
    for (const qtyStr of chunks) {
      if (!orderCircuitBreaker.canPlaceOrder()) {
        console.error("[AutoTrader] Order circuit breaker: trading paused, skipping entry", top.symbol);
        break;
      }
      const qty = parseFloat(qtyStr);
      if (qty <= 0) continue;
      try {
        await Promise.all([
          binanceManager.placeIOCLimitOrder(keys.binance, top.symbol, binanceSide, qty, binancePrice, { leverage: levInt }).then((r) => {
            orderCircuitBreaker.recordOrderPlaced();
            return r;
          }),
          bybitManager.placeIOCLimitOrder(keys.bybit, top.symbol, bybitSide, qty, bybitPrice).then((r) => {
            orderCircuitBreaker.recordOrderPlaced();
            return r;
          }),
        ]);
        tradedCycles[symbol] = nextFundingTime;
        console.log(`[AutoTrader] Locked ${symbol} for the current cycle. Will not re-enter until next funding time.`);
        lastEntryTimeBySymbol[top.symbol] = now;
        entryFundingDirectionBySymbol[top.symbol] = { binanceHigher: Number(top.fundingBinance) > Number(top.fundingBybit) };
        console.log("[AutoTrader] Entry", top.symbol, binanceSide, bybitSide, "qty", qtyStr);
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

module.exports = {
  getTradeCapital,
  computeQuantityChunks,
  getOpenArbitrageCount,
  getEntryFundingDirection,
  clearEntryFundingDirection,
  runAutoEntry,
  start,
  stop,
};
