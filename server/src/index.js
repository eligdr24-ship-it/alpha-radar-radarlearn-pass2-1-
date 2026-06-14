import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import api from './routes/api.js';
import { initStore, activeDriver, getUniverse } from './db/store.js';
import { runScan } from './services/scanner.js';
import { resolveAll } from './services/outcomeResolver.js';
import { runBackfill } from './services/historyBackfill.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));
app.use('/api', api);

const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
app.get(/.*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Boot: init store (Postgres or memory) -> listen -> initial scan -> cron.
await initStore();

const intervalMin = Math.min(5, Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 2)));
const cronEnabled = process.env.DISABLE_CRON !== 'true';

app.listen(PORT, () => {
  console.log(`Alpha Radar running on port ${PORT}`);
  runScan('startup').catch((e) => console.error('[boot] initial scan failed:', e.message));
  if (cronEnabled) {
    const expr = `*/${intervalMin} * * * *`;
    cron.schedule(expr, () => runScan('cron'));
    console.log(`[cron] scanning every ${intervalMin} min ("${expr}")`);

    // Radar Learn outcome resolver (Postgres only).
    if (activeDriver() === 'postgres') {
      const rmin = Math.min(15, Math.max(5, Number(process.env.RL_RESOLVER_MINUTES || 10)));
      cron.schedule(`*/${rmin} * * * *`, () => resolveAll().catch((e) => console.error('[resolver]', e.message)));
      console.log(`[cron] outcome resolver every ${rmin} min`);

      // Deep-history keep-fresh: daily append + provenance refresh.
      const refreshExpr = process.env.HIST_REFRESH_CRON || '0 3 * * *';
      cron.schedule(refreshExpr, async () => {
        try {
          const uni = await getUniverse();
          const symbols = (uni?.coins || []).map((c) => c.symbol);
          const r = await runBackfill({ symbols });
          console.log(`[history] keep-fresh: ${r.count || 0} assets refreshed`);
        } catch (e) { console.error('[history] keep-fresh failed:', e.message); }
      });
      console.log(`[cron] deep-history keep-fresh ("${refreshExpr}")`);
    }
  } else {
    console.log('[cron] disabled (DISABLE_CRON=true)');
  }
});
