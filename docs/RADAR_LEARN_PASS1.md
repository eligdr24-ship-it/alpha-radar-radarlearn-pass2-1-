# Radar Learn — Pass 1 (implemented)

Event-driven setup/outcome learning layer. Postgres only; no-ops on the memory
driver (dashboard/feed unaffected). Implements §1–§9 of RADAR_LEARN_SPEC.md.

## Delivered
- **migration `002_radar_learn.sql`** — `setups`, `signal_values`,
  `setup_vectors` (`DOUBLE PRECISION[]`), `outcomes` (+ `success_label`), indexed.
- **Decision-time context on every setup**: market_regime, narrative, macro_state,
  asset_class, exchange_source, history_class (Pass-2), depth_score (Pass-2).
- **Promotion evaluator** (`services/radarLearn.js`) — pure `decidePromotion`
  with all triggers: emerge / direction-change / setup-type-change / entered-top /
  buy-zone-valid / conviction-band-cross / major-jump. One active setup per
  (symbol,mode); **mode-dependent cooldowns** (scalp 30m / day 4h / swing 24h).
- **Outcome resolver** (`services/outcomeResolver.js`) — pure `computeOutcome`:
  target1/2/stretch/invalidation hits (time-ordered), MFE/MAE, final return, and
  `success_label` (fail/target1/target2/stretch/invalidated) at **1h/4h/24h/7d/30d**.
- **Feature vector** (14 normalized dims) per setup for future kNN.
- **Read-only endpoints**: `/api/setups`, `/api/setups/:id`,
  `/api/learn/success-rate`, `/api/learn/signal-edge`, `/api/learn/similar/:id`.
- **Resolver cron** (Postgres only, 5–15 min) + `npm run backfill:outcomes`.
- **Tests**: 16 (every promotion trigger + resolver math); full suite 34 green.

## Verified against real Postgres SQL (pg-mem)
A scan promoted 15 setups (5×3 modes) with 75 signal_values and 15 vectors; a
backdated setup resolved correctly (7d hit target1, return +19%); learn queries
return success-rate and per-signal edge.

## Notes
- `history_class`/`depth_score` are `unknown`/null until Pass 2 fills them.
- Similarity/success-rate will be segmented by `history_class` once Pass 2 lands.

## Next: Pass 2 — deep historical backfill (asset_history, asset_sources,
asset_profile, source fetchers, depth-aware scoring, coverage endpoints).
