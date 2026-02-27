require("dotenv").config();

// Global error handling: log critical errors instead of crashing the Node process
process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Unhandled rejection at", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught exception:", err && (err.stack || err.message || err));
});

const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server: SocketServer } = require("socket.io");

const routes = require("./routes");
const { startExchanges, binanceManager, bybitManager } = require("./services/exchanges");
const screener = require("./services/screener");
const autoTrader = require("./services/autoTrader");
const tradeMonitor = require("./services/tradeMonitor");
const logService = require("./services/logService");
const livePnlService = require("./services/livePnlService");

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/binbyb";

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

const CORS_ORIGINS = [
  "https://tradeictearner.online",
  "http://tradeictearner.online",
  "http://139.180.190.25:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const io = new SocketServer(server, {
  cors: { origin: CORS_ORIGINS },
  path: "/socket.io",
});
io.on("connection", (socket) => {
  socket.join("system-logs");
});

app.use(
  cors({
    origin: ["http://139.180.190.25:3000", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true, // Required for cookies, authorization headers with HTTPS
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);
app.use("/", routes); // When Nginx strips /api prefix (e.g. proxy_pass with trailing slash), requests like POST /login still work

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "binbyb-backend" });
});

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    try {
      console.log("MongoDB connected:", MONGODB_URI);
      logService.init(io);
      // 7s startup delay before first REST calls to avoid API storm on PM2 crash loop
      await new Promise((r) => setTimeout(r, 7000));
      const symbols = await startExchanges();
      screener.start(Array.isArray(symbols) ? symbols : undefined);
      autoTrader.start(1000);
      livePnlService.init(io, binanceManager, bybitManager);
      tradeMonitor.start();
      server.listen(PORT, () => {
        console.log("Server running on port", PORT);
      });
    } catch (err) {
      console.error("[CRITICAL] Startup error:", err && (err.stack || err.message || err));
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
