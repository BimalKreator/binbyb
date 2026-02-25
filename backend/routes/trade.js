const express = require("express");
const { protect } = require("../middleware/auth");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");
const autoTrader = require("../services/autoTrader");
const screener = require("../services/screener");
const TradeLog = require("../models/TradeLog");
const orderCircuitBreaker = require("../services/orderCircuitBreaker");

const router = express.Router();

router.use(protect);

/**
 * POST /api/trade/arbitrage
 * Body: { symbol, quantity, leverage, binanceSide, bybitSide, markPrice }
 * Places IOC limit orders on both exchanges simultaneously (Short one, Long the other).
 */
router.post("/arbitrage", async (req, res) => {
  try {
    const { symbol, quantity, leverage, binanceSide, bybitSide, markPrice } = req.body;

    if (!symbol || quantity == null || leverage == null || !binanceSide || !bybitSide || markPrice == null) {
      return res.status(400).json({
        success: false,
        message: "symbol, quantity, leverage, binanceSide, bybitSide, and markPrice are required.",
      });
    }

    const qty = Number(quantity);
    const price = Number(markPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: "quantity must be a positive number." });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, message: "markPrice must be a positive number." });
    }

    const binanceSideNorm = String(binanceSide).toUpperCase();
    const bybitSideNorm = String(bybitSide).toLowerCase();
    if (binanceSideNorm !== "BUY" && binanceSideNorm !== "SELL") {
      return res.status(400).json({ success: false, message: "binanceSide must be BUY or SELL." });
    }
    if (bybitSideNorm !== "buy" && bybitSideNorm !== "sell") {
      return res.status(400).json({ success: false, message: "bybitSide must be Buy or Sell." });
    }

    const keys = await getDecryptedApiKeys();
    if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret) {
      return res.status(400).json({
        success: false,
        message: "Binance API keys not configured. Add keys in Exchange settings.",
      });
    }
    if (!keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
      return res.status(400).json({
        success: false,
        message: "Bybit API keys not configured. Add keys in Exchange settings.",
      });
    }

    const bybitSideApi = bybitSideNorm === "buy" ? "Buy" : "Sell";
    const levInt = Math.max(1, Math.min(125, Math.floor(Number(leverage)) || 1));

    const [binanceOrderbookPrice, bybitOrderbookPrice] = await Promise.all([
      binanceManager.getOrderbookPrice(symbol, binanceSideNorm),
      bybitManager.getOrderbookPrice(symbol, bybitSideApi),
    ]);
    const binancePrice = Number.isFinite(binanceOrderbookPrice) && binanceOrderbookPrice > 0
      ? binanceOrderbookPrice
      : price;
    const bybitPrice = Number.isFinite(bybitOrderbookPrice) && bybitOrderbookPrice > 0
      ? bybitOrderbookPrice
      : price;

    if (!orderCircuitBreaker.canPlaceOrder()) {
      return res.status(503).json({
        success: false,
        message: "Order rate limit reached; trading paused. Try again later.",
      });
    }
    // Order placement uses WS (placeWSOrder) with REST fallback via placeIOCLimitOrder
    const [binanceResult, bybitResult] = await Promise.all([
      binanceManager.placeIOCLimitOrder(keys.binance, symbol, binanceSideNorm, qty, binancePrice, { leverage: levInt }).then((r) => {
        orderCircuitBreaker.recordOrderPlaced();
        return r;
      }),
      bybitManager.placeIOCLimitOrder(keys.bybit, symbol, bybitSideApi, qty, bybitPrice).then((r) => {
        orderCircuitBreaker.recordOrderPlaced();
        return r;
      }),
    ]);

    return res.json({
      success: true,
      data: { binance: binanceResult, bybit: bybitResult },
      message: "Arbitrage orders submitted.",
    });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error("[Trade/arbitrage] Error:", e.message || e);
    if (e.response?.data) console.error("[Trade/arbitrage] Response data:", e.response.data);
    return res.status(e.response?.status === 400 ? 400 : 500).json({
      success: false,
      message: msg || "Arbitrage order failed.",
    });
  }
});

/**
 * POST /api/trade/close-all
 * Body: { symbol }
 * Closes all open positions for the symbol on both exchanges via Market orders.
 * Enforces Binance Hedge Mode: LONG -> SELL with positionSide LONG, SHORT -> BUY with positionSide SHORT.
 */
router.post("/close-all", async (req, res) => {
  try {
    const symbol = req.body?.symbol;
    const sym = symbol ? String(symbol).toUpperCase() : "";
    if (!sym) {
      return res.status(400).json({ success: false, message: "symbol is required." });
    }

    const keys = await getDecryptedApiKeys();
    if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
      return res.status(400).json({
        success: false,
        message: "API keys for both Binance and Bybit are required.",
      });
    }

    let binancePositions = binanceManager.getLivePositions();
    let bybitPositions = bybitManager.getLivePositions();
    const binanceForSymbol = (binancePositions || []).filter((p) => String(p?.symbol || "").toUpperCase() === sym);
    const bybitForSymbol = (bybitPositions || []).filter((p) => String(p?.symbol || "").toUpperCase() === sym);

    if (binanceForSymbol.length === 0 && bybitForSymbol.length === 0) {
      const [restBinance, restBybit] = await Promise.all([
        binanceManager.getPositionDetails(keys.binance),
        bybitManager.getPositionDetails(keys.bybit),
      ]);
      binancePositions = (restBinance || []).filter((p) => String(p?.symbol || "").toUpperCase() === sym);
      bybitPositions = (restBybit || []).filter((p) => String(p?.symbol || "").toUpperCase() === sym);
    } else {
      binancePositions = binanceForSymbol;
      bybitPositions = bybitForSymbol;
    }

    if (binancePositions.length === 0 && bybitPositions.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No open positions found for symbol " + sym + ".",
      });
    }

    const results = { binance: [], bybit: [] };

    for (const pos of binancePositions) {
      const qty = Math.abs(Number(pos.positionAmt) || 0);
      if (qty <= 0) continue;
      if (!orderCircuitBreaker.canPlaceOrder()) {
        results.binance.push({ positionSide: pos.positionSide, qty, error: "Circuit breaker: trading paused" });
        continue;
      }
      const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
      const positionSide =
        pos.positionSide === "LONG" || pos.positionSide === "SHORT"
          ? pos.positionSide
          : closeSide === "SELL"
            ? "LONG"
            : "SHORT";
      try {
        const order = await binanceManager.placeMarketCloseOrder(keys.binance, sym, closeSide, qty, {
          positionSide,
        });
        orderCircuitBreaker.recordOrderPlaced();
        results.binance.push({ positionSide, qty, order });
      } catch (e) {
        console.error("[Trade/close-all] Binance close failed", sym, positionSide, e.message);
        results.binance.push({ positionSide, qty, error: e.response?.data?.msg || e.message });
      }
    }

    for (const pos of bybitPositions) {
      const qty = Math.abs(Number(pos.positionAmt) || 0);
      if (qty <= 0) continue;
      if (!orderCircuitBreaker.canPlaceOrder()) {
        results.bybit.push({ side: pos.side, qty, error: "Circuit breaker: trading paused" });
        continue;
      }
      const closeSide = String(pos.side || "").toLowerCase() === "buy" ? "Sell" : "Buy";
      try {
        const order = await bybitManager.placeMarketCloseOrder(keys.bybit, sym, closeSide, qty);
        orderCircuitBreaker.recordOrderPlaced();
        results.bybit.push({ side: pos.side, qty, order });
      } catch (e) {
        console.error("[Trade/close-all] Bybit close failed", sym, e.message);
        results.bybit.push({ side: pos.side, qty, error: e.response?.data?.retMsg || e.message });
      }
    }

    const totalUnrealized =
      (binancePositions || []).reduce((s, p) => s + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0), 0) +
      (bybitPositions || []).reduce((s, p) => s + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0), 0);
    const snapshot = screener.getSnapshot();
    const token = (snapshot?.rankedTokens || []).find((t) => String(t?.symbol || "").toUpperCase() === sym);
    const markPrice = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : 0;
    const entryPrice = markPrice > 0 ? markPrice : 0;
    const exitPrice = markPrice > 0 ? markPrice : 0;
    TradeLog.create({
      symbol: sym,
      entryPrice,
      exitPrice,
      pnl: totalUnrealized,
      reason: "Manual",
      side: (binancePositions?.[0]?.side === "BUY" || bybitPositions?.[0]?.side?.toLowerCase() === "buy") ? "long" : "short",
      exchange: "binance+bybit",
    }).catch((e) => console.error("[Trade/close-all] TradeLog create failed", e.message));

    autoTrader.clearEntryFundingDirection(sym);
    return res.json({
      success: true,
      data: { symbol: sym, binance: results.binance, bybit: results.bybit },
      message: "Close-all orders submitted for " + sym + ".",
    });
  } catch (e) {
    console.error("[Trade/close-all] Error:", e.message || e);
    return res.status(500).json({
      success: false,
      message: e.response?.data?.msg || e.message || "Close-all failed.",
    });
  }
});

module.exports = router;
