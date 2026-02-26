/**
 * Phase 8: Trade History API
 * GET /api/trades/history?page=1&limit=20 — paginated TradeLog, sorted by exitTime desc
 */

const express = require("express");
const { protect } = require("../middleware/auth");
const TradeLog = require("../models/TradeLog");

const router = express.Router();
router.use(protect);

router.get("/history", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [total, trades] = await Promise.all([
      TradeLog.countDocuments(),
      TradeLog.find()
        .sort({ exitTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const items = trades.map((t) => ({
      _id: t._id,
      symbol: t.symbol || "",
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      reason: t.reason || "Manual",
      pnl: t.pnl,
      exitTime: t.exitTime,
      side: t.side || "",
      exchange: t.exchange || "",
      groupId: t.groupId ?? null,
      requestedEntryPrice: t.requestedEntryPrice ?? null,
      executedEntryPrice: t.executedEntryPrice ?? null,
      fee: t.fee ?? 0,
    }));

    return res.json({
      success: true,
      data: { total, page, limit, trades: items },
    });
  } catch (e) {
    console.error("[Trades/history]", e.message);
    return res.status(500).json({ success: false, message: e.message || "Failed to fetch trade history." });
  }
});

module.exports = router;
