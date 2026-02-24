const express = require("express");
const { protect } = require("../middleware/auth");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");

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

    const [binanceResult, bybitResult] = await Promise.all([
      binanceManager.placeIOCLimitOrder(keys.binance, symbol, binanceSideNorm, qty, price),
      bybitManager.placeIOCLimitOrder(keys.bybit, symbol, bybitSideApi, qty, price),
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

module.exports = router;
