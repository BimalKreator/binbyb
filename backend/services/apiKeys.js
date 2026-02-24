const APIKey = require("../models/APIKey");
const { decrypt } = require("../utils/encrypt");

/**
 * Fetches active API keys from DB and returns decrypted credentials per exchange.
 * @returns {Promise<{ binance?: { apiKey, apiSecret }, bybit?: { apiKey, apiSecret, passphrase? } }>}
 */
async function getDecryptedApiKeys() {
  const docs = await APIKey.find({ isActive: true }).lean();
  const result = {};

  for (const doc of docs) {
    const exchange = doc.exchange.toLowerCase();
    if (exchange !== "binance" && exchange !== "bybit") continue;

    result[exchange] = {
      apiKey: decrypt(doc.apiKeyEncrypted),
      apiSecret: decrypt(doc.apiSecretEncrypted),
      passphrase: doc.passphraseEncrypted ? decrypt(doc.passphraseEncrypted) : "",
    };
  }

  return result;
}

module.exports = { getDecryptedApiKeys };
