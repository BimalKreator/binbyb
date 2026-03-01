/**
 * The Brain: funding interval, spread calculation, volatility meter,
 * ranking, and max leverage. Updates on every WebSocket funding message.
 * Tracks all symbols that exist on both Binance and Bybit (set at startup via
 * exchange Exchange Info / instruments-info; screener calculates for the full list).
 */

const Setting = require("../models/Setting");
const { binanceManager, bybitManager } = require("./exchanges");
const rankingService = require("./rankingService");

const VOLATILITY_THRESHOLD_PCT = 0.5;
/** Sort priority by interval string: 1h and 2h first (1), then 4h (2), then 8h (3). Lowest number first. */
const INTERVAL_PRIORITY_BY_LABEL = { "1h": 1, "2h": 1, "4h": 2, "8h": 3 };

const binanceData = {};
const bybitData = {};
const intervalHoursCache = {};
const intervalDisplayCache = {}; // '1h' | '2h' | '4h' | '8h'
const maxLeverageCache = {};
let rankedTokens = [];
let volatilityMeter = { level: "Low", count: 0 };
let cachedUserMinSpread = 0;
/** When set, only tokens in this set (symbols on BOTH Binance and Bybit) are included. */
let trackedCommonSymbols = new Set();

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

/** Resolve numeric interval to display string. NaN/undefined → '8h'. */
function intervalHoursToLabel(hours) {
  if (hours == null || (typeof hours === "number" && Number.isNaN(hours))) return "8h";
  const h = Number(hours);
  if (h === 1) return "1h";
  if (h === 2) return "2h";
  if (h === 4) return "4h";
  if (h === 8) return "8h";
  return "8h";
}

/**
 * Interval from manager cache only (hours). Both managers return 8 when missing.
 * commonSymbols is strict-interval-matched so Binance and Bybit agree for every symbol in the list.
 */
function computeIntervalHours(symbol, _nextFundingTime, source) {
  if (source === "binance") return binanceManager.getFundingIntervalHours(symbol);
  if (source === "bybit") return bybitManager.getFundingInterval(symbol);
  return 8;
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
    // Strict match: only symbols that exist on BOTH exchanges (and in tracked common list if set)
    let symbols = binanceKeys.filter((s) => bybitUpper.has(s.toUpperCase()));
    if (trackedCommonSymbols.size > 0) {
      symbols = symbols.filter((s) => trackedCommonSymbols.has(s.toUpperCase()));
    }
    const tokens = [];

    for (const symbol of symbols) {
      const bin = binanceData[symbol];
      const byb = bybitData[symbol];
      const nextBin = bin?.nextFundingTime ?? null;
      const nextByb = byb?.nextFundingTime ?? null;

      const binanceIntervalHours = computeIntervalHours(symbol, nextBin, "binance");
      const bybitIntervalHours = computeIntervalHours(symbol, nextByb, "bybit");
      // commonSymbols is strict-interval-matched, so both match; use Binance for display.
      const intervalDisplay = intervalHoursToLabel(binanceIntervalHours);
      const intervalHours = binanceIntervalHours ?? 8;

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
    const settings = await Setting.findOne().lean();
    if (settings?.useAdvancedRanking) {
      const withScore = [];
      for (const token of tokens) {
        const { rankScore, passed } = rankingService.calculateRankScore(token.symbol, settings);
        if (!passed) continue;
        withScore.push({ ...token, rankScore });
      }
      rankedTokens = withScore.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
    } else {
      rankedTokens = sortByPriorityAndSpread(tokens);
    }
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
    intervalHours: 8,
  };
  runScreener();
}

/**
 * Hydrate Binance funding from ONE batch getPremiumIndex. Intervals from manager cache (fundingInfo + WS).
 * @param {string[]} commonSymbols - Symbols that exist on both Binance and Bybit
 */
async function hydrateBinanceDataFromPremiumIndex(commonSymbols) {
  if (!Array.isArray(commonSymbols) || commonSymbols.length === 0) return;
  const symbolSet = new Set(commonSymbols.map((s) => String(s).toUpperCase()));
  try {
    const list = await binanceManager.getPremiumIndex();
    const now = Date.now();
    for (const item of list) {
      const sym = String(item.symbol || "").toUpperCase();
      if (!symbolSet.has(sym)) continue;
      const nextFundingTime = item.nextFundingTime ?? null;
      const intervalHours = binanceManager.getFundingIntervalHours(sym) || 8;
      intervalHoursCache[sym] = intervalHours;
      intervalDisplayCache[sym] = intervalHoursToLabel(intervalHours);
      binanceData[sym] = {
        fundingRate: item.lastFundingRate ?? 0,
        nextFundingTime,
        markPrice: item.markPrice ?? 0,
        eventTime: item.eventTime ?? item.time ?? now,
        intervalHours,
      };
    }
    console.log("[Screener] Hydrated Binance from premiumIndex for", Object.keys(binanceData).length, "symbols.");
  } catch (e) {
    console.warn("[Screener] hydrateBinanceDataFromPremiumIndex failed", e.message);
  }
}

/**
 * Connect to exchange managers so screener updates on every funding message.
 * Relies strictly on commonSymbols: only these symbols are included in ranked tokens and broadcast.
 * @param {string[]} [commonSymbols] - Symbols that exist on BOTH Binance and Bybit with matching funding interval (strict); used to hydrate and enforce list.
 */
function start(commonSymbols) {
  if (Array.isArray(commonSymbols) && commonSymbols.length > 0) {
    trackedCommonSymbols = new Set(commonSymbols.map((s) => String(s).toUpperCase()));
  } else {
    trackedCommonSymbols = new Set();
  }
  binanceManager.setOnFundingUpdate(onBinanceFunding);
  bybitManager.setOnFundingUpdate(onBybitFunding);
  if (Array.isArray(commonSymbols) && commonSymbols.length > 0) {
    setTimeout(() => {
      hydrateBinanceDataFromPremiumIndex(commonSymbols).then(() => runScreener());
    }, 2000);
  }
  console.log("[Screener] Started; subscribed to Binance and Bybit funding streams.", commonSymbols?.length ? `Strict match: ${commonSymbols.length} common symbols.` : "");
}

function stop() {
  binanceManager.setOnFundingUpdate(null);
  bybitManager.setOnFundingUpdate(null);
  trackedCommonSymbols = new Set();
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
 * Includes ALL matched symbols; interval from cache or '8h' (never drop for missing interval).
 */
function buildRankedTokensFromCurrentData() {
  const binanceKeys = Object.keys(binanceData);
  const bybitUpper = new Set(Object.keys(bybitData).map((s) => s.toUpperCase()));
  let symbols = binanceKeys.filter((s) => bybitUpper.has(s.toUpperCase()));
  if (trackedCommonSymbols.size > 0) {
    symbols = symbols.filter((s) => trackedCommonSymbols.has(s.toUpperCase()));
  }
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
    const exactHours = binanceManager.getFundingIntervalHours(symbol) || 8;
    const intervalDisplay = exactHours + "h";
    return {
      symbol,
      fundingBinance,
      fundingBybit,
      nextFundingTime,
      intervalHours: exactHours,
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
