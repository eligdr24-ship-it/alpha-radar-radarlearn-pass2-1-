// Storage facade. Selects Postgres when DATABASE_URL is set and reachable,
// otherwise falls back to the in-memory/JSON store. Same async API either way,
// so scanner.js and routes never need to know which driver is active.
import { createMemoryStore } from './memoryStore.js';

let driver = null;

export async function initStore(opts = {}) {
  const url = opts.connectionString || process.env.DATABASE_URL;
  if (url || opts.pool) {
    try {
      const { createPgStore } = await import('./pgStore.js');
      driver = await createPgStore({ connectionString: url, pool: opts.pool });
      await driver.init();
      console.log('[store] driver: postgres');
      return driver;
    } catch (err) {
      // Priority 7: never crash on a bad/missing DB — degrade to memory.
      console.error('[store] Postgres unavailable, falling back to memory:', err.message);
    }
  }
  driver = createMemoryStore();
  await driver.init();
  console.log('[store] driver: in-memory/JSON (no DATABASE_URL)');
  return driver;
}

export function activeDriver() { return driver?.driverName || 'none'; }

// Proxy every method to the active driver.
const proxy = (name) => (...args) => {
  if (!driver) throw new Error('store not initialized — call initStore() first');
  return driver[name](...args);
};
export const setUniverse = proxy('setUniverse');
export const getUniverse = proxy('getUniverse');
export const addSnapshot = proxy('addSnapshot');
export const getLatestSnapshot = proxy('getLatestSnapshot');
export const getSnapshots = proxy('getSnapshots');
export const setOpportunities = proxy('setOpportunities');
export const getOpportunities = proxy('getOpportunities');
export const addScanRun = proxy('addScanRun');
export const getScanRuns = proxy('getScanRuns');
export const getLastScanRun = proxy('getLastScanRun');
export const addSourceStatus = proxy('addSourceStatus');
export const getSourceStatus = proxy('getSourceStatus');
export const addAlertEvent = proxy('addAlertEvent');
export const getAlertEvents = proxy('getAlertEvents');
export const createSetup = proxy('createSetup');
export const updateSetup = proxy('updateSetup');
export const supersedeSetup = proxy('supersedeSetup');
export const markSetupResolved = proxy('markSetupResolved');
export const getActiveSetup = proxy('getActiveSetup');
export const getLastSetup = proxy('getLastSetup');
export const getResolvableSetups = proxy('getResolvableSetups');
export const listSetups = proxy('listSetups');
export const getSetup = proxy('getSetup');
export const recordSignalValues = proxy('recordSignalValues');
export const saveSetupVector = proxy('saveSetupVector');
export const getPricePath = proxy('getPricePath');
export const upsertOutcome = proxy('upsertOutcome');
export const getOutcomes = proxy('getOutcomes');
export const learnSuccessRate = proxy('learnSuccessRate');
export const learnSignalEdge = proxy('learnSignalEdge');
export const learnSimilar = proxy('learnSimilar');
export const upsertCandles = proxy('upsertCandles');
export const getCandleTimestamps = proxy('getCandleTimestamps');
export const getLatestCandleTs = proxy('getLatestCandleTs');
export const getCandles = proxy('getCandles');
export const getCandlesRange = proxy('getCandlesRange');
export const upsertAssetSource = proxy('upsertAssetSource');
export const getAssetSources = proxy('getAssetSources');
export const upsertAssetProfile = proxy('upsertAssetProfile');
export const getAssetProfile = proxy('getAssetProfile');
export const getAssetProfiles = proxy('getAssetProfiles');
export const getCoverageOverview = proxy('getCoverageOverview');
export const learnRRBuckets = proxy('learnRRBuckets');
export const learnWinRateByType = proxy('learnWinRateByType');
export const getRadarLearnStats = proxy('getRadarLearnStats');
export const getBackfillStats = proxy('getBackfillStats');
export const getCoinHistories = proxy('getCoinHistories');
export const getMeta = proxy('getMeta');
export const close = proxy('close');
