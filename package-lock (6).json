-- Radar Learn — clean, event-driven setup/outcome learning layer (Pass 1)

CREATE TABLE IF NOT EXISTS setups (
  setup_id          TEXT PRIMARY KEY,
  setup_key         TEXT,                -- symbol|mode (one active per key, enforced in app)
  symbol            TEXT,
  mode              TEXT,
  direction         TEXT,
  setup_type        TEXT,
  entry_price       DOUBLE PRECISION,
  buy_zone_low      DOUBLE PRECISION,
  buy_zone_high     DOUBLE PRECISION,
  target1           DOUBLE PRECISION,
  target2           DOUBLE PRECISION,
  stretch_target    DOUBLE PRECISION,
  invalidation      DOUBLE PRECISION,
  opportunity_score INTEGER,
  confidence_score  INTEGER,
  risk_score        INTEGER,
  risk_label        TEXT,
  conviction_score  INTEGER,
  status            TEXT DEFAULT 'active',          -- active/resolved/expired/superseded
  promotion_reason  TEXT,
  resolution_reason TEXT,
  final_label       TEXT,                            -- best outcome level reached
  entry_filled      BOOLEAN DEFAULT false,
  entry_filled_at   TIMESTAMPTZ,
  -- decision-time context (your required fields)
  market_regime     TEXT,
  narrative         TEXT,
  macro_state       JSONB,
  asset_class       TEXT,
  exchange_source   TEXT,
  history_class     TEXT DEFAULT 'unknown',          -- filled by Pass 2
  depth_score       INTEGER,                         -- filled by Pass 2
  history_tier      TEXT,
  engine            TEXT,
  run_id            TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_setups_key_status ON setups (setup_key, status);
CREATE INDEX IF NOT EXISTS idx_setups_status_expires ON setups (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_setups_symbol_mode ON setups (symbol, mode);
CREATE INDEX IF NOT EXISTS idx_setups_type ON setups (setup_type);
CREATE INDEX IF NOT EXISTS idx_setups_created ON setups (created_at);

CREATE TABLE IF NOT EXISTS signal_values (
  id                      BIGSERIAL PRIMARY KEY,
  setup_id                TEXT,
  signal_name             TEXT,
  numeric_value           DOUBLE PRECISION,
  normalized_score        INTEGER,
  timeframe               TEXT,
  direction_contribution  DOUBLE PRECISION,
  confidence_contribution DOUBLE PRECISION,
  detail                  JSONB,
  created_at              TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signal_values_setup ON signal_values (setup_id);
CREATE INDEX IF NOT EXISTS idx_signal_values_name_score ON signal_values (signal_name, normalized_score);

CREATE TABLE IF NOT EXISTS setup_vectors (
  setup_id      TEXT PRIMARY KEY,
  vector        DOUBLE PRECISION[],
  feature_names TEXT[],
  dims          INTEGER,
  l2norm        DOUBLE PRECISION,
  history_class TEXT,
  mode          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_setup_vectors_class_mode ON setup_vectors (history_class, mode);

CREATE TABLE IF NOT EXISTS outcomes (
  id                       BIGSERIAL PRIMARY KEY,
  setup_id                 TEXT,
  horizon                  TEXT,                 -- 1h/4h/24h/7d/30d
  hit_target1              BOOLEAN DEFAULT false,
  hit_target2              BOOLEAN DEFAULT false,
  hit_stretch              BOOLEAN DEFAULT false,
  hit_invalidation         BOOLEAN DEFAULT false,
  success_label            TEXT,                 -- fail/target1/target2/stretch/invalidated
  max_favorable_excursion  DOUBLE PRECISION,
  max_adverse_excursion    DOUBLE PRECISION,
  final_return             DOUBLE PRECISION,
  price_at_horizon         DOUBLE PRECISION,
  samples                  INTEGER,
  data_complete            BOOLEAN DEFAULT true,
  resolved_at              TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outcomes_setup_horizon ON outcomes (setup_id, horizon);
CREATE INDEX IF NOT EXISTS idx_outcomes_horizon ON outcomes (horizon);
