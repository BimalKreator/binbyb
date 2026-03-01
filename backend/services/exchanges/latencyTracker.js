/**
 * Format a timestamp (ms) as HH:mm:ss.SSS for console logs.
 * @param {number|string} timestamp - Milliseconds since epoch
 * @returns {string} e.g. "14:32:01.234" or "N/A"
 */
function formatMs(timestamp) {
  if (!timestamp) return "N/A";
  const d = new Date(Number(timestamp));
  return d.toISOString().split("T")[1].replace("Z", "");
}

/**
 * Logs message arrival latency (client receive time vs event time when provided).
 * Disabled to avoid terminal spam on every WebSocket message; re-enable for debugging.
 * @param {string} exchange - Exchange name (e.g. 'binance', 'bybit')
 * @param {string} stream - Stream or topic name
 * @param {number} [eventTimeMs] - Event time from exchange (ms). If missing, only logs "message received".
 * @param {object} [meta] - Optional extra data to log
 */
function logLatency(exchange, stream, eventTimeMs, meta = {}) {
  // Uncomment below to log latency on every message (noisy).
  // const now = Date.now();
  // if (eventTimeMs != null && typeof eventTimeMs === "number") {
  //   const latencyMs = now - eventTimeMs;
  //   console.log(`[Latency] ${exchange} | ${stream} | ${latencyMs} ms`, Object.keys(meta).length ? meta : "");
  // } else {
  //   console.log(`[Latency] ${exchange} | ${stream} | received at ${now}`);
  // }
}

module.exports = { formatMs, logLatency };
