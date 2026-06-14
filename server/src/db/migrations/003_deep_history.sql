-- Deep historical backfill layer (Pass 2)

-- Real OHLCV candles (distinct from the 2-min snapshot_coins sampling)
CREATE TABLE IF NOT EXISTS asset_history (
  id         BIGSERIAL PRIMARY KEY,
  asset      TEXT,                 -- symbol, or MACRO:GOLD / MACRO:VIX / ...
  source     TEXT,                 -- binance / coingecko / geckoterminal / stooq / fred
  timeframe  TEXT,                 -- 1d / 4h / 1h
  ts         TIMESTAMPTZ,          -- candle open time
  open       DOUBLE PRECISION,
  high       DOUBLE PRECISION,
  low        DOUBLE PRECISION,
  close      DOUBLE PRECISION,
  volume     DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_history ON asset_history (asset, source, timeframe, ts);
CREATE INDEX IF NOT EXISTS idx_asset_history_asset_tf_ts ON asset_history (asset, timeframe, ts);

-- Provenance per (asset, source, timeframe)
CREATE TABLE IF NOT EXISTS asset_sources (
  id                   BIGSERIAL PRIMARY KEY,
  asset                TEXT,
  source               TEXT,
  timeframe            TEXT,
  first_available_date TIMESTAMPTZ,
  last_available_date  TIMESTAMPTZ,
  data_coverage_days   INTEGER,
  expected_points      INTEGER,
  actual_points        INTEGER,
  missing_pct          DOUBLE PRECISION,
  gap_count            INTEGER,
  has_gaps             BOOLEAN,
  source_quality       INTEGER,
  status               TEXT,
  last_backfilled_at   TIMESTAMPTZ,
  notes                TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_sources ON asset_sources (asset, source, timeframe);

-- One profile row per asset: depth + model class
CREATE TABLE IF NOT EXISTS asset_profile (
  asset                TEXT PRIMARY KEY,
  best_source          TEXT,
  best_timeframe       TEXT,
  first_available_date TIMESTAMPTZ,
  coverage_days        INTEGER,
  source_quality       INTEGER,
  depth_score          INTEGER,
  history_class        TEXT,         -- long / medium / new
  min_sample_met       BOOLEAN,
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_profile_class ON asset_profile (history_class);
CREATE INDEX IF NOT EXISTS idx_asset_profile_depth ON asset_profile (depth_score);
