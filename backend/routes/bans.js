/**
 * Bans API: list banned/cooling tokens and toggle ban by symbol.
 * GET /: { bannedTokens, coolingTokens }
 * POST /: { symbol, action: 'ban' | 'unban' } -> updates settings.bannedTokens, returns { bannedTokens }
 */

const express = require("express");
const { protect } = require("../middleware/auth");
const Setting = require("../models/Setting");
const autoTrader = require("../services/autoTrader");

const router = express.Router();
router.use(protect);

router.get("/", async (req, res) => {
  try {
    const settings = await Setting.findOne().lean();
    const bannedTokens = Array.isArray(settings?.bannedTokens) ? settings.bannedTokens : [];
    const coolingTokens = autoTrader.getCoolingTokens ? autoTrader.getCoolingTokens() : [];
    return res.json({ bannedTokens, coolingTokens });
  } catch (e) {
    console.error("[Bans] GET error:", e?.message);
    return res.status(500).json({ error: e?.message || "Failed to fetch bans." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { symbol, action } = req.body || {};
    const sym = String(symbol || "").toUpperCase();
    if (!sym) {
      return res.status(400).json({ error: "symbol is required." });
    }
    if (action !== "ban" && action !== "unban") {
      return res.status(400).json({ error: "action must be 'ban' or 'unban'." });
    }

    let settings = await Setting.findOne();
    if (!settings) {
      settings = await Setting.create({});
    }
    const list = Array.isArray(settings.bannedTokens) ? [...settings.bannedTokens] : [];
    const set = new Set(list.map((s) => String(s).toUpperCase()));

    if (action === "unban") {
      settings.bannedTokens = list.filter((s) => String(s).toUpperCase() !== sym);
      await settings.save();
      return res.json({ bannedTokens: settings.bannedTokens });
    }
    if (!set.has(sym)) {
      list.push(sym);
    }
    settings.bannedTokens = list;
    await settings.save();
    return res.json({ bannedTokens: settings.bannedTokens });
  } catch (e) {
    console.error("[Bans] POST error:", e?.message);
    return res.status(500).json({ error: e?.message || "Failed to update ban." });
  }
});

module.exports = router;
