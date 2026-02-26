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
const { logLatency } = require("./latencyTracker");

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

let publicWs = null;
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
  const rawSize = raw?.size;
  const size = rawSize != null ? parseFloat(rawSize) : (existing != null ? parseFloat(existing.positionAmt) : NaN);
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
  livePositionsByKey[key] = {
    symbol: sym,
    unrealizedProfit: Number.isFinite(unrealizedProfit) ? unrealizedProfit : 0,
    marginUsed: Number.isFinite(marginUsed) ? marginUsed : 0,
    positionAmt: size,
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
      } catch (e) {
        console.error("[Bybit] Trade WS message parse error", e.message);
      }
    });
    ws.on("close", (code, reason) => {
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
  if (publicWs && publicWs.readyState === WebSocket.OPEN) return;

  publicStreamSymbols = symbols;
  const ws = new WebSocket(PUBLIC_WS_URL, { family: 4 });
  publicWs = ws;

  ws.on("open", () => {
    publicReconnectAttempts = 0;
    console.log("[Bybit] Public WebSocket connected");
    const args = symbols.map((s) => `tickers.${s}`);
    ws.send(JSON.stringify({ op: "subscribe", args }));
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
            const mp = parseFloat(d.markPrice || d.lastPrice || 0);
            if (Number.isFinite(mp) && mp > 0) lastMarkPriceBySymbol[sym] = mp;
            if (onMarkPriceUpdate && Number.isFinite(mp) && mp > 0) {
              try {
                onMarkPriceUpdate(sym, mp, "bybit");
              } catch (e) {
                console.error("[Bybit] onMarkPriceUpdate error", e.message);
              }
            }
            cachedFundingRates[sym] = {
              fundingRate: Number.isFinite(parseFloat(d.fundingRate)) ? parseFloat(d.fundingRate) : 0,
              nextFundingTime: d.nextFundingTime != null ? Number(d.nextFundingTime) : null,
            };
            if (!onFundingUpdate) continue;
            const now = Date.now();
            const last = lastFundingEmitBySymbol[sym];
            if (last != null && now - last < FUNDING_THROTTLE_MS) continue;
            lastFundingEmitBySymbol[sym] = now;
            onFundingUpdate({
              symbol: d.symbol,
              fundingRate: parseFloat(d.fundingRate || 0),
              nextFundingTime: d.nextFundingTime ? Number(d.nextFundingTime) : null,
              markPrice: mp,
              eventTime: d.timestamp ? Number(d.timestamp) : msg.ts,
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

  ws.on("close", (code, reason) => {
    publicWs = null;
    ws.removeAllListeners?.();
    console.log("[Bybit] Public WebSocket closed", code, reason?.toString());
    if (!publicStopped) schedulePublicReconnect();
  });

  ws.on("error", (err) => {
    console.error("[Bybit] Public WebSocket error", err.message);
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
        if (s) instrumentsBySymbol[s] = item;
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
    bybitSymbolFiltersCache[sym] = { stepSize: null, tickSize: null, maxOrderQty: null };
    return bybitSymbolFiltersCache[sym];
  }
  const stepSize = item.lotSizeFilter?.qtyStep ?? null;
  const tickSize = item.priceFilter?.tickSize ?? null;
  const maxOrderQty = item.lotSizeFilter?.maxOrderQty ?? null;
  bybitSymbolFiltersCache[sym] = { stepSize, tickSize, maxOrderQty };
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

/** Slippage 1% so IOC orders get filled. */

/**
 * Get limit price for IOC from cached mark price + slippage. No REST orderbook.
 * BUY (Long): markPrice * (1 + slippagePct/100). SELL (Short): markPrice * (1 - slippagePct/100).
 * @param {string} symbol
 * @param {string} side - Buy | Sell
 * @param {number} [slippagePct=2] - slippage in percent (e.g. 2 = 2%)
 */
function getOrderbookPrice(symbol, side, slippagePct = 2) {
  const sym = String(symbol).toUpperCase();
  const mark = lastMarkPriceBySymbol[sym];
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  const pct = Number.isFinite(slippagePct) ? Math.max(0, Math.min(100, slippagePct)) : 2;
  const isBuy = String(side).toLowerCase() === "buy";
  return isBuy ? mark * (1 + pct / 100) : mark * (1 - pct / 100);
}

async function placeIOCLimitOrder(credentials, symbol, side, qty, price, opts = {}) {
  const sym = symbol.toUpperCase();
  const sideNorm = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();

  try {
    const data = await placeWSOrder(credentials, sym, sideNorm, qty, price, opts);
    return { result: data, retCode: 0, retMsg: "OK" };
  } catch (e) {
    console.error("[Bybit] placeWSOrder failed", sym, sideNorm, e.message, "- falling back to REST");
    return placeIOCLimitOrderREST(credentials, sym, sideNorm, qty, price, opts);
  }
}

async function placeIOCLimitOrderREST(credentials, sym, sideNorm, qty, price, opts = {}) {
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
 * Ignores 110043 (leverage not modified) so it doesn't block the trade.
 */
async function setLeverage(credentials, symbol, leverage) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return;
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
    if (retCode === 110043) return;
    if (retCode !== 0 && retCode != null) {
      console.warn("[Bybit] setLeverage", sym, "retCode", retCode, res.data?.retMsg);
    }
  } catch (e) {
    const code = e.response?.data?.retCode;
    if (code === 110043) return;
    console.warn("[Bybit] setLeverage failed", sym, e.response?.data?.retMsg || e.message);
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
  if (publicWs) {
    publicWs.removeAllListeners?.();
    publicWs.close();
    publicWs = null;
  }
  privateCredentials = null;
  tradeWsCredentials = null;
  cachedWalletBalance = 0;
  instrumentsLoadPromise = null;
  Object.keys(cachedFundingRates).forEach((k) => delete cachedFundingRates[k]);
  Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
  Object.keys(lastMarkPriceBySymbol).forEach((k) => delete lastMarkPriceBySymbol[k]);
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

module.exports = {
  start,
  stop,
  placeIOCLimitOrder,
  getOrderFillPrice,
  setLeverage,
  placeWSOrder,
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
  getMaxLeverage,
  getPerpetualSymbols,
  getOrderbookPrice,
  getBalance,
  getPositionSymbols,
  getPositionDetails,
  getSymbolFilters,
  hydratePositionsFromRest,
};
