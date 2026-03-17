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
    const OPENING_BALANCE = 3300;

    const keys = await getDecryptedApiKeys();
    // Strictly use WebSocket-cached values only. No REST to avoid IP bans.
    // Binance: Margin Balance (wallet + total unrealized PnL). Bybit: Total Equity.
    let binanceBalances = { totalMarginBalance: 0, totalWalletBalance: 0, availableBalance: 0 };
    let bybitBalances = { totalEquity: 0, totalWalletBalance: 0, availableBalance: 0 };
    if (keys?.binance?.apiKey && keys?.binance?.apiSecret) {
      const bin = binanceManager.getBalance(keys.binance);
      const marginBalance = typeof bin === "object" && bin != null ? Number(bin.balance) : Number(bin);
      const binanceAvail = typeof bin === "object" && bin != null ? Number(bin.availableBalance) : 0;
      binanceBalances = {
        totalMarginBalance: Number.isFinite(marginBalance) ? marginBalance : 0,
        totalWalletBalance: Number.isFinite(marginBalance) ? marginBalance : 0,
        availableBalance: Number.isFinite(binanceAvail) ? binanceAvail : 0,
      };
    }
    if (keys?.bybit?.apiKey && keys?.bybit?.apiSecret) {
      const byb = bybitManager.getBalance();
      const totalEquity = typeof byb === "object" && byb != null ? Number(byb.balance) : Number(byb);
      const bybitAvail = typeof byb === "object" && byb != null ? Number(byb.availableBalance) : 0;
      bybitBalances = {
        totalEquity: Number.isFinite(totalEquity) ? totalEquity : 0,
        totalWalletBalance: Number.isFinite(totalEquity) ? totalEquity : 0,
        availableBalance: Number.isFinite(bybitAvail) ? bybitAvail : 0,
      };
    }
    const actualBinanceMarginBalance = parseFloat(binanceBalances.totalMarginBalance || binanceBalances.totalWalletBalance || binanceBalances.availableBalance || 0) || 0;
    const actualBybitEquity = parseFloat(bybitBalances.totalEquity || bybitBalances.totalWalletBalance || bybitBalances.availableBalance || 0) || 0;
    const FUNDS_ADD_PER_EXCHANGE = 1650; // Added to actual balance of each exchange for funds display
    const binanceBalance = actualBinanceMarginBalance + FUNDS_ADD_PER_EXCHANGE;
    const bybitBalance = actualBybitEquity + FUNDS_ADD_PER_EXCHANGE;
    const totalCapital = binanceBalance + bybitBalance;

    const binanceAvailableBalance = parseFloat(binanceBalances.availableBalance || 0) || 0;
    const bybitAvailableBalance = parseFloat(bybitBalances.availableBalance || bybitBalances.availableToWithdraw || 0) || 0;

    const binancePositions = keys?.binance?.apiKey ? binanceManager.getLivePositions() || [] : [];
    const bybitPositions = keys?.bybit?.apiKey ? bybitManager.getLivePositions() || [] : [];
    const binanceUsedMargin = binancePositions.reduce((s, p) => s + (parseFloat(String(p?.marginUsed ?? 0)) || 0), 0);
    const bybitUsedMargin = bybitPositions.reduce((s, p) => s + (parseFloat(String(p?.marginUsed ?? 0)) || 0), 0);
    const binanceTotalTradeValue = binancePositions.reduce((sum, p) => {
      const amt = Math.abs(parseFloat(p?.positionAmt ?? 0) || 0);
      const mark = binanceManager.getMarkPrice(p?.symbol) ?? 0;
      return sum + amt * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const bybitTotalTradeValue = bybitPositions.reduce((sum, p) => {
      const amt = Math.abs(parseFloat(p?.positionAmt ?? p?.size ?? 0) || 0);
      const mark = bybitManager.getMarkPrice(p?.symbol) ?? 0;
      return sum + amt * (Number.isFinite(mark) ? mark : 0);
    }, 0);
    const binanceWallet = {
      totalWalletBalance: Number.isFinite(binanceBalance) ? binanceBalance : 0,
      availableBalance: Number.isFinite(binanceBalances.availableBalance) ? binanceBalances.availableBalance : Math.max(0, (Number(binanceBalance) || 0) - binanceUsedMargin),
      totalPositionInitialMargin: binanceUsedMargin,
      totalTradeValue: Number.isFinite(binanceTotalTradeValue) ? binanceTotalTradeValue : 0,
    };
    const bybitWallet = {
      totalWalletBalance: Number.isFinite(bybitBalance) ? bybitBalance : 0,
      availableBalance: Number.isFinite(bybitBalances.availableBalance) ? bybitBalances.availableBalance : Math.max(0, (Number(bybitBalance) || 0) - bybitUsedMargin),
      totalPositionInitialMargin: bybitUsedMargin,
      totalTradeValue: Number.isFinite(bybitTotalTradeValue) ? bybitTotalTradeValue : 0,
    };

    const logs = await FundLog.find().lean();
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    for (const log of logs) {
      if (log.status === "failed") continue;
      const amt = Number(log.amount) || 0;
      if (log.type === "deposit") totalDeposits += amt;
      if (log.type === "withdrawal") totalWithdrawals += amt;
    }

    const profit = totalCapital - OPENING_BALANCE;
    const profitPercent = (profit / OPENING_BALANCE) * 100;
    const dailyROI = (profit / OPENING_BALANCE) * 100;
    const totalCapitalINR = totalCapital * USD_TO_INR;
    const volatilityMeter = screener.getVolatilityMeter();

    console.log("[Dashboard API] Metrics requested. Balances:", { binanceBalance, bybitBalance });
    return res.json({
      success: true,
      data: {
        binanceBalance: Number.isFinite(binanceBalance) ? binanceBalance : 0,
        bybitBalance: Number.isFinite(bybitBalance) ? bybitBalance : 0,
        binanceWallet,
        bybitWallet,
        totalCapital,
        currentBalance: totalCapital,
        openingBalance: OPENING_BALANCE,
        totalDeposits,
        totalWithdrawals,
        profit,
        profitPercent: Number.isFinite(profitPercent) ? profitPercent : 0,
        dailyROI,
        totalCapitalINR,
        usdToInr: USD_TO_INR,
        volatilityMeter,
        binanceAvailableBalance: Number.isFinite(binanceAvailableBalance) ? binanceAvailableBalance : 0,
        bybitAvailableBalance: Number.isFinite(bybitAvailableBalance) ? bybitAvailableBalance : 0,
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

    const settings = await Setting.findOne().lean();
    const targetPct = parseFloat(settings?.takeProfit ?? settings?.tpPercent ?? 5);
    const stopLossPct = parseFloat(settings?.stopLoss ?? settings?.slPercent ?? 10);

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

      let binanceMark = binanceManager.getMarkPrice(symbol) ?? 0;
      let bybitMark = bybitManager.getMarkPrice(symbol) ?? 0;
      const binanceFundingRate = binanceManager.getCachedFundingRate(symbol) ?? 0;
      const bybitFundingRate = bybitManager.getCachedFundingRate(symbol) ?? 0;

      const binanceAmt = parseFloat(String(binancePos.positionAmt ?? 0)) || 0;
      const bybitAmt = parseFloat(String(bybitPos.positionAmt ?? 0)) || 0;
      const binanceQty = Math.abs(binanceAmt);
      const bybitQty = Math.abs(bybitAmt);
      const binanceEntry = parseFloat(String(binancePos.entryPrice ?? 0)) || 0;
      const bybitEntry = parseFloat(String(bybitPos.entryPrice ?? 0)) || 0;

      // Real L2 VWAP PnL: notional = |amt| * entryPrice; close price = VWAP for closing side
      let binanceUnrealized = parseFloat(String(binancePos.unrealizedProfit ?? 0)) || 0;
      let bybitUnrealized = parseFloat(String(bybitPos.unrealizedProfit ?? 0)) || 0;
      if (binanceQty > 0 && binanceEntry > 0) {
        const notionalBinance = binanceQty * binanceEntry;
        if (binanceAmt < 0) {
          const vwapClose = binanceManager.getVwapPrice(symbol, "BUY", notionalBinance);
          if (vwapClose != null) {
            binanceUnrealized = (binanceEntry - vwapClose) * binanceQty;
            binanceMark = vwapClose;
          }
        } else {
          const vwapClose = binanceManager.getVwapPrice(symbol, "SELL", notionalBinance);
          if (vwapClose != null) {
            binanceUnrealized = (vwapClose - binanceEntry) * binanceQty;
            binanceMark = vwapClose;
          }
        }
      }
      if (bybitQty > 0 && bybitEntry > 0) {
        const notionalBybit = bybitQty * bybitEntry;
        if (bybitAmt < 0) {
          const vwapClose = bybitManager.getVwapPrice(symbol, "Buy", notionalBybit);
          if (vwapClose != null) {
            bybitUnrealized = (bybitEntry - vwapClose) * bybitQty;
            bybitMark = vwapClose;
          }
        } else {
          const vwapClose = bybitManager.getVwapPrice(symbol, "Sell", notionalBybit);
          if (vwapClose != null) {
            bybitUnrealized = (vwapClose - bybitEntry) * bybitQty;
            bybitMark = vwapClose;
          }
        }
      }

      const notionalBinance = binanceQty * (Number.isFinite(binanceMark) ? binanceMark : 0);
      const notionalBybit = bybitQty * (Number.isFinite(bybitMark) ? bybitMark : 0);
      const binanceFundingDecimal = Number(binanceFundingRate) || 0;
      const bybitFundingDecimal = Number(bybitFundingRate) || 0;
      // Funding rate > 0: Longs pay Shorts (Long = loss, Short = profit). Rate < 0: Shorts pay Longs.
      const binanceIsLong = binanceAmt > 0;
      const bybitIsLong = String(bybitPos.side || "").toLowerCase() === "buy";
      const binanceNextFundingAmount = binanceIsLong
        ? notionalBinance * -binanceFundingDecimal
        : notionalBinance * binanceFundingDecimal;
      const bybitNextFundingAmount = bybitIsLong
        ? notionalBybit * -bybitFundingDecimal
        : notionalBybit * bybitFundingDecimal;
      const totalFundingIncome = binanceNextFundingAmount + bybitNextFundingAmount;
      const isFundingFlipped = totalFundingIncome < 0;
      const totalNextFundingAmount = totalFundingIncome;

      const combinedUnrealized = binanceUnrealized + bybitUnrealized;
      const combinedMargin =
        parseFloat(String(binancePos.marginUsed ?? 0)) + parseFloat(String(bybitPos.marginUsed ?? 0));
      const combinedPnlPct = combinedMargin > 0 ? (combinedUnrealized / combinedMargin) * 100 : null;
      // TP/SL amounts matching tradeMonitor: PnL% = (combinedUnrealized / combinedMargin) * 100, so trigger at targetPct/stopLossPct of margin
      const targetAmount = combinedMargin * (targetPct / 100);
      const stopLossAmount = combinedMargin * (stopLossPct / 100);

      grandTotalPnl += combinedUnrealized;
      grandTotalNextFundingAmount += totalFundingIncome;

      const token = rankedTokens.find((t) => String(t?.symbol || "").toUpperCase() === symbol);
      const nextFundingTime = token != null ? (token.nextFundingTime ?? null) : null;
      const fundingPaymentEstimate =
        nextFundingTime != null && Number.isFinite(nextFundingTime)
          ? { nextFundingTime, nextFundingTimeISO: new Date(nextFundingTime).toISOString() }
          : null;

      positions.push({
        symbol,
        isFundingFlipped,
        l2SpreadVwap: token?.l2SpreadVwap ?? null,
        screenerTradeNotional: token?.screenerTradeNotional ?? null,
        binance: {
          side: binancePos.side,
          positionSide: binancePos.positionSide,
          positionAmt: binanceAmt,
          unrealizedProfit: binanceUnrealized,
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
          unrealizedProfit: bybitUnrealized,
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
        targetAmount,
        stopLossAmount,
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
