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
let cachedUserMinSpread = 0;

/**
 * Interval (hours) = Math.round((NextFundingTime - LastFundingTime) / 3600000).
 * Buckets into 1h, 2h, 4h, 8h so 1h and 2h tokens are included.
 */
function intervalMsToHours(intervalMs) {
  if (intervalMs == null || intervalMs <= 0) return null;
  const rawHours = Math.round(intervalMs / 3600000);
  if (rawHours <= 1) return 1;
  if (rawHours <= 2) return 2;
  if (rawHours <= 4) return 4;
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
 * Compute funding interval in hours: Interval = NextFundingTime - LastFundingTime.
 * If LastFundingTime is unreliable (null), fallback to 8h (24/3 funding rate frequency).
 */
async function computeIntervalHours(symbol, nextFundingTime, source) {
  if (nextFundingTime == null) return null;
  const last =
    source === "binance"
      ? await getLastFundingTimeBinance(symbol)
      : await getLastFundingTimeBybit(symbol);
  if (last == null) return 8; // fallback: 8h = 24 / 3 (typical perpetual funding frequency)
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
 * Spread = Math.abs(Funding_Binance - Funding_Bybit). Used for sorting (highest first).
 * Net spread: S_net = signed gross - UserMinSpread% for display.
 */
function computeSpread(fundingBinance, fundingBybit, userMinSpreadPct) {
  const bin = Number(fundingBinance);
  const byb = Number(fundingBybit);
  const grossSigned = (Number.isNaN(bin) ? 0 : bin) - (Number.isNaN(byb) ? 0 : byb);
  const spreadAbs = Math.abs(grossSigned);
  const userMinSpreadDecimal = (Number(userMinSpreadPct) || 0) / 100;
  const net = grossSigned - userMinSpreadDecimal;
  return {
    grossPct: Number.isFinite(grossSigned * 100) ? grossSigned * 100 : 0,
    netPct: Number.isFinite(net * 100) ? net * 100 : 0,
    spreadPctAbs: Number.isFinite(spreadAbs * 100) ? spreadAbs * 100 : 0,
    gross: grossSigned,
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
 * Sort: 1st priority 1h, 2nd 2h, 3rd 4h, 4th 8h. Within each interval, highest spread first.
 */
function sortByPriorityAndSpread(tokens) {
  return [...tokens].sort((a, b) => {
    const pa = INTERVAL_PRIORITY[a.intervalHours] ?? 99;
    const pb = INTERVAL_PRIORITY[b.intervalHours] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.spreadPctAbs ?? 0) - (a.spreadPctAbs ?? 0);
  });
}

/**
 * Fetch UserMinSpread from Settings (single doc). Returns 0 if NaN/undefined.
 */
async function getUserMinSpread() {
  const doc = await Setting.findOne().lean();
  const val = doc?.userMinSpread ?? 0;
  return Number(val) || 0;
}

let runScreenerDebounce = null;

async function runScreener() {
  if (runScreenerDebounce) {
    clearTimeout(runScreenerDebounce);
  }
  runScreenerDebounce = setTimeout(async () => {
    runScreenerDebounce = null;
    const userMinSpread = await getUserMinSpread();
    cachedUserMinSpread = userMinSpread;
    const binanceKeys = Object.keys(binanceData);
    const bybitUpper = new Set(Object.keys(bybitData).map((s) => s.toUpperCase()));
    const symbols = binanceKeys.filter((s) => bybitUpper.has(s.toUpperCase()));
    const tokens = [];

    for (const symbol of symbols) {
      const bin = binanceData[symbol];
      const byb = bybitData[symbol];
      const nextBin = bin?.nextFundingTime ?? null;
      const nextByb = byb?.nextFundingTime ?? null;

      // Continuously calculate interval for both: Interval = NextFundingTime - LastFundingTime → 1h/2h/4h/8h
      let binanceIntervalHours = null;
      let bybitIntervalHours = null;
      try {
        if (nextBin != null) binanceIntervalHours = await computeIntervalHours(symbol, nextBin, "binance");
        if (nextByb != null) bybitIntervalHours = await computeIntervalHours(symbol, nextByb, "bybit");
      } catch (_) {
        // keep null
      }

      // Strict match: only include token when BinanceInterval === BybitInterval
      if (
        binanceIntervalHours == null ||
        bybitIntervalHours == null ||
        binanceIntervalHours !== bybitIntervalHours
      ) {
        continue;
      }

      intervalHoursCache[symbol] = binanceIntervalHours;
      const fundingBinance = bin?.fundingRate ?? 0;
      const fundingBybit = byb?.fundingRate ?? 0;
      const nextFundingTime = nextBin ?? nextByb;

      const { grossPct, netPct, spreadPctAbs, gross, net } = computeSpread(
        fundingBinance,
        fundingBybit,
        userMinSpread
      );

      let maxLeverage = maxLeverageCache[symbol] ?? null;
      if (maxLeverage == null) {
        try {
          maxLeverage = await fetchAndCacheMaxLeverage(symbol);
        } catch (_) {
          // keep null
        }
      }

      const markPrice = bin?.markPrice ?? byb?.markPrice ?? null;
      tokens.push({
        symbol,
        fundingBinance: bin?.fundingRate ?? 0,
        fundingBybit: byb?.fundingRate ?? 0,
        nextFundingTime,
        intervalHours: binanceIntervalHours,
        grossPct,
        netPct,
        spreadPctAbs,
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
  const key = String(data.symbol).toUpperCase();
  binanceData[key] = {
    fundingRate: data.fundingRate,
    nextFundingTime: data.nextFundingTime,
    markPrice: data.markPrice,
    eventTime: data.eventTime,
  };
  runScreener();
}

function onBybitFunding(data) {
  if (!data?.symbol) return;
  const key = String(data.symbol).toUpperCase();
  bybitData[key] = {
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

/**
 * Build ranked tokens synchronously from current in-memory data (no await).
 * Only includes symbols that have matching Binance/Bybit interval (from cache).
 */
function buildRankedTokensFromCurrentData() {
  const binanceKeys = Object.keys(binanceData);
  const bybitUpper = new Set(Object.keys(bybitData).map((s) => s.toUpperCase()));
  const symbols = binanceKeys.filter((s) => bybitUpper.has(s.toUpperCase()));
  const tokens = symbols
    .filter((symbol) => intervalHoursCache[symbol] != null)
    .map((symbol) => {
      const bin = binanceData[symbol];
      const byb = bybitData[symbol];
      const fundingBinance = bin?.fundingRate ?? 0;
      const fundingBybit = byb?.fundingRate ?? 0;
      const nextFundingTime = bin?.nextFundingTime ?? byb?.nextFundingTime ?? null;
      const { grossPct, netPct, spreadPctAbs, gross, net } = computeSpread(
        fundingBinance,
        fundingBybit,
        cachedUserMinSpread
      );
      return {
        symbol,
        fundingBinance,
        fundingBybit,
        nextFundingTime,
        intervalHours: intervalHoursCache[symbol],
        grossPct,
        netPct,
        spreadPctAbs,
        gross,
        net,
        maxLeverage: maxLeverageCache[symbol] ?? null,
        markPrice: bin?.markPrice ?? byb?.markPrice ?? null,
      };
    });
  return sortByPriorityAndSpread(tokens);
}

function getSnapshot() {
  let list = getRankedTokens();
  if (list.length === 0) {
    list = buildRankedTokensFromCurrentData();
  }
  return {
    rankedTokens: list,
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
