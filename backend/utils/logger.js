/**
 * Database-backed logger for trade entries/exits and chunk executions.
 * Logs to console and persists to SystemLog (7-day TTL).
 */
const SystemLog = require("../models/SystemLog");

/**
 * @param {string} type - 'ENTRY' | 'EXIT' | 'ERROR' | 'SYSTEM'
 * @param {string} message
 * @param {string|null} [symbol=null]
 * @param {object} [details={}]
 */
async function dbLog(type, message, symbol = null, details = {}) {
  const safeType = ["ENTRY", "EXIT", "ERROR", "SYSTEM"].includes(type) ? type : "SYSTEM";
  const logLine = symbol ? `[${symbol}] ${message}` : message;
  console.log(`[dbLog:${safeType}]`, logLine, Object.keys(details).length ? details : "");
  SystemLog.create({
    type: safeType,
    message: String(message),
    symbol: symbol != null ? String(symbol) : null,
    details: details && typeof details === "object" ? details : {},
  }).catch((e) => console.error("[dbLog] Persist failed:", e?.message ?? e));
}

module.exports = { dbLog };
