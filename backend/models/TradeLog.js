const mongoose = require("mongoose");

const tradeLogSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: "" },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    pnl: { type: Number, required: true },
    reason: { type: String, enum: ["Target", "SL", "Orphan", "Manual"], default: "Manual" },
    exitTime: { type: Date, default: Date.now },
    side: { type: String, enum: ["long", "short", ""], default: "" },
    exchange: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

tradeLogSchema.index({ createdAt: -1 });
tradeLogSchema.index({ exitTime: -1 });

module.exports = mongoose.model("TradeLog", tradeLogSchema);
