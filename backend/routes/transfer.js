/**
 * POST /transfer - Fund transfer between Binance and Bybit (internal transfer + withdraw).
 * Body: { from: 'binance'|'bybit', to: 'bybit'|'binance', amount: number }
 */

const express = require("express");
const { protect } = require("../middleware/auth");
const Setting = require("../models/Setting");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");

const router = express.Router();
router.use(protect);

const WAIT_MS = 3000;

router.post("/", async (req, res) => {
  try {
    const { from, to, amount } = req.body || {};
    const fromNorm = String(from || "").toLowerCase();
    const toNorm = String(to || "").toLowerCase();
    const amt = parseFloat(amount);
    if (fromNorm !== "binance" && fromNorm !== "bybit") {
      return res.status(400).json({ success: false, message: "from must be 'binance' or 'bybit'" });
    }
    if (toNorm !== "binance" && toNorm !== "bybit") {
      return res.status(400).json({ success: false, message: "to must be 'binance' or 'bybit'" });
    }
    if (fromNorm === toNorm) {
      return res.status(400).json({ success: false, message: "from and to must be different" });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: "amount must be a positive number" });
    }

    const keys = await getDecryptedApiKeys();
    if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
      return res.status(400).json({ success: false, message: "API keys not configured" });
    }

    const settings = await Setting.findOne().lean();
    if (!settings) {
      return res.status(500).json({ success: false, message: "Settings not found" });
    }

    if (fromNorm === "binance" && toNorm === "bybit") {
      const bybitAddress = (settings.bybitDepositAddress || "").trim();
      const bybitNetwork = (settings.bybitNetwork || "").trim();
      if (!bybitAddress || !bybitNetwork) {
        return res.status(400).json({
          success: false,
          message: "Bybit deposit address and network must be set in settings",
        });
      }
      await binanceManager.futuresTransferToSpot(keys.binance, "USDT", amt);
      await new Promise((r) => setTimeout(r, WAIT_MS));
      await binanceManager.withdrawSpot(keys.binance, "USDT", amt, bybitAddress, bybitNetwork);
      return res.json({ success: true, message: `Transferred $${amt} from Binance to Bybit (withdraw to ${bybitAddress})` });
    }

    if (fromNorm === "bybit" && toNorm === "binance") {
      const binanceAddress = (settings.binanceDepositAddress || "").trim();
      const binanceNetwork = (settings.binanceNetwork || "").trim();
      if (!binanceAddress || !binanceNetwork) {
        return res.status(400).json({
          success: false,
          message: "Binance deposit address and network must be set in settings",
        });
      }
      await bybitManager.transferUnifiedToFunding(keys.bybit, "USDT", amt);
      await new Promise((r) => setTimeout(r, WAIT_MS));
      await bybitManager.withdrawCreate(keys.bybit, "USDT", binanceNetwork, binanceAddress, amt);
      return res.json({ success: true, message: `Transferred $${amt} from Bybit to Binance (withdraw to ${binanceAddress})` });
    }

    return res.status(400).json({ success: false, message: "Invalid from/to combination" });
  } catch (e) {
    const msg = e.response?.data?.msg ?? e.response?.data?.message ?? e.message ?? "Transfer failed";
    console.error("[Transfer]", e.message || e);
    return res.status(500).json({ success: false, message: String(msg) });
  }
});

module.exports = router;
