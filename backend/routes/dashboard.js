/**
 * Phase 7: Dashboard APIs
 * GET /api/dashboard/metrics - balances, profit, daily ROI, INR conversion, volatilityMeter
 * GET /api/dashboard/positions - active positions from local state (or REST fallback), grouped by symbol
 */

const express = require("express");
const { protect } = require("../middleware/auth");
const Setting = require("../models/Setting");
const FundLog = require("../models/FundLog");
const { getDecryptedApiKeys } = require("../services/apiKeys");
const { binanceManager, bybitManager } = require("../services/exchanges");
const screener = require("../services/screener");

const router = express.Router();
router.use(protect);

const USD_TO_INR = 86.5;

/**
 * Build primary position per symbol from list (largest absolute size wins for pairing).
 * Uses explicit float conversion and !== 0 check so paired rows match frontend expectations.
 */
function buildPrimaryBySymbol(positions) {
  const out = {};
  for (const p of positions || []) {
    const symbol = String(p?.symbol || "").toUpperCase();
    const positionAmt = parseFloat(String(p?.positionAmt ?? 0));
    if (!symbol || !Number.isFinite(positionAmt) || Math.abs(positionAmt) === 0) continue;
    const amtAbs = Math.abs(positionAmt);
    const existing = out[symbol];
    const existingAmt = existing ? Math.abs(parseFloat(String(existing.positionAmt ?? 0))) : 0;
    if (!existing || amtAbs > existingAmt) {
      out[symbol] = {
        symbol,
        side: p?.side ?? (positionAmt > 0 ? "BUY" : "SELL"),
        positionSide: p?.positionSide,
        positionAmt,
        unrealizedProfit: parseFloat(String(p?.unrealizedProfit ?? 0)) || 0,
        marginUsed: parseFloat(String(p?.marginUsed ?? 0)) || 0,
        entryPrice: p?.entryPrice != null && Number.isFinite(p.entryPrice) ? p.entryPrice : null,
        leverage: p?.leverage != null && Number.isFinite(p.leverage) ? p.leverage : null,
        liquidationPrice: p?.liquidationPrice != null && Number.isFinite(p.liquidationPrice) ? p.liquidationPrice : null,
      };
    }
  }
  return out;
}

/** GET /api/dashboard/metrics */
router.get("/metrics", async (req, res) => {
  try {
    const settings = await Setting.findOne().lean();
    const openingBalance = Number(settings?.openingBalance) || 0;

    const keys = await getDecryptedApiKeys();
    // getBalance() is synchronous (reads from WS cache); no await, no REST. Safe fallback to 0.
    const binanceBalance =
      keys?.binance?.apiKey && keys?.binance?.apiSecret
        ? (Number(binanceManager.getBalance(keys.binance)) || 0)
        : 0;
    const val = bybitManager.getBalance();
    const bybitBalance = Number.isFinite(val) ? val : 0;

    const totalCapital = binanceBalance + bybitBalance;
    const currentBalance = totalCapital;

    const logs = await FundLog.find().lean();
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    for (const log of logs) {
      if (log.status === "failed") continue;
      const amt = Number(log.amount) || 0;
      if (log.type === "deposit") totalDeposits += amt;
      if (log.type === "withdrawal") totalWithdrawals += amt;
    }

    const profit = currentBalance - openingBalance - totalDeposits + totalWithdrawals;
    const dailyROI = openingBalance > 0 ? (profit / openingBalance) * 100 : null;
    const profitPercent =
      openingBalance !== 0 && Number.isFinite(openingBalance)
        ? ((currentBalance - openingBalance) / openingBalance) * 100
        : null;
    const totalCapitalINR = currentBalance * USD_TO_INR;
    const volatilityMeter = screener.getVolatilityMeter();

    console.log("[Dashboard API] Metrics requested. Balances:", { binanceBalance, bybitBalance });
    return res.json({
      success: true,
      data: {
        binanceBalance: Number.isFinite(binanceBalance) ? binanceBalance : 0,
        bybitBalance: Number.isFinite(bybitBalance) ? bybitBalance : 0,
        totalCapital,
        currentBalance,
        openingBalance,
        totalDeposits,
        totalWithdrawals,
        profit,
        profitPercent: profitPercent != null && Number.isFinite(profitPercent) ? profitPercent : null,
        dailyROI,
        totalCapitalINR,
        usdToInr: USD_TO_INR,
        volatilityMeter,
      },
    });
  } catch (e) {
    console.error("[Dashboard/metrics]", e.message);
    return res.status(500).json({ success: false, message: e.message || "Failed to fetch metrics." });
  }
});

/** GET /api/dashboard/positions — reads only from managers' local state (WS + initial startup hydration). No REST polling. */
router.get("/positions", async (req, res) => {
  try {
    const keys = await getDecryptedApiKeys();
    if (!keys?.binance?.apiKey || !keys?.binance?.apiSecret || !keys?.bybit?.apiKey || !keys?.bybit?.apiSecret) {
      return res.json({ success: true, data: [] });
    }

    const binancePositions = binanceManager.getLivePositions();
    const bybitPositions = bybitManager.getLivePositions();

    const binanceBySymbol = buildPrimaryBySymbol(binancePositions);
    const bybitBySymbol = buildPrimaryBySymbol(bybitPositions);
    const binanceSymbols = new Set(Object.keys(binanceBySymbol));
    const bybitSymbols = new Set(Object.keys(bybitBySymbol));
    const allSymbols = Array.from(new Set([...binanceSymbols, ...bybitSymbols]));
    const snapshot = screener.getSnapshot();
    const rankedTokens = snapshot?.rankedTokens || [];

    const defaultBinancePos = {
      side: "NONE",
      positionSide: "NONE",
      positionAmt: 0,
      unrealizedProfit: 0,
      marginUsed: 0,
      entryPrice: null,
      leverage: null,
      liquidationPrice: null,
    };
    const defaultBybitPos = {
      side: "NONE",
      positionSide: "NONE",
      positionAmt: 0,
      unrealizedProfit: 0,
      marginUsed: 0,
      entryPrice: null,
      leverage: null,
      liquidationPrice: null,
    };

    const positions = [];
    let grandTotalPnl = 0;
    let grandTotalNextFundingAmount = 0;

    for (const symbol of allSymbols) {
      const binancePos = binanceBySymbol[symbol] ?? defaultBinancePos;
      const bybitPos = bybitBySymbol[symbol] ?? defaultBybitPos;

      const binanceMark = binanceManager.getMarkPrice(symbol) ?? 0;
      const bybitMark = bybitManager.getMarkPrice(symbol) ?? 0;
      const binanceFundingRate = binanceManager.getCachedFundingRate(symbol) ?? 0;
      const bybitFundingRate = bybitManager.getCachedFundingRate(symbol) ?? 0;

      const binanceAmt = parseFloat(String(binancePos.positionAmt ?? 0)) || 0;
      const bybitAmt = parseFloat(String(bybitPos.positionAmt ?? 0)) || 0;
      const notionalBinance = Math.abs(binanceAmt) * (Number.isFinite(binanceMark) ? binanceMark : 0);
      const notionalBybit = Math.abs(bybitAmt) * (Number.isFinite(bybitMark) ? bybitMark : 0);
      const binanceFundingDecimal = Number(binanceFundingRate) || 0;
      const bybitFundingDecimal = Number(bybitFundingRate) || 0;
      const binanceNextFundingAmount = notionalBinance * binanceFundingDecimal;
      const bybitNextFundingAmount = notionalBybit * bybitFundingDecimal;
      const totalNextFundingAmount = binanceNextFundingAmount + bybitNextFundingAmount;

      const combinedUnrealized =
        parseFloat(String(binancePos.unrealizedProfit ?? 0)) + parseFloat(String(bybitPos.unrealizedProfit ?? 0));
      const combinedMargin =
        parseFloat(String(binancePos.marginUsed ?? 0)) + parseFloat(String(bybitPos.marginUsed ?? 0));
      const combinedPnlPct = combinedMargin > 0 ? (combinedUnrealized / combinedMargin) * 100 : null;

      grandTotalPnl += combinedUnrealized;
      grandTotalNextFundingAmount += totalNextFundingAmount;

      const token = rankedTokens.find((t) => String(t?.symbol || "").toUpperCase() === symbol);
      const nextFundingTime = token != null ? (token.nextFundingTime ?? null) : null;
      const fundingPaymentEstimate =
        nextFundingTime != null && Number.isFinite(nextFundingTime)
          ? { nextFundingTime, nextFundingTimeISO: new Date(nextFundingTime).toISOString() }
          : null;

      positions.push({
        symbol,
        isFundingFlipped: totalNextFundingAmount < 0,
        binance: {
          side: binancePos.side,
          positionSide: binancePos.positionSide,
          positionAmt: binanceAmt,
          unrealizedProfit: parseFloat(String(binancePos.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(binancePos.marginUsed ?? 0)) || 0,
          entryPrice: binancePos.entryPrice,
          leverage: binancePos.leverage,
          liquidationPrice: binancePos.liquidationPrice,
          markPrice: binanceMark,
          fundingRate: binanceFundingRate,
          fundingRatePct: Number.isFinite(binanceFundingRate) ? binanceFundingRate * 100 : null,
          nextFundingAmount: binanceNextFundingAmount,
          exchangeFees: 0,
        },
        bybit: {
          side: bybitPos.side,
          positionSide: bybitPos.positionSide ?? "NONE",
          positionAmt: bybitAmt,
          unrealizedProfit: parseFloat(String(bybitPos.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(bybitPos.marginUsed ?? 0)) || 0,
          entryPrice: bybitPos.entryPrice,
          leverage: bybitPos.leverage,
          liquidationPrice: bybitPos.liquidationPrice,
          markPrice: bybitMark,
          fundingRate: bybitFundingRate,
          fundingRatePct: Number.isFinite(bybitFundingRate) ? bybitFundingRate * 100 : null,
          nextFundingAmount: bybitNextFundingAmount,
          exchangeFees: 0,
        },
        combinedUnrealizedProfit: combinedUnrealized,
        combinedMarginUsed: combinedMargin,
        combinedPnlPercent: combinedPnlPct,
        totalNextFundingAmount,
        nextFundingPayment: fundingPaymentEstimate,
      });
    }

    console.log("[Dashboard API] Positions requested. Count:", positions.length);
    return res.json({
      success: true,
      data: positions,
      grandTotalPnl,
      grandTotalNextFundingAmount,
    });
  } catch (e) {
    console.error("[Dashboard/positions]", e.message);
    return res.status(500).json({ success: false, message: e.message || "Failed to fetch positions." });
  }
});

module.exports = router;
