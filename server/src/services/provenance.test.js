import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProvenance, depthScore, classifyHistory, minSampleMet, pickBestSource } from './provenance.js';

const DAY = 86400e3;
const dailyCandles = (n, gapAt = -1) => {
  const out = []; let t = Date.now() - n * DAY;
  for (let i = 0; i < n; i++) { if (i === gapAt) t += 5 * DAY; out.push({ ts: new Date(t).toISOString() }); t += DAY; }
  return out;
};

test('computeProvenance: clean daily series → full quality, no gaps', () => {
  const p = computeProvenance(dailyCandles(100), '1d');
  assert.ok(p.data_coverage_days >= 98 && p.data_coverage_days <= 100);
  assert.equal(p.gap_count, 0); assert.equal(p.has_gaps, false);
  assert.equal(p.source_quality, 100); assert.equal(p.status, 'ok');
});

test('computeProvenance: a gap is detected and lowers quality', () => {
  const p = computeProvenance(dailyCandles(100, 50), '1d');
  assert.ok(p.gap_count >= 1); assert.equal(p.has_gaps, true);
  assert.ok(p.source_quality < 100);
});

test('computeProvenance: empty → failed', () => {
  const p = computeProvenance([], '1d');
  assert.equal(p.status, 'failed'); assert.equal(p.source_quality, 0); assert.equal(p.missing_pct, 1);
});

test('depthScore rises with coverage', () => {
  assert.ok(depthScore(30, 100) < depthScore(365, 100));
  assert.ok(depthScore(365, 100) < depthScore(2000, 100));
});

test('classifyHistory thresholds', () => {
  assert.equal(classifyHistory({ coverage_days: 800, depth_score: 90, min_sample_met: true }), 'long');
  assert.equal(classifyHistory({ coverage_days: 120, depth_score: 55, min_sample_met: false }), 'medium');
  assert.equal(classifyHistory({ coverage_days: 30, depth_score: 40, min_sample_met: false }), 'new');
  assert.equal(classifyHistory({ coverage_days: 800, depth_score: 90, min_sample_met: true, isDexOnly: true }), 'new');
});

test('minSampleMet needs 365d and quality>=60', () => {
  assert.equal(minSampleMet(400, 70), true);
  assert.equal(minSampleMet(200, 90), false);
  assert.equal(minSampleMet(400, 50), false);
});

test('pickBestSource prefers deepest clean source', () => {
  const best = pickBestSource([
    { source: 'coingecko', data_coverage_days: 1200, source_quality: 80 },
    { source: 'binance', data_coverage_days: 2500, source_quality: 95 },
    { source: 'dead', data_coverage_days: 0, source_quality: 0 },
  ]);
  assert.equal(best.source, 'binance');
});
