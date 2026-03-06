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
    useStoploss: { type: Boolean, default: false },
    useTarget: { type: Boolean, default: false },
    autoTrade: { type: Boolean, default: false },
    autoTradeEnabled: { type: Boolean, default: false },
    autoExitEnabled: { type: Boolean, default: false },
    entryTimeMs: { type: Number, default: 1000 }, // ms before funding to execute entry
    entrySlippagePct: { type: Number, default: 0.1 }, // IOC limit order slippage % (arbitrage needs tight slippage)
    minL2Spread: { type: Number, default: 0.15 }, // min L2 orderbook spread % for entry (e.g. 0.15 = 0.15%)
    userMinSpread: { type: Number, default: 0, min: 0 }, // min spread in % (e.g. 0.1 = 0.1%)
    openingBalance: { type: Number, default: 0 }, // USDT balance at start (legacy; use dailyOpeningBalance for daily snapshot)
    dailyOpeningBalance: { type: Number, default: 3450 }, // Snapshot of total capital at 00:00 IST each day
    lastSnapshotDate: { type: String, default: "" }, // YYYY-MM-DD in IST
    binanceDepositAddress: { type: String, default: "" },
    binanceNetwork: { type: String, default: "" }, // e.g. TRC20, BEP20
    bybitDepositAddress: { type: String, default: "" },
    bybitNetwork: { type: String, default: "" },
    mismatchMinNotionalFilter: { type: Boolean, default: true },
    liquidationAutoClose: { type: Boolean, default: false },
    liquidationDistancePct: { type: Number, default: 25 },
    cooldownMinutes: { type: Number, default: 15 },
    bannedTokens: { type: [String], default: [] },
    useAdvancedRanking: { type: Boolean, default: false },
    rankStepA: { type: Boolean, default: true },
    rankStepB: { type: Boolean, default: true },
    rankStepC: { type: Boolean, default: true },
    minFundingConsistency: { type: Number, default: 75 },
    minFundingSpread: { type: Number, default: 0.15 },
    allowedIntervals: { type: [Number], default: [1, 2, 4, 8] },
    binanceMarginAllowedPct: { type: Number, default: 50, min: 0, max: 100 },
    bybitMarginAllowedPct: { type: Number, default: 50, min: 0, max: 100 },
    screenerSortBy: { type: String, enum: ["funding", "l2spread"], default: "funding" },
    screenerTradeNotional: { type: Number, default: 500, min: 1 },
    tradingMode: { type: String, enum: ["funding", "l2"], default: "funding" },
    screenerDirectionBy: { type: String, enum: ["funding", "l2"], default: "funding" },
  },
  { timestamps: true }
);

// Single global settings document: use findOne() / findOneAndUpdate(); _id already has a unique index by default.

module.exports = mongoose.model("Setting", settingSchema);
