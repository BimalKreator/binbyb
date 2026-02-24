const WebSocket = require("ws");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const { logLatency } = require("./latencyTracker");

const PUBLIC_WS_URL = "wss://stream.bybit.com/v5/public/linear";
const PRIVATE_WS_URL = "wss://stream.bybit.com/v5/private";
const REST_BASE = "https://api.bybit.com";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let publicWs = null;
let privateWs = null;
let privateCredentials = null;
let pingTimer = null;

function signMessage(message, apiSecret) {
  return CryptoJS.HmacSHA256(message, apiSecret).toString(CryptoJS.enc.Hex);
}

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  publicWs = new WebSocket(PUBLIC_WS_URL);

  publicWs.on("open", () => {
    console.log("[Bybit] Public WebSocket connected");
    const args = [
      ...symbols.map((s) => `tickers.${s}`),
    ];
    publicWs.send(JSON.stringify({ op: "subscribe", args }));
  });

  publicWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.topic && msg.data) {
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const d of list) {
          const eventTime = d.timestamp ? Number(d.timestamp) : msg.ts;
          if (eventTime) logLatency("bybit", msg.topic, eventTime, { symbol: d.symbol });

          if (msg.topic.startsWith("tickers.")) {
            console.log("[Bybit] Ticker/Mark/Funding", {
              symbol: d.symbol,
              lastPrice: d.lastPrice,
              markPrice: d.markPrice,
              fundingRate: d.fundingRate,
              nextFundingTime: d.nextFundingTime,
            });
          }
        }
      } else if (msg.op === "pong" || msg.success) {
        // ping/pong or subscribe ack
      }
    } catch (e) {
      console.error("[Bybit] Public message parse error", e.message);
    }
  });

  publicWs.on("close", (code, reason) => {
    console.log("[Bybit] Public WebSocket closed", code, reason?.toString());
    publicWs = null;
  });

  publicWs.on("error", (err) => {
    console.error("[Bybit] Public WebSocket error", err.message);
  });
}

function openPrivateStream(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    console.warn("[Bybit] No API credentials, skipping private stream");
    return;
  }
  privateCredentials = credentials;

  privateWs = new WebSocket(PRIVATE_WS_URL);

  privateWs.on("open", () => {
    const expires = Date.now() + 10000;
    const message = `GET/realtime${expires}`;
    const signature = signMessage(message, credentials.apiSecret);
    privateWs.send(
      JSON.stringify({
        op: "auth",
        args: [credentials.apiKey, String(expires), signature],
      })
    );
  });

  privateWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.op === "auth" && msg.success) {
        console.log("[Bybit] Private WebSocket authenticated");
        privateWs.send(
          JSON.stringify({ op: "subscribe", args: ["wallet", "order"] })
        );
        return;
      }

      if (msg.topic && msg.data) {
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const d of list) {
          const eventTime = d.updateTime ? Number(d.updateTime) : msg.ts;
          if (eventTime) logLatency("bybit", msg.topic, eventTime);

          if (msg.topic === "wallet") {
            const accounts = d.account?.accountBalanceList || [];
            for (const a of accounts) {
              console.log("[Bybit] Balance", {
                accountType: a.accountType,
                totalEquity: a.totalEquity,
                availableBalance: a.availableBalance,
                totalWalletBalance: a.totalWalletBalance,
                totalMarginBalance: a.totalMarginBalance,
              });
            }
          } else if (msg.topic === "order") {
            console.log("[Bybit] Order update", {
              symbol: d.symbol,
              side: d.side,
              orderStatus: d.orderStatus,
              orderId: d.orderId,
              cumExecQty: d.cumExecQty,
              avgPrice: d.avgPrice,
            });
          }
        }
      }

      if (msg.op === "pong") {
        // heartbeat response
      }
    } catch (e) {
      console.error("[Bybit] Private message parse error", e.message);
    }
  });

  privateWs.on("close", (code, reason) => {
    console.log("[Bybit] Private WebSocket closed", code, reason?.toString());
    privateWs = null;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  });

  privateWs.on("error", (err) => {
    console.error("[Bybit] Private WebSocket error", err.message);
  });

  pingTimer = setInterval(() => {
    if (privateWs && privateWs.readyState === WebSocket.OPEN) {
      privateWs.send(JSON.stringify({ op: "ping" }));
    }
  }, 20000);
}

/**
 * Place an IOC limit order on Bybit V5 (linear perpetual).
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - Buy | Sell
 * @param {number} qty - quantity
 * @param {number} price - limit price
 * @param {object} [opts] - { orderLinkId, category }
 */
async function placeIOCLimitOrder(credentials, symbol, side, qty, price, opts = {}) {
  const timestamp = Date.now();
  const recvWindow = 5000;
  const body = {
    category: "linear",
    symbol: symbol.toUpperCase(),
    side: side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(),
    orderType: "Limit",
    qty: String(qty),
    price: String(price),
    timeInForce: "IOC",
    ...opts,
  };
  const rawBody = JSON.stringify(body);
  const message = `${timestamp}${credentials.apiKey}${recvWindow}${rawBody}`;
  const signature = signMessage(message, credentials.apiSecret);

  const res = await axios.post(`${REST_BASE}/v5/order/create`, body, {
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": String(recvWindow),
    },
  });
  return res.data;
}

function stop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (privateWs) {
    privateWs.close();
    privateWs = null;
  }
  if (publicWs) {
    publicWs.close();
    publicWs = null;
  }
  privateCredentials = null;
  console.log("[Bybit] Manager stopped");
}

function start(credentials, options = {}) {
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  openPrivateStream(credentials);
}

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  getCredentials: () => privateCredentials,
};
