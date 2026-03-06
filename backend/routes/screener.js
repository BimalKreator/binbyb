const express = require("express");
const screener = require("../services/screener");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.get("/", protect, (req, res) => {
  try {
    const snapshot = screener.getSnapshot();
    const list = snapshot.rankedTokens || [];
    res.json({ success: true, ...snapshot, rankedTokens: list.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
