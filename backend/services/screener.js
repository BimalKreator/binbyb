/**
 * The Brain: funding interval, spread calculation, volatility meter,
 * ranking, and max leverage. Updates on every WebSocket funding message.
 * Tracks all symbols that exist on both Binance and Bybit (set at startup via
 * exchange Exchange Info / instruments-info; screener calculates for the full list).
 */

const Setting = require("../models/Setting");
const { binanceManager, bybitManager } = require("./exchanges");

const VOLATILITY_THRESHOLD_PCT = 0.5;
/** Sort priority by interval string: 1h and 2h first (1), then 4h (2), then 8h (3). Lowest number first. */
const INTERVAL_PRIORITY_BY_LABEL = { "1h": 1, "2h": 1, "4h": 2, "8h": 3 };

const binanceData = {};
const bybitData = {};
const intervalHoursCache = {};
const intervalDisplayCache = {}; // '1h' | '2h' | '4h' | '8h' | 'Loading'
const lastFundingTimeCache = { binance: {}, bybit: {} };
const maxLeverageCache = {};
let rankedTokens = [];
let volatilityMeter = { level: "Low", count: 0 };
let cachedUserMinSpread = 0;

/**
 * Map interval milliseconds strictly to 1, 2, 4, 8 (then to '1h', '2h', '4h', '8h').
 * When ms is invalid or unknown, return 8 so we never get stuck on Loading.
 */
function intervalMsToHours(intervalMs) {
  if (intervalMs == null || !Number.isFinite(intervalMs) || intervalMs <= 0) return 8;
  const rawHours = Math.round(intervalMs / 3600000);
  if (rawHours <= 1) return 1;
  if (rawHours <= 2) return 2;
  if (rawHours <= 4) return 4;
  return 8;
}

/** Resolve numeric interval to display string. NaN/undefined → 'Loading'. */
function intervalHoursToLabel(hours) {
  if (hours == null || (typeof hours === "number" && Number.isNaN(hours))) return "Loading";
  const h = Number(hours);
  if (h === 1) return "1h";
  if (h === 2) return "2h";
  if (h === 4) return "4h";
  if (h === 8) return "8h";
  return "Loading";
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
 * Compute interval when a WebSocket message has nextFundingTime.
 * Interval = NextFundingTime - LastFundingTime (ms) → strictly '1h'|'2h'|'4h'|'8h'.
 * If lastFundingTime is unknown, fetch via REST; if still unknown, derive 8h so we never stay on Loading.
 */
async function computeIntervalHours(symbol, nextFundingTime, source) {
  if (nextFundingTime == null || !Number.isFinite(nextFundingTime)) return 8;
  let last =
    source === "binance"
      ? await getLastFundingTimeBinance(symbol)
      : await getLastFundingTimeBybit(symbol);
  if (last == null) return 8; // REST failed or not yet loaded: use 8h (typical perpetual)
  const intervalMs = nextFundingTime - last;
  return intervalMsToHours(intervalMs); // always returns 1, 2, 4, or 8
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
 * Sort: priority map {'1h':1, '2h':1, '4h':2, '8h':3} (lowest first).
 * Same priority → by absolute Net Spread descending.
 */
function sortByPriorityAndSpread(tokens) {
  return [...tokens].sort((a, b) => {
    const labelA = a.intervalDisplay ?? (a.intervalHours != null ? `${a.intervalHours}h` : "");
    const labelB = b.intervalDisplay ?? (b.intervalHours != null ? `${b.intervalHours}h` : "");
    const pa = INTERVAL_PRIORITY_BY_LABEL[labelA] ?? 99;
    const pb = INTERVAL_PRIORITY_BY_LABEL[labelB] ?? 99;
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

      // Resolve intervals to strings '1h', '2h', '4h', '8h', or 'Loading' (no raw math comparison)
      let binanceIntervalHours = null;
      let bybitIntervalHours = null;
      try {
        if (nextBin != null) binanceIntervalHours = await computeIntervalHours(symbol, nextBin, "binance");
        if (nextByb != null) bybitIntervalHours = await computeIntervalHours(symbol, nextByb, "bybit");
      } catch (_) {
        // keep null → will become 'Loading'
      }

      const binanceIntervalString = intervalHoursToLabel(binanceIntervalHours);
      const bybitIntervalString = intervalHoursToLabel(bybitIntervalHours);

      // Include token: either interval is Loading (don't drop), or both strings match
      const eitherLoading = binanceIntervalString === "Loading" || bybitIntervalString === "Loading";
      const bothMatch = binanceIntervalString === bybitIntervalString;
      if (!eitherLoading && !bothMatch) {
        continue; // only drop when both resolved and different
      }

      const intervalDisplay = eitherLoading ? "Loading" : binanceIntervalString;
      const intervalHours = binanceIntervalString !== "Loading" && bybitIntervalString !== "Loading"
        ? binanceIntervalHours
        : null;

      intervalHoursCache[symbol] = intervalHours;
      intervalDisplayCache[symbol] = intervalDisplay;

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
        intervalHours: intervalHours ?? undefined,
        intervalDisplay,
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
  Object.keys(intervalDisplayCache).forEach((k) => delete intervalDisplayCache[k]);
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
 * Includes ALL matched symbols; interval from cache or 'Loading' (never drop for missing interval).
 */
function buildRankedTokensFromCurrentData() {
  const binanceKeys = Object.keys(binanceData);
  const bybitUpper = new Set(Object.keys(bybitData).map((s) => s.toUpperCase()));
  const symbols = binanceKeys.filter((s) => bybitUpper.has(s.toUpperCase()));
  const tokens = symbols.map((symbol) => {
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
    const intervalHours = intervalHoursCache[symbol] ?? null;
    const intervalDisplay = intervalDisplayCache[symbol] ?? "Loading";
    return {
      symbol,
      fundingBinance,
      fundingBybit,
      nextFundingTime,
      intervalHours: intervalHours ?? undefined,
      intervalDisplay,
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
  INTERVAL_PRIORITY_BY_LABEL,
};
