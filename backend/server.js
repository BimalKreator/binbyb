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
const { startExchanges } = require("./services/exchanges");
const screener = require("./services/screener");
const autoTrader = require("./services/autoTrader");
const tradeMonitor = require("./services/tradeMonitor");
const logService = require("./services/logService");

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/binbyb";

const app = express();
const server = http.createServer(app);

const CORS_ORIGINS = [
  "https://tradeictearner.online",
  "http://tradeictearner.online",
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
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);

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
