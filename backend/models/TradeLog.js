const mongoose = require("mongoose");

const tradeLogSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: "" },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    pnl: { type: Number, required: true },
    reason: { type: String, enum: ["Target", "SL", "Orphan", "Manual"], default: "Manual" },
    /** Human-readable exit reason for UI (e.g. "Stop Loss Hit (Combined)", "Orphan Exit: Bybit Data Missing (10s Lag)"). */
    exitReason: { type: String, default: "" },
    exitTime: { type: Date, default: Date.now },
    side: { type: String, enum: ["long", "short", ""], default: "" },
    exchange: { type: String, default: "" },
    /** Links Binance + Bybit legs of the same arbitrage; null for legacy or single-leg (orphan). */
    groupId: { type: String, default: null },
    /** Requested limit price when opening (if available). */
    requestedEntryPrice: { type: Number, default: null },
    /** Actual avg entry price from position (executed entry). */
    executedEntryPrice: { type: Number, default: null },
    /** Requested limit price when closing (close order). */
    reqExit: { type: Number, default: null },
    /** Actual exit fill price (executed exit). */
    execExit: { type: Number, default: null },
    /** Commission/fee paid on this leg (e.g. USDT). */
    fee: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

tradeLogSchema.index({ createdAt: -1 });
tradeLogSchema.index({ exitTime: -1 });
tradeLogSchema.index({ symbol: 1, exitTime: -1 });
tradeLogSchema.index({ groupId: 1 });

module.exports = mongoose.model("TradeLog", tradeLogSchema);
