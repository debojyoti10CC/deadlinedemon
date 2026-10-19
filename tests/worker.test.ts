import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { Worker } from '../src/scheduler/worker.js';
import type { Agent, Evidence, GitHubReader, Transport } from '../src/types.js';
import type { Orchestrator } from '../src/agent/orchestrator.js';
import type { Logger } from 'pino';

// The live application URL is deliberately never read by this regression suite.
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `dd_worker_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!databaseUrl)('worker retries after a paused delivery', () => {
 let admin: pg.Pool | undefined;
 let pool: pg.Pool | undefined;
 let created = false;
 beforeAll(async () => {
  if (!/^dd_worker_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
  admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA ${schema}`);created = true;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000,
   statement_timeout: 15_000, options: `-c search_path=${schema}` });
  await migrate(pool);
 }, 30_000);
 beforeEach(async () => { await pool!.query('TRUNCATE users CASCADE'); });
 afterAll(async () => {
  try { await pool?.end();if (created) await admin!.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin?.end(); }
 }, 30_000);

 it.each(['reminder', 'verdict', 'victory', 'error'] as const)('preserves the retry budget for %s after a long pause', async kind => {
  const user = (await pool!.query<{ id: string }>(`INSERT INTO users(imessage_handle,timezone,space_id,paused)
   VALUES('paused@example.test','Asia/Kolkata','test-space',true) RETURNING id`)).rows[0]!;
  const task = (await pool!.query<{ id: string }>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state)
   VALUES($1,'Paused task','task',now()+interval '2 hours','mild','active') RETURNING id`, [user.id])).rows[0]!;
  const row = (await pool!.query<{ id: string }>(`INSERT INTO outbox(user_id,contract_id,space_id,event_key,message_text,kind)
   VALUES($1,$2,'test-space','pause-retry','Queued task update',$3) RETURNING id`, [user.id, task.id, kind])).rows[0]!;
  const forbidden = vi.fn(async () => { throw new Error('Unexpected integration call'); });
  const send = vi.fn(async () => { throw new Error('Transient transport failure'); });
  const transport: Transport = { send, responding: async (_space, work) => work(), stop: vi.fn() };
  const worker = new Worker(pool!, {} as Orchestrator, { inspect: forbidden } as GitHubReader,
   { parse: forbidden, generate: forbidden } as Agent, transport, { error: vi.fn() } as unknown as Logger);
  const tick = async () => {
   // Advance only this isolated fixture, without sleeping or changing the host clock.
   await pool!.query('UPDATE outbox SET run_at=now() WHERE id=$1', [row.id]);
   await worker.tick();
   return (await pool!.query<{ status: string; attempts: number }>('SELECT status,attempts FROM outbox WHERE id=$1', [row.id])).rows[0]!;
  };
  for (let i = 0; i < 6; i++) expect(await tick()).toEqual({ status: 'pending', attempts: 0 });
  expect(send).not.toHaveBeenCalled();
  await pool!.query('UPDATE users SET paused=false WHERE id=$1', [user.id]);
  for (let attempt = 1; attempt < 5; attempt++) expect(await tick()).toEqual({ status: 'pending', attempts: attempt });
  expect(await tick()).toEqual({ status: 'failed', attempts: 5 });
  expect(send).toHaveBeenCalledTimes(5);
  expect(forbidden).not.toHaveBeenCalled();
 });

 it('resumes into the current deadline alert without sending stale checkpoint or outbox bursts', async () => {
  const user = (await pool!.query<{ id: string }>(`INSERT INTO users(imessage_handle,timezone,space_id,paused)
   VALUES('alerts@example.test','Asia/Kolkata','test-space',true) RETURNING id`)).rows[0]!;
  const task = (await pool!.query<{ id: string }>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state,confirmed_at,progress_percent)
   VALUES($1,'Finish the video','task',now()+interval '10 minutes','mild','active',now()-interval '3 hours',27) RETURNING id`, [user.id])).rows[0]!;
  for (const checkpoint of [120, 60, 30, 15]) await pool!.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at)
   VALUES($1,$2,now()-interval '1 minute')`, [task.id, `before_${checkpoint}`]);
  await pool!.query(`INSERT INTO outbox(user_id,contract_id,space_id,event_key,message_text,kind)
   VALUES($1,$2,'test-space',$3,'Old one-hour warning','reminder')`, [user.id, task.id, `milestone:${task.id}:before_60`]);
  const forbidden = vi.fn(async () => { throw new Error('Unexpected integration call'); });
  const send = vi.fn(async (_spaceId: string, _text: string) => undefined);
  const transport: Transport = { send, responding: async (_space, work) => work(), stop: vi.fn() };
  const worker = new Worker(pool!, {} as Orchestrator, { inspect: forbidden } as GitHubReader,
   { parse: forbidden, generate: forbidden } as Agent, transport, { error: vi.fn() } as unknown as Logger);
  // All four checkpoints can become due during a pause; none should send while paused.
  for (let i = 0; i < 4; i++) await worker.tick();
  expect(send).not.toHaveBeenCalled();
  await pool!.query('UPDATE users SET paused=false WHERE id=$1', [user.id]);
  await pool!.query("UPDATE scheduled_jobs SET run_at=now()-interval '1 minute' WHERE contract_id=$1", [task.id]);
  await pool!.query("UPDATE outbox SET run_at=now()-interval '1 minute' WHERE contract_id=$1", [task.id]);
  for (let i = 0; i < 5; i++) await worker.tick();
  expect(send).toHaveBeenCalledExactlyOnceWith('test-space', expect.stringMatching(/^Deadline alert · /));
  expect(send.mock.calls[0]?.[1]).toContain('Finish the video');
  expect(send.mock.calls[0]?.[1]).toContain('HP ▰▰▱▱▱▱▱▱▱▱ 27%');
  expect(forbidden).not.toHaveBeenCalled();
  expect((await pool!.query('SELECT job_type,status FROM scheduled_jobs WHERE contract_id=$1 ORDER BY job_type', [task.id])).rows)
   .toEqual([120, 15, 30, 60].map(checkpoint => ({ job_type: `before_${checkpoint}`, status: 'done' })));
  expect((await pool!.query('SELECT event_key,status FROM outbox WHERE contract_id=$1 ORDER BY event_key', [task.id])).rows)
   .toEqual([
    { event_key: `milestone:${task.id}:before_15`, status: 'sent' },
    { event_key: `milestone:${task.id}:before_60`, status: 'suppressed' },
   ]);
 });

 it('queues and delivers GitHub checkpoint alerts with fresh evidence and no generated countdown', async () => {
  const user = (await pool!.query<{ id: string }>(`INSERT INTO users(imessage_handle,timezone,space_id)
   VALUES('github-alerts@example.test','Asia/Kolkata','test-space') RETURNING id`)).rows[0]!;
  const linked = (await pool!.query<{ id: string }>(`INSERT INTO contracts(user_id,title,artifact_type,repo_owner,repo_name,artifact_number,artifact_url,due_at,intensity,state,confirmed_at)
   VALUES($1,'Merge the feature','pull_request','owner','repo',42,'https://github.com/owner/repo/pull/42',now()+interval '90 minutes','mild','active',now()-interval '3 hours') RETURNING id`, [user.id])).rows[0]!;
  await pool!.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at)
   VALUES($1,'before_120',now()-interval '1 minute')`, [linked.id]);
  const facts: Evidence = {
   artifact: { repo_owner: 'owner', repo_name: 'repo', artifact_type: 'pull_request', artifact_number: 42, artifact_url: 'https://github.com/owner/repo/pull/42' },
   observedAt: new Date().toISOString(), title: 'Merge the feature', state: 'open', mergedAt: null, closedAt: null,
   headSha: 'a'.repeat(40), mergeable: true, draft: false, checks: [], reviews: [], files: [], limitations: [],
  };
  const inspect = vi.fn(async () => facts);
  const forbidden = vi.fn(async () => { throw new Error('Unexpected model call'); });
  const send = vi.fn(async (_spaceId: string, _text: string) => undefined);
  const transport: Transport = { send, responding: async (_space, work) => work(), stop: vi.fn() };
  const worker = new Worker(pool!, {} as Orchestrator, { inspect } as GitHubReader,
   { parse: forbidden, generate: forbidden } as Agent, transport, { error: vi.fn() } as unknown as Logger);
  await worker.tick();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(forbidden).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith('test-space', expect.stringMatching(/^Deadline alert · 1h/));
  expect(send.mock.calls[0]?.[1]).toContain('Merge the feature');
  expect(send.mock.calls[0]?.[1]).toContain('GitHub reports PR open; no merge verified');
  expect((await pool!.query('SELECT status FROM scheduled_jobs WHERE contract_id=$1', [linked.id])).rows).toEqual([{ status: 'done' }]);
 });

 it('discards reclaimed jobs and every queued snapshot for a deleted task without changing another task or its timing', async () => {
  const user = (await pool!.query<{ id: string }>(`INSERT INTO users(imessage_handle,timezone,space_id,paused,hourly_summary_due_at)
   VALUES('deleted@example.test','Asia/Kolkata','test-space',true,now()+interval '1 hour') RETURNING id`)).rows[0]!;
  const deleted = (await pool!.query<{ id: string }>(`INSERT INTO contracts(user_id,title,artifact_type,repo_owner,repo_name,artifact_number,artifact_url,due_at,intensity,state,confirmed_at,deleted_at)
   VALUES($1,'Deleted GitHub task','pull_request','owner','repo',42,'https://github.com/owner/repo/pull/42',now()+interval '10 minutes','mild','active',now()-interval '3 hours',now()) RETURNING id`, [user.id])).rows[0]!;
  const other = (await pool!.query<{ id: string }>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state,confirmed_at,progress_percent)
   VALUES($1,'Keep this task','task',now()+interval '3 hours','savage','active',now()-interval '1 hour',44) RETURNING id`, [user.id])).rows[0]!;
  await pool!.query('UPDATE users SET selected_contract_id=$2 WHERE id=$1', [user.id, other.id]);
  await pool!.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at)
   VALUES($1,'before_120',now()+interval '1 hour')`, [other.id]);
  for (const [index, type] of ['monitor', 'before_15', 'deadline', 'followup'].entries()) {
   await pool!.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at,status,attempts,locked_until)
    VALUES($1,$2,now()-interval '1 minute',$3,4,now()-interval '1 minute')`, [deleted.id, type, index % 2 ? 'processing' : 'pending']);
  }
  for (const [index, kind] of ['reply', 'reminder', 'verdict', 'victory', 'error', 'summary'].entries()) {
   await pool!.query(`INSERT INTO outbox(user_id,contract_id,contract_version,space_id,event_key,message_text,kind,status,attempts,locked_until)
    VALUES($1,$2,NULL,'test-space',$3,'Stale deleted task snapshot',$4,$5,4,now()-interval '1 minute')`,
    [user.id, deleted.id, `deleted:${kind}`, kind, index % 2 ? 'processing' : 'pending']);
  }
  const taskBefore = (await pool!.query('SELECT * FROM contracts WHERE id=$1', [other.id])).rows;
  const jobsBefore = (await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1', [other.id])).rows;
  const ownerBefore = (await pool!.query('SELECT paused,selected_contract_id,hourly_summary_due_at FROM users WHERE id=$1', [user.id])).rows;
  const forbidden = vi.fn(async () => { throw new Error('Deleted task must not call integrations'); });
  const worker = new Worker(pool!, {} as Orchestrator, { inspect: forbidden } as GitHubReader,
   { parse: forbidden, generate: forbidden } as Agent, { send: forbidden, responding: forbidden, stop: forbidden } as Transport,
   { error: vi.fn() } as unknown as Logger);
  for (let i = 0; i < 6; i++) await worker.tick();
  expect(forbidden).not.toHaveBeenCalled();
  expect((await pool!.query('SELECT status FROM scheduled_jobs WHERE contract_id=$1', [deleted.id])).rows).toEqual(Array(4).fill({ status: 'done' }));
  expect((await pool!.query('SELECT status FROM outbox WHERE contract_id=$1', [deleted.id])).rows).toEqual(Array(6).fill({ status: 'suppressed' }));
  expect((await pool!.query('SELECT * FROM contracts WHERE id=$1', [other.id])).rows).toEqual(taskBefore);
  expect((await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1', [other.id])).rows).toEqual(jobsBefore);
  expect((await pool!.query('SELECT paused,selected_contract_id,hourly_summary_due_at FROM users WHERE id=$1', [user.id])).rows).toEqual(ownerBefore);
 });
});
