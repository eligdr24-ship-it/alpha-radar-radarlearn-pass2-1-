import { initStore, activeDriver } from '../src/db/store.js';
import { recomputeFinalLabels } from '../src/services/outcomeResolver.js';
await initStore();
console.log('[recomputeLabels] driver:', activeDriver());
const r = await recomputeFinalLabels();
console.log('[recomputeLabels]', JSON.stringify(r));
process.exit(0);
