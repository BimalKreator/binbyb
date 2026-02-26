/**
 * Live PnL over WebSocket: on every mark price tick, compute unrealized PnL for open positions
 * and emit live_pnl_update so the frontend can update the Active Positions table in real time.
 */

let io = null;
let binanceManager = null;
let bybitManager = null;

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

/** Build cache of open paired positions: symbol -> { binanceEntry, bybitEntry, binanceQty, bybitQty, direction } */
function buildPositionCache() {
  const binanceList = binanceManager.getLivePositions() || [];
  const bybitList = bybitManager.getLivePositions() || [];
  const binanceBySymbol = buildPrimaryBySymbol(binanceList);
  const bybitBySymbol = buildPrimaryBySymbol(bybitList);
  const binanceSymbols = new Set(Object.keys(binanceBySymbol));
  const bybitSymbols = new Set(Object.keys(bybitBySymbol));
  const paired = [...binanceSymbols].filter((s) => bybitSymbols.has(s));
  const cache = {};
  for (const symbol of paired) {
    const binancePos = binanceBySymbol[symbol];
    const bybitPos = bybitBySymbol[symbol];
    if (!binancePos || !bybitPos) continue;
    const binanceQty = Math.abs(parseFloat(binancePos.positionAmt) || 0);
    const bybitQty = Math.abs(parseFloat(bybitPos.positionAmt) || 0);
    if (binanceQty <= 0 && bybitQty <= 0) continue;
    const binanceEntry = parseFloat(binancePos.entryPrice) || 0;
    const bybitEntry = parseFloat(bybitPos.entryPrice) || 0;
    const isLong =
      (parseFloat(binancePos.positionAmt) || 0) > 0 ||
      String(binancePos.side || "").toUpperCase() === "BUY";
    const direction = isLong ? 1 : -1;
    cache[symbol] = {
      binanceEntry,
      bybitEntry,
      binanceQty,
      bybitQty,
      direction,
    };
  }
  return cache;
}

/**
 * On any mark price tick: refresh position cache and emit live_pnl_update for each open position.
 * PnL formula: long -> (mark - entry) * qty, short -> (entry - mark) * qty.
 */
function onMarkPriceTick() {
  if (!io || !binanceManager || !bybitManager) return;
  const cache = buildPositionCache();
  const symbols = Object.keys(cache);
  if (symbols.length === 0) return;
  for (const symbol of symbols) {
    const pos = cache[symbol];
    const binanceMark = binanceManager.getMarkPrice(symbol) ?? 0;
    const bybitMark = bybitManager.getMarkPrice(symbol) ?? 0;
    const { binanceEntry, bybitEntry, binanceQty, bybitQty, direction } = pos;
    const binancePnL =
      direction * (binanceMark - binanceEntry) * binanceQty;
    const bybitPnL =
      direction * (bybitMark - bybitEntry) * bybitQty;
    const combinedPnL = binancePnL + bybitPnL;
    io.emit("live_pnl_update", {
      symbol,
      binancePnL: Number.isFinite(binancePnL) ? binancePnL : 0,
      bybitPnL: Number.isFinite(bybitPnL) ? bybitPnL : 0,
      combinedPnL: Number.isFinite(combinedPnL) ? combinedPnL : 0,
    });
  }
}

function init(socketServer, binance, bybit) {
  io = socketServer;
  binanceManager = binance;
  bybitManager = bybit;
  const handler = () => onMarkPriceTick();
  binanceManager.setOnMarkPriceUpdate(handler);
  bybitManager.setOnMarkPriceUpdate(handler);
  console.log("[LivePnl] Started: emitting live_pnl_update on mark price ticks for open positions.");
}

function stop() {
  if (binanceManager) binanceManager.setOnMarkPriceUpdate(null);
  if (bybitManager) bybitManager.setOnMarkPriceUpdate(null);
  io = null;
  binanceManager = null;
  bybitManager = null;
  console.log("[LivePnl] Stopped.");
}

module.exports = {
  init,
  stop,
};
