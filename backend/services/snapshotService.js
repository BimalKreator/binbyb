/**
 * Daily Opening Balance Snapshot at 00:00 IST.
 * Runs every 1 minute; takes a snapshot of total capital when the date in IST rolls to a new day.
 */

const Setting = require("../models/Setting");
const { getDecryptedApiKeys } = require("./apiKeys");
const { binanceManager, bybitManager } = require("./exchanges");

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

/** Get current date in IST as YYYY-MM-DD */
function getCurrentIstDate() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffsetMs);
  const y = istTime.getUTCFullYear();
  const m = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const d = String(istTime.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function checkAndTakeDailySnapshot() {
  try {
    const currentIstDate = getCurrentIstDate();

    let settings = await Setting.findOne();
    if (!settings) {
      settings = await Setting.create({});
    }

    if (settings.lastSnapshotDate === currentIstDate) {
      return; // Already snapped today IST
    }

    const keys = await getDecryptedApiKeys();
    let binanceRaw = 0;
    let bybitRaw = 0;
    if (keys?.binance?.apiKey && keys?.binance?.apiSecret) {
      try {
        const binanceBalances = await binanceManager.getBalances(keys.binance);
        binanceRaw = parseFloat(binanceBalances.totalMarginBalance || binanceBalances.totalWalletBalance || binanceBalances.availableBalance || 0) || 0;
      } catch (e) {
        const bin = binanceManager.getBalance(keys.binance);
        binanceRaw = Number(bin?.balance ?? bin) || 0;
      }
    }
    if (keys?.bybit?.apiKey && keys?.bybit?.apiSecret) {
      try {
        const bybitBalances = await bybitManager.getBalances(keys.bybit);
        bybitRaw = parseFloat(bybitBalances.totalEquity || bybitBalances.totalWalletBalance || bybitBalances.availableBalance || 0) || 0;
      } catch (e) {
        const byb = bybitManager.getBalance();
        bybitRaw = Number(byb?.balance ?? byb) || 0;
      }
    }
    // Use same display formula as dashboard: actual + (marginAllowedPct * 30)
    const binanceMarginAllowedPct = Number(settings.binanceMarginAllowedPct) || 50;
    const bybitMarginAllowedPct = Number(settings.bybitMarginAllowedPct) || 50;
    const binanceCapital = binanceRaw + (binanceMarginAllowedPct * 30);
    const bybitCapital = bybitRaw + (bybitMarginAllowedPct * 30);
    const totalCapital = binanceCapital + bybitCapital;

    if (totalCapital <= 0) {
      return; // Avoid resetting to 0 on API/WS cache errors
    }

    if (settings.lastSnapshotDate !== "") {
      settings.dailyOpeningBalance = totalCapital;
    }
    settings.lastSnapshotDate = currentIstDate;
    await settings.save();
    console.log(
      `[Snapshot] Daily opening balance updated to $${settings.dailyOpeningBalance.toFixed(2)} for ${currentIstDate} (IST)`
    );
  } catch (err) {
    console.error("[Snapshot] Error taking daily snapshot:", err.message);
  }
}

let intervalId = null;

function start() {
  if (intervalId) return;
  intervalId = setInterval(checkAndTakeDailySnapshot, CHECK_INTERVAL_MS);
  console.log("[Snapshot] Daily opening balance snapshot service started (check every 1 min, 00:00 IST).");
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log("[Snapshot] Service stopped.");
}

module.exports = {
  start,
  stop,
  checkAndTakeDailySnapshot,
  getCurrentIstDate,
};
