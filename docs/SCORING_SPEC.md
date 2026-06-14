# Alpha Radar — Historical Scoring Spec v1 (DRAFT for approval)

Goal: replace single-tick heuristics with explainable signals computed from the
stored `snapshot_coins` history. Every signal must emit a machine- and
human-readable **why**.

---

## 0. Foundations (read first — this shapes everything)

### 0.1 What data we actually have
`snapshot_coins` stores, per symbol, **one row per scan** (~every
`SCAN_INTERVAL_MINUTES`, default 2 min):

| field | meaning |
|---|---|
| `at` | timestamp of the scan |
| `price` | spot price at scan time (point sample, **not** a candle close) |
| `volume24h_usd` | **rolling** 24h volume at scan time |
| `liquidity_usd` | liquidity (DEX) or volume proxy (CEX) |
| `change24h` | 24h % change at scan time |

We do **NOT** have native OHLC candles, per-interval (1h/4h) volume buckets, or
order-book data. Classic ATR / MACD / ADX assume OHLC; we must adapt.

### 0.2 Two implementation tiers
- **Tier A — from stored snapshots (implement now).** Synthesize bars from
  sampled prices. Sufficient for realized vol, RVOL, EMA/RSI/MACD on sampled
  closes, range/breakout, structure. ATR/ADX become *approximations*.
- **Tier B — from exchange klines (future, optional).** Pull true OHLC from
  Binance `/api/v3/klines` per symbol for exact ATR/ADX/true-range. Higher API
  cost; add later behind a flag. **Spec marks every place Tier B would improve.**

> **Decision needed:** approve Tier A now, Tier B later? (My recommendation.)

### 0.3 Synthetic bars (Tier A)
Resample the price series into fixed buckets per mode:

| mode | bar interval | trend window | why |
|---|---|---|---|
| scalp | 5m | last ~4–8h | fast |
| day | 1h | last ~3–5d | medium |
| swing | 4h | last ~20–30d | slow |

For each bucket: `open`=first sample, `close`=last sample, `high`=max sample,
`low`=min sample, `volume`=last `volume24h_usd` (rolling) / mean. Buckets with
too few samples are flagged `lowSample` and down-weighted. Gaps (missed scans)
are forward-filled up to 1 bar, else the bar is skipped.

> Note: synthetic high/low come from *intra-bucket sample dispersion*, so ATR
> here understates a real candle's range. Acceptable for ranking; flagged.

### 0.4 Common signal output contract
Every signal returns the same shape, which makes aggregation + explainability
uniform:
```js
{
  key: 'volume_acceleration',
  score: 0..100,        // signal-local meaning (defined per signal)
  long:  -1..1,         // normalized push toward LONG  (× weight later)
  short: -1..1,         // normalized push toward SHORT (× weight later)
  confidence: 0..1,     // data sufficiency × signal clarity
  status: 'ok'|'partial'|'insufficient',
  why: 'Volume 3.2× its 7d average while price rose 1.4% → buyers in control',
  detail: { rvol: 3.2, z: 2.8, ... }   // raw numbers for audit/tooltip
}
```

### 0.5 Warmup tiers (critical — avoids garbage on a fresh DB)
History accrues over real time (2-min cadence → 720 points/day). Signals
**degrade gracefully** and lower `confidence` when history is short.

| tier | history | unlocks | max confidence |
|---|---|---|---|
| T0 | < 1h | change24h + RVOL-lite only; mostly neutral | 0.25 |
| T1 | ≥ 24h | realized vol, RVOL vs 24h, RSI, EMA9/21, range, basic breakout | 0.65 |
| T2 | ≥ 7d | 7d baselines, EMA50, MACD, ADX, BB-width percentile, sweep/reclaim | 0.85 |
| T3 | ≥ 30d | 30d baselines & full percentiles | 1.0 |

Until T1, the engine falls back toward the current heuristic with a clear
`status:'insufficient'` and low confidence (so the dashboard says "warming up").

### 0.6 Aggregation
```
LongScore  = clamp( Σ wᵢ · signalᵢ.long  · signalᵢ.confidence , 0, 100 ) → mapped to 0..100
ShortScore = clamp( Σ wᵢ · signalᵢ.short · signalᵢ.confidence , 0, 100 )
direction  = LongScore ≥ ShortScore ? LONG : SHORT
agreement  = fraction of weighted signals pointing the chosen direction
confidence = (Σ wᵢ·confidenceᵢ / Σ wᵢ) · agreementFactor · liquidityFactor
conviction = 0.45·score + 0.25·confidence·100 + 0.20·agreement·100 + 0.10·freshness
```
Per-mode weights `wᵢ` (initial, tunable):

| signal | scalp | day | swing |
|---|---|---|---|
| Volatility window | 0.10 | 0.15 | 0.20 |
| Volume acceleration | 0.30 | 0.20 | 0.15 |
| Trend vs mean-rev | 0.15 | 0.25 | 0.30 |
| Momentum confirm | 0.25 | 0.25 | 0.20 |
| Liquidity/breakout | 0.20 | 0.15 | 0.15 |

### 0.7 Explainability
- Each signal's `why` is stored on the opportunity payload.
- Dashboard "Why now?" = top 3 signals by `|contribution|` where
  `contribution = wᵢ · (signalᵢ.long − signalᵢ.short) · confidenceᵢ`.
- A "warming up / N% history" badge shows when tier < T2.
- Nothing is a black box: `detail` holds every raw number behind a score.

---

## 1. Volatility Window

**Input data needed:** synthetic bar close (+ high/low for ATR); price series for
returns; baseline series of the same metric.

**Lookback windows:** ATR 14 bars; realized-vol window 20 bars; Bollinger 20
bars (±2σ); baselines = the metric's own distribution over 24h / 7d / 30d.

**Formula:**
- True Range `TR = max(high−low, |high−prevClose|, |low−prevClose|)`;
  `ATR = SMA₁₄(TR)`; `ATR% = ATR/price`. *(Tier B: real OHLC → exact ATR.)*
- Realized vol `RV = stdev(ln(pₜ/pₜ₋₁)) over 20 bars`, expressed %.
- Bollinger width `BBW = (SMA₂₀ + 2σ − (SMA₂₀ − 2σ)) / SMA₂₀ = 4σ/SMA₂₀`.
- Regime: `volRatio = RV_now / median(RV over baseline)`;
  `bbwPct = percentile rank of BBW_now within baseline` (low pct = squeeze).

**Output score 0–100:** `volatilityScore` = percentile of current RV (0 = dead
calm … 100 = extreme). Also expose `compressionScore = 100 − bbwPct` (100 = max
squeeze).

**Long effect:** Direction-neutral by itself. High compression →
**raises the breakout signal's weight** and adds a small boost to whichever
direction trend/momentum already favor. Mild long if RV is *expanding from a
squeeze with price ticking up*.

**Short effect:** Symmetric — squeeze + price ticking down adds mild short.
Extreme blow-off vol (volatilityScore > 90) adds a small **fade/short** bias
(mean-reversion risk after a spike up).

**Confidence:** scales with bars available vs needed (BBW needs 20, percentiles
need the baseline window). Wide sample gaps → lower confidence.

**Required minimum history:** ATR/RV → 21 bars (T1). BBW percentile vs 7d → T2.
30d regime → T3. Below T1: `status:'insufficient'`, score 50, conf ≤ 0.25.

**Why template:** "Volatility compressed — Bollinger width in the {bbwPct}th
percentile of the last 7d → coiled for a breakout."

---

## 2. Volume Acceleration

**Input data needed:** `volume24h_usd` series (+ optional synthetic per-bar
volume); `price`/`change24h` for direction.

**Lookback windows:** RVOL baseline 7d (T3: 30d); short-term growth deltas over
1h / 4h / 24h; z-score over 7d.

**Formula:**
- `RVOL = volume24h_now / mean(volume24h over baseline)`.
- Growth `gₕ = (vol_now − vol_{now−h}) / vol_{now−h}` for h ∈ {1h,4h,24h}.
  *(Caveat: differencing a rolling-24h series is noisy; treated as a coarse
  rising/falling signal, not exact interval volume. Tier B klines give true
  per-interval volume.)*
- Unusual expansion `z = (vol_now − μ₇d) / σ₇d`; `z>2` = unusual.
- `relVolScore = clamp(50 + 25·log₂(RVOL), 0, 100)` (RVOL 1→50, 2→75, 4→100).

**Output score 0–100:** `relVolScore` (volume strength, direction-agnostic).

**Long effect:** Volume **confirms** direction. `long ∝ (relVolScore−50)/50`
**signed by short-term price direction** (up → long). High RVOL + price up +
`z>2` = strong long confirmation.

**Short effect:** High RVOL + price down = strong short confirmation. Volume
expansion with flat price (churn) → neutral, but **+confidence to breakout**.

**Confidence:** needs a 7d baseline for clean RVOL/z; with only 24h, use 24h
baseline at reduced confidence. Falling volume → lower confirmation confidence.

**Required minimum history:** RVOL-lite (vs 1h mean) at T0/T1; RVOL+z vs 7d at
T2; time-of-day-matched baseline at T3.

**Why template:** "Volume {RVOL}× its 7d average (z={z}) while price moved
{dir} {chg}% → {buyers/sellers} in control."

---

## 3. Trend vs Mean Reversion

**Input data needed:** synthetic bar close series; pivots for structure;
RSI input.

**Lookback windows:** EMA 9 / 21 / 50 bars; swing detection over last ~50 bars;
RSI 14; stretch percentile over 7d/30d.

**Formula:**
- EMA alignment: `bull = EMA9>EMA21>EMA50 and price>EMA9`; `bear` = reversed.
  `alignScore` from how many conditions hold + EMA slopes.
- Structure: detect swing highs/lows (local extrema, k-bar window); count
  HH/HL (up) vs LH/LL (down) over lookback → `structureScore`.
- Stretch: `stretch = (price − EMA21)/EMA21`; `stretchPct` = percentile vs
  baseline. Large +stretch = overextended up (reversion-short risk).
- RSI(14) overextension: >70 overbought, <30 oversold.
- `reversalScore = f(stretchPct extreme, RSI extreme, RSI/price divergence)`
  0–100 (100 = high reversal risk).

**Output score 0–100:** `trendScore` (100 = strong uptrend, 0 = strong
downtrend, 50 = neutral) **and** `reversalScore`.

**Long effect:** `long ∝ (trendScore−50)/50` in a trending regime
(low reversalScore). When `reversalScore` is high in an **up** move, long is
**damped** and confidence reduced (overextended).

**Short effect:** `short ∝ (50−trendScore)/50`. High `reversalScore` in an up
move **adds short pressure** (fade); in a down move it adds long (oversold
bounce). This is the explicit trend-vs-reversion switch.

**Confidence:** EMA50 needs 50 bars; structure needs ≥ ~3 pivots; divergence
needs a clean swing pair. Degrade if missing.

**Required minimum history:** EMA9/21 + RSI at T1; EMA50 + structure at T2;
stretch percentiles at T2/T3.

**Why template:** "Bullish EMA alignment with higher highs, but price {stretch}%
above EMA21 and RSI {rsi} → uptrend intact yet overextended; long with caution."

---

## 4. Momentum Confirmation

**Input data needed:** close series (RSI, MACD); synthetic high/low (ADX);
multi-window returns.

**Lookback windows:** RSI 14; MACD(12,26,9); ADX 14; returns over
15m/1h/4h/24h (mode-scaled).

**Formula:**
- RSI(14) (Wilder smoothing) on synthetic closes.
- MACD `= EMA12 − EMA26`; `signal = EMA9(MACD)`; `hist = MACD − signal`.
  Bullish if `hist>0` and rising; cross = trigger.
- ADX(14) from +DI/−DI on synthetic high/low; `ADX>25` = trending; direction by
  +DI vs −DI. *(Tier B OHLC → reliable ADX; Tier A is approximate, flagged.)*
- Multi-window agreement: sign of return over each window; `agree` = share
  pointing the same way.
- `momentumScore` 0–100 = blend(RSI centered, MACD hist sign/slope, ADX
  strength, window agreement), directional.

**Output score 0–100:** `momentumScore` (100 = strong up-momentum, 0 = strong
down).

**Long effect:** `long ∝ (momentumScore−50)/50`; **ADX scales magnitude**
(strong trend → bigger push). MACD bullish cross = extra long trigger.

**Short effect:** `short ∝ (50−momentumScore)/50`; MACD bearish cross +
ADX-confirmed downtrend = strong short.

**Confidence:** MACD needs ≥ 35 bars, ADX ≥ 28; window agreement raises
confidence, disagreement lowers it.

**Required minimum history:** RSI at T1; MACD + ADX at T2.

**Why template:** "RSI {rsi} rising, MACD histogram positive & expanding, ADX
{adx} (+DI>−DI), gains across 1h/4h/24h → momentum confirms long."

---

## 5. Liquidity / Breakout Context

**Input data needed:** close/high/low series; `liquidity_usd`; volume (for
breakout confirmation).

**Lookback windows:** range over 24h and 7d; pivots over last ~30–50 bars for
S/R and sweep/reclaim.

**Formula:**
- Range `H = max(high)`, `L = min(low)` over lookback; `posInRange =
  (price−L)/(H−L)` (0..1).
- Breakout: `close > H_prior` (up) / `close < L_prior` (down). **Confirmed** if
  accompanied by `relVolScore > 65`. Retest = price returns within ε of the
  broken level and holds (close back on breakout side within k bars).
- S/R proximity: distance to nearest pivot cluster; near resistance caps longs,
  near support bids.
- Sweep/reclaim: bar low < prior swing low (liquidity sweep) then close back
  **above** it within k bars → bullish reclaim (mirror for bearish).
- `liquidityFactor = clamp(log scale of liquidity_usd)`; low liquidity → caps
  conviction and raises `rugRisk` (already computed for emerging).

**Output score 0–100:** `breakoutScore` (100 = confirmed up-breakout/reclaim,
0 = confirmed down-breakout, 50 = mid-range).

**Long effect:** Confirmed up-breakout + retest hold → strong long. Bullish
sweep+reclaim → strong long reversal. `posInRange` near 1 without breakout →
capped (resistance).

**Short effect:** Confirmed down-breakout → strong short. Bearish sweep+reclaim
→ short. `posInRange` near 0 without breakdown → bounce risk (caps short).

**Confidence:** needs enough history for a meaningful range (≥24h) and pivots
for sweep (≥2–3d). **`liquidityFactor` multiplies overall confidence** — thin
books are untrustworthy.

**Required minimum history:** range/breakout at T1; retest + sweep/reclaim at
T2.

**Why template:** "Broke the 7d range high {H} on {RVOL}× volume and retested it
as support → breakout long. Liquidity {liq} ({health})."

---

## 6. Engine I/O & explainability summary

Per coin per mode the engine returns:
```js
{
  symbol, mode, direction, longScore, shortScore, score,
  conviction, confidence, agreement, historyTier, warming: bool,
  signals: { volatility:{...}, volume:{...}, trend:{...}, momentum:{...}, breakout:{...} },
  why: [ top3 contribution sentences ],
  detail: { ...all raw numbers... }
}
```
This object is stored in `opportunities.payload` (already jsonb), so the
dashboard renders scores **and** the "why" with zero extra queries.

## 7. Proposed implementation plan (after approval)
1. `engines/history.js` — load series from `snapshot_coins`, build synthetic bars, warmup-tier detection.
2. `engines/indicators.js` — pure functions: EMA, RSI, MACD, ATR, stdev/RV, BBW, ADX, percentile, swing pivots. Unit-tested with known fixtures.
3. `engines/signals.js` — the 5 signals, each returning the §0.4 contract + `why`.
4. `engines/scoringV2.js` — aggregation (§0.6), confidence, conviction, top-3 why.
5. Wire into `scanner.js` (replaces `scoreCoin`), keeping the old engine as a `historyTier < T1` fallback. Store `payload`/`why`.
6. Backfill-friendly: works on whatever history exists; improves as the DB grows.
7. Tests: indicator fixtures + a synthetic 30d snapshot series asserting expected scores/whys.

## 8. Open decisions for you
1. **Tier A now, Tier B (exchange klines) later?** (recommended)
2. **Bar intervals & trend windows** per mode in §0.3 — good, or adjust?
3. **Initial weights** in §0.6 — good starting point, or reweight?
4. **Warmup behavior** — fall back to the old heuristic below T1 (recommended), or show "warming up" and withhold rankings?
