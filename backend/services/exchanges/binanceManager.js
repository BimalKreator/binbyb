const WebSocket = require("ws");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const { logLatency } = require("./latencyTracker");

const PUBLIC_WS_BASE = "wss://fstream.binance.com";
const REST_BASE = "https://fapi.binance.com";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let onFundingUpdate = null;
function setOnFundingUpdate(fn) {
  onFundingUpdate = fn;
}

let publicWs = null;
let privateWs = null;
let listenKey = null;
let privateCredentials = null;
let listenKeyKeepaliveTimer = null;

function signQueryString(queryString, apiSecret) {
  return CryptoJS.HmacSHA256(queryString, apiSecret).toString(CryptoJS.enc.Hex);
}

const MAX_STREAMS_PER_CONNECTION = 1024;

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  const list = symbols.slice(0, MAX_STREAMS_PER_CONNECTION);
  const streams = list.map((s) => `${s.toLowerCase()}@markPrice@1s`);
  const url = `${PUBLIC_WS_BASE}/stream?streams=${streams.join("/")}`;

  publicWs = new WebSocket(url);

  publicWs.on("open", () => {
    console.log("[Binance] Public WebSocket connected");
  });

  publicWs.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString());
      const stream = raw.stream || "";
      const payload = raw.data || raw;

      if (payload.E) {
        logLatency("binance", stream || payload.e || "public", payload.E, { s: payload.s });
      }

      if (payload.e === "markPriceUpdate") {
        // Mark price + funding rate
        const { s, p, r, T, E } = payload;
        if (onFundingUpdate && s) {
          onFundingUpdate({
            symbol: s,
            fundingRate: parseFloat(r),
            nextFundingTime: T,
            markPrice: parseFloat(p),
            eventTime: E,
          });
        }
        console.log("[Binance] MarkPrice", { symbol: s, markPrice: p, fundingRate: r, nextFunding: T });
      }
    } catch (e) {
      console.error("[Binance] Public message parse error", e.message);
    }
  });

  publicWs.on("close", (code, reason) => {
    console.log("[Binance] Public WebSocket closed", code, reason?.toString());
    publicWs = null;
  });

  publicWs.on("error", (err) => {
    console.error("[Binance] Public WebSocket error", err.message);
  });
}

async function startPrivateStream(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    console.warn("[Binance] No API credentials, skipping private stream");
    return;
  }
  privateCredentials = credentials;

  try {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signQueryString(query, credentials.apiSecret);
    const res = await axios.post(
      `${REST_BASE}/fapi/v1/listenKey`,
      null,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      }
    );
    listenKey = res.data.listenKey;
  } catch (e) {
    console.error("[Binance] Failed to get listenKey", e.response?.data || e.message);
    return;
  }

  const url = `${PUBLIC_WS_BASE}/ws/${listenKey}`;
  privateWs = new WebSocket(url);

  privateWs.on("open", () => {
    console.log("[Binance] Private (user) WebSocket connected");
  });

  privateWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.E) logLatency("binance", "user", msg.E, { e: msg.e });

      if (msg.e === "ACCOUNT_UPDATE") {
        const balances = msg.a?.B || [];
        for (const b of balances) {
          console.log("[Binance] Balance", {
            asset: b.a,
            walletBalance: b.wb,
            crossWalletBalance: b.cw,
            available: b.bc || b.b,
          });
        }
      } else if (msg.e === "ORDER_TRADE_UPDATE") {
        const o = msg.o || {};
        console.log("[Binance] Order update", {
          symbol: o.s,
          side: o.S,
          status: o.X,
          orderId: o.i,
          filled: o.z,
          avgPrice: o.ap,
        });
      }
    } catch (e) {
      console.error("[Binance] Private message parse error", e.message);
    }
  });

  privateWs.on("close", (code, reason) => {
    console.log("[Binance] Private WebSocket closed", code, reason?.toString());
    privateWs = null;
    if (listenKeyKeepaliveTimer) {
      clearInterval(listenKeyKeepaliveTimer);
      listenKeyKeepaliveTimer = null;
    }
  });

  privateWs.on("error", (err) => {
    console.error("[Binance] Private WebSocket error", err.message);
  });

  listenKeyKeepaliveTimer = setInterval(async () => {
    if (!privateCredentials || !listenKey) return;
    try {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = signQueryString(query, privateCredentials.apiSecret);
      await axios.put(`${REST_BASE}/fapi/v1/listenKey`, null, {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": privateCredentials.apiKey },
      });
    } catch (e) {
      console.error("[Binance] ListenKey keepalive failed", e.message);
    }
  }, 60 * 1000);
}

/**
 * Place an IOC limit order on Binance USDT-M Futures.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - BUY | SELL
 * @param {number} quantity - in base/contracts
 * @param {number} price - limit price
 * @param {object} [opts] - { newClientOrderId, positionSide }
 */
async function placeIOCLimitOrder(credentials, symbol, side, quantity, price, opts = {}) {
  const timestamp = Date.now();
  const params = {
    symbol: symbol.toUpperCase(),
    side: side.toUpperCase(),
    type: "LIMIT",
    timeInForce: "IOC",
    quantity: String(quantity),
    price: String(price),
    timestamp,
    ...opts,
  };
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  params.signature = signature;

  const res = await axios.post(`${REST_BASE}/fapi/v1/order`, null, {
    params,
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
  return res.data;
}

function stop() {
  if (listenKeyKeepaliveTimer) {
    clearInterval(listenKeyKeepaliveTimer);
    listenKeyKeepaliveTimer = null;
  }
  if (privateWs) {
    privateWs.close();
    privateWs = null;
  }
  if (publicWs) {
    publicWs.close();
    publicWs = null;
  }
  listenKey = null;
  privateCredentials = null;
  console.log("[Binance] Manager stopped");
}

async function start(credentials, options = {}) {
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  await startPrivateStream(credentials);
}

/**
 * Fetch last funding time (ms) for interval calculation. Public endpoint.
 */
async function getLastFundingTime(symbol) {
  const { data } = await axios.get(`${REST_BASE}/fapi/v1/fundingRate`, {
    params: { symbol: symbol.toUpperCase(), limit: 1 },
  });
  const item = Array.isArray(data) && data.length ? data[0] : null;
  return item ? item.fundingTime : null;
}

/**
 * Fetch max leverage for symbol. Public endpoint.
 */
async function getMaxLeverage(symbol) {
  const { data } = await axios.get(`${REST_BASE}/fapi/v1/leverageBracket`, {
    params: { symbol: symbol.toUpperCase() },
  });
  const brackets = data && data[0] && data[0].brackets;
  if (!brackets || !brackets.length) return null;
  const maxLev = Math.max(...brackets.map((b) => b.initialLeverage));
  return maxLev;
}

/**
 * Fetch all USDT-margined perpetual symbols from Exchange Info. Public endpoint.
 * @returns {Promise<string[]>} e.g. ["BTCUSDT", "ETHUSDT", ...]
 */
async function getPerpetualSymbols() {
  const { data } = await axios.get(`${REST_BASE}/fapi/v1/exchangeInfo`);
  const symbols = (data && data.symbols) || [];
  return symbols
    .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map((s) => s.symbol);
}

/** Cache for funding interval hours by symbol (from REST fundingInfo). */
let fundingIntervalCache = {};

/**
 * Fetch funding interval hours from REST GET /fapi/v1/fundingInfo. Public endpoint.
 * Returns 1, 2, 4, or 8; null if not found or API error.
 */
async function getFundingIntervalHours(symbol) {
  if (fundingIntervalCache[symbol] != null) return fundingIntervalCache[symbol];
  try {
    const { data } = await axios.get(`${REST_BASE}/fapi/v1/fundingInfo`);
    const list = Array.isArray(data) ? data : [];
    const item = list.find((s) => (s.symbol || "").toUpperCase() === String(symbol).toUpperCase());
    const hours = item?.fundingIntervalHours;
    const h = hours != null ? Number(hours) : null;
    if (h === 1 || h === 2 || h === 4 || h === 8) {
      fundingIntervalCache[symbol] = h;
      return h;
    }
    if (Number.isFinite(h) && h > 0) {
      const bucket = h <= 1 ? 1 : h <= 2 ? 2 : h <= 4 ? 4 : 8;
      fundingIntervalCache[symbol] = bucket;
      return bucket;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  getCredentials: () => privateCredentials,
  setOnFundingUpdate,
  getLastFundingTime,
  getMaxLeverage,
  getPerpetualSymbols,
  getFundingIntervalHours,
};
