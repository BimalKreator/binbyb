/**
 * Live PnL over WebSocket: tick-by-tick PnL using ONLY in-memory state.
 * - Position cache: updated ONLY from User Data Streams (position updates) or a slow interval.
 * - Mark price cache: updated ONLY inside the mark-price tick handler (from the tick payload).
 * - Tick handler: ZERO network calls, ZERO getLivePositions/getMarkPrice; only local math + emit.
 */

let io = null;
let binanceManager = null;
let bybitManager = null;

/** Slow interval for position cache refresh (decoupled from ticks). 5–10s. */
const POSITION_CACHE_INTERVAL_MS = 5000;

/** In-memory position cache: symbol -> { binanceEntry, bybitEntry, binanceQty, bybitQty, binanceDirection, bybitDirection }.
 *  Updated ONLY by refreshPositionCache() (called from setInterval).
 */
const positionCache = Object.create(null);

/** In-memory mark price cache: symbol -> { binance, bybit }.
 *  Updated ONLY inside the mark-price tick handler (from the tick payload). No REST, no manager reads.
 */
const markPriceCache = Object.create(null);

let positionCacheIntervalId = null;

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
 * Refresh position cache from managers' in-memory state (fed by User Data Streams).
 * Called ONLY from: (1) slow setInterval, (2) onPositionUpdate callback.
 * NEVER called from the mark-price tick handler.
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
    const binanceEntry = parseFloat(binancePos.entryPrice) || 0;
    const bybitEntry = parseFloat(bybitPos.entryPrice) || 0;
    const binanceDirection = (parseFloat(binancePos.positionAmt) || 0) > 0 ? 1 : -1;
    const bybitDirection = String(bybitPos.side || "").toLowerCase() === "buy" ? 1 : -1;
    positionCache[symbol] = {
      binanceEntry,
      bybitEntry,
      binanceQty,
      bybitQty,
      binanceDirection,
      bybitDirection,
    };
  }
  // Remove symbols no longer paired
  for (const symbol of Object.keys(positionCache)) {
    if (!paired.includes(symbol)) delete positionCache[symbol];
  }
}

/**
 * Mark price tick handler: ONLY local math, ZERO network, ZERO manager reads.
 * - Updates markPriceCache from the tick payload.
 * - Reads position from positionCache.
 * - Computes PnL and emits.
 */
function onMarkPriceTick(symbol, markPrice, source) {
  if (!io || !symbol || markPrice == null || !Number.isFinite(markPrice)) return;

  const sym = toUpperSymbol(symbol);
  if (!markPriceCache[sym]) markPriceCache[sym] = { binance: 0, bybit: 0 };
  if (source === "binance") markPriceCache[sym].binance = markPrice;
  else if (source === "bybit") markPriceCache[sym].bybit = markPrice;

  const pos = positionCache[sym];
  if (!pos) return;

  const binanceMark = markPriceCache[sym].binance || 0;
  const bybitMark = markPriceCache[sym].bybit || 0;
  const { binanceEntry, bybitEntry, binanceQty, bybitQty, binanceDirection, bybitDirection } = pos;

  const binancePnL = binanceDirection * (binanceMark - binanceEntry) * binanceQty;
  const bybitPnL = bybitDirection * (bybitMark - bybitEntry) * bybitQty;
  const combinedPnL = binancePnL + bybitPnL;

  io.emit("live_pnl_update", {
    symbol: sym,
    binancePnL: Number.isFinite(binancePnL) ? binancePnL : 0,
    bybitPnL: Number.isFinite(bybitPnL) ? bybitPnL : 0,
    combinedPnL: Number.isFinite(combinedPnL) ? combinedPnL : 0,
    binanceMarkPrice: binanceMark,
    bybitMarkPrice: bybitMark,
  });
}

function init(socketServer, binance, bybit) {
  io = socketServer;
  binanceManager = binance;
  bybitManager = bybit;

  refreshPositionCache();

  const tickHandler = (symbol, markPrice, source) => onMarkPriceTick(symbol, markPrice, source);
  binanceManager.setOnMarkPriceUpdate(tickHandler);
  bybitManager.setOnMarkPriceUpdate(tickHandler);

  // Position cache: updated ONLY by slow interval. (Do not use setOnPositionUpdate here—tradeMonitor owns that callback.)
  positionCacheIntervalId = setInterval(refreshPositionCache, POSITION_CACHE_INTERVAL_MS);

  console.log(
    "[LivePnl] Started: tick handler is pure local math; position cache refreshed every",
    POSITION_CACHE_INTERVAL_MS / 1000,
    "s (no REST in tick path)."
  );
}

function stop() {
  if (positionCacheIntervalId) {
    clearInterval(positionCacheIntervalId);
    positionCacheIntervalId = null;
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
};
