// Step 2: Filter the raw universe down to scannable, trustworthy coins.
// All thresholds are env-configurable so you can tune without code changes.
const NUM = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function getFilterConfig() {
  return {
    minVolumeUsd: NUM(process.env.FILTER_MIN_VOLUME_USD, 1_000_000),
    minMarketCapUsd: NUM(process.env.FILTER_MIN_MARKETCAP_USD, 5_000_000),
    minLiquidityUsd: NUM(process.env.FILTER_MIN_LIQUIDITY_USD, 250_000),
    maxAgeMs: NUM(process.env.FILTER_MAX_AGE_MS, 10 * 60 * 1000), // staleness guard
    maxAbsChange: NUM(process.env.FILTER_MAX_ABS_CHANGE, 95), // reject likely-bad ticks
  };
}

// Data-quality gate: a coin must be well-formed and fresh to be scored.
function qualityReason(c, cfg, now) {
  if (!c.symbol) return 'no-symbol';
  if (!Number.isFinite(c.price) || c.price <= 0) return 'bad-price';
  if (!Number.isFinite(c.volume24hUsd)) return 'bad-volume';
  if (!Number.isFinite(c.change24h)) return 'bad-change';
  if (Math.abs(c.change24h) > cfg.maxAbsChange) return 'change-outlier';
  if (c.updatedAt && now - c.updatedAt > cfg.maxAgeMs) return 'stale';
  return null;
}

// Threshold gate. Market cap is skipped for sources that don't provide it
// (e.g. Binance tickers have no cap) so we don't wrongly drop everything.
function thresholdReason(c, cfg) {
  if (c.volume24hUsd < cfg.minVolumeUsd) return 'low-volume';
  if (c.liquidityUsd < cfg.minLiquidityUsd) return 'low-liquidity';
  if (c.marketCapUsd > 0 && c.marketCapUsd < cfg.minMarketCapUsd) return 'low-marketcap';
  return null;
}

export function applyFilters(coins, cfg = getFilterConfig()) {
  const now = Date.now();
  const kept = [];
  const rejected = [];
  const reasonCounts = {};
  for (const c of coins) {
    const reason = qualityReason(c, cfg, now) || thresholdReason(c, cfg);
    if (reason) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      rejected.push({ symbol: c.symbol, reason });
    } else {
      kept.push(c);
    }
  }
  return { kept, rejected, reasonCounts, cfg };
}
