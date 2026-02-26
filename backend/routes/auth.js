const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, protect } = require("../middleware/auth");

const router = express.Router();

const ADMIN_EMAIL = "admin@tradeictearner.site";
const ADMIN_PASSWORD = "Tikhat@999";

const COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

function loginHandler(req, res) {
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

  res.cookie("binbyb_jwt", token, COOKIE_OPTIONS);

  res.json({
    success: true,
    message: "Login successful.",
    token,
    user: { email: ADMIN_EMAIL, role: "admin" },
  });
}

router.post("/login", loginHandler);

router.get("/me", protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
module.exports.loginHandler = loginHandler;
