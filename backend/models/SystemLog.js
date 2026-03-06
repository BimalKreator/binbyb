const mongoose = require("mongoose");

const systemLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ["ENTRY", "EXIT", "ERROR", "SYSTEM"] },
    message: { type: String, required: true },
    symbol: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 7-day TTL: documents auto-delete 7 days after createdAt
systemLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model("SystemLog", systemLogSchema);
