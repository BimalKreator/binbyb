const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

function getKey() {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET || "default-32-byte-secret-key!!";
  return crypto.scryptSync(secret, "salt", KEY_LENGTH);
}

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText) return "";
  const [ivHex, encrypted] = encryptedText.split(":");
  if (!ivHex || !encrypted) return "";
  const iv = Buffer.from(ivHex, "hex");
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

module.exports = { encrypt, decrypt };
