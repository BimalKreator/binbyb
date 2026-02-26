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

/** In-memory position cache: symbol -> { binanceEntry, bybitEntry, binanceQty, bybitQty, binanceDirection, bybitSide, binanceNativePnL, bybitNativePnL, totalMargin, binanceRaw, bybitRaw }.
 *  Updated ONLY by refreshPositionCache() (called from setInterval). Tick handler ONLY reads this.
 *  Native PnL uses both API casings: unRealizedProfit/unrealizedProfit (Binance), unrealisedPnl/unrealizedProfit (Bybit).
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
    const bybitEntry = parseFloat(String(bybitPos.avgPrice ?? bybitPos.entryPrice ?? 0)) || 0;
    const binanceDirection = (parseFloat(String(binancePos.positionAmt ?? 0)) || 0) > 0 ? 1 : -1;
    const bybitSide = String(bybitPos.side ?? "").trim();
    const binanceNativePnL = parseFloat(binancePos.unRealizedProfit ?? binancePos.unrealizedProfit) || 0;
    const bybitNativePnL = parseFloat(bybitPos.unrealisedPnl ?? bybitPos.unrealizedProfit) || 0;
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
      binanceRaw: binancePos,
      bybitRaw: bybitPos,
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
  try {
    if (!io) return;
    const sym = toUpperSymbol(symbol);
    const pos = positionCache[sym];
    if (!pos) return;

    const bQty = Math.abs(parseFloat(pos.binanceQty || pos.binance?.positionAmt || pos.binanceRaw?.positionAmt || 0));
    const byQty = Math.abs(parseFloat(pos.bybitQty || pos.bybit?.size || pos.bybitRaw?.size || 0));
    if (bQty === 0 && byQty === 0) return;

    // 1. Get Entry Prices safely (Using fields that actually exist in positionCache)
    const bEntry = parseFloat(pos.binanceEntry || 0);
    const byEntry = parseFloat(pos.bybitEntry || 0);

    // 2. Get Mark Prices safely (Cache -> Manager Fallback -> 0)
    const binanceMark = parseFloat(markPriceCache[sym]?.binance) || (binanceManager && typeof binanceManager.getMarkPrice === 'function' ? parseFloat(binanceManager.getMarkPrice(sym)) : 0) || 0;
    const bybitMark = parseFloat(markPriceCache[sym]?.bybit) || (bybitManager && typeof bybitManager.getMarkPrice === 'function' ? parseFloat(bybitManager.getMarkPrice(sym)) : 0) || 0;

    // 3. Get Directions safely
    const bDir = parseFloat(pos.binanceDirection || 0) >= 0 ? 1 : -1;
    const byDir = String(pos.bybitSide || "").toLowerCase() === "buy" ? 1 : -1;

    // 4. Get Native REST Fallbacks
    const binanceNative = parseFloat(pos.binanceNativePnL || 0);
    const bybitNative = parseFloat(pos.bybitNativePnL || 0);

    // 5. Calculate Live PnL (Uses bQty and byQty already declared at the top of the function)
    const binancePnL = (bEntry > 0 && binanceMark > 0) ? bDir * (binanceMark - bEntry) * bQty : binanceNative;
    const bybitPnL = (byEntry > 0 && bybitMark > 0) ? byDir * (bybitMark - byEntry) * byQty : bybitNative;
    const combinedPnL = binancePnL + bybitPnL;

    const totalMargin = parseFloat(pos.totalMargin) || 0;
    const combinedPnlPercent =
      totalMargin > 0 && Number.isFinite(combinedPnL) ? (combinedPnL / totalMargin) * 100 : null;

    // Diagnostic log
    console.log(`[LIVE-MATH] 🟢 ${sym} | B_Entry: ${bEntry.toFixed(4)}, B_Mark: ${binanceMark.toFixed(4)} -> PnL: ${binancePnL.toFixed(4)} | By_Entry: ${byEntry.toFixed(4)}, By_Mark: ${bybitMark.toFixed(4)} -> PnL: ${bybitPnL.toFixed(4)}`);
    if (typeof io !== "undefined" && io.emit) {
      io.emit("live_pnl_update", {
        symbol: sym,
        binancePnL: Number.isFinite(binancePnL) ? binancePnL : 0,
        bybitPnL: Number.isFinite(bybitPnL) ? bybitPnL : 0,
        combinedPnL: Number.isFinite(combinedPnL) ? combinedPnL : 0,
        binanceMarkPrice: binanceMark,
        bybitMarkPrice: bybitMark,
      });
    }

    if (typeof exitCheckCallback === "function" && combinedPnlPercent != null) {
      try {
        exitCheckCallback(sym, combinedPnlPercent);
      } catch (e) {
        console.error("[LivePnl] exitCheckCallback error", sym, e?.message || e);
      }
    }
  } catch (err) {
    console.error("[PnL-Calc-Error]", toUpperSymbol(symbol), err?.message || err);
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

  // Only process tick if we hold an active position for this symbol
  if (!positionCache[sym]) return;

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
    Object.keys(positionCache).forEach((sym) => {
      if (positionCache[sym]) computeAndEmitPnL(sym);
    });
  }, 200);

  console.log(
    "[LivePnl] Started: tick handler + 200ms heartbeat; position cache refreshed every",
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
