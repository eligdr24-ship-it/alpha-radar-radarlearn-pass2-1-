// Pure provenance, depth-score and history-class computation. No I/O.
const DAY = 86400e3;
export const TF_MS = { '1d': DAY, '4h': 4 * 3600e3, '1h': 3600e3 };
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const cfgNum = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
export const MIN_LONG_CANDLES = () => cfgNum('MIN_LONG_CANDLES', 365);

// candles: [{ ts, ... }] (any order). Returns provenance for one (asset,source,tf).
export function computeProvenance(candles, timeframe) {
  if (!candles.length) {
    return { first_available_date: null, last_available_date: null, data_coverage_days: 0,
      expected_points: 0, actual_points: 0, missing_pct: 1, gap_count: 0, has_gaps: false,
      source_quality: 0, status: 'failed' };
  }
  const interval = TF_MS[timeframe] || DAY;
  const ts = candles.map((c) => +new Date(c.ts)).sort((a, b) => a - b);
  const first = ts[0], last = ts[ts.length - 1];
  const coverage_days = Math.max(0, Math.round((last - first) / DAY));
  const expected_points = Math.max(1, Math.floor((last - first) / interval) + 1);
  const actual_points = candles.length;
  const missing_pct = clamp(1 - actual_points / expected_points, 0, 1);
  let gap_count = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 1.5 * interval) gap_count++;
  const has_gaps = gap_count > 0;
  const source_quality = Math.round(clamp(100 - missing_pct * 100 - Math.min(gap_count * 2, 30)));
  const status = source_quality >= 60 ? 'ok' : source_quality > 0 ? 'partial' : 'failed';
  return {
    first_available_date: new Date(first).toISOString(), last_available_date: new Date(last).toISOString(),
    data_coverage_days: coverage_days, expected_points, actual_points,
    missing_pct: Math.round(missing_pct * 1e4) / 1e4, gap_count, has_gaps, source_quality, status,
  };
}

export function depthScore(coverage_days, source_quality) {
  const coverageScore = clamp(100 * Math.log(coverage_days + 1) / Math.log(2001));
  return Math.round(0.6 * coverageScore + 0.4 * source_quality);
}

export function minSampleMet(coverage_days, source_quality) {
  return coverage_days >= MIN_LONG_CANDLES() && source_quality >= 60;
}

// long ≥365d & depth≥60 & min-sample; medium ≥90d; else new. DEX-only caps at new.
export function classifyHistory({ coverage_days, depth_score, min_sample_met, isDexOnly = false }) {
  if (isDexOnly) return 'new';
  if (coverage_days >= 365 && depth_score >= 60 && min_sample_met) return 'long';
  if (coverage_days >= 90) return 'medium';
  return 'new';
}

// Pick the best (asset_sources) provenance row as primary: deepest clean source.
export function pickBestSource(provenances) {
  const ok = provenances.filter((p) => p.source_quality > 0);
  if (!ok.length) return null;
  return ok.slice().sort((a, b) =>
    (b.data_coverage_days - a.data_coverage_days) || (b.source_quality - a.source_quality))[0];
}

export const CONFIDENCE_CEILING = { long: 1.0, medium: 0.80, new: 0.60 };
