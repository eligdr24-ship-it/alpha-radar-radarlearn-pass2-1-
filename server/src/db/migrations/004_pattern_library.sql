-- Pattern Library (v5.1) — additive. Postgres only.

CREATE TABLE IF NOT EXISTS patterns (
  pattern_id        BIGSERIAL PRIMARY KEY,
  pattern_key       TEXT UNIQUE NOT NULL,
  pattern_name      TEXT NOT NULL,
  level             SMALLINT NOT NULL,            -- 0..4
  parent_pattern_id BIGINT NULL REFERENCES patterns(pattern_id),
  mode TEXT, direction TEXT, history_class TEXT, setup_type TEXT, market_regime TEXT, narrative TEXT,
  conditions        JSONB NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patterns_level ON patterns(level);
CREATE INDEX IF NOT EXISTS idx_patterns_mode_dir ON patterns(mode, direction);

CREATE TABLE IF NOT EXISTS pattern_members (
  pattern_id BIGINT NOT NULL REFERENCES patterns(pattern_id),
  setup_id   TEXT NOT NULL,
  level      SMALLINT NOT NULL,
  added_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (pattern_id, setup_id)
);
CREATE INDEX IF NOT EXISTS idx_pattern_members_setup ON pattern_members(setup_id);

CREATE TABLE IF NOT EXISTS pattern_performance (
  pattern_id        BIGINT NOT NULL REFERENCES patterns(pattern_id),
  time_window       TEXT NOT NULL,                -- 'all_time' | 'rolling_90d'
  sample_size       INT DEFAULT 0,
  wins              INT DEFAULT 0,
  losses            INT DEFAULT 0,
  open              INT DEFAULT 0,
  win_rate          NUMERIC,
  win_rate_lb       NUMERIC,                      -- Wilson 95% lower bound (used for ranking)
  shrunk_win_rate   NUMERIC,                      -- shrunk toward parent pattern
  avg_return        NUMERIC,
  avg_rr            NUMERIC,
  avg_drawdown      NUMERIC,                      -- mean max-adverse-excursion
  target1_rate      NUMERIC,
  target2_rate      NUMERIC,
  stretch_rate      NUMERIC,
  invalidation_rate NUMERIC,
  failure_rate      NUMERIC,
  trend             TEXT,                         -- improving | stable | declining
  strength          NUMERIC,                      -- 0..100 composite
  regime_breakdown  JSONB,                        -- {regime: {n, wins, win_rate, win_rate_lb}}
  best_regime       TEXT,
  best_regime_win_rate NUMERIC,
  worst_regime      TEXT,
  worst_regime_win_rate NUMERIC,
  recommended_conf_adj NUMERIC,                   -- display-only suggestion (not applied in v5.1)
  activated         BOOLEAN DEFAULT false,        -- sample_size >= min
  first_seen        TIMESTAMPTZ,
  last_seen         TIMESTAMPTZ,
  computed_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (pattern_id, time_window)
);
CREATE INDEX IF NOT EXISTS idx_pattern_perf_window ON pattern_performance(time_window);
