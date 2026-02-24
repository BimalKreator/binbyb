const binanceManager = require("./binanceManager");
const bybitManager = require("./bybitManager");
const { getDecryptedApiKeys } = require("../apiKeys");

let started = false;

/**
 * Fetch perpetual symbols from both exchanges and return intersection (symbols on both).
 */
async function getCommonPerpetualSymbols() {
  let binanceList = [];
  let bybitList = [];
  try {
    [binanceList, bybitList] = await Promise.all([
      binanceManager.getPerpetualSymbols(),
      bybitManager.getPerpetualSymbols(),
    ]);
  } catch (e) {
    console.error("[Exchanges] Failed to fetch symbol lists:", e.message);
    return ["BTCUSDT", "ETHUSDT"];
  }
  const bybitSet = new Set(bybitList.map((s) => s.toUpperCase()));
  const common = binanceList.filter((s) => bybitSet.has(s.toUpperCase()));
  const sorted = [...new Set(common)].sort();
  const maxSymbols = 500;
  const capped = sorted.length ? sorted.slice(0, maxSymbols) : ["BTCUSDT", "ETHUSDT"];
  console.log("[Exchanges] Common perpetual symbols:", binanceList.length, "Binance,", bybitList.length, "Bybit,", sorted.length, "common, tracking", capped.length);
  return capped;
}

async function startExchanges(options = {}) {
  if (started) {
    console.log("[Exchanges] Already started");
    return;
  }

  const keys = await getDecryptedApiKeys();
  const symbols = options.symbols || (await getCommonPerpetualSymbols());

  binanceManager.start(keys.binance || null, { symbols });
  bybitManager.start(keys.bybit || null, { symbols });

  started = true;
  console.log("[Exchanges] Binance and Bybit managers started, tracking", symbols.length, "symbols");
}

function stopExchanges() {
  binanceManager.stop();
  bybitManager.stop();
  started = false;
  console.log("[Exchanges] All managers stopped");
}

module.exports = {
  startExchanges,
  stopExchanges,
  binanceManager,
  bybitManager,
};
