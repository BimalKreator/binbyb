const WebSocket = require("ws");
const axios = require("axios");
axios.defaults.family = 4;
axios.interceptors.request.use((request) => {
  console.log(`[REST API TRACKER] ${request.method.toUpperCase()} ${request.baseURL || ""}${request.url}`);
  return request;
});
const CryptoJS = require("crypto-js");
const { formatMs, logLatency } = require("./latencyTracker");

const PUBLIC_WS_BASE = "wss://fstream.binance.com";
const WS_FAPI_BASE = "wss://ws-fapi.binance.com/ws-fapi/v1";
const REST_BASE = "https://fapi.binance.com";
const SPOT_REST_BASE = "https://api.binance.com";

/** If x-mbx-used-weight-1m exceeds this, all Binance REST requests pause for 60s to avoid IP ban. */
const BINANCE_WEIGHT_LIMIT = 2000;
const BINANCE_WEIGHT_PAUSE_MS = 60000;
let binanceRestPausedUntil = 0;

const binanceAxios = axios.create();
binanceAxios.interceptors.request.use((req) => {
  console.log(`[REST API TRACKER] ${req.method.toUpperCase()} ${req.baseURL || ""}${req.url}`);
  return req;
});
binanceAxios.interceptors.request.use(
  (config) => {
    if (Date.now() < binanceRestPausedUntil) {
      return Promise.reject(new Error("Binance REST paused (API weight limit); retry after 60s"));
    }
    return config;
  },
  (err) => Promise.reject(err)
);
binanceAxios.interceptors.response.use(
  (response) => {
    const raw = response.headers["x-mbx-used-weight-1m"];
    if (raw != null && raw !== "") {
      const weight = parseInt(String(raw), 10);
      if (Number.isFinite(weight) && weight > BINANCE_WEIGHT_LIMIT) {
        binanceRestPausedUntil = Date.now() + BINANCE_WEIGHT_PAUSE_MS;
        console.error(
          "[Binance] API weight exceeded",
          BINANCE_WEIGHT_LIMIT,
          "(got",
          weight,
          "). All REST requests paused for",
          BINANCE_WEIGHT_PAUSE_MS / 1000,
          "s."
        );
      }
    }
    return response;
  },
  (err) => Promise.reject(err)
);
const PLACE_WS_ORDER_TIMEOUT_MS = 15000;
/** ListenKey expires after 60 min; REST PUT extend strictly every 30 min to keep fstream user stream alive */
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000;

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let onFundingUpdate = null;
function setOnFundingUpdate(fn) {
  onFundingUpdate = fn;
}
/** Called on every mark price tick (no throttle). (symbol, markPrice, 'binance') */
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

let publicWs = null;
let privateWs = null;
let apiWs = null;
let listenKey = null;
let privateCredentials = null;
let listenKeyKeepaliveTimer = null;
let privateReconnectAttempts = 0;
let privateReconnectTimer = null;
const livePositionsByKey = {};
/** USDT cached balance: updated by private WS ACCOUNT_UPDATE (msg.a.B) and one-time REST at startup only. */
let cachedWalletBalance = 0;
/** Free balance available to open new positions (from REST or computed as marginBalance - totalMarginUsed). */
let cachedAvailableBalance = 0;
const AVAILABLE_BALANCE_CACHE_TTL_MS = 15000;
let lastAvailableBalanceRestTime = 0;
let availableBalanceFetchInFlight = false;
/** Pending WS API requests: id -> { resolve, reject, timeoutId } */
const pendingRequests = new Map();
let apiWsConnectPromise = null;
let apiWsReconnectAttempts = 0;
let apiWsReconnectTimer = null;
const API_WS_PING_INTERVAL_MS = 30000;
let apiWsPingTimer = null;

/** Global cache: symbol -> funding interval hours (1, 2, 4, 8). Filled by syncFundingIntervals(); never cleared. */
let fundingIntervalCache = {};
let fundingIntervalRefreshTimerId = null;

function getLivePositions() {
  return Object.values(livePositionsByKey);
}

function emitPositionUpdate() {
  if (typeof onPositionUpdate === "function") {
    onPositionUpdate(getLivePositions());
  }
}

function upsertLivePosition(raw) {
  const sym = String(raw?.s || raw?.symbol || "").toUpperCase();
  const positionSideRaw = String(raw?.ps || raw?.positionSide || "BOTH").toUpperCase();
  const positionSide =
    positionSideRaw === "LONG" || positionSideRaw === "SHORT" ? positionSideRaw : "BOTH";
  if (!sym) return;
  const amt = parseFloat(raw?.pa ?? raw?.positionAmt ?? 0);
  const key = `${sym}:${positionSide}`;
  if (!Number.isFinite(amt) || Math.abs(amt) <= 0) {
    delete livePositionsByKey[key];
    if (typeof onPositionClosed === "function") onPositionClosed(sym, "binance");
    return;
  }
  const now = Date.now();
  const existing = livePositionsByKey[key];
  const side = positionSide === "LONG" ? "BUY" : positionSide === "SHORT" ? "SELL" : amt > 0 ? "BUY" : "SELL";
  const entryPrice = parseFloat(raw?.ep ?? raw?.entryPrice ?? 0) || null;
  const leverage = raw?.l != null ? Number(raw.l) : raw?.leverage != null ? Number(raw.leverage) : null;
  const liquidationPrice = parseFloat(raw?.lp ?? raw?.liquidationPrice ?? 0) || null;
  let marginUsed = parseFloat(raw?.iw ?? raw?.im ?? raw?.isolatedWallet ?? raw?.positionInitialMargin ?? 0) || 0;
  if (marginUsed <= 0 && Number.isFinite(entryPrice) && entryPrice > 0 && leverage != null && leverage >= 1) {
    marginUsed = (Math.abs(amt) * entryPrice) / leverage;
  }
  livePositionsByKey[key] = {
    symbol: sym,
    unrealizedProfit: parseFloat(raw?.up ?? raw?.unRealizedProfit ?? raw?.unrealizedProfit ?? 0) || 0,
    marginUsed,
    positionAmt: amt,
    side,
    positionSide,
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
    leverage: Number.isFinite(leverage) ? leverage : null,
    liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null,
    createdTime: existing?.createdTime ?? now,
    updatedTime: now,
  };
}

function signQueryString(queryString, apiSecret) {
  return CryptoJS.HmacSHA256(queryString, apiSecret).toString(CryptoJS.enc.Hex);
}

/**
 * Ensure WebSocket connection to ws-fapi for API requests (order.place etc.).
 * Separate from fstream (public) and listenKey (user data).
 * Reuses in-flight connect promise so concurrent callers share one connection.
 */
function connectApiWs() {
  if (apiWs && apiWs.readyState === WebSocket.OPEN) return Promise.resolve();
  if (apiWsConnectPromise) return apiWsConnectPromise;
  if (apiWs) {
    apiWs.removeAllListeners?.();
    apiWs.close();
    apiWs = null;
  }
  apiWsConnectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_FAPI_BASE, { family: 4 });
    apiWs = ws;
    ws.on("open", () => {
      console.log("[Binance] WS-FAPI (order API) connected");
      apiWsReconnectAttempts = 0;
      apiWsConnectPromise = null;
      if (apiWsPingTimer) clearInterval(apiWsPingTimer);
      apiWsPingTimer = setInterval(() => {
        if (apiWs && apiWs.readyState === WebSocket.OPEN) {
          try {
            apiWs.send(JSON.stringify({ method: "ping", id: Date.now() }));
          } catch (e) {
            // ignore
          }
        }
      }, API_WS_PING_INTERVAL_MS);
      resolve();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const id = msg.id;
        if (id == null || !pendingRequests.has(id)) return;
        const pending = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        if (msg.status === 200 && msg.result != null) {
          pending.resolve(msg.result);
        } else {
          const err = new Error(msg.error?.msg || msg.error?.message || JSON.stringify(msg.error || msg));
          err.code = msg.error?.code;
          err.response = { data: msg };
          pending.reject(err);
        }
      } catch (e) {
        console.error("[Binance] WS-FAPI message parse error", e.message);
      }
    });
    ws.on("close", (code, reason) => {
      if (apiWsPingTimer) {
        clearInterval(apiWsPingTimer);
        apiWsPingTimer = null;
      }
      console.log("[Binance] WS-FAPI closed", code, reason?.toString());
      apiWs = null;
      apiWsConnectPromise = null;
      for (const [id, pending] of pendingRequests) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pending.reject(new Error("WS-FAPI connection closed"));
      }
      pendingRequests.clear();
      scheduleApiWsReconnect();
    });
    ws.on("error", (err) => {
      console.error("[Binance] WS-FAPI error", err.message);
      if (apiWs === ws) apiWs = null;
      apiWsConnectPromise = null;
      reject(err);
      scheduleApiWsReconnect();
    });
  });
  return apiWsConnectPromise;
}

/**
 * Place an IOC limit order via WebSocket API (order.place).
 * Returns a Promise that resolves with the execution result (orderId, symbol, etc.) or rejects on error.
 */
async function placeWSOrder(credentials, symbol, side, quantity, price, opts = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = String(side).toUpperCase();
  if (sideNorm !== "BUY" && sideNorm !== "SELL") {
    throw new Error("side must be BUY or SELL");
  }
  await connectApiWs();
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(quantity, filters.stepSize)
    : String(quantity);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);

  let positionSide = opts.positionSide;
  if (positionSide === undefined) {
    try {
      const isHedge = await getPositionMode(credentials);
      positionSide = isHedge ? (sideNorm === "BUY" ? "LONG" : "SHORT") : "BOTH";
    } catch (e) {
      positionSide = "BOTH";
    }
  }

  const timestamp = Date.now();
  const id = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const params = {
    apiKey: credentials.apiKey,
    symbol: sym,
    side: sideNorm,
    type: "LIMIT",
    quantity: qtyStr,
    price: priceStr,
    timeInForce: "IOC",
    timestamp,
    newOrderRespType: "RESULT",
  };
  if (positionSide && positionSide !== "BOTH") params.positionSide = positionSide;
  if (opts.reduceOnly === true) params.reduceOnly = "true";
  if (params.positionSide && (params.positionSide.toUpperCase() === "LONG" || params.positionSide.toUpperCase() === "SHORT")) {
    delete params.reduceOnly; // Binance forbids reduceOnly when positionSide is used (Hedge Mode)
  }

  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  params.signature = signature;

  const payload = { id, method: "order.place", params };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("placeWSOrder timeout"));
      }
    }, PLACE_WS_ORDER_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timeoutId });
    try {
      apiWs.send(JSON.stringify(payload));
    } catch (e) {
      pendingRequests.delete(id);
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

/**
 * Build the exact stringified JSON payload for an IOC limit order. Sync only: no async, REST, or DB.
 * Uses in-memory symbolFiltersCache for stepSize/tickSize; call ensureExchangeInfoAndLeverageLoaded first.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - BUY | SELL
 * @param {number} quantity - in base/contracts
 * @param {number} price - limit price
 * @param {object} [options] - { positionSide } (default BOTH)
 * @returns {string} JSON string to send over WS
 */
function prepareOrderPayload(credentials, symbol, side, qty, price, options = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = String(side).toUpperCase();
  if (sideNorm !== "BUY" && sideNorm !== "SELL") {
    throw new Error("side must be BUY or SELL");
  }
  const filters = symbolFiltersCache[sym] || {};
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(qty, filters.stepSize)
    : String(qty);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);
  const positionSide = options.positionSide != null ? options.positionSide : "BOTH";

  const timestamp = Date.now();
  const id = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const params = {
    apiKey: credentials.apiKey,
    symbol: sym,
    side: sideNorm,
    type: "LIMIT",
    quantity: qtyStr,
    price: priceStr,
    timeInForce: "IOC",
    timestamp,
  };
  if (positionSide && positionSide !== "BOTH") params.positionSide = positionSide;
  if (options.reduceOnly === true) params.reduceOnly = "true";
  if (params.positionSide && (params.positionSide.toUpperCase() === "LONG" || params.positionSide.toUpperCase() === "SHORT")) {
    delete params.reduceOnly;
  }

  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  params.signature = signature;

  const payload = { id, method: "order.place", params };
  return JSON.stringify(payload);
}

/**
 * Fire-and-forget: send pre-computed order payload over WS. No await, no Promise.
 * @param {string} preComputedJsonPayload - result of prepareOrderPayload()
 */
function executeWSTrade(preComputedJsonPayload) {
  if (apiWs && apiWs.readyState === WebSocket.OPEN) {
    apiWs.send(preComputedJsonPayload);
  }
}

/**
 * Send pre-computed order payload over WS and wait for the response by matching id in incoming messages.
 * Resolves with the order result (executedQty, etc.); rejects on error or timeout. No REST.
 * @param {string} preComputedJsonPayload - result of prepareOrderPayload()
 * @returns {Promise<object>} result from WS response (e.g. { executedQty, orderId, ... })
 */
function sendOrderPayloadAndWaitResponse(preComputedJsonPayload) {
  let payload;
  try {
    payload = JSON.parse(preComputedJsonPayload);
  } catch (e) {
    return Promise.reject(new Error("Invalid order payload JSON"));
  }
  const id = payload?.id;
  if (!id) {
    return Promise.reject(new Error("Order payload missing id"));
  }
  return new Promise((resolve, reject) => {
    connectApiWs()
      .then(() => {
        const timeoutId = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error("sendOrderPayloadAndWaitResponse timeout"));
          }
        }, PLACE_WS_ORDER_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timeoutId });
        try {
          apiWs.send(preComputedJsonPayload);
        } catch (e) {
          pendingRequests.delete(id);
          clearTimeout(timeoutId);
          reject(e);
        }
      })
      .catch(reject);
  });
}

/** Slippage 1% so IOC orders get filled. */
const ORDERBOOK_SLIPPAGE_PCT = 0.01;

/**
 * Place a MARKET reduce-only order via WebSocket API (order.place).
 * Used for position close; no REST fallback to avoid IP ban.
 */
async function placeWSMarketOrder(credentials, symbol, side, quantity, opts = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = String(side).toUpperCase();
  if (sideNorm !== "BUY" && sideNorm !== "SELL") {
    throw new Error("side must be BUY or SELL");
  }
  await connectApiWs();
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(quantity, filters.stepSize)
    : String(quantity);

  let positionSide = opts.positionSide;
  if (positionSide === undefined) {
    try {
      const isHedge = await getPositionMode(credentials);
      positionSide = isHedge ? (sideNorm === "BUY" ? "LONG" : "SHORT") : "BOTH";
    } catch (e) {
      positionSide = "BOTH";
    }
  }

  const timestamp = Date.now();
  const id = `order_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const params = {
    apiKey: credentials.apiKey,
    symbol: sym,
    side: sideNorm,
    type: "MARKET",
    quantity: qtyStr,
    timestamp,
  };
  if (positionSide === "LONG" || positionSide === "SHORT") {
    // Hedge mode: do not include reduceOnly (avoids Binance conflict)
  } else {
    params.reduceOnly = "true";
  }
  if (positionSide && positionSide !== "BOTH") params.positionSide = positionSide;

  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  params.signature = signature;

  const payload = { id, method: "order.place", params };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("placeWSMarketOrder timeout"));
      }
    }, PLACE_WS_ORDER_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timeoutId });
    try {
      apiWs.send(JSON.stringify(payload));
    } catch (e) {
      pendingRequests.delete(id);
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

const MAX_STREAMS_PER_CONNECTION = 1024;
const FUNDING_THROTTLE_MS = 500;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let publicStreamSymbols = DEFAULT_SYMBOLS;
let publicReconnectAttempts = 0;
let publicReconnectTimer = null;
let publicStopped = false;
/** Throttle funding emits per symbol; only overwrites keys (no .push), prevents memory growth. */
const lastFundingEmitBySymbol = {};
/** markPrice per symbol from public stream (for getOrderbookPrice without REST). */
const lastMarkPriceBySymbol = {};
/** Best bid/ask from !bookTicker stream: { bestBid, bestBidQty, bestAsk, bestAskQty } */
const bookTickerBySymbol = {};
/** L2 top of book for sweeper: { topBidPrice, topBidQty, topAskPrice, topAskQty } from b, B, a, A */
const topOfBookBySymbol = {};
/** Full depth (20 levels) per symbol from @depth20@100ms: { bids: [[price,qty],...], asks: [[price,qty],...] } */
const orderbooksBySymbol = {};
/** Separate WebSocket(s) for depth (Binance 200-stream limit); 150 symbols per connection. */
let depthWsArray = [];
const BINANCE_DEPTH_CHUNK_SIZE = 150;
/** Funding rate (and nextFundingTime) from public markPriceUpdate stream. No REST /fundingRate. */
const cachedFundingRates = {};

function schedulePublicReconnect() {
  if (publicStopped || publicReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, publicReconnectAttempts), RECONNECT_MAX_MS);
  publicReconnectAttempts += 1;
  console.log("[Binance] Public WebSocket reconnecting in", delay, "ms (attempt", publicReconnectAttempts, ")");
  publicReconnectTimer = setTimeout(() => {
    publicReconnectTimer = null;
    openPublicStreams(publicStreamSymbols);
  }, delay);
}

function scheduleApiWsReconnect() {
  if (apiWsReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, apiWsReconnectAttempts), RECONNECT_MAX_MS);
  apiWsReconnectAttempts += 1;
  console.log("[Binance] WS-FAPI reconnecting in", delay, "ms (attempt", apiWsReconnectAttempts, ")");
  apiWsReconnectTimer = setTimeout(() => {
    apiWsReconnectTimer = null;
    connectApiWs();
  }, delay);
}

function schedulePrivateReconnect() {
  if (!privateCredentials || privateReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, privateReconnectAttempts), RECONNECT_MAX_MS);
  privateReconnectAttempts += 1;
  console.log("[Binance] Private WebSocket reconnecting in", delay, "ms (attempt", privateReconnectAttempts, ")");
  privateReconnectTimer = setTimeout(() => {
    privateReconnectTimer = null;
    startPrivateStream(privateCredentials);
  }, delay);
}

/**
 * Open a dedicated WebSocket for depth20@100ms for a chunk of symbols (Binance 200-stream limit).
 * Processes depthUpdate into orderbooksBySymbol.
 */
function connectBinanceDepthChunk(symbolsChunk) {
  if (!symbolsChunk || symbolsChunk.length === 0) return;
  const url = `${PUBLIC_WS_BASE}/ws`;
  const ws = new WebSocket(url, { family: 4 });
  depthWsArray.push(ws);

  ws.on("open", () => {
    const streams = symbolsChunk.map((s) => String(s).toLowerCase() + "@depth20@100ms");
    ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: 1 }));
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const list = Array.isArray(data) ? data : [data.data || data];
      for (const payload of list) {
        if (payload && payload.e === "depthUpdate" && payload.b && payload.a) {
          const sym = payload.s ? String(payload.s).toUpperCase() : "";
          if (sym) {
            orderbooksBySymbol[sym] = {
              bids: (payload.b || []).map((x) => [parseFloat(x[0]), parseFloat(x[1])]),
              asks: (payload.a || []).map((x) => [parseFloat(x[0]), parseFloat(x[1])]),
            };
          }
        }
      }
    } catch (e) {
      console.error("[Binance-Depth-WS] Parse error:", e.message);
    }
  });

  ws.on("close", (code, reason) => {
    depthWsArray = depthWsArray.filter((w) => w !== ws);
  });

  ws.on("error", (err) => {
    console.error("[Binance] Depth WebSocket error", err.message);
  });
}

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicStopped) return;
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  publicStreamSymbols = symbols;
  const trackedSymbols = new Set((symbols || []).map((s) => String(s).toUpperCase()));
  const url = `${PUBLIC_WS_BASE}/ws`;

  depthWsArray.forEach((w) => {
    try {
      w.removeAllListeners?.();
      w.close();
    } catch (_) {}
  });
  depthWsArray = [];

  const ws = new WebSocket(url, { family: 4 });
  publicWs = ws;

  ws.on("open", () => {
    publicReconnectAttempts = 0;
    console.log("[Binance] Public WebSocket connected. Subscribing to markPrice and bookTicker...");
    ws.send(JSON.stringify({
      method: "SUBSCRIBE",
      params: ["!markPrice@arr@1s", "!bookTicker"],
      id: 1,
    }));
    const symList = symbols || [];
    for (let i = 0; i < symList.length; i += BINANCE_DEPTH_CHUNK_SIZE) {
      const chunk = symList.slice(i, i + BINANCE_DEPTH_CHUNK_SIZE);
      connectBinanceDepthChunk(chunk);
    }
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data && data.result === null && data.id === 1) {
        console.log("[Binance] Successfully subscribed to !markPrice@arr@1s");
        return;
      }

      if (Array.isArray(data)) {
        data.forEach((item) => {
          if (item && item.e === "bookTicker") {
            const sym = item.s ? String(item.s).toUpperCase() : "";
            if (sym && item.b != null && item.a != null) {
              const bestBid = parseFloat(item.b) || 0;
              const bestBidQty = parseFloat(item.B) || 0;
              const bestAsk = parseFloat(item.a) || 0;
              const bestAskQty = parseFloat(item.A) || 0;
              if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
                bookTickerBySymbol[sym] = { bestBid, bestBidQty, bestAsk, bestAskQty };
                topOfBookBySymbol[sym] = { topBidPrice: bestBid, topBidQty: bestBidQty, topAskPrice: bestAsk, topAskQty: bestAskQty };
              }
            }
            return;
          }
          if (item && item.e === "markPriceUpdate") {
            const sym = item.s ? String(item.s).toUpperCase() : "";
            const mp = parseFloat(item.p);
            const fr = parseFloat(item.r);
            const nextTime = Number.isFinite(parseInt(item.T, 10)) ? parseInt(item.T, 10) : null;

            if (sym && !Number.isNaN(mp) && mp > 0) {
              lastMarkPriceBySymbol[sym] = mp;
              cachedFundingRates[sym] = {
                fundingRate: Number.isFinite(fr) ? fr : 0,
                nextFundingTime: nextTime,
              };

              if (onMarkPriceUpdate && trackedSymbols.has(sym)) {
                try {
                  onMarkPriceUpdate(sym, mp, "binance");
                } catch (e) {
                  console.error("[Binance-WS-Error]", e.message);
                }
              }

              if (onFundingUpdate && trackedSymbols.has(sym)) {
                const now = Date.now();
                const last = lastFundingEmitBySymbol[sym];
                if (last == null || now - last >= FUNDING_THROTTLE_MS) {
                  lastFundingEmitBySymbol[sym] = now;
                  onFundingUpdate({
                    symbol: sym,
                    fundingRate: fr,
                    nextFundingTime: nextTime,
                    markPrice: mp,
                    eventTime: item.E,
                  });
                }
              }
            }
          }
        });
        return;
      }

      const stream = data.stream || "";
      const payload = data.data || data;

      if (payload && payload.E) {
        logLatency("binance", stream || payload.e || "public", payload.E, { s: payload.s });
      }

      if (payload && payload.e === "bookTicker") {
        const { s, b, B, a, A } = payload;
        const sym = s ? String(s).toUpperCase() : "";
        if (sym && b != null && a != null) {
          const bestBid = parseFloat(b) || 0;
          const bestBidQty = parseFloat(B) || 0;
          const bestAsk = parseFloat(a) || 0;
          const bestAskQty = parseFloat(A) || 0;
          if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
            bookTickerBySymbol[sym] = { bestBid, bestBidQty, bestAsk, bestAskQty };
            topOfBookBySymbol[sym] = { topBidPrice: bestBid, topBidQty: bestBidQty, topAskPrice: bestAsk, topAskQty: bestAskQty };
          }
        }
        return;
      }
      if (payload && payload.e === "markPriceUpdate") {
        const { s, p, r, T, E } = payload;
        const sym = s ? String(s).toUpperCase() : s;
        if (sym && p != null) lastMarkPriceBySymbol[sym] = parseFloat(p) || 0;
        if (onMarkPriceUpdate && sym && p != null) {
          try {
            onMarkPriceUpdate(sym, parseFloat(p), "binance");
          } catch (e) {
            console.error("[Binance-WS-Error]", e.message);
          }
        }
        if (sym != null) {
          const nextFundingTime = T != null ? Number(T) : null;
          cachedFundingRates[sym] = {
            fundingRate: Number.isFinite(parseFloat(r)) ? parseFloat(r) : 0,
            nextFundingTime,
          };
        }
        if (onFundingUpdate && sym) {
          const now = Date.now();
          const last = lastFundingEmitBySymbol[sym];
          if (last == null || now - last >= FUNDING_THROTTLE_MS) {
            lastFundingEmitBySymbol[sym] = now;
            onFundingUpdate({
              symbol: sym,
              fundingRate: parseFloat(r),
              nextFundingTime: T,
              markPrice: parseFloat(p),
              eventTime: E,
            });
          }
        }
      }
    } catch (e) {
      console.error("[Binance-WS-Error] Failed to parse message:", e.message);
    }
  });

  ws.on("close", (code, reason) => {
    publicWs = null;
    ws.removeAllListeners?.();
    console.log("[Binance] Public WebSocket closed", code, reason?.toString());
    if (!publicStopped) schedulePublicReconnect();
  });

  ws.on("error", (err) => {
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
    const queryString = `timestamp=${timestamp}`;
    const signature = signQueryString(queryString, credentials.apiSecret);
    const fullQuery = `${queryString}&signature=${signature}`;
    const res = await binanceAxios.post(`${REST_BASE}/fapi/v1/listenKey?${fullQuery}`, null, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    listenKey = res.data.listenKey;
  } catch (e) {
    console.error("[Binance] Failed to get listenKey", e.response?.data || e.message);
    return;
  }

  const url = `${PUBLIC_WS_BASE}/ws/${listenKey}`;
  privateWs = new WebSocket(url, { family: 4 });

  privateWs.on("open", () => {
    privateReconnectAttempts = 0;
    console.log("[Binance] Private (user) WebSocket connected");
  });

  privateWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.E) logLatency("binance", "user", msg.E, { e: msg.e });

      // Position state is populated from ACCOUNT_UPDATE (a.P); exit loops read via getLivePositions()
      if (msg.e === "ACCOUNT_UPDATE") {
        const positions = msg?.a?.P;
        if (Array.isArray(positions)) {
          for (const p of positions) {
            const sym = String(p?.s ?? p?.symbol ?? "").toUpperCase();
            const positionSideRaw = String(p?.ps ?? p?.positionSide ?? "BOTH").toUpperCase();
            const positionSide =
              positionSideRaw === "LONG" || positionSideRaw === "SHORT" ? positionSideRaw : "BOTH";
            if (!sym) continue;
            const key = `${sym}:${positionSide}`;
            const pa = parseFloat(p?.pa ?? p?.positionAmt ?? 0);
            if (!Number.isFinite(pa) || pa === 0) {
              delete livePositionsByKey[key];
              if (typeof onPositionClosed === "function") onPositionClosed(sym, "binance");
              continue;
            }
            const existing = livePositionsByKey[key];
            if (existing) {
              existing.positionAmt = pa;
              const rawIw = p?.iw ?? p?.isolatedWallet ?? p?.positionInitialMargin;
              const rawIm = p?.im;
              const marginFromPayload = rawIw != null && String(rawIw).length > 0 ? parseFloat(rawIw) : (rawIm != null && String(rawIm).length > 0 ? parseFloat(rawIm) : NaN);
              if (Number.isFinite(marginFromPayload)) {
                existing.marginUsed = marginFromPayload;
              } else {
                const ep = parseFloat(p?.ep ?? p?.entryPrice ?? 0);
                const lev = p?.l != null ? Number(p.l) : p?.leverage != null ? Number(p.leverage) : null;
                if (Number.isFinite(ep) && ep > 0 && lev != null && lev >= 1) {
                  existing.marginUsed = (Math.abs(pa) * ep) / lev;
                }
              }
              const up = parseFloat(p?.up ?? p?.unRealizedProfit ?? p?.unrealizedProfit ?? 0);
              if (Number.isFinite(up)) existing.unrealizedProfit = up;
              existing.updatedTime = Date.now();
            } else {
              upsertLivePosition(p);
            }
          }
          emitPositionUpdate();
        }
        // Wallet balance: msg.a.B = balances array; USDT = walletBalance (wb). Available not in stream → recompute.
        const balances = msg?.a?.B;
        if (Array.isArray(balances)) {
          const usdt = balances.find((b) => String(b?.a ?? b?.asset ?? "").toUpperCase() === "USDT");
          if (usdt != null) {
            const wb = usdt.wb ?? usdt.walletBalance ?? usdt.availableBalance;
            if (wb != null && String(wb).length > 0) cachedWalletBalance = parseFloat(wb) || 0;
          }
        }
        // Recompute available: margin balance - total margin used (ACCOUNT_UPDATE does not send availableBalance).
        const livePositions = getLivePositions();
        const totalMarginUsed = (livePositions || []).reduce((s, p) => s + (parseFloat(String(p?.marginUsed ?? 0)) || 0), 0);
        const totalUnrealized = (livePositions || []).reduce((s, p) => s + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0), 0);
        const marginBalance = (cachedWalletBalance ?? 0) + totalUnrealized;
        cachedAvailableBalance = Math.max(0, marginBalance - totalMarginUsed);
      } else if (msg.e === "ORDER_TRADE_UPDATE") {
        const o = msg.o || {};
        console.log("[Binance] Order update", {
          symbol: o.s,
          side: o.S,
          status: o.X,
          orderId: o.i,
          filled: o.z,
          avgPrice: o.ap,
          execTime: formatMs(msg.E),
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
    if (privateCredentials) schedulePrivateReconnect();
  });

  privateWs.on("error", (err) => {
    console.error("[Binance] Private WebSocket error", err.message);
    if (privateCredentials) schedulePrivateReconnect();
  });

  listenKeyKeepaliveTimer = setInterval(async () => {
    if (!privateCredentials || !listenKey) return;
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = signQueryString(queryString, privateCredentials.apiSecret);
      const fullQuery = `${queryString}&signature=${signature}`;
      await binanceAxios.put(`${REST_BASE}/fapi/v1/listenKey?${fullQuery}`, null, {
        headers: { "X-MBX-APIKEY": privateCredentials.apiKey },
      });
    } catch (e) {
      console.error("[Binance] ListenKey keepalive failed", e.message);
    }
  }, LISTEN_KEY_KEEPALIVE_MS);
}

/** Global cache: one-time REST fetch at startup. No per-symbol REST. */
let cachedExchangeInfo = null;
let cachedLeverageBrackets = null;
/** Set true after one attempt (success or fail) to avoid 401 retry loop. */
let leverageBracketAttempted = false;
/** Single-flight for the one-time load. */
let exchangeInfoAndLeverageLoadPromise = null;

/** Cache symbol filters (stepSize, tickSize) from cachedExchangeInfo. */
let symbolFiltersCache = {};
/** Single-flight: only one exchangeInfo request in flight to prevent concurrent storms. */
let exchangeInfoFetchPromise = null;

/**
 * One-time load: one GET /fapi/v1/exchangeInfo (public). If credentials provided, one signed GET /fapi/v1/leverageBracket.
 * Never rejects: on failure we log once and resolve so no retry loop.
 */
async function ensureExchangeInfoAndLeverageLoaded(credentials) {
  if (cachedExchangeInfo != null && (cachedLeverageBrackets != null || !(credentials?.apiKey && credentials?.apiSecret) || leverageBracketAttempted)) {
    return;
  }
  if (exchangeInfoAndLeverageLoadPromise) return exchangeInfoAndLeverageLoadPromise;
  exchangeInfoAndLeverageLoadPromise = (async () => {
    if (cachedExchangeInfo == null) {
      try {
        const infoRes = await binanceAxios.get(`${REST_BASE}/fapi/v1/exchangeInfo`);
        const data = infoRes?.data;
        const symbols = (data && data.symbols) || [];
        cachedExchangeInfo = data;
        for (const item of symbols) {
          const s = (item.symbol || "").toUpperCase();
          if (!s) continue;
          if (!item.filters) {
            symbolFiltersCache[s] = { stepSize: null, tickSize: null, maxOrderQty: null, minOrderQty: null };
            continue;
          }
          let stepSize = null;
          let tickSize = null;
          let maxOrderQty = null;
          let minOrderQty = null;
          for (const f of item.filters) {
            if (f.filterType === "LOT_SIZE") {
              stepSize = f.stepSize;
              maxOrderQty = f.maxQty;
              minOrderQty = f.minQty ?? null;
            }
            if (f.filterType === "PRICE_FILTER") tickSize = f.tickSize;
          }
          symbolFiltersCache[s] = { stepSize, tickSize, maxOrderQty, minOrderQty };
        }
      } catch (e) {
        console.warn("[Binance] One-time exchangeInfo load failed:", e.message);
      }
    }
    if (credentials?.apiKey && credentials?.apiSecret && !leverageBracketAttempted) {
      leverageBracketAttempted = true;
      try {
        const timestamp = Date.now();
        const recvWindow = 5000;
        const queryString = "recvWindow=5000&timestamp=" + timestamp;
        const signature = signQueryString(queryString, credentials.apiSecret);
        const bracketRes = await binanceAxios.get(
          REST_BASE + "/fapi/v1/leverageBracket?" + queryString + "&signature=" + signature,
          { headers: { "X-MBX-APIKEY": credentials.apiKey } }
        );
        const bracketData = Array.isArray(bracketRes?.data) ? bracketRes.data : [];
        cachedLeverageBrackets = bracketData;
      } catch (e) {
        console.warn("[Binance] One-time leverageBracket load failed (401 or network):", e.message);
        // Resolve anyway; do not reject so no retry loop.
      }
    }
    exchangeInfoAndLeverageLoadPromise = null;
  })();
  return exchangeInfoAndLeverageLoadPromise;
}

function decimalsFromStep(stepSize) {
  const s = String(stepSize);
  if (!s || s.includes("e")) return 8;
  const i = s.indexOf(".");
  if (i === -1) return 0;
  return s.length - i - 1;
}

/**
 * Round quantity down to stepSize and format per Binance LOT_SIZE.
 */
function formatQuantityToStepSize(quantity, stepSize) {
  const step = parseFloat(stepSize);
  if (!Number.isFinite(step) || step <= 0) return String(quantity);
  const q = parseFloat(quantity);
  if (!Number.isFinite(q) || q <= 0) return String(quantity);
  const precision = decimalsFromStep(stepSize);
  const rounded = Math.floor(q / step) * step;
  return rounded.toFixed(precision);
}

/**
 * Round price to tickSize and format per Binance PRICE_FILTER.
 */
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
 * Fetch exchangeInfo once and fill symbolFiltersCache. Uses one-time ensureExchangeInfoAndLeverageLoaded.
 */
async function fetchAndCacheAllSymbolFilters() {
  await ensureExchangeInfoAndLeverageLoaded();
}

/**
 * Get LOT_SIZE.stepSize and PRICE_FILTER.tickSize for a symbol. From memory cache only; no per-symbol REST.
 */
async function getSymbolFilters(symbol) {
  const sym = String(symbol).toUpperCase();
  if (symbolFiltersCache[sym]) return symbolFiltersCache[sym];
  await ensureExchangeInfoAndLeverageLoaded();
  return symbolFiltersCache[sym] || { stepSize: null, tickSize: null, maxOrderQty: null, minOrderQty: null };
}

/**
 * Get current position mode (Hedge vs One-Way). USER_DATA, signed.
 * @returns {Promise<boolean>} true = Hedge (dualSidePosition), false = One-Way
 */
async function getPositionMode(credentials) {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = signQueryString(queryString, credentials.apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;
  const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/positionSide/dual?${fullQuery}`, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
  return data && data.dualSidePosition === true;
}

/**
 * Set initial leverage for a symbol. USER_DATA, signed. Call before placing order.
 */
async function setLeverage(credentials, symbol, leverage) {
  const timestamp = Date.now();
  const lev = Math.floor(Number(leverage)) || 1;
  const params = {
    symbol: String(symbol).toUpperCase(),
    leverage: Math.max(1, Math.min(125, lev)),
    timestamp,
  };
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;
  await binanceAxios.post(`${REST_BASE}/fapi/v1/leverage?${fullQuery}`, null, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
}

/**
 * Place an IOC limit order on Binance USDT-M Futures via WebSocket API (order.place).
 * Applies stepSize/tickSize precision, position mode (BOTH vs LONG/SHORT), and optional leverage setup.
 * Falls back to REST if WS fails (e.g. connection not ready).
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - BUY | SELL
 * @param {number} quantity - in base/contracts
 * @param {number} price - limit price
 * @param {object} [opts] - { newClientOrderId, positionSide, leverage }
 */
async function placeIOCLimitOrder(credentials, symbol, side, quantity, price, opts = {}) {
  const sym = symbol.toUpperCase();
  const sideNorm = side.toUpperCase();
  if (sideNorm !== "BUY" && sideNorm !== "SELL") {
    throw new Error("side must be BUY or SELL");
  }

  if (opts.leverage != null) {
    try {
      await setLeverage(credentials, sym, opts.leverage);
    } catch (e) {
      console.log(
        `[Binance] Could not set leverage to ${opts.leverage} for ${sym}, proceeding anyway.`,
        e?.message ?? e
      );
    }
  }

  try {
    return await placeWSOrder(credentials, sym, sideNorm, quantity, price, opts);
  } catch (e) {
    console.error("[Binance] placeWSOrder failed", sym, sideNorm, e.message, "- falling back to REST");
    return placeIOCLimitOrderREST(credentials, sym, sideNorm, quantity, price, opts);
  }
}

/**
 * REST fallback for IOC limit order (same contract as previous placeIOCLimitOrder).
 */
async function placeIOCLimitOrderREST(credentials, sym, sideNorm, quantity, price, opts = {}) {
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(quantity, filters.stepSize)
    : String(quantity);
  const priceStr = filters.tickSize
    ? formatPriceToTickSize(price, filters.tickSize)
    : String(price);

  let positionSide = opts.positionSide;
  if (positionSide === undefined) {
    try {
      const isHedge = await getPositionMode(credentials);
      positionSide = isHedge ? (sideNorm === "BUY" ? "LONG" : "SHORT") : "BOTH";
    } catch (e) {
      positionSide = "BOTH";
    }
  }

  const timestamp = Date.now();
  const params = {
    symbol: sym,
    side: sideNorm,
    positionSide: String(positionSide),
    type: "LIMIT",
    timeInForce: "IOC",
    quantity: qtyStr,
    price: priceStr,
    timestamp,
    newOrderRespType: "RESULT", // get avgPrice/executedQty in response when order fills
  };
  if (opts.newClientOrderId != null) params.newClientOrderId = opts.newClientOrderId;
  if (opts.reduceOnly === true) params.reduceOnly = "true";
  if (params.positionSide && (params.positionSide.toUpperCase() === "LONG" || params.positionSide.toUpperCase() === "SHORT")) {
    delete params.reduceOnly; // Binance forbids reduceOnly when positionSide is used (Hedge Mode)
  }

  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;

  const res = await binanceAxios.post(`${REST_BASE}/fapi/v1/order?${fullQuery}`, null, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
  return res.data;
}

/**
 * Futures USDT-M to Spot (internal transfer). Uses Spot API. type=2 = FUTURES to SPOT.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} asset - e.g. USDT
 * @param {number} amount - amount to transfer
 */
async function futuresTransferToSpot(credentials, asset, amount) {
  if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error("Binance credentials required");
  const timestamp = Date.now();
  const params = {
    type: 2, // FUTURES to SPOT
    asset: String(asset || "USDT").toUpperCase(),
    amount: parseFloat(amount) || 0,
    timestamp,
  };
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;
  const { data } = await binanceAxios.post(`${SPOT_REST_BASE}/sapi/v1/futures/transfer?${fullQuery}`, null, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
  return data;
}

/**
 * Withdraw from Spot to external address. Uses Spot API.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} coin - e.g. USDT
 * @param {number} amount - amount to withdraw
 * @param {string} address - destination address
 * @param {string} network - e.g. TRC20, BEP20
 */
async function withdrawSpot(credentials, coin, amount, address, network) {
  if (!credentials?.apiKey || !credentials?.apiSecret) throw new Error("Binance credentials required");
  if (!address || !network) throw new Error("Address and network required");
  const timestamp = Date.now();
  const params = {
    coin: String(coin || "USDT").toUpperCase(),
    amount: parseFloat(amount) || 0,
    address: String(address).trim(),
    network: String(network).trim(),
    timestamp,
  };
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const signature = signQueryString(queryString, credentials.apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;
  const { data } = await binanceAxios.post(`${SPOT_REST_BASE}/sapi/v1/capital/withdraw/apply?${fullQuery}`, null, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  });
  return data;
}

function stop() {
  publicStopped = true;
  if (publicReconnectTimer) {
    clearTimeout(publicReconnectTimer);
    publicReconnectTimer = null;
  }
  if (apiWsReconnectTimer) {
    clearTimeout(apiWsReconnectTimer);
    apiWsReconnectTimer = null;
  }
  if (privateReconnectTimer) {
    clearTimeout(privateReconnectTimer);
    privateReconnectTimer = null;
  }
  if (listenKeyKeepaliveTimer) {
    clearInterval(listenKeyKeepaliveTimer);
    listenKeyKeepaliveTimer = null;
  }
  for (const [id, pending] of pendingRequests) {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    pending.reject(new Error("Binance manager stopped"));
  }
  pendingRequests.clear();
  apiWsConnectPromise = null;
  if (apiWsPingTimer) {
    clearInterval(apiWsPingTimer);
    apiWsPingTimer = null;
  }
  if (apiWs) {
    apiWs.removeAllListeners?.();
    apiWs.close();
    apiWs = null;
  }
  if (privateWs) {
    privateWs.removeAllListeners?.();
    privateWs.close();
    privateWs = null;
  }
  if (publicWs) {
    publicWs.removeAllListeners?.();
    publicWs.close();
    publicWs = null;
  }
  depthWsArray.forEach((w) => {
    try {
      w.removeAllListeners?.();
      w.close();
    } catch (_) {}
  });
  depthWsArray = [];
  listenKey = null;
  privateCredentials = null;
  exchangeInfoFetchPromise = null;
  exchangeInfoAndLeverageLoadPromise = null;
  leverageBracketAttempted = false;
  if (fundingIntervalRefreshTimerId != null) {
    clearInterval(fundingIntervalRefreshTimerId);
    fundingIntervalRefreshTimerId = null;
  }
  cachedWalletBalance = 0;
  Object.keys(cachedFundingRates).forEach((k) => delete cachedFundingRates[k]);
  Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
  Object.keys(lastMarkPriceBySymbol).forEach((k) => delete lastMarkPriceBySymbol[k]);
  Object.keys(bookTickerBySymbol).forEach((k) => delete bookTickerBySymbol[k]);
  Object.keys(topOfBookBySymbol).forEach((k) => delete topOfBookBySymbol[k]);
  Object.keys(orderbooksBySymbol).forEach((k) => delete orderbooksBySymbol[k]);
  console.log("[Binance] Manager stopped");
}

const HYDRATE_RETRY_DELAY_MS = 3000;

/**
 * One-time REST fetch at startup to populate local position state (so dashboard shows positions after restart).
 * Retries once on failure so transient errors (e.g. rate limit) don't leave positions empty.
 */
async function hydratePositionsFromRest(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const list = await getPositionDetails(credentials);
      Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
      for (const p of list || []) {
        const sym = String(p?.symbol || "").toUpperCase();
        const positionAmt = parseFloat(String(p?.positionAmt ?? 0));
        if (!sym || !Number.isFinite(positionAmt) || Math.abs(positionAmt) === 0) continue;
        const posSide = p?.positionSide === "LONG" || p?.positionSide === "SHORT" ? p.positionSide : "BOTH";
        const key = `${sym}:${posSide}`;
        const entryPrice = parseFloat(String(p?.entryPrice ?? 0)) || null;
        const leverage = p?.leverage != null ? Number(p.leverage) : null;
        const liquidationPrice = parseFloat(String(p?.liquidationPrice ?? 0)) || null;
        livePositionsByKey[key] = {
          symbol: sym,
          unrealizedProfit: parseFloat(String(p?.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p?.marginUsed ?? 0)) || 0,
          positionAmt,
          side: p?.side || (positionAmt > 0 ? "BUY" : "SELL"),
          positionSide: posSide,
          entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
          leverage: Number.isFinite(leverage) ? leverage : null,
          liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null,
        };
      }
      emitPositionUpdate();
      if (list?.length > 0) console.log("[Binance] Hydrated", list.length, "positions from REST");
      return;
    } catch (e) {
      console.error("[Binance] Hydrate positions failed (attempt " + attempt + "/2):", e.message || e);
      if (attempt === 1) await new Promise((r) => setTimeout(r, HYDRATE_RETRY_DELAY_MS));
    }
  }
  console.warn("[Binance] Position hydration skipped after retries; dashboard may show no positions until WS updates.");
}

async function start(credentials, options = {}) {
  publicStopped = false;
  publicReconnectAttempts = 0;
  await syncFundingIntervals();
  await ensureExchangeInfoAndLeverageLoaded(credentials);
  if (fundingIntervalRefreshTimerId != null) clearInterval(fundingIntervalRefreshTimerId);
  fundingIntervalRefreshTimerId = setInterval(syncFundingIntervals, 15 * 60 * 1000);
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  await startPrivateStream(credentials);
  await hydratePositionsFromRest(credentials);
  if (credentials?.apiKey && credentials?.apiSecret) {
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = signQueryString(queryString, credentials.apiSecret);
      const fullQuery = `${queryString}&signature=${signature}`;
      const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/account?${fullQuery}`, {
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      });
      const total = data?.totalWalletBalance;
      if (total != null && String(total).length > 0) {
        cachedWalletBalance = parseFloat(total) || 0;
      } else {
        const assets = Array.isArray(data?.assets) ? data.assets : [];
        const usdt = assets.find((b) => (b.asset || "").toUpperCase() === "USDT");
        const bal = usdt?.walletBalance ?? usdt?.availableBalance ?? 0;
        cachedWalletBalance = parseFloat(bal) || 0;
      }
      const avail = parseFloat(data?.availableBalance ?? 0);
      if (Number.isFinite(avail)) {
        cachedAvailableBalance = avail;
      } else {
        const assets = Array.isArray(data?.assets) ? data.assets : [];
        const usdt = assets.find((b) => (b.asset || "").toUpperCase() === "USDT");
        const ab = usdt?.availableBalance ?? 0;
        cachedAvailableBalance = parseFloat(ab) || 0;
      }
    } catch (e) {
      console.warn("[Binance] One-time balance hydration failed:", e.message);
    }
  }
}

/**
 * Get mark price from WebSocket cache (markPriceUpdate stream). No REST.
 */
function getMarkPrice(symbol) {
  const s = String(symbol || "").toUpperCase();
  const v = lastMarkPriceBySymbol[s];
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Get funding rate from WebSocket cache (markPriceUpdate stream). No REST.
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
 * Get max leverage for symbol from one-time cached leverageBracket. No per-symbol REST.
 */
async function getMaxLeverage(symbol) {
  await ensureExchangeInfoAndLeverageLoaded();
  const sym = String(symbol).toUpperCase();
  if (!Array.isArray(cachedLeverageBrackets)) return null;
  const entry = cachedLeverageBrackets.find((e) => (e.symbol || "").toUpperCase() === sym);
  const brackets = entry?.brackets;
  if (!brackets || !brackets.length) return null;
  return Math.max(...brackets.map((b) => b.initialLeverage));
}

/**
 * Get all USDT-margined perpetual symbols from one-time cached exchangeInfo. No REST loop.
 * @returns {Promise<string[]>} e.g. ["BTCUSDT", "ETHUSDT", ...]
 */
async function getPerpetualSymbols() {
  await ensureExchangeInfoAndLeverageLoaded();
  const symbols = (cachedExchangeInfo && cachedExchangeInfo.symbols) || [];
  return symbols
    .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map((s) => s.symbol);
}

/**
 * Single bulk GET /fapi/v1/fundingInfo (weight 1). Populates fundingIntervalCache. Safe from bans.
 * Called at start() and every 15 minutes to keep intervals immortal.
 */
async function syncFundingIntervals() {
  try {
    const response = await binanceAxios.get(`${REST_BASE}/fapi/v1/fundingInfo`);
    const data = response?.data;
    if (!Array.isArray(data)) return;
    data.forEach((item) => {
      const sym = (item.symbol || "").toUpperCase().trim();
      // Binance returns fundingIntervalHours directly
      fundingIntervalCache[sym] = parseInt(item.fundingIntervalHours, 10) || 8;
    });
  } catch (err) {
    console.error("[Binance] Failed to sync funding intervals:", err?.message || err);
  }
}

/**
 * Get funding interval hours (1, 2, 4, or 8) from cache. Default 8 if symbol not in cache.
 */
function getFundingIntervalHours(symbol) {
  return fundingIntervalCache[(symbol || "").toUpperCase().trim()] || 8;
}

/**
 * Get funding interval in hours. Same as getFundingIntervalHours; alias for exchange-agnostic use.
 */
function getFundingInterval(symbol) {
  return getFundingIntervalHours(symbol);
}

/**
 * Fetch premium index (mark price, last funding rate, next funding time) for all symbols.
 * Public endpoint. Used on startup to prefill funding state and compute funding interval.
 * @returns {Promise<Array<{ symbol: string, nextFundingTime: number, lastFundingRate: number, markPrice: number }>>}
 */
async function getPremiumIndex() {
  try {
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/premiumIndex`);
    const list = Array.isArray(data) ? data : [];
    return list.map((item) => {
      const symbol = String(item.symbol || "").toUpperCase();
      const nextFundingTime = item.nextFundingTime != null ? Number(item.nextFundingTime) : null;
      const lastFundingRate = item.lastFundingRate != null ? parseFloat(item.lastFundingRate) : 0;
      const markPrice = item.markPrice != null ? parseFloat(item.markPrice) : 0;
      const eventTime = item.time != null ? Number(item.time) : null;
      return { symbol, nextFundingTime, lastFundingRate, markPrice, eventTime };
    }).filter((r) => r.symbol);
  } catch (e) {
    console.warn("[Binance] getPremiumIndex failed", e.message);
    return [];
  }
}

/**
 * Pure function: map (nextFundingTime - eventTime) / 3600000 to interval bucket 1, 2, 4, or 8.
 */
function intervalHoursFromHoursUntilNext(hoursUntilNext) {
  if (hoursUntilNext == null || !Number.isFinite(hoursUntilNext) || hoursUntilNext <= 0) return 8;
  if (hoursUntilNext <= 1.5) return 1;
  if (hoursUntilNext <= 3.0) return 2;
  if (hoursUntilNext <= 5.5) return 4;
  return 8;
}

/**
 * Throttled REST fetch for availableBalance (max once per AVAILABLE_BALANCE_CACHE_TTL_MS). Fire-and-forget.
 */
function refreshAvailableBalanceInBackground(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret || availableBalanceFetchInFlight) return;
  availableBalanceFetchInFlight = true;
  (async () => {
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = signQueryString(queryString, credentials.apiSecret);
      const fullQuery = `${queryString}&signature=${signature}`;
      const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/account?${fullQuery}`, {
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      });
      const avail = parseFloat(data?.availableBalance ?? 0);
      if (Number.isFinite(avail)) {
        cachedAvailableBalance = avail;
      } else {
        const assets = Array.isArray(data?.assets) ? data.assets : [];
        const usdt = assets.find((b) => (b.asset || "").toUpperCase() === "USDT");
        const ab = usdt?.availableBalance ?? 0;
        cachedAvailableBalance = parseFloat(ab) || 0;
      }
    } catch (e) {
      console.warn("[Binance] Throttled availableBalance fetch failed:", e?.message ?? e);
    } finally {
      availableBalanceFetchInFlight = false;
    }
  })();
}

/**
 * Get Binance balance and available (free) balance from cache. Triggers throttled REST (every 15s) for accurate availableBalance.
 * Prefer cachedAvailableBalance from REST/ACCOUNT_UPDATE when set; else compute as marginBalance - totalMarginUsed.
 * @returns {{ balance: number, availableBalance: number }} balance = margin balance (wallet + unrealized PnL); availableBalance = free to open new positions
 */
function getBalance(credentials) {
  const now = Date.now();
  if (credentials?.apiKey && credentials?.apiSecret && now - lastAvailableBalanceRestTime >= AVAILABLE_BALANCE_CACHE_TTL_MS) {
    lastAvailableBalanceRestTime = now;
    refreshAvailableBalanceInBackground(credentials);
  }
  const wallet = cachedWalletBalance ?? 0;
  const positions = getLivePositions();
  const totalUnrealized = (positions || []).reduce(
    (sum, p) => sum + (parseFloat(String(p?.unrealizedProfit ?? 0)) || 0),
    0
  );
  const balance = wallet + totalUnrealized;
  const totalMarginUsed = (positions || []).reduce((s, p) => s + (parseFloat(String(p?.marginUsed ?? 0)) || 0), 0);
  const computedAvailable = Math.max(0, balance - totalMarginUsed);
  const availableBalance =
    cachedAvailableBalance != null && Number.isFinite(cachedAvailableBalance) && cachedAvailableBalance >= 0
      ? cachedAvailableBalance
      : computedAvailable;
  return { balance, availableBalance };
}

/**
 * Fetch account balances from REST (equity = totalMarginBalance = wallet + unrealized PnL).
 * @param {object} credentials - { apiKey, apiSecret }
 * @returns {Promise<{ totalMarginBalance: number, totalWalletBalance: number, availableBalance: number }>}
 */
async function getBalances(credentials) {
  const out = { totalMarginBalance: 0, totalWalletBalance: 0, availableBalance: 0 };
  if (!credentials?.apiKey || !credentials?.apiSecret) return out;
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = signQueryString(queryString, credentials.apiSecret);
    const fullQuery = `${queryString}&signature=${signature}`;
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/account?${fullQuery}`, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const totalWallet = parseFloat(data?.totalWalletBalance ?? 0) || 0;
    const available = parseFloat(data?.availableBalance ?? 0) || 0;
    const totalMargin = parseFloat(data?.totalMarginBalance ?? 0) || 0;
    const totalUnrealized = parseFloat(data?.totalUnrealizedProfit ?? 0) || 0;
    out.totalWalletBalance = totalWallet;
    out.availableBalance = available;
    out.totalMarginBalance = totalMargin > 0 ? totalMargin : totalWallet + totalUnrealized;
  } catch (e) {
    console.warn("[Binance] getBalances failed:", e?.message ?? e);
  }
  return out;
}

/**
 * Get open position symbols (positionAmt !== 0). USER_DATA, signed.
 * @returns {Promise<string[]>} symbols with open position
 */
async function getPositionSymbols(credentials) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = signQueryString(queryString, credentials.apiSecret);
    const fullQuery = `${queryString}&signature=${signature}`;
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/positionRisk?${fullQuery}`, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const list = Array.isArray(data) ? data : [];
    return list
      .filter((p) => {
        const amt = parseFloat(String(p.positionAmt ?? 0));
        return Number.isFinite(amt) && Math.abs(amt) > 0;
      })
      .map((p) => String(p.symbol || "").toUpperCase())
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Get position details for PnL/margin: unrealizedProfit, marginUsed, positionAmt, side. USER_DATA, signed.
 * @returns {Promise<Array<{ symbol: string, unrealizedProfit: number, marginUsed: number, positionAmt: number, side: string }>>}
 */
async function getPositionDetails(credentials) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = signQueryString(queryString, credentials.apiSecret);
    const fullQuery = `${queryString}&signature=${signature}`;
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/positionRisk?${fullQuery}`, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const list = Array.isArray(data) ? data : [];
    return list
      .filter((p) => {
        const amt = parseFloat(String(p.positionAmt ?? 0));
        return Number.isFinite(amt) && Math.abs(amt) > 0;
      })
      .map((p) => {
        const amt = parseFloat(String(p.positionAmt ?? 0));
        const posSide = (p.positionSide || "BOTH").toUpperCase();
        const entryPrice = parseFloat(String(p.entryPrice ?? 0)) || null;
        const leverage = p.leverage != null ? Number(p.leverage) : null;
        const liquidationPrice = parseFloat(String(p.liquidationPrice ?? 0)) || null;
        return {
          symbol: String(p.symbol || "").toUpperCase(),
          unrealizedProfit: parseFloat(String(p.unRealizedProfit ?? p.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p.initialMargin ?? (p.marginType === "isolated" ? p.isolatedWallet : 0))) || 0,
          positionAmt: amt,
          side: amt > 0 ? "BUY" : "SELL",
          positionSide: posSide === "LONG" || posSide === "SHORT" ? posSide : "BOTH",
          entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
          leverage: Number.isFinite(leverage) ? leverage : null,
          liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null,
        };
      })
      .filter((p) => p.symbol);
  } catch (e) {
    return [];
  }
}

/**
 * Close position with a market order via WebSocket only (zero REST). Reduce-only.
 * Hedge mode: positionSide (LONG/SHORT) is strictly passed.
 */
async function placeMarketCloseOrder(credentials, symbol, side, quantity, opts = {}) {
  return placeWSMarketOrder(credentials, symbol, side, Math.abs(quantity), {
    positionSide: opts.positionSide,
  });
}

const DEFAULT_SLIPPAGE_PCT = 0.1;

/**
 * Get best bid/ask from WebSocket bookTicker cache (L2 top of book). Returns null if not available.
 * @param {string} symbol
 * @returns {{ bestBid: number, bestBidQty: number, bestAsk: number, bestAskQty: number } | null}
 */
function getBestBidAsk(symbol) {
  const sym = String(symbol).toUpperCase();
  const book = bookTickerBySymbol[sym];
  if (!book || !Number.isFinite(book.bestBid) || !Number.isFinite(book.bestAsk)) return null;
  return book;
}

/**
 * Get top of book for liquidity sweep: topBidPrice, topBidQty (SELL), topAskPrice, topAskQty (BUY).
 * Uses live L2 state from !bookTicker (topOfBookBySymbol). No REST.
 */
function getTopOfBook(symbol) {
  const sym = String(symbol).toUpperCase();
  const top = topOfBookBySymbol[sym];
  if (!top || !Number.isFinite(top.topBidPrice) || !Number.isFinite(top.topAskPrice)) return null;
  return top;
}

/**
 * VWAP for a target notional (USD) from depth orderbook. BUY = consume asks (asc), SELL = consume bids (desc).
 * Returns VWAP of whatever depth is available even if below targetNotional (never null if any level exists).
 * @param {string} symbol
 * @param {string} side - 'BUY' | 'SELL'
 * @param {number} targetNotional - USD notional to fill
 * @returns {number|null} VWAP price or null if no depth
 */
function getVwapPrice(symbol, side, targetNotional) {
  const sym = String(symbol).toUpperCase();
  const book = orderbooksBySymbol[sym];
  if (!book || !targetNotional || targetNotional <= 0) return null;
  const isBuy = String(side).toUpperCase() === "BUY";
  let levels = isBuy ? (book.asks || []) : (book.bids || []);
  levels = levels.map((x) => [parseFloat(x[0]), parseFloat(x[1])]).filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0);
  if (isBuy) levels.sort((a, b) => a[0] - b[0]);
  else levels.sort((a, b) => b[0] - a[0]);
  if (levels.length === 0) return null;
  let accumulatedQty = 0;
  let accumulatedNotional = 0;
  for (let i = 0; i < levels.length; i++) {
    const price = levels[i][0];
    const qty = levels[i][1];
    const levelNotional = price * qty;
    if (accumulatedNotional + levelNotional >= targetNotional) {
      const neededNotional = targetNotional - accumulatedNotional;
      const neededQty = neededNotional / price;
      accumulatedQty += neededQty;
      accumulatedNotional = targetNotional;
      break;
    } else {
      accumulatedQty += qty;
      accumulatedNotional += levelNotional;
    }
  }
  if (accumulatedQty === 0) return null;
  return accumulatedNotional / accumulatedQty;
}

const SWEEP_SLEEP_MS = 20;

/**
 * Dynamic L2 liquidity sweep (iceberg): while loop, place IOC chunks at live top-of-book via placeWSOrder.
 * Uses getTopOfBook only; if missing, fallback to standard pricing and place one order then break.
 * @param {object} credentials - { apiKey, apiSecret }
 * @param {string} symbol - e.g. BTCUSDT
 * @param {string} side - BUY | SELL
 * @param {number} totalQtyRemaining - quantity left to fill
 * @param {number} leverage - leverage for the order
 * @param {number} [maxIterations=10] - max chunks per sweep
 * @param {object} [opts={}] - { reduceOnly: true, positionSide: 'LONG'|'SHORT' } for exits
 * @returns {Promise<{ totalFilled: number }>}
 */
async function executeLiquiditySweep(credentials, symbol, side, totalQtyRemaining, leverage, maxIterations = 10, opts = {}) {
  const sym = String(symbol).toUpperCase();
  const sideNorm = String(side).toUpperCase();
  if (sideNorm !== "BUY" && sideNorm !== "SELL") {
    return { totalFilled: 0 };
  }
  if (totalQtyRemaining <= 0 || maxIterations <= 0) {
    return { totalFilled: 0 };
  }

  await connectApiWs();
  // Leverage must be set once per symbol by the caller before starting the sweep; not set here to avoid repeated REST per chunk.

  const filters = await getSymbolFilters(sym);
  const stepSize = filters?.stepSize ?? null;
  let totalFilled = 0;

  while (totalQtyRemaining > 0 && maxIterations > 0) {
    const topOfBook = getTopOfBook(sym);
    let targetPrice;
    let availableQty;

    if (topOfBook && Number.isFinite(topOfBook.topBidPrice) && Number.isFinite(topOfBook.topAskPrice)) {
      const isBuy = sideNorm === "BUY";
      targetPrice = isBuy ? topOfBook.topAskPrice : topOfBook.topBidPrice;
      availableQty = isBuy ? (topOfBook.topAskQty ?? 0) : (topOfBook.topBidQty ?? 0);
    } else {
      targetPrice = getOrderbookPrice(sym, sideNorm);
      if (targetPrice == null || !Number.isFinite(targetPrice)) break;
      availableQty = null;
    }

    // 0.1% buffer to prevent IOC minimum notional ping-pong expiration
    let bufferedPrice = targetPrice;
    if (sideNorm.toUpperCase() === "BUY") {
      bufferedPrice = targetPrice * 1.001;
    } else {
      bufferedPrice = targetPrice * 0.999;
    }
    if (filters?.tickSize) {
      bufferedPrice = parseFloat(formatPriceToTickSize(bufferedPrice, filters.tickSize)) || bufferedPrice;
    }

    let chunkQty = availableQty != null && Number.isFinite(availableQty) && availableQty > 0
      ? Math.min(totalQtyRemaining, availableQty * 0.5)
      : totalQtyRemaining;
    if (stepSize) {
      chunkQty = parseFloat(formatQuantityToStepSize(chunkQty, stepSize)) || 0;
    }

    const minQty = filters?.minOrderQty ? parseFloat(filters.minOrderQty) : 0;
    if (chunkQty < minQty && totalQtyRemaining >= minQty) {
      chunkQty = minQty;
    } else if (chunkQty < minQty && totalQtyRemaining < minQty) {
      chunkQty = totalQtyRemaining;
    }

    // Force minimum notional of $5 (using $5.1 to be safe) for Binance
    const chunkValue = chunkQty * targetPrice;
    const minNotional = 5.1;

    if (chunkQty > 0 && chunkValue < minNotional) {
      const requiredQty = minNotional / targetPrice;
      if (stepSize) {
        const step = parseFloat(stepSize);
        const steps = Math.ceil(requiredQty / step);
        chunkQty = parseFloat((steps * step).toFixed(10));
      } else {
        chunkQty = requiredQty;
      }
      console.log(`[Binance Sweeper] Chunk value ($${chunkValue.toFixed(2)}) is below $5. Adjusted chunkQty to ${chunkQty} to meet Binance's minimum notional.`);
    }

    if (chunkQty <= 0) break;

    const orderOpts = { timeInForce: "IOC", leverage, ...opts };
    let res;
    try {
      res = await placeWSOrder(credentials, sym, sideNorm, chunkQty, bufferedPrice, orderOpts);
    } catch (e) {
      console.error("[Binance] executeLiquiditySweep placeWSOrder failed", sym, e?.message ?? e);
      return { totalFilled, error: e?.message || "Order failed" };
    }
    console.log("[Binance] executeLiquiditySweep order placed", {
      sym,
      orderId: res?.orderId,
      execTime: formatMs(res?.updateTime ?? Date.now()),
    });

    const filledQty = Number.isFinite(parseFloat(res?.executedQty)) ? parseFloat(res.executedQty) : 0;
    totalQtyRemaining -= filledQty;
    totalFilled += filledQty;
    maxIterations -= 1;

    if (availableQty == null) break;
    await new Promise((r) => setTimeout(r, SWEEP_SLEEP_MS));
  }

  return { totalFilled };
}

/**
 * Get limit price for IOC from real best bid/ask (WebSocket bookTicker). Fallback to mark ± slippage if no book.
 * BUY: Best Ask * (1 + slippagePct/100). SELL: Best Bid * (1 - slippagePct/100).
 * @param {string} symbol
 * @param {string} side - BUY | SELL
 * @param {number} [slippagePct=0.1] - slippage in percent (e.g. 0.1 = 0.1%)
 */
function getOrderbookPrice(symbol, side, slippagePct = DEFAULT_SLIPPAGE_PCT) {
  const sym = String(symbol).toUpperCase();
  const pct = Number.isFinite(slippagePct) ? Math.max(0, Math.min(100, slippagePct)) : DEFAULT_SLIPPAGE_PCT;
  const isBuy = String(side).toUpperCase() === "BUY";
  const book = bookTickerBySymbol[sym];
  if (book && Number.isFinite(book.bestBid) && Number.isFinite(book.bestAsk) && book.bestBid > 0 && book.bestAsk > 0) {
    return isBuy ? book.bestAsk * (1 + pct / 100) : book.bestBid * (1 - pct / 100);
  }
  const mark = lastMarkPriceBySymbol[sym];
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  return isBuy ? mark * (1 + pct / 100) : mark * (1 - pct / 100);
}

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  placeWSOrder,
  prepareOrderPayload,
  executeWSTrade,
  connectApiWs,
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
  getMaxLeverage,
  getPerpetualSymbols,
  getFundingInterval,
  getFundingIntervalHours,
  getPremiumIndex,
  syncFundingIntervals,
  intervalHoursFromHoursUntilNext,
  getOrderbookPrice,
  getBestBidAsk,
  getTopOfBook,
  getVwapPrice,
  executeLiquiditySweep,
  getBalance,
  getBalances,
  getPositionSymbols,
  getPositionDetails,
  getSymbolFilters,
  setLeverage,
  hydratePositionsFromRest,
  futuresTransferToSpot,
  withdrawSpot,
};
