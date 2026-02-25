const WebSocket = require("ws");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const { logLatency } = require("./latencyTracker");

const PUBLIC_WS_BASE = "wss://fstream.binance.com";
const WS_FAPI_BASE = "wss://ws-fapi.binance.com/ws-fapi/v1";
const REST_BASE = "https://fapi.binance.com";

/** If x-mbx-used-weight-1m exceeds this, all Binance REST requests pause for 60s to avoid IP ban. */
const BINANCE_WEIGHT_LIMIT = 2000;
const BINANCE_WEIGHT_PAUSE_MS = 60000;
let binanceRestPausedUntil = 0;

const binanceAxios = axios.create();
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
/** Pending WS API requests: id -> { resolve, reject, timeoutId } */
const pendingRequests = new Map();
let apiWsConnectPromise = null;
let apiWsReconnectAttempts = 0;
let apiWsReconnectTimer = null;

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
  const side = positionSide === "LONG" ? "BUY" : positionSide === "SHORT" ? "SELL" : amt > 0 ? "BUY" : "SELL";
  livePositionsByKey[key] = {
    symbol: sym,
    unrealizedProfit: parseFloat(raw?.up ?? raw?.unRealizedProfit ?? raw?.unrealizedProfit ?? 0) || 0,
    marginUsed: parseFloat(raw?.iw ?? raw?.isolatedWallet ?? raw?.positionInitialMargin ?? 0) || 0,
    positionAmt: amt,
    side,
    positionSide,
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
    const ws = new WebSocket(WS_FAPI_BASE);
    apiWs = ws;
    ws.on("open", () => {
      console.log("[Binance] WS-FAPI (order API) connected");
      apiWsReconnectAttempts = 0;
      apiWsConnectPromise = null;
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
  };
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

function openPublicStreams(symbols = DEFAULT_SYMBOLS) {
  if (publicStopped) return;
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  publicStreamSymbols = symbols;
  const list = symbols.slice(0, MAX_STREAMS_PER_CONNECTION);
  const streams = list.map((s) => `${s.toLowerCase()}@markPrice@1s`);
  const url = `${PUBLIC_WS_BASE}/stream?streams=${streams.join("/")}`;

  const ws = new WebSocket(url);
  publicWs = ws;

  ws.on("open", () => {
    publicReconnectAttempts = 0;
    console.log("[Binance] Public WebSocket connected");
  });

  ws.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString());
      const stream = raw.stream || "";
      const payload = raw.data || raw;

      if (payload.E) {
        logLatency("binance", stream || payload.e || "public", payload.E, { s: payload.s });
      }

      if (payload.e === "markPriceUpdate") {
        const { s, p, r, T, E } = payload;
        if (!onFundingUpdate || !s) return;
        const now = Date.now();
        const last = lastFundingEmitBySymbol[s];
        if (last != null && now - last < FUNDING_THROTTLE_MS) return;
        lastFundingEmitBySymbol[s] = now;
        onFundingUpdate({
          symbol: s,
          fundingRate: parseFloat(r),
          nextFundingTime: T,
          markPrice: parseFloat(p),
          eventTime: E,
        });
      }
    } catch (e) {
      console.error("[Binance] Public message parse error", e.message);
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
  privateWs = new WebSocket(url);

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
          for (const p of positions) upsertLivePosition(p);
          emitPositionUpdate();
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

/** Cache symbol filters (stepSize, tickSize) from exchangeInfo. */
let symbolFiltersCache = {};
/** Single-flight: only one exchangeInfo request in flight to prevent concurrent storms. */
let exchangeInfoFetchPromise = null;

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
 * Fetch exchangeInfo once and fill symbolFiltersCache for all symbols. Single-flight to prevent concurrent storms.
 */
async function fetchAndCacheAllSymbolFilters() {
  if (exchangeInfoFetchPromise) return exchangeInfoFetchPromise;
  exchangeInfoFetchPromise = (async () => {
    try {
      const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/exchangeInfo`);
      const symbols = (data && data.symbols) || [];
      for (const item of symbols) {
        const s = (item.symbol || "").toUpperCase();
        if (!s) continue;
        if (!item.filters) {
          symbolFiltersCache[s] = { stepSize: null, tickSize: null, maxOrderQty: null };
          continue;
        }
        let stepSize = null;
        let tickSize = null;
        let maxOrderQty = null;
        for (const f of item.filters) {
          if (f.filterType === "LOT_SIZE") {
            stepSize = f.stepSize;
            maxOrderQty = f.maxQty;
          }
          if (f.filterType === "PRICE_FILTER") tickSize = f.tickSize;
        }
        symbolFiltersCache[s] = { stepSize, tickSize, maxOrderQty };
      }
    } catch (e) {
      console.warn("[Binance] exchangeInfo fetch failed", e.message);
    } finally {
      exchangeInfoFetchPromise = null;
    }
  })();
  return exchangeInfoFetchPromise;
}

/**
 * Get LOT_SIZE.stepSize and PRICE_FILTER.tickSize for a symbol. Cached; single-flight for exchangeInfo.
 */
async function getSymbolFilters(symbol) {
  const sym = String(symbol).toUpperCase();
  if (symbolFiltersCache[sym]) return symbolFiltersCache[sym];
  await fetchAndCacheAllSymbolFilters();
  return symbolFiltersCache[sym] || { stepSize: null, tickSize: null, maxOrderQty: null };
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
      console.error("[Binance] setLeverage failed", sym, "leverage", opts.leverage, "response:", e.response?.data);
      throw e;
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
  };
  if (opts.newClientOrderId != null) params.newClientOrderId = opts.newClientOrderId;

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
  listenKey = null;
  privateCredentials = null;
  exchangeInfoFetchPromise = null;
  Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
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
        livePositionsByKey[key] = {
          symbol: sym,
          unrealizedProfit: parseFloat(String(p?.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p?.marginUsed ?? 0)) || 0,
          positionAmt,
          side: p?.side || (positionAmt > 0 ? "BUY" : "SELL"),
          positionSide: posSide,
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
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  await startPrivateStream(credentials);
  await hydratePositionsFromRest(credentials);
}

/**
 * Fetch last funding time (ms) for interval calculation. Public endpoint.
 */
async function getLastFundingTime(symbol) {
  const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/fundingRate`, {
    params: { symbol: symbol.toUpperCase(), limit: 1 },
  });
  const item = Array.isArray(data) && data.length ? data[0] : null;
  return item ? item.fundingTime : null;
}

/**
 * Fetch max leverage for symbol. Public endpoint.
 */
async function getMaxLeverage(symbol) {
  const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/leverageBracket`, {
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
  const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/exchangeInfo`);
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
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/fundingInfo`);
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
      return { symbol, nextFundingTime, lastFundingRate, markPrice };
    }).filter((r) => r.symbol);
  } catch (e) {
    console.warn("[Binance] getPremiumIndex failed", e.message);
    return [];
  }
}

/**
 * Map (nextFundingTime - now) / 3600000 (hours until next funding) to interval bucket 1, 2, 4, or 8.
 * Used to derive display interval from premium index on startup.
 */
function intervalHoursFromHoursUntilNext(hoursUntilNext) {
  if (hoursUntilNext == null || !Number.isFinite(hoursUntilNext) || hoursUntilNext <= 0) return 8;
  if (hoursUntilNext <= 1) return 1;
  if (hoursUntilNext <= 2) return 2;
  if (hoursUntilNext <= 4) return 4;
  return 8;
}

/**
 * Get total USDT wallet balance (including used margin / unrealized PnL). USER_DATA, signed.
 * Uses /fapi/v2/account and totalWalletBalance (or USDT asset walletBalance).
 * @returns {Promise<number>} total wallet balance or 0 on error
 */
async function getBalance(credentials) {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = signQueryString(queryString, credentials.apiSecret);
    const fullQuery = `${queryString}&signature=${signature}`;
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v2/account?${fullQuery}`, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const total = data?.totalWalletBalance;
    if (total != null && String(total).length > 0) return parseFloat(total) || 0;
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    const usdt = assets.find((b) => (b.asset || "").toUpperCase() === "USDT");
    const bal = usdt?.walletBalance ?? usdt?.availableBalance ?? 0;
    return parseFloat(bal) || 0;
  } catch (e) {
    return 0;
  }
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
        return {
          symbol: String(p.symbol || "").toUpperCase(),
          unrealizedProfit: parseFloat(String(p.unRealizedProfit ?? p.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p.initialMargin ?? (p.marginType === "isolated" ? p.isolatedWallet : 0))) || 0,
          positionAmt: amt,
          side: amt > 0 ? "BUY" : "SELL",
          positionSide: posSide === "LONG" || posSide === "SHORT" ? posSide : "BOTH",
        };
      })
      .filter((p) => p.symbol);
  } catch (e) {
    return [];
  }
}

/**
 * Close position with a market order (reduce-only).
 * Hedge mode: MUST send positionSide (LONG with side SELL, or SHORT with side BUY). Binance returns 400 if missing.
 * @param {object} credentials
 * @param {string} symbol
 * @param {string} side - BUY or SELL (close side: SELL to close long, BUY to close short)
 * @param {number} quantity - absolute size to close
 * @param {{ positionSide?: string }} [opts] - positionSide from position (LONG | SHORT); required in hedge mode
 */
async function placeMarketCloseOrder(credentials, symbol, side, quantity, opts = {}) {
  const sym = symbol.toUpperCase();
  const sideNorm = side.toUpperCase();
  const filters = await getSymbolFilters(sym);
  const qtyStr = filters.stepSize
    ? formatQuantityToStepSize(Math.abs(quantity), filters.stepSize)
    : String(Math.abs(quantity));

  let positionSide = opts.positionSide;
  if (positionSide !== "LONG" && positionSide !== "SHORT") {
    try {
      const isHedge = await getPositionMode(credentials);
      positionSide = isHedge ? (sideNorm === "SELL" ? "LONG" : "SHORT") : "BOTH";
    } catch (_) {
      positionSide = sideNorm === "SELL" ? "LONG" : "SHORT";
    }
  }

  const timestamp = Date.now();
  const params = {
    symbol: sym,
    side: sideNorm,
    positionSide,
    type: "MARKET",
    quantity: qtyStr,
    reduceOnly: "true",
    timestamp,
  };
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
 * Fetch orderbook depth (limit=5) and return aggressive limit price for IOC.
 * BUY (Long): use 2nd row of asks (index 1). SELL (Short): use 2nd row of bids (index 1).
 * Falls back to 1st row if 2nd is missing. Returns null on error.
 */
async function getOrderbookPrice(symbol, side) {
  try {
    const { data } = await binanceAxios.get(`${REST_BASE}/fapi/v1/depth`, {
      params: { symbol: String(symbol).toUpperCase(), limit: 5 },
    });
    const asks = data?.asks || [];
    const bids = data?.bids || [];
    const isBuy = String(side).toUpperCase() === "BUY";
    if (isBuy && asks.length > 0) {
      const row = asks[1] || asks[0];
      return row && row[0] ? parseFloat(row[0]) : null;
    }
    if (!isBuy && bids.length > 0) {
      const row = bids[1] || bids[0];
      return row && row[0] ? parseFloat(row[0]) : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  placeWSOrder,
  placeMarketCloseOrder,
  getCredentials: () => privateCredentials,
  setOnFundingUpdate,
  setOnPositionUpdate,
  setOnPositionClosed,
  getLivePositions,
  getLastFundingTime,
  getMaxLeverage,
  getPerpetualSymbols,
  getFundingIntervalHours,
  getPremiumIndex,
  intervalHoursFromHoursUntilNext,
  getOrderbookPrice,
  getBalance,
  getPositionSymbols,
  getPositionDetails,
  getSymbolFilters,
};
