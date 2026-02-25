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
    let binanceBalance = 0;
    let bybitBalance = 0;

    // Fetch Binance balance independently; 418/403 must not crash the route.
    if (keys?.binance?.apiKey && keys?.binance?.apiSecret) {
      try {
        const val = await binanceManager.getBalance(keys.binance);
        binanceBalance = Number.isFinite(val) ? val : 0;
      } catch (e) {
        const status = e.response?.status;
        const isBan = status === 418 || status === 403;
        if (isBan) {
          console.error("[Dashboard/metrics] Binance balance skipped (IP/ban):", status, e.response?.data?.msg ?? e.message);
        } else {
          console.warn("[Dashboard/metrics] Binance getBalance failed:", e.message);
        }
        binanceBalance = 0;
      }
    }

    // Fetch Bybit balance independently.
    if (keys?.bybit?.apiKey && keys?.bybit?.apiSecret) {
      try {
        const val = await bybitManager.getBalance(keys.bybit);
        bybitBalance = Number.isFinite(val) ? val : 0;
      } catch (e) {
        console.warn("[Dashboard/metrics] Bybit getBalance failed:", e.message);
        bybitBalance = 0;
      }
    }

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
    const pairedSymbols = [...binanceSymbols].filter((s) => bybitSymbols.has(s));
    const snapshot = screener.getSnapshot();
    const rankedTokens = snapshot?.rankedTokens || [];

    const positions = [];
    for (const symbol of pairedSymbols) {
      const binancePos = binanceBySymbol[symbol];
      const bybitPos = bybitBySymbol[symbol];
      if (!binancePos || !bybitPos) continue;

      const combinedUnrealized =
        parseFloat(String(binancePos.unrealizedProfit ?? 0)) + parseFloat(String(bybitPos.unrealizedProfit ?? 0));
      const combinedMargin =
        parseFloat(String(binancePos.marginUsed ?? 0)) + parseFloat(String(bybitPos.marginUsed ?? 0));
      const combinedPnlPct = combinedMargin > 0 ? (combinedUnrealized / combinedMargin) * 100 : null;

      const token = rankedTokens.find((t) => String(t?.symbol || "").toUpperCase() === symbol);
      const nextFundingTime = token?.nextFundingTime ?? null;
      const fundingPaymentEstimate =
        nextFundingTime != null && Number.isFinite(nextFundingTime)
          ? { nextFundingTime, nextFundingTimeISO: new Date(nextFundingTime).toISOString() }
          : null;

      positions.push({
        symbol,
        binance: {
          side: binancePos.side,
          positionSide: binancePos.positionSide,
          positionAmt: parseFloat(String(binancePos.positionAmt ?? 0)) || 0,
          unrealizedProfit: parseFloat(String(binancePos.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(binancePos.marginUsed ?? 0)) || 0,
        },
        bybit: {
          side: bybitPos.side,
          positionAmt: parseFloat(String(bybitPos.positionAmt ?? 0)) || 0,
          unrealizedProfit: parseFloat(String(bybitPos.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(bybitPos.marginUsed ?? 0)) || 0,
        },
        combinedUnrealizedProfit: combinedUnrealized,
        combinedMarginUsed: combinedMargin,
        combinedPnlPercent: combinedPnlPct,
        nextFundingPayment: fundingPaymentEstimate,
      });
    }

    return res.json({ success: true, data: positions });
  } catch (e) {
    console.error("[Dashboard/positions]", e.message);
    return res.status(500).json({ success: false, message: e.message || "Failed to fetch positions." });
  }
});

module.exports = router;
