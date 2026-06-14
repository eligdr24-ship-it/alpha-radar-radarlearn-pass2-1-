-- Alpha Radar persistent history schema (Phase 3)

CREATE TABLE IF NOT EXISTS scan_runs (
  run_id        TEXT PRIMARY KEY,
  trigger       TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,
  source        TEXT,
  universe_raw  INTEGER,
  kept          INTEGER,
  rejected      INTEGER,
  reason_counts JSONB,
  errors        JSONB,
  integrations  JSONB,
  status        TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Priority 1: active scan universe (one row per scan)
CREATE TABLE IF NOT EXISTS scan_universe (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT,
  built_at   TIMESTAMPTZ,
  source     TEXT,
  filter     JSONB,
  counts     JSONB,
  coins      JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Priority 2: market snapshots (header + per-coin rows for historical scoring)
CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id      TEXT,
  at          TIMESTAMPTZ,
  source      TEXT,
  macro       JSONB,
  emerging    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshot_coins (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_id     TEXT,
  at              TIMESTAMPTZ,
  symbol          TEXT,
  name            TEXT,
  price           DOUBLE PRECISION,
  change24h       DOUBLE PRECISION,
  market_cap_usd  DOUBLE PRECISION,
  volume24h_usd   DOUBLE PRECISION,
  liquidity_usd   DOUBLE PRECISION,
  type            TEXT,
  sector          TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_coins_symbol_at ON snapshot_coins (symbol, at);

-- Priority 3: opportunity scores (per mode, per coin, per scan)
CREATE TABLE IF NOT EXISTS opportunities (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT,
  at         TIMESTAMPTZ,
  source     TEXT,
  mode       TEXT,
  rank       INTEGER,
  symbol     TEXT,
  direction  TEXT,
  conviction INTEGER,
  confidence INTEGER,
  consensus  INTEGER,
  freshness  INTEGER,
  risk       TEXT,
  score      INTEGER,
  payload    JSONB
);
CREATE INDEX IF NOT EXISTS idx_opportunities_run_mode ON opportunities (run_id, mode, rank);
CREATE INDEX IF NOT EXISTS idx_opportunities_symbol_at ON opportunities (symbol, at);

-- Priority 4: source status / errors over time
CREATE TABLE IF NOT EXISTS source_status (
  id      BIGSERIAL PRIMARY KEY,
  run_id  TEXT,
  at      TIMESTAMPTZ,
  source  TEXT,
  status  TEXT,
  detail  JSONB
);
CREATE INDEX IF NOT EXISTS idx_source_status_source_at ON source_status (source, at);

-- Priority 5: alert events
CREATE TABLE IF NOT EXISTS alert_events (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ,
  type       TEXT,
  title      TEXT,
  body       TEXT,
  payload    JSONB,
  channel    TEXT,
  delivered  BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_events_at ON alert_events (at);
