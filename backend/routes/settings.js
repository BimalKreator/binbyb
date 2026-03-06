const express = require("express");
const Setting = require("../models/Setting");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

/** GET /api/settings - Get global settings (single doc) */
router.get("/", async (req, res) => {
  try {
    let doc = await Setting.findOne().lean();
    if (!doc) {
      doc = await Setting.create({});
      doc = doc.toObject();
    }
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/** PUT /api/settings - Update global settings */
router.put("/", async (req, res) => {
  try {
    const {
      capitalPercent,
      leverage,
      maxTrades,
      stopLoss,
      takeProfit,
      useStoploss,
      useTarget,
      autoTrade,
      autoTradeEnabled,
      autoExitEnabled,
      mismatchMinNotionalFilter,
      liquidationAutoClose,
      liquidationDistancePct,
      entryTimeMs,
      entrySlippagePct,
      cooldownMinutes,
      minL2Spread,
      userMinSpread,
      openingBalance,
      binanceDepositAddress,
      binanceNetwork,
      bybitDepositAddress,
      bybitNetwork,
      useAdvancedRanking,
      rankStepA,
      rankStepB,
      rankStepC,
      minFundingConsistency,
      minFundingSpread,
      minL2VwapSpread,
      allowedIntervals,
      binanceMarginAllowedPct,
      bybitMarginAllowedPct,
      screenerSortBy,
      screenerTradeNotional,
      tradingMode,
      screenerDirectionBy,
      l2FavourableFundingOnly,
    } = req.body;
    const update = {};
    if (capitalPercent !== undefined) update.capitalPercent = Number(capitalPercent);
    if (leverage !== undefined) update.leverage = Math.max(1, Math.min(125, Number(leverage) || 10));
    if (maxTrades !== undefined) update.maxTrades = Number(maxTrades);
    if (stopLoss !== undefined) update.stopLoss = Number(stopLoss);
    if (takeProfit !== undefined) update.takeProfit = Number(takeProfit);
    if (useStoploss !== undefined) update.useStoploss = Boolean(useStoploss);
    if (useTarget !== undefined) update.useTarget = Boolean(useTarget);
    const tradeStatus = autoTradeEnabled !== undefined ? autoTradeEnabled : autoTrade;
    if (tradeStatus !== undefined) {
      update.autoTradeEnabled = Boolean(tradeStatus);
      update.autoTrade = Boolean(tradeStatus);
    }
    if (autoExitEnabled !== undefined) update.autoExitEnabled = Boolean(autoExitEnabled);
    if (mismatchMinNotionalFilter !== undefined) update.mismatchMinNotionalFilter = Boolean(mismatchMinNotionalFilter);
    if (liquidationAutoClose !== undefined) update.liquidationAutoClose = Boolean(liquidationAutoClose);
    if (liquidationDistancePct !== undefined) update.liquidationDistancePct = Math.max(0, Math.min(100, Number(liquidationDistancePct) ?? 25));
    if (entryTimeMs !== undefined) update.entryTimeMs = Math.max(0, Number(entryTimeMs) || 1000);
    if (entrySlippagePct !== undefined) update.entrySlippagePct = Math.max(0, Math.min(100, Number(entrySlippagePct) ?? 0.1));
    if (cooldownMinutes !== undefined) update.cooldownMinutes = Math.max(0, Number(cooldownMinutes) ?? 15);
    if (minL2Spread !== undefined) update.minL2Spread = Number(minL2Spread);
    if (userMinSpread !== undefined) update.userMinSpread = Number(userMinSpread);
    if (openingBalance !== undefined) update.openingBalance = Number(openingBalance);
    if (binanceDepositAddress !== undefined) update.binanceDepositAddress = String(binanceDepositAddress ?? "").trim();
    if (binanceNetwork !== undefined) update.binanceNetwork = String(binanceNetwork ?? "").trim();
    if (bybitDepositAddress !== undefined) update.bybitDepositAddress = String(bybitDepositAddress ?? "").trim();
    if (bybitNetwork !== undefined) update.bybitNetwork = String(bybitNetwork ?? "").trim();
    if (useAdvancedRanking !== undefined) update.useAdvancedRanking = Boolean(useAdvancedRanking);
    if (rankStepA !== undefined) update.rankStepA = Boolean(rankStepA);
    if (rankStepB !== undefined) update.rankStepB = Boolean(rankStepB);
    if (rankStepC !== undefined) update.rankStepC = Boolean(rankStepC);
    if (minFundingConsistency !== undefined) update.minFundingConsistency = Math.max(0, Math.min(100, Number(minFundingConsistency) ?? 75));
    if (minFundingSpread !== undefined) update.minFundingSpread = Number(minFundingSpread);
    if (minL2VwapSpread !== undefined) update.minL2VwapSpread = Number(minL2VwapSpread);
    if (allowedIntervals !== undefined) {
      update.allowedIntervals = Array.isArray(allowedIntervals)
        ? allowedIntervals.map((n) => Number(n)).filter((n) => Number.isFinite(n) && [1, 2, 4, 8].includes(n))
        : [1, 2, 4, 8];
    }
    if (binanceMarginAllowedPct !== undefined) update.binanceMarginAllowedPct = Math.max(0, Math.min(100, Number(binanceMarginAllowedPct) ?? 50));
    if (bybitMarginAllowedPct !== undefined) update.bybitMarginAllowedPct = Math.max(0, Math.min(100, Number(bybitMarginAllowedPct) ?? 50));
    if (screenerSortBy !== undefined) update.screenerSortBy = (screenerSortBy === "l2spread" ? "l2spread" : "funding");
    if (screenerTradeNotional !== undefined) update.screenerTradeNotional = Math.max(1, Number(screenerTradeNotional) || 500);
    if (tradingMode !== undefined) update.tradingMode = (tradingMode === "l2" ? "l2" : "funding");
    if (screenerDirectionBy !== undefined) update.screenerDirectionBy = (screenerDirectionBy === "l2" ? "l2" : "funding");
    if (l2FavourableFundingOnly !== undefined) update.l2FavourableFundingOnly = Boolean(l2FavourableFundingOnly);

    const doc = await Setting.findOneAndUpdate({}, update, { new: true, upsert: true }).lean();
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
