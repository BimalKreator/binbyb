const mongoose = require("mongoose");

const tradeLogSchema = new mongoose.Schema(
  {
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    pnl: { type: Number, required: true },
    symbol: { type: String, default: "" },
    side: { type: String, enum: ["long", "short", ""], default: "" },
    exchange: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

tradeLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("TradeLog", tradeLogSchema);
