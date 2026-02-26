const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, protect } = require("../middleware/auth");

const router = express.Router();

// Accept both .site and .online so login works on https://tradeictearner.online
const ADMIN_EMAILS = ["admin@tradeictearner.site", "admin@tradeictearner.online"];
const ADMIN_PASSWORD = "Tikhat@999";

// secure: true when over HTTPS (trust proxy makes req.secure correct behind Nginx)
function getCookieOptions(req) {
  return {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: "lax",
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
  };
}

function loginHandler(req, res) {
  const rawEmail = req.body && typeof req.body.email === "string" ? req.body.email : "";
  const rawPassword = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const email = rawEmail.trim();
  const password = rawPassword.trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  const normalizedEmail = email.toLowerCase();
  if (!ADMIN_EMAILS.includes(normalizedEmail) || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Invalid credentials." });
  }

  const token = jwt.sign(
    { email: normalizedEmail, role: "admin" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("binbyb_jwt", token, getCookieOptions(req));

  res.json({
    success: true,
    message: "Login successful.",
    token,
    user: { email: normalizedEmail, role: "admin" },
  });
}

router.post("/login", loginHandler);

router.get("/me", protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
module.exports.loginHandler = loginHandler;
