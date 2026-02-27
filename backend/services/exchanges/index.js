const binanceManager = require("./binanceManager");
const bybitManager = require("./bybitManager");
const { getDecryptedApiKeys } = require("../apiKeys");
const vwapService = require("../vwapService");

let started = false;

const SYMBOL_FETCH_RETRIES = 3;
const SYMBOL_FETCH_RETRY_DELAY_MS = 2000;

/**
 * Fetch perpetual symbols from one exchange with optional retries.
 */
async function fetchSymbolsWithRetry(getSymbolsFn, label) {
  for (let attempt = 1; attempt <= SYMBOL_FETCH_RETRIES; attempt++) {
    try {
      const list = await getSymbolsFn();
      if (Array.isArray(list) && list.length > 0) {
        return list;
      }
    } catch (e) {
      console.warn(`[Exchanges] ${label} symbol list attempt ${attempt}/${SYMBOL_FETCH_RETRIES} failed:`, e.message);
      if (attempt < SYMBOL_FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, SYMBOL_FETCH_RETRY_DELAY_MS));
      } else {
        throw e;
      }
    }
  }
  return [];
}

/**
 * Fetch perpetual symbols from both exchanges and return intersection (symbols on both)
 * with STRICT funding interval match only. Retries each exchange independently.
 */
async function getCommonPerpetualSymbols() {
  let binanceList = [];
  let bybitList = [];
  try {
    binanceList = await fetchSymbolsWithRetry(
      () => binanceManager.getPerpetualSymbols(),
      "Binance"
    );
  } catch (e) {
    console.error("[Exchanges] Binance symbol list failed after retries:", e.message);
  }
  try {
    bybitList = await fetchSymbolsWithRetry(
      () => bybitManager.getPerpetualSymbols(),
      "Bybit"
    );
  } catch (e) {
    console.error("[Exchanges] Bybit symbol list failed after retries:", e.message);
  }

  if (binanceList.length === 0 && bybitList.length === 0) {
    console.warn("[Exchanges] No symbols from either exchange; using default BTCUSDT, ETHUSDT");
    return ["BTCUSDT", "ETHUSDT"];
  }

  // Binance funding intervals required for strict matching (populated before filtering)
  try {
    await binanceManager.syncFundingIntervals();
  } catch (e) {
    console.warn("[Exchanges] Binance funding interval sync failed:", e.message);
  }

  const bybitSet = new Set(bybitList.map((s) => String(s).toUpperCase()));
  const common = [];
  for (const sym of binanceList) {
    const s = String(sym).toUpperCase();
    if (!bybitSet.has(s)) continue;
    const binanceInterval = binanceManager.getFundingInterval(sym);
    const bybitInterval = bybitManager.getFundingInterval(sym);
    if (binanceInterval === bybitInterval) {
      common.push(sym);
    } else {
      console.log(`[Exchanges] Mismatch excluded ${sym}: Binance ${binanceInterval}h, Bybit ${bybitInterval}h`);
    }
  }
  const sorted = [...new Set(common)].sort();
  const maxSymbols = 500;
  const capped = sorted.length ? sorted.slice(0, maxSymbols) : ["BTCUSDT", "ETHUSDT"];
  console.log("[Exchanges] Common perpetual symbols (strict interval match): Binance", binanceList.length, ", Bybit", bybitList.length, ", common", sorted.length, ", tracking", capped.length);
  return capped;
}

async function startExchanges(options = {}) {
  if (started) {
    console.log("[Exchanges] Already started");
    return;
  }

  const keys = await getDecryptedApiKeys();
  const symbols = options.symbols || (await getCommonPerpetualSymbols());
  if (symbols.length === 0) {
    console.warn("[Exchanges] No symbols to track; start aborted.");
    return;
  }
  vwapService.setKnownSymbols(symbols);

  await Promise.all([
    binanceManager.start(keys.binance || null, { symbols }),
    bybitManager.start(keys.bybit || null, { symbols }),
  ]);

  started = true;
  console.log("[Exchanges] Binance and Bybit managers started, tracking", symbols.length, "symbols (funding streams for all common symbols).");
  return symbols;
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
