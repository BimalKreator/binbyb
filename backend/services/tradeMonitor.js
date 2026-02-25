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

async function closePair(credentials, symbol, binancePos, bybitPos, reason) {
  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[TradeMonitor] Order circuit breaker: trading paused, skipping closePair", toUpperSymbol(symbol));
    return { binanceOk: false, bybitOk: false };
  }
  const sym = toUpperSymbol(symbol);
  const binanceCloseSide = binancePos.side === "BUY" ? "SELL" : "BUY";
  const binanceQty = Math.abs(Number(binancePos.positionAmt) || 0);
  const binancePositionSide = binancePos.positionSide || undefined;
  const bybitCloseSide = String(bybitPos.side || "").toLowerCase() === "buy" ? "Sell" : "Buy";
  const bybitQty = Math.abs(Number(bybitPos.positionAmt) || 0);

  const combinedPnl =
    (Number.isFinite(binancePos?.unrealizedProfit) ? binancePos.unrealizedProfit : 0) +
    (Number.isFinite(bybitPos?.unrealizedProfit) ? bybitPos.unrealizedProfit : 0);
  const snapshot = screener.getSnapshot();
  const token = (snapshot.rankedTokens || []).find((t) => toUpperSymbol(t?.symbol) === sym);
  const markPrice = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : 0;

  const binancePositionSideForClose =
    binancePositionSide === "LONG" || binancePositionSide === "SHORT"
      ? binancePositionSide
      : binanceCloseSide === "SELL"
        ? "LONG"
        : "SHORT";
  const results = await Promise.allSettled([
    binanceQty > 0
      ? binanceManager.placeMarketCloseOrder(credentials.binance, sym, binanceCloseSide, binanceQty, {
          positionSide: binancePositionSideForClose,
        }).then((r) => {
          orderCircuitBreaker.recordOrderPlaced();
          return r;
        })
      : Promise.resolve(),
    bybitQty > 0
      ? bybitManager.placeMarketCloseOrder(credentials.bybit, sym, bybitCloseSide, bybitQty).then((r) => {
          orderCircuitBreaker.recordOrderPlaced();
          return r;
        })
      : Promise.resolve(),
  ]);

  const binanceOk = results[0].status === "fulfilled";
  const bybitOk = results[1].status === "fulfilled";
  if (!binanceOk && results[0].reason) {
    console.error("[TradeMonitor] Binance close failed", sym, results[0].reason?.message || results[0].reason);
  }
  if (!bybitOk && results[1].reason) {
    console.error("[TradeMonitor] Bybit close failed", sym, results[1].reason?.message || results[1].reason);
  }
  if (binanceOk || bybitOk) {
    autoTrader.clearEntryFundingDirection(sym);
    const entryPrice = markPrice > 0 ? markPrice : 0;
    const exitPrice = markPrice > 0 ? markPrice : 0;
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

async function closeOrphanPosition(credentials, exchange, symbol, pos) {
  if (!orderCircuitBreaker.canPlaceOrder()) {
    console.error("[TradeMonitor] Order circuit breaker: trading paused, skipping closeOrphan", toUpperSymbol(symbol), exchange);
    return;
  }
  const sym = toUpperSymbol(symbol);
  const qty = Math.abs(Number(pos?.positionAmt) || 0);
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
  if (exchange === "binance") {
    await binanceManager.placeMarketCloseOrder(credentials.binance, sym, closeSide, qty, {
      positionSide: binancePositionSide,
    });
  } else {
    await bybitManager.placeMarketCloseOrder(credentials.bybit, sym, closeSide, qty);
  }
  orderCircuitBreaker.recordOrderPlaced();
  autoTrader.clearEntryFundingDirection(sym);
  const snapshot = screener.getSnapshot();
  const token = (snapshot.rankedTokens || []).find((t) => toUpperSymbol(t?.symbol) === sym);
  const markPrice = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : 0;
  const unrealized = Number.isFinite(pos?.unrealizedProfit) ? pos.unrealizedProfit : 0;
  TradeLog.create({
    symbol: sym,
    entryPrice: markPrice > 0 ? markPrice : 0,
    exitPrice: markPrice > 0 ? markPrice : 0,
    pnl: unrealized,
    reason: "Orphan",
    side: (exchange === "binance" && pos.side === "BUY") || (exchange === "bybit" && String(pos.side || "").toLowerCase() === "buy") ? "long" : "short",
    exchange,
  }).catch((e) => console.error("[TradeMonitor] TradeLog create failed", e.message));
  console.log("[TradeMonitor] Orphan closed", exchange, sym);
}

async function runMonitor() {
  const settings = await Setting.findOne().lean();
  const keys = await getDecryptedApiKeys();
  if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
    return;
  }

  const slPercent = Number(settings?.slPercent ?? settings?.stopLoss ?? 0);
  const tpPercent = Number(settings?.tpPercent ?? settings?.takeProfit ?? 0);
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

  // 10-second orphan rule; skip symbols in failedCloses cooldown (10 min) to avoid IP ban
  for (const symbol of Object.keys(orphanFirstSeen)) {
    const rec = orphanFirstSeen[symbol];
    if (now - rec.firstSeen < ORPHAN_WAIT_MS) continue;
    if (now < (orphanCloseCooldownUntil[symbol] || 0)) continue;
    if (now < (failedClosesUntil[symbol] || 0)) continue;

    const stillOnlyBinance = rec.exchange === "binance" && binanceSymbols.has(symbol) && !bybitSymbols.has(symbol);
    const stillOnlyBybit = rec.exchange === "bybit" && bybitSymbols.has(symbol) && !binanceSymbols.has(symbol);

    if (stillOnlyBinance) {
      const pos = binanceBySymbol[symbol];
      if (pos && Math.abs(Number(pos.positionAmt) || 0) > 0) {
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
      if (slPercent !== 0 && pnlPct <= slPercent) {
        console.log("[TradeMonitor] SL exit", symbol, "PnL%", pnlPct.toFixed(2), "slPercent", slPercent);
        try {
          await closePair(keys, symbol, binancePos, bybitPos, "SL");
          delete failedClosesUntil[symbol];
        } catch (e) {
          console.error("[TradeMonitor] closePair (SL) failed", symbol, e.message || e);
          failedClosesUntil[symbol] = now + FAILED_CLOSE_COOLDOWN_MS;
        }
        continue;
      }
      if (tpPercent !== 0 && pnlPct >= tpPercent) {
        console.log("[TradeMonitor] TP exit", symbol, "PnL%", pnlPct.toFixed(2), "tpPercent", tpPercent);
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
    const nextFundingTime = token?.nextFundingTime;
    if (nextFundingTime != null && Number.isFinite(nextFundingTime) && nextFundingTime - now < FUNDING_WINDOW_MS) {
      const entryDir = autoTrader.getEntryFundingDirection(symbol);
      if (entryDir) {
        const currentBinanceHigher = Number(token?.fundingBinance ?? 0) > Number(token?.fundingBybit ?? 0);
        if (currentBinanceHigher !== entryDir.binanceHigher) {
          console.log("[TradeMonitor] Funding flip exit", symbol);
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
