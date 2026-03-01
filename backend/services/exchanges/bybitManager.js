const WebSocket = require("ws");
const axios = require("axios");
axios.defaults.family = 4;
axios.interceptors.request.use((request) => {
  console.log(`[REST API TRACKER] ${request.method.toUpperCase()} ${request.baseURL || ""}${request.url}`);
  return request;
});
/** Dedicated instance for authenticated private calls only; public market data uses axios. */
const bybitPrivateAxios = axios.create();
bybitPrivateAxios.defaults.family = 4;
const CryptoJS = require("crypto-js");
const { formatMs, logLatency } = require("./latencyTracker");

const PUBLIC_WS_URL = "wss://stream.bybit.com/v5/public/linear";
const PRIVATE_WS_URL = "wss://stream.bybit.com/v5/private";
const TRADE_WS_URL = "wss://stream.bybit.com/v5/trade";
const REST_BASE = "https://api.bybit.com";
const PLACE_WS_ORDER_TIMEOUT_MS = 15000;

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let onFundingUpdate = null;
function setOnFundingUpdate(fn) {
  onFundingUpdate = fn;
}
/** Called on every mark price tick (no throttle). (symbol, markPrice, 'bybit') */
let onMarkPriceUpdate = null;
function setOnMarkPriceUpdate(fn) {
  onMarkPriceUpdate = fn;
}
let onPositionUpdate = null;
function setOnPositionUpdate(fn) {
  onPositionUpdate = fn;
}
let onPositionClosed = null;
function setOnPositionClosed(fn) {
  onPositionClosed = fn;
}

let publicWsArray = [];
let privateWs = null;
let tradeWs = null;
let privateCredentials = null;
let tradeWsCredentials = null;
let pingTimer = null;
let tradeWsReconnectAttempts = 0;
let tradeWsReconnectTimer = null;
let privateReconnectAttempts = 0;
let privateReconnectTimer = null;
const livePositionsByKey = {};
/** USDT wallet balance/equity from private WS wallet topic. No REST in getBalance(). */
let cachedWalletBalance = 0;
/** Pending WS trade requests: reqId -> { resolve, reject, timeoutId } */
const pendingRequests = new Map();
let tradeWsConnectPromise = null;
const TRADE_WS_PING_INTERVAL_MS = 20000;
let tradeWsPingTimer = null;

function getLivePositions() {
  return Object.values(livePositionsByKey);
}

function emitPositionUpdate() {
  if (typeof onPositionUpdate === "function") {
    onPositionUpdate(getLivePositions());
  }
}

function upsertLivePosition(raw) {
  const sym = String(raw?.symbol || "").toUpperCase();
  if (!sym) return;
  const sideRaw = String(raw?.side || "").toLowerCase();
  const side = sideRaw === "buy" ? "Buy" : sideRaw === "sell" ? "Sell" : "";
  const idx = raw?.positionIdx != null ? String(raw.positionIdx) : "0";
  const key = `${sym}:${side || "NONE"}:${idx}`;
  const existing = livePositionsByKey[key];
  // Bybit sends delta updates: when size is present, strictly overwrite local size/positionAmt
  const rawSize = raw?.size;
  const size =
    rawSize !== undefined
      ? parseFloat(rawSize)
      : existing != null
        ? parseFloat(existing.positionAmt ?? existing.size ?? 0)
        : NaN;
  if (!Number.isFinite(size) || Math.abs(size) <= 0) {
    delete livePositionsByKey[key];
    if (typeof onPositionClosed === "function") onPositionClosed(sym, "bybit");
    return;
  }
  const now = Date.now();
  const rawEntry = raw?.avgPrice ?? raw?.entryPrice;
  const entryPrice = rawEntry != null ? parseFloat(rawEntry) : (existing?.entryPrice ?? null);
  const rawPnl = raw?.unrealisedPnl;
  const unrealizedProfit = rawPnl != null ? parseFloat(rawPnl) : (existing?.unrealizedProfit ?? 0);
  const rawIM = raw?.positionIM ?? raw?.positionIMByMp;
  const marginUsed = rawIM != null ? parseFloat(rawIM) : (existing?.marginUsed ?? 0);
  const rawLev = raw?.leverage;
  const leverage = rawLev != null ? Number(rawLev) : (existing?.leverage ?? null);
  const rawLiq = raw?.liqPrice ?? raw?.liquidationPrice;
  const liquidationPrice = rawLiq != null ? parseFloat(rawLiq) : (existing?.liquidationPrice ?? null);
  const sizeNum = Number(size);
  livePositionsByKey[key] = {
    symbol: sym,
    unrealizedProfit: Number.isFinite(unrealizedProfit) ? unrealizedProfit : 0,
    marginUsed: Number.isFinite(marginUsed) ? marginUsed : 0,
    size: sizeNum,
    positionAmt: sizeNum,
    side: side || existing?.side || "Sell",
    entryPrice: entryPrice != null && Number.isFinite(entryPrice) ? entryPrice : null,
    leverage: leverage != null && Number.isFinite(leverage) ? leverage : null,
    liquidationPrice: liquidationPrice != null && Number.isFinite(liquidationPrice) ? liquidationPrice : null,
    createdTime: existing?.createdTime ?? now,
    updatedTime: now,
  };
}

function signMessage(message, apiSecret) {
  return CryptoJS.HmacSHA256(message, apiSecret).toString(CryptoJS.enc.Hex);
}

/**
 * Ensure WebSocket connection to v5/trade for order placement (order.create).
 * Separate from v5/private (wallet/order/position subscriptions). Authenticates with same auth as private.
 */
function connectTradeWs(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    return Promise.reject(new Error("Bybit trade WS requires API credentials"));
  }
  tradeWsCredentials = credentials;
  if (tradeWs && tradeWs.readyState === WebSocket.OPEN) return Promise.resolve();
  if (tradeWsConnectPromise) return tradeWsConnectPromise;
  if (tradeWs) {
    tradeWs.removeAllListeners?.();
    tradeWs.close();
    tradeWs = null;
  }
  tradeWsConnectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(TRADE_WS_URL, { family: 4 });
    tradeWs = ws;
    ws.on("open", () => {
      const expires = Date.now() + 10000;
      const message = `GET/realtime${expires}`;
      const signature = signMessage(message, credentials.apiSecret);
      ws.send(
        JSON.stringify({
          op: "auth",
          args: [credentials.apiKey, String(expires), signature],
        })
      );
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.op === "auth") {
          if (msg.retCode === 0) {
            tradeWsReconnectAttempts = 0;
            console.log("[Bybit] Trade WebSocket authenticated");
            tradeWsConnectPromise = null;
            if (tradeWsPingTimer) clearInterval(tradeWsPingTimer);
            tradeWsPingTimer = setInterval(() => {
              if (tradeWs && tradeWs.readyState === WebSocket.OPEN) {
                try {
                  tradeWs.send(JSON.stringify({ op: "ping" }));
                } catch (e) {
                  // ignore
                }
              }
            }, TRADE_WS_PING_INTERVAL_MS);
            resolve();
          } else {
            tradeWsConnectPromise = null;
            reject(new Error(msg.retMsg || "Trade WS auth failed"));
          }
          return;
        }

        if (msg.op === "order.create" && msg.reqId != null && pendingRequests.has(msg.reqId)) {
          const pending = pendingRequests.get(msg.reqId);
          pendingRequests.delete(msg.reqId);
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          if (msg.retCode === 0) {
            pending.resolve(msg.data || msg);
          } else {
            const err = new Error(msg.retMsg || "order.create failed");
            err.retCode = msg.retCode;
            err.response = { data: msg };
            pending.reject(err);
          }
        }
      } catch (err) {
        console.error("[Bybit-WS-Error]", err.message);
      }
    });
    ws.on("close", (code, reason) => {
      if (tradeWsPingTimer) {
        clearInterval(tradeWsPingTimer);
        tradeWsPingTimer = null;
      }
      console.log("[Bybit] Trade WebSocket closed", code, reason?.toString());
      tradeWs = null;
      tradeWsConnectPromise = null;
      for (const [reqId, pending] of pendingRequests) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pending.reject(new Error("Trade WS connection closed"));
      }
      pendingRequests.clear();
      if (tradeWsCredentials) scheduleTradeWsReconnect();
    });
    ws.on("error", (err) => {
      console.error("[Bybit] Trade WebSocket error", err.message);
      tradeWs = null;
      tradeWsConnectPromise = null;
      reject(err);
      if (tradeWsCredentials) scheduleTradeWsReconnect();
    });
  });
  return tradeWsConnectPromise;
}

/**
 * Place an IOC limit order via Trade WebSocket (order.create).
 * Returns a Promise that resolves with the response data (orderId, orderLinkId, etc.) or rejects on error.
 */
async function placeWSOrder(credentials, symbol, side, qty, price, opts = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  if (sideNorm !== "Buy" && sideNorm !== "Sell") {
    throw new Error("side must be Buy or Sell");
  }
  await connectTradeWs(credentials);

  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(qty, filters.stepSize)
    : String(qty);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);

  const timestamp = Date.now();
  const recvWindow = 5000;
  const args = [
    {
      category: "linear",
      symbol: sym,
      side: sideNorm,
      orderType: "Limit",
      qty: qtyStr,
      price: priceStr,
      timeInForce: "IOC",
      ...opts,
    },
  ];
  const rawBody = JSON.stringify(args[0]);
  const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${rawBody}`;
  const signature = signMessage(signStr, credentials.apiSecret);

  const reqId = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    reqId,
    header: {
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": String(recvWindow),
      "X-BAPI-SIGN": signature,
    },
    op: "order.create",
    args,
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        reject(new Error("placeWSOrder timeout"));
      }
    }, PLACE_WS_ORDER_TIMEOUT_MS);
    pendingRequests.set(reqId, { resolve, reject, timeoutId });
    try {
      tradeWs.send(JSON.stringify(payload));
    } catch (e) {
      pendingRequests.delete(reqId);
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

/**
 * Build the exact stringified JSON payload for an IOC limit order. Sync only: no async, REST, or DB.
 * Uses in-memory bybitSymbolFiltersCache for stepSize/tickSize; call ensureInstrumentsLoaded first.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - Buy | Sell
 * @param {number} quantity - in base/contracts
 * @param {number} price - limit price
 * @param {object} [options] - optional overrides for args (e.g. orderLinkId)
 * @returns {string} JSON string to send over WS
 */
function prepareOrderPayload(credentials, symbol, side, quantity, price, options = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  if (sideNorm !== "Buy" && sideNorm !== "Sell") {
    throw new Error("side must be Buy or Sell");
  }
  const filters = bybitSymbolFiltersCache[sym] || {};
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(quantity, filters.stepSize)
    : String(quantity);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);

  const timestamp = Date.now();
  const recvWindow = 5000;
  const args = [
    {
      category: "linear",
      symbol: sym,
      side: sideNorm,
      orderType: "Limit",
      qty: qtyStr,
      price: priceStr,
      timeInForce: "IOC",
      ...options,
    },
  ];
  const rawBody = JSON.stringify(args[0]);
  const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${rawBody}`;
  const signature = signMessage(signStr, credentials.apiSecret);

  const reqId = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    reqId,
    header: {
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": String(recvWindow),
      "X-BAPI-SIGN": signature,
    },
    op: "order.create",
    args,
  };

  return JSON.stringify(payload);
}

/**
 * Fire-and-forget: send pre-computed order payload over Trade WS. No await, no Promise.
 * @param {string} preComputedJsonPayload - result of prepareOrderPayload()
 */
function executeWSTrade(preComputedJsonPayload) {
  if (tradeWs && tradeWs.readyState === WebSocket.OPEN) {
    tradeWs.send(preComputedJsonPayload);
  }
}

/**
 * Send pre-computed order payload over Trade WS and wait for the response by matching reqId in incoming messages.
 * Resolves with the order result (cumExecQty, orderId, etc.); rejects on error or timeout. No REST.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} preComputedJsonPayload - result of prepareOrderPayload()
 * @returns {Promise<object>} result from WS response (e.g. { cumExecQty, orderId, ... })
 */
function sendOrderPayloadAndWaitResponse(credentials, preComputedJsonPayload) {
  let payload;
  try {
    payload = JSON.parse(preComputedJsonPayload);
  } catch (e) {
    return Promise.reject(new Error("Invalid order payload JSON"));
  }
  const reqId = payload?.reqId;
  if (!reqId) {
    return Promise.reject(new Error("Order payload missing reqId"));
  }
  return new Promise((resolve, reject) => {
    connectTradeWs(credentials)
      .then(() => {
        const timeoutId = setTimeout(() => {
          if (pendingRequests.has(reqId)) {
            pendingRequests.delete(reqId);
            reject(new Error("sendOrderPayloadAndWaitResponse timeout"));
          }
        }, PLACE_WS_ORDER_TIMEOUT_MS);
        pendingRequests.set(reqId, { resolve, reject, timeoutId });
        try {
          tradeWs.send(preComputedJsonPayload);
        } catch (e) {
          pendingRequests.delete(reqId);
          clearTimeout(timeoutId);
          reject(e);
        }
      })
      .catch(reject);
  });
}

const FUNDING_THROTTLE_MS = 500;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let publicStreamSymbols = DEFAULT_SYMBOLS;
let publicReconnectAttempts = 0;
let publicReconnectTimer = null;
let publicStopped = false;
/** Throttle funding emits per symbol; only overwrites keys (no .push), prevents memory growth. */
const lastFundingEmitBySymbol = {};
/** markPrice per symbol from public tickers (for getOrderbookPrice without REST). */
const lastMarkPriceBySymbol = {};
/** Merged ticker state per symbol (snapshot + delta) so markPrice is never lost on delta-only updates. */
const tickerStateBySymbol = {};
/** Funding rate and nextFundingTime from public tickers stream. No REST /funding/history. */
const cachedFundingRates = {};

function schedulePublicReconnect() {
  if (publicStopped || publicReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, publicReconnectAttempts), RECONNECT_MAX_MS);
  publicReconnectAttempts += 1;
  console.log("[Bybit] Public WebSocket reconnecting in", delay, "ms (attempt", publicReconnectAttempts, ")");
  publicReconnectTimer = setTimeout(() => {
    publicReconnectTimer = null;
    openPublicStreams(publicStreamSymbols);
  }, delay);
}

function scheduleTradeWsReconnect() {
  if (!tradeWsCredentials || tradeWsReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, tradeWsReconnectAttempts), RECONNECT_MAX_MS);
  tradeWsReconnectAttempts += 1;
  console.log("[Bybit] Trade WebSocket reconnecting in", delay, "ms (attempt", tradeWsReconnectAttempts, ")");
  tradeWsReconnectTimer = setTimeout(() => {
    tradeWsReconnectTimer = null;
    connectTradeWs(tradeWsCredentials);
  }, delay);
}

function schedulePrivateReconnect() {
  if (!privateCredentials || privateReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, privateReconnectAttempts), RECONNECT_MAX_MS);
  privateReconnectAttempts += 1;
  console.log("[Bybit] Private WebSocket reconnecting in", delay, "ms (attempt", privateReconnectAttempts, ")");
  privateReconnectTimer = setTimeout(() => {
    privateReconnectTimer = null;
    openPrivateStream(privateCredentials);
  }, delay);
}

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicStopped) return;

  publicWsArray.forEach((ws) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.removeAllListeners?.();
      ws.close();
    }
  });
  publicWsArray = [];
  publicStreamSymbols = symbols;

  const MAX_TOPICS_PER_CONN = 300;
  for (let i = 0; i < symbols.length; i += MAX_TOPICS_PER_CONN) {
    const symbolChunk = symbols.slice(i, i + MAX_TOPICS_PER_CONN);
    const chunkIndex = Math.floor(i / MAX_TOPICS_PER_CONN);
    connectBybitPublicChunk(symbolChunk, chunkIndex);
  }
}

function connectBybitPublicChunk(symbolsChunk, chunkIndex) {
  const ws = new WebSocket(PUBLIC_WS_URL, { family: 4 });
  publicWsArray.push(ws);

  ws.on("open", async () => {
    publicReconnectAttempts = 0;
    console.log(`[Bybit] Public WS [Chunk ${chunkIndex}] connected. Subscribing to ${symbolsChunk.length} symbols...`);

    const subscribe_args = symbolsChunk.map((s) => `tickers.${s}`);
    const chunkSize = 10;
    for (let i = 0; i < subscribe_args.length; i += chunkSize) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const chunk = subscribe_args.slice(i, i + chunkSize);
      ws.send(JSON.stringify({ op: "subscribe", args: chunk }));
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.topic && msg.data) {
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const d of list) {
          const eventTime = d.timestamp ? Number(d.timestamp) : msg.ts;
          if (eventTime) logLatency("bybit", msg.topic, eventTime, { symbol: d.symbol });

          if (msg.topic.startsWith("tickers.") && d.symbol) {
            const sym = String(d.symbol).toUpperCase();
            if (msg.type === "snapshot") {
              tickerStateBySymbol[sym] = { ...d };
            } else if (msg.type === "delta") {
              if (!tickerStateBySymbol[sym]) tickerStateBySymbol[sym] = {};
              const merged = { ...tickerStateBySymbol[sym] };
              Object.keys(d).forEach((k) => {
                if (d[k] != null && d[k] !== "") merged[k] = d[k];
              });
              tickerStateBySymbol[sym] = merged;
            } else {
              tickerStateBySymbol[sym] = { ...d };
            }
            const state = tickerStateBySymbol[sym];
            const mp =
              state && state.markPrice != null && state.markPrice !== ""
                ? parseFloat(state.markPrice)
                : state && state.lastPrice != null && state.lastPrice !== ""
                  ? parseFloat(state.lastPrice)
                  : NaN;
            if (Number.isFinite(mp) && mp > 0) lastMarkPriceBySymbol[sym] = mp;
            if (onMarkPriceUpdate && Number.isFinite(mp) && mp > 0) {
              try {
                onMarkPriceUpdate(sym, mp, "bybit");
              } catch (e) {
                console.error("[Bybit-WS-Error] onMarkPriceUpdate", e.message);
              }
            }
            cachedFundingRates[sym] = {
              fundingRate: Number.isFinite(parseFloat((state?.fundingRate ?? d.fundingRate) || 0)) ? parseFloat((state?.fundingRate ?? d.fundingRate) || 0) : 0,
              nextFundingTime: ((state?.nextFundingTime ?? d.nextFundingTime) != null) ? Number(state?.nextFundingTime ?? d.nextFundingTime) : null,
            };
            if (!onFundingUpdate) continue;
            const now = Date.now();
            const last = lastFundingEmitBySymbol[sym];
            if (last != null && now - last < FUNDING_THROTTLE_MS) continue;
            lastFundingEmitBySymbol[sym] = now;
            onFundingUpdate({
              symbol: d.symbol,
              fundingRate: parseFloat((state?.fundingRate ?? d.fundingRate) || 0),
              nextFundingTime: ((state?.nextFundingTime ?? d.nextFundingTime) != null) ? Number(state?.nextFundingTime ?? d.nextFundingTime) : null,
              markPrice: mp,
              eventTime: (state?.timestamp ?? d.timestamp) ? Number(state?.timestamp ?? d.timestamp) : msg.ts,
            });
          }
        }
      } else if (msg.op === "pong" || msg.success) {
        // ping/pong or subscribe ack
      }
    } catch (e) {
      console.error(`[Bybit] Public chunk ${chunkIndex} message parse error`, e.message);
    }
  });

  ws.on("close", (code, reason) => {
    ws.removeAllListeners?.();
    publicWsArray = publicWsArray.filter((w) => w !== ws);
    console.log(`[Bybit] Public WS [Chunk ${chunkIndex}] closed`, code, reason?.toString());
    if (!publicStopped && publicWsArray.length === 0) schedulePublicReconnect();
  });

  ws.on("error", (err) => {
    console.error(`[Bybit] Public WS [Chunk ${chunkIndex}] error`, err.message);
  });
}

function openPrivateStream(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    console.warn("[Bybit] No API credentials, skipping private stream");
    return;
  }
  privateCredentials = credentials;

  privateWs = new WebSocket(PRIVATE_WS_URL, { family: 4 });

  privateWs.on("open", () => {
    privateReconnectAttempts = 0;
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
          JSON.stringify({ op: "subscribe", args: ["wallet", "order", "position"] })
        );
        return;
      }

      if (msg.topic && msg.data) {
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const d of list) {
          const eventTime = d.updateTime ? Number(d.updateTime) : msg.ts;
          if (eventTime) logLatency("bybit", msg.topic, eventTime);

          if (msg.topic === "wallet") {
            const coins = d.coin || [];
            const usdt = coins.find((c) => (c.coin || "").toUpperCase() === "USDT");
            if (usdt) cachedWalletBalance = parseFloat(usdt.equity ?? usdt.walletBalance ?? 0) || 0;
          } else if (msg.topic === "order") {
            console.log("[Bybit] Order update", {
              symbol: d.symbol,
              side: d.side,
              orderStatus: d.orderStatus,
              orderId: d.orderId,
              cumExecQty: d.cumExecQty,
              avgPrice: d.avgPrice,
              execTime: formatMs(d.updatedTime ?? msg.ts),
            });
          } else if (msg.topic === "position") {
            if (parseFloat(d.size) === 0) {
              const sym = String(d?.symbol || "").toUpperCase();
              if (sym) {
                Object.keys(livePositionsByKey).forEach((key) => {
                  if (key.startsWith(sym + ":")) delete livePositionsByKey[key];
                });
              }
            } else {
              upsertLivePosition(d);
            }
          }
        }
        if (msg.topic === "position") emitPositionUpdate();
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
    if (privateCredentials) schedulePrivateReconnect();
  });

  privateWs.on("error", (err) => {
    console.error("[Bybit] Private WebSocket error", err.message);
    if (privateCredentials) schedulePrivateReconnect();
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
/** Global cache: one-time REST fetch at startup. No per-symbol REST. */
let cachedInstrumentsInfo = [];
/** symbol -> instrument for fast lookup. */
let instrumentsBySymbol = {};
let instrumentsLoadPromise = null;

/**
 * One-time load: single batch GET /v5/market/instruments-info?category=linear (paginated once at startup).
 * Fills cachedInstrumentsInfo and instrumentsBySymbol. Never loop REST per symbol.
 */
async function ensureInstrumentsLoaded() {
  if (cachedInstrumentsInfo.length > 0) return;
  if (instrumentsLoadPromise) return instrumentsLoadPromise;
  instrumentsLoadPromise = (async () => {
    try {
      const all = [];
      let cursor;
      do {
        const params = { category: "linear", limit: 500 };
        if (cursor) params.cursor = cursor;
        const { data } = await axios.get(`${REST_BASE}/v5/market/instruments-info`, { params });
        const list = data?.result?.list || [];
        all.push(...list);
        cursor = data?.result?.nextPageCursor || null;
      } while (cursor);
      cachedInstrumentsInfo = all;
      instrumentsBySymbol = {};
      for (const item of all) {
        const s = (item.symbol || "").toUpperCase();
        if (!s) continue;
        // Bybit returns fundingInterval in minutes (e.g., 240 for 4h, 60 for 1h)
        const intervalMinutes = parseInt(item.fundingInterval, 10) || 480;
        item.fundingIntervalHours = intervalMinutes / 60;
        instrumentsBySymbol[s] = item;
      }
      console.log("[Bybit] One-time instruments-info loaded:", cachedInstrumentsInfo.length, "instruments");
    } catch (e) {
      console.warn("[Bybit] One-time instruments-info load failed", e.message);
    } finally {
      instrumentsLoadPromise = null;
    }
  })();
  return instrumentsLoadPromise;
}

/** Cache symbol filters (qtyStep, tickSize) from cachedInstrumentsInfo. */
let bybitSymbolFiltersCache = {};

function decimalsFromStep(stepSize) {
  const s = String(stepSize);
  if (!s || s.includes("e")) return 8;
  const i = s.indexOf(".");
  if (i === -1) return 0;
  return s.length - i - 1;
}

function formatQuantityToStepSize(quantity, stepSize) {
  const step = parseFloat(stepSize);
  if (!Number.isFinite(step) || step <= 0) return String(quantity);
  const q = parseFloat(quantity);
  if (!Number.isFinite(q) || q <= 0) return String(quantity);
  const precision = decimalsFromStep(stepSize);
  const rounded = Math.floor(q / step) * step;
  return rounded.toFixed(precision);
}

function formatPriceToTickSize(price, tickSize) {
  const tick = parseFloat(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return String(price);
  const p = parseFloat(price);
  if (!Number.isFinite(p) || p <= 0) return String(price);
  const precision = decimalsFromStep(tickSize);
  const rounded = Math.round(p / tick) * tick;
  return rounded.toFixed(precision);
}

/**
 * Get lotSizeFilter.qtyStep and priceFilter.tickSize for a symbol. From memory cache only; no per-symbol REST.
 */
async function getSymbolFilters(symbol) {
  const sym = String(symbol).toUpperCase();
  if (bybitSymbolFiltersCache[sym]) return bybitSymbolFiltersCache[sym];
  await ensureInstrumentsLoaded();
  const item = instrumentsBySymbol[sym];
  if (!item) {
    bybitSymbolFiltersCache[sym] = { stepSize: null, tickSize: null, maxOrderQty: null, minOrderQty: null };
    return bybitSymbolFiltersCache[sym];
  }
  const stepSize = item.lotSizeFilter?.qtyStep ?? null;
  const tickSize = item.priceFilter?.tickSize ?? null;
  const maxOrderQty = item.lotSizeFilter?.maxOrderQty ?? null;
  const minOrderQty = item.lotSizeFilter?.minOrderQty ?? null;
  bybitSymbolFiltersCache[sym] = { stepSize, tickSize, maxOrderQty, minOrderQty };
  return bybitSymbolFiltersCache[sym];
}

/**
 * Internal transfer: UNIFIED to FUND (Funding account). Same UID.
 * POST /v5/asset/transfer/inter-transfer
 */
async function transferUnifiedToFunding(credentials, coin, amount) {
  if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error("Bybit credentials required");
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = {
    transferId: `bt-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
    coin: String(coin || "USDT").toUpperCase(),
    amount: String(parseFloat(amount) || 0),
    fromAccountType: "UNIFIED",
    toAccountType: "FUND",
  };
  const rawBody = JSON.stringify(body);
  const signStr = timestamp + credentials.apiKey + recvWindow + rawBody;
  const signature = signMessage(signStr, credentials.apiSecret);
  const { data } = await bybitPrivateAxios.post(`${REST_BASE}/v5/asset/transfer/inter-transfer`, body, {
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  return data;
}

/**
 * Withdraw from Bybit to external address.
 * POST /v5/asset/withdraw/create
 */
async function withdrawCreate(credentials, coin, chain, address, amount) {
  if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error("Bybit credentials required");
  if (!address || !chain) throw new Error("Address and chain required");
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = {
    coin: String(coin || "USDT").toUpperCase(),
    chain: String(chain).trim(),
    address: String(address).trim(),
    amount: String(parseFloat(amount) || 0),
  };
  const rawBody = JSON.stringify(body);
  const signStr = timestamp + credentials.apiKey + recvWindow + rawBody;
  const signature = signMessage(signStr, credentials.apiSecret);
  const { data } = await bybitPrivateAxios.post(`${REST_BASE}/v5/asset/withdraw/create`, body, {
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  return data;
}

/**
 * Get USDT wallet balance from WebSocket cache (private wallet topic). Synchronous; no REST.
 */
function getBalance() {
  return cachedWalletBalance || 0;
}

/**
 * Fetch account balances from REST (equity = wallet + UPL).
 * @param {object} credentials - { apiKey, apiSecret }
 * @returns {Promise<{ totalEquity: number, totalWalletBalance: number, availableBalance: number }>}
 */
async function getBalances(credentials) {
  const out = { totalEquity: 0, totalWalletBalance: 0, availableBalance: 0 };
  if (!credentials?.apiKey || !credentials?.apiSecret) return out;
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const qsUnified = "accountType=UNIFIED";
    const signStr = timestamp + credentials.apiKey + recvWindow + qsUnified;
    const signature = signMessage(signStr, credentials.apiSecret);
    const headers = {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    };
    let data = (await bybitPrivateAxios.get(REST_BASE + "/v5/account/wallet-balance?" + qsUnified, { headers })).data;
    let list = data?.result?.list || [];
    if (!list.length) {
      const qsContract = "accountType=CONTRACT";
      const signStrContract = timestamp + credentials.apiKey + recvWindow + qsContract;
      const signatureContract = signMessage(signStrContract, credentials.apiSecret);
      const headersContract = {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signatureContract,
      };
      data = (await bybitPrivateAxios.get(REST_BASE + "/v5/account/wallet-balance?" + qsContract, { headers: headersContract })).data;
      list = data?.result?.list || [];
    }
    let usdtCoin = null;
    for (const item of list) {
      if (Array.isArray(item.coin)) {
        usdtCoin = item.coin.find((c) => (c.coin || "").toUpperCase() === "USDT");
      }
      if (usdtCoin) break;
    }
    if (usdtCoin) {
      const coinData = usdtCoin;
      const equity = parseFloat(coinData.equity || coinData.walletBalance || 0) || 0;
      const walletBal = parseFloat(coinData.walletBalance || 0) || 0;
      // Free balance: availableToWithdraw or free in Unified Accounts
      const availableBal = parseFloat(
        coinData.availableToWithdraw || coinData.free || coinData.availableBalance || 0
      ) || 0;
      out.totalEquity = equity;
      out.totalWalletBalance = walletBal;
      out.availableBalance = availableBal > 0 ? availableBal : walletBal * 0.95;
    }
  } catch (e) {
    console.warn("[Bybit] getBalances failed:", e?.message ?? e);
  }
  return out;
}

/**
 * Get open position symbols (size !== 0) for linear. USER_DATA, signed. Header-based auth only.
 */
async function getPositionSymbols(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return [];
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const qs = "category=linear";
    const signStr = timestamp + credentials.apiKey + recvWindow + qs;
    const signature = signMessage(signStr, credentials.apiSecret);
    const headers = {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    };
    const { data } = await bybitPrivateAxios.get(REST_BASE + "/v5/position/list?" + qs, { headers });
    const list = data?.result?.list || [];
    return list
      .filter((p) => {
        const size = parseFloat(String(p.size ?? 0));
        return Number.isFinite(size) && Math.abs(size) > 0;
      })
      .map((p) => String(p.symbol || "").toUpperCase())
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Get position details for PnL/margin: unrealizedProfit, marginUsed, size, side. USER_DATA, signed.
 * @returns {Promise<Array<{ symbol: string, unrealizedProfit: number, marginUsed: number, positionAmt: number, side: string }>>}
 */
async function getPositionDetails(credentials, symbol) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return [];
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    let qs = "category=linear&settleCoin=USDT";
    if (symbol) {
      qs += `&symbol=${encodeURIComponent(symbol)}`;
    }
    const signStr = timestamp + credentials.apiKey + recvWindow + qs;
    const signature = signMessage(signStr, credentials.apiSecret);
    const headers = {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    };
    const positionResponse = await bybitPrivateAxios.get(REST_BASE + "/v5/position/list?" + qs, { headers });
    const data = positionResponse.data;
    const list = data?.result?.list || [];
    return list
      .filter((p) => {
        const size = parseFloat(String(p.size ?? 0));
        return Number.isFinite(size) && Math.abs(size) > 0;
      })
      .map((p) => {
        const size = parseFloat(String(p.size ?? 0));
        const side = String(p.side || "").toLowerCase() === "buy" ? "Buy" : "Sell";
        const entryPrice = parseFloat(String(p.avgPrice ?? p.entryPrice ?? 0)) || null;
        const leverage = p.leverage != null ? Number(p.leverage) : null;
        const liquidationPrice = parseFloat(String(p.liqPrice ?? p.liquidationPrice ?? 0)) || null;
        return {
          symbol: String(p.symbol || "").toUpperCase(),
          unrealizedProfit: parseFloat(String(p.unrealisedPnl ?? 0)) || 0,
          marginUsed: parseFloat(String(p.positionIM ?? 0)) || 0,
          positionAmt: size,
          side,
          entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
          leverage: Number.isFinite(leverage) ? leverage : null,
          liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null,
        };
      })
      .filter((p) => p.symbol);
  } catch (e) {
    console.warn("[Bybit] getPositionDetails error:", e.message || e);
    throw e;
  }
}

/**
 * Place a MARKET reduce-only order via Trade WebSocket (order.create). Zero REST.
 */
async function placeWSMarketOrder(credentials, symbol, side, qty) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  if (sideNorm !== "Buy" && sideNorm !== "Sell") {
    throw new Error("side must be Buy or Sell");
  }
  await connectTradeWs(credentials);
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(Math.abs(qty), filters.stepSize)
    : String(Math.abs(qty));

  const timestamp = Date.now();
  const recvWindow = 5000;
  const args = [
    {
      category: "linear",
      symbol: sym,
      side: sideNorm,
      orderType: "Market",
      qty: qtyStr,
      reduceOnly: true,
    },
  ];
  const rawBody = JSON.stringify(args[0]);
  const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${rawBody}`;
  const signature = signMessage(signStr, credentials.apiSecret);

  const reqId = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    reqId,
    header: {
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": String(recvWindow),
      "X-BAPI-SIGN": signature,
    },
    op: "order.create",
    args,
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        reject(new Error("placeWSMarketOrder timeout"));
      }
    }, PLACE_WS_ORDER_TIMEOUT_MS);
    pendingRequests.set(reqId, { resolve, reject, timeoutId });
    try {
      tradeWs.send(JSON.stringify(payload));
    } catch (e) {
      pendingRequests.delete(reqId);
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

/**
 * Close position with a market order via WebSocket only (zero REST). Reduce-only.
 */
async function placeMarketCloseOrder(credentials, symbol, side, qty) {
  return placeWSMarketOrder(credentials, symbol, side, Math.abs(qty));
}

const DEFAULT_SLIPPAGE_PCT = 0.1;

/**
 * Get best bid/ask from WebSocket ticker cache (bid1Price/ask1Price, bid1Size/ask1Size). Returns null if not available.
 * @param {string} symbol
 * @returns {{ bestBid: number, bestBidQty: number, bestAsk: number, bestAskQty: number } | null}
 */
function getBestBidAsk(symbol) {
  const sym = String(symbol).toUpperCase();
  const state = tickerStateBySymbol[sym];
  if (!state) return null;
  const bestBid = parseFloat(state.bid1Price);
  const bestBidQty = parseFloat(state.bid1Size);
  const bestAsk = parseFloat(state.ask1Price);
  const bestAskQty = parseFloat(state.ask1Size);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  return { bestBid, bestBidQty: Number.isFinite(bestBidQty) ? bestBidQty : 0, bestAsk, bestAskQty: Number.isFinite(bestAskQty) ? bestAskQty : 0 };
}

/**
 * Get limit price for IOC from real best bid/ask (WebSocket ticker). Fallback to mark ± slippage if no BBO.
 * BUY: Best Ask * (1 + slippagePct/100). SELL: Best Bid * (1 - slippagePct/100).
 * @param {string} symbol
 * @param {string} side - Buy | Sell
 * @param {number} [slippagePct=0.1] - slippage in percent (e.g. 0.1 = 0.1%)
 */
function getOrderbookPrice(symbol, side, slippagePct = DEFAULT_SLIPPAGE_PCT) {
  const sym = String(symbol).toUpperCase();
  const pct = Number.isFinite(slippagePct) ? Math.max(0, Math.min(100, slippagePct)) : DEFAULT_SLIPPAGE_PCT;
  const isBuy = String(side).toLowerCase() === "buy";
  const book = getBestBidAsk(sym);
  if (book) {
    return isBuy ? book.bestAsk * (1 + pct / 100) : book.bestBid * (1 - pct / 100);
  }
  const mark = lastMarkPriceBySymbol[sym];
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  return isBuy ? mark * (1 + pct / 100) : mark * (1 - pct / 100);
}

/**
 * Get top of book for liquidity sweep: topBidPrice, topBidQty (SELL), topAskPrice, topAskQty (BUY).
 * Uses live orderbook state from tickers stream: bid1Price, bid1Size, ask1Price, ask1Size in tickerStateBySymbol.
 */
function getTopOfBook(symbol) {
  const sym = String(symbol).toUpperCase();
  const state = tickerStateBySymbol[sym];
  if (!state) return null;
  const topBidPrice = parseFloat(state.bid1Price);
  const topBidQty = parseFloat(state.bid1Size);
  const topAskPrice = parseFloat(state.ask1Price);
  const topAskQty = parseFloat(state.ask1Size);
  if (!Number.isFinite(topBidPrice) || !Number.isFinite(topAskPrice)) return null;
  return {
    topBidPrice,
    topBidQty: Number.isFinite(topBidQty) ? topBidQty : 0,
    topAskPrice,
    topAskQty: Number.isFinite(topAskQty) ? topAskQty : 0,
  };
}

const SWEEP_SLEEP_MS = 20;

/**
 * Dynamic L2 liquidity sweep (iceberg): while loop, place IOC chunks at live top-of-book via placeWSOrder.
 * Uses getTopOfBook only; if missing, fallback to standard pricing and place one order then break.
 * Filled qty from getOrderFilledQty(credentials, orderId) after each order.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - Buy | Sell
 * @param {number} totalQtyRemaining - quantity left to fill
 * @param {number} leverage - leverage for the order
 * @param {number} [maxIterations=10] - max chunks per sweep
 * @returns {Promise<{ totalFilled: number }>}
 */
async function executeLiquiditySweep(credentials, symbol, side, totalQtyRemaining, leverage, maxIterations = 10) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  if (sideNorm !== "Buy" && sideNorm !== "Sell") {
    return { totalFilled: 0 };
  }
  if (totalQtyRemaining <= 0 || maxIterations <= 0) {
    return { totalFilled: 0 };
  }

  await connectTradeWs(credentials);
  try {
    await setLeverage(credentials, sym, leverage);
  } catch (e) {
    console.log("[Bybit] executeLiquiditySweep setLeverage warning", sym, e?.message ?? e);
  }

  const filters = await getSymbolFilters(sym);
  const stepSize = filters?.stepSize ?? null;
  let totalFilled = 0;

  while (totalQtyRemaining > 0 && maxIterations > 0) {
    const topOfBook = getTopOfBook(sym);
    let targetPrice;
    let availableQty;

    if (topOfBook && Number.isFinite(topOfBook.topBidPrice) && Number.isFinite(topOfBook.topAskPrice)) {
      const isBuy = sideNorm === "Buy";
      targetPrice = isBuy ? topOfBook.topAskPrice : topOfBook.topBidPrice;
      availableQty = isBuy ? topOfBook.topAskQty : topOfBook.topBidQty;
    } else {
      targetPrice = getOrderbookPrice(sym, sideNorm);
      if (targetPrice == null || !Number.isFinite(targetPrice)) break;
      availableQty = null;
    }

    let chunkQty = availableQty != null && Number.isFinite(availableQty) && availableQty > 0
      ? Math.min(totalQtyRemaining, availableQty * 0.5)
      : totalQtyRemaining;
    if (stepSize) {
      chunkQty = parseFloat(formatQuantityToStepSize(chunkQty, stepSize)) || 0;
    }
    if (chunkQty <= 0) break;

    let res;
    try {
      res = await placeWSOrder(credentials, sym, sideNorm, chunkQty, targetPrice, { timeInForce: "IOC", leverage });
    } catch (e) {
      console.error("[Bybit] executeLiquiditySweep placeWSOrder failed", sym, e?.message ?? e);
      break;
    }
    console.log("[Bybit] executeLiquiditySweep order placed", {
      sym,
      orderId: res?.orderId ?? res?.result?.orderId,
      execTime: formatMs(res?.updatedTime ?? res?.result?.updatedTime ?? Date.now()),
    });

    const orderId = res?.orderId ?? res?.result?.orderId;
    const filledQty = orderId
      ? await getOrderFilledQty(credentials, orderId)
      : (Number.isFinite(parseFloat(res?.cumExecQty)) ? parseFloat(res.cumExecQty) : 0);
    totalQtyRemaining -= filledQty;
    totalFilled += filledQty;
    maxIterations -= 1;

    if (availableQty == null) break;
    await new Promise((r) => setTimeout(r, SWEEP_SLEEP_MS));
  }

  return { totalFilled };
}

async function placeIOCLimitOrder(credentials, symbol, side, qty, price, opts = {}) {
  const sym = symbol.toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();

  // STEP 1: If leverage is provided, update it FIRST and WAIT for the exchange response.
  if (opts?.leverage != null) {
    try {
      const success = await setLeverage(credentials, sym, opts.leverage);
      if (!success) {
        throw new Error(`Failed to confirm leverage set to ${opts.leverage}`);
      }
      console.log(`[Bybit] Leverage confirmed at ${opts.leverage}x for ${sym}. Proceeding to order.`);
    } catch (e) {
      const errCode = e?.body?.retCode ?? e?.response?.data?.retCode;
      if (errCode !== 110043) {
        console.error(`[Bybit] Stopping order: Leverage setup failed for ${sym}:`, e?.message ?? e);
        throw e;
      }
    }
  }

  // STEP 2: Place the order ONLY after Step 1 is successful.
  try {
    const data = await placeWSOrder(credentials, sym, sideNorm, qty, price, opts);
    return { result: data, retCode: 0, retMsg: "OK" };
  } catch (e) {
    console.error("[Bybit] placeWSOrder failed", sym, sideNorm, e.message, "- falling back to REST");
    return placeIOCLimitOrderREST(credentials, sym, sideNorm, qty, price, opts);
  }
}

async function placeIOCLimitOrderREST(credentials, sym, sideNorm, qty, price, opts = {}) {
  // STEP 1: If leverage is provided, update it FIRST and WAIT for confirmation.
  if (opts?.leverage != null) {
    try {
      const success = await setLeverage(credentials, sym, opts.leverage);
      if (!success) {
        throw new Error(`Failed to confirm leverage set to ${opts.leverage}`);
      }
      console.log(`[Bybit] Leverage confirmed at ${opts.leverage}x for ${sym}. Proceeding to order.`);
    } catch (e) {
      const errCode = e?.body?.retCode ?? e?.response?.data?.retCode;
      if (errCode !== 110043) {
        console.error(`[Bybit] Stopping order: Leverage setup failed for ${sym}:`, e?.message ?? e);
        throw e;
      }
    }
  }

  // STEP 2: Place the order ONLY after Step 1 is successful.
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(qty, filters.stepSize)
    : String(qty);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);

  const timestamp = Date.now();
  const recvWindow = 5000;
  const body = {
    category: "linear",
    symbol: sym,
    side: sideNorm,
    orderType: "Limit",
    qty: qtyStr,
    price: priceStr,
    timeInForce: "IOC",
    ...opts,
  };
  const rawBody = JSON.stringify(body);
  const signStr = String(timestamp) + credentials.apiKey + String(recvWindow) + rawBody;
  const signature = signMessage(signStr, credentials.apiSecret);

  const res = await bybitPrivateAxios.post(`${REST_BASE}/v5/order/create`, body, {
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": String(recvWindow),
    },
  });
  return res.data;
}

/**
 * Set leverage for a symbol via Bybit V5 REST. Used before entry so orders use correct leverage.
 * @returns {Promise<boolean>} true on success or 110043 (already set); false if credentials missing.
 * V5 return codes: 0 = success, 110043 = leverage already set to this value (treat as success).
 */
async function setLeverage(credentials, symbol, leverage) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return false;
  const sym = String(symbol || "").toUpperCase();
  const levStr = String(Math.max(1, Math.min(125, Number(leverage) || 1)));
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = {
    category: "linear",
    symbol: sym,
    buyLeverage: levStr,
    sellLeverage: levStr,
  };
  const rawBody = JSON.stringify(body);
  const signStr = String(timestamp) + credentials.apiKey + String(recvWindow) + rawBody;
  const signature = signMessage(signStr, credentials.apiSecret);
  try {
    const res = await bybitPrivateAxios.post(`${REST_BASE}/v5/position/set-leverage`, body, {
      headers: {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });
    const retCode = res.data?.retCode;
    if (retCode === 110043) return true; // Already set to this value
    if (retCode !== 0 && retCode != null) {
      console.warn("[Bybit] setLeverage", sym, "retCode", retCode, res.data?.retMsg);
    }
    return true; // retCode 0 or other non-fatal
  } catch (e) {
    if (e?.body?.retCode === 110043 || e?.response?.data?.retCode === 110043) return true;
    throw e;
  }
}

function stop() {
  publicStopped = true;
  if (publicReconnectTimer) {
    clearTimeout(publicReconnectTimer);
    publicReconnectTimer = null;
  }
  if (tradeWsReconnectTimer) {
    clearTimeout(tradeWsReconnectTimer);
    tradeWsReconnectTimer = null;
  }
  if (privateReconnectTimer) {
    clearTimeout(privateReconnectTimer);
    privateReconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  for (const [reqId, pending] of pendingRequests) {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    pending.reject(new Error("Bybit manager stopped"));
  }
  pendingRequests.clear();
  tradeWsConnectPromise = null;
  if (tradeWsPingTimer) {
    clearInterval(tradeWsPingTimer);
    tradeWsPingTimer = null;
  }
  if (tradeWs) {
    tradeWs.removeAllListeners?.();
    tradeWs.close();
    tradeWs = null;
  }
  if (privateWs) {
    privateWs.removeAllListeners?.();
    privateWs.close();
    privateWs = null;
  }
  if (publicWsArray && publicWsArray.length > 0) {
    publicWsArray.forEach((ws) => {
      if (ws) {
        ws.removeAllListeners?.();
        ws.close();
      }
    });
    publicWsArray = [];
  }
  privateCredentials = null;
  tradeWsCredentials = null;
  cachedWalletBalance = 0;
  instrumentsLoadPromise = null;
  Object.keys(cachedFundingRates).forEach((k) => delete cachedFundingRates[k]);
  Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
  Object.keys(lastMarkPriceBySymbol).forEach((k) => delete lastMarkPriceBySymbol[k]);
  Object.keys(tickerStateBySymbol).forEach((k) => delete tickerStateBySymbol[k]);
  console.log("[Bybit] Manager stopped");
}

const HYDRATE_RETRY_DELAY_MS = 3000;

/**
 * One-time REST fetch at startup to populate local position state (so dashboard shows positions after restart).
 * Retries once on failure so transient errors don't leave positions empty.
 */
async function hydratePositionsFromRest(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
      const list = await getPositionDetails(credentials);
      for (const p of list || []) {
        const sym = String(p?.symbol || "").toUpperCase();
        const positionAmt = parseFloat(String(p?.positionAmt ?? 0));
        if (!sym || !Number.isFinite(positionAmt) || Math.abs(positionAmt) === 0) continue;
        const side = String(p?.side || "").toLowerCase() === "buy" ? "Buy" : "Sell";
        const key = `${sym}:${side}:0`;
        const entryPrice = parseFloat(String(p?.entryPrice ?? 0)) || null;
        const leverage = p?.leverage != null ? Number(p.leverage) : null;
        const liquidationPrice = parseFloat(String(p?.liquidationPrice ?? 0)) || null;
        livePositionsByKey[key] = {
          symbol: sym,
          unrealizedProfit: parseFloat(String(p?.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p?.marginUsed ?? 0)) || 0,
          positionAmt,
          side,
          entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
          leverage: Number.isFinite(leverage) ? leverage : null,
          liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null,
        };
      }
      emitPositionUpdate();
      if (list?.length > 0) console.log("[Bybit] Hydrated", list.length, "positions from REST");
      return;
    } catch (e) {
      console.error("[Bybit] Hydrate positions failed (attempt " + attempt + "/2):", e.message || e);
      if (attempt === 1) await new Promise((r) => setTimeout(r, HYDRATE_RETRY_DELAY_MS));
    }
  }
  console.warn("[Bybit] Position hydration skipped after retries; dashboard may show no positions until WS updates.");
}

async function start(credentials, options = {}) {
  publicStopped = false;
  publicReconnectAttempts = 0;
  await ensureInstrumentsLoaded();
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  openPrivateStream(credentials);
  await hydratePositionsFromRest(credentials);
  if (credentials?.apiKey && credentials?.apiSecret) {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";

      const qsUnified = "accountType=UNIFIED";
      const signStrUnified = timestamp + credentials.apiKey + recvWindow + qsUnified;
      const signatureUnified = signMessage(signStrUnified, credentials.apiSecret);
      const headersUnified = {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signatureUnified,
      };
      let data = (await bybitPrivateAxios.get(REST_BASE + "/v5/account/wallet-balance?" + qsUnified, { headers: headersUnified })).data;

      let list = data?.result?.list || [];
      if (!list.length) {
        const qsContract = "accountType=CONTRACT";
        const signStrContract = timestamp + credentials.apiKey + recvWindow + qsContract;
        const signatureContract = signMessage(signStrContract, credentials.apiSecret);
        const headersContract = {
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "X-BAPI-SIGN": signatureContract,
        };
        data = (await bybitPrivateAxios.get(REST_BASE + "/v5/account/wallet-balance?" + qsContract, { headers: headersContract })).data;
        list = data?.result?.list || [];
      }

      let usdtCoin = null;
      for (const item of list) {
        if (Array.isArray(item.coin)) {
          usdtCoin = item.coin.find((c) => (c.coin || "").toUpperCase() === "USDT");
        } else if ((item.coin || "").toUpperCase() === "USDT") {
          usdtCoin = item;
        }
        if (usdtCoin) break;
      }

      if (usdtCoin) {
        cachedWalletBalance = parseFloat(usdtCoin.equity ?? usdtCoin.walletBalance ?? usdtCoin.availableToWithdraw ?? 0) || 0;
      }
    } catch (e) {
      console.warn("[Bybit] One-time balance hydration failed:", e.message);
    }
  }
}

/**
 * Get mark price from WebSocket cache (tickers stream). No REST.
 */
function getMarkPrice(symbol) {
  const s = String(symbol || "").toUpperCase();
  const v = lastMarkPriceBySymbol[s];
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Get funding rate from WebSocket cache (tickers stream). No REST.
 */
function getCachedFundingRate(symbol) {
  const s = String(symbol || "").toUpperCase();
  const c = cachedFundingRates[s];
  return c != null && Number.isFinite(c.fundingRate) ? c.fundingRate : null;
}

/**
 * Get next funding time from WebSocket cache. No REST.
 */
function getCachedNextFundingTime(symbol) {
  const s = String(symbol || "").toUpperCase();
  const c = cachedFundingRates[s];
  return c?.nextFundingTime != null && Number.isFinite(c.nextFundingTime) ? c.nextFundingTime : null;
}

/**
 * Get funding interval in hours (1, 2, 4, 8) from instruments-info cache. Default 8 if missing.
 * Call after ensureInstrumentsLoaded() (e.g. after getPerpetualSymbols()) so cache is populated.
 */
function getFundingInterval(symbol) {
  const sym = String(symbol || "").toUpperCase();
  const instrument = instrumentsBySymbol[sym];
  const h = instrument?.fundingIntervalHours;
  return h != null && Number.isFinite(h) ? h : 8;
}

/**
 * Get max leverage for symbol from one-time cached instruments-info. No per-symbol REST.
 */
async function getMaxLeverage(symbol) {
  await ensureInstrumentsLoaded();
  const sym = String(symbol).toUpperCase();
  const instrument = instrumentsBySymbol[sym];
  const lev = instrument?.leverageFilter?.maxLeverage;
  return lev != null ? Number(lev) : null;
}

/**
 * Get all linear perpetual symbols from one-time cached instruments-info. No REST loop.
 * @returns {Promise<string[]>} e.g. ["BTCUSDT", "ETHUSDT", ...]
 */
async function getPerpetualSymbols() {
  await ensureInstrumentsLoaded();
  return cachedInstrumentsInfo
    .filter((item) => item.symbol && item.status === "Trading")
    .map((item) => item.symbol);
}

/**
 * Get average fill price for a closed/filled order (e.g. after placeIOCLimitOrder).
 * Waits briefly then GET /v5/order/history to read avgPrice. Used for trade history execExit.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} orderId - order ID from create response
 * @returns {Promise<number|null>} avgPrice or null
 */
async function getOrderFillPrice(credentials, orderId) {
  if (!credentials?.apiKey || !credentials?.apiSecret || !orderId) return null;
  await new Promise((r) => setTimeout(r, 500));
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const qs = `category=linear&orderId=${encodeURIComponent(orderId)}`;
    const signStr = timestamp + credentials.apiKey + recvWindow + qs;
    const signature = signMessage(signStr, credentials.apiSecret);
    const { data } = await bybitPrivateAxios.get(`${REST_BASE}/v5/order/history?${qs}`, {
      headers: {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature,
      },
    });
    const list = data?.result?.list || [];
    const order = list[0];
    const avg = order?.avgPrice;
    if (avg != null && String(avg).length > 0) {
      const p = parseFloat(avg);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch (e) {
    console.warn("[Bybit] getOrderFillPrice", orderId, e.message || e);
  }
  return null;
}

/**
 * Get filled quantity for an order (e.g. after placeIOCLimitOrder). Waits briefly then GET /v5/order/history.
 * Used so Binance leg can match Bybit filled qty on partial fills.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} orderId - order ID from create response
 * @returns {Promise<number>} cumExecQty or 0
 */
async function getOrderFilledQty(credentials, orderId) {
  if (!credentials?.apiKey || !credentials?.apiSecret || !orderId) return 0;
  await new Promise((r) => setTimeout(r, 400));
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const qs = `category=linear&orderId=${encodeURIComponent(orderId)}`;
    const signStr = timestamp + credentials.apiKey + recvWindow + qs;
    const signature = signMessage(signStr, credentials.apiSecret);
    const { data } = await bybitPrivateAxios.get(`${REST_BASE}/v5/order/history?${qs}`, {
      headers: {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature,
      },
    });
    const list = data?.result?.list || [];
    const order = list[0];
    const q = order?.cumExecQty;
    if (q != null && String(q).length > 0) {
      const n = parseFloat(q);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch (e) {
    console.warn("[Bybit] getOrderFilledQty", orderId, e?.message ?? e);
  }
  return 0;
}

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  getOrderFillPrice,
  getOrderFilledQty,
  setLeverage,
  placeWSOrder,
  prepareOrderPayload,
  executeWSTrade,
  connectTradeWs,
  transferUnifiedToFunding,
  withdrawCreate,
  placeMarketCloseOrder,
  getCredentials: () => privateCredentials,
  setOnFundingUpdate,
  setOnMarkPriceUpdate,
  setOnPositionUpdate,
  setOnPositionClosed,
  getLivePositions,
  getMarkPrice,
  getCachedFundingRate,
  getCachedNextFundingTime,
  getFundingInterval,
  getMaxLeverage,
  getPerpetualSymbols,
  getOrderbookPrice,
  getBestBidAsk,
  getTopOfBook,
  executeLiquiditySweep,
  getBalance,
  getBalances,
  getPositionSymbols,
  getPositionDetails,
  getSymbolFilters,
  hydratePositionsFromRest,
};
