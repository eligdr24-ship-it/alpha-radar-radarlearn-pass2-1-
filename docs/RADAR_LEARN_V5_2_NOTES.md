# Radar Learn v5.2 — Failure Learning (implemented)

Additive, Postgres-only, **display-only**. Memory store = no-op. No changes to scoring.js / scoringV2.js or ranking. Confidence Engine and Weight Optimization are NOT implemented (deferred).

## What shipped
- **Migration 005** — `failure_reasons` table (one row per setup: primary_reason, secondary_reasons JSONB, evidence JSONB, confidence, classifier_version, classified_at) + `pattern_performance.top_failure_reasons` JSONB.
- **Pure classifier** (`failureLearning.js`, `classifyFailure`) — deterministic, rule-based, evidence-driven. Only losses/expired get a reason. All 13 reasons:
  `failed_to_enter_zone, hit_invalidation, failed_to_reach_target, market_regime_changed, volume_faded, btc_reversed, macro_risk_off, liquidity_weakness, liquidity_trap, narrative_reversal, signal_too_early, signal_too_late, unknown`.
  Strength-ordered: the most *informative* specific cause becomes primary; literal mechanics (hit_invalidation) surface as secondary unless nothing more specific fired.
- **Evidence sources** (existing data only): outcomes (hit flags, MFE/MAE, return), setup (entry_filled_at, levels, regime), coin + BTC price path (snapshot_coins), volume/liquidity (snapshot history), macro VIX/DXY candles (asset_history), and a same-narrative peer-return basket.
  - Proxies (documented): `market_regime_changed` / `macro_risk_off` derive from VIX/DXY candle moves over the trade window; `narrative_reversal` from the avg realized return of ≥3 same-narrative peers resolved within ±3 days; `signal_too_late` from pre-signal run-up toward T1.
- **Classification on resolution** — the resolver classifies each newly resolved/expired setup (self-skips wins). Idempotent (one row per setup, upsert).
- **Rollup** into `pattern_performance.top_failure_reasons` during `recomputePatterns`.
- **Integrations**: Trade Replay "Why It Lost" shows primary + secondary + confidence; Pattern Dashboard cards show common failures; System Performance shows a global Failure Breakdown card. New: `/api/trade/:id` → `failureReason`; `/api/performance` → `failureBreakdown`.
- **Backfill**: `npm run backfill:failures` classifies historical losses + refreshes rollups.

## Tests
- `failureLearning.test.js` (17 pure): one per reason + win/open → null + secondary/evidence/version + labels + rollup.
- `failureStore.test.js` (4 pg-mem): classify+store (wins skipped), rollup into pattern_performance, global breakdown, idempotent backfill.

## Render notes
- Classification runs on Postgres only; reasons accrue as setups resolve.
- One-time after deploy: `npm run backfill:failures` to classify already-resolved losses.
- Reasons needing macro/narrative data only fire where that data exists; otherwise the setup falls back to the strongest available reason (often `hit_invalidation`).
