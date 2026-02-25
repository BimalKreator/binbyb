/**
 * Global order rate limiter: if more than MAX_ORDERS are placed within WINDOW_MS,
 * all trading is paused for PAUSE_MS and a critical error is logged.
 * Used by autoTrader, tradeMonitor, and API routes before/after order placement.
 */

const WINDOW_MS = 10000;   // 10 seconds
const MAX_ORDERS = 10;
const PAUSE_MS = 60000;    // 1 minute

const orderTimestamps = [];
let pausedUntil = 0;

function trimToWindow() {
  const now = Date.now();
  while (orderTimestamps.length && orderTimestamps[0] < now - WINDOW_MS) {
    orderTimestamps.shift();
  }
}

/**
 * Returns true if it is safe to place an order (under limit and not in pause).
 */
function canPlaceOrder() {
  const now = Date.now();
  if (now < pausedUntil) return false;
  trimToWindow();
  return orderTimestamps.length < MAX_ORDERS;
}

/**
 * Call after successfully placing an order (REST or WS).
 * If this pushes the count over MAX_ORDERS in the window, sets a 1-minute pause and logs critical.
 */
function recordOrderPlaced() {
  const now = Date.now();
  orderTimestamps.push(now);
  trimToWindow();
  if (orderTimestamps.length > MAX_ORDERS) {
    pausedUntil = now + PAUSE_MS;
    console.error(
      "[OrderCircuitBreaker] CRITICAL: More than",
      MAX_ORDERS,
      "orders in",
      WINDOW_MS / 1000,
      "s. All trading paused for",
      PAUSE_MS / 1000,
      "s until",
      new Date(pausedUntil).toISOString()
    );
  }
}

/**
 * For logging/debug: current count in window and whether paused.
 */
function getState() {
  trimToWindow();
  return {
    countInWindow: orderTimestamps.length,
    pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
  };
}

module.exports = {
  canPlaceOrder,
  recordOrderPlaced,
  getState,
};
