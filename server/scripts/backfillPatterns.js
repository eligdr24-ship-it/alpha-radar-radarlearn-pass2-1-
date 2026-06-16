// Assign patterns for setups created before the Pattern Library existed, then recompute.
// Idempotent. Usage: DATABASE_URL=... npm run backfill:patterns
import { initStore, activeDriver, backfillPatterns, recomputePatterns } from '../src/db/store.js';
await initStore();
if (activeDriver() !== 'postgres') { console.error('Pattern Library requires DATABASE_URL (Postgres).'); process.exit(1); }
const r = await backfillPatterns();
console.log(`Assigned patterns for ${r.assigned}/${r.setups} setups.`);
const rc = await recomputePatterns();
console.log(`✅ Recomputed ${rc.patterns || 0} patterns (all_time + rolling_90d).`);
process.exit(0);
