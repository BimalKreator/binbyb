/**
 * System log streaming: intercept console.log/error, persist to SystemLog (48h TTL), emit via Socket.io to room 'system-logs'.
 */

const SystemLog = require("../models/SystemLog");

let io = null;
const ROOM = "system-logs";

function categoryFromMessage(level, message) {
  const str = String(message || "");
  if (level === "error") return "error";
  if (/\bentry\b|entry\s|\[AutoTrader\]\s*Entry/i.test(str)) return "entry";
  if (/\bexit\b|close|SL exit|TP exit|orphan|funding flip|closed/i.test(str)) return "exit";
  return null;
}

function persistAndEmit(level, message, category) {
  const payload = {
    level,
    message: String(message),
    category: category || categoryFromMessage(level, message),
    ts: Date.now(),
  };
  SystemLog.create({
    level,
    message: payload.message,
    source: "console",
    metadata: { category: payload.category },
  }).catch((e) => {
    if (io) io.to(ROOM).emit("system-log", { ...payload, level: "error", message: `[logService] ${e.message}` });
  });
  if (io) io.to(ROOM).emit("system-log", payload);
}

let originalLog = null;
let originalError = null;

function init(socketServer) {
  io = socketServer;
  if (originalLog != null) return;
  originalLog = console.log;
  originalError = console.error;

  console.log = function (...args) {
    originalLog.apply(console, args);
    const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    persistAndEmit("info", message);
  };

  console.error = function (...args) {
    originalError.apply(console, args);
    const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    persistAndEmit("error", message);
  };
}

function shutdown() {
  if (originalLog) console.log = originalLog;
  if (originalError) console.error = originalError;
  originalLog = null;
  originalError = null;
  io = null;
}

module.exports = { init, shutdown };
