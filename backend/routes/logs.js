/**
 * GET /api/logs — recent system logs for initial load (real-time continues via Socket.io)
 */
const express = require("express");
const { protect } = require("../middleware/auth");
const SystemLog = require("../models/SystemLog");

const router = express.Router();
router.use(protect);

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const logs = await SystemLog.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const items = logs.map((l) => ({
      level: l.level,
      message: l.message,
      category: l.metadata?.category || (l.level === "error" ? "error" : null),
      ts: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
    }));
    res.json({ success: true, data: items.reverse() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Failed to fetch logs." });
  }
});

module.exports = router;
