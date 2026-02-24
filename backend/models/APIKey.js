const mongoose = require("mongoose");

const apiKeySchema = new mongoose.Schema(
  {
    exchange: { type: String, required: true, enum: ["binance", "bybit"] },
    apiKeyEncrypted: { type: String, required: true },
    apiSecretEncrypted: { type: String, required: true },
    passphraseEncrypted: { type: String, default: "" },
    label: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

apiKeySchema.index({ exchange: 1 });

module.exports = mongoose.model("APIKey", apiKeySchema);
