const express = require("express");
const { protect } = require("../middleware/auth");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");
const autoTrader = require("../services/autoTrader");
const screener = require("../services/screener");
const TradeLog = require("../models/TradeLog");
const Setting = require("../models/Setting");
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

    if (!orderCircuitBreaker.canPlaceOrder()) {
      return res.status(503).json({
        success: false,
        message: "Order rate limit reached; trading paused. Try again later.",
      });
    }

    try {
      const sym = String(symbol).toUpperCase();
      try {
        await bybitManager.setLeverage(keys.bybit, sym, levInt);
        await binanceManager.setLeverage(keys.binance, sym, levInt);
      } catch (levErr) {
        console.warn("[Manual Trade] setLeverage warning", sym, levErr?.message ?? levErr);
      }
      console.log(`[Manual Trade] Initiating Interleaved Sweep for ${qty} ${symbol}...`);
      let remainingQty = qty;
      let totalBybitFilled = 0;
      let totalBinanceFilled = 0;
      let maxSweeps = 500;

      while (remainingQty > 0 && maxSweeps > 0) {
        const bybitRes = await bybitManager.executeLiquiditySweep(keys.bybit, symbol, bybitSideApi, remainingQty, levInt, 1);
        const chunkFilled = bybitRes?.totalFilled || 0;

        if (chunkFilled <= 0) {
          console.log(`[Manual Trade] Bybit chunk filled 0. Waiting 100ms for liquidity...`);
          await new Promise((r) => setTimeout(r, 100));
          maxSweeps--;
          continue;
        }

        orderCircuitBreaker.recordOrderPlaced();
        totalBybitFilled += chunkFilled;
        remainingQty -= chunkFilled;

        let binanceRemaining = chunkFilled;
        let binanceFailsafe = 100;
        while (binanceRemaining > 0 && binanceFailsafe > 0) {
          const binanceRes = await binanceManager.executeLiquiditySweep(keys.binance, symbol, binanceSideNorm, binanceRemaining, levInt, 5);
          const bFilled = binanceRes?.totalFilled || 0;

          if (bFilled > 0) orderCircuitBreaker.recordOrderPlaced();

          totalBinanceFilled += bFilled;
          binanceRemaining -= bFilled;

          if (binanceRemaining > 0) {
            console.log(`[Manual Trade] Binance partial fill. Remaining: ${binanceRemaining}. Waiting 100ms...`);
            await new Promise((r) => setTimeout(r, 100));
          }
          binanceFailsafe--;
        }

        maxSweeps--;
      }

      if (totalBybitFilled <= 0) {
        console.log(`[Manual Trade] Bybit sweep filled 0. Aborting Binance leg.`);
        return res.status(400).json({
          success: false,
          message: "No liquidity available on Bybit to execute the manual trade at current prices.",
        });
      }

      return res.json({
        success: true,
        data: { bybitTotalFilled: totalBybitFilled, binanceTotalFilled: totalBinanceFilled },
        message: `Arbitrage executed. Bybit filled ${totalBybitFilled}; Binance matched.`,
      });

    } catch (err) {
      console.error("[Manual Trade Error]", err);
      return res.status(500).json({
        success: false,
        message: "An error occurred during the liquidity sweep execution.",
      });
    }
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
 * Closes all open positions for the symbol on both exchanges via IOC limit orders at L2 book prices.
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

    const settings = await Setting.findOne().lean();
    const slippagePct = Number.isFinite(settings?.entrySlippagePct) ? Math.max(0, Math.min(100, settings.entrySlippagePct)) : 0.1;
    const snapshot = screener.getSnapshot();
    const token = (snapshot?.rankedTokens || []).find((t) => String(t?.symbol || "").toUpperCase() === sym);
    const fallbackMark = token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : null;

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
      const mark = parseFloat(pos?.markPrice ?? pos?.entryPrice) || fallbackMark || binanceManager.getMarkPrice(sym);
      const price = binanceManager.getOrderbookPrice(sym, closeSide, slippagePct) ?? mark;
      if (price == null || !Number.isFinite(price) || price <= 0) {
        results.binance.push({ positionSide, qty, error: "No L2 price or mark available for IOC close" });
        continue;
      }
      try {
        const order = await binanceManager.placeIOCLimitOrder(keys.binance, sym, closeSide, qty, price, {
          positionSide,
          reduceOnly: true,
        });
        orderCircuitBreaker.recordOrderPlaced();
        results.binance.push({ positionSide, qty, order });
      } catch (e) {
        console.error("[Trade/close-all] Binance IOC close failed", sym, positionSide, e.message);
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
      const mark = parseFloat(pos?.markPrice ?? pos?.entryPrice ?? pos?.avgPrice) || fallbackMark || bybitManager.getMarkPrice(sym);
      const price = bybitManager.getOrderbookPrice(sym, closeSide, slippagePct) ?? mark;
      if (price == null || !Number.isFinite(price) || price <= 0) {
        results.bybit.push({ side: pos.side, qty, error: "No L2 price or mark available for IOC close" });
        continue;
      }
      try {
        const order = await bybitManager.placeIOCLimitOrder(keys.bybit, sym, closeSide, qty, price, { reduceOnly: true });
        orderCircuitBreaker.recordOrderPlaced();
        results.bybit.push({ side: pos.side, qty, order });
      } catch (e) {
        console.error("[Trade/close-all] Bybit IOC close failed", sym, e.message);
        results.bybit.push({ side: pos.side, qty, error: e.response?.data?.retMsg || e.message });
      }
    }

    const binanceUnrealized = (binancePositions || []).reduce((s, p) => s + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0), 0);
    const bybitUnrealized = (bybitPositions || []).reduce((s, p) => s + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0), 0);
    const markPrice = (token?.markPrice != null && Number.isFinite(token.markPrice) ? Number(token.markPrice) : fallbackMark) ?? 0;
    const entryPrice = markPrice > 0 ? markPrice : 0;
    const exitPrice = markPrice > 0 ? markPrice : 0;
    const sideStr = (binancePositions?.[0]?.side === "BUY" || bybitPositions?.[0]?.side?.toLowerCase() === "buy") ? "long" : "short";
    const groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const legs = [];
    if (binancePositions.length > 0) {
      legs.push({
        symbol: sym,
        entryPrice,
        exitPrice,
        pnl: binanceUnrealized,
        reason: "Manual",
        side: sideStr,
        exchange: "Binance",
        groupId,
        requestedEntryPrice: exitPrice,
        executedEntryPrice: exitPrice,
        fee: 0,
      });
    }
    if (bybitPositions.length > 0) {
      legs.push({
        symbol: sym,
        entryPrice,
        exitPrice,
        pnl: bybitUnrealized,
        reason: "Manual",
        side: sideStr,
        exchange: "Bybit",
        groupId,
        requestedEntryPrice: exitPrice,
        executedEntryPrice: exitPrice,
        fee: 0,
      });
    }
    if (legs.length > 0) {
      TradeLog.insertMany(legs).catch((e) => console.error("[Trade/close-all] TradeLog insertMany failed", e.message));
    }

    autoTrader.clearEntryFundingDirection(sym);
    await Promise.all([
      binanceManager.hydratePositionsFromRest(keys.binance),
      bybitManager.hydratePositionsFromRest(keys.bybit),
    ]);
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
