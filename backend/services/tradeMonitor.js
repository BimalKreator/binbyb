/**
 * Event-driven monitoring for active arbitrage pairs.
 * - State: only from WebSocket (local activePositions). No GET position polling after startup.
 * - Entry/exit: REST used only for placing orders; no retry loops on error.
 * - On WS position-close: immediately check other exchange and close orphan with one REST POST (Hedge Mode positionSide respected).
 */

const Setting = require("../models/Setting");
const TradeLog = require("../models/TradeLog");
const { getDecryptedApiKeys } = require("./apiKeys");
const { binanceManager, bybitManager } = require("./exchanges");
const screener = require("./screener");
const autoTrader = require("./autoTrader");
const orderCircuitBreaker = require("./orderCircuitBreaker");
const livePnlService = require("./livePnlService");
const { dbLog } = require("../utils/logger");

let cachedSettingsForTick = null;
let lastSettingsFetchTime = 0;

async function getTickSettings() {
  const now = Date.now();
  if (!cachedSettingsForTick || now - lastSettingsFetchTime > 2000) {
    cachedSettingsForTick = await Setting.findOne().lean();
    lastSettingsFetchTime = now;
  }
  return cachedSettingsForTick;
}

const ORPHAN_GRACE_MS = 10000; // 10 seconds: only close orphan if position age > this (avoids false orphan from leg latency)
const ORPHAN_GRACE_PERIOD_MS = 10000; // 10 seconds: wait after first detecting an orphan before closing (avoids WS delay false orphans)

const FUNDING_WINDOW_MS = 600000; // 10 minutes before next funding
const ORPHAN_WAIT_MS = 10000; // 10 seconds before closing orphan (for timer-based orphan path)
const ORPHAN_CLOSE_COOLDOWN_MS = 30000; // 30 seconds after a failed close before retry (no spam)
const FAILED_CLOSE_COOLDOWN_MS = 10000; // 10 seconds (allows rapid TP retry)

/** Orphan tracking: symbol -> { exchange: 'binance'|'bybit', firstSeen: number } */
const orphanFirstSeen = {};
/** Cooldown until (ms) after failed orphan close to avoid API spam */
const orphanCloseCooldownUntil = {};
/** Symbols that had a close API failure: skip for 10 minutes (no retries) */
const failedClosesUntil = {};
/** Symbols currently being closed from tick callback; runMonitor skips them to avoid double-close */
const closingSymbols = new Set();

let started = false;
let runInProgress = false;
let runQueued = false;
let queueTimer = null;
let heartbeatTimer = null;
const orphanRecheckTimerBySymbol = {};

function toUpperSymbol(value) {
  return String(value || "").toUpperCase();
}

function scheduleRunAfter(delayMs) {
  setTimeout(() => queueRun(), Math.max(0, Number(delayMs) || 0));
}

/**
 * Keep a single "primary" position per symbol for cross-exchange checks.
 * If multiple rows exist for a symbol (e.g. hedge mode), pick the largest absolute size.
 */
function buildPrimaryBySymbol(positions) {
  const out = {};
  for (const p of positions || []) {
    const symbol = toUpperSymbol(p?.symbol);
    const amt = Math.abs(Number(p?.positionAmt) || 0);
    if (!symbol || amt <= 0) continue;
    const existing = out[symbol];
    if (!existing || amt > Math.abs(Number(existing.positionAmt) || 0)) {
      out[symbol] = { ...p, symbol };
    }
  }
  return out;
}

/**
 * Real-time PnL % using Real L2 VWAP exit price (executable orderbook), not mark price.
 */
function calculateRealtimePnlPercent(symbol, binancePos, bybitPos) {
  const sym = toUpperSymbol(symbol);
  const bEntry = parseFloat(binancePos?.entryPrice) || 0;
  const byEntry = parseFloat(bybitPos?.entryPrice ?? bybitPos?.avgPrice) || 0;
  const bQty = Math.abs(parseFloat(binancePos?.positionAmt) || 0);
  const byQty = Math.abs(parseFloat(bybitPos?.positionAmt) || 0);
  const bAmt = parseFloat(binancePos?.positionAmt) || 0;
  const byAmt = parseFloat(bybitPos?.positionAmt) || 0;

  let binanceRealPnl = parseFloat(binancePos?.unrealizedProfit) || 0;
  if (bQty > 0 && bEntry > 0) {
    const binNotional = bQty * bEntry;
    if (bAmt < 0) {
      const vwapBuy = binanceManager.getVwapPrice(sym, "BUY", binNotional);
      if (vwapBuy != null) binanceRealPnl = (bEntry - vwapBuy) * bQty;
    } else if (bAmt > 0) {
      const vwapSell = binanceManager.getVwapPrice(sym, "SELL", binNotional);
      if (vwapSell != null) binanceRealPnl = (vwapSell - bEntry) * bQty;
    }
  }

  let bybitRealPnl = parseFloat(bybitPos?.unrealizedProfit) || parseFloat(bybitPos?.unrealisedPnl) || 0;
  if (byQty > 0 && byEntry > 0) {
    const bybNotional = byQty * byEntry;
    if (byAmt < 0) {
      const vwapBuy = bybitManager.getVwapPrice(sym, "Buy", bybNotional);
      if (vwapBuy != null) bybitRealPnl = (byEntry - vwapBuy) * byQty;
    } else if (byAmt > 0) {
      const vwapSell = bybitManager.getVwapPrice(sym, "Sell", bybNotional);
      if (vwapSell != null) bybitRealPnl = (vwapSell - byEntry) * byQty;
    }
  }

  const combinedUnrealizedPnL = binanceRealPnl + bybitRealPnl;
  const bMargin = parseFloat(binancePos?.marginUsed) || parseFloat(binancePos?.initialMargin) || 0;
  const byMargin = parseFloat(bybitPos?.marginUsed) || parseFloat(bybitPos?.positionIM) || 0;
  const combinedMargin = bMargin + byMargin;

  if (combinedMargin <= 0) return null;
  return (combinedUnrealizedPnL / combinedMargin) * 100;
}

/** Compute combined unrealized PnL using Real L2 VWAP (for closePair logging). */
function getCombinedUnrealizedPnL(symbol, binancePos, bybitPos) {
  const sym = toUpperSymbol(symbol);
  const bEntry = parseFloat(binancePos?.entryPrice) || 0;
  const byEntry = parseFloat(bybitPos?.entryPrice ?? bybitPos?.avgPrice) || 0;
  const bQty = Math.abs(parseFloat(binancePos?.positionAmt) || 0);
  const byQty = Math.abs(parseFloat(bybitPos?.positionAmt) || 0);
  const bAmt = parseFloat(binancePos?.positionAmt) || 0;
  const byAmt = parseFloat(bybitPos?.positionAmt) || 0;

  let binanceRealPnl = parseFloat(binancePos?.unrealizedProfit) || 0;
  if (bQty > 0 && bEntry > 0) {
    const binNotional = bQty * bEntry;
    if (bAmt < 0) {
      const vwapBuy = binanceManager.getVwapPrice(sym, "BUY", binNotional);
      if (vwapBuy != null) binanceRealPnl = (bEntry - vwapBuy) * bQty;
    } else if (bAmt > 0) {
      const vwapSell = binanceManager.getVwapPrice(sym, "SELL", binNotional);
      if (vwapSell != null) binanceRealPnl = (vwapSell - bEntry) * bQty;
    }
  }

  let bybitRealPnl = parseFloat(bybitPos?.unrealizedProfit) || parseFloat(bybitPos?.unrealisedPnl) || 0;
  if (byQty > 0 && byEntry > 0) {
    const bybNotional = byQty * byEntry;
    if (byAmt < 0) {
      const vwapBuy = bybitManager.getVwapPrice(sym, "Buy", bybNotional);
      if (vwapBuy != null) bybitRealPnl = (byEntry - vwapBuy) * byQty;
    } else if (byAmt > 0) {
      const vwapSell = bybitManager.getVwapPrice(sym, "Sell", bybNotional);
      if (vwapSell != null) bybitRealPnl = (vwapSell - byEntry) * byQty;
    }
  }

  return binanceRealPnl + bybitRealPnl;
}

/**
 * Live exit spread in % for funding flip convergence (0 spread) exit.
 * SELL (Short Bin, Long Byb) -> exit = Buy Bin, Sell Byb: (bybitBid - binanceAsk) / binanceAsk * 100.
 * BUY (Long Bin, Short Byb) -> exit = Sell Bin, Buy Byb: (binanceBid - bybitAsk) / bybitAsk * 100.
 * Returns null if either book is missing.
 */
function calculateLiveExitSpread(symbol, currentBinanceSide) {
  const binanceBook = binanceManager.getTopOfBook(symbol);
  const bybitBook = bybitManager.getTopOfBook(symbol);
  if (!binanceBook || !bybitBook) return null;
  if (currentBinanceSide === "SELL") {
    return ((bybitBook.topBidPrice - binanceBook.topAskPrice) / binanceBook.topAskPrice) * 100;
  }
  if (currentBinanceSide === "BUY") {
    return ((binanceBook.topBidPrice - bybitBook.topAskPrice) / bybitBook.topAskPrice) * 100;
  }
  return null;
}

/**
 * Close paired positions using split IOC limit orders (getOrderbookPrice slippage). No REST polling.
 */
async function closePair(credentials, symbol, binancePos, bybitPos, reason, exitReasonOverride) {
  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[TradeMonitor] Order circuit breaker: trading paused, skipping closePair", toUpperSymbol(symbol));
    return { binanceOk: false, bybitOk: false };
  }
  const sym = toUpperSymbol(symbol);
  closingSymbols.add(sym);

  const settings = await Setting.findOne().lean();
  const slippagePct = Number.isFinite(Number(settings?.entrySlippagePct)) ? Number(settings.entrySlippagePct) : 0.5;

  try {
  const binanceQty = Math.abs(Number(binancePos?.positionAmt ?? binancePos?.size ?? 0) || 0);
  const bybitQty = Math.abs(Number(bybitPos?.positionAmt ?? bybitPos?.size ?? 0) || 0);
  if (binanceQty <= 0 && bybitQty <= 0) {
    return { binanceOk: false, bybitOk: false };
  }
  const binanceCloseSide = binancePos.side === "BUY" ? "SELL" : "BUY";
  const binancePositionSide = binancePos.positionSide || undefined;
  const bybitCloseSide = String(bybitPos.side || "").toLowerCase() === "buy" ? "Sell" : "Buy";

  const combinedUnrealizedPnL = getCombinedUnrealizedPnL(symbol, binancePos, bybitPos);
  const snapshot = screener.getSnapshot();
  const token = (snapshot.rankedTokens || []).find((t) => toUpperSymbol(t?.symbol) === sym);
  const markPriceFromToken = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : null;
  const fallbackMarkPrice =
    parseFloat(markPriceFromToken) ||
    parseFloat(binancePos?.markPrice) ||
    parseFloat(bybitPos?.markPrice) ||
    parseFloat(binancePos?.entryPrice) ||
    parseFloat(bybitPos?.entryPrice) ||
    binanceManager.getMarkPrice(sym) ||
    bybitManager.getMarkPrice(sym);
  if (!fallbackMarkPrice || Number.isNaN(fallbackMarkPrice)) {
    console.error("[TradeMonitor] CRITICAL: Cannot determine any price for", sym, "exit. Missing all price data.");
    return { binanceOk: false, bybitOk: false };
  }

  const binancePositionSideForClose =
    binancePositionSide === "LONG" || binancePositionSide === "SHORT"
      ? binancePositionSide
      : binanceCloseSide === "SELL"
        ? "LONG"
        : "SHORT";

  const lev = Math.max(1, Number(binancePos?.leverage ?? bybitPos?.leverage ?? 1));
  const exitSweepIterations = 30;

  const binancePromise =
    binanceQty > 0
      ? binanceManager
          .executeLiquiditySweep(
            credentials.binance,
            sym,
            binanceCloseSide,
            binanceQty,
            lev,
            exitSweepIterations,
            { reduceOnly: true, positionSide: binancePositionSideForClose, slippagePct }
          )
          .then((res) => {
            const filled = res?.totalFilled ?? 0;
            if (filled > 0) orderCircuitBreaker.recordOrderPlaced();
            return filled;
          })
      : Promise.resolve(0);
  const bybitPromise =
    bybitQty > 0
      ? bybitManager
          .executeLiquiditySweep(credentials.bybit, sym, bybitCloseSide, bybitQty, lev, exitSweepIterations, { reduceOnly: true, slippagePct })
          .then((res) => {
            const filled = res?.totalFilled ?? 0;
            if (filled > 0) orderCircuitBreaker.recordOrderPlaced();
            return filled;
          })
      : Promise.resolve(0);

  const [binanceResult, bybitResult] = await Promise.allSettled([binancePromise, bybitPromise]);
  const binanceFilled = binanceResult.status === "fulfilled" ? binanceResult.value : 0;
  const bybitFilled = bybitResult.status === "fulfilled" ? bybitResult.value : 0;

  if (binanceResult.status === "rejected" || bybitResult.status === "rejected") {
    failedClosesUntil[sym] = Date.now() + FAILED_CLOSE_COOLDOWN_MS;
    console.log(`[Phantom Protection] Failed to close ${sym}. Locked for 10s. Forcing REST Sync...`);
    binanceManager.hydratePositionsFromRest(credentials.binance).catch(() => {});
    bybitManager.hydratePositionsFromRest(credentials.bybit).catch(() => {});
  }

  if (binanceResult.status === "rejected") {
    const msg = binanceResult.reason?.message || String(binanceResult.reason);
    console.error("[TradeMonitor] closePair Binance exit sweep failed", sym, msg);
    if (msg.includes("ReduceOnly") || msg.includes("position is zero") || msg.includes("notional")) {
      console.log(`[Phantom Position Detected] ${sym} on Binance. Forcing REST Sync...`);
      binanceManager.hydratePositionsFromRest(credentials.binance).catch(() => {});
    }
  }
  if (bybitResult.status === "rejected") {
    const msg = bybitResult.reason?.message || String(bybitResult.reason);
    console.error("[TradeMonitor] closePair Bybit exit sweep failed", sym, msg);
    if (msg.includes("ReduceOnly") || msg.includes("position is zero") || msg.includes("minimum order value")) {
      console.log(`[Phantom Position Detected] ${sym} on Bybit. Forcing REST Sync...`);
      bybitManager.hydratePositionsFromRest(credentials.bybit).catch(() => {});
    }
  }

  const isPhantomError = (err) => {
    const msg = err?.message ?? String(err ?? "");
    return msg.includes("ReduceOnly") || msg.includes("position is zero");
  };
  if (
    (binanceResult.status === "rejected" && isPhantomError(binanceResult.reason)) ||
    (bybitResult.status === "rejected" && isPhantomError(bybitResult.reason))
  ) {
    console.log(`[Phantom Position Detected] ${sym}. Forcing REST sync to clear frozen cache...`);
    if (credentials?.binance && binanceManager.hydratePositionsFromRest) {
      binanceManager.hydratePositionsFromRest(credentials.binance).catch(() => {});
    }
    if (credentials?.bybit && bybitManager.hydratePositionsFromRest) {
      bybitManager.hydratePositionsFromRest(credentials.bybit).catch(() => {});
    }
  }

  const binanceOk = binanceQty <= 0 || binanceFilled > 0;
  const bybitOk = bybitQty <= 0 || bybitFilled > 0;

  // Execution prices: entry from position (before close); exit from sweep uses mark (sweep does not return avg fill)
  const binanceExecEntry = parseFloat(binancePos?.entryPrice) || fallbackMarkPrice;
  const bybitExecEntry = parseFloat(bybitPos?.entryPrice ?? bybitPos?.avgPrice) || fallbackMarkPrice;
  const binanceExecExit = fallbackMarkPrice;
  const bybitExecExit = fallbackMarkPrice;

  if (binanceOk || bybitOk) {
    const exitReasonLabel = exitReasonOverride || (reason === "SL" ? "SL exit" : reason === "Target" ? "TP/Target exit" : reason);
    dbLog("EXIT", `Auto-Exited: ${exitReasonLabel}`, sym, {
      pnl: combinedUnrealizedPnL != null ? combinedUnrealizedPnL : undefined,
      reason,
      exitReasonOverride: exitReasonOverride || null,
      binanceFilled,
      bybitFilled,
    });
    autoTrader.clearEntryFundingDirection(sym);
    const groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const reasonStr = reason === "SL" ? "SL" : "Target";
    const exitReasonStr =
      exitReasonOverride ||
      (reason === "SL" ? "Stop Loss Hit (Combined)" : "Target Profit Hit (Combined)");
    const sideStr = binancePos.side === "BUY" ? "long" : "short";
    const binancePnl = Number.isFinite(binancePos?.unrealizedProfit) ? binancePos.unrealizedProfit : combinedUnrealizedPnL / 2;
    const bybitPnl = Number.isFinite(bybitPos?.unrealizedProfit) ? bybitPos.unrealizedProfit : combinedUnrealizedPnL / 2;
    const legs = [
      {
        symbol: sym,
        entryPrice: binanceExecEntry,
        exitPrice: binanceExecExit,
        pnl: binancePnl,
        reason: reasonStr,
        exitReason: exitReasonStr,
        side: sideStr,
        exchange: "Binance",
        groupId,
        requestedEntryPrice: null,
        executedEntryPrice: binanceExecEntry,
        reqExit: fallbackMarkPrice,
        execExit: binanceExecExit,
        fee: 0,
      },
      {
        symbol: sym,
        entryPrice: bybitExecEntry,
        exitPrice: bybitExecExit,
        pnl: bybitPnl,
        reason: reasonStr,
        exitReason: exitReasonStr,
        side: sideStr,
        exchange: "Bybit",
        groupId,
        requestedEntryPrice: null,
        executedEntryPrice: bybitExecEntry,
        reqExit: fallbackMarkPrice,
        execExit: bybitExecExit,
        fee: 0,
      },
    ];
    TradeLog.insertMany(legs).catch((e) => console.error("[TradeMonitor] TradeLog insertMany failed", e.message));
  }
  return { binanceOk, bybitOk };
  } catch (err) {
    console.error(`[Exit Error] ${symbol}:`, err?.message ?? err);
    const msg = err?.message ?? String(err ?? "");
    if (msg.includes("ReduceOnly") || msg.includes("position is zero")) {
      console.log(`[Phantom Position Detected] ${symbol}. Forcing REST sync to clear frozen cache...`);
      if (credentials?.binance && binanceManager.hydratePositionsFromRest) {
        binanceManager.hydratePositionsFromRest(credentials.binance).catch(() => {});
      }
      if (credentials?.bybit && bybitManager.hydratePositionsFromRest) {
        bybitManager.hydratePositionsFromRest(credentials.bybit).catch(() => {});
      }
    }
    return { binanceOk: false, bybitOk: false };
  } finally {
    closingSymbols.delete(sym);
  }
}

/**
 * Close orphan position using split IOC limit orders (getOrderbookPrice). No REST polling.
 * @param {string} [exitReason] - Descriptive reason for the log (e.g. "Orphan Exit: Bybit Data Missing (10s Lag)")
 */
async function closeOrphanPosition(credentials, exchange, symbol, pos, exitReason) {
  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[TradeMonitor] Order circuit breaker: trading paused, skipping closeOrphan", toUpperSymbol(symbol), exchange);
    return;
  }
  if (!pos || (pos.size != null && parseFloat(pos.size) <= 0)) return;
  const sym = toUpperSymbol(symbol);
  const qty = Math.abs(Number(pos?.positionAmt ?? pos?.size ?? 0) || 0);
  if (qty <= 0) return;
  const isLong =
    (exchange === "binance" && pos.side === "BUY") ||
    (exchange === "bybit" && String(pos.side || "").toLowerCase() === "buy");
  const closeSide = isLong
    ? exchange === "binance"
      ? "SELL"
      : "Sell"
    : exchange === "binance"
      ? "BUY"
      : "Buy";

  const binancePositionSide =
    pos.positionSide === "LONG" || pos.positionSide === "SHORT"
      ? pos.positionSide
      : closeSide === "SELL"
        ? "LONG"
        : "SHORT";

  const snapshot = screener.getSnapshot();
  const token = (snapshot.rankedTokens || []).find((t) => toUpperSymbol(t?.symbol) === sym);
  const markPriceFromToken = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : null;
  const fallbackMarkPrice =
    parseFloat(markPriceFromToken) ||
    parseFloat(pos?.markPrice) ||
    parseFloat(pos?.entryPrice) ||
    (exchange === "binance" ? binanceManager.getMarkPrice(sym) : bybitManager.getMarkPrice(sym));
  if (!fallbackMarkPrice || Number.isNaN(fallbackMarkPrice)) {
    console.error("[TradeMonitor] CRITICAL: Cannot determine any price for", sym, "orphan exit. Missing all price data.");
    return;
  }

  const lev = Math.max(1, Number(pos?.leverage ?? 1));
  const exitSweepIterations = 30;

  const settings = await Setting.findOne().lean();
  const slippagePct = Number.isFinite(Number(settings?.entrySlippagePct)) ? Number(settings.entrySlippagePct) : 0.5;

  try {
    let res;
    if (exchange === "binance") {
      res = await binanceManager.executeLiquiditySweep(
        credentials.binance,
        sym,
        closeSide,
        qty,
        lev,
        exitSweepIterations,
        { reduceOnly: true, positionSide: binancePositionSide, slippagePct }
      );
    } else {
      res = await bybitManager.executeLiquiditySweep(
        credentials.bybit,
        sym,
        closeSide,
        qty,
        lev,
        exitSweepIterations,
        { reduceOnly: true, slippagePct }
      );
    }
    if ((res?.totalFilled ?? 0) > 0) orderCircuitBreaker.recordOrderPlaced();
    if (res?.error) {
      const msg = String(res.error);
      if (msg.includes("ReduceOnly") || msg.includes("position is zero") || msg.includes("notional") || msg.includes("minimum order value")) {
        console.log(`[Phantom Position Detected] ${sym} on ${exchange}. Locking for 10s + REST Sync...`);
        failedClosesUntil[sym] = Date.now() + FAILED_CLOSE_COOLDOWN_MS;
        if (exchange === "binance") {
          binanceManager.hydratePositionsFromRest(credentials?.binance).catch(() => {});
        } else {
          bybitManager.hydratePositionsFromRest(credentials?.bybit).catch(() => {});
        }
        return;
      }
    }
  } catch (e) {
    const msg = e?.message ?? String(e ?? "");
    console.error("[TradeMonitor] closeOrphanPosition exit sweep failed", exchange, sym, msg);
    if (msg.includes("ReduceOnly") || msg.includes("position is zero") || msg.includes("notional") || msg.includes("minimum order value")) {
      console.log(`[Phantom Position Detected] ${sym} on ${exchange}. Locking for 10 mins + REST Sync...`);
      failedClosesUntil[sym] = Date.now() + FAILED_CLOSE_COOLDOWN_MS;
      if (exchange === "binance") {
        binanceManager.hydratePositionsFromRest(credentials?.binance).catch(() => {});
      } else {
        bybitManager.hydratePositionsFromRest(credentials?.bybit).catch(() => {});
      }
    }
    return;
  }

  const execExitPrice = fallbackMarkPrice;

  autoTrader.clearEntryFundingDirection(sym);
  const unrealized = Number.isFinite(pos?.unrealizedProfit) ? pos.unrealizedProfit : 0;
  const exchangeName = exchange === "binance" ? "Binance" : "Bybit";
  const execEntryPrice = parseFloat(pos?.entryPrice ?? pos?.avgPrice) || fallbackMarkPrice;
  TradeLog.create({
    symbol: sym,
    entryPrice: execEntryPrice,
    exitPrice: execExitPrice,
    pnl: unrealized,
    reason: "Orphan",
    exitReason: exitReason || "Orphan",
    side: isLong ? "long" : "short",
    exchange: exchangeName,
    groupId: null,
    requestedEntryPrice: null,
    executedEntryPrice: execEntryPrice,
    reqExit: fallbackMarkPrice,
    execExit: execExitPrice,
    fee: 0,
  }).catch((e) => console.error("[TradeMonitor] TradeLog create failed", e.message));
  dbLog("EXIT", `Orphan closed: ${exitReason || "Orphan"}`, sym, { pnl: unrealized, exchange: exchangeName });
  console.log("[TradeMonitor] Orphan closed", exchange, sym);
}

async function runMonitor() {
  const settings = await Setting.findOne().lean();
  if (!settings?.autoExitEnabled) return;

  const keys = await getDecryptedApiKeys();
  if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
    return;
  }

  const stopLoss = Number(settings?.stopLoss ?? settings?.slPercent ?? 0);
  const takeProfit = Number(settings?.takeProfit ?? settings?.tpPercent ?? 0);
  const now = Date.now();

  // Exit loops read from local position state (Binance: ACCOUNT_UPDATE, Bybit: position topic)
  const binanceBySymbol = buildPrimaryBySymbol(binanceManager.getLivePositions());
  const bybitBySymbol = buildPrimaryBySymbol(bybitManager.getLivePositions());
  const binanceSymbols = new Set(Object.keys(binanceBySymbol));
  const bybitSymbols = new Set(Object.keys(bybitBySymbol));

  // Orphan = non-zero position exists on exactly one exchange
  const onlyBinance = [...binanceSymbols].filter((s) => !bybitSymbols.has(s));
  const onlyBybit = [...bybitSymbols].filter((s) => !binanceSymbols.has(s));

  for (const symbol of onlyBinance) {
    if (closingSymbols.has(symbol)) continue; // Do not treat as orphan while TP/SL close in progress
    if (!orphanFirstSeen[symbol]) {
      orphanFirstSeen[symbol] = { exchange: "binance", firstSeen: now };
      console.log(`[TradeMonitor] Orphan detected for ${symbol}. Waiting 10s for data sync.`);
      if (!orphanRecheckTimerBySymbol[symbol]) {
        orphanRecheckTimerBySymbol[symbol] = setTimeout(() => {
          delete orphanRecheckTimerBySymbol[symbol];
          queueRun();
        }, ORPHAN_WAIT_MS + 100);
      }
    } else if (orphanFirstSeen[symbol].exchange !== "binance") {
      orphanFirstSeen[symbol] = { exchange: "binance", firstSeen: now };
    }
  }
  for (const symbol of onlyBybit) {
    if (closingSymbols.has(symbol)) continue; // Do not treat as orphan while TP/SL close in progress
    if (!orphanFirstSeen[symbol]) {
      orphanFirstSeen[symbol] = { exchange: "bybit", firstSeen: now };
      console.log(`[TradeMonitor] Orphan detected for ${symbol}. Waiting 10s for data sync.`);
      if (!orphanRecheckTimerBySymbol[symbol]) {
        orphanRecheckTimerBySymbol[symbol] = setTimeout(() => {
          delete orphanRecheckTimerBySymbol[symbol];
          queueRun();
        }, ORPHAN_WAIT_MS + 100);
      }
    } else if (orphanFirstSeen[symbol].exchange !== "bybit") {
      orphanFirstSeen[symbol] = { exchange: "bybit", firstSeen: now };
    }
  }

  const pairedSymbols = [...binanceSymbols].filter((s) => bybitSymbols.has(s));
  for (const symbol of pairedSymbols) {
    delete orphanFirstSeen[symbol];
    delete orphanCloseCooldownUntil[symbol];
    delete failedClosesUntil[symbol];
    if (orphanRecheckTimerBySymbol[symbol]) {
      clearTimeout(orphanRecheckTimerBySymbol[symbol]);
      delete orphanRecheckTimerBySymbol[symbol];
    }
  }

  // Orphan exit: only close after 10s grace; skip if this symbol is being closed as a pair (avoid double-kill)
  for (const symbol of Object.keys(orphanFirstSeen)) {
    const rec = orphanFirstSeen[symbol];
    if (closingSymbols.has(symbol)) continue;
    if (now < (orphanCloseCooldownUntil[symbol] || 0)) continue;
    if (now < (failedClosesUntil[symbol] || 0)) continue;

    const elapsed = now - rec.firstSeen;
    if (elapsed < ORPHAN_GRACE_PERIOD_MS) continue; // Still in grace period

    const stillOnlyBinance = rec.exchange === "binance" && binanceSymbols.has(symbol) && !bybitSymbols.has(symbol);
    const stillOnlyBybit = rec.exchange === "bybit" && bybitSymbols.has(symbol) && !binanceSymbols.has(symbol);

    if (stillOnlyBinance) {
      const pos = binanceBySymbol[symbol];
      if (pos && Math.abs(Number(pos.positionAmt) || 0) > 0) {
        try {
          await closeOrphanPosition(keys, "binance", symbol, pos, "Orphan: Bybit Lag (10s)");
          delete orphanFirstSeen[symbol];
          delete orphanCloseCooldownUntil[symbol];
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] Orphan close failed binance", symbol, e.message || e);
          orphanCloseCooldownUntil[symbol] = now + ORPHAN_CLOSE_COOLDOWN_MS;
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
          scheduleRunAfter(ORPHAN_CLOSE_COOLDOWN_MS + 100);
        }
      } else {
        delete orphanFirstSeen[symbol];
      }
    } else if (stillOnlyBybit) {
      const pos = bybitBySymbol[symbol];
      if (pos && Math.abs(Number(pos.positionAmt) || 0) > 0) {
        try {
          await closeOrphanPosition(keys, "bybit", symbol, pos, "Orphan: Binance Lag (10s)");
          delete orphanFirstSeen[symbol];
          delete orphanCloseCooldownUntil[symbol];
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] Orphan close failed bybit", symbol, e.message || e);
          orphanCloseCooldownUntil[symbol] = now + ORPHAN_CLOSE_COOLDOWN_MS;
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
          scheduleRunAfter(ORPHAN_CLOSE_COOLDOWN_MS + 100);
        }
      } else {
        delete orphanFirstSeen[symbol];
      }
    } else {
      delete orphanFirstSeen[symbol];
      delete orphanCloseCooldownUntil[symbol];
    }
  }

  // Paired positions: SL/TP and funding flip
  const snapshot = screener.getSnapshot();
  const rankedTokens = snapshot.rankedTokens || [];

  for (const symbol of pairedSymbols) {
    // CRITICAL FIX: If the symbol is currently being closed (e.g., TP/SL Hit), do NOT trigger orphan detection or mismatch fixing. Skip entirely.
    if (closingSymbols.has(symbol)) {
      continue;
    }
    // PREVENT RACE CONDITION: Skip monitoring completely if AutoTrader is currently building this position
    if (global.activeEnteringSymbols && global.activeEnteringSymbols.has(symbol)) {
      continue;
    }
    if (now < (failedClosesUntil[symbol] || 0)) continue;
    const binancePos = binanceBySymbol[symbol];
    const bybitPos = bybitBySymbol[symbol];
    if (!binancePos || !bybitPos) continue;

    const liqAutoCloseOn = settings?.liquidationAutoClose ?? false;
    const liqDistanceLimit = settings?.liquidationDistancePct ?? 25;
    if (liqAutoCloseOn) {
      const binanceLiq = parseFloat(binancePos?.liquidationPrice ?? 0);
      const binanceMark = parseFloat(binancePos?.markPrice ?? 0) || binanceManager.getMarkPrice(symbol) || 0;
      const bybitLiq = parseFloat(bybitPos?.liqPrice ?? bybitPos?.liquidationPrice ?? 0);
      const bybitMark = parseFloat(bybitPos?.markPrice ?? 0) || bybitManager.getMarkPrice(symbol) || 0;
      const binanceLiqDist = binanceLiq > 0 && binanceMark > 0 ? (Math.abs(binanceMark - binanceLiq) / binanceMark) * 100 : 100;
      const bybitLiqDist = bybitLiq > 0 && bybitMark > 0 ? (Math.abs(bybitMark - bybitLiq) / bybitMark) * 100 : 100;

      if (binanceLiq > 0 && binanceLiqDist <= liqDistanceLimit) {
        console.log(`[TradeMonitor] LIQUIDATION ALERT: Binance distance ${binanceLiqDist.toFixed(2)}% <= ${liqDistanceLimit}%. Auto-closing ${symbol}.`);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "Target", "Auto-Close: Binance Near Liquidation");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (liquidation Binance) failed", symbol, e?.message ?? e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
        continue;
      }
      if (bybitLiq > 0 && bybitLiqDist <= liqDistanceLimit) {
        console.log(`[TradeMonitor] LIQUIDATION ALERT: Bybit distance ${bybitLiqDist.toFixed(2)}% <= ${liqDistanceLimit}%. Auto-closing ${symbol}.`);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "Target", "Auto-Close: Bybit Near Liquidation");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (liquidation Bybit) failed", symbol, e?.message ?? e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
        continue;
      }
    }

    const pnlPct = calculateRealtimePnlPercent(symbol, binancePos, bybitPos);
    const useStoploss = Boolean(settings?.useStoploss);
    const useTarget = Boolean(settings?.useTarget);
    if (pnlPct != null) {
      if (useStoploss && stopLoss > 0 && pnlPct <= -stopLoss) {
        console.log("[TradeMonitor] SL exit", symbol, "PnL%", pnlPct.toFixed(2), "stopLoss", stopLoss);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "SL");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (SL) failed", symbol, e.message || e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
        continue;
      }
      if (useTarget && takeProfit > 0 && pnlPct >= takeProfit) {
        console.log("[TradeMonitor] TP exit", symbol, "PnL%", pnlPct.toFixed(2), "takeProfit", takeProfit);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "Target");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (TP) failed", symbol, e.message || e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
        continue;
      }
    }

    const token = rankedTokens.find((t) => toUpperSymbol(t?.symbol) === symbol);
    const nextFundingTimeRaw = token?.nextFundingTime ?? null;
    const bFR = Number(token?.fundingBinance ?? binanceManager.getCachedFundingRate(symbol) ?? 0) || 0;
    const byFR = Number(token?.fundingBybit ?? bybitManager.getCachedFundingRate(symbol) ?? 0) || 0;
    const bQtyRaw = parseFloat(binancePos?.positionAmt ?? binancePos?.size ?? 0) || 0;
    const byQtyRaw = parseFloat(bybitPos?.positionAmt ?? bybitPos?.size ?? 0) || 0;
    const mark = binanceManager.getMarkPrice(symbol) ?? bybitManager.getMarkPrice(symbol) ?? 0;
    const binanceQty = Math.abs(bQtyRaw);
    const bybitQty = Math.abs(byQtyRaw);
    const notionalBinance = binanceQty * mark;
    const notionalBybit = bybitQty * mark;
    const binanceIsLong = bQtyRaw > 0;
    const bybitIsLong = String(bybitPos?.side || "").toLowerCase() === "buy";
    const binanceFee = binanceIsLong ? notionalBinance * -bFR : notionalBinance * bFR;
    const bybitFee = bybitIsLong ? notionalBybit * -byFR : notionalBybit * byFR;
    const totalFundingIncome = binanceFee + bybitFee;
    const isFundingFlipped = totalFundingIncome < 0;
    if (isFundingFlipped && nextFundingTimeRaw != null && Number.isFinite(nextFundingTimeRaw)) {
      // Normalize to ms: APIs may send ms (13 digits) or seconds (10 digits)
      const nextFundingTimeMs = nextFundingTimeRaw >= 1e12 ? nextFundingTimeRaw : nextFundingTimeRaw * 1000;
      const msToFunding = nextFundingTimeMs - now;
      const in10MinWindow = msToFunding >= 0 && msToFunding <= FUNDING_WINDOW_MS;

      if (in10MinWindow) {
        console.log("[TradeMonitor] Executing Flip Exit (10 min before funding) for", symbol, "msToFunding", Math.round(msToFunding / 1000), "s");
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "Target", "Funding Flip Exit (10 min before funding)");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (funding flip 10min) failed", symbol, e.message || e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
      } else {
        const currentBinanceSide = binanceIsLong ? "BUY" : "SELL";
        const exitSpread = calculateLiveExitSpread(symbol, currentBinanceSide);
        const l2Favorable = exitSpread != null && exitSpread >= 0;
        if (l2Favorable) {
          console.log("[TradeMonitor] Executing Flip Exit at favorable L2 spread for", symbol, "exitSpread", exitSpread?.toFixed(4), "%");
          try {
            await closePair(keys, symbol, binancePos, bybitPos, "Target", "Funding Flip Exit (Combined)");
            delete failedClosesUntil[symbol];
          } catch (e) {
            console.error("[TradeMonitor] closePair (funding flip) failed", symbol, e.message || e);
            failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
          }
        } else {
          console.log("[TradeMonitor] Funding flipped for", symbol, "exit spread", exitSpread != null ? exitSpread.toFixed(4) + "%" : "null", ". Waiting for favorable L2 or 10 min window.");
        }
      }
    }

    // ---------------------------------------------------------
    // MISMATCH DETECTION & FIXING (STRICTLY GUARDED)
    // ---------------------------------------------------------
    // CRITICAL FIX: NEVER attempt to fix a mismatch if the pair is already in the process of closing (e.g., via TP/SL)
    if (!closingSymbols.has(symbol)) {
      const mismatchFirstSeen = (global.mismatchFirstSeen = global.mismatchFirstSeen || {});

      const bQty = Math.abs(parseFloat(binancePos?.positionAmt ?? binancePos?.size ?? 0) || 0);
      const byQty = Math.abs(parseFloat(bybitPos?.positionAmt ?? bybitPos?.size ?? 0) || 0);
      const qtyDiff = Math.abs(bQty - byQty);

      const bMark = Number(binancePos?.markPrice ?? 0) || binanceManager.getMarkPrice(symbol) || 0;
      const yMark = Number(bybitPos?.markPrice ?? 0) || bybitManager.getMarkPrice(symbol) || 0;
      const markPrice = bMark || yMark || 0;

      // Use dynamic threshold: 1% of the larger position or absolute minimum size (e.g., 5)
      const mismatchThreshold = Math.max(5, Math.max(bQty, byQty) * 0.01);

      if (qtyDiff > mismatchThreshold && bMark > 0 && yMark > 0) {
        const notionalDiff = qtyDiff * markPrice;

        // Only fix if the difference is worth > $6 to avoid API spam on dust
        if (notionalDiff >= 6.0) {
          if (!mismatchFirstSeen[symbol]) {
            console.log(`[TradeMonitor] Mismatch detected on ${symbol}: Binance ${bQty}, Bybit ${byQty}. Starting 60s timer.`);
            mismatchFirstSeen[symbol] = now;
          } else {
            const elapsed = now - mismatchFirstSeen[symbol];
            if (elapsed > 60000) {
              console.log(`[TradeMonitor] 60s elapsed for mismatch on ${symbol}. Attempting fix.`);

              const lowExchange = bQty < byQty ? "binance" : "bybit";
              const highExchange = bQty > byQty ? "binance" : "bybit";
              const lowPos = lowExchange === "binance" ? binancePos : bybitPos;
              const highPos = highExchange === "binance" ? binancePos : bybitPos;

              const lowLeverage = Math.max(1, Number(lowPos?.leverage ?? lowPos?.leverageId ?? 1));
              let requiredMargin = (qtyDiff * markPrice) / lowLeverage;
              requiredMargin *= 1.1;

              let availableBalance = 0;
              try {
                if (lowExchange === "binance") {
                  const bal = binanceManager.getBalance(keys.binance);
                  availableBalance = typeof bal === "number" ? bal : Number(bal?.availableBalance ?? bal?.available ?? 0) || 0;
                } else {
                  const bal = bybitManager.getBalance();
                  availableBalance = typeof bal === "number" ? bal : Number(bal?.availableBalance ?? bal?.available ?? bal?.equity ?? 0) || 0;
                }
              } catch (e) {
                console.warn("[TradeMonitor] Mismatch fix: balance fetch failed", symbol, e?.message ?? e);
              }

              const doReduce = async (reason) => {
                const posToReduce = { ...highPos, positionAmt: qtyDiff, size: qtyDiff };
                await closeOrphanPosition(keys, highExchange, symbol, posToReduce);
                console.log(`[TradeMonitor] Mismatch Fix: Reducing ${highExchange} by ${qtyDiff} (${reason})`);
              };

              if (!orderCircuitBreaker.canPlaceOrder()) {
                // skip this run
              } else if (availableBalance > requiredMargin) {
                const sym = String(symbol).toUpperCase();
                const slippagePct = Number.isFinite(settings?.entrySlippagePct) ? Math.max(0, Math.min(100, settings.entrySlippagePct)) : 0.1;
                const isLong = String(lowPos?.side || "").toUpperCase() === "BUY";
                const addSide = lowExchange === "binance" ? (isLong ? "BUY" : "SELL") : (isLong ? "Buy" : "Sell");
                const addPrice = lowExchange === "binance"
                  ? (binanceManager.getOrderbookPrice(sym, addSide, slippagePct) ?? bMark)
                  : (bybitManager.getOrderbookPrice(sym, addSide, slippagePct) ?? yMark);

                try {
                  if (lowExchange === "binance") {
                    await binanceManager.placeIOCLimitOrder(keys.binance, sym, addSide, qtyDiff, addPrice, {
                      positionSide: lowPos?.positionSide || (isLong ? "LONG" : "SHORT"),
                      leverage: lowLeverage,
                    });
                  } else {
                    await bybitManager.placeIOCLimitOrder(keys.bybit, sym, addSide, qtyDiff, addPrice, {
                      positionIdx: lowPos?.positionIdx,
                      leverage: lowLeverage,
                    });
                  }
                  orderCircuitBreaker.recordOrderPlaced();
                  console.log(`[TradeMonitor] Mismatch Fix: Increasing ${lowExchange} by ${qtyDiff} (Funds: $${availableBalance.toFixed(2)} > Req: $${requiredMargin.toFixed(2)})`);
                } catch (e) {
                  console.warn("[TradeMonitor] Mismatch fix (Add) failed, attempting Reduce fallback", symbol, e?.message ?? e);
                  try {
                    await doReduce("Add failed, fallback");
                  } catch (e2) {
                    console.error(`[TradeMonitor] Mismatch fix Reduce fallback failed for ${symbol}:`, e2?.message ?? e2);
                  }
                }
                failedClosesUntil[symbol] = now + 30000;
                delete mismatchFirstSeen[symbol];
              } else {
                try {
                  await doReduce("Insufficient funds on other side");
                } catch (e) {
                  console.error(`[TradeMonitor] Failed to fix mismatch for ${symbol}:`, e?.message ?? e);
                }
                failedClosesUntil[symbol] = now + 30000;
                delete mismatchFirstSeen[symbol];
              }
            }
          }
        } else {
          // Dust mismatch, ignore
          delete mismatchFirstSeen[symbol];
        }
      } else {
        // Mismatch resolved naturally or below threshold
        if (mismatchFirstSeen[symbol]) {
          console.log(`[TradeMonitor] Mismatch resolved naturally for ${symbol}.`);
          delete mismatchFirstSeen[symbol];
        }
      }
    }
    // ---------------------------------------------------------
  }
}

function queueRun() {
  if (!started) return;
  if (queueTimer) return;
  queueTimer = setTimeout(async () => {
    queueTimer = null;
    if (runInProgress) {
      runQueued = true;
      return;
    }
    runInProgress = true;
    try {
      await runMonitor();
    } catch (e) {
      console.error("[TradeMonitor] run error", e.message || e);
    } finally {
      runInProgress = false;
      if (runQueued) {
        runQueued = false;
        queueRun();
      }
    }
  }, 150);
}

/**
 * Event-driven orphan close: when WS shows a position closed on one exchange,
 * immediately check the other exchange's local state; if still open, close it with one REST POST (no retry loop).
 */
function handlePositionClosed(symbol, closedExchange) {
  const sym = toUpperSymbol(symbol);
  if (!sym) return;
  const now = Date.now();
  if (now < (orphanCloseCooldownUntil[sym] || 0)) return;
  if (now < (failedClosesUntil[sym] || 0)) return;

  getDecryptedApiKeys()
    .then((keys) => {
      if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) return;
      const otherExchange = closedExchange === "binance" ? "bybit" : "binance";
      const positions = otherExchange === "binance" ? binanceManager.getLivePositions() : bybitManager.getLivePositions();
      const forSymbol = (positions || []).filter((p) => toUpperSymbol(p?.symbol) === sym && Math.abs(Number(p?.positionAmt) || 0) > 0);
      const primary = forSymbol.length ? forSymbol.reduce((a, b) => (Math.abs(Number(b?.positionAmt) || 0) > Math.abs(Number(a?.positionAmt) || 0) ? b : a)) : null;
      if (!primary) return;
      const posAge = Date.now() - (primary.createdTime ?? primary.updatedTime ?? Date.now());
      if (posAge <= ORPHAN_GRACE_MS) return;
      return closeOrphanPosition(keys, otherExchange, sym, primary, "Orphan: Pair Closed (Follow-up)").then(
        () => {
          delete orphanCloseCooldownUntil[sym];
          delete failedClosesUntil[sym];
        },
        (e) => {
          console.error("[TradeMonitor] Immediate orphan close failed", otherExchange, sym, e?.message || e);
          orphanCloseCooldownUntil[sym] = Date.now() + ORPHAN_CLOSE_COOLDOWN_MS;
          failedClosesUntil[sym] = Date.now() + FAILED_CLOSE_COOLDOWN_MS;
        }
      );
    })
    .catch((e) => console.error("[TradeMonitor] handlePositionClosed", e?.message || e));
}

function start() {
  if (started) return;
  started = true;
  binanceManager.setOnPositionUpdate(() => queueRun());
  bybitManager.setOnPositionUpdate(() => queueRun());
  binanceManager.setOnPositionClosed((symbol, exchange) => handlePositionClosed(symbol, exchange));
  bybitManager.setOnPositionClosed((symbol, exchange) => handlePositionClosed(symbol, exchange));

  livePnlService.setExitCheckCallback(async (symbol, combinedPnl) => {
    const sym = String(symbol).toUpperCase();
    if (closingSymbols.has(sym)) return;
    if (Date.now() < (failedClosesUntil[sym] || 0)) return; // DO NOT RETRY IF LOCKED

    const settings = await getTickSettings();
    if (!settings || !settings.autoExitEnabled) return;

    const keys = await getDecryptedApiKeys();
    if (!keys?.binance || !keys?.bybit) return;

    const binList = binanceManager.getLivePositions() || [];
    const bybList = bybitManager.getLivePositions() || [];
    // FIX: Must filter by absolute quantity > 0 to grab the correct active Hedge leg
    const bp = binList.find((p) => String(p.symbol).toUpperCase() === sym && Math.abs(parseFloat(p.positionAmt || p.size || 0)) > 0);
    const yp = bybList.find((p) => String(p.symbol).toUpperCase() === sym && Math.abs(parseFloat(p.positionAmt || p.size || 0)) > 0);

    if (!bp || !yp) return;

    // ---------------------------------------------------------
    // UNIVERSAL FUNDING FLIP EXIT LOGIC (VWAP BASED)
    // ---------------------------------------------------------
    const binFundingInfo = binanceManager.getCachedFundingRate(sym);
    const bybFundingInfo = bybitManager.getCachedFundingRate(sym);

    if (binFundingInfo && bybFundingInfo && settings?.autoExitEnabled) {
      const bFunding = typeof binFundingInfo === "number" ? binFundingInfo : (binFundingInfo?.fundingRate || 0);
      const yFunding = typeof bybFundingInfo === "number" ? bybFundingInfo : (bybFundingInfo?.fundingRate || 0);

      // Determine direction based on Binance leg
      const isBinanceLong = String(bp.side || "").toUpperCase() === "BUY" || parseFloat(bp.positionAmt || 0) > 0;
      
      // Net funding: If Binance is Long, we receive Binance funding and pay Bybit funding
      const netFunding = isBinanceLong ? (bFunding - yFunding) : (yFunding - bFunding);

      if (netFunding < 0) { // Funding has flipped against us
        const nextFundingTime = Math.min(
          binFundingInfo?.nextFundingTime || Infinity,
          bybFundingInfo?.nextFundingTime || Infinity
        );
        
        const timeToFundingMs = nextFundingTime - Date.now();
        const twoMinutesMs = 2 * 60 * 1000;

        let shouldExit = false;
        let exitLogReason = "";

        if (timeToFundingMs > 0 && timeToFundingMs <= twoMinutesMs) {
          // Less than 2 minutes left -> Force Exit
          shouldExit = true;
          exitLogReason = "Funding Flip (Force Exit < 2 mins)";
        } else {
          // Wait for L2 VWAP Spread to become positive
          const bMark = binanceManager.getMarkPrice(sym) || 0;
          const yMark = bybitManager.getMarkPrice(sym) || 0;
          
          const bQty = Math.abs(parseFloat(bp.positionAmt || 0));
          const yQty = Math.abs(parseFloat(yp.size || yp.positionAmt || 0));

          const bTargetNotional = bQty * bMark;
          const yTargetNotional = yQty * yMark;

          // Exit sides are opposite of entry sides
          const bExitSide = isBinanceLong ? "SELL" : "BUY";
          const yExitSide = isBinanceLong ? "Buy" : "Sell"; 

          const bVwap = binanceManager.getVwapPrice ? binanceManager.getVwapPrice(sym, bExitSide, bTargetNotional) : null;
          const yVwap = bybitManager.getVwapPrice ? bybitManager.getVwapPrice(sym, yExitSide, yTargetNotional) : null;

          if (bVwap && yVwap) {
            // Calculate VWAP spread exactly like the Screener does for exits
            const exitVwapSpread = isBinanceLong
              ? ((bVwap - yVwap) / yVwap) * 100
              : ((yVwap - bVwap) / bVwap) * 100;

            if (exitVwapSpread > 0) {
              shouldExit = true;
              exitLogReason = `Funding Flip (Smart VWAP Spread: +${exitVwapSpread.toFixed(4)}%)`;
            }
          }
        }

        if (shouldExit && !closingSymbols.has(sym)) {
          console.log(`[TradeMonitor] ${sym} triggering Funding Flip Exit: ${exitLogReason}`);
          await closePair(keys, sym, bp, yp, "Funding Flip", exitLogReason);
          return; // Exit this callback, position is closing
        }
      }
    }
    // ---------------------------------------------------------

    const bMargin = parseFloat(bp.marginUsed) || 0;
    const yMargin = parseFloat(yp.marginUsed) || 0;
    const totalMargin = bMargin + yMargin;

    if (totalMargin <= 0) return;

    const pnlPct = (combinedPnl / totalMargin) * 100;

    if (settings.useTarget && settings.takeProfit > 0 && pnlPct >= settings.takeProfit) {
      console.log(`[Tick-Exit] ${symbol} Hit Take Profit: ${pnlPct.toFixed(2)}% >= ${settings.takeProfit}%`);
      try {
        await closePair(keys, symbol, bp, yp, "Target", "Take Profit Hit");
      } catch (e) {
        console.error("[TradeMonitor] Tick-Exit TP closePair failed", symbol, e?.message ?? e);
      }
    } else if (settings.useStoploss && settings.stopLoss > 0 && pnlPct <= -Math.abs(settings.stopLoss)) {
      console.log(`[Tick-Exit] ${symbol} Hit Stop Loss: ${pnlPct.toFixed(2)}% <= -${settings.stopLoss}%`);
      try {
        await closePair(keys, symbol, bp, yp, "SL", "Stop Loss Hit");
      } catch (e) {
        console.error("[TradeMonitor] Tick-Exit SL closePair failed", symbol, e?.message ?? e);
      }
    }
  });

  heartbeatTimer = setInterval(() => queueRun(), 1000);
  queueRun();
  console.log("[TradeMonitor] Started (event-driven + 1s active heartbeat for fast TP/SL).");
}

function stop() {
  if (!started) return;
  started = false;
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const symbol of Object.keys(orphanRecheckTimerBySymbol)) {
    clearTimeout(orphanRecheckTimerBySymbol[symbol]);
    delete orphanRecheckTimerBySymbol[symbol];
  }
  binanceManager.setOnPositionUpdate(null);
  bybitManager.setOnPositionUpdate(null);
  binanceManager.setOnPositionClosed(null);
  bybitManager.setOnPositionClosed(null);
  livePnlService.setExitCheckCallback(null);
  closingSymbols.clear();
  runQueued = false;
  console.log("[TradeMonitor] Stopped.");
}

module.exports = {
  start,
  stop,
  runMonitor,
};
