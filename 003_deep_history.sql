const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(n)));

function baseSignals(coin) {
  const volatilityBoost = Math.min(Math.abs(coin.change24h) * 4, 28);
  const memeHype = coin.type === 'meme' ? 14 : 0;
  const emergingBoost = coin.type === 'emerging' ? 18 : 0;
  const blueChipStability = coin.type === 'major' ? 12 : 0;
  return {
    technical: clamp(62 + volatilityBoost + (coin.change24h > 0 ? 10 : -8)),
    derivatives: clamp(65 + (coin.symbol === 'PEPE' ? 18 : 0) + (coin.symbol === 'SOL' ? 12 : 0)),
    sentiment: clamp(55 + memeHype + emergingBoost + Math.max(coin.change24h, 0) * 2),
    smartMoney: clamp(60 + blueChipStability + (['SOL','LINK','SUI','SEI'].includes(coin.symbol) ? 22 : 0)),
    macro: clamp(65 + blueChipStability + (coin.type === 'meme' ? -8 : 0)),
    narrative: clamp(55 + memeHype + emergingBoost + (coin.sector.includes('Solana') ? 18 : 0)),
    freshness: clamp(70 + emergingBoost + (coin.symbol === 'SOL' ? 20 : 0) + (coin.symbol === 'PEPE' ? 20 : 0) - (coin.symbol === 'BTC' ? 10 : 0))
  };
}

export function scoreCoin(coin, mode = 'day') {
  const s = baseSignals(coin);
  const longRaw = 0.22*s.technical + 0.14*s.derivatives + 0.14*s.sentiment + 0.16*s.smartMoney + 0.10*s.macro + 0.14*s.narrative + 0.10*s.freshness;
  const shortRaw = coin.symbol === 'PEPE'
    ? 92
    : clamp(100 - longRaw + (coin.change24h < -2 ? 20 : 0) + (coin.type === 'meme' ? 8 : 0));
  const longScore = clamp(longRaw);
  const shortScore = clamp(shortRaw);
  const direction = shortScore > longScore ? 'SHORT' : 'LONG';
  const score = Math.max(longScore, shortScore);
  const confidence = clamp(70 + (score - 75) * 0.7 + (coin.type === 'major' ? 8 : 0));
  const consensus = clamp((s.technical + s.derivatives + s.sentiment + s.smartMoney + s.macro + s.narrative) / 6);
  const risk = coin.type === 'meme' ? 'High' : coin.type === 'major' ? 'Low' : 'Medium';
  const conviction = clamp(score * 0.45 + confidence * 0.25 + consensus * 0.2 + s.freshness * 0.1);
  return { ...coin, signals:s, longScore, shortScore, direction, score, confidence, consensus, risk, conviction };
}

export function makeTargets(scored, mode = 'day') {
  const p = scored.price;
  const isShort = scored.direction === 'SHORT';
  const cl = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const volatility = scored.type === 'meme' ? 0.12 : scored.type === 'emerging' ? 0.10 : scored.type === 'major' ? 0.035 : 0.07;
  const mult = mode === 'scalp' ? 0.35 : mode === 'swing' ? 2.4 : 1;
  const unit = volatility * mult; // ATR-like move unit

  // Setup quality drives asymmetry: strong, clean, coiled setups earn tighter
  // stops and extended targets → higher RR. Weak/choppy setups → ~1R.
  const sd = scored.signalDetail || {};
  const q = cl(((scored.conviction || 0) * 0.5 + (scored.confidence || 0) * 0.3 + (scored.consensus || 0) * 0.2) / 100, 0, 1);
  const adx = sd.momentum?.detail?.adx ?? sd.trend?.detail?.adx ?? 0;
  const trendStrength = cl((adx / 40 + Math.abs(sd.trend?.detail?.emaAlign ?? 0)) / 2, 0, 1);
  const coil = cl((sd.volatility?.detail?.compression ?? 40) / 100, 0, 1);

  const stopFactor = cl(0.95 - 0.40 * q - 0.15 * coil, 0.40, 1.0);        // tighter when strong/coiled
  const rrBias = mode === 'scalp' ? 0.82 : mode === 'swing' ? 1.22 : 1.0;  // swings earn wider targets vs stop
  const targetFactor = cl((0.85 + 1.65 * q + 0.85 * trendStrength) * rrBias, 0.85, 4.2); // farther when strong/trending

  const riskD = unit * stopFactor;
  const t1D = unit * targetFactor;
  const t2D = t1D * 1.75;
  const stretchD = t1D * 2.9;

  const buyLow = isShort ? p * (1 + riskD * 0.25) : p * (1 - riskD * 0.25);
  const buyHigh = isShort ? p * (1 + riskD * 0.75) : p * (1 - riskD * 0.75);
  const target1 = isShort ? p * (1 - t1D) : p * (1 + t1D);
  const target2 = isShort ? p * (1 - t2D) : p * (1 + t2D);
  const stretchTarget = isShort ? p * (1 - stretchD) : p * (1 + stretchD);
  const invalidation = isShort ? p * (1 + riskD) : p * (1 - riskD);
  return { buyZone: [buyLow, buyHigh].sort((a, b) => a - b), target1, target2, stretchTarget, invalidation };
}

export function formatPrice(n) {
  if (n < 0.01) return '$' + n.toFixed(8);
  if (n < 10) return '$' + n.toFixed(3);
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
