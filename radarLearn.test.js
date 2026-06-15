# Radar Learn — Pass 2 (deep historical backfill)

Ingests as much reliable history as each source allows (no 1-year cap), tracks
provenance per asset/source, scores depth, and treats long/medium/new assets
differently. Postgres only; no-ops on memory. Implements Addendum A of the spec.

## Delivered
- **migration `003_deep_history.sql`** — `asset_history` (real OHLCV),
  `asset_sources` (provenance), `asset_profile` (depth + class), indexed.
- **Source fetchers** (`services/sources/`): Binance klines (paginated to
  listing), CoinGecko `days=max`, GeckoTerminal pool OHLCV, macro via Stooq
  (free) — all with injectable fetch for testing.
- **Backfill orchestrator** (`services/historyBackfill.js`) — resumable
  (continues from last candle), idempotent (`ON CONFLICT` upserts), per-source
  priority, computes provenance + depth_score + history_class → `asset_profile`.
- **Provenance/depth** (`services/provenance.js`, pure): first_available_date,
  coverage_days, expected/actual points, missing_pct, gap_count, has_gaps,
  source_quality, depth_score, and class (long ≥365d&depth≥60 / medium ≥90d /
  new). `MIN_LONG_CANDLES=365`.
- **historyProvider** (`engines/historyProvider.js`) — feeds the **best**
  series into scoring: real candles (deep, real OHLC) for long/medium →
  synthetic snapshot bars → warmup.
- **Depth-aware scoring**: confidence scaled by depth and **capped per class**
  (long 1.0 / medium 0.80 / new 0.60). Every opportunity & setup carries
  `history_class` + `depth_score`. BTC/ETH are "deep" on first backfill.
- **Apples-to-apples learning**: similarity and success-rate queries are
  segmented by `history_class` — a 30-day meme is never matched against
  multi-year BTC.
- **Endpoints**: `/api/assets/:symbol/coverage`, `/api/assets/:symbol/history`,
  `/api/learn/coverage`.
- **Daily keep-fresh cron** + one-shot `npm run backfill:history`.
- **Tests**: 11 (provenance math, class thresholds, kline pagination, CSV/chart
  parsers). Full suite now **45 green**.

## Config
`HIST_INTRADAY_DAYS=720` (1h/4h window; **full history at 1d**),
`MIN_LONG_CANDLES=365`, `HIST_REFRESH_CRON`. All in `.env.example`.

## Run
```bash
DATABASE_URL=... npm run backfill:history -- BTC ETH SOL   # one-shot
DATABASE_URL=... npm run backfill:history                  # whole universe
curl localhost:10000/api/assets/BTC/coverage
curl localhost:10000/api/learn/coverage
```

## Notes
- Daily candles go back as far as each source reliably allows (Binance ~2017 for
  BTC); 1h/4h limited to `HIST_INTRADAY_DAYS` for storage control (configurable).
- Network-blocked sandboxes can't backfill live; all parsing/pagination/
  provenance/scoring logic is verified via injected fetchers + pg-mem.
- Real OHLC candles make ATR/ADX/MACD exact (Tier B) for long/medium assets.
