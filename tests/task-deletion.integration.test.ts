import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Contract, ContractState, GitHubReader, Transport, User } from '../src/types.js';
import { deleteContract, setIntensity } from '../src/contracts/service.js';
import { contractByReference, contractsFor, queueMessage } from '../src/db/queries.js';
import { migrate } from '../src/db/migrate.js';
import { lockUser, transaction } from '../src/db/pool.js';
import { deliverOutbox, type OutboxRow } from '../src/scheduler/outbox.js';
import { queueDueSummary, unfinishedForSummary } from '../src/scheduler/summaries.js';

// This suite never loads .env or falls back to the application's DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `dd_delete_${randomUUID().replaceAll('-', '')}`;
const HOUR = 60 * 60_000;

describe.skipIf(!databaseUrl)('durable task deletion in real PostgreSQL', () => {
 let admin: pg.Pool | undefined;
 let pool: pg.Pool | undefined;
 let created = false;

 function scopedPool(target = schema): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000,
   statement_timeout: 15_000, options: `-c search_path=${target}`, application_name: 'deadline-demon-delete-tests' });
 }
 async function owner(): Promise<User> {
  return (await pool!.query<User>(`INSERT INTO users(imessage_handle,timezone,space_id,hourly_summary_due_at)
   VALUES($1,'Asia/Kolkata',$2,now()+interval '1 hour') RETURNING *`,
  [`${randomUUID()}@example.test`, `space-${randomUUID()}`])).rows[0]!;
 }
 async function task(user: User, state: ContractState = 'active', title = 'Delete exactly this task'): Promise<Contract> {
  return (await pool!.query<Contract>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state,
   progress_percent,confirmed_at,completed_at,missed_at)
   VALUES($1,$2,'task',now()+interval '3 hours','mild',$3,$4,$5,$6,$7) RETURNING *`,
  [user.id, title, state, state === 'completed' ? 100 : 27,
   ['active', 'missed', 'completed'].includes(state) ? new Date() : null,
   state === 'completed' ? new Date() : null, state === 'missed' ? new Date() : null])).rows[0]!;
 }
 async function ownerTransaction<T>(user: User, work: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool!, async db => { await lockUser(db, user.id);return work(db); });
 }
 async function load(id: string): Promise<Contract> {
  return (await pool!.query<Contract>('SELECT * FROM contracts WHERE id=$1', [id])).rows[0]!;
 }
 async function jobs(c: Contract) {
  return (await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1 ORDER BY id', [c.id])).rows;
 }
 async function messages(c: Contract) {
  return (await pool!.query('SELECT * FROM outbox WHERE contract_id=$1 ORDER BY id', [c.id])).rows;
 }
 async function addQueues(c: Contract, user: User) {
  for (const status of ['pending', 'processing', 'failed', 'done']) await pool!.query(`INSERT INTO scheduled_jobs
   (contract_id,job_type,run_at,status,attempts,locked_until,last_error) VALUES($1,$2,now(),$3,2,now()+interval '1 minute','old failure')`,
  [c.id, `delete-${status}`, status]);
  for (const kind of ['reply', 'reminder', 'verdict', 'victory', 'error']) {
   for (const status of ['pending', 'processing', 'failed', 'sent', 'suppressed']) await pool!.query(`INSERT INTO outbox
    (user_id,contract_id,space_id,event_key,message_text,contract_version,kind,status,attempts,locked_until)
    VALUES($1,$2,$3,$4,'Saved task update',$5,$6,$7,2,now()+interval '1 minute')`,
   [user.id, c.id, user.space_id, randomUUID(), c.version, kind, status]);
  }
 }

 beforeAll(async () => {
  if (!/^dd_delete_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
  admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
  await admin.query(`CREATE SCHEMA ${schema}`);created = true;
  pool = scopedPool();await migrate(pool);
 }, 30_000);
 beforeEach(async () => { await pool!.query('TRUNCATE users CASCADE'); });
 afterAll(async () => {
  try { await pool?.end();if (created) await admin!.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin?.end(); }
 }, 30_000);

 it.each(['pending', 'active', 'missed', 'completed', 'cancelled'] as const)('deletes one %s task without rewriting its facts or its neighbours', async state => {
  const user = await owner();const another = await owner();
  const target = await task(user, state);const sibling = await task(user, 'active', 'Keep this task');
  const foreign = await task(another, 'active', 'Another owner task');
  await pool!.query('UPDATE users SET selected_contract_id=$2 WHERE id=$1', [user.id, target.id]);
  await pool!.query(`INSERT INTO contract_events(contract_id,event_type,evidence) VALUES($1,'existing_event',$2)`,
   [target.id, JSON.stringify({ progressPercent: 27, original: true })]);
  await addQueues(target, user);await addQueues(sibling, user);await addQueues(foreign, another);
  const before = await load(target.id);const neighbour = await load(sibling.id);const other = await load(foreign.id);
  const siblingJobs = await jobs(sibling);const siblingMessages = await messages(sibling);
  const foreignJobs = await jobs(foreign);const foreignMessages = await messages(foreign);
  const queueBefore = await messages(target);const jobsBefore = await jobs(target);
  const otherOwner = (await pool!.query('SELECT * FROM users WHERE id=$1', [another.id])).rows[0];
  const when = new Date();
  expect(await ownerTransaction(user, db => deleteContract(db, target, when))).toBe(true);
  const after = await load(target.id);
  expect(after).toEqual({ ...before, deleted_at: when, version: before.version + 1 });
  expect(target.deleted_at).toEqual(when);expect(target.version).toBe(before.version + 1);
  expect(await load(sibling.id)).toEqual(neighbour);expect(await load(foreign.id)).toEqual(other);
  expect(await jobs(sibling)).toEqual(siblingJobs);expect(await messages(sibling)).toEqual(siblingMessages);
  expect(await jobs(foreign)).toEqual(foreignJobs);expect(await messages(foreign)).toEqual(foreignMessages);
  expect((await pool!.query('SELECT * FROM users WHERE id=$1', [another.id])).rows[0]).toEqual(otherOwner);
  expect((await pool!.query('SELECT selected_contract_id FROM users WHERE id=$1', [user.id])).rows[0]?.selected_contract_id).toBeNull();
  expect(await jobs(target)).toEqual(jobsBefore.map(row => row.status === 'done' ? row : { ...row, status: 'done', locked_until: null }));
  expect(await messages(target)).toEqual(queueBefore.map(row => ['pending', 'processing', 'failed'].includes(row.status)
   ? { ...row, status: 'suppressed', locked_until: null } : row));
  expect((await pool!.query('SELECT event_type,evidence FROM contract_events WHERE contract_id=$1 ORDER BY observed_at,id', [target.id])).rows)
   .toEqual([{ event_type: 'existing_event', evidence: { progressPercent: 27, original: true } },
    { event_type: 'deleted', evidence: { source: 'owner_command', deletedAt: when.toISOString() } }]);
  expect((await pool!.query('SELECT hourly_summary_due_at FROM users WHERE id=$1', [user.id])).rows[0]?.hourly_summary_due_at).toBeInstanceOf(Date);
 });

 it('repeated deletion of a stale object preserves the first timestamp and writes one audit event', async () => {
  const user = await owner();const target = await task(user);const stale = { ...target };const when = new Date();
  await ownerTransaction(user, db => deleteContract(db, target, when));
  const before = await load(target.id);
  expect(await ownerTransaction(user, db => deleteContract(db, stale, new Date(when.getTime() + HOUR)))).toBe(false);
  expect(await load(target.id)).toEqual(before);expect(stale.deleted_at).toEqual(when);expect(stale.version).toBe(before.version);
  expect((await pool!.query("SELECT * FROM contract_events WHERE contract_id=$1 AND event_type='deleted'", [target.id])).rows).toHaveLength(1);
 });

 it('also removes a GitHub commitment without discarding its evidence or completion record', async () => {
  const user = await owner();
  const target = (await pool!.query<Contract>(`INSERT INTO contracts(user_id,title,repo_owner,repo_name,artifact_type,
   artifact_number,artifact_url,due_at,intensity,state,confirmed_at,completed_at,last_observed_state)
   VALUES($1,'Completed pull request','example','app','pull_request',7,'https://github.com/example/app/pull/7',
   now()+interval '1 hour','mild','completed',now()-interval '1 hour',now(),$2) RETURNING *`,
  [user.id, JSON.stringify({ state: 'closed', mergedAt: new Date().toISOString() })])).rows[0]!;
  await addQueues(target, user);const before = await load(target.id);const when = new Date();
  await ownerTransaction(user, db => deleteContract(db, target, when));
  expect(await load(target.id)).toEqual({ ...before, deleted_at: when, version: before.version + 1 });
  expect((await messages(target)).filter(row => ['pending', 'processing', 'failed'].includes(row.status))).toEqual([]);
  expect((await pool!.query("SELECT evidence_url FROM contract_events WHERE contract_id=$1 AND event_type='deleted'", [target.id])).rows)
   .toEqual([{ evidence_url: 'https://github.com/example/app/pull/7' }]);
 });

 it('rejects a forged owner without touching the task, queues, selection or audit', async () => {
  const user = await owner();const another = await owner();const target = await task(user);
  await addQueues(target, user);
  const before = await load(target.id);const beforeJobs = await jobs(target);const beforeMessages = await messages(target);
  const users = (await pool!.query('SELECT * FROM users ORDER BY id')).rows;
  await expect(ownerTransaction(another, db => deleteContract(db, { ...target, user_id: another.id })))
   .rejects.toThrow('Task not found for this owner');
  expect(await load(target.id)).toEqual(before);expect(await jobs(target)).toEqual(beforeJobs);
  expect(await messages(target)).toEqual(beforeMessages);expect((await pool!.query('SELECT * FROM users ORDER BY id')).rows).toEqual(users);
  expect((await pool!.query('SELECT * FROM contract_events')).rows).toHaveLength(0);
 });

 it('keeps another selected task and excludes deleted work from lists, summaries and mode changes', async () => {
  const user = await owner();const target = await task(user);const selected = await task(user, 'pending', 'Selected sibling');
  await pool!.query('UPDATE users SET selected_contract_id=$2 WHERE id=$1', [user.id, selected.id]);
  await ownerTransaction(user, db => deleteContract(db, target));const frozen = await load(target.id);
  await ownerTransaction(user, async db => {
   expect((await contractsFor(db, user.id)).map(c => c.id)).toEqual([selected.id]);
   expect((await contractsFor(db, user.id, true)).map(c => c.id)).toEqual([selected.id]);
   expect((await unfinishedForSummary(db, user.id)).map(c => c.id)).toEqual([selected.id]);
   expect((await contractByReference(db, user.id, String(target.display_id)))?.deleted_at).toBeInstanceOf(Date);
   expect((await contractByReference(db, user.id, target.id))?.deleted_at).toBeInstanceOf(Date);
   await setIntensity(db, user, 'nuclear');
  });
  expect(await load(target.id)).toEqual(frozen);expect((await load(selected.id)).intensity).toBe('nuclear');
  expect((await pool!.query('SELECT selected_contract_id FROM users WHERE id=$1', [user.id])).rows[0]?.selected_contract_id).toBe(selected.id);
  const newTask = await task(user, 'pending', 'New task after deletion');expect(newTask.display_id).toBeGreaterThan(target.display_id);
 });

 it('suppresses only stale owner snapshots referencing the removed task, preserving unrelated replies and sent history', async () => {
  const user = await owner();const foreign = await owner();const target = await task(user);const keep = await task(user, 'pending', 'Keep this snapshot');
  const snapshotKeys: string[] = [];
  for (const status of ['pending', 'processing', 'failed', 'sent', 'suppressed']) {
   const key = randomUUID();snapshotKeys.push(key);
   await ownerTransaction(user, db => queueMessage(db, { userId: user.id, spaceId: user.space_id!,
    key, text: 'A structured board or proposal snapshot', referencedContractIds: [target.id, keep.id] }));
   await pool!.query("UPDATE outbox SET status=$2,locked_until=now()+interval '1 minute' WHERE event_key=$1", [key, status]);
  }
  const otherKey = randomUUID();const plainKey = randomUUID();const foreignKey = randomUUID();
  await ownerTransaction(user, async db => {
   await queueMessage(db, { userId: user.id, spaceId: user.space_id!, key: otherKey,
    text: 'Another task snapshot', referencedContractIds: [keep.id] });
   await queueMessage(db, { userId: user.id, spaceId: user.space_id!, key: plainKey, text: 'An unrelated acknowledgement' });
  });
  await ownerTransaction(foreign, db => queueMessage(db, { userId: foreign.id, spaceId: foreign.space_id!,
   key: foreignKey, text: 'Another owner snapshot', referencedContractIds: [target.id] }));
  const allBefore = (await pool!.query('SELECT * FROM outbox ORDER BY id')).rows;
  expect(allBefore.filter(row => snapshotKeys.includes(row.event_key)).every(row => row.contract_id === null
   && row.referenced_contract_ids[0] === target.id && row.referenced_contract_ids[1] === keep.id)).toBe(true);
  await ownerTransaction(user, db => deleteContract(db, target));
  expect((await pool!.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(allBefore.map(row =>
   snapshotKeys.includes(row.event_key) && ['pending', 'processing', 'failed'].includes(row.status)
    ? { ...row, status: 'suppressed', locked_until: null } : row));
 });

 it('refreshes a queued hourly summary after deletion and stops the clock only when visible work is empty', async () => {
  const user = await owner();const target = await task(user);const keep = await task(user, 'pending', 'Keep visible work');
  const now = new Date();await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, now]);
  await queueDueSummary(pool!, now);
  const queued = (await pool!.query<OutboxRow>("SELECT * FROM outbox WHERE user_id=$1 AND kind='summary'", [user.id])).rows[0]!;
  expect(queued.message_text).toContain(target.title);
  await ownerTransaction(user, db => deleteContract(db, target));
  const forbidden = vi.fn(async () => { throw new Error('No external request is permitted'); });
  const send = vi.fn(async (_space: string, _text: string) => undefined);
  const transport: Transport = { send, responding: async (_space, work) => work(), stop: vi.fn() };
  await ownerTransaction(user, db => deliverOutbox(db, queued, { inspect: forbidden } as GitHubReader,
   { parse: forbidden, generate: forbidden } as Agent, transport));
  expect(send).toHaveBeenCalledExactlyOnceWith(user.space_id, expect.stringContaining(keep.title));
  expect(send.mock.calls[0]?.[1]).not.toContain(target.title);expect(forbidden).not.toHaveBeenCalled();
  await pool!.query("UPDATE users SET hourly_summary_due_at=now()-interval '1 second' WHERE id=$1", [user.id]);await queueDueSummary(pool!);
  const pending = (await pool!.query<{ id: string }>("SELECT id FROM outbox WHERE user_id=$1 AND kind='summary' AND status='pending'", [user.id])).rows[0]!;
  expect(pending).toBeDefined();await ownerTransaction(user, db => deleteContract(db, keep));
  expect((await pool!.query('SELECT hourly_summary_due_at FROM users WHERE id=$1', [user.id])).rows[0]?.hourly_summary_due_at).toBeNull();
  expect((await pool!.query('SELECT status FROM outbox WHERE id=$1', [pending.id])).rows[0]?.status).toBe('suppressed');
  await queueDueSummary(pool!);expect((await pool!.query("SELECT * FROM outbox WHERE status='pending'")).rows).toHaveLength(0);
 });

 it('persists tombstones across connection restart and migration reruns', async () => {
  const user = await owner();const target = await task(user);await ownerTransaction(user, db => deleteContract(db, target));
  const before = await load(target.id);await pool!.end();pool = scopedPool();await migrate(pool);
  expect(await load(target.id)).toEqual(before);
  await ownerTransaction(user, async db => {
   expect(await contractsFor(db, user.id, true)).toEqual([]);
   expect((await contractByReference(db, user.id, String(target.display_id)))?.deleted_at).toEqual(before.deleted_at);
  });
 });

 it('adds the tombstone column without changing existing task rows or migration history', async () => {
  const legacySchema = `dd_delete_legacy_${randomUUID().replaceAll('-', '')}`;
  if (!/^dd_delete_legacy_[a-f0-9]{32}$/.test(legacySchema)) throw new Error('Unsafe legacy schema');
  await admin!.query(`CREATE SCHEMA ${legacySchema}`);const legacy = scopedPool(legacySchema);
  try {
   await legacy.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
   for (const name of ['001_initial.sql', '002_general_tasks.sql', '003_task_experience.sql', '004_hourly_summaries.sql', '005_deadline_alerts.sql']) {
    await legacy.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    await legacy.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
   }
   const user = (await legacy.query<{ id: string }>("INSERT INTO users(imessage_handle,timezone) VALUES('legacy@example.test','Asia/Kolkata') RETURNING id")).rows[0]!;
   await legacy.query(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state,progress_percent)
    VALUES($1,'Existing draft','task',now()+interval '2 hours','mild','pending',27)`, [user.id]);
   await legacy.query(`INSERT INTO outbox(user_id,space_id,event_key,message_text,kind)
    VALUES($1,'legacy-space','legacy-reply','Saved acknowledgement','reply')`, [user.id]);
   const before = (await legacy.query('SELECT * FROM contracts ORDER BY id')).rows;
   const usersBefore = (await legacy.query('SELECT * FROM users ORDER BY id')).rows;
   const messagesBefore = (await legacy.query('SELECT * FROM outbox ORDER BY id')).rows;
   const migrations = (await legacy.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
   await migrate(legacy);await migrate(legacy);
   expect((await legacy.query('SELECT * FROM contracts ORDER BY id')).rows).toEqual(before.map(row => ({ ...row, deleted_at: null })));
   expect((await legacy.query('SELECT * FROM users ORDER BY id')).rows).toEqual(usersBefore);
   expect((await legacy.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(messagesBefore.map(row => ({ ...row, referenced_contract_ids: null })));
   expect((await legacy.query('SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name', ['006_task_deletion.sql'])).rows).toEqual(migrations);
   expect((await legacy.query('SELECT * FROM schema_migrations WHERE name=$1', ['006_task_deletion.sql'])).rows).toHaveLength(1);
  } finally { await legacy.end();await admin!.query(`DROP SCHEMA ${legacySchema} CASCADE`); }
 });
});
