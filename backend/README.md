# Binbyb Backend

## Install dependencies

From the project root:

```bash
cd backend
npm install
```

Or from anywhere:

```bash
npm install --prefix /path/to/binbyb/backend
```

One-liner from repo root:

```bash
cd backend && npm install
```

## Environment

Copy `.env.example` to `.env` and set:

- `PORT` – server port (default 5000)
- `MONGODB_URI` – MongoDB connection string (default `mongodb://localhost:27017/binbyb`)
- `JWT_SECRET` – secret for signing JWTs
- `API_KEY_ENCRYPTION_SECRET` – 32-byte secret for encrypting exchange API keys

## Run

- Development (with file watch): `npm run dev`
- Production: `npm start`

## Auth

- **Login:** `POST /api/auth/login` with body `{ "email": "...", "password": "..." }`
- Hardcoded admin: `admin@tradeictearner.site` / `Tikhat@999`
- Use the returned `token` in the header: `Authorization: Bearer <token>` for protected routes.

## Models

- **User** – admin login
- **APIKey** – Binance/Bybit keys (stored encrypted)
- **Setting** – Capital%, Max Trades, SL/TP, Auto Trade
- **TradeLog** – entry/exit price, PnL, timestamps
- **FundLog** – deposit/withdrawal history
- **SystemLog** – errors/events with 48h TTL

## Phase 2: Exchange connectors

Custom connectors (no CCXT) in `services/exchanges/`:

- **binanceManager.js** – Public WS (mark price, funding rate, ticker), private user stream (balance + order updates), REST IOC limit orders. Uses `ws` and `axios`. Auth via HMAC SHA256 (crypto-js).
- **bybitManager.js** – Same for Bybit V5 (linear): public ticker/mark/funding, private wallet + order streams, REST IOC limit orders.
- **latencyTracker.js** – Logs message arrival latency (client time vs event time).
- **apiKeys.js** – Loads and decrypts API keys from the `APIKey` model for use by the managers.

Exchange managers start automatically when the server starts (after MongoDB connects). They read API keys from the database; if none are configured, only public streams run. IOC limit order helpers: `binanceManager.placeIOCLimitOrder(credentials, symbol, side, quantity, price)` and `bybitManager.placeIOCLimitOrder(credentials, symbol, side, qty, price)`.

## Screener (The Brain)

`services/screener.js` runs on every funding WebSocket update from Binance and Bybit:

- **Funding interval:** `Interval = NextFundingTime - LastFundingTime` (REST for last time), converted to 1h / 2h / 4h / 8h.
- **Spread:** Gross = Funding_Binance − Funding_Bybit; Net = Gross − UserMinSpread% (from **Setting** model `userMinSpread`).
- **Volatility meter:** Count of tokens with Net Spread &gt; 0.5%; levels: 0–2 Low, 3–5 Med, 5+ High.
- **Ranking:** Tokens sorted by interval priority (1h/2h first) then by highest net spread.
- **Max leverage:** Min(Binance max leverage, Bybit max leverage) per symbol, fetched via REST and cached.

Protected API: `GET /api/screener` returns `rankedTokens`, `volatilityMeter`, and symbol lists (requires `Authorization: Bearer <token>`).
