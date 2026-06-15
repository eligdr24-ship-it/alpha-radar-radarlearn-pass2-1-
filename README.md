# Alpha Radar v1.2 — Full API Ready

Alpha Radar is a responsive crypto intelligence dashboard that ranks the best long/short opportunities across Scalper, Day Trader, and Swing modes.

## What is live now
- CoinGecko public API for market prices, market cap, volume
- Binance public API fallback
- DEX Screener public API for emerging coins
- GeckoTerminal public API for emerging/trending pools
- Reddit public JSON lightweight sentiment feed
- Fear & Greed public API
- Telegram test alert route
- Safe mock fallback if an API fails

## API-ready but requires keys
Add these in Render Environment Variables when you have accounts/keys:

- `COINGLASS_API_KEY` — funding, open interest, liquidation data
- `COINMARKETCAP_API_KEY` — pro market data fallback
- `X_BEARER_TOKEN` — X/Twitter sentiment and hype tracking
- `TWELVEDATA_API_KEY` or `POLYGON_API_KEY` — Gold, VIX, DXY, Nasdaq, SPX live quotes
- `FRED_API_KEY` — yields and macro series
- `ETHERSCAN_API_KEY` / `SOLSCAN_API_KEY` — on-chain/whale data
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — Telegram alerts

## Render settings
Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

## Useful endpoints
- `/api/health`
- `/api/dashboard?mode=day`
- `/api/sources`
- `/api/integrations`
- `/api/emerging`
- `/api/alerts/test-telegram` POST

## Important note
This is a full API-ready codebase, but key-required services will show `not-configured` until API keys are added. This keeps the app deployable immediately.

## v1.2 Phase 2 — 24/7 Scanner (added)
The server now runs a dynamic scan every 1–5 minutes: it builds a live universe
(CoinGecko → Binance → mock), filters by liquidity/volume/market-cap/quality,
stores each snapshot, and rescores long/short across all three modes. The
dashboard serves the latest stored scan (no live call per request).

New endpoints:
- `GET  /api/universe` — current filtered universe + thresholds
- `POST /api/scan/run` — run a scan now
- `GET  /api/scan/status` — store meta + last run
- `GET  /api/scan/runs` — recent run logs

CLI:
- `npm run scan:once` — run one scan and print the ranked top opportunities
- `npm run db:reset` — clear the local store

See `docs/PHASE2_NOTES.md` for architecture, tuning env vars, and the deploy
caveat (24/7 cron needs a long-running host → Render, not Vercel serverless).
