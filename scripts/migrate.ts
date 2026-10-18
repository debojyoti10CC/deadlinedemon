import 'dotenv/config';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(process.env.DATABASE_URL);
try { await migrate(pool); console.log('PostgreSQL migrations applied.'); }
finally { await pool.end(); }
