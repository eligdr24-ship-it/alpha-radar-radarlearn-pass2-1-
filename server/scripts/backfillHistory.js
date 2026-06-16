// One-shot deep-history backfill. Usage:
//   DATABASE_URL=... npm run backfill:history -- BTC ETH SOL
//   DATABASE_URL=... npm run backfill:history            (uses latest universe)
import { initStore, activeDriver, getUniverse } from '../src/db/store.js';
import { runBackfill } from '../src/services/historyBackfill.js';

await initStore();
if (activeDriver() !== 'postgres') { console.error('Deep history requires DATABASE_URL (Postgres).'); process.exit(1); }

let symbols = process.argv.slice(2);
if (!symbols.length) { const uni = await getUniverse(); symbols = (uni?.coins || []).map((c) => c.symbol); }
console.log('Backfilling deep history for:', symbols.join(', ') || '(none)');
console.log('Binance base:', process.env.BINANCE_BASE_URL || 'https://data-api.binance.vision (default)');
console.log('CoinGecko key:', process.env.COINGECKO_API_KEY ? 'set' : 'NOT set (history fallback may 429/403)');
console.log('');

const r = await runBackfill({ symbols });

console.log('=== Backfill summary ===');
let ok = 0, failed = 0;
for (const x of r.results || []) {
  const cand = x.candles ?? 0;
  const prof = x.best_source ? `best=${x.best_source} ${x.history_class} ${x.coverage_days}d depth=${x.depth_score}` : 'no-profile';
  const errs = x.errors && x.errors.length ? `  errors: ${x.errors.join(' | ')}` : '';
  console.log(`  ${String(x.asset).padEnd(12)} candles=${String(cand).padEnd(6)} ${prof}${errs}`);
  if (cand > 0) ok++; else failed++;
}
console.log('');
console.log(`Assets with data: ${ok} | empty: ${failed} | total candles stored: ${r.totalCandles}`);

if (!r.totalCandles) {
  console.error('\n❌ BACKFILL FAILED: 0 candles stored.');
  console.error('   Likely causes (see per-asset errors above):');
  console.error('   • Binance 451 → set env BINANCE_BASE_URL=https://data-api.binance.vision (default already applied; confirm it is not overridden to api.binance.com).');
  console.error('   • CoinGecko 403/429 → set env COINGECKO_API_KEY (demo key) for the history fallback.');
  console.error('   • Macro/Stooq blocked → non-fatal; crypto candles should still store.');
  process.exit(1);
}
console.log(`\n✅ Backfill complete: ${r.totalCandles} candles across ${ok} asset(s). Run /status to see Historical Candles.`);
process.exit(0);
