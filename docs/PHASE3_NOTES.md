# Phase 3 — Persistent History (Postgres)

Adds a Postgres-backed store for full scan history, with a zero-config
in-memory fallback. The storage interface is identical for both drivers, so
`scanner.js` and the routes are driver-agnostic.

## Driver selection
```
DATABASE_URL set & reachable   -> Postgres driver  (persistent history)
DATABASE_URL set & unreachable -> warn + fall back to memory (never crashes)
DATABASE_URL absent            -> in-memory/JSON store (default, offline-ok)
```
Check which is active: `GET /api/health` → `storeDriver`.

## What gets persisted (your priority order)
1. **Scan universe** — `scan_universe` (one row per scan: source, filter, counts, coins)
2. **Market snapshots** — `market_snapshots` (header) + `snapshot_coins`
   (per-coin rows, indexed by `(symbol, at)` — the time series the scoring
   rework will consume)
3. **Opportunity scores** — `opportunities` (per mode, per coin, per scan;
   normalized score columns + full `payload` jsonb for the dashboard)
4. **Source status / errors** — `source_status` (per source, per scan)
5. **Alert events** — `alert_events` (top setups, telegram tests, …)
6. **Migrations/schema** — `server/src/db/migrations/*.sql`, applied on boot by
   a tracked runner (`schema_migrations` table). Idempotent.
7. **Safe fallback** — see driver selection above.
8. **Local/mock mode** — the in-memory driver is the default; the dashboard runs
   fully offline with mock data, exactly as in Phase 2.

## Files
- `server/src/db/store.js` — facade / driver selector
- `server/src/db/memoryStore.js` — in-memory + JSON flush driver
- `server/src/db/pgStore.js` — Postgres driver (uses `pg`)
- `server/src/db/migrate.js` — migration runner
- `server/src/db/migrations/001_init.sql` — schema
- `server/scripts/migrate.js` — manual migrate CLI

## New endpoints
- `GET /api/health` → now includes `storeDriver`
- `GET /api/source-status?limit=` — per-source status history
- `GET /api/alerts/events?limit=` — alert event history

## Run locally
```bash
# Default (no DB): in-memory, works offline
npm run dev

# With Postgres:
export DATABASE_URL=postgres://user:pass@host:5432/alpha
npm run db:migrate      # optional; boot also auto-migrates
npm run dev
curl localhost:10000/api/health        # storeDriver: postgres
curl localhost:10000/api/scan/runs
```

## Deploy (Render)
`render.yaml` now provisions a free Postgres (`alpha-radar-db`) and injects
`DATABASE_URL` automatically, with `PGSSL=true`. Migrations run on first boot.
Caveats: Render's free Postgres instances expire after ~30 days and the free
web tier sleeps on inactivity — fine for testing; upgrade for real persistence.

## Testing notes
The Postgres driver and migrations were validated against a real Postgres
engine via `pg-mem` (a pure-JS Postgres) — see how rows accumulate across scans
(e.g. each coin gains one `snapshot_coins` point per scan). `pg-mem` is a
dev-only dependency; production uses the real `pg` Pool.

## Next: scoring rework
The `snapshot_coins` table is the foundation — it stores price/volume/liquidity
per symbol over time. The scoring engine can now compute real momentum,
volatility, and volume-acceleration from history instead of single-tick
heuristics (and retire the hardcoded rules like the PEPE short-pin).
Suggested first queries:
- recent N snapshots per symbol → realized volatility & trend
- volume_24h delta across snapshots → volume acceleration
- compare current vs rolling average → mean-reversion / breakout signals
