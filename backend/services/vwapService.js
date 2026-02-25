/**
 * VWAP / live bid-ask service.
 * Parses Binance <symbol>@bookTicker and Bybit tickers.{symbol} for live bid/ask prices.
 * Exchange managers do not currently subscribe to these streams; when they do, they can
 * call updateFromBinanceBookTicker / updateFromBybitTicker and consumers can use getBidAsk.
 *
 * Memory safety: We only overwrite existing keys in lastBidAskBySymbol, or keys in a
 * known symbol set set via setKnownSymbols(), so WS data never grows storage unbounded.
 */

const lastBidAskBySymbol = {};
/** If set, only these symbols are updated (prevents unbounded growth from arbitrary WS data). */
let knownSymbolsSet = new Set();
const MAX_BID_ASK_KEYS = 500;

/**
 * Set the allowed symbols for bid/ask updates. Call from exchanges when symbol list is loaded.
 * Only symbols in this set (or already in lastBidAskBySymbol if set is empty) will be stored.
 */
function setKnownSymbols(symbols) {
  knownSymbolsSet = new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean));
}

/**
 * Parse Binance bookTicker payload (stream: <symbol>@bookTicker or !bookTicker).
 * Fields: s (symbol), b (best bid price), B (best bid qty), a (best ask price), A (best ask qty).
 * @param {object} payload - Raw message (may be payload or data if wrapped)
 * @returns {{ symbol: string, bid: number, ask: number } | null}
 */
function parseBinanceBookTicker(payload) {
  if (!payload || !payload.s) return null;
  const symbol = String(payload.s).toUpperCase();
  const bid = parseFloat(payload.b);
  const ask = parseFloat(payload.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { symbol, bid, ask };
}

/**
 * Parse Bybit tickers.{symbol} payload (linear: bid1Price, ask1Price).
 * @param {object} data - Single ticker object from msg.data (or array item)
 * @returns {{ symbol: string, bid: number, ask: number } | null}
 */
function parseBybitTicker(data) {
  if (!data || !data.symbol) return null;
  const symbol = String(data.symbol).toUpperCase();
  const bid = parseFloat(data.bid1Price ?? data.bidPrice);
  const ask = parseFloat(data.ask1Price ?? data.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { symbol, bid, ask };
}

/**
 * Update stored bid/ask from a parsed Binance bookTicker result. Call when you receive bookTicker.
 * Only overwrites existing keys or keys in knownSymbolsSet; never grows beyond MAX_BID_ASK_KEYS.
 */
function updateFromBinanceBookTicker(payload) {
  const parsed = parseBinanceBookTicker(payload);
  if (!parsed) return;
  const sym = parsed.symbol;
  if (knownSymbolsSet.size > 0) {
    if (!knownSymbolsSet.has(sym)) return;
  } else {
    const keys = Object.keys(lastBidAskBySymbol);
    if (lastBidAskBySymbol[sym] === undefined && keys.length >= MAX_BID_ASK_KEYS) return;
  }
  lastBidAskBySymbol[sym] = { bid: parsed.bid, ask: parsed.ask, ts: Date.now() };
}

/**
 * Update stored bid/ask from a parsed Bybit ticker result. Call when you receive tickers.* data.
 * Only overwrites existing keys or keys in knownSymbolsSet; never grows beyond MAX_BID_ASK_KEYS.
 */
function updateFromBybitTicker(data) {
  const parsed = parseBybitTicker(data);
  if (!parsed) return;
  const sym = parsed.symbol;
  if (knownSymbolsSet.size > 0) {
    if (!knownSymbolsSet.has(sym)) return;
  } else {
    const keys = Object.keys(lastBidAskBySymbol);
    if (lastBidAskBySymbol[sym] === undefined && keys.length >= MAX_BID_ASK_KEYS) return;
  }
  lastBidAskBySymbol[sym] = { bid: parsed.bid, ask: parsed.ask, ts: Date.now() };
}

/**
 * Get last known bid/ask for a symbol (from bookTicker / tickers if subscriptions feed this service).
 */
function getBidAsk(symbol) {
  const sym = String(symbol || "").toUpperCase();
  return lastBidAskBySymbol[sym] || null;
}

function getLastBidAskBySymbol() {
  return { ...lastBidAskBySymbol };
}

module.exports = {
  parseBinanceBookTicker,
  parseBybitTicker,
  updateFromBinanceBookTicker,
  updateFromBybitTicker,
  getBidAsk,
  getLastBidAskBySymbol,
  setKnownSymbols,
};
