const WebSocket = require("ws");
const axios = require("axios");
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
  const size = parseFloat(raw?.size ?? 0);
  if (!Number.isFinite(size) || Math.abs(size) <= 0) {
    delete livePositionsByKey[key];
    if (typeof onPositionClosed === "function") onPositionClosed(sym, "bybit");
    return;
  }
  livePositionsByKey[key] = {
    symbol: sym,
    unrealizedProfit: parseFloat(raw?.unrealisedPnl ?? 0) || 0,
    marginUsed: parseFloat(raw?.positionIM ?? raw?.positionIMByMp ?? 0) || 0,
    positionAmt: size,
    side: side || "Sell",
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
    const ws = new WebSocket(TRADE_WS_URL);
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
  const ws = new WebSocket(PUBLIC_WS_URL);
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

  privateWs = new WebSocket(PRIVATE_WS_URL);

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
            const usdt = coins.find((c) => String(c?.coin ?? "").toUpperCase() === "USDT");
            if (usdt != null) {
              const eq = usdt.equity ?? usdt.walletBalance ?? usdt.availableToWithdraw;
              if (eq != null && String(eq).length > 0) cachedWalletBalance = parseFloat(eq) || 0;
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
          } else if (msg.topic === "position") {
            // Position state populated from position topic; exit loops read via getLivePositions()
            upsertLivePosition(d);
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
/** Cache symbol filters (qtyStep, tickSize) from instruments-info. */
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
 * Get lotSizeFilter.qtyStep and priceFilter.tickSize for a symbol. Cached.
 */
async function getSymbolFilters(symbol) {
  const sym = String(symbol).toUpperCase();
  if (bybitSymbolFiltersCache[sym]) return bybitSymbolFiltersCache[sym];
  try {
    const { data } = await axios.get(`${REST_BASE}/v5/market/instruments-info`, {
      params: { category: "linear", symbol: sym },
    });
    const list = data?.result?.list || [];
    const item = list.find((s) => (s.symbol || "").toUpperCase() === sym);
    if (!item) {
      bybitSymbolFiltersCache[sym] = { stepSize: null, tickSize: null, maxOrderQty: null };
      return bybitSymbolFiltersCache[sym];
    }
    const stepSize = item.lotSizeFilter?.qtyStep ?? null;
    const tickSize = item.priceFilter?.tickSize ?? null;
    const maxOrderQty = item.lotSizeFilter?.maxOrderQty ?? null;
    bybitSymbolFiltersCache[sym] = { stepSize, tickSize, maxOrderQty };
    return bybitSymbolFiltersCache[sym];
  } catch (e) {
    return { stepSize: null, tickSize: null, maxOrderQty: null };
  }
}

/**
 * Get USDT wallet balance from WebSocket cache (private wallet topic). No REST calls.
 * @returns {number} cached balance or 0 if not yet received
 */
function getBalance(credentials) {
  return typeof cachedWalletBalance === "number" && Number.isFinite(cachedWalletBalance)
    ? cachedWalletBalance
    : 0;
}

/**
 * Get open position symbols (size !== 0) for linear. USER_DATA, signed.
 */
async function getPositionSymbols(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return [];
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const params = { category: "linear", recvWindow, timestamp };
    const queryString = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${queryString}`;
    const signature = signMessage(signStr, credentials.apiSecret);
    const { data } = await axios.get(
      `${REST_BASE}/v5/position/list?${queryString}&signature=${signature}`,
      {
        headers: {
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-TIMESTAMP": String(timestamp),
          "X-BAPI-RECV-WINDOW": String(recvWindow),
          "X-BAPI-SIGN": signature,
        },
      }
    );
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
async function getPositionDetails(credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) return [];
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const params = { category: "linear", recvWindow, timestamp };
    const queryString = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${queryString}`;
    const signature = signMessage(signStr, credentials.apiSecret);
    const { data } = await axios.get(
      `${REST_BASE}/v5/position/list?${queryString}&signature=${signature}`,
      {
        headers: {
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-TIMESTAMP": String(timestamp),
          "X-BAPI-RECV-WINDOW": String(recvWindow),
          "X-BAPI-SIGN": signature,
        },
      }
    );
    const list = data?.result?.list || [];
    return list
      .filter((p) => {
        const size = parseFloat(String(p.size ?? 0));
        return Number.isFinite(size) && Math.abs(size) > 0;
      })
      .map((p) => {
        const size = parseFloat(String(p.size ?? 0));
        const side = String(p.side || "").toLowerCase() === "buy" ? "Buy" : "Sell";
        return {
          symbol: String(p.symbol || "").toUpperCase(),
          unrealizedProfit: parseFloat(String(p.unrealisedPnl ?? 0)) || 0,
          marginUsed: parseFloat(String(p.positionIM ?? 0)) || 0,
          positionAmt: size,
          side,
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

/** Slippage (0.1%) applied to mark price when no REST orderbook. */
const ORDERBOOK_SLIPPAGE_PCT = 0.001;

/**
 * Get limit price for IOC from cached mark price + slippage. No REST orderbook.
 * Buy: markPrice * (1 + slippage). Sell: markPrice * (1 - slippage).
 * @returns {number|null} price or null if no mark price yet
 */
function getOrderbookPrice(symbol, side) {
  const sym = String(symbol).toUpperCase();
  const mark = lastMarkPriceBySymbol[sym];
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  const isBuy = String(side).toLowerCase() === "buy";
  const slip = ORDERBOOK_SLIPPAGE_PCT;
  return isBuy ? mark * (1 + slip) : mark * (1 - slip);
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
      const list = await getPositionDetails(credentials);
      Object.keys(livePositionsByKey).forEach((k) => delete livePositionsByKey[k]);
      for (const p of list || []) {
        const sym = String(p?.symbol || "").toUpperCase();
        const positionAmt = parseFloat(String(p?.positionAmt ?? 0));
        if (!sym || !Number.isFinite(positionAmt) || Math.abs(positionAmt) === 0) continue;
        const side = String(p?.side || "").toLowerCase() === "buy" ? "Buy" : "Sell";
        const key = `${sym}:${side}:0`;
        livePositionsByKey[key] = {
          symbol: sym,
          unrealizedProfit: parseFloat(String(p?.unrealizedProfit ?? 0)) || 0,
          marginUsed: parseFloat(String(p?.marginUsed ?? 0)) || 0,
          positionAmt,
          side,
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
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  openPublicStreams(symbols);
  openPrivateStream(credentials);
  await hydratePositionsFromRest(credentials);

  // One-time REST fetch to seed cachedWalletBalance; WS will keep it updated. No retries.
  if (credentials?.apiKey && credentials?.apiSecret) {
    try {
      const timestamp = Date.now();
      const recvWindow = 5000;
      const params = { accountType: "UNIFIED", recvWindow, timestamp };
      const queryString = Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("&");
      const signStr = `${timestamp}${credentials.apiKey}${recvWindow}${queryString}`;
      const signature = signMessage(signStr, credentials.apiSecret);
      const { data } = await axios.get(
        `${REST_BASE}/v5/account/wallet-balance?${queryString}&signature=${signature}`,
        {
          headers: {
            "X-BAPI-API-KEY": credentials.apiKey,
            "X-BAPI-TIMESTAMP": String(timestamp),
            "X-BAPI-RECV-WINDOW": String(recvWindow),
            "X-BAPI-SIGN": signature,
          },
        }
      );
      const list = data?.result?.list || [];
      for (const acc of list) {
        const coins = acc.coin || [];
        const usdt = coins.find((c) => (c.coin || "").toUpperCase() === "USDT");
        if (usdt) {
          const eq = usdt.equity ?? usdt.walletBalance ?? usdt.availableToWithdraw ?? 0;
          cachedWalletBalance = parseFloat(eq) || 0;
          break;
        }
      }
    } catch (e) {
      console.warn("[Bybit] One-time balance fetch failed:", e.message, "- WS will set balance on first update");
      // Leave cachedWalletBalance at 0
    }
  }
}

/**
 * Fetch last funding time (ms) for interval calculation. Public endpoint.
 */
async function getLastFundingTime(symbol) {
  const { data } = await axios.get(`${REST_BASE}/v5/market/funding/history`, {
    params: { category: "linear", symbol: symbol.toUpperCase(), limit: 1 },
  });
  const list = data?.result?.list;
  const item = list && list.length ? list[0] : null;
  return item && item.fundingRateTimestamp ? Number(item.fundingRateTimestamp) : null;
}

/**
 * Fetch max leverage for symbol. Public endpoint.
 */
async function getMaxLeverage(symbol) {
  const { data } = await axios.get(`${REST_BASE}/v5/market/instruments-info`, {
    params: { category: "linear", symbol: symbol.toUpperCase() },
  });
  const list = data?.result?.list;
  const instrument = list && list.length ? list[0] : null;
  const lev = instrument?.leverageFilter?.maxLeverage;
  return lev != null ? Number(lev) : null;
}

/**
 * Fetch all linear perpetual symbols from Instruments Info. Public endpoint. Uses pagination.
 * @returns {Promise<string[]>} e.g. ["BTCUSDT", "ETHUSDT", ...]
 */
async function getPerpetualSymbols() {
  const all = [];
  let cursor;
  do {
    const params = { category: "linear", limit: 500 };
    if (cursor) params.cursor = cursor;
    const { data } = await axios.get(`${REST_BASE}/v5/market/instruments-info`, { params });
    const list = data?.result?.list || [];
    for (const item of list) {
      if (item.symbol && item.status === "Trading") {
        all.push(item.symbol);
      }
    }
    cursor = data?.result?.nextPageCursor || null;
  } while (cursor);
  return all;
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
  getOrderbookPrice,
  getBalance,
  getPositionSymbols,
  getPositionDetails,
  getSymbolFilters,
};
