# Phase 2 — Dynamic Scan Universe & 24/7 Scanner

Adds an always-on scanning pipeline on top of the v1.2 base. Built in the
requested order; each step is independently testable.

## Pipeline (one scan)
```
buildUniverse()         # Step 1: CoinGecko -> Binance -> mock (rate-limited)
  -> applyFilters()     # Step 2: min volume/liquidity/marketcap + data quality
  -> store.setUniverse  # Step 3: persist active universe
  -> store.addSnapshot  # Step 4: persist market snapshot (coins + macro + emerging)
  -> scoreCoin x3 modes # Step 7: rescore long/short for scalp/day/swing
  -> store.setOpportunities
  -> store.addScanRun    # Step 6: structured run log
```
The dashboard reads the **stored** result (fast, no live call per request).
`node-cron` re-runs the pipeline every `SCAN_INTERVAL_MINUTES` (1-5).

## Files added
- `server/src/lib/limiter.js` — per-provider throttle (min gap + concurrency cap)
- `server/src/lib/http.js` — fetch with timeout + retries + exponential backoff
- `server/src/db/store.js` — persistence (in-memory + atomic JSON flush, ring-buffered)
- `server/src/services/universe.js` — Step 1 dynamic universe + classifier + fallbacks
- `server/src/services/filters.js` — Step 2 quality + threshold gates
- `server/src/services/scanner.js` — Steps 3-7 pipeline + dashboard reader
- `server/scripts/scanOnce.js`, `server/scripts/dbReset.js` — CLI helpers
- Removed: `marketData.js`, `fullMarketData.js` (superseded by the above)

## Not overloading APIs
- CoinGecko: **one** batched `coins/markets` call per scan (≤250 coins),
  throttled to 1.5s gap, 1 concurrent.
- Binance/DEX/Gecko: independent hosts, single calls each, all behind retries.
- The dashboard never calls a live API — it serves the last stored scan.
- Default 2-min interval = ~30 CoinGecko calls/hour, well under free limits.

## Fallbacks & resilience
- `buildUniverse()` never throws: CoinGecko → Binance → mock.
- Emerging/macro failures degrade to empty/fallback, scan still completes.
- A whole-scan error logs an `error` run and **keeps the previous good data**.
- An overlap lock skips a new scan if the prior one is still running.

## New / changed endpoints
- `GET  /api/health` — now includes `scan` meta
- `GET  /api/dashboard?mode=scalp|day|swing` — served from store
- `GET  /api/universe` — current filtered universe + thresholds
- `POST /api/scan/run` — trigger a scan now (testing)
- `GET  /api/scan/status` — store meta + last run
- `GET  /api/scan/runs?limit=20` — recent run logs

## How to test each step
```bash
# Step 1+2 in isolation (one scan, ranked output, no server):
npm run scan:once

# Full server with cron + initial scan:
npm run dev            # then:
curl localhost:10000/api/scan/status
curl -X POST localhost:10000/api/scan/run
curl localhost:10000/api/universe | jq '.counts'
curl "localhost:10000/api/dashboard?mode=swing" | jq '.opportunities[0]'

# Reset local store:
npm run db:reset
```

## Tuning (env)
`SCAN_INTERVAL_MINUTES`, `UNIVERSE_SIZE`, `DISABLE_CRON`, `DATA_DIR`,
`MAX_SNAPSHOTS`, `MAX_SCAN_RUNS`, and all `FILTER_MIN_*` thresholds — see
`.env.example`. Defaults work out of the box.

## Deploy caveat (important)
The store is a local file. Render's **free** tier has an ephemeral disk, so the
file resets on restart/redeploy — fine, since the boot scan repopulates it in
seconds. For durable history, attach a Render Disk and point `DATA_DIR` at it,
or swap the store driver to Postgres later (the interface is isolated for this).
The 24/7 cron requires a long-running process → **Render, not Vercel**.

## Next (Phase 3 candidates)
- Replace hardcoded scoring heuristics (e.g. PEPE short-pin) with real
  derivatives/sentiment signals once those API keys are added.
- Swap the file store for Postgres (`DATABASE_URL`) for multi-instance + history.
- Persist signal outcomes to measure win-rate (the v4 "Radar Learn" goal).
