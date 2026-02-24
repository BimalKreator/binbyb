const express = require("express");
const FundLog = require("../models/FundLog");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

/** GET /api/fund-logs - List fund logs (deposits/withdrawals) */
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const logs = await FundLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, data: logs });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/** POST /api/fund-logs - Create manual deposit/withdrawal log */
router.post("/", async (req, res) => {
  try {
    const { type, amount, currency, exchange, txId, status } = req.body;
    if (!type || amount == null) {
      return res.status(400).json({ success: false, message: "type and amount are required." });
    }
    if (type !== "deposit" && type !== "withdrawal") {
      return res.status(400).json({ success: false, message: "type must be deposit or withdrawal." });
    }
    const doc = await FundLog.create({
      type,
      amount: Number(amount),
      currency: currency || "USDT",
      exchange: exchange || "",
      txId: txId || "",
      status: status || "completed",
    });
    res.status(201).json({ success: true, data: doc.toObject() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
