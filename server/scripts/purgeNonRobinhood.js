// Remove ALL stored data for coins not on the Robinhood allowlist (keeps MACRO:* macro history).
// Usage: DATABASE_URL=... npm run purge:non-robinhood
import { initStore, activeDriver, purgeNonRobinhood } from '../src/db/store.js';
import { ROBINHOOD_SYMBOLS } from '../src/config/robinhoodUniverse.js';
await initStore();
if (activeDriver() !== 'postgres') { console.error('Purge requires DATABASE_URL (Postgres).'); process.exit(1); }
const r = await purgeNonRobinhood(ROBINHOOD_SYMBOLS);
console.log(`✅ Removed ${r.removedSetups} non-Robinhood setups, ${r.removedSnapshots} snapshot rows, ${r.removedAssets} deep-history assets.`);
console.log('Pattern + failure stats recomputed. Going forward only Robinhood coins are tracked.');
process.exit(0);
