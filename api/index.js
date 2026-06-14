// Vercel serverless entry. Re-exports the Express API as a single function.
// NOTE: Vercel functions are EPHEMERAL. With DATABASE_URL set, history DOES
// persist (Postgres is external); without it, the in-memory store resets per
// invocation. For 24/7 cron scanning use the long-running Render service.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import api from '../server/src/routes/api.js';
import { initStore } from '../server/src/db/store.js';

await initStore();

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use('/api', api);

export default app;
