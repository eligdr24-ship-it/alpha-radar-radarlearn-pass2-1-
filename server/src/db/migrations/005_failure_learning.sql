-- Failure Learning (v5.2) — additive. Postgres only.

CREATE TABLE IF NOT EXISTS failure_reasons (
  setup_id           TEXT PRIMARY KEY,
  primary_reason     TEXT NOT NULL,
  secondary_reasons  JSONB,
  evidence           JSONB,
  confidence         NUMERIC,
  classifier_version TEXT,
  classified_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_failure_reasons_primary ON failure_reasons(primary_reason);

-- Per-pattern rollup of member-setup failure reasons (display-only).
ALTER TABLE pattern_performance ADD COLUMN IF NOT EXISTS top_failure_reasons JSONB;
