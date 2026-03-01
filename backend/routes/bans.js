const express = require('express');
const router = express.Router();
const Setting = require('../models/Setting');
const autoTrader = require('../services/autoTrader');

// GET banned and cooling tokens
router.get('/', async (req, res) => {
    try {
        const settings = await Setting.findOne();
        const bannedTokens = settings ? (settings.bannedTokens || []) : [];
        
        let coolingTokens = [];
        if (typeof autoTrader.getCoolingTokens === 'function') {
            coolingTokens = autoTrader.getCoolingTokens();
        }

        res.json({ bannedTokens, coolingTokens });
    } catch (err) {
        console.error("Error fetching bans:", err);
        res.status(500).json({ error: "Failed to fetch bans" });
    }
});

// POST to ban or unban a token
router.post('/', async (req, res) => {
    try {
        const { symbol, action } = req.body;
        if (!symbol || !action) {
            return res.status(400).json({ error: "Missing symbol or action" });
        }

        let settings = await Setting.findOne();
        if (!settings) settings = await Setting.create({});
        
        let banned = settings.bannedTokens || [];

        if (action === 'ban') {
            if (!banned.includes(symbol)) banned.push(symbol);
        } else if (action === 'unban') {
            banned = banned.filter(t => t !== symbol);
        }

        settings.bannedTokens = banned;
        await settings.save();

        res.json({ success: true, bannedTokens: banned });
    } catch (err) {
        console.error("Error updating ban:", err);
        res.status(500).json({ error: "Failed to update ban" });
    }
});

module.exports = router;
