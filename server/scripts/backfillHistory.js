// One-shot deep-history backfill. Usage:
//   DATABASE_URL=... npm run backfill:history -- BTC ETH SOL
//   DATABASE_URL=... npm run backfill:history            (uses latest universe)
import { initStore, activeDriver, getUniverse } from '../src/db/store.js';
import { runBackfill } from '../src/services/historyBackfill.js';

await initStore();
if (activeDriver() !== 'postgres') { console.error('Deep history requires DATABASE_URL (Postgres).'); process.exit(1); }
let symbols = process.argv.slice(2);
if (!symbols.length) { const uni = await getUniverse(); symbols = (uni?.coins || []).map((c) => c.symbol); }
console.log('backfilling history for:', symbols.join(', ') || '(none)');
const r = await runBackfill({ symbols });
for (const x of r.results || []) console.log(' ', x.asset, '→', x.history_class || x.error || 'n/a', x.depth_score != null ? `(depth ${x.depth_score}, ${x.coverage_days}d)` : '');
process.exit(0);
