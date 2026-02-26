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

const ORPHAN_GRACE_MS = 10000; // 10 seconds: only close orphan if position age > this (avoids false orphan from leg latency)

const FUNDING_WINDOW_MS = 600000; // 10 minutes before next funding
const ORPHAN_WAIT_MS = 10000; // 10 seconds before closing orphan (for timer-based orphan path)
const ORPHAN_CLOSE_COOLDOWN_MS = 30000; // 30 seconds after a failed close before retry (no spam)
const FAILED_CLOSE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes: strictly skip symbol after any close API error (avoid IP ban)

/** Orphan tracking: symbol -> { exchange: 'binance'|'bybit', firstSeen: number } */
const orphanFirstSeen = {};
/** Cooldown until (ms) after failed orphan close to avoid API spam */
const orphanCloseCooldownUntil = {};
/** Symbols that had a close API failure: skip for 10 minutes (no retries) */
const failedClosesUntil = {};

let started = false;
let runInProgress = false;
let runQueued = false;
let queueTimer = null;
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
 * Combined PnL % = (Binance_Unrealized + Bybit_Unrealized) / Total_Margin * 100
 */
function combinedPnlPercent(binancePos, bybitPos) {
  const totalUnrealized =
    (Number.isFinite(binancePos?.unrealizedProfit) ? binancePos.unrealizedProfit : 0) +
    (Number.isFinite(bybitPos?.unrealizedProfit) ? bybitPos.unrealizedProfit : 0);
  const totalMargin =
    (Number.isFinite(binancePos?.marginUsed) ? binancePos.marginUsed : 0) +
    (Number.isFinite(bybitPos?.marginUsed) ? bybitPos.marginUsed : 0);
  if (totalMargin <= 0) return null;
  return (totalUnrealized / totalMargin) * 100;
}

/**
 * Close paired positions using split IOC limit orders (getOrderbookPrice slippage). No REST polling.
 */
async function closePair(credentials, symbol, binancePos, bybitPos, reason) {
  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[TradeMonitor] Order circuit breaker: trading paused, skipping closePair", toUpperSymbol(symbol));
    return { binanceOk: false, bybitOk: false };
  }
  const sym = toUpperSymbol(symbol);
  const binanceQty = Math.abs(Number(binancePos?.positionAmt ?? binancePos?.size ?? 0) || 0);
  const bybitQty = Math.abs(Number(bybitPos?.positionAmt ?? bybitPos?.size ?? 0) || 0);
  if (binanceQty <= 0 && bybitQty <= 0) return { binanceOk: false, bybitOk: false };
  const binanceCloseSide = binancePos.side === "BUY" ? "SELL" : "BUY";
  const binancePositionSide = binancePos.positionSide || undefined;
  const bybitCloseSide = String(bybitPos.side || "").toLowerCase() === "buy" ? "Sell" : "Buy";

  const combinedPnl =
    (Number.isFinite(binancePos?.unrealizedProfit) ? binancePos.unrealizedProfit : 0) +
    (Number.isFinite(bybitPos?.unrealizedProfit) ? bybitPos.unrealizedProfit : 0);
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

  const settings = await Setting.findOne().lean();
  const slippagePct = Number.isFinite(settings?.entrySlippagePct) ? Math.max(0, Math.min(100, settings.entrySlippagePct)) : 2;

  const binancePositionSideForClose =
    binancePositionSide === "LONG" || binancePositionSide === "SHORT"
      ? binancePositionSide
      : binanceCloseSide === "SELL"
        ? "LONG"
        : "SHORT";

  const { computeQuantityChunks } = autoTrader;
  const binanceChunks = binanceQty > 0 ? (await computeQuantityChunks(binanceQty * fallbackMarkPrice, fallbackMarkPrice, sym)).chunks : [];
  const bybitChunks = bybitQty > 0 ? (await computeQuantityChunks(bybitQty * fallbackMarkPrice, fallbackMarkPrice, sym)).chunks : [];

  const binancePrice = binanceManager.getOrderbookPrice(sym, binanceCloseSide, slippagePct) ?? fallbackMarkPrice;
  const bybitPrice = bybitManager.getOrderbookPrice(sym, bybitCloseSide, slippagePct) ?? fallbackMarkPrice;

  const binancePromises = binanceChunks.map((qtyStr) => {
    const qty = parseFloat(qtyStr);
    if (qty <= 0) return Promise.resolve();
    return binanceManager
      .placeIOCLimitOrder(credentials.binance, sym, binanceCloseSide, qty, binancePrice, {
        positionSide: binancePositionSideForClose,
        reduceOnly: true,
      })
      .then((r) => {
        orderCircuitBreaker.recordOrderPlaced();
        return r;
      });
  });
  const bybitPromises = bybitChunks.map((qtyStr) => {
    const qty = parseFloat(qtyStr);
    if (qty <= 0) return Promise.resolve();
    return bybitManager
      .placeIOCLimitOrder(credentials.bybit, sym, bybitCloseSide, qty, bybitPrice, { reduceOnly: true })
      .then((r) => {
        orderCircuitBreaker.recordOrderPlaced();
        return r;
      });
  });

  const results = await Promise.allSettled([...binancePromises, ...bybitPromises]);
  const binanceOk = binanceChunks.length === 0 || results.slice(0, binanceChunks.length).every((r) => r.status === "fulfilled");
  const bybitOk = bybitChunks.length === 0 || results.slice(binanceChunks.length).every((r) => r.status === "fulfilled");
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error("[TradeMonitor] Close order failed", sym, i < binanceChunks.length ? "binance" : "bybit", r.reason?.message || r.reason);
    }
  });
  if (binanceOk || bybitOk) {
    autoTrader.clearEntryFundingDirection(sym);
    const entryPrice = fallbackMarkPrice;
    const exitPrice = fallbackMarkPrice;
    TradeLog.create({
      symbol: sym,
      entryPrice,
      exitPrice,
      pnl: combinedPnl,
      reason: reason === "SL" ? "SL" : "Target",
      side: binancePos.side === "BUY" ? "long" : "short",
      exchange: "binance+bybit",
    }).catch((e) => console.error("[TradeMonitor] TradeLog create failed", e.message));
  }
  return { binanceOk, bybitOk };
}

/**
 * Close orphan position using split IOC limit orders (getOrderbookPrice). No REST polling.
 */
async function closeOrphanPosition(credentials, exchange, symbol, pos) {
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

  const settings = await Setting.findOne().lean();
  const slippagePct = Number.isFinite(settings?.entrySlippagePct) ? Math.max(0, Math.min(100, settings.entrySlippagePct)) : 2;

  const { computeQuantityChunks } = autoTrader;
  const chunks = (await computeQuantityChunks(qty * fallbackMarkPrice, fallbackMarkPrice, sym)).chunks;
  const price = exchange === "binance"
    ? (binanceManager.getOrderbookPrice(sym, closeSide, slippagePct) ?? fallbackMarkPrice)
    : (bybitManager.getOrderbookPrice(sym, closeSide, slippagePct) ?? fallbackMarkPrice);

  for (const qtyStr of chunks) {
    const q = parseFloat(qtyStr);
    if (q <= 0) continue;
    if (exchange === "binance") {
      await binanceManager.placeIOCLimitOrder(credentials.binance, sym, closeSide, q, price, {
        positionSide: binancePositionSide,
        reduceOnly: true,
      });
    } else {
      await bybitManager.placeIOCLimitOrder(credentials.bybit, sym, closeSide, q, price, { reduceOnly: true });
    }
    orderCircuitBreaker.recordOrderPlaced();
  }

  autoTrader.clearEntryFundingDirection(sym);
  const unrealized = Number.isFinite(pos?.unrealizedProfit) ? pos.unrealizedProfit : 0;
  TradeLog.create({
    symbol: sym,
    entryPrice: fallbackMarkPrice,
    exitPrice: fallbackMarkPrice,
    pnl: unrealized,
    reason: "Orphan",
    side: isLong ? "long" : "short",
    exchange,
  }).catch((e) => console.error("[TradeMonitor] TradeLog create failed", e.message));
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
    if (!orphanFirstSeen[symbol]) {
      orphanFirstSeen[symbol] = { exchange: "binance", firstSeen: now };
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
    if (!orphanFirstSeen[symbol]) {
      orphanFirstSeen[symbol] = { exchange: "bybit", firstSeen: now };
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

  // Orphan exit with 10-second grace: only close if position age > ORPHAN_GRACE_MS (avoids false orphan from leg latency)
  for (const symbol of Object.keys(orphanFirstSeen)) {
    const rec = orphanFirstSeen[symbol];
    if (now < (orphanCloseCooldownUntil[symbol] || 0)) continue;
    if (now < (failedClosesUntil[symbol] || 0)) continue;

    const stillOnlyBinance = rec.exchange === "binance" && binanceSymbols.has(symbol) && !bybitSymbols.has(symbol);
    const stillOnlyBybit = rec.exchange === "bybit" && bybitSymbols.has(symbol) && !binanceSymbols.has(symbol);

    if (stillOnlyBinance) {
      const pos = binanceBySymbol[symbol];
      if (pos && Math.abs(Number(pos.positionAmt) || 0) > 0) {
        const posAge = now - (pos.createdTime ?? pos.updatedTime ?? now);
        if (posAge <= ORPHAN_GRACE_MS) continue;
        try {
          await closeOrphanPosition(keys, "binance", symbol, pos);
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
        const posAge = now - (pos.createdTime ?? pos.updatedTime ?? now);
        if (posAge <= ORPHAN_GRACE_MS) continue;
        try {
          await closeOrphanPosition(keys, "bybit", symbol, pos);
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
    if (now < (failedClosesUntil[symbol] || 0)) continue;
    const binancePos = binanceBySymbol[symbol];
    const bybitPos = bybitBySymbol[symbol];
    if (!binancePos || !bybitPos) continue;

    const pnlPct = combinedPnlPercent(binancePos, bybitPos);
    if (pnlPct != null) {
      if (stopLoss > 0 && pnlPct <= -stopLoss) {
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
      if (takeProfit > 0 && pnlPct >= takeProfit) {
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
    const nextFundingTime = token?.nextFundingTime ?? null;
    const binanceFunding = Number(token?.fundingBinance ?? binanceManager.getCachedFundingRate(symbol) ?? 0) || 0;
    const bybitFunding = Number(token?.fundingBybit ?? bybitManager.getCachedFundingRate(symbol) ?? 0) || 0;
    const notionalBinance = Math.abs(Number(binancePos?.positionAmt ?? 0)) * (binanceManager.getMarkPrice(symbol) ?? 0);
    const notionalBybit = Math.abs(Number(bybitPos?.positionAmt ?? 0)) * (bybitManager.getMarkPrice(symbol) ?? 0);
    const binanceFee = notionalBinance * binanceFunding;
    const bybitFee = notionalBybit * bybitFunding;
    const totalFundingIncome = -(binanceFee + bybitFee);
    const isFundingFlipped = totalFundingIncome < 0;
    if (isFundingFlipped && nextFundingTime != null && Number.isFinite(nextFundingTime)) {
      const timeLeft = nextFundingTime - now;
      if (timeLeft <= FUNDING_WINDOW_MS) {
        console.log("[TradeMonitor] Funding flip exit (within 10 min)", symbol);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "Target");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (funding flip) failed", symbol, e.message || e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
      }
    }
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
      return closeOrphanPosition(keys, otherExchange, sym, primary).then(
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
  queueRun(); // initial pass in case state already exists
  console.log("[TradeMonitor] Started (event-driven, WS state only; no position GET polling).");
}

function stop() {
  if (!started) return;
  started = false;
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  for (const symbol of Object.keys(orphanRecheckTimerBySymbol)) {
    clearTimeout(orphanRecheckTimerBySymbol[symbol]);
    delete orphanRecheckTimerBySymbol[symbol];
  }
  binanceManager.setOnPositionUpdate(null);
  bybitManager.setOnPositionUpdate(null);
  binanceManager.setOnPositionClosed(null);
  bybitManager.setOnPositionClosed(null);
  runQueued = false;
  console.log("[TradeMonitor] Stopped.");
}

module.exports = {
  start,
  stop,
  runMonitor,
};
