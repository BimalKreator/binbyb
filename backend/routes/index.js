const express = require("express");
const authRoutes = require("./auth");
const screenerRoutes = require("./screener");
const apiKeysRoutes = require("./apiKeys");
const settingsRoutes = require("./settings");
const fundLogsRoutes = require("./fundLogs");
const ordersRoutes = require("./orders");
const tradeRoutes = require("./trade");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/screener", screenerRoutes);
router.use("/api-keys", apiKeysRoutes);
router.use("/settings", settingsRoutes);
router.use("/fund-logs", fundLogsRoutes);
router.use("/orders", ordersRoutes);
router.use("/trade", tradeRoutes);

module.exports = router;
