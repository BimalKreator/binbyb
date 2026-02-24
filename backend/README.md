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
