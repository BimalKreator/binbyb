const express = require("express");
const authRoutes = require("./auth");
const screenerRoutes = require("./screener");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/screener", screenerRoutes);

module.exports = router;
