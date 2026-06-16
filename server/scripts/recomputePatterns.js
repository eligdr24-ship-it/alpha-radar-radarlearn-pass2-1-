// Full Pattern Library recompute. Usage: DATABASE_URL=... npm run recompute:patterns
import { initStore, activeDriver, recomputePatterns } from '../src/db/store.js';
await initStore();
if (activeDriver() !== 'postgres') { console.error('Pattern Library requires DATABASE_URL (Postgres).'); process.exit(1); }
const r = await recomputePatterns();
console.log(`✅ recomputed ${r.patterns || 0} patterns (all_time + rolling_90d).`);
process.exit(0);
