const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "admin" },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 });

module.exports = mongoose.model("User", userSchema);
