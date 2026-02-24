/**
 * The Brain: funding interval, spread calculation, volatility meter,
 * ranking, and max leverage. Updates on every WebSocket funding message.
 * Tracks all symbols that exist on both Binance and Bybit (set at startup via
 * exchange Exchange Info / instruments-info; screener calculates for the full list).
 */

const Setting = require("../models/Setting");
const { binanceManager, bybitManager } = require("./exchanges");

const VOLATILITY_THRESHOLD_PCT = 0.5;
const INTERVAL_PRIORITY = { 1: 0, 2: 1, 4: 2, 8: 3 }; // lower = higher priority

const binanceData = {};
const bybitData = {};
const intervalHoursCache = {};
const lastFundingTimeCache = { binance: {}, bybit: {} };
const maxLeverageCache = {};
let rankedTokens = [];
let volatilityMeter = { level: "Low", count: 0 };

/**
 * Interval (hours) = (NextFundingTime - LastFundingTime) in hours.
 * Converts to standard bucket: 1h, 2h, 4h, 8h.
 */
function intervalMsToHours(intervalMs) {
  if (intervalMs == null || intervalMs <= 0) return null;
  const hours = intervalMs / (3600 * 1000);
  if (hours <= 1.5) return 1;
  if (hours <= 3) return 2;
  if (hours <= 6) return 4;
  return 8;
}

async function getLastFundingTimeBinance(symbol) {
  if (lastFundingTimeCache.binance[symbol] != null) return lastFundingTimeCache.binance[symbol];
  try {
    const t = await binanceManager.getLastFundingTime(symbol);
    if (t != null) lastFundingTimeCache.binance[symbol] = t;
    return t;
  } catch (e) {
    return null;
  }
}

async function getLastFundingTimeBybit(symbol) {
  if (lastFundingTimeCache.bybit[symbol] != null) return lastFundingTimeCache.bybit[symbol];
  try {
    const t = await bybitManager.getLastFundingTime(symbol);
    if (t != null) lastFundingTimeCache.bybit[symbol] = t;
    return t;
  } catch (e) {
    return null;
  }
}

/**
 * Compute funding interval in hours using Interval = NextFundingTime - LastFundingTime.
 * Uses Binance next funding time and last funding time (from REST or cache).
 */
async function computeIntervalHours(symbol, nextFundingTime, source) {
  if (nextFundingTime == null) return null;
  const last =
    source === "binance"
      ? await getLastFundingTimeBinance(symbol)
      : await getLastFundingTimeBybit(symbol);
  if (last == null) return null;
  const intervalMs = nextFundingTime - last;
  return intervalMsToHours(intervalMs);
}

async function fetchAndCacheMaxLeverage(symbol) {
  if (maxLeverageCache[symbol] != null) return maxLeverageCache[symbol];
  try {
    const [binanceL, bybitL] = await Promise.all([
      binanceManager.getMaxLeverage(symbol),
      bybitManager.getMaxLeverage(symbol),
    ]);
    const minLeverage =
      binanceL != null && bybitL != null ? Math.min(binanceL, bybitL) : binanceL ?? bybitL ?? null;
    maxLeverageCache[symbol] = minLeverage;
    return minLeverage;
  } catch (e) {
    return null;
  }
}

/**
 * Gross spread: S_gross = Funding_Binance - Funding_Bybit (decimal).
 * Net spread: S_net = S_gross - UserMinSpread% (userMinSpread in percent, e.g. 0.1 = 0.1%).
 */
function computeSpread(fundingBinance, fundingBybit, userMinSpreadPct) {
  const gross = fundingBinance - fundingBybit;
  const userMinSpreadDecimal = (userMinSpreadPct || 0) / 100;
  const net = gross - userMinSpreadDecimal;
  return {
    grossPct: gross * 100,
    netPct: net * 100,
    gross,
    net,
  };
}

/**
 * Volatility meter: count tokens where S_net > 0.5%. Then:
 * 0–2: Low, 3–5: Med, 5+: High.
 */
function updateVolatilityMeter(tokensWithNetSpread) {
  const count = tokensWithNetSpread.filter((t) => t.netPct > VOLATILITY_THRESHOLD_PCT).length;
  let level = "Low";
  if (count >= 5) level = "High";
  else if (count >= 3) level = "Med";
  volatilityMeter = { count, level };
  return volatilityMeter;
}

/**
 * Sort: first by interval priority (1h/2h first), then by highest net spread.
 */
function sortByPriorityAndSpread(tokens) {
  return [...tokens].sort((a, b) => {
    const pa = INTERVAL_PRIORITY[a.intervalHours] ?? 99;
    const pb = INTERVAL_PRIORITY[b.intervalHours] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.netPct ?? 0) - (a.netPct ?? 0);
  });
}

/**
 * Fetch UserMinSpread from Settings (single doc).
 */
async function getUserMinSpread() {
  const doc = await Setting.findOne().lean();
  return doc?.userMinSpread ?? 0;
}

let runScreenerDebounce = null;

async function runScreener() {
  if (runScreenerDebounce) {
    clearTimeout(runScreenerDebounce);
  }
  runScreenerDebounce = setTimeout(async () => {
    runScreenerDebounce = null;
    const userMinSpread = await getUserMinSpread();
    const symbols = Object.keys(binanceData).filter((s) => bybitData[s]);
    const tokens = [];

    for (const symbol of symbols) {
      const bin = binanceData[symbol];
      const byb = bybitData[symbol];
      const nextFundingTime = bin?.nextFundingTime ?? byb?.nextFundingTime;
      const intervalHours = nextFundingTime
        ? await computeIntervalHours(
            symbol,
            nextFundingTime,
            bin?.nextFundingTime != null ? "binance" : "bybit"
          )
        : intervalHoursCache[symbol] ?? null;
      if (intervalHours != null) intervalHoursCache[symbol] = intervalHours;

      const { grossPct, netPct, gross, net } = computeSpread(
        bin?.fundingRate ?? 0,
        byb?.fundingRate ?? 0,
        userMinSpread
      );

      const maxLeverage = await fetchAndCacheMaxLeverage(symbol);

      const markPrice = bin?.markPrice ?? byb?.markPrice ?? null;
      tokens.push({
        symbol,
        fundingBinance: bin?.fundingRate,
        fundingBybit: byb?.fundingRate,
        nextFundingTime,
        intervalHours: intervalHours ?? undefined,
        grossPct,
        netPct,
        gross,
        net,
        maxLeverage,
        markPrice,
      });
    }

    updateVolatilityMeter(tokens);
    rankedTokens = sortByPriorityAndSpread(tokens);
  }, 80);
}

function onBinanceFunding(data) {
  if (!data?.symbol) return;
  binanceData[data.symbol] = {
    fundingRate: data.fundingRate,
    nextFundingTime: data.nextFundingTime,
    markPrice: data.markPrice,
    eventTime: data.eventTime,
  };
  runScreener();
}

function onBybitFunding(data) {
  if (!data?.symbol) return;
  bybitData[data.symbol] = {
    fundingRate: data.fundingRate,
    nextFundingTime: data.nextFundingTime,
    markPrice: data.markPrice,
    eventTime: data.eventTime,
  };
  runScreener();
}

/**
 * Connect to exchange managers so screener updates on every funding message.
 */
function start() {
  binanceManager.setOnFundingUpdate(onBinanceFunding);
  bybitManager.setOnFundingUpdate(onBybitFunding);
  console.log("[Screener] Started; subscribed to Binance and Bybit funding streams.");
}

function stop() {
  binanceManager.setOnFundingUpdate(null);
  bybitManager.setOnFundingUpdate(null);
  rankedTokens = [];
  volatilityMeter = { level: "Low", count: 0 };
  console.log("[Screener] Stopped.");
}

function getRankedTokens() {
  return rankedTokens;
}

function getVolatilityMeter() {
  return { ...volatilityMeter };
}

function getMaxLeverage(symbol) {
  return maxLeverageCache[symbol] ?? null;
}

function getSnapshot() {
  return {
    rankedTokens: getRankedTokens(),
    volatilityMeter: getVolatilityMeter(),
    binanceSymbols: Object.keys(binanceData),
    bybitSymbols: Object.keys(bybitData),
  };
}

module.exports = {
  start,
  stop,
  getRankedTokens,
  getVolatilityMeter,
  getMaxLeverage,
  getSnapshot,
  computeSpread,
  intervalMsToHours,
  VOLATILITY_THRESHOLD_PCT,
  INTERVAL_PRIORITY,
};
