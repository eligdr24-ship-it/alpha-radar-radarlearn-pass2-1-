// Manually run migrations against DATABASE_URL. Usage: npm run db:migrate
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
const r = await runMigrations(pool);
console.log(r.applied.length ? `applied: ${r.applied.join(', ')}` : 'already up to date');
await pool.end();
process.exit(0);
