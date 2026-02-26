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
    /** Links Binance + Bybit legs of the same arbitrage; null for legacy or single-leg (orphan). */
    groupId: { type: String, default: null },
    /** Limit price sent when closing (requested exit). */
    requestedEntryPrice: { type: Number, default: null },
    /** Actual avg fill price (executed); fallback to exitPrice if not from exchange. */
    executedEntryPrice: { type: Number, default: null },
    /** Commission/fee paid on this leg (e.g. USDT). */
    fee: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

tradeLogSchema.index({ createdAt: -1 });
tradeLogSchema.index({ exitTime: -1 });
tradeLogSchema.index({ groupId: 1 });

module.exports = mongoose.model("TradeLog", tradeLogSchema);
