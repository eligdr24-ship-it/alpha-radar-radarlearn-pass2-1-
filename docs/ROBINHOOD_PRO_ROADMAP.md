# Alpha Radar Pro — Robinhood Edition: layered roadmap

Principle (yours): don't rebuild; upgrade in layers; preserve the existing architecture, UI, backend, DB, scoring engine, and deploy setup. This document maps your 13 requested items to what **already exists** vs. what's **new**, and proposes a build order. **Layer 1 (Robinhood universe) is implemented in this build.**

## Status of each requested item

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Robinhood-only scanner + categories + label | **DONE (this build)** | Single config file `config/robinhoodUniverse.js`; filter + category tag + dashboard label/filter. |
| 6 | Performance Lab (signal tracking) | **Mostly exists** | System Performance + Trade Replay already track coin, signal time, type, entry, stop, targets, status, P&L%, RR, reason, market conditions. Gap: a dedicated "Performance Lab" page name + notes field + Buy/Sell/Hold/Avoid/Accumulate signal taxonomy. |
| 7 | Win/Loss analytics | **Partly exists** | `/performance` has win rate, avg win/loss, by-coin, by-horizon, recent wins/losses, loss reasons. Gap: profit factor, equity curve, drawdown chart, monthly perf, best/worst strategy. |
| 8 | Learning Engine ("what happened") | **Exists as v5.2 Failure Learning** | entry-too-early→`signal_too_early`, stop-too-tight→`liquidity_trap`/`signal_too_early`, BTC conflict→`btc_reversed`, macro→`macro_risk_off`, weak volume→`volume_faded`, false breakout→`failed_to_reach_target`. Learning notes ≈ `failure_reasons`. Disclaimer copy to add. |
| 9 | Scoring calibration (adjustment layer) | **Designed, deferred** | This is exactly the v5.3 **Confidence Engine** from the v5 spec — a post-scoring, versioned, display-first calibration layer that does NOT touch the core engine. You previously asked to defer it; it's the natural next layer. |
| 2 | Pro dashboard (heatmap, BTC dominance, F&G, VIX, ETF/stablecoin flows, altseason, macro) | **Partly exists** | Macro temp, regime, narratives, RR analytics exist. New: heatmap, BTC dominance, Fear & Greed, VIX card, ETF/stablecoin flows, altseason probability, prob-of-outperforming-BTC, Buy/Hold/Avoid rating. Several need new data sources/keys. |
| 3 | Coin analysis page (fundamentals, tokenomics, bull/base/bear, catalysts, TA, rating) | **New** | Mostly static research content + existing technicals/targets. Needs a content model; non-trivial. |
| 4 | AI research assistant | **New** | Requires an LLM API key (cost). Must be constrained to the Robinhood universe + system data. |
| 5 | Portfolio builder (Conservative/Balanced/Aggressive) | **New** | Allocation %, risk, expected return, max drawdown, rebalancing rules, per-coin rationale — built from existing scores + categories. |
| 10 | Admin/settings page | **New** | Edit coin list / toggle coins / view sources / clear test signals / export trade history + analytics CSV / reset learning notes. Coin list edit can write to the config or a DB override. |
| 11 | Data persistence | **Exists** | Postgres (Radar Learn, patterns, failures) + memory fallback already persist across restarts. |
| 12 | GitHub + Render ready | **Exists, extend** | README, render.yaml, .env.example present; CHANGELOG added; `ROBINHOOD_ONLY` documented. SETUP.md to add. |
| 13 | Safety/reliability (errors, loading/empty states, mobile, disclaimers, demo labels) | **Mostly exists** | Demo-mode labeling, data-source transparency, mobile/overflow hardening already in. Add explicit "not financial advice / no guaranteed profits" disclaimers on Pro surfaces. |

## Proposed build order (small, testable layers)

1. **Robinhood universe** — DONE.
2. **Performance Lab + Win/Loss analytics polish** — rename/extend the existing Performance page: add profit factor, equity curve, drawdown, monthly, best/worst strategy, notes, and the Buy/Sell/Hold/Avoid/Accumulate signal taxonomy. (Reuses existing data; low risk.)
3. **Portfolio builder** — Conservative/Balanced/Aggressive from existing scores + categories (display-only). Low risk, high value.
4. **Pro dashboard widgets** — BTC dominance, Fear & Greed, VIX, altseason, heatmap (each gated on a data source; show "demo" when no key). Medium.
5. **Confidence Engine (item 9 scoring calibration)** — the deferred v5.3 layer, display-first then optionally flagged into ranking. Highest care; versioned + reversible.
6. **Coin analysis page (item 3)** + **Admin/settings (item 10)**.
7. **AI assistant (item 4)** — last; needs an LLM key + guardrails to stay within the Robinhood universe.

Each layer ships additively with tests, memory-store no-ops, no edits to `scoring.js` / `scoringV2.js`, and a clear "not financial advice / no guaranteed results" disclaimer where relevant.
