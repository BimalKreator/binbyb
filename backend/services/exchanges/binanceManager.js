const WebSocket = require("ws");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const { logLatency } = require("./latencyTracker");

const PUBLIC_WS_BASE = "wss://fstream.binance.com";
const REST_BASE = "https://fapi.binance.com";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let publicWs = null;
let privateWs = null;
let listenKey = null;
let privateCredentials = null;
let listenKeyKeepaliveTimer = null;

function signQueryString(queryString, apiSecret) {
  return CryptoJS.HmacSHA256(queryString, apiSecret).toString(CryptoJS.enc.Hex);
}

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  const streams = [
    ...symbols.map((s) => `${s.toLowerCase()}@markPrice@1s`),
    ...symbols.map((s) => `${s.toLowerCase()}@ticker`),
  ];
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
        console.log("[Binance] MarkPrice", { symbol: s, markPrice: p, fundingRate: r, nextFunding: T });
      } else if (payload.e === "24hrTicker") {
        const { s, c, p, P, E } = payload;
        console.log("[Binance] Ticker", { symbol: s, last: c, change: p, changePercent: P });
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

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  getCredentials: () => privateCredentials,
};
