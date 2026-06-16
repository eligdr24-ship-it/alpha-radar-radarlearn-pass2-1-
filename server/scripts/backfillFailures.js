// Classify historical losing/expired setups. Idempotent.
// Usage: DATABASE_URL=... npm run backfill:failures
import { initStore, activeDriver, backfillFailures, recomputePatterns } from '../src/db/store.js';
await initStore();
if (activeDriver() !== 'postgres') { console.error('Failure Learning requires DATABASE_URL (Postgres).'); process.exit(1); }
const r = await backfillFailures();
console.log(`Classified ${r.classified}/${r.scanned} resolved/expired setups.`);
await recomputePatterns();
console.log('✅ Pattern failure rollups refreshed.');
process.exit(0);
