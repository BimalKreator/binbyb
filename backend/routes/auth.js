const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, protect } = require("../middleware/auth");

const router = express.Router();

const ADMIN_EMAIL = "admin@tradeictearner.site";
const ADMIN_PASSWORD = "Tikhat@999";

router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Invalid credentials." });
  }

  const token = jwt.sign(
    { email: ADMIN_EMAIL, role: "admin" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    success: true,
    message: "Login successful.",
    token,
    user: { email: ADMIN_EMAIL, role: "admin" },
  });
});

router.get("/me", protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
