const express = require("express");
const authRoutes = require("./auth");
const { loginHandler } = require("./auth");
const bansRoutes = require("./bans");
const screenerRoutes = require("./screener");
const apiKeysRoutes = require("./apiKeys");
const settingsRoutes = require("./settings");
const fundLogsRoutes = require("./fundLogs");
const ordersRoutes = require("./orders");
const tradeRoutes = require("./trade");
const tradesRoutes = require("./trades");
const dashboardRoutes = require("./dashboard");
const logsRoutes = require("./logs");
const transferRoutes = require("./transfer");

const router = express.Router();

router.post("/login", loginHandler);
router.use("/bans", bansRoutes);
router.use("/auth", authRoutes);
router.use("/screener", screenerRoutes);
router.use("/api-keys", apiKeysRoutes);
router.use("/settings", settingsRoutes);
router.use("/fund-logs", fundLogsRoutes);
router.use("/orders", ordersRoutes);
router.use("/trade", tradeRoutes);
router.use("/trades", tradesRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/logs", logsRoutes);
router.use("/transfer", transferRoutes);

module.exports = router;
