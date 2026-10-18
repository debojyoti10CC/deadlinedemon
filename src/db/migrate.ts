import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { transaction } from './pool.js';
export async function migrate(pool: pg.Pool): Promise<void> {
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('deadline-demon-migrations',0))");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // SQL remains in the source tree in the runtime image; works in tsx and dist.
    const dir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
    const fallback = fileURLToPath(new URL('./migrations/', import.meta.url));
    let location = fallback;
    try { await readdir(location); } catch { location = dir; }
    const files = (await readdir(location)).filter(f => f.endsWith('.sql')).sort();
    if (!files.length) throw new Error('No database migrations found');
    for (const name of files) {
      if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await db.query(await readFile(`${location}/${name}`, 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}
