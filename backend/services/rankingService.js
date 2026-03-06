/**
 * Ranking service: 8-hour cron fetches 30 days of funding, OI, and klines for all pairs.
 * calculateRankScore(symbol, settings) uses global.rankingCache to compute rankScore and passed.
 */

const axios = require("axios");
axios.defaults.family = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BINANCE_FAPI = "https://fapi.binance.com";
const BINANCE_FUTURES_DATA = "https://fapi.binance.com/futures/data";
const BYBIT_REST = "https://api.bybit.com";

const CRON_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DELAY_BEFORE_FIRST_RUN_MS = 15000; // 15s after start to let exchanges boot

if (typeof global.rankingCache !== "object") {
  global.rankingCache = {};
}

let symbolList = [];
let intervalId = null;

/**
 * Fetch last 30 days funding rate history (Binance). Paginates if needed (limit 1000).
 */
async function fetchBinanceFundingHistory(symbol) {
  const endTime = Date.now();
  const startTime = endTime - THIRTY_DAYS_MS;
  const out = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/fundingRate`, {
      params: { symbol, startTime: cursor, endTime, limit: 1000 },
      timeout: 10000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    cursor = (data[data.length - 1]?.fundingTime ?? cursor) + 1;
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Fetch last 30 days funding rate history (Bybit v5).
 */
async function fetchBybitFundingHistory(symbol) {
  const endTime = Date.now();
  const startTime = endTime - THIRTY_DAYS_MS;
  const out = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const { data } = await axios.get(`${BYBIT_REST}/v5/market/funding/history`, {
      params: { category: "linear", symbol, startTime: cursor, endTime, limit: 200 },
      timeout: 10000,
    });
    const list = data?.result?.list;
    if (!Array.isArray(list) || list.length === 0) break;
    out.push(...list);
    const lastTs = list[list.length - 1]?.fundingRateTimestamp;
    if (lastTs == null) break;
    cursor = Number(lastTs) + 1;
    if (list.length < 200) break;
  }
  return out;
}

/**
 * Fetch open interest history. Binance: /futures/data/openInterestHist. Bybit: /v5/market/open-interest/...
 */
async function fetchBinanceOpenInterestHistory(symbol) {
  try {
    const endTime = Date.now();
    const startTime = endTime - THIRTY_DAYS_MS;
    const { data } = await axios.get(`${BINANCE_FUTURES_DATA}/openInterestHist`, {
      params: { symbol, period: "1d", limit: 30, startTime, endTime },
      timeout: 10000,
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function fetchBybitOpenInterestHistory(symbol) {
  try {
    const endTime = Date.now();
    const startTime = endTime - THIRTY_DAYS_MS;
    const out = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const { data } = await axios.get(`${BYBIT_REST}/v5/market/open-interest`, {
        params: { category: "linear", symbol, intervalTime: "1d", startTime: cursor, endTime, limit: 200 },
        timeout: 10000,
      });
      const list = data?.result?.list;
      if (!Array.isArray(list) || list.length === 0) break;
      out.push(...list);
      const lastTs = list[list.length - 1]?.timestamp;
      if (lastTs == null) break;
      cursor = Number(lastTs) + 1;
      if (list.length < 200) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * Fetch 30 days daily klines. Binance: /fapi/v1/klines. Bybit: /v5/market/kline.
 */
async function fetchBinanceKlines(symbol) {
  const endTime = Date.now();
  const startTime = endTime - THIRTY_DAYS_MS;
  const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/klines`, {
    params: { symbol, interval: "1d", startTime, endTime, limit: 31 },
    timeout: 10000,
  });
  return Array.isArray(data) ? data : [];
}

async function fetchBybitKlines(symbol) {
  const endTime = Date.now();
  const startTime = endTime - THIRTY_DAYS_MS;
  const { data } = await axios.get(`${BYBIT_REST}/v5/market/kline`, {
    params: { category: "linear", symbol, interval: "D", start: startTime, end: endTime, limit: 31 },
    timeout: 10000,
  });
  const list = data?.result?.list || [];
  return Array.isArray(list) ? list : [];
}

/**
 * Run one full cache refresh for all symbols.
 * L2 arbitrage bot: no REST klines/OI/funding history per symbol (avoids event loop blocking).
 * Set empty defaults; real-time data comes from exchange manager WebSockets.
 */
async function refreshRankingCache() {
  const symbols = symbolList.length > 0 ? symbolList : ["BTCUSDT", "ETHUSDT"];
  const now = Date.now();
  for (const symbol of symbols) {
    global.rankingCache[symbol] = {
      binanceFunding: [],
      bybitFunding: [],
      binanceOI: [],
      bybitOI: [],
      binanceKlines: [],
      bybitKlines: [],
      lastUpdated: now,
    };
  }
}

/**
 * Continuation probability: fraction of funding intervals where sign (positive/negative) is the same as the previous.
 * Avg run length: average length of consecutive same-sign runs.
 */
function continuationStats(fundingRates) {
  if (!Array.isArray(fundingRates) || fundingRates.length < 2) return { p: 0, avgRun: 0 };
  const rates = fundingRates
    .map((r) => {
      const val = typeof r === "object" && r !== null ? (r.fundingRate != null ? parseFloat(r.fundingRate) : r.fundingRate) : parseFloat(r);
      return Number.isFinite(val) ? val : 0;
    })
    .filter((_, i, arr) => arr.length);
  if (rates.length < 2) return { p: 0, avgRun: 0 };
  let sameSignCount = 0;
  const runs = [];
  let run = 1;
  for (let i = 1; i < rates.length; i++) {
    const prevSign = rates[i - 1] >= 0 ? 1 : -1;
    const curSign = rates[i] >= 0 ? 1 : -1;
    if (prevSign === curSign) {
      sameSignCount++;
      run++;
    } else {
      runs.push(run);
      run = 1;
    }
  }
  runs.push(run);
  const p = sameSignCount / (rates.length - 1);
  const avgRun = runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
  return { p, avgRun };
}

/**
 * Step A: Continuation probability and avg run length. Max 50 pts.
 * If settings.rankStepA is false, skip. If P < minFundingConsistency/100 or avgRun < 5, passed = false.
 */
function stepA(cache, settings, result) {
  if (!settings.rankStepA) return;
  const minP = (Number(settings.minFundingConsistency) || 75) / 100;
  const binanceRates = cache?.binanceFunding || [];
  const bybitRates = cache?.bybitFunding || [];
  const bin = continuationStats(binanceRates);
  const byb = continuationStats(bybitRates);
  const p = (bin.p + byb.p) / 2;
  const avgRun = (bin.avgRun + byb.avgRun) / 2;
  if (p < minP || avgRun < 5) {
    result.passed = false;
    return;
  }
  const stability = Math.min(1, p * 1.2) * Math.min(1, avgRun / 10);
  result.rankScore += Math.round(50 * stability);
}

/**
 * Step B: 7-day avg OI and exchange parity. Max 30 pts.
 * If funding > 0 and OI dropped > 5% in 24h, passed = false. Deduct if parity diff > 20%.
 */
function stepB(cache, settings, result) {
  if (!settings.rankStepB) return;
  const binanceOI = cache?.binanceOI || [];
  const bybitOI = cache?.bybitOI || [];
  const binanceFunding = cache?.binanceFunding || [];
  const bybitFunding = cache?.bybitFunding || [];

  const binOILatest = binanceOI.length > 0 ? parseFloat(binanceOI[binanceOI.length - 1]?.sumOpenInterest ?? binanceOI[binanceOI.length - 1]?.openInterest ?? 0) : 0;
  const binOIPrev = binanceOI.length >= 2 ? parseFloat(binanceOI[binanceOI.length - 2]?.sumOpenInterest ?? binanceOI[binanceOI.length - 2]?.openInterest ?? 0) : binOILatest;
  const bybOILatest = bybitOI.length > 0 ? parseFloat(bybitOI[bybitOI.length - 1]?.openInterest ?? 0) : 0;
  const bybOIPrev = bybitOI.length >= 2 ? parseFloat(bybitOI[bybitOI.length - 2]?.openInterest ?? 0) : bybOILatest;

  const binFundingLatest = binanceFunding.length > 0 ? parseFloat(binanceFunding[binanceFunding.length - 1]?.fundingRate ?? 0) : 0;
  const bybFundingLatest = bybitFunding.length > 0 ? parseFloat(bybitFunding[bybitFunding.length - 1]?.fundingRate ?? 0) : 0;
  const avgFunding = (binFundingLatest + bybFundingLatest) / 2;

  if (avgFunding > 0 && binOIPrev > 0 && bybOIPrev > 0) {
    const binDrop = (binOIPrev - binOILatest) / binOIPrev;
    const bybDrop = (bybOIPrev - bybOILatest) / bybOIPrev;
    if (binDrop > 0.05 || bybDrop > 0.05) {
      result.passed = false;
      return;
    }
  }

  const oiSumBin = binanceOI.slice(-7).reduce((s, o) => s + (parseFloat(o?.sumOpenInterest ?? o?.openInterest ?? 0) || 0), 0);
  const oiSumByb = bybitOI.slice(-7).reduce((s, o) => s + (parseFloat(o?.openInterest ?? 0) || 0), 0);
  const parityDiff = oiSumBin > 0 && oiSumByb > 0 ? Math.abs(oiSumBin - oiSumByb) / Math.max(oiSumBin, oiSumByb) : 0;
  if (parityDiff > 0.2) {
    result.rankScore -= Math.round(30 * Math.min(1, (parityDiff - 0.2) / 0.3));
  }
  const steady = parityDiff <= 0.2 ? 1 : Math.max(0, 1 - parityDiff);
  result.rankScore += Math.round(30 * steady);
  result.rankScore = Math.max(0, result.rankScore);
}

/**
 * Step C: 7-day price variance. If 20-30% spike/crash in 24h, passed = false. Max 20 pts for range-bound stability.
 */
function stepC(cache, settings, result) {
  if (!settings.rankStepC) return;
  const binanceKlines = cache?.binanceKlines || [];
  const bybitKlines = cache?.bybitKlines || [];

  const close = (klines, i) => {
    const k = klines[i];
    if (!k) return null;
    if (Array.isArray(k)) return parseFloat(k[4]);
    return parseFloat(k?.close);
  };
  const highs = [];
  const lows = [];
  const len = Math.max(binanceKlines.length, bybitKlines.length);
  for (let i = Math.max(0, len - 8); i < len - 1; i++) {
    const c0 = close(binanceKlines, i) ?? close(bybitKlines, i);
    const c1 = close(binanceKlines, i + 1) ?? close(bybitKlines, i + 1);
    if (c0 != null && c0 > 0 && c1 != null) {
      const pct = (c1 - c0) / c0;
      if (Math.abs(pct) >= 0.2 && Math.abs(pct) <= 0.3) {
        result.passed = false;
        return;
      }
      highs.push(pct);
      lows.push(pct);
    }
  }
  const variance = highs.length > 0 ? highs.reduce((s, p) => s + p * p, 0) / highs.length : 0;
  const rangeBound = Math.max(0, 1 - variance * 20);
  result.rankScore += Math.round(20 * rangeBound);
}

/**
 * Calculate rank score and pass/fail for a symbol using cached 30-day data and settings.
 * @param {string} symbol
 * @param {object} settings - { rankStepA, rankStepB, rankStepC, minFundingConsistency }
 * @returns {{ rankScore: number, passed: boolean }}
 */
function calculateRankScore(symbol, settings = {}) {
  const result = { rankScore: 0, passed: true };
  const cache = global.rankingCache[symbol];
  if (!cache) {
    return result;
  }
  stepA(cache, settings, result);
  stepB(cache, settings, result);
  stepC(cache, settings, result);
  result.rankScore = Math.max(0, Math.min(100, result.rankScore));
  return result;
}

function start(symbols = []) {
  if (Array.isArray(symbols) && symbols.length > 0) {
    symbolList = symbols.map((s) => String(s).toUpperCase());
  }
  if (intervalId) return;
  const run = () => refreshRankingCache().catch((e) => console.error("[RankingService] Refresh error:", e?.message ?? e));
  setTimeout(run, DELAY_BEFORE_FIRST_RUN_MS);
  intervalId = setInterval(run, CRON_INTERVAL_MS);
  console.log("[RankingService] Started (8h cache cycle, 30d data). Symbols:", symbolList.length || "default");
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log("[RankingService] Stopped.");
}

module.exports = {
  start,
  stop,
  calculateRankScore,
  refreshRankingCache,
};
