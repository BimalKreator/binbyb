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
const { dbLog } = require("../utils/logger");

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

/** L2 VWAP failure cooldown: symbol -> timestamp. Prevents spam logging. */
const l2FailCooldown = {};
const L2_FAIL_COOLDOWN_MS = 30000; // 30 seconds

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
  const minL2VwapSpread = Number(settings?.minL2VwapSpread) ?? 0.15;
  const minFundingSpread = Number(settings?.minFundingSpread) ?? 0.15;
  const now = Date.now();
  const binList = binanceManager.getLivePositions() || [];
  const bybList = bybitManager.getLivePositions() || [];
  const isL2Mode = settings.tradingMode === "l2";

  // Hunt in the top 10 eligible tokens
  for (const token of eligible.slice(0, 10)) {
    const sym = String(token.symbol).toUpperCase();

    // Skip if token already has an active open position (prevent duplicate entries)
    const isActiveBinance = binList.some((p) => String(p.symbol).toUpperCase() === sym && Math.abs(parseFloat(p.positionAmt ?? 0) || 0) > 0);
    const isActiveBybit = bybList.some((p) => String(p.symbol).toUpperCase() === sym && Math.abs(parseFloat(p.positionAmt ?? p.size ?? 0) || 0) > 0);
    if (isActiveBinance || isActiveBybit) continue;

    if (isL2Mode) {
      // L2 mode: no funding-time countdown; only require L2 spread and live spread
      if (token.l2SpreadVwap == null || token.l2SpreadVwap < minL2VwapSpread) {
        console.log(`[AutoTrader] Skipped ${token.symbol}: L2 VWAP Spread (${token.l2SpreadVwap}%) < Minimum (${minL2VwapSpread}%)`);
        continue;
      }
    } else {
      // Funding mode: strict funding time window
      const nextFundingTime = token.nextFundingTime;
      if (nextFundingTime == null || !Number.isFinite(nextFundingTime)) continue;
      const countdownMs = nextFundingTime - now;
      if (countdownMs < windowEndMs) continue; // Missed strict window
      if (tradedCycles[token.symbol] === nextFundingTime) continue; // Already traded this cycle
      if (countdownMs <= 0 || countdownMs > entryTimeMs) continue; // Expired or too early
      if ((token.spreadPctAbs || 0) < minFundingSpread) {
        console.log(`[AutoTrader] Skipped ${token.symbol}: Funding Spread < Minimum`);
        continue;
      }
    }

    if (lastEntryTimeBySymbol[token.symbol] && now - lastEntryTimeBySymbol[token.symbol] < ENTRY_BUFFER_MS) continue;

    const lastTrade = await TradeLog.findOne({ symbol: token.symbol }).sort({ exitTime: -1 }).lean();
    if (lastTrade?.exitTime && (Date.now() - new Date(lastTrade.exitTime).getTime()) < cooldownMs) continue;

    const { binanceSide, bybitSide } = getSidesFromToken(token);
    const currentSpread = calculateLiveEntrySpread(token.symbol, binanceSide);
    if (currentSpread === null || currentSpread < minL2Spread) continue;

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
  let binanceSide = selectedBinanceSide;
  let bybitSide = selectedBybitSide;
  if (settings.tradingMode === "l2") {
    const targetNotional = Math.max(1, Number(settings.screenerTradeNotional) || 500);
    const binBuy = binanceManager.getVwapPrice(top.symbol, "BUY", targetNotional);
    const binSell = binanceManager.getVwapPrice(top.symbol, "SELL", targetNotional);
    const bybBuy = bybitManager.getVwapPrice(top.symbol, "Buy", targetNotional);
    const bybSell = bybitManager.getVwapPrice(top.symbol, "Sell", targetNotional);
    
    // If orderbook data is too thin or missing, skip silently to prevent event loop log spam
    if (!binBuy || !binSell || !bybBuy || !bybSell) {
      return;
    }
    
    const spreadIfBinShort = binSell && bybBuy ? ((binSell - bybBuy) / bybBuy) * 100 : -Infinity;
    const spreadIfBybShort = bybSell && binBuy ? ((bybSell - binBuy) / binBuy) * 100 : -Infinity;
    const isBinanceShort = spreadIfBinShort >= spreadIfBybShort;
    binanceSide = isBinanceShort ? "SELL" : "BUY";
    bybitSide = isBinanceShort ? "Buy" : "Sell";
  }

  if (settings.tradingMode === "l2" && settings.l2FavourableFundingOnly) {
    const binFunding = binanceManager.getCachedFundingRate(symbol) ?? 0;
    const bybFunding = bybitManager.getCachedFundingRate(symbol) ?? 0;
    const netFunding = binanceSide === "SELL" ? binFunding - bybFunding : bybFunding - binFunding;
    if (netFunding <= 0) {
      console.log(`[AutoTrader-Failsafe] Skipping ${symbol}: Unfavorable Net Funding (${(netFunding * 100).toFixed(4)}%).`);
      return;
    }
  }

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

  // Remove Date.now() so the bot doesn't spam the same token repeatedly in a single cycle
  const cycleKey = isL2Mode ? `${symbol}_L2_ACTIVE` : `${symbol}_${nextFundingTime}`;
  if (lastFiredCycleKey === cycleKey) return;

  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[AutoTrader] Order circuit breaker: trading paused, skipping entry", top.symbol);
    return;
  }

  isExecutingTrade = true;
  try {
    if (settings.tradingMode === "l2") {
      const targetNotional = Math.max(1, Number(settings.screenerTradeNotional) || 500);
      const binBuy = binanceManager.getVwapPrice(top.symbol, "BUY", targetNotional);
      const binSell = binanceManager.getVwapPrice(top.symbol, "SELL", targetNotional);
      const bybBuy = bybitManager.getVwapPrice(top.symbol, "Buy", targetNotional);
      const bybSell = bybitManager.getVwapPrice(top.symbol, "Sell", targetNotional);
      
      // Null data detection: if all VWAP prices are null, orderbook data not ready - skip silently
      if (binBuy == null && binSell == null && bybBuy == null && bybSell == null) {
        isExecutingTrade = false;
        return; // Silent skip - no log spam
      }
      
      const spreadIfBinShort = binSell && bybBuy ? ((binSell - bybBuy) / bybBuy) * 100 : -Infinity;
      const spreadIfBybShort = bybSell && binBuy ? ((bybSell - binBuy) / binBuy) * 100 : -Infinity;
      const liveL2Spread = binanceSide === "SELL" ? spreadIfBinShort : spreadIfBybShort;
      const minL2Vwap = Number(settings?.minL2VwapSpread) ?? 0.15;
      
      if (liveL2Spread == null || !Number.isFinite(liveL2Spread) || liveL2Spread < minL2Vwap) {
        // 30-second per-symbol cooldown to prevent log spam
        const now = Date.now();
        if (!l2FailCooldown[top.symbol] || now > l2FailCooldown[top.symbol]) {
          // Determine specific failure reason
          const noBinance = binBuy == null && binSell == null;
          const noBybit = bybBuy == null && bybSell == null;
          const reason = noBinance && noBybit ? "no L2 orderbook data"
            : noBinance ? "no Binance L2 orderbook data"
            : noBybit ? "no Bybit L2 orderbook data"
            : `spread ${liveL2Spread?.toFixed(2)}% < min ${minL2Vwap}%`;
          console.log(`[AutoTrader-Failsafe] Aborting ${top.symbol}: Live L2 VWAP check failed (${reason}). Will retry silently for 30s.`);
          l2FailCooldown[top.symbol] = now + L2_FAIL_COOLDOWN_MS;
        }
        isExecutingTrade = false;
        return;
      }
    }
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
    console.log(`[AutoTrader] Initiating Independent Legging Sweep for ${totalQuantity} ${top.symbol}...`);
    const targetPrice = markPrice;
    let bybitTotalFilled = 0;
    let binanceTotalFilled = 0;
    let maxSweeps = 5;
    let criticalExchangeError = false;

    // Phase 1: Independent Concurrent Sweeping
    while ((bybitTotalFilled < totalQuantity || binanceTotalFilled < totalQuantity) && maxSweeps > 0) {
      let bybitNeeded = totalQuantity - bybitTotalFilled;
      let binanceNeeded = totalQuantity - binanceTotalFilled;

      if (binanceNeeded > 0) {
        const estNotional = binanceNeeded * targetPrice;
        if (estNotional < 5) {
          binanceNeeded = Math.ceil(5 / targetPrice);
        }
      }

      const sweepPromises = [];
      if (bybitNeeded > 0) {
        sweepPromises.push(
          bybitManager
            .executeLiquiditySweep(keys.bybit, top.symbol, bybitSide, bybitNeeded, levInt, 1)
            .then((res) => ({ exchange: "bybit", res }))
            .catch((err) => ({ exchange: "bybit", res: { error: err?.message || "Bybit sweep failed", totalFilled: 0 } }))
        );
      }
      if (binanceNeeded > 0) {
        sweepPromises.push(
          binanceManager
            .executeLiquiditySweep(keys.binance, top.symbol, binanceSide, binanceNeeded, levInt, 5)
            .then((res) => ({ exchange: "binance", res }))
            .catch((err) => ({ exchange: "binance", res: { error: err?.message || "Binance sweep failed", totalFilled: 0 } }))
        );
      }

      if (sweepPromises.length === 0) break;

      const results = await Promise.all(sweepPromises);
      let bybitError = false;
      let binanceError = false;

      for (const r of results) {
        if (r.exchange === "bybit") {
          bybitTotalFilled += r.res.totalFilled || 0;
          if (r.res.error && (r.res.totalFilled || 0) <= 0) bybitError = true;
          if ((r.res.totalFilled || 0) > 0) orderCircuitBreaker.recordOrderPlaced();
        }
        if (r.exchange === "binance") {
          binanceTotalFilled += r.res.totalFilled || 0;
          if (r.res.error && (r.res.totalFilled || 0) <= 0) binanceError = true;
          if ((r.res.totalFilled || 0) > 0) orderCircuitBreaker.recordOrderPlaced();
        }
      }

      if (bybitError || binanceError) {
        criticalExchangeError = true;
        const errMsg = `CRITICAL: An exchange rejected the order (BybitError: ${bybitError}, BinanceError: ${binanceError}). Aborting sweeps instantly to prevent unhedged exposure.`;
        console.error(`[AutoTrader] ${errMsg}`);
        dbLog("ERROR", errMsg, top.symbol, { bybitError, binanceError, bybitTotalFilled, binanceTotalFilled });
        break;
      }

      maxSweeps--;
      if (maxSweeps > 0) await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // Phase 2: Final Force-Balancing (True-up) — only if no critical exchange rejection
    if (!criticalExchangeError) {
      const mismatch = Math.abs(bybitTotalFilled - binanceTotalFilled);
      const mismatchNotional = mismatch * targetPrice;
      if (mismatchNotional > 6) {
        console.log(`[AutoTrader] Final Balancing: Binance ${binanceTotalFilled}, Bybit ${bybitTotalFilled}. Fixing mismatch...`);
        if (bybitTotalFilled > binanceTotalFilled) {
          let catchUpQty = bybitTotalFilled - binanceTotalFilled;
          if (catchUpQty * targetPrice < 5) catchUpQty = Math.ceil(5 / targetPrice);
          try {
            const res = await binanceManager.executeLiquiditySweep(keys.binance, top.symbol, binanceSide, catchUpQty, levInt, 5);
            if (res?.totalFilled > 0) orderCircuitBreaker.recordOrderPlaced();
            binanceTotalFilled += res?.totalFilled || 0;
          } catch (e) {
            console.error("[AutoTrader] Binance catch-up sweep failed", e?.message ?? e);
          }
        } else if (binanceTotalFilled > bybitTotalFilled) {
          const catchUpQty = binanceTotalFilled - bybitTotalFilled;
          try {
            const res = await bybitManager.executeLiquiditySweep(keys.bybit, top.symbol, bybitSide, catchUpQty, levInt, 1);
            if (res?.totalFilled > 0) orderCircuitBreaker.recordOrderPlaced();
            bybitTotalFilled += res?.totalFilled || 0;
          } catch (e) {
            console.error("[AutoTrader] Bybit catch-up sweep failed", e?.message ?? e);
          }
        }
      }
    } else {
      console.log("[AutoTrader] Skipping Phase 2 balancing due to critical exchange rejection. Relying on TradeMonitor to handle the orphan/mismatch.");
    }

    if (bybitTotalFilled <= 0) {
      console.log(`[AutoTrader] Sweep failed or 0 filled on Bybit for ${top.symbol}. Aborting.`);
      dbLog("ERROR", "Sweep failed or 0 filled on Bybit. Aborting.", top.symbol, { bybitTotalFilled, binanceTotalFilled });
      isExecutingTrade = false;
      return;
    }

    const mismatch = Math.abs(bybitTotalFilled - binanceTotalFilled);
    dbLog("ENTRY", `Chunk Executed: Binance ${binanceTotalFilled}, Bybit ${bybitTotalFilled}`, top.symbol, {
      binanceTotalFilled,
      bybitTotalFilled,
      mismatch,
    });
    lastFiredCycleKey = cycleKey;
    tradedCycles[symbol] = nextFundingTime;
    lastEntryTimeBySymbol[top.symbol] = Date.now();
    entryFundingDirectionBySymbol[top.symbol] = { binanceHigher: Number(top.fundingBinance) > Number(top.fundingBybit) };
    console.log("[AutoTrader] Entry (liquidity sweep)", top.symbol, binanceSide, bybitSide, "bybitFilled", bybitTotalFilled, "binanceFilled", binanceTotalFilled);
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
