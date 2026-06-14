# Phase 4 — Historical Scoring Engine (implementation)

Implements `docs/SCORING_SPEC.md`. Replaces single-tick heuristics with
explainable signals computed from stored snapshot history. Old engine retained
as the sub-T1 fallback.

## Modules (all pure except the store/scanner glue)
- `engines/indicators.js` — EMA, SMA, RSI, MACD, ATR (Wilder), ADX, Bollinger,
  realized vol, stdev, percentile, swing pivots. **12 unit tests** incl. the
  canonical StockCharts RSI(14) ≈ 70.53 fixture.
- `engines/history.js` — raw points → series → synthetic OHLCV bars per mode;
  warmup-tier detection (T0–T3).
- `engines/signals.js` — the 5 signals (volatility, volume, trend, momentum,
  breakout), each returning the §0.4 contract `{score, long, short, confidence,
  status, why, detail}`.
- `engines/scoringV2.js` — aggregation: long/short scores, agreement,
  confidence, conviction, top-3 `why`. **6 tests** on a synthetic 30-day series.
- `engines/scoring.js` — **unchanged**; used as the sub-T1 fallback.

## Engine selection (in `scanner.js`)
Per coin, per scan:
```
historyTier(series).rank < T1  → legacy scoreCoin()  (engine: 'v1-fallback', warming:true)
otherwise                      → scoreCoinV2()        (engine: 'v2')
```
Both paths emit a 3-item `why`, so the dashboard contract is identical.

History is loaded once per scan via `store.getCoinHistories(symbols, since)`
(batched IN-query on `snapshot_coins`, indexed by `(symbol, at)`).

## Explainability
Every opportunity payload now includes:
- `signals` — `{volatility, volume, trend, momentum, breakout, freshness}` 0-100
  (drives the dashboard breakdown bars)
- `signalDetail` — every raw number behind each signal (audit/tooltip)
- `why` — top-3 contributing reasons, e.g.
  *"Broke 7-day range high $1.72 on 2.5× volume → breakout long"*
- `confidence`, `agreement`, `conviction`, `historyTier`, `warming`

The dashboard Detail panel renders `why` as a list with an engine/tier/
confidence line and a "warming up" badge below T1.

## Important behaviour
- **Memory store → always v1 fallback.** The in-memory driver keeps only the
  last ~20 snapshots (T0), so v2 only fully engages with **Postgres** history.
  This is by design; deep history lives in Postgres.
- v2 confidence scales with the warmup tier — it is only "fully itself" after
  ~7–30 days of accumulated 2-min snapshots. Until then it degrades gracefully
  and the UI shows it's warming up.
- Tier A (synthetic bars from snapshots) is implemented now; Tier B (exchange
  klines for exact ATR/ADX) remains a future option, marked in the spec.

## Test / run
```bash
npm test            # 18 unit + engine tests (node --test, zero deps)
npm run scan:once   # one scan; with Postgres history → v2, else warming v1
```

## Tuning
Weights live in `engines/scoringV2.js` (`WEIGHTS` per mode); bar intervals in
`engines/history.js` (`BAR_MS`); signal thresholds inline in `signals.js`.
All match the approved spec defaults.
