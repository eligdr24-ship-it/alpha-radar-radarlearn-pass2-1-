// In-memory store with atomic JSON-file flush. Used as the fallback driver
// when DATABASE_URL is absent or Postgres is unreachable. Same async interface
// as the Postgres driver so callers don't care which is active.
import fs from 'fs';
import path from 'path';

export function createMemoryStore() {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const FILE = path.join(DATA_DIR, 'alpha-radar.json');
  const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS || 20);
  const MAX_RUNS = Number(process.env.MAX_SCAN_RUNS || 50);
  const MAX_EVENTS = Number(process.env.MAX_ALERT_EVENTS || 100);

  const empty = () => ({
    universe: null, snapshots: [], opportunities: null,
    scanRuns: [], sourceStatus: [], alertEvents: [],
  });
  let state = empty();
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 250);
  }
  function flush() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (err) { console.error('[store:mem] flush failed:', err.message); }
  }
  const ring = (arr, max) => (arr.length > max ? arr.slice(-max) : arr);

  return {
    driverName: 'memory',
    async init() {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(FILE)) {
          state = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
          console.log(`[store:mem] loaded ${FILE}`);
        } else console.log(`[store:mem] fresh store at ${FILE}`);
      } catch (err) { console.error('[store:mem] load failed:', err.message); state = empty(); }
    },
    async setUniverse(u) { state.universe = u; scheduleFlush(); },
    async getUniverse() { return state.universe; },
    async addSnapshot(s) {
      const snap = { id: `snap_${Date.now()}`, ...s };
      state.snapshots.push(snap); state.snapshots = ring(state.snapshots, MAX_SNAPSHOTS); scheduleFlush(); return snap;
    },
    async getLatestSnapshot() { return state.snapshots[state.snapshots.length - 1] || null; },
    async getSnapshots(limit = MAX_SNAPSHOTS) { return state.snapshots.slice(-limit); },
    async setOpportunities(o) { state.opportunities = o; scheduleFlush(); },
    async getOpportunities() { return state.opportunities; },
    async addScanRun(r) {
      const run = { id: `run_${Date.now()}`, ...r };
      state.scanRuns.push(run); state.scanRuns = ring(state.scanRuns, MAX_RUNS); scheduleFlush(); return run;
    },
    async getScanRuns(limit = 20) { return state.scanRuns.slice(-limit).reverse(); },
    async getLastScanRun() { return state.scanRuns[state.scanRuns.length - 1] || null; },
    async addSourceStatus(rows) {
      for (const r of rows) state.sourceStatus.push(r);
      state.sourceStatus = ring(state.sourceStatus, 500); scheduleFlush();
    },
    async getSourceStatus(limit = 50) { return state.sourceStatus.slice(-limit).reverse(); },
    async addAlertEvent(e) {
      const ev = { id: `evt_${Date.now()}`, ...e };
      state.alertEvents.push(ev); state.alertEvents = ring(state.alertEvents, MAX_EVENTS); scheduleFlush(); return ev;
    },
    async getAlertEvents(limit = 50) { return state.alertEvents.slice(-limit).reverse(); },
    async getCoinHistories(symbols, sinceISO) {
      const want = new Set(symbols);
      const sinceMs = sinceISO ? +new Date(sinceISO) : 0;
      const out = {};
      for (const snap of state.snapshots) {
        if (sinceMs && +new Date(snap.at) < sinceMs) continue;
        for (const c of snap.coins || []) {
          if (!want.has(c.symbol)) continue;
          (out[c.symbol] ||= []).push({ at: snap.at, price: c.price, volume24hUsd: c.volume24hUsd, liquidityUsd: c.liquidityUsd, change24h: c.change24h });
        }
      }
      return out;
    },
    // ---- Deep history: no-ops (Postgres only) ----
    async upsertCandles() { return 0; }, async getLatestCandleTs() { return null; },
    async getCandles() { return []; }, async getCandlesRange() { return []; },
    async upsertAssetSource() {}, async getAssetSources() { return []; },
    async upsertAssetProfile() {}, async getAssetProfile() { return null; },
    async getAssetProfiles() { return {}; }, async getCoverageOverview() { return []; },
    // ---- Radar Learn: no-ops (Postgres only). Memory mode skips learning. ----
    async createSetup() {}, async updateSetup() {}, async supersedeSetup() {},
    async markSetupResolved() {}, async getActiveSetup() { return null; }, async getLastSetup() { return null; },
    async getResolvableSetups() { return []; }, async listSetups() { return []; }, async getSetup() { return null; },
    async recordSignalValues() {}, async saveSetupVector() {}, async getPricePath() { return []; },
    async upsertOutcome() {}, async getOutcomes() { return []; },
    async learnSuccessRate() { return []; }, async learnSignalEdge() { return []; }, async learnSimilar() { return []; },
    async getMeta() {
      const last = state.scanRuns[state.scanRuns.length - 1] || null;
      return {
        driver: 'memory-json', file: FILE,
        universeSize: state.universe?.coins?.length || 0,
        snapshots: state.snapshots.length, scanRuns: state.scanRuns.length,
        alertEvents: state.alertEvents.length,
        lastScanAt: last?.finishedAt || null, lastScanStatus: last?.status || 'none',
      };
    },
    async close() { flush(); },
  };
}
