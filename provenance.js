# Alpha Radar — Radar Learn Storage Spec v1 (DRAFT for approval)

Goal: alongside the existing per-tick `opportunities` feed, persist a **clean,
event-driven layer of meaningful setups + their outcomes + their decision-time
signal vectors**, structured so the system can later (a) find similar historical
setups, (b) measure their success rates, and (c) learn which signals carry edge.

Decisions already locked in by you:
- **Promotion = meaningful events only** (never every scan tick).
- **Outcomes = trade-levels hit + realized returns at 5 horizons + MFE/MAE.**
- Keep `opportunities` as the dashboard/feed history; Radar Learn is a separate,
  cleaner layer.

---

## 0. Architecture & principles

```
scan (every 2 min)
  ├─ opportunities  (every tick, all coins × modes)         ← UNCHANGED (feed)
  └─ promotion evaluator  ─ meaningful event? ─┐
                                               ▼
        setups ── signal_values ── setup_vectors            ← Radar Learn (clean)
                                               ▲
outcome resolver (every 5–15 min) ── reads snapshot_coins ──┘ writes outcomes
```

- **Postgres-only.** Radar Learn requires the Postgres driver; in memory/JSON
  mode it is a graceful no-op (learning needs durable history). `store.activeDriver()`
  gates it.
- **Modular.** New migration `002_radar_learn.sql`; new modules
  `services/radarLearn.js` (promotion) and `services/outcomeResolver.js`
  (resolution); new store methods. No changes to scoring or the feed.
- **Indexed & backfillable.** Every learning query has a supporting index; the
  resolver runs both live (cron) and as a one-shot backfill over old setups
  (raw price history in `snapshot_coins` is already retained, so nothing is lost).
- **Decision-time capture.** `signal_values` and `setup_vectors` snapshot the
  features **at the moment of promotion** — that's the input the outcome later
  labels. Features are never overwritten on update.

---

## 1. `setups` table

One row per *distinct meaningful setup episode* (not per tick).

| column | type | notes |
|---|---|---|
| `setup_id` | TEXT PK | stable id, e.g. `set_<ts>_<rand6>` |
| `setup_key` | TEXT | `symbol|mode` — partial-unique while `status='active'` (one active per coin+mode) |
| `symbol` | TEXT | |
| `mode` | TEXT | `scalp` / `day` / `swing` |
| `direction` | TEXT | `long` / `short` |
| `setup_type` | TEXT | breakout, breakdown, trend-continuation, mean-reversion, sweep-reclaim, momentum-thrust, squeeze-expansion, range-fade (see §1.1) |
| `entry_price` | DOUBLE | price at promotion |
| `buy_zone_low` | DOUBLE | |
| `buy_zone_high` | DOUBLE | |
| `target1` | DOUBLE | |
| `target2` | DOUBLE | |
| `stretch_target` | DOUBLE | |
| `invalidation` | DOUBLE | |
| `opportunity_score` | INT | `score` 0–100 |
| `confidence_score` | INT | 0–100 |
| `risk_score` | INT | numeric 0–100 (see §1.2); keep label too in `risk_label` |
| `conviction_score` | INT | 0–100 |
| `status` | TEXT | `active` / `resolved` / `expired` / `superseded` |
| `created_at` | TIMESTAMPTZ | promotion time |
| `updated_at` | TIMESTAMPTZ | |
| `entry_filled` | BOOLEAN | did price enter the buy zone after promotion |
| `entry_filled_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ | `created_at + MAX_HORIZON` (30d) — resolver stop point |
| `resolved_at` | TIMESTAMPTZ | nullable |
| `resolution_reason` | TEXT | `invalidation` / `horizon-complete` / `superseded` / `entry-timeout` |
| `promotion_reason` | TEXT | which rule fired (§5) |
| `run_id` | TEXT | link to `scan_runs` |
| `history_tier` | TEXT | T0–T3 at promotion (lets us weight learning by data maturity) |
| `engine` | TEXT | `v2` / `v1-fallback` |
| `risk_label` | TEXT | High/Medium/Low |

**Indexes:** `(symbol, mode, status)`, `(status, expires_at)` (resolver scan),
`(setup_type)`, `(direction)`, `(created_at)`, partial-unique
`(setup_key) WHERE status='active'`.

### 1.1 `setup_type` derivation (from the dominant signal at promotion)
| condition | type |
|---|---|
| breakout signal up-break confirmed | `breakout` |
| breakout signal down-break confirmed | `breakdown` |
| breakout sweep/reclaim ≠ 0 | `sweep-reclaim` |
| trend dominant, low reversalScore | `trend-continuation` |
| trend dominant, high reversalScore | `mean-reversion` |
| momentum dominant (MACD cross / ADX) | `momentum-thrust` |
| volatility compression dominant | `squeeze-expansion` |
| else (mid-range) | `range-fade` |

### 1.2 `risk_score` (numeric)
`risk_score = clamp( base[type] + (1−liquidityFactor)·30 + (100−confidence)·0.15 )`
where `base = {meme:60, emerging:55, alt:40, large-alt:35, major:25}`.

---

## 2. `signal_values` table

Tall/normalized — one row per (setup, signal) captured at promotion. This is the
table similarity & per-signal success-rate queries hit.

| column | type | notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `setup_id` | TEXT FK | |
| `signal_name` | TEXT | volatility / volume / trend / momentum / breakout |
| `numeric_value` | DOUBLE | the signal's primary raw value (e.g. RVOL, RSI, BBW pct) |
| `normalized_score` | INT | the signal's 0–100 score |
| `timeframe` | TEXT | bar interval used: scalp=5m, day=1h, swing=4h |
| `direction_contribution` | DOUBLE | `long − short` (signed) |
| `confidence_contribution` | DOUBLE | the signal's confidence 0–1 |
| `detail` | JSONB | full raw numbers (rsi, adx, z, stretch, posInRange…) for audit |
| `created_at` | TIMESTAMPTZ | |

**Indexes:** `(setup_id)`, `(signal_name, normalized_score)`,
`(signal_name, numeric_value)`.

> The "primary numeric value" per signal: volatility→volRegimePct,
> volume→rvol, trend→trendScore, momentum→rsi, breakout→posInRange. Full vector
> stays in `detail`.

---

## 3. `outcomes` table

One row per (setup, horizon), written by the resolver once that horizon's data
window has fully elapsed.

| column | type | notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `setup_id` | TEXT FK | |
| `horizon` | TEXT | `1h` / `4h` / `24h` / `7d` / `30d` |
| `hit_target1` | BOOLEAN | reached within this horizon (cumulative) |
| `hit_target2` | BOOLEAN | |
| `hit_stretch` | BOOLEAN | |
| `hit_invalidation` | BOOLEAN | |
| `max_favorable_excursion` | DOUBLE | MFE %, direction-adjusted |
| `max_adverse_excursion` | DOUBLE | MAE %, direction-adjusted |
| `final_return` | DOUBLE | return at horizon end, direction-adjusted % |
| `price_at_horizon` | DOUBLE | |
| `samples` | INT | price points used (data-quality guard) |
| `data_complete` | BOOLEAN | false if snapshot gaps left the window underfilled |
| `resolved_at` | TIMESTAMPTZ | |

**Unique:** `(setup_id, horizon)`. **Indexes:** `(setup_id)`, `(horizon)`,
`(horizon, hit_target1)`, `(horizon, hit_invalidation)`.

### 3.1 Direction-adjusted math (entry = `entry_price`)
For a window of prices `P` (from `snapshot_coins`, `created_at … created_at+horizon`):
- LONG: `MFE = (max(P) − entry)/entry`, `MAE = (entry − min(P))/entry`,
  `final = (P_end − entry)/entry`.
- SHORT: mirror (`MFE = (entry − min(P))/entry`, etc.).
- `hit_target1` = LONG: `max(P) ≥ target1` (SHORT: `min(P) ≤ target1`); same idea
  for target2/stretch/invalidation.

### 3.2 Win label (derived, used by learning queries — not a stored column)
`win = hit_target1 AND NOT (hit_invalidation before target1)` evaluated at the
**mode's natural horizon** (scalp→4h, day→24h, swing→7d). Secondary label:
`final_return > 0`. Kept as a SQL expression/view so we can iterate without
migrations.

---

## 4. `setup_vectors` table (similarity / kNN)

Dedicated table (cleaner than a column; ready for `pgvector` later).

| column | type | notes |
|---|---|---|
| `setup_id` | TEXT PK FK | |
| `vector` | DOUBLE PRECISION[] | normalized features in [0,1] |
| `feature_names` | TEXT[] | parallel names (interpretability) |
| `dims` | INT | |
| `l2norm` | DOUBLE | precomputed for cosine |
| `created_at` | TIMESTAMPTZ | |

### 4.1 Feature vector (decision-time, ~14 dims, all normalized 0–1)
`[ dir(long=1/short=0), volRegimePct/100, compression/100, rvolNorm,
volumeZsquash, (emaAlign+1)/2, (structure+1)/2, stretchTanh, rsi/100, adx/100,
(macdSign+1)/2, posInRange, breakoutState(0/.5/1), conviction/100, confidence/100 ]`

- v1: similarity computed in SQL/app (cosine via stored `l2norm`, or euclidean).
  Filter by `mode` (and optionally `direction`) before ranking.
- v2 (future): enable the `pgvector` extension, store `vector vector(14)`, add an
  `ivfflat`/`hnsw` index for scalable ANN. The migration is additive; this spec
  keeps `DOUBLE PRECISION[]` so it works with **zero extensions** today.

---

## 5. Setup promotion rules (event-driven — option 2)

Evaluated each scan, per (symbol, mode), against the current **active** setup
(if any) and the previous scan's opportunity for that key. A scan becomes/updates
a setup when **any** trigger fires:

| # | trigger | action |
|---|---|---|
| R1 | **New setup emerges**: no active setup AND `conviction ≥ EMERGE_CONVICTION` (65) AND buy zone valid | create |
| R2 | **Direction change** long↔short on an active setup | supersede old (`resolved`, reason `superseded`) → create new |
| R3 | **Setup type changes** vs active setup | supersede → create new |
| R4 | **Coin enters top list**: `rank ≤ TOP_N` (5) in its mode, was not before | create (if none active) |
| R5 | **Buy zone becomes valid**: price enters buy zone when previously outside | create (if none active) / mark `entry_filled` |
| R6 | **Conviction crosses a band** (65/75/85) upward | update active (or create if none) |
| R7 | **Major score jump**: `conviction − prevConviction ≥ JUMP_DELTA` (12) | update active (or create if none) |

Guards:
- **One active setup per (symbol, mode)** (partial-unique index). Updates (R6/R7)
  modify it in place — but **never rewrite captured `signal_values`/`vector`**
  (decision-time integrity); they only bump `conviction/score/updated_at`.
- **Cooldown**: after a setup resolves/expires, no new setup for the same
  `(symbol, mode, direction)` for `COOLDOWN_MIN` (e.g. 30 min) unless invalidated.
- **Entry timeout**: if `entry_filled` never becomes true within `ENTRY_WINDOW`
  (e.g. mode-scaled: scalp 1h, day 6h, swing 24h) → `status='expired'`,
  reason `entry-timeout` (signal fired but trade never triggered — still useful
  to learn from).
- All thresholds are env-configurable (`RL_EMERGE_CONVICTION`, `RL_TOP_N`,
  `RL_JUMP_DELTA`, `RL_COOLDOWN_MIN`, …).

State for comparison comes from the DB (`active` setup) plus a small in-memory
`lastByKey` map in the scanner for prev-rank / prev-conviction (rebuildable, and
falls back to the active setup's stored values after a restart).

---

## 6. Outcome resolver cron

- Separate schedule, `RL_RESOLVER_MINUTES` (5–15, default 10), independent of the
  scan cron. Skips entirely on the memory driver.
- For each **active** (and not-yet-fully-resolved) setup:
  1. For each horizon H in `[1h,4h,24h,7d,30d]` where `created_at + H ≤ now` and
     no `outcomes` row exists yet:
     - load price path from `snapshot_coins` (`symbol`, `created_at … created_at+H`),
     - compute MFE / MAE / target & invalidation hits / final_return (§3.1),
     - upsert `outcomes (setup_id, horizon)`, set `data_complete`/`samples`.
  2. Track `entry_filled` (did price enter buy zone) and set timestamps.
  3. **Resolve** the setup (`status='resolved'`) when invalidation is hit (reason
     `invalidation`) **or** the 30d horizon is done (`horizon-complete`).
     **Expire** it on entry timeout. Otherwise leave `active`.
- **Idempotent**: only resolves horizons whose window has fully elapsed; unique
  `(setup_id, horizon)` upsert; safe to run repeatedly.
- **Backfill mode** (`scripts/backfillOutcomes.js`): same logic over historical
  setups — because `snapshot_coins` retains the price path, old setups can be
  fully labeled in one pass.
- **Data-quality**: if the price window has gaps, `data_complete=false` and that
  outcome is down-weighted in learning queries.

---

## 7. Similarity & success-rate query shapes (what this unlocks)

These are the questions the schema is built to answer later (sketches, not final):

**A. "Find similar historical setups"** — kNN on the feature vector, same mode:
```sql
-- app computes cosine using stored l2norm, or:
SELECT s.setup_id, s.symbol, s.setup_type, s.direction
FROM setup_vectors v JOIN setups s USING (setup_id)
WHERE s.mode = $mode AND s.status = 'resolved'
-- ORDER BY  <distance(v.vector, $queryVector)>  ASC  LIMIT $k;
```
(v2: `ORDER BY vector <=> $queryVec` with pgvector.)

**B. "What was the success rate of this pattern?"** — over the kNN neighborhood
or a `setup_type`:
```sql
SELECT o.horizon,
       AVG((o.hit_target1 AND NOT o.hit_invalidation)::int) AS win_rate,
       AVG(o.final_return)                                  AS avg_return,
       AVG(o.max_adverse_excursion)                         AS avg_mae,
       COUNT(*)                                             AS n
FROM setups s JOIN outcomes o USING (setup_id)
WHERE s.setup_type = $type AND s.mode = $mode
GROUP BY o.horizon ORDER BY o.horizon;
```

**C. "Which signals actually improved accuracy?"** — bucket each signal's
normalized score and compare win rates / returns (edge per signal):
```sql
SELECT sv.signal_name,
       width_bucket(sv.normalized_score, 0, 100, 10) AS bucket,
       AVG((o.hit_target1 AND NOT o.hit_invalidation)::int) AS win_rate,
       AVG(o.final_return) AS avg_return, COUNT(*) AS n
FROM signal_values sv
JOIN outcomes o ON o.setup_id = sv.setup_id AND o.horizon = '24h'
GROUP BY sv.signal_name, bucket
ORDER BY sv.signal_name, bucket;
```
Plus correlation `corr(sv.normalized_score, o.final_return)` per signal → the
direct input to **future weight optimization** (Radar Learn V4): reweight signals
by measured edge, per mode.

---

## 8. New endpoints (read-only, for inspection/learning UI later)
- `GET /api/setups?status=&mode=&limit=` — recent setups
- `GET /api/setups/:id` — setup + its signal_values + outcomes + vector
- `GET /api/learn/success-rate?type=&mode=` — query B
- `GET /api/learn/signal-edge?horizon=` — query C
- `GET /api/learn/similar/:setupId?k=` — query A

## 9. Implementation plan (after approval)
1. `migrations/002_radar_learn.sql` — 4 tables + indexes.
2. Store methods (pg + memory no-op): `createSetup`, `supersedeSetup`,
   `updateSetup`, `getActiveSetup(symbol,mode)`, `recordSignalValues`,
   `saveSetupVector`, `getResolvableSetups`, `upsertOutcome`, `resolveSetup`,
   `getCoinHistories` (reused).
3. `services/radarLearn.js` — promotion evaluator (§5) + setup_type (§1.1) +
   vector builder (§4.1); called from `scanner.js` after scoring (Postgres only).
4. `services/outcomeResolver.js` + cron wiring (§6) + `scripts/backfillOutcomes.js`.
5. Learn endpoints (§8).
6. Tests: promotion-rule unit tests (each trigger), resolver math on a synthetic
   price path (MFE/MAE/target hits), and an end-to-end pg-mem run asserting a
   setup → signal_values → vector → outcome chain.

## 10. Open defaults to confirm (base layer)
1. **Thresholds** (§5): EMERGE_CONVICTION 65, TOP_N 5, JUMP_DELTA 12, COOLDOWN 30m — ok?
2. **Win definition** (§3.2): target1-before-invalidation at the mode's natural horizon — ok as the primary label?
3. **pgvector**: `DOUBLE PRECISION[]` now, pgvector later — ok? (keeps deploy dependency-free today)
4. **Horizons** fixed at 1h/4h/24h/7d/30d for every mode — ok, or scale per mode?

---

# ADDENDUM A — Deep Historical Backfill & Depth-Aware Models

Requirement: **do not cap analysis at 1 year.** For every asset, ingest and
analyze as much *reliable* history as each source allows, track provenance per
asset/source, and treat assets differently by how much clean history they have.
A 30-day meme must never be compared the same way as BTC with years of candles.

## 11. Backfill sources & priority

Per asset, attempt sources in priority order; the **best** (deepest, cleanest)
becomes the asset's primary history. All others are still stored for cross-checks.

| pri | source | endpoint | depth | granularity |
|---|---|---|---|---|
| 1 | **Binance/exchange candles** | `/api/v3/klines` (paginate `startTime`) | to listing (BTC ~2017) | 1d full history + 1h/4h recent window |
| 2 | **CoinGecko** | `/coins/{id}/market_chart?days=max` | to CG listing | daily (close/volume; OHLC only ≤365d free → mark `ohlc_partial`) |
| 3 | **GeckoTerminal / DEX Screener** | pool OHLCV | weeks–months (DEX tokens) | hourly/daily where available |
| 4 | **Macro** (Gold, VIX, DXY, Nasdaq, S&P 500) | FRED / Stooq (free, decades) → TwelveData/Polygon (keyed) | as far back as provider allows | daily |

- **Pagination to earliest:** Binance returns ≤1000 candles/call; loop `startTime`
  forward from 0 (or asset listing) until "now", throttled via the per-provider
  limiter (§0.2 of the scoring spec). Resumable & idempotent.
- **Reliability first:** a source is only adopted as primary if it passes the
  quality gate (§13). Garbage/short series are stored but flagged, not trusted.
- **Storage sizing:** full history at **1d** for everyone; **1h/4h** only for a
  recent window (`HIST_INTRADAY_DAYS`, default 720d) to bound table size.
  Configurable.

## 12. New tables

### 12.1 `asset_history` (real OHLCV candles — distinct from the 2-min `snapshot_coins`)
| column | type | notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `asset` | TEXT | symbol, or `MACRO:GOLD` / `MACRO:VIX` / `MACRO:DXY` / `MACRO:NDX` / `MACRO:SPX` |
| `source` | TEXT | binance / coingecko / geckoterminal / fred / stooq / … |
| `timeframe` | TEXT | `1d` / `4h` / `1h` |
| `ts` | TIMESTAMPTZ | candle open time |
| `open` `high` `low` `close` | DOUBLE | (`open/high/low` null when source is close-only → `ohlc_partial`) |
| `volume` | DOUBLE | |
| `created_at` | TIMESTAMPTZ | |

**Unique** `(asset, source, timeframe, ts)` (idempotent upsert).
**Indexes** `(asset, timeframe, ts)`, `(asset, source, timeframe, ts DESC)`.

### 12.2 `asset_sources` (provenance — your required fields)
| column | type | notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `asset` | TEXT | |
| `source` | TEXT | |
| `timeframe` | TEXT | |
| `first_available_date` | TIMESTAMPTZ | **required** |
| `last_available_date` | TIMESTAMPTZ | |
| `data_coverage_days` | INT | **required** |
| `expected_points` | INT | days×(per-tf) |
| `actual_points` | INT | rows present |
| `missing_pct` | DOUBLE | `1 − actual/expected` |
| `gap_count` | INT | runs of consecutive missing candles |
| `has_gaps` | BOOLEAN | **required flag** |
| `source_quality` | INT | 0–100 (§13) **required** |
| `status` | TEXT | ok / partial / stale / failed |
| `last_backfilled_at` | TIMESTAMPTZ | |
| `notes` | TEXT | e.g. `ohlc_partial` |

**Unique** `(asset, source, timeframe)`.

### 12.3 `asset_profile` (depth + model class — one row per asset)
| column | type | notes |
|---|---|---|
| `asset` | TEXT PK | |
| `best_source` | TEXT | chosen primary |
| `best_timeframe` | TEXT | usually `1d` |
| `first_available_date` | TIMESTAMPTZ | |
| `coverage_days` | INT | from best source |
| `source_quality` | INT | of best source |
| `depth_score` | INT | 0–100 (§13) |
| `history_class` | TEXT | `long` / `medium` / `new` |
| `min_sample_met` | BOOLEAN | |
| `updated_at` | TIMESTAMPTZ | |

**Index** `(history_class)`, `(depth_score)`.

## 13. Historical depth score, sample rule, classes

**`source_quality`** (per asset/source) = `clamp(100 − missing_pct·100 − min(gap_count·2, 30))`.

**`depth_score`** (per asset, from best source):
```
coverageScore = clamp(100 · ln(coverage_days + 1) / ln(2000 + 1))   // 30d≈45, 365d≈78, 2000d≈100
depth_score   = round(0.6 · coverageScore + 0.4 · source_quality)
```

**Minimum sample rule** (`min_sample_met`): an asset qualifies for long-history
models only with **≥ MIN_LONG_CANDLES daily candles** (default 365) AND
`source_quality ≥ 60`. Indicator-level minimums from the scoring spec still apply
(e.g. EMA50 needs ≥50 bars; multi-year percentiles need ≥365).

**`history_class`** (configurable thresholds):
| class | rule |
|---|---|
| **long** | `coverage_days ≥ 365` AND `depth_score ≥ 60` AND `min_sample_met` |
| **medium** | `coverage_days ≥ 90` (and not long) |
| **new** | `coverage_days < 90` OR DEX-only OR `depth_score < 40` |

## 14. Depth-aware confidence & three model treatments

This **supersedes the live-snapshot warmup tier as the dominant confidence
driver** once backfill exists. Effective history = the better of (backfilled
depth) and (live snapshot tier) — so BTC is "deep" on day one.

`confidenceFinal = signalConfidence · depthFactor`, where
`depthFactor = 0.4 + 0.6 · (depth_score/100)` (clamped per class ceiling below).

| model | applies to | data used | baselines | confidence ceiling | similarity pool |
|---|---|---|---|---|---|
| **long-history** | `history_class=long` (BTC/ETH/large caps) | real `1d`+`4h` candles, years | multi-year vol/return percentiles, regime (bull/bear/range) | 1.0 | long-class setups |
| **medium-history** | `history_class=medium` | `1d`/`1h` candles, 90–365d | 90-day percentiles | 0.80 | medium-class setups |
| **new/emerging** | `history_class=new` (new memes, DEX-only) | recent snapshots + short candles | recent-window only; **no long percentiles** | 0.60 | new-class setups; emerging risk features (liquidity, rug, age, vol-accel) weighted up |

**Scoring-engine integration (Tier B, now full-history):** the engine gains a
history provider that returns the **best** series per asset —
`asset_history` real candles (preferred, deep, real OHLC) → else `snapshot_coins`
synthetic bars → else warmup. Real OHLC means ATR/ADX/MACD become exact (not
approximations) for long/medium assets. `depth_score` and `history_class` are
attached to every scored opportunity and carried onto the setup.

## 15. Radar Learn integration (apples-to-apples learning)

- `setups` gains `history_class` and `depth_score` columns (captured at promotion).
- **Similarity (§7A) is segmented by `history_class`** — kNN only matches within
  the same class, so a 30-day meme is never compared to multi-year BTC.
- **Success-rate (§7B) and signal-edge (§7C) queries group by `history_class`**,
  and learning samples are **confidence-weighted by `depth_score`** (cleaner,
  deeper history counts more when tuning weights).
- Weight optimization (future V4) is computed **per (mode × history_class)** —
  the signals that work for long-history BTC swing trades differ from those for
  new-meme scalps, and the system learns them separately.

## 16. Backfill pipeline

- `services/historyBackfill.js`: per asset → per source (priority) → paginate to
  earliest → upsert `asset_history` → compute & upsert `asset_sources` provenance
  → recompute `asset_profile` (depth/class). Idempotent (unique-key upserts),
  resumable (continues from `last_available_date`), throttled per provider.
- **Run modes:** one-shot `scripts/backfillHistory.js [--asset BTC] [--full]`;
  plus a **daily keep-fresh cron** (`HIST_REFRESH_CRON`, not the 2-min scanner)
  that appends new candles and refreshes provenance. Heavy initial backfill runs
  once; daily top-ups are cheap.
- **Reliability gate:** sources failing the quality gate are marked
  `status=partial/failed` and excluded from `best_source` selection.
- Macro assets backfilled the same way into `asset_history` under `MACRO:*`.

## 17. New endpoints
- `GET /api/assets/:symbol/coverage` — provenance + depth_score + history_class
- `GET /api/assets/:symbol/history?timeframe=1d&from=&to=` — candles
- `GET /api/learn/coverage` — fleet overview (counts per class, avg depth)

## 18. Implementation plan (this addendum, after the base layer)
1. `migrations/003_deep_history.sql` — `asset_history`, `asset_sources`, `asset_profile` + indexes; add `history_class`,`depth_score` to `setups`.
2. `services/sources/binanceKlines.js`, `coingeckoHistory.js`, `dexHistory.js`, `macroHistory.js` — paginating fetchers (rate-limited, resumable).
3. `services/historyBackfill.js` — orchestrator + provenance + depth/class computation.
4. `engines/historyProvider.js` — best-series selector feeding the scoring engine (real candles → synthetic bars → warmup).
5. Depth-aware confidence + model-class selection in `scoringV2.js`.
6. `scripts/backfillHistory.js` + daily refresh cron.
7. Coverage endpoints (§17).
8. Tests: provenance math (coverage/gaps/quality/depth), class thresholds, pagination stitching on a fixture, and best-series selection precedence.

## 19. Open defaults to confirm (addendum)
1. **Class thresholds** (§13): long ≥365d & depth≥60; medium ≥90d; new <90d — ok?
2. **Min long sample**: `MIN_LONG_CANDLES=365` daily candles & quality≥60 — ok?
3. **Intraday storage window**: full history at `1d`, but `1h/4h` only for last **720 days** (size control) — ok, or store intraday for all time?
4. **Macro free source default**: **Stooq + FRED** (no key needed) as the default, upgrading to TwelveData/Polygon when keys are present — ok?
5. **Confidence ceilings** per class (§14): long 1.0 / medium 0.80 / new 0.60 — ok?
