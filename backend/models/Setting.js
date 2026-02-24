const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    capitalPercent: { type: Number, default: 10, min: 0, max: 100 },
    maxTrades: { type: Number, default: 5, min: 0 },
    stopLoss: { type: Number, default: 0 },
    takeProfit: { type: Number, default: 0 },
    autoTrade: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Single global settings document
settingSchema.index({ _id: 1 }, { unique: true });

module.exports = mongoose.model("Setting", settingSchema);
