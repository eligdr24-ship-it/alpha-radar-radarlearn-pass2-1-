// Resolve outcomes for all active setups from stored price history.
// Usage: DATABASE_URL=... npm run backfill:outcomes
import { initStore, activeDriver } from '../src/db/store.js';
import { resolveAll } from '../src/services/outcomeResolver.js';

await initStore();
if (activeDriver() !== 'postgres') { console.error('Radar Learn requires DATABASE_URL (Postgres).'); process.exit(1); }
const r = await resolveAll();
console.log('backfill outcomes:', JSON.stringify(r));
process.exit(0);
