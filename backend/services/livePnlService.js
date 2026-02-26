/**
 * Live PnL over WebSocket: tick-by-tick PnL using ONLY in-memory state.
 */

let io = null;
let binanceManager = null;
let bybitManager = null;

const POSITION_CACHE_INTERVAL_MS = 3000;
const positionCache = Object.create(null);
const markPriceCache = Object.create(null);
let positionCacheIntervalId = null;

function toUpperSymbol(value) {
  return String(value || "").toUpperCase();
}

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

    // Cache native PnL from exchanges as a fallback
    const binanceNativePnL = parseFloat(binancePos.unrealizedProfit) || 0;
    const bybitNativePnL = parseFloat(bybitPos.unrealizedProfit) || parseFloat(bybitPos.unrealisedPnl) || 0;

    positionCache[symbol] = {
      binanceEntry,
      bybitEntry,
      binanceQty,
      bybitQty,
      binanceDirection,
      bybitSide,
      binanceNativePnL,
      bybitNativePnL
    };
  }

  for (const symbol of Object.keys(positionCache)) {
    if (!paired.includes(symbol)) delete positionCache[symbol];
  }
}

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

  const bEntry = pos.binanceEntry || 0;
  const bQty = pos.binanceQty || 0;
  const byEntry = pos.bybitEntry || 0;
  const byQty = pos.bybitQty || 0;

  const binanceDirection = pos.binanceDirection === 1 ? 1 : -1;
  const bybitDirection = String(pos.bybitSide || "").toLowerCase() === "buy" ? 1 : -1;

  // STRICTLY INDEPENDENT MATH: Use local tick math if mark exists, otherwise use Exchange Native PnL
  const binancePnL = (binanceMark > 0 && bEntry > 0)
    ? binanceDirection * (binanceMark - bEntry) * bQty
    : pos.binanceNativePnL;

  const bybitPnL = (bybitMark > 0 && byEntry > 0)
    ? bybitDirection * (bybitMark - byEntry) * byQty
    : pos.bybitNativePnL;

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
  setTimeout(refreshPositionCache, 800);

  const tickHandler = (symbol, markPrice, source) => onMarkPriceTick(symbol, markPrice, source);
  binanceManager.setOnMarkPriceUpdate(tickHandler);
  bybitManager.setOnMarkPriceUpdate(tickHandler);

  positionCacheIntervalId = setInterval(refreshPositionCache, POSITION_CACHE_INTERVAL_MS);
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
}

function setExitCheckCallback() {
  // No-op: tick-based TP/SL removed; tradeMonitor uses position-update + runMonitor only
}

module.exports = { init, stop, setExitCheckCallback };
