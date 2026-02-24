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
