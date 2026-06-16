# Radar Learn v5.1 — Pattern Library (implemented)

Additive, Postgres-only. Memory store = no-op. No changes to scoring.js / scoringV2.js.
Failure Learning, Confidence Engine, Weight Optimization are NOT implemented (deferred).

## What shipped
- **Migration 004** — `patterns`, `pattern_members`, `pattern_performance` (windows: `all_time`, `rolling_90d`; column is `time_window` because `window` is a SQL reserved word).
- **`patternKeysFor(setup)`** — hierarchical L0–L4 keys (L0 mode+direction → L4 +narrative); each level's parent is the level above (stored as `parent_pattern_id`).
- **Membership** — `assignPatterns(setup)` on setup creation (in radarLearn). Stats recomputed after each resolver pass (`recomputePatterns()`), plus a daily cron and `npm run recompute:patterns`.
- **Stats** — Wilson 95% lower bound for win rate; empirical-Bayes shrinkage toward the parent pattern (k=10); avg return / RR / drawdown; target/invalidation rates; trend (rolling vs all-time).
- **Pattern Strength (0–100)** — blends win_rate_lb (.40), sample (.20), return (.15), trend (.10), stability=1−invalidation (.10), drawdown (.05).
- **Regime Memory** — per-pattern best/worst `market_regime` by Wilson LB (min sample 4), stored as `best_regime` / `worst_regime` + win rates + full `regime_breakdown` JSONB.
- **Similar Setup Matching** — `matchSetup(setupId)`: cohort = most-specific *activated* pattern (falls back down the ladder); stats over RESOLVED members EXCLUDING the current setup; plus vector top-N closest (existing kNN). Exposed at `GET /api/similar/:setupId` and attached to `GET /api/trade/:id` as `patternMatch`.
- **Endpoints** — `GET /api/patterns?window=`, `GET /api/patterns/:id`, `GET /api/similar/:setupId`.
- **Pattern Dashboard** — `/patterns`: best / gaining / losing / worst sections, strength score, win rate (+LB), avg return/RR, sample, trend, last seen, best/worst regime, display-only suggested confidence. Window toggle (all-time / 90d). Nav links added across desktop + bottom navs.

## Tests
- `patterns.test.js` (10 pure): keying, Wilson, shrinkage, setupResult ordering, RR, trend, strength bounds, regime pick, conf-adj bounds.
- `patternStore.test.js` (5 pg-mem): migration, L0–L4 membership + parent links, recompute (Wilson/shrink/strength/regime), matchSetup excludes current setup, incremental recompute.

## Render notes
- Patterns populate on Postgres only. They appear as setups are created and become meaningful as setups resolve.
- One-time/optional after deploy: `npm run recompute:patterns` to backfill stats for already-resolved setups. (Membership is only auto-created for setups created *after* this deploy; a future `backfill:patterns` script could assign historical setups — not built in v5.1.)
