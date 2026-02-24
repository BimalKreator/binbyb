const mongoose = require("mongoose");

const fundLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ["deposit", "withdrawal"] },
    amount: { type: Number, required: true },
    currency: { type: String, default: "USDT" },
    exchange: { type: String, default: "" },
    txId: { type: String, default: "" },
    status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

fundLogSchema.index({ createdAt: -1 });
fundLogSchema.index({ type: 1 });

module.exports = mongoose.model("FundLog", fundLogSchema);
