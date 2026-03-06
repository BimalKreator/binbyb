/**
 * GET /api/logs — recent system logs (legacy shape for Socket.io compatibility)
 * GET /api/logs/system — DB-driven logs with ?type=ENTRY,EXIT&days=7
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
      level: l.type === "ERROR" ? "error" : (l.level || "info"),
      message: l.message,
      category: l.type === "ENTRY" ? "entry" : l.type === "EXIT" ? "exit" : l.type === "ERROR" ? "error" : (l.metadata?.category || null),
      ts: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
      type: l.type,
      symbol: l.symbol ?? null,
      details: l.details ?? l.metadata ?? {},
    }));
    res.json({ success: true, data: items.reverse() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Failed to fetch logs." });
  }
});

/** GET /api/logs/system?type=ENTRY,EXIT,ERROR&days=7 — last 7 days, filter by type, limit 1000 */
router.get("/system", async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const typeParam = req.query.type;
    const typesArray = typeParam
      ? typeParam.split(",").map((s) => s.trim().toUpperCase()).filter((t) => ["ENTRY", "EXIT", "ERROR", "SYSTEM"].includes(t))
      : ["ENTRY", "EXIT", "ERROR", "SYSTEM"];
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const logs = await SystemLog.find({
      createdAt: { $gte: since },
      type: { $in: typesArray },
    })
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    const data = logs.map((l) => ({
      _id: l._id,
      type: l.type,
      message: l.message,
      symbol: l.symbol ?? null,
      details: l.details ?? {},
      createdAt: l.createdAt,
      ts: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
    }));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Failed to fetch system logs." });
  }
});

module.exports = router;
