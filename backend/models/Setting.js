const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    capitalPercent: { type: Number, default: 10, min: 0, max: 100 },
    leverage: { type: Number, default: 10, min: 1, max: 125 },
    maxTrades: { type: Number, default: 5, min: 0 },
    stopLoss: { type: Number, default: 0 },
    takeProfit: { type: Number, default: 0 },
    slPercent: { type: Number, default: 0 },   // combined PnL % to trigger stop (e.g. -2)
    tpPercent: { type: Number, default: 0 },   // combined PnL % to trigger take profit (e.g. 1)
    autoTrade: { type: Boolean, default: false },
    autoTradeEnabled: { type: Boolean, default: false },
    autoExitEnabled: { type: Boolean, default: false },
    entryTimeMs: { type: Number, default: 1000 }, // ms before funding to execute entry
    entrySlippagePct: { type: Number, default: 2 }, // IOC limit order slippage %
    userMinSpread: { type: Number, default: 0, min: 0 }, // min spread in % (e.g. 0.1 = 0.1%)
    openingBalance: { type: Number, default: 0 }, // USDT balance at start (for Profit = Current - Opening - Deposits + Withdrawals)
    binanceDepositAddress: { type: String, default: "" },
    binanceNetwork: { type: String, default: "" }, // e.g. TRC20, BEP20
    bybitDepositAddress: { type: String, default: "" },
    bybitNetwork: { type: String, default: "" },
    mismatchMinNotionalFilter: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Single global settings document: use findOne() / findOneAndUpdate(); _id already has a unique index by default.

module.exports = mongoose.model("Setting", settingSchema);
