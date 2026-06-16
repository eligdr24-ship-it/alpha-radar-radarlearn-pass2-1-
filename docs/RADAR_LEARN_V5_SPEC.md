# Alpha Radar v5 — Pattern Library, Weight Optimization & Self-Improving Confidence Engine

**Status:** DRAFT — spec only, awaiting approval. No code until sign-off.
**Scope:** Adds a learning layer on top of the existing Radar Learn (Pass 1/2) data. Postgres-only, same as Radar Learn; memory store = no-ops.
**Hard constraint (carried from prior phases):** the *core scoring engines* (`scoring.js` v1, `scoringV2.js`) are NOT modified. v5 is a **calibration + analytics layer** that sits *after* scoring. Weight optimization, when it ships, changes the *inputs* to scoringV2 (the per-mode component weights) only through a versioned, gated, reversible mechanism — never silently.

---

## 0. Guiding principles

1. **Explainable before clever.** Categorical patterns and rule-based failure classification first; learned/clustered models are explicitly deferred. Every number a user sees must be traceable to rows.
2. **Small samples are the enemy.** Every rate uses a **Wilson lower bound** and **shrinkage toward a coarser prior**. A pattern with 6 samples and 0 wins is *not* treated as "0% — avoid"; it is treated as "unknown, leaning slightly below its parent."
3. **Point-in-time correctness.** A setup's confidence adjustment is computed from pattern stats **as they were at signal time**, never from the setup's own future outcome. No leakage.
4. **Nothing auto-changes weights without a version, a basis, and a rollback path.** Shadow-first, promote-on-evidence, one-click revert.
5. **Layered, not destructive.** v5 writes new tables and a calibrated `confidence_adjusted` value; it never overwrites `confidence_score` from scoring. Downstream can show both.

### Non-goals (v5)
- No neural nets / online clustering for pattern definition (vector similarity is used for *matching*, not for *defining* groups in v5).
- No change to universe building, indicators, target/zone math, or the resolver's `success_label` logic.
- No real-money execution logic.

---

## 1. Pattern Library

### 1.1 What a "pattern" is
A pattern is a **named, reusable bucket of historically comparable setups**, defined by a conjunction of categorical context dimensions. Patterns are **hierarchical**: each setup belongs to one pattern at *each* specificity level, from coarse to fine. This is the core mechanism that prevents combinatorial blow-up and tiny samples.

#### Dimensions (all already on `setups`, except `macro_state` which is new)
| Dimension | Source | Values |
|---|---|---|
| `mode` | setups.mode | scalper / day / swing |
| `direction` | setups.direction | long / short |
| `history_class` | setups.history_class | long / medium / new |
| `setup_type` | setups.setup_type | breakout, pullback, reclaim, … (existing classifier) |
| `market_regime` | setups.market_regime | risk_on / risk_off / neutral |
| `narrative` | setups.narrative | sector/narrative string |
| `macro_state` | **NEW** (§9.8) | risk_on / risk_off / neutral / btc_led / btc_bleed |
| signal-vector cluster | setup_vectors | *matching only in v5, not a grouping key* |

#### Specificity ladder (nested patterns)
```
L0  mode + direction
L1  + history_class
L2  + setup_type
L3  + market_regime         (and macro_state folded in at L3b, optional)
L4  + narrative
```
A setup at signal time is stamped into **one pattern per level it qualifies for** (L0…L4). Coarser levels always have more samples; finer levels are more specific but sparser. The confidence engine (§5) and matching (§2) pick the **most specific level that meets the activation threshold**, and shrink toward its parent.

> **Why hierarchical, not full cross-product?** The full product of the 7 dimensions is ~3·2·3·6·3·N_narratives·5 ≈ tens of thousands of cells — almost all empty. The ladder gives every setup a *guaranteed* populated coarse pattern plus progressively specific ones, with statistically sound fallback.

### 1.2 Pattern identity & naming
- `pattern_key` — canonical, deterministic string: `L{level}|mode=…|dir=…|hist=…|type=…|regime=…|narr=…`. Unique. Stable across restarts (pure function `patternKeysFor(setup) -> [{level, key, dims}]`).
- `pattern_name` — human label generated from dims, e.g. *"Swing · Long · Long-history · Breakout · Risk-on"* (L3) or *"Day · Short"* (L0).
- `conditions` — JSONB snapshot of the dimension tuple (for display + forward-compat).

### 1.3 Stored stats (per pattern, per window)
Computed into `pattern_performance` (§9.3). Two windows kept: **all_time** and **rolling_90d** (configurable). Fields:
- `sample_size`, `wins`, `losses`, `open`
- `win_rate`, **`win_rate_lb`** (Wilson 95% lower bound — the number used for ranking/decisions)
- `avg_return`, `avg_rr`
- `target1_rate`, `target2_rate`, `stretch_rate`, `invalidation_rate`, `failure_rate`
- `top_failure_reasons` JSONB (reason → count, from §4)
- `first_seen`, `last_seen`
- `trend` ∈ {improving, stable, declining} (§1.4)
- `recommended_conf_adj` (signed points, bounded; §5.6)
- `activated` (bool — meets min sample; only activated patterns influence confidence/weights)
- `computed_at`

### 1.4 Trend ("gaining strength / losing edge")
`trend` compares **rolling_90d win_rate_lb** vs **all_time win_rate_lb** (and a slope over the last K recompute snapshots stored in a small `pattern_perf_history` ring, or derived from windowed recompute):
- improving: rolling_lb − alltime_lb ≥ +Δ_trend (default +0.05) AND rolling sample ≥ min_trend_n
- declining: rolling_lb − alltime_lb ≤ −Δ_trend
- else stable

### 1.5 Lifecycle
- **On setup creation:** `patternKeysFor(setup)` → upsert `patterns` rows (insert if new) → insert `pattern_members` (one row per level). O(levels) writes, no scan.
- **On resolution:** mark member resolved; enqueue affected pattern_ids for recompute; record `pattern_outcome_delta` (§7.4) for Trade Replay "improved/weakened".
- **Periodic recompute job** (daily, reuses the cron infra): recompute `pattern_performance` for all patterns with ≥1 newly-resolved member since last run; refresh trends + recommended adj.

---

## 2. Similar Setup Matching

For each new setup we answer "what happened to setups like this before?" using a **hybrid** of the categorical pattern and the existing vector kNN.

### 2.1 Algorithm
1. **Categorical cohort:** the members of the **most-specific activated pattern** the setup belongs to (fallback down the ladder until `sample_size ≥ min_match_n`, default 8). This guarantees an explainable, populated cohort.
2. **Vector refinement (optional, ranked):** within that cohort (or, if cohort thin, within the same `mode`), rank members by cosine similarity on `setup_vectors.vector` (existing `cos()` in pgStore). Surface the top-N closest as concrete examples.
3. Only **resolved** members count toward rates; the **current setup is always excluded** (carry forward the existing `v.setup_id <> $current` guard).

### 2.2 Returned object (extends the current `learnSimilar`)
```
{
  pattern_id, pattern_name, level, matched_dims,
  n,                      // resolved cohort size
  win_rate, win_rate_lb,
  avg_return, avg_rr,
  target1_rate, target2_rate, invalidation_rate,
  top_failure_reasons: [{reason, share}],
  closest: [{setup_id, symbol, similarity, success_label, final_return}],  // vector top-N
  basis_level_fellback: bool   // true if we used a coarser level than L-max
}
```
This object powers Trade Replay (§7) and the Selected-Coin hero's "Similar Historical Setups" block. It is computed **server-side** so the math is shared and testable.

---

## 3. Weight Optimization

> **Highest-risk component. Ships LAST, behind a flag, shadow-first.** The thing being optimized is the per-mode component weight map in `scoringV2.js`:
> `MODE_WEIGHTS[mode] = { volatility, volume, trend, momentum, breakout }` (currently hand-set per scalp/day/swing).

### 3.1 Segmentation
Weights are tuned per **segment** = `mode × direction × history_class × asset_class`. Coarse segments (e.g. `day·long·*·major`) accrue samples faster; sparse segments inherit the global/mode prior and stay frozen until they have data.

### 3.2 Method (transparent, bounded — NOT a black box)
For each segment with ≥ `min_weight_n` resolved setups (default 50):
1. For each component c ∈ {volatility, volume, trend, momentum, breakout}, compute a **discrimination score** = how well that component's normalized signal separated winners from losers. Two cheap, explainable options (use point-biserial correlation as primary):
   - `r_pb(c)` = point-biserial correlation between the component's `normalized_score` (from `signal_values`) and the binary win/loss label.
   - cross-check: `mean(c | win) − mean(c | loss)`.
2. Form a **target weight** `w*_c ∝ max(0, r_pb(c))`, renormalized to sum to 1 within the mode (preserves scoringV2's normalization contract).
3. **Nudge, don't jump.** New weight = EWMA toward target with a tiny rate and a hard clamp:
   `w_new = clamp( w_cur + lr · (w*_c − w_cur), w_cur ± max_delta )`, then renormalize.
   Defaults: `lr = 0.10`, `max_delta = 0.03` absolute per component per update.
4. **Regularize toward the prior:** blend with the existing hand-set mode weights `w_prior`: `w_final = (1−λ)·w_new + λ·w_prior`, `λ = 0.5` default (shrinkage; prevents drift away from sane defaults).

### 3.3 Guardrails (all required before a proposal can auto-apply)
- **Min sample:** segment resolved n ≥ `min_weight_n`.
- **Max change:** per-component |Δ| ≤ `max_delta`; if any component exceeds `max_delta_review` (default 0.05) → `manual_review_required = true`, do not auto-apply.
- **Walk-forward validation:** split resolved setups by time (train = older 70%, holdout = newer 30%). A proposal is only eligible if its **holdout ranking metric** (see §3.4) ≥ current weights' holdout metric by ≥ `min_improvement` (default +0.01) AND not worse on the second-newest fold (anti-luck).
- **Rollback on regression:** after promotion, the periodic job re-measures the *live* metric over the next window; if it drops below the pre-promotion baseline by `regress_tol`, auto-rollback to the parent version and flag `manual_review_required`.
- **No overfit:** λ-shrinkage (§3.2.4) + min sample + holdout. Segments below threshold are never touched.

### 3.4 Metric
Primary: **realized RR-weighted hit-rate on the holdout**, i.e. would the *re-ranked* top-K opportunities have produced better resolved returns? Concretely, recompute alphaScore for holdout setups under candidate weights, take the rank correlation (Spearman) between predicted rank and realized `final_return` / `success_label rank`. Higher = better. This measures *ranking quality*, which is what the dashboard ultimately uses — not raw classification accuracy.

### 3.5 Application path
`weight_versions` (immutable proposals/snapshots) → shadow run (compute-only, logged) → promotion writes the active set into `model_weights` and flips the active pointer. scoringV2 reads active weights via a small accessor `getActiveWeights(mode, segment)` that **defaults to the hard-coded `MODE_WEIGHTS` when no active row exists** (zero behavior change until a version is promoted).

---

## 4. Failure Learning

Goal: for every losing/expired setup, attach a **primary reason** + secondary reasons + evidence. v5 uses a **deterministic rule-based classifier** (explainable, testable). A learned classifier is future work.

### 4.1 Reason taxonomy (enum `failure_reason`)
`hit_invalidation`, `failed_to_enter_zone`, `failed_to_reach_target`, `market_regime_changed`, `volume_faded`, `btc_reversed`, `macro_risk_off`, `liquidity_weakness`, `signal_too_early`, `signal_too_late`, `unknown`.

### 4.2 Evidence sources (all already collected)
- `outcomes` (hit_* flags, MFE/MAE, final_return, success_label)
- `setups` (entry_filled_at, zone, created_at, resolved_at)
- price `path` (snapshot_coins / asset_history) — same source Trade Replay uses
- BTC path + macro candles (binance.vision / Stooq) for btc_reversed / macro_risk_off
- volume series (snapshot_coins.volume or asset_history) for volume_faded / liquidity_weakness

### 4.3 Rules (ordered; first strong match = primary, others recorded as secondary with confidence)
| Reason | Trigger (sketch) |
|---|---|
| failed_to_enter_zone | `entry_filled_at IS NULL` and status expired |
| hit_invalidation | any outcome `hit_invalidation` and no prior target |
| signal_too_late | at signal, price already ≥ X% of the way to T1 (entry near T1); little room left |
| signal_too_early | invalidation hit, **then** price later crossed T1 within the window (right call, wrong timing) |
| btc_reversed | BTC return over trade window opposes the setup direction by ≥ btc_thresh; coin beta high |
| macro_risk_off | macro_state flipped to risk_off during window (VIX↑ / DXY↑ vs signal-time) |
| market_regime_changed | `regime(resolve) ≠ regime(signal)` and unfavorable |
| volume_faded | post-signal mean volume < vol_fade_frac × pre-signal mean |
| liquidity_weakness | low marketcap_rank/volume at signal (thin book proxy) |
| failed_to_reach_target | resolved, no target, no invalidation (timed out flat) |
| unknown | none of the above fire strongly |

Each rule returns `{fires: bool, strength: 0..1, evidence: {...}}`. Output: 1 primary + ranked secondaries + per-reason evidence JSON, `classifier_version` stamped.

### 4.4 Aggregation
Failure reasons roll up into `pattern_performance.top_failure_reasons` and the Pattern Dashboard's "common failure reasons," and feed the confidence engine's `failure_pattern_risk` factor (§5).

---

## 5. Confidence Adjustment (the self-improving part)

A **post-scoring calibration layer**. scoring produces `confidence_score`; v5 computes `confidence_adjusted` = `clamp(confidence_score + Σ factor_deltas, 0, 100)`, with the **total** adjustment bounded to ±`max_total_adj` (default ±15) so the engine can nudge but never override the model.

### 5.1 Factors (each bounded; each stored with its inputs in `confidence_adjustments`)
| Factor | Input | Effect |
|---|---|---|
| `pattern_winrate` | matched pattern `win_rate_lb` vs baseline 0.5, shrunk | ± up to 8 |
| `regime_match` | does current `market_regime`/`macro_state` match the pattern's historically favorable regime? | ± up to 4 |
| `history_depth` | asset `history_class` (long/med/new) | 0 / −2 / −4 (cap, never boosts) |
| `recent_model_perf` | global rolling resolved win_rate_lb (calibration) | ± up to 3 |
| `failure_pattern_risk` | share of cohort losses from a dominant failure reason | − up to 6 |

### 5.2 Bounds & cold-start
- Until the matched pattern is **activated** (≥ min sample), `pattern_winrate` and `failure_pattern_risk` contribute **0** (neutral). The engine is silent rather than noisy on thin data.
- Shrinkage: `winrate_used = (n·rate + k·prior) / (n + k)`, prior = parent pattern rate, `k = 10` (pseudo-count). This is what kills the "0% on 6 samples" problem.

### 5.3 Point-in-time
Computed at **setup creation**, reading pattern_performance **as of now** (before this setup resolves). Stored once. Trade Replay later shows the breakdown that *was used*.

### 5.4 Output surfaces
- `confidence_adjusted` stored on the setup context (or `confidence_adjustments` row joined for display).
- Ranking can optionally use `confidence_adjusted` (behind a flag `USE_ADJUSTED_CONFIDENCE`, default off in phase 1 — measure first).

### 5.6 Recommended adjustment (per pattern)
`pattern_performance.recommended_conf_adj` = the `pattern_winrate` factor that pattern would contribute, precomputed for the dashboard ("this pattern suggests +5 confidence").

---

## 6. Pattern Dashboard (`/patterns`)

New SPA route + `GET /api/patterns?window=&sort=`. Sections:
- **Best performing** (top by `win_rate_lb`, min sample) — name, win rate (+LB), avg return, avg RR, n, last seen.
- **Worst / most dangerous** (lowest `win_rate_lb` or highest `invalidation_rate`).
- **Gaining strength** (`trend = improving`), **Losing edge** (`trend = declining`).
- Per-pattern card: win rate, avg return, sample size, last seen, top failure reasons, **recommended confidence adjustment**, sparkline of rolling win_rate (optional later).
- Filters by mode/direction/history_class/level. Mobile = cards.

API returns precomputed `pattern_performance` rows (no heavy compute on request). Empty-state copy for cold start.

---

## 7. Trade Replay Integration

Add a **"Pattern Match"** card to the existing replay page:
1. **Pattern matched** — name + level + matched dims (chips).
2. **Pattern historical win rate** — `win_rate_lb`, avg return, avg RR, n (the §2 object).
3. **Why it matched** — the dimension tuple rendered as "same mode + direction + history + setup type + regime."
4. **Did this outcome improve or weaken the pattern?** — `pattern_outcome_delta`: win_rate_lb of the pattern **before** vs **after** including this resolved setup. Show ▲/▼ and the delta. (Recorded at resolution so it's exact, not recomputed.)
5. Reuses the §2 "closest historical setups" list (vector top-N), each linking to its own replay.

No change to the consistency work already done (deriveResult etc.); this is additive.

---

## 8. System Performance Integration

Extend `/api/performance` + page with a **Patterns** block:
- Best performing patterns, Worst performing patterns (by `win_rate_lb`).
- Most improved (largest positive trend delta), Most dangerous (high invalidation_rate × sample).
- Links into `/patterns` and into example setups' Trade Replay.

Pure read of `pattern_performance`; consistent ranking math with the dashboard.

---

## 9. Database / Schema (migration `004_pattern_library.sql`)

All Postgres-only, auto-applied like 001–003. Memory store stubs everything to no-ops/empties.

### 9.1 `patterns`
```
pattern_id      BIGSERIAL PK
pattern_key     TEXT UNIQUE NOT NULL
pattern_name    TEXT NOT NULL
level           SMALLINT NOT NULL          -- 0..4
mode            TEXT, direction TEXT, history_class TEXT,
setup_type      TEXT, market_regime TEXT, narrative TEXT, macro_state TEXT,  -- nullable by level
conditions      JSONB NOT NULL
created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
INDEX(level), INDEX(mode,direction)
```

### 9.2 `pattern_members`
```
pattern_id BIGINT REFERENCES patterns,
setup_id   TEXT  REFERENCES setups,
level      SMALLINT NOT NULL,
added_at   TIMESTAMPTZ DEFAULT now(),
PRIMARY KEY (pattern_id, setup_id)
INDEX(setup_id)
```

### 9.3 `pattern_performance`
```
pattern_id BIGINT REFERENCES patterns,
window     TEXT NOT NULL,                 -- 'all_time' | 'rolling_90d'
sample_size INT, wins INT, losses INT, open INT,
win_rate NUMERIC, win_rate_lb NUMERIC,
avg_return NUMERIC, avg_rr NUMERIC,
target1_rate NUMERIC, target2_rate NUMERIC, stretch_rate NUMERIC,
invalidation_rate NUMERIC, failure_rate NUMERIC,
top_failure_reasons JSONB,
first_seen TIMESTAMPTZ, last_seen TIMESTAMPTZ,
trend TEXT,                               -- improving|stable|declining
recommended_conf_adj NUMERIC,
activated BOOLEAN DEFAULT false,
computed_at TIMESTAMPTZ DEFAULT now(),
PRIMARY KEY (pattern_id, window)
```

### 9.4 `model_weights` (current active)
```
segment_key TEXT NOT NULL,                -- mode|direction|history_class|asset_class
component   TEXT NOT NULL,                -- volatility|volume|trend|momentum|breakout
weight      NUMERIC NOT NULL,
version_id  BIGINT REFERENCES weight_versions,
updated_at  TIMESTAMPTZ DEFAULT now(),
PRIMARY KEY (segment_key, component)
```

### 9.5 `weight_versions` (immutable history)
```
version_id BIGSERIAL PK,
segment_key TEXT NOT NULL,
weights JSONB NOT NULL,                    -- {component: weight}
parent_version_id BIGINT NULL,
basis JSONB,                               -- {sample_size, metric_before, metric_after, holdout}
status TEXT NOT NULL,                      -- proposed|shadow|active|rolled_back|superseded
manual_review_required BOOLEAN DEFAULT false,
created_by TEXT,                           -- 'auto' | 'manual:<user>'
created_at TIMESTAMPTZ DEFAULT now(),
activated_at TIMESTAMPTZ NULL
INDEX(segment_key, status)
```

### 9.6 `failure_reasons`
```
id BIGSERIAL PK,
setup_id TEXT REFERENCES setups,
outcome_id BIGINT NULL,
primary_reason TEXT NOT NULL,
secondary_reasons JSONB,                   -- [{reason, strength}]
evidence JSONB,
confidence NUMERIC,
classifier_version TEXT,
classified_at TIMESTAMPTZ DEFAULT now()
INDEX(setup_id), INDEX(primary_reason)
```

### 9.7 `confidence_adjustments`
```
id BIGSERIAL PK,
setup_id TEXT REFERENCES setups,
pattern_id BIGINT NULL,
base_confidence NUMERIC,
adjusted_confidence NUMERIC,
factors JSONB,                             -- {factor: {delta, inputs}}
created_at TIMESTAMPTZ DEFAULT now()
INDEX(setup_id)
```

### 9.8 `setups` alteration
```
ALTER TABLE setups ADD COLUMN macro_state TEXT NULL;
```
Set at signal time by an extended `deriveContext` (macro_state from BTC trend + VIX/DXY levels via existing macro candles). Recomputed at resolve time into evidence for failure learning (not overwritten on the setup).

### 9.9 (optional) `pattern_perf_history`
Small ring for trend slopes: `(pattern_id, window, win_rate_lb, sample_size, snapshot_at)`. Can be deferred; trend can start from the two-window comparison.

---

## 10. Safety Rules (consolidated)

1. **Versioned weights only.** No process writes `model_weights` except the promotion step, which always creates a `weight_versions` row first.
2. **Immutable history.** `weight_versions` rows are never updated except `status`/`activated_at`. Previous weights always recoverable.
3. **Rollback.** `rollbackWeights(segment_key)` repoints `model_weights` to the parent version and marks the bad one `rolled_back`. One call, reversible.
4. **Manual review flag.** Any proposal with a component |Δ| > `max_delta_review`, or a segment crossing into first-time activation, sets `manual_review_required = true` and is **never auto-applied** — it waits in `proposed`/`shadow`.
5. **Min sample to act.** Confidence factors neutral below activation threshold; weight proposals refused below `min_weight_n`.
6. **Shadow-first.** New weights run compute-only for `shadow_period` (e.g. 7 days / N resolutions), logged, before they can be promoted.
7. **Auto-rollback on regression.** Live metric monitored post-promotion; regression → revert + flag.
8. **No leakage.** All as-of computations exclude the subject setup's future; failure/perf recompute is idempotent.
9. **Config-gated.** Master flags: `PATTERNS_ENABLED`, `FAILURE_LEARNING_ENABLED`, `WEIGHTS_AUTO_OPTIMIZE` (default OFF), `USE_ADJUSTED_CONFIDENCE` (default OFF). Everything can run in measure-only mode.

---

## 11. Implementation recommendation & phased plan

**I endorse your ordering** (Pattern Library → Failure Learning → Weight Optimization), with one addition: slot **Confidence Adjustment** right after Pattern Library, because it depends on patterns (not weights) and delivers user-visible value immediately, in measure-only mode. Weight Optimization stays last — it's the only piece that can degrade live ranking, so it ships behind the most gates and after we have a healthy pattern + failure dataset to validate against.

| Phase | Deliverable | Depends on | Risk | Default mode |
|---|---|---|---|---|
| **5.1 Pattern Library** | migration 004 (patterns, members, performance) + `patternKeysFor`, membership on create/resolve, recompute job, `/patterns` page, §7/§8 read-only integration, §2 matching object | Radar Learn data | low (additive, read-only) | live |
| **5.2 Failure Learning** | `failure_reasons` + rule classifier (pure, unit-tested) + rollup into pattern_performance + Trade Replay reasons | 5.1, price/macro paths | low–med (read-only) | live |
| **5.3 Confidence Engine** | `confidence_adjustments` + factor functions + as-of computation at signal time; ranking still uses raw confidence | 5.1, 5.2 | med (visible numbers) | **measure-only** (`USE_ADJUSTED_CONFIDENCE=off`) |
| **5.4 Weight Optimization** | `model_weights`, `weight_versions`, proposer + walk-forward validation + shadow + promote/rollback + `getActiveWeights` accessor in scoringV2 | 5.1–5.3, ≥50/seg samples | **high** | **shadow-only** (`WEIGHTS_AUTO_OPTIMIZE=off`) |

**Why Pattern Library first (vs B or C):** it is the substrate everything else reads from. Failure Learning rolls *into* patterns; Confidence reads pattern stats; Weight Optimization validates against pattern/segment cohorts. Building B or C first means rebuilding their aggregation once patterns land.

### Per-phase acceptance criteria
- **5.1:** every resolved setup is a member of ≥1 activated pattern; `/patterns` shows non-empty best/worst with Wilson LBs; §2 object returns a populated cohort with correct exclusion of the current setup; recompute is idempotent (pg-mem test).
- **5.2:** every loss has a primary reason; classifier is pure + deterministic (unit tests per rule); reasons roll up into pattern_performance.
- **5.3:** `confidence_adjusted` is bounded ±15, neutral on cold-start, point-in-time (no leakage test); breakdown visible in Trade Replay.
- **5.4:** no weight write without a version row; rollback restores prior ranking exactly; auto-apply refused below min sample / above max_delta_review; scoringV2 unchanged when no active version exists.

---

## Appendix A — Math
- **Wilson lower bound** (95%, z=1.96): `lb = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`.
- **Shrinkage:** `rate_used = (n·p̂ + k·prior)/(n+k)`, prior = parent pattern rate, k=10.
- **Point-biserial:** `r_pb = (M₁−M₀)/s · √(p·q)` where M₁/M₀ are component means for win/loss, s = pooled SD, p/q class shares.
- **EWMA weight nudge + clamp + λ-shrink:** §3.2.

## Appendix B — Config / env knobs (defaults)
`PATTERN_MIN_SAMPLE=12`, `MATCH_MIN_N=8`, `SHRINK_K=10`, `MAX_TOTAL_ADJ=15`,
`WEIGHT_MIN_N=50`, `WEIGHT_LR=0.10`, `WEIGHT_MAX_DELTA=0.03`, `WEIGHT_MAX_DELTA_REVIEW=0.05`,
`WEIGHT_LAMBDA=0.5`, `WEIGHT_MIN_IMPROVEMENT=0.01`, `WEIGHT_SHADOW_DAYS=7`, `REGRESS_TOL=0.03`,
`ROLLING_WINDOW_DAYS=90`, `TREND_DELTA=0.05`.

## Appendix C — Testing strategy
- Pure functions (`patternKeysFor`, Wilson LB, shrinkage, failure rules, confidence factors, weight proposer) → `node --test`, no DB.
- SQL (membership, performance recompute, avg_rr, dashboard queries) → pg-mem, **portable SQL only** (no `ABS`/`NULLIF`/`HAVING` — carry forward the CASE-based patterns already used in `getPerformance`/`avgRrForSetups`).
- Leakage/idempotency tests for recompute + as-of confidence.
- Live numbers verified on Render (sandbox can't reach live APIs/Postgres).

## Appendix D — Open questions (please weigh in)
1. **macro_state** taxonomy — is {risk_on, risk_off, neutral, btc_led, btc_bleed} the right 5, or do you want a separate `btc_state` dimension?
2. **Ranking switch** — once measured, do you want `confidence_adjusted` to drive the dashboard ranking, or stay display-only?
3. **Vector clusters as pattern keys** — defer to v5.1 as planned, or do you want a coarse vector bucket folded into L4 now?
4. **Narrative cardinality** — narratives can be many/sparse; cap L4 to top-N narratives + "other"?
5. **Weight optimizer autonomy** — keep `WEIGHTS_AUTO_OPTIMIZE` off indefinitely (human promotes from a review queue), or allow auto-promote once holdout gates pass?
