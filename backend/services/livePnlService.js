/**
 * Live PnL over WebSocket: tick-by-tick PnL using ONLY in-memory state.
 */

let io = null;
let binanceManager = null;
let bybitManager = null;
let onExitCheck = null;
let lastLogTime = 0; // Diagnostic logging throttle
let tickCounter = 0; // For verbose tick logging
const bybitSubscribedSymbols = new Set(); // Track symbols we've asked Bybit to subscribe to
const binanceSubscribedSymbols = new Set(); // Track symbols we've asked Binance to subscribe to

const POSITION_CACHE_INTERVAL_MS = 1000;
const positionCache = Object.create(null);
const markPriceCache = Object.create(null);
let positionCacheIntervalId = null;
let pnlIntervalId = null;
let restPollingIntervalId = null;

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
  const binList = binanceManager.getLivePositions() || [];
  const bybList = bybitManager.getLivePositions() || [];
  
  // Get unique symbols from both exchanges
  const binanceSymbols = new Set(binList.map(p => toUpperSymbol(p.symbol)).filter(Boolean));
  const bybitSymbols = new Set(bybList.map(p => toUpperSymbol(p.symbol)).filter(Boolean));
  const paired = [...binanceSymbols].filter((s) => bybitSymbols.has(s));

  // Ensure Bybit is subscribed to all active paired symbols, even if they aren't in the common screener list
  if (bybitManager && bybitManager.subscribeAdditionalSymbols) {
    const missingSymbols = paired.filter(sym => !bybitSubscribedSymbols.has(sym));
    if (missingSymbols.length > 0) {
      bybitManager.subscribeAdditionalSymbols(missingSymbols);
      missingSymbols.forEach(sym => bybitSubscribedSymbols.add(sym));
    }
  }

  // Ensure Binance is subscribed to all active paired symbols L2 depth
  if (binanceManager && binanceManager.subscribeAdditionalSymbols) {
    const missingBinance = paired.filter(sym => !binanceSubscribedSymbols.has(sym));
    if (missingBinance.length > 0) {
      binanceManager.subscribeAdditionalSymbols(missingBinance);
      missingBinance.forEach(sym => binanceSubscribedSymbols.add(sym));
    }
  }

  for (const symbol of paired) {
    // FIX: Must strictly filter for active quantities > 0 to bypass empty hedge legs
    const binancePos = binList.find(p => toUpperSymbol(p.symbol) === symbol && Math.abs(parseFloat(p.positionAmt || 0)) > 0);
    const bybitPos = bybList.find(p => toUpperSymbol(p.symbol) === symbol && Math.abs(parseFloat(p.size || p.positionAmt || 0)) > 0);
    if (!binancePos || !bybitPos) continue;

    const binanceQty = Math.abs(parseFloat(binancePos.positionAmt) || 0);
    const bybitQty = Math.abs(parseFloat(bybitPos.size || bybitPos.positionAmt) || 0);
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
    if (!paired.includes(symbol)) {
      delete positionCache[symbol];
      if (io) {
        io.emit("position_closed", { symbol });
      }
    }
  }
}

function onMarkPriceTick(symbol, markPrice, source) {
  if (!symbol || markPrice == null || !Number.isFinite(markPrice)) return;
  const sym = toUpperSymbol(symbol);
  if (!markPriceCache[sym]) markPriceCache[sym] = { binance: 0, bybit: 0 };
  if (source === "binance") markPriceCache[sym].binance = markPrice;
  else if (source === "bybit") markPriceCache[sym].bybit = markPrice;
}

async function pollPositionMarkPricesRest() {
  if (!binanceManager || !bybitManager) return;
  const pairedSymbols = Object.keys(positionCache);
  for (const sym of pairedSymbols) {
    try {
      if (binanceManager.fetchMarkPriceRest) {
        const bMark = await binanceManager.fetchMarkPriceRest(sym);
        if (bMark) onMarkPriceTick(sym, bMark, "binance");
      }
      if (bybitManager.fetchMarkPriceRest) {
        const byMark = await bybitManager.fetchMarkPriceRest(sym);
        if (byMark) onMarkPriceTick(sym, byMark, "bybit");
      }
    } catch (e) {
      // ignore
    }
  }
}

function broadcastLivePnl() {
  if (!io || !binanceManager || !bybitManager) return;
  const pairedSymbols = Object.keys(positionCache);

  // Diagnostic logging every 10 seconds
  const now = Date.now();
  if (now - lastLogTime > 10000) {
    console.log(`[LivePnL] Broadcasting to ${io.engine?.clientsCount || 0} clients. Active Pairs: ${pairedSymbols.length}`);
    lastLogTime = now;
  }

  for (const sym of pairedSymbols) {
    const pos = positionCache[sym];
    if (!pos || (parseFloat(pos.binanceQty || 0) === 0 && parseFloat(pos.bybitQty || 0) === 0)) continue;

    const binanceMark = binanceManager.getMarkPrice(sym) || markPriceCache[sym]?.binance || 0;
    const bybitMark = bybitManager.getMarkPrice(sym) || markPriceCache[sym]?.bybit || 0;

    const bEntry = pos.binanceEntry || 0;
    const bQty = pos.binanceQty || 0;
    const byEntry = pos.bybitEntry || 0;
    const byQty = pos.bybitQty || 0;

    const binanceDirection = pos.binanceDirection === 1 ? 1 : -1;
    const bybitDirection = String(pos.bybitSide || "").toLowerCase() === "buy" ? 1 : -1;

    const bExitSide = binanceDirection === 1 ? "SELL" : "BUY";
    const byExitSide = bybitDirection === 1 ? "Sell" : "Buy";

    // Use Top of Book for blazing fast, never-null tick PnL
    const bBook = binanceManager.getBestBidAsk ? binanceManager.getBestBidAsk(sym) : null;
    const byBook = bybitManager.getBestBidAsk ? bybitManager.getBestBidAsk(sym) : null;

    // If exiting a LONG, we SELL at the Bid. If exiting a SHORT, we BUY at the Ask.
    // Priority: Orderbook > Mark Price > Native PnL
    let bCalcPrice = bBook ? (bExitSide === "SELL" ? bBook.bestBid : bBook.bestAsk) : 0;
    if (!bCalcPrice || bCalcPrice <= 0) bCalcPrice = binanceMark;
    
    let byCalcPrice = byBook ? (byExitSide === "Sell" ? byBook.bestBid : byBook.bestAsk) : 0;
    if (!byCalcPrice || byCalcPrice <= 0) byCalcPrice = bybitMark;

    // CROSS-EXCHANGE FALLBACK: Prevent PnL Freeze
    if (bCalcPrice > 0 && (!byCalcPrice || byCalcPrice === 0)) {
      byCalcPrice = bCalcPrice; // Use Binance price as a proxy for Bybit
    } else if (byCalcPrice > 0 && (!bCalcPrice || bCalcPrice === 0)) {
      bCalcPrice = byCalcPrice; // Use Bybit price as a proxy for Binance
    }

    // Calculate live PnL using available price, fallback to native only if no price at all
    const binancePnL = (bCalcPrice > 0 && bEntry > 0)
      ? binanceDirection * (bCalcPrice - bEntry) * bQty
      : pos.binanceNativePnL;

    const bybitPnL = (byCalcPrice > 0 && byEntry > 0)
      ? bybitDirection * (byCalcPrice - byEntry) * byQty
      : pos.bybitNativePnL;

    const combinedPnL = binancePnL + bybitPnL;

    const pnlPayload = {
      symbol: sym,
      binancePnL: Number.isFinite(binancePnL) ? binancePnL : 0,
      bybitPnL: Number.isFinite(bybitPnL) ? bybitPnL : 0,
      combinedPnL: Number.isFinite(combinedPnL) ? combinedPnL : 0,
      binanceMarkPrice: binanceMark,
      bybitMarkPrice: bybitMark,
    };

    // Verbose tick logging for proof of life (every ~4.5 seconds)
    tickCounter++;
    if (tickCounter % 15 === 0) {
      console.log(`[LivePnL-TICK] ${sym} | bEntry=${bEntry} byEntry=${byEntry} | bCalc=${bCalcPrice} byCalc=${byCalcPrice} | bPnL=${binancePnL?.toFixed(4)} byPnL=${bybitPnL?.toFixed(4)} | combined=${combinedPnL?.toFixed(4)}`);
    }

    io.emit("live_pnl_update", pnlPayload);

    if (onExitCheck && Number.isFinite(combinedPnL)) {
      onExitCheck(sym, combinedPnL);
    }
  }
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
  pnlIntervalId = setInterval(broadcastLivePnl, 300);
  restPollingIntervalId = setInterval(pollPositionMarkPricesRest, 2000);
}

function stop() {
  if (positionCacheIntervalId) {
    clearInterval(positionCacheIntervalId);
    positionCacheIntervalId = null;
  }
  if (pnlIntervalId) {
    clearInterval(pnlIntervalId);
    pnlIntervalId = null;
  }
  if (restPollingIntervalId) {
    clearInterval(restPollingIntervalId);
    restPollingIntervalId = null;
  }
  if (binanceManager) binanceManager.setOnMarkPriceUpdate(null);
  if (bybitManager) bybitManager.setOnMarkPriceUpdate(null);
  onExitCheck = null;
  io = null;
  binanceManager = null;
  bybitManager = null;
  Object.keys(positionCache).forEach((k) => delete positionCache[k]);
  Object.keys(markPriceCache).forEach((k) => delete markPriceCache[k]);
  bybitSubscribedSymbols.clear();
  binanceSubscribedSymbols.clear();
}

function setExitCheckCallback(cb) {
  onExitCheck = cb;
}

module.exports = { init, stop, setExitCheckCallback };
