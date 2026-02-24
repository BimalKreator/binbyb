const express = require("express");
const Setting = require("../models/Setting");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

/** GET /api/settings - Get global settings (single doc) */
router.get("/", async (req, res) => {
  try {
    let doc = await Setting.findOne().lean();
    if (!doc) {
      doc = await Setting.create({});
      doc = doc.toObject();
    }
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/** PUT /api/settings - Update global settings */
router.put("/", async (req, res) => {
  try {
    const { capitalPercent, maxTrades, stopLoss, takeProfit, autoTrade, userMinSpread } = req.body;
    const update = {};
    if (capitalPercent !== undefined) update.capitalPercent = Number(capitalPercent);
    if (maxTrades !== undefined) update.maxTrades = Number(maxTrades);
    if (stopLoss !== undefined) update.stopLoss = Number(stopLoss);
    if (takeProfit !== undefined) update.takeProfit = Number(takeProfit);
    if (autoTrade !== undefined) update.autoTrade = Boolean(autoTrade);
    if (userMinSpread !== undefined) update.userMinSpread = Number(userMinSpread);

    const doc = await Setting.findOneAndUpdate({}, update, { new: true, upsert: true }).lean();
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
