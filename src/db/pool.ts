import pg, { type PoolClient } from 'pg';
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000, statement_timeout: 180000, application_name: 'deadline-demon' });
}
export async function transaction<T>(pool: pg.Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function lockUser(db: PoolClient, userId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
}
