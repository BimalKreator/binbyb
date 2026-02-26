/**
 * Live PnL over WebSocket: tick-by-tick PnL using ONLY in-memory state.
 * - Position cache: updated ONLY from User Data Streams (position updates) or a slow interval.
 * - Mark price cache: updated ONLY inside the mark-price tick handler (from the tick payload).
 * - Tick handler: ZERO network calls, ZERO getLivePositions/getMarkPrice; only local math + emit.
 */

let io = null;
let binanceManager = null;
let bybitManager = null;

/** Background position cache refresh interval. NOT in tick handler. 3–5s. */
const POSITION_CACHE_INTERVAL_MS = 3000;

/** In-memory position cache: symbol -> { binanceEntry, bybitEntry, binanceQty, bybitQty, binanceDirection, bybitSide, binanceNativePnL, bybitNativePnL }.
 *  Updated ONLY by refreshPositionCache() (called from setInterval). Tick handler ONLY reads this.
 */
const positionCache = Object.create(null);

/** Optional callback(symbol, combinedPnlPercent) called on every PnL compute for tick-based TP/SL. Set by tradeMonitor. */
let exitCheckCallback = null;

/** In-memory mark price cache: symbol -> { binance, bybit }.
 *  Updated ONLY inside the mark-price tick handler (from the tick payload). No REST, no manager reads.
 */
const markPriceCache = Object.create(null);

let positionCacheIntervalId = null;
let heartbeatIntervalId = null;

function toUpperSymbol(value) {
  return String(value || "").toUpperCase();
}

/** Build primary position per symbol (largest absolute size). Same logic as dashboard. */
function buildPrimaryBySymbol(positions) {
  const out = {};
  for (const p of positions || []) {
    const symbol = toUpperSymbol(p?.symbol);
    const positionAmt = parseFloat(String(p?.positionAmt ?? 0));
    if (!symbol || !Number.isFinite(positionAmt) || Math.abs(positionAmt) === 0) continue;
    const amtAbs = Math.abs(positionAmt);
    const existing = out[symbol];
    const existingAmt = existing ? Math.abs(parseFloat(String(existing.positionAmt ?? 0))) : 0;
    if (!existing || amtAbs > existingAmt) {
      out[symbol] = { ...p, symbol, positionAmt };
    }
  }
  return out;
}

/**
 * Refresh position cache from managers' in-memory state (WS User Data / position streams).
 * Called ONLY from setInterval. NEVER called from the mark-price tick handler.
 */
function refreshPositionCache() {
  if (!binanceManager || !bybitManager) return;
  const binanceList = binanceManager.getLivePositions() || [];
  const bybitList = bybitManager.getLivePositions() || [];
  const binanceBySymbol = buildPrimaryBySymbol(binanceList);
  const bybitBySymbol = buildPrimaryBySymbol(bybitList);
  const binanceSymbols = new Set(Object.keys(binanceBySymbol));
  const bybitSymbols = new Set(Object.keys(bybitBySymbol));
  const paired = [...binanceSymbols].filter((s) => bybitSymbols.has(s));

  for (const symbol of paired) {
    const binancePos = binanceBySymbol[symbol];
    const bybitPos = bybitBySymbol[symbol];
    if (!binancePos || !bybitPos) continue;
    const binanceQty = Math.abs(parseFloat(binancePos.positionAmt) || 0);
    const bybitQty = Math.abs(parseFloat(bybitPos.positionAmt) || 0);
    if (binanceQty <= 0 && bybitQty <= 0) continue;
    const binanceEntry = parseFloat(String(binancePos.entryPrice ?? 0)) || 0;
    const bybitEntry = parseFloat(String(bybitPos.entryPrice ?? 0)) || 0;
    const binanceDirection = (parseFloat(String(binancePos.positionAmt ?? 0)) || 0) > 0 ? 1 : -1;
    const bybitSide = String(bybitPos.side ?? "").trim();
    const binanceNativePnL = parseFloat(binancePos.unrealizedProfit) || 0;
    const bybitNativePnL = parseFloat(bybitPos.unrealizedProfit) || 0;
    const totalMargin =
      (Number.isFinite(binancePos.marginUsed) ? Number(binancePos.marginUsed) : 0) +
      (Number.isFinite(bybitPos.marginUsed) ? Number(bybitPos.marginUsed) : 0);
    positionCache[symbol] = {
      binanceEntry,
      bybitEntry,
      binanceQty,
      bybitQty,
      binanceDirection,
      bybitSide,
      binanceNativePnL,
      bybitNativePnL,
      totalMargin,
    };
  }
  // Remove symbols no longer paired
  for (const symbol of Object.keys(positionCache)) {
    if (!paired.includes(symbol)) delete positionCache[symbol];
  }
}

/**
 * Compute PnL from cached entry prices and mark prices, then emit live_pnl_update.
 * Synchronous; uses only positionCache and markPriceCache (and manager getMarkPrice fallback).
 * Reused by both the tick handler and the heartbeat.
 */
function computeAndEmitPnL(symbol) {
  if (!io) return;
  const sym = toUpperSymbol(symbol);
  const pos = positionCache[sym];
  if (!pos) return;

  const cachedBinanceMark = parseFloat(markPriceCache[sym]?.binance);
  const cachedBybitMark = parseFloat(markPriceCache[sym]?.bybit);
  const binanceMark =
    cachedBinanceMark > 0
      ? cachedBinanceMark
      : (typeof binanceManager.getMarkPrice === "function" ? parseFloat(binanceManager.getMarkPrice(sym)) : 0) || 0;
  const bybitMark =
    cachedBybitMark > 0 ? cachedBybitMark : (typeof bybitManager.getMarkPrice === "function" ? parseFloat(bybitManager.getMarkPrice(sym)) : 0) || 0;

  const bEntry = parseFloat(pos.binanceEntry);
  const bQty = parseFloat(pos.binanceQty);
  const byEntry = parseFloat(pos.bybitEntry);
  const byQty = parseFloat(pos.bybitQty);
  const binanceDirection = Number(pos.binanceDirection) === 1 ? 1 : -1;
  const bybitDirection = String(pos.bybitSide || pos.bybitDirection || "").toLowerCase() === "buy" ? 1 : -1;

  const binancePnL =
    binanceMark > 0 && bEntry > 0
      ? binanceDirection * (binanceMark - bEntry) * bQty
      : parseFloat(pos.binanceNativePnL) || 0;
  const bybitPnL =
    bybitMark > 0 && byEntry > 0 ? bybitDirection * (bybitMark - byEntry) * byQty : parseFloat(pos.bybitNativePnL) || 0;
  const combinedPnL = binancePnL + bybitPnL;
  const totalMargin = parseFloat(pos.totalMargin) || 0;
  const combinedPnlPercent =
    totalMargin > 0 && Number.isFinite(combinedPnL) ? (combinedPnL / totalMargin) * 100 : null;

  io.emit("live_pnl_update", {
    symbol: sym,
    binancePnL: Number.isFinite(binancePnL) ? binancePnL : 0,
    bybitPnL: Number.isFinite(bybitPnL) ? bybitPnL : 0,
    combinedPnL: Number.isFinite(combinedPnL) ? combinedPnL : 0,
    binanceMarkPrice: binanceMark,
    bybitMarkPrice: bybitMark,
  });

  if (typeof exitCheckCallback === "function" && combinedPnlPercent != null) {
    try {
      exitCheckCallback(sym, combinedPnlPercent);
    } catch (e) {
      console.error("[LivePnl] exitCheckCallback error", sym, e?.message || e);
    }
  }
}

/**
 * Mark price tick handler: update markPriceCache from the tick payload, then compute and emit PnL.
 */
function onMarkPriceTick(symbol, markPrice, source) {
  if (!symbol || markPrice == null || !Number.isFinite(markPrice)) return;

  const sym = toUpperSymbol(symbol);
  if (!markPriceCache[sym]) markPriceCache[sym] = { binance: 0, bybit: 0 };
  if (source === "binance") markPriceCache[sym].binance = markPrice;
  else if (source === "bybit") markPriceCache[sym].bybit = markPrice;

  computeAndEmitPnL(sym);
}

function init(socketServer, binance, bybit) {
  io = socketServer;
  binanceManager = binance;
  bybitManager = bybit;

  refreshPositionCache();
  setTimeout(refreshPositionCache, 800);

  const tickHandler = (symbol, markPrice, source) => onMarkPriceTick(symbol, markPrice, source);
  binanceManager.setOnMarkPriceUpdate(tickHandler);
  bybitManager.setOnMarkPriceUpdate(tickHandler);

  positionCacheIntervalId = setInterval(refreshPositionCache, POSITION_CACHE_INTERVAL_MS);

  heartbeatIntervalId = setInterval(() => {
    Object.keys(positionCache).forEach((sym) => computeAndEmitPnL(sym));
  }, 500);

  console.log(
    "[LivePnl] Started: tick handler + 500ms heartbeat; position cache refreshed every",
    POSITION_CACHE_INTERVAL_MS / 1000,
    "s."
  );
}

function setExitCheckCallback(cb) {
  exitCheckCallback = typeof cb === "function" ? cb : null;
}

function stop() {
  exitCheckCallback = null;
  if (positionCacheIntervalId) {
    clearInterval(positionCacheIntervalId);
    positionCacheIntervalId = null;
  }
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  if (binanceManager) binanceManager.setOnMarkPriceUpdate(null);
  if (bybitManager) bybitManager.setOnMarkPriceUpdate(null);
  io = null;
  binanceManager = null;
  bybitManager = null;
  Object.keys(positionCache).forEach((k) => delete positionCache[k]);
  Object.keys(markPriceCache).forEach((k) => delete markPriceCache[k]);
  console.log("[LivePnl] Stopped.");
}

module.exports = {
  init,
  stop,
  setExitCheckCallback,
};
