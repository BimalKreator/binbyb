const binanceManager = require("./binanceManager");
const bybitManager = require("./bybitManager");
const { getDecryptedApiKeys } = require("../apiKeys");

let started = false;

async function startExchanges(options = {}) {
  if (started) {
    console.log("[Exchanges] Already started");
    return;
  }

  const keys = await getDecryptedApiKeys();
  const symbols = options.symbols || ["BTCUSDT", "ETHUSDT"];

  binanceManager.start(keys.binance || null, { symbols });
  bybitManager.start(keys.bybit || null, { symbols });

  started = true;
  console.log("[Exchanges] Binance and Bybit managers started");
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
