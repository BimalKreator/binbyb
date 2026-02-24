/**
 * Logs message arrival latency (client receive time vs event time when provided).
 * @param {string} exchange - Exchange name (e.g. 'binance', 'bybit')
 * @param {string} stream - Stream or topic name
 * @param {number} [eventTimeMs] - Event time from exchange (ms). If missing, only logs "message received".
 * @param {object} [meta] - Optional extra data to log
 */
function logLatency(exchange, stream, eventTimeMs, meta = {}) {
  const now = Date.now();
  if (eventTimeMs != null && typeof eventTimeMs === "number") {
    const latencyMs = now - eventTimeMs;
    console.log(
      `[Latency] ${exchange} | ${stream} | ${latencyMs} ms`,
      Object.keys(meta).length ? meta : ""
    );
  } else {
    console.log(`[Latency] ${exchange} | ${stream} | received at ${now}`);
  }
}

module.exports = { logLatency };
