const express = require("express");
const APIKey = require("../models/APIKey");
const { encrypt } = require("../utils/encrypt");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

/** GET /api/api-keys - List API keys (no secrets returned) */
router.get("/", async (req, res) => {
  try {
    const keys = await APIKey.find({ isActive: true }).select("-apiKeyEncrypted -apiSecretEncrypted -passphraseEncrypted").lean();
    res.json({ success: true, data: keys });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/** POST /api/api-keys - Create or update API key for an exchange */
router.post("/", async (req, res) => {
  try {
    const { exchange, apiKey, apiSecret, passphrase, label } = req.body;
    if (!exchange || !apiKey || !apiSecret) {
      return res.status(400).json({ success: false, message: "exchange, apiKey, and apiSecret are required." });
    }
    const name = exchange.toLowerCase();
    if (name !== "binance" && name !== "bybit") {
      return res.status(400).json({ success: false, message: "exchange must be binance or bybit." });
    }
    const doc = await APIKey.findOneAndUpdate(
      { exchange: name },
      {
        apiKeyEncrypted: encrypt(apiKey),
        apiSecretEncrypted: encrypt(apiSecret),
        passphraseEncrypted: passphrase ? encrypt(passphrase) : "",
        label: label || "",
        isActive: true,
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: { _id: doc._id, exchange: doc.exchange, label: doc.label } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
