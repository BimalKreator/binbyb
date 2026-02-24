const mongoose = require("mongoose");

const TTL_SECONDS = 48 * 60 * 60; // 48 hours

const systemLogSchema = new mongoose.Schema(
  {
    level: { type: String, required: true, enum: ["error", "warn", "info", "debug"] },
    message: { type: String, required: true },
    source: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now, expires: TTL_SECONDS },
  },
  { timestamps: true }
);

// TTL index: MongoDB automatically deletes documents when createdAt is older than 48h
systemLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

module.exports = mongoose.model("SystemLog", systemLogSchema);
