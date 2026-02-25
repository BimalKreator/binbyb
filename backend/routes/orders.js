const express = require("express");
const { protect } = require("../middleware/auth");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");
const orderCircuitBreaker = require("../services/orderCircuitBreaker");

const router = express.Router();

router.use(protect);

/** POST /api/orders - Place IOC limit order on Binance or Bybit */
router.post("/", async (req, res) => {
  try {
    const { exchange, symbol, side, quantity, price } = req.body;
    if (!exchange || !symbol || !side || quantity == null || price == null) {
      return res.status(400).json({
        success: false,
        message: "exchange, symbol, side, quantity, and price are required.",
      });
    }
    const ex = exchange.toLowerCase();
    if (ex !== "binance" && ex !== "bybit") {
      return res.status(400).json({ success: false, message: "exchange must be binance or bybit." });
    }
    const qty = Number(quantity);
    const pr = Number(price);
    if (isNaN(qty) || qty <= 0 || isNaN(pr) || pr <= 0) {
      return res.status(400).json({ success: false, message: "quantity and price must be positive numbers." });
    }
    const keys = await getDecryptedApiKeys();
    const creds = ex === "binance" ? keys.binance : keys.bybit;
    if (!creds?.apiKey || !creds?.apiSecret) {
      return res.status(400).json({
        success: false,
        message: `No API keys configured for ${exchange}. Add keys in Settings.`,
      });
    }
    const sideNorm = String(side).toUpperCase();
    if (sideNorm !== "BUY" && sideNorm !== "SELL") {
      return res.status(400).json({ success: false, message: "side must be BUY or SELL." });
    }
    if (!orderCircuitBreaker.canPlaceOrder()) {
      return res.status(503).json({
        success: false,
        message: "Order rate limit reached; trading paused. Try again later.",
      });
    }
    // Order placement uses WS (placeWSOrder) with REST fallback via placeIOCLimitOrder
    if (ex === "binance") {
      const result = await binanceManager.placeIOCLimitOrder(creds, symbol, sideNorm, qty, pr);
      orderCircuitBreaker.recordOrderPlaced();
      return res.json({ success: true, data: result, exchange: "binance" });
    }
    const result = await bybitManager.placeIOCLimitOrder(creds, symbol, sideNorm === "BUY" ? "Buy" : "Sell", qty, pr);
    orderCircuitBreaker.recordOrderPlaced();
    return res.json({ success: true, data: result, exchange: "bybit" });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    return res.status(500).json({ success: false, message: msg || "Order failed." });
  }
});

module.exports = router;
