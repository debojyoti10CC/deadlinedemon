import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Contract, Evidence, GitHubContract, GitHubReader, TaskContract, Transport, User } from '../src/types.js';
import { migrate } from '../src/db/migrate.js';
import { lockUser, transaction } from '../src/db/pool.js';
import { queueMessage } from '../src/db/queries.js';
import { cancelContract, confirmContract, createContract, createTaskContract, observe, observeTaskDeadline, reportTaskComplete, reportTaskProgress, reschedulePendingContract, setIntensity } from '../src/contracts/service.js';
import { persistInbound } from '../src/photon/inbound.js';
import { claim } from '../src/scheduler/worker.js';
import { deliverOutbox, type OutboxRow } from '../src/scheduler/outbox.js';
import { ensureHourlySummary, queueDueSummary, unfinishedForSummary } from '../src/scheduler/summaries.js';

// Never falls back to DATABASE_URL: production credentials cannot accidentally enable this suite.
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `dd_test_${randomUUID().replaceAll('-', '')}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    artifact: { repo_owner: 'acme', repo_name: 'app', artifact_type: 'pull_request', artifact_number: 7, artifact_url: 'https://github.com/acme/app/pull/7' },
    observedAt: new Date().toISOString(), title: 'Ship it', state: 'open', mergedAt: null,
    closedAt: null, headSha: 'a'.repeat(40), mergeable: null, draft: false,
    checks: [], reviews: [], files: [], limitations: [], ...overrides,
  };
}

describe.skipIf(!databaseUrl)('real PostgreSQL durability and contract lifecycle', () => {
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let schemaCreated = false;

  function scopedPool(): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000, options: `-c search_path=${schema}`, application_name: 'deadline-demon-tests' });
  }

  async function newUser(): Promise<User> {
    return (await pool!.query<User>(`INSERT INTO users(imessage_handle,timezone,space_id) VALUES($1,'Asia/Kolkata','test-space') RETURNING *`, [`${randomUUID()}@example.test`])).rows[0]!;
  }

  async function newContract(user: User, now = new Date()): Promise<Contract> {
    const e = evidence();
    return userTransaction(user, (db) => createContract(db, user, e.artifact, 'Ship the feature', new Date(now.getTime() + 120 * MINUTE), 'savage', e));
  }

  async function userTransaction<T>(user: User, work: (db: PoolClient) => Promise<T>): Promise<T> {
    return transaction(pool!, async (db) => {
      await lockUser(db, user.id);
      await db.query('SELECT id FROM contracts WHERE user_id=$1 FOR UPDATE', [user.id]);
      return work(db);
    });
  }

  async function loadContract(id: string): Promise<Contract> {
    return (await pool!.query<Contract>('SELECT * FROM contracts WHERE id=$1', [id])).rows[0]!;
  }

  async function summaryDue(user: User): Promise<Date | null> {
    return (await pool!.query<{ hourly_summary_due_at: Date | null }>('SELECT hourly_summary_due_at FROM users WHERE id=$1', [user.id])).rows[0]!.hourly_summary_due_at;
  }

  async function queueSummaryNow(user: User): Promise<OutboxRow> {
    const now = new Date();
    await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, new Date(now.getTime() - MINUTE)]);
    await queueDueSummary(pool!, now);
    return (await pool!.query<OutboxRow>("SELECT * FROM outbox WHERE user_id=$1 AND kind='summary' ORDER BY created_at DESC LIMIT 1", [user.id])).rows[0]!;
  }

  function offlineDelivery() {
    const inspect = vi.fn(async () => { throw new Error('Hourly summaries must not request GitHub'); });
    const generate = vi.fn(async () => { throw new Error('Hourly summaries must not request OpenAI'); });
    const parse = vi.fn(async () => { throw new Error('Hourly summaries must not parse with OpenAI'); });
    const send = vi.fn(async (_spaceId: string, _text: string) => {});
    const responding = vi.fn(async (_spaceId: string, work: () => Promise<unknown>) => work());
    return { inspect, generate, parse, send, github: { inspect } as GitHubReader,
      ai: { parse, generate } as Agent, transport: { send, responding, stop: vi.fn() } as Transport };
  }

  beforeAll(async () => {
    if (!/^dd_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema name');
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = scopedPool();
    await migrate(pool);
  }, 30_000);

  beforeEach(async () => {
    await pool!.query('TRUNCATE users CASCADE');
  });

  afterAll(async () => {
    try {
      await pool?.end();
      if (schemaCreated && /^dd_test_[a-f0-9]{32}$/.test(schema)) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await admin?.end(); }
  }, 30_000);

  it('isolates all tables and migration tracking in the generated schema and migrates idempotently', async () => {
    const before = (await pool!.query('SELECT name FROM schema_migrations ORDER BY name')).rows;
    expect(before.length).toBeGreaterThan(0);
    await migrate(pool!);
    expect((await pool!.query('SELECT current_schema() AS name')).rows[0]?.name).toBe(schema);
    const names = (await pool!.query<{ schemaname: string }>(`SELECT schemaname FROM pg_tables WHERE tablename IN ('users','contracts','schema_migrations') AND schemaname=$1`, [schema])).rows;
    expect(names).toHaveLength(3);
    expect((await pool!.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual(before);
  });

  it('adds references and progress to existing rows without changing their state or history', async () => {
    const legacySchema = `${schema}_legacy`;
    if (!/^dd_test_[a-f0-9]{32}_legacy$/.test(legacySchema)) throw new Error('Unsafe legacy test schema name');
    await admin!.query(`CREATE SCHEMA "${legacySchema}"`);
    const legacy = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${legacySchema}`,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    try {
      await legacy.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of ['001_initial.sql', '002_general_tasks.sql']) {
        await legacy.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
        await legacy.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
      const user = (await legacy.query<User>("INSERT INTO users(imessage_handle,timezone) VALUES('legacy@example.test','Asia/Kolkata') RETURNING *")).rows[0]!;
      const firstId = randomUUID();
      const secondId = randomUUID();
      await legacy.query(`INSERT INTO contracts(id,user_id,title,artifact_type,due_at,intensity,state,created_at,completed_at)
        VALUES($1,$3,'Completed old task','task','2026-10-20','mild','completed','2026-10-01','2026-10-19'),
        ($2,$3,'Cancelled old task','task','2026-10-19','savage','cancelled','2026-10-02',NULL)`, [firstId, secondId, user.id]);
      await legacy.query("INSERT INTO contract_events(contract_id,event_type,evidence) VALUES($1,'legacy_event','{\"preserved\":true}')", [firstId]);
      await legacy.query("INSERT INTO scheduled_jobs(contract_id,job_type,run_at) VALUES($1,'deadline','2026-10-19')", [secondId]);
      const columns = 'id,user_id,title,artifact_type,due_at,intensity,state,created_at,completed_at,missed_at,version';
      const contractsBefore = (await legacy.query(`SELECT ${columns} FROM contracts ORDER BY id`)).rows;
      const eventsBefore = (await legacy.query('SELECT * FROM contract_events ORDER BY id')).rows;
      const jobsBefore = (await legacy.query('SELECT * FROM scheduled_jobs ORDER BY id')).rows;
      await migrate(legacy);
      expect((await legacy.query(`SELECT ${columns} FROM contracts ORDER BY id`)).rows).toEqual(contractsBefore);
      expect((await legacy.query('SELECT * FROM contract_events ORDER BY id')).rows).toEqual(eventsBefore);
      expect((await legacy.query('SELECT * FROM scheduled_jobs ORDER BY id')).rows).toEqual(jobsBefore);
      const upgraded = (await legacy.query<Contract>('SELECT * FROM contracts ORDER BY display_id')).rows;
      expect(upgraded.map(c => [c.id, c.display_id, c.progress_percent])).toEqual([[firstId, 1, 100], [secondId, 2, 0]]);
      const inserted = (await legacy.query<Contract>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity)
        VALUES($1,'New task','task','2026-10-21','mild') RETURNING *`, [user.id])).rows[0]!;
      expect(inserted.display_id).toBe(3);
      expect(inserted.progress_percent).toBe(0);
      await migrate(legacy);
      expect((await legacy.query('SELECT id,display_id FROM contracts ORDER BY display_id')).rows).toEqual([
        { id: firstId, display_id: 1 }, { id: secondId, display_id: 2 }, { id: inserted.id, display_id: 3 },
      ]);
    } finally {
      await legacy.end();
      await admin!.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });

  it('backfills hourly schedules only for existing unfinished owners without rewriting commitments or queued replies', async () => {
    const legacySchema = `${schema}_hourly`;
    if (!/^dd_test_[a-f0-9]{32}_hourly$/.test(legacySchema)) throw new Error('Unsafe legacy test schema name');
    await admin!.query(`CREATE SCHEMA "${legacySchema}"`);
    const legacy = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${legacySchema}`,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    try {
      await legacy.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of ['001_initial.sql', '002_general_tasks.sql', '003_task_experience.sql']) {
        await legacy.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
        await legacy.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
      const owners = (await legacy.query<User>(`INSERT INTO users(imessage_handle,timezone,space_id) VALUES
        ('unfinished@example.test','Asia/Kolkata','unfinished-space'),
        ('finished@example.test','Asia/Kolkata','finished-space'),
        ('empty@example.test','Asia/Kolkata','empty-space') RETURNING *`)).rows;
      const unfinished = owners.find(owner => owner.imessage_handle === 'unfinished@example.test')!;
      const finished = owners.find(owner => owner.imessage_handle === 'finished@example.test')!;
      for (const state of ['pending', 'active', 'missed', 'completed', 'cancelled']) {
        await legacy.query(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state)
          VALUES($1,$2,'task','2026-10-20','mild',$3)`, [['completed', 'cancelled'].includes(state) ? finished.id : unfinished.id, `${state} legacy task`, state]);
      }
      await legacy.query("INSERT INTO outbox(user_id,space_id,event_key,message_text,kind) VALUES($1,'unfinished-space','legacy-reply','Preserve this reply','reply')", [unfinished.id]);
      const contractsBefore = (await legacy.query('SELECT * FROM contracts ORDER BY id')).rows;
      const outboxBefore = (await legacy.query('SELECT * FROM outbox ORDER BY id')).rows;
      const before = Date.now();
      await migrate(legacy);
      const after = Date.now();
      const upgraded = (await legacy.query<User & {hourly_summary_due_at: Date | null}>('SELECT * FROM users')).rows;
      const armed = upgraded.find(owner => owner.id === unfinished.id)!.hourly_summary_due_at!;
      expect(armed.getTime()).toBeGreaterThanOrEqual(before+HOUR);
      expect(armed.getTime()).toBeLessThanOrEqual(after+HOUR);
      expect(upgraded.filter(owner => owner.id !== unfinished.id).every(owner => owner.hourly_summary_due_at === null)).toBe(true);
      expect((await legacy.query('SELECT * FROM contracts ORDER BY id')).rows).toEqual(contractsBefore.map(row=>({...row,deleted_at:null})));
      expect((await legacy.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(outboxBefore.map(row=>({...row,referenced_contract_ids:null})));
      await migrate(legacy);
      expect((await legacy.query('SELECT hourly_summary_due_at FROM users WHERE id=$1', [unfinished.id])).rows[0]!.hourly_summary_due_at).toEqual(armed);
    } finally {
      await legacy.end();
      await admin!.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });

  it('backfills only future new alert checkpoints without changing tasks, history, or existing jobs', async () => {
    const legacySchema = `${schema}_alerts`;
    if (!/^dd_test_[a-f0-9]{32}_alerts$/.test(legacySchema)) throw new Error('Unsafe legacy test schema name');
    await admin!.query(`CREATE SCHEMA "${legacySchema}"`);
    const legacy = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${legacySchema}`,
      connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    try {
      await legacy.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of ['001_initial.sql', '002_general_tasks.sql', '003_task_experience.sql', '004_hourly_summaries.sql']) {
        await legacy.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
        await legacy.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
      const user = (await legacy.query<User>("INSERT INTO users(imessage_handle,timezone,space_id) VALUES('alerts@example.test','Asia/Kolkata','alerts-space') RETURNING *")).rows[0]!;
      const now = new Date();
      const taskIds = new Map<string, string>();
      for (const [title, state, dueMinutes, confirmedMinutes] of [
        ['Long active task', 'active', 300, -60],
        ['Soon active task', 'active', 60, -60],
        ['Near active task', 'active', 20, -60],
        ['Existing checkpoint', 'active', 300, -60],
        ['Unconfirmed active task', 'active', 300, null],
        ['Confirmed too late', 'active', 300, 290],
        ['Pending task', 'pending', 300, -60],
        ['Missed task', 'missed', 300, -60],
        ['Completed task', 'completed', 300, -60],
        ['Cancelled task', 'cancelled', 300, -60],
      ] as const) {
        const c = (await legacy.query<Contract>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity,state,confirmed_at)
          VALUES($1,$2,'task',$3,'mild',$4,$5) RETURNING *`,
        [user.id, title, new Date(now.getTime() + dueMinutes * MINUTE), state,
          confirmedMinutes === null ? null : new Date(now.getTime() + confirmedMinutes * MINUTE)])).rows[0]!;
        taskIds.set(title, c.id);
      }
      await legacy.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at,status,attempts,last_error)
        VALUES($1,'before_60',$3,'pending',0,NULL),($2,'before_30',$4,'done',2,'Preserve this checkpoint')`,
      [taskIds.get('Long active task'), taskIds.get('Existing checkpoint'),
        new Date(now.getTime() + 240 * MINUTE), new Date(now.getTime() + 270 * MINUTE)]);
      await legacy.query("INSERT INTO contract_events(contract_id,event_type,evidence) VALUES($1,'legacy_event','{\"preserved\":true}')", [taskIds.get('Long active task')]);
      await legacy.query("INSERT INTO outbox(user_id,space_id,event_key,message_text,kind) VALUES($1,'alerts-space','existing-alert-reply','Preserve this reply','reply')", [user.id]);
      const contractsBefore = (await legacy.query('SELECT * FROM contracts ORDER BY id')).rows;
      const usersBefore = (await legacy.query('SELECT * FROM users ORDER BY id')).rows;
      const eventsBefore = (await legacy.query('SELECT * FROM contract_events ORDER BY id')).rows;
      const outboxBefore = (await legacy.query('SELECT * FROM outbox ORDER BY id')).rows;
      const jobsBefore = (await legacy.query('SELECT * FROM scheduled_jobs ORDER BY id')).rows;

      await migrate(legacy);

      expect((await legacy.query('SELECT * FROM contracts ORDER BY id')).rows).toEqual(contractsBefore.map(row=>({...row,deleted_at:null})));
      expect((await legacy.query('SELECT * FROM users ORDER BY id')).rows).toEqual(usersBefore);
      expect((await legacy.query('SELECT * FROM contract_events ORDER BY id')).rows).toEqual(eventsBefore);
      expect((await legacy.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(outboxBefore.map(row=>({...row,referenced_contract_ids:null})));
      const jobs = (await legacy.query<{ id: string; contract_id: string; job_type: string; run_at: Date }>('SELECT * FROM scheduled_jobs ORDER BY id')).rows;
      expect(jobs.filter(job => jobsBefore.some(previous => previous.id === job.id))).toEqual(jobsBefore);
      const added = jobs.filter(job => !jobsBefore.some(previous => previous.id === job.id));
      expect(added).toHaveLength(4);
      for (const [title, expected] of [
        ['Long active task', ['before_120', 'before_30']],
        ['Soon active task', ['before_30']],
        ['Existing checkpoint', ['before_120']],
      ] as const) {
        expect(added.filter(job => job.contract_id === taskIds.get(title)).map(job => job.job_type).sort()).toEqual(expected);
      }
      for (const job of added) {
        const c = contractsBefore.find(contract => contract.id === job.contract_id)!;
        expect(job.run_at.getTime()).toBe(c.due_at.getTime() - Number(job.job_type.slice('before_'.length)) * MINUTE);
        expect(job.run_at.getTime()).toBeGreaterThan(Date.now());
        expect(job.run_at.getTime()).toBeGreaterThan(c.confirmed_at.getTime());
      }
      await migrate(legacy);
      expect((await legacy.query('SELECT * FROM scheduled_jobs ORDER BY id')).rows).toEqual(jobs);
    } finally {
      await legacy.end();
      await admin!.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });

  it('moves a draft deadline without renumbering or activating the task', async () => {
    const user=await newUser();const now=new Date();
    const draft=await userTransaction(user,db=>createTaskContract(db,user,'Finish the front end',new Date(now.getTime()+60*MINUTE),'savage'));
    const number=draft.display_id;const due=new Date(now.getTime()+120*MINUTE);
    await userTransaction(user,db=>reschedulePendingContract(db,draft,due,now));
    const saved=await loadContract(draft.id);
    expect(saved).toMatchObject({display_id:number,state:'pending',confirmed_at:null,due_at:due});
    expect((await pool!.query('SELECT count(*)::int AS total FROM scheduled_jobs')).rows[0].total).toBe(0);
    expect((await pool!.query("SELECT event_type FROM contract_events WHERE contract_id=$1 AND event_type='deadline_changed'",[draft.id])).rows).toHaveLength(1);
    await expect(userTransaction(user,db=>reschedulePendingContract(db,draft,new Date(now.getTime()-MINUTE),now))).rejects.toThrow(/future/);
    await userTransaction(user,db=>confirmContract(db,draft,now));
    await expect(userTransaction(user,db=>reschedulePendingContract(db,draft,due,now))).rejects.toThrow(/pending/);
  });

  it('creates pending commitments and confirms them with durable deduplicated jobs', async () => {
    const user = await newUser();
    const now = new Date();
    const c = await newContract(user, now);
    expect(c.state).toBe('pending');
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toHaveLength(0);
    await userTransaction(user, (db) => confirmContract(db, c, now));
    expect(c.state).toBe('active');
    expect(c.confirmed_at).toEqual(now);
    const saved = await loadContract(c.id);
    expect(saved.state).toBe('active');
    expect(saved.confirmed_at?.getTime()).toBe(now.getTime());
    const jobs = (await pool!.query<{ job_type: string }>('SELECT job_type FROM scheduled_jobs WHERE contract_id=$1', [c.id])).rows;
    expect(jobs.map((job) => job.job_type).sort()).toEqual(['before_15', 'before_30', 'before_60', 'deadline', 'followup', 'monitor']);
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1', [c.id])).rows).toHaveLength(2);
  });

  it('stores ordinary tasks without GitHub metadata and schedules reminders without a GitHub monitor', async () => {
    const user = await newUser();
    const now = new Date();
    const due = new Date(now.getTime() + 120 * MINUTE);
    const c = await userTransaction(user, db => createTaskContract(db, user, 'Finish the front end', due, 'savage'));
    expect(c.artifact_type).toBe('task');
    expect(c.artifact_url).toBeNull();
    expect(c.repo_owner).toBeNull();
    expect(c.repo_name).toBeNull();
    expect(c.artifact_number).toBeNull();
    await userTransaction(user, db => confirmContract(db, c, now));
    const jobs = (await pool!.query<{ job_type: string }>('SELECT job_type FROM scheduled_jobs WHERE contract_id=$1 ORDER BY job_type', [c.id])).rows;
    expect(jobs.map(job => job.job_type)).not.toContain('monitor');
    expect(jobs.map(job => job.job_type).sort()).toEqual(['before_15', 'before_30', 'before_60', 'deadline', 'followup']);
    const audit = (await pool!.query<{ event_type: string; evidence_url: string|null; evidence: {tracking:string} }>('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY observed_at', [c.id])).rows;
    expect(audit[0]).toMatchObject({ event_type: 'created', evidence_url: null, evidence: { tracking: 'owner_reported' } });
  });

  it('records task completion as self-reported and stops its remaining reminders', async () => {
    const user = await newUser();
    const now = new Date();
    const c = await userTransaction(user, db => createTaskContract(db, user, 'Submit the design', new Date(now.getTime()+120*MINUTE), 'mild'));
    await userTransaction(user, db => confirmContract(db, c, now));
    const active = await loadContract(c.id);
    await userTransaction(user, db => reportTaskComplete(db, active as Extract<Contract,{artifact_type:'task'}>, new Date(now.getTime()+MINUTE)));
    const saved = await loadContract(c.id);
    expect(saved.state).toBe('completed');
    expect(saved.progress_percent).toBe(100);
    expect(saved.completed_at).toEqual(new Date(now.getTime()+MINUTE));
    expect((await pool!.query<{ status:string }>('SELECT status FROM scheduled_jobs WHERE contract_id=$1', [c.id])).rows.every(job=>job.status==='done')).toBe(true);
    expect((await pool!.query<{event_type:string;evidence:{source:string;late:boolean}}>("SELECT event_type,evidence FROM contract_events WHERE contract_id=$1 ORDER BY observed_at",[c.id])).rows.at(-1)).toMatchObject({
      event_type: 'completed_self_reported', evidence: { source: 'owner_reported', late: false },
    });
  });

  it.each([-MINUTE, 0, MINUTE])('completes an ordinary draft due %d ms from the report without activation or touching other work', async (offset) => {
    const user = await newUser();
    const now = new Date();
    const due = new Date(now.getTime()+offset);
    const draft = await userTransaction(user, db => createTaskContract(db, user, 'Finish the front end', due, 'savage'));
    const other = await userTransaction(user, db => createTaskContract(db, user, 'Keep the video task', new Date(now.getTime()+HOUR), 'mild'));
    const untouched = await loadContract(other.id);
    const initialVersion = draft.version;
    await userTransaction(user, db => reportTaskComplete(db, draft, now));
    expect(await loadContract(draft.id)).toMatchObject({ state: 'completed', progress_percent: 100,
      completed_at: now, confirmed_at: null, missed_at: offset < 0 ? due : null, version: initialVersion+1 });
    expect(draft).toMatchObject({ state: 'completed', progress_percent: 100, confirmed_at: null });
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toHaveLength(0);
    expect((await pool!.query('SELECT event_type,evidence FROM contract_events WHERE contract_id=$1 ORDER BY observed_at,id', [draft.id])).rows).toEqual([
      { event_type: 'created', evidence: { tracking: 'owner_reported', dueAt: due.toISOString() } },
      { event_type: 'completed_self_reported', evidence: { source: 'owner_reported', reportedAt: now.toISOString(), late: offset < 0 } },
    ]);
    const saved = await loadContract(draft.id);
    await userTransaction(user, db => reportTaskComplete(db, draft, new Date(now.getTime()+MINUTE)));
    await userTransaction(user, db => reportTaskComplete(db, saved as TaskContract, new Date(now.getTime()+2*MINUTE)));
    expect(await loadContract(draft.id)).toEqual(saved);
    expect((await pool!.query("SELECT * FROM contract_events WHERE contract_id=$1 AND event_type='completed_self_reported'", [draft.id])).rows).toHaveLength(1);
    expect(await loadContract(other.id)).toEqual(untouched);
    expect(await summaryDue(user)).not.toBeNull();
  });

  it.each([-MINUTE, HOUR])('records draft progress and completes at 100 for a deadline %d ms away without scheduling or confirmation', async (offset) => {
    const user = await newUser();
    const now = new Date();
    const due = new Date(now.getTime()+offset);
    const draft = await userTransaction(user, db => createTaskContract(db, user, 'Edit the video', due, 'mild'));
    const version = draft.version;
    await userTransaction(user, db => reportTaskProgress(db, draft, 0, now));
    await userTransaction(user, db => reportTaskProgress(db, draft, 40, now));
    expect(await loadContract(draft.id)).toMatchObject({ state: 'pending', progress_percent: 40,
      confirmed_at: null, completed_at: null, missed_at: null, version: version+2 });
    expect((await pool!.query('SELECT evidence FROM contract_events WHERE contract_id=$1 AND event_type=$2 ORDER BY observed_at,id', [draft.id, 'progress_self_reported'])).rows).toEqual([
      { evidence: { source: 'owner_reported', previousPercent: 0, progressPercent: 0, reportedAt: now.toISOString() } },
      { evidence: { source: 'owner_reported', previousPercent: 0, progressPercent: 40, reportedAt: now.toISOString() } },
    ]);
    await userTransaction(user, db => reportTaskProgress(db, draft, 100, now));
    expect(await loadContract(draft.id)).toMatchObject({ state: 'completed', progress_percent: 100,
      confirmed_at: null, completed_at: now, missed_at: offset < 0 ? due : null, version: version+3 });
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toHaveLength(0);
    expect((await pool!.query("SELECT * FROM contract_events WHERE contract_id=$1 AND event_type='confirmed'", [draft.id])).rows).toHaveLength(0);
    expect((await pool!.query("SELECT evidence FROM contract_events WHERE contract_id=$1 AND event_type='completed_self_reported'", [draft.id])).rows).toEqual([
      { evidence: { source: 'owner_reported', reportedAt: now.toISOString(), late: offset < 0 } },
    ]);
    expect(await summaryDue(user)).toBeNull();
  });

  it('labels a past-due task unreported until the owner reports it, then records the report as late', async () => {
    const user = await newUser();
    const now = new Date();
    const c = await userTransaction(user, db => createTaskContract(db, user, 'Publish the page', new Date(now.getTime()-MINUTE), 'mild'));
    await userTransaction(user, db => confirmContract(db, c, new Date(now.getTime()-2*MINUTE)));
    const active = await loadContract(c.id);
    await userTransaction(user, db => observeTaskDeadline(db, active as Extract<Contract,{artifact_type:'task'}>, now));
    expect((await loadContract(c.id)).state).toBe('missed');
    const missed = await loadContract(c.id);
    await userTransaction(user, db => reportTaskComplete(db, missed as Extract<Contract,{artifact_type:'task'}>, new Date(now.getTime()+MINUTE)));
    expect((await loadContract(c.id)).state).toBe('completed');
    expect((await pool!.query<{event_type:string;evidence:{late:boolean}}>("SELECT event_type,evidence FROM contract_events WHERE contract_id=$1 ORDER BY observed_at",[c.id])).rows.at(-1)).toMatchObject({
      event_type: 'completed_self_reported', evidence: { late: true },
    });
  });

  it('persists self-reported task progress and completes only at 100 percent', async () => {
    const user = await newUser();
    const now = new Date();
    const task = await userTransaction(user, db => createTaskContract(db, user, 'Build the demo', new Date(now.getTime()+120*MINUTE), 'mild'));
    await userTransaction(user, db => confirmContract(db, task, now));
    const version = task.version;
    await userTransaction(user, db => reportTaskProgress(db, task, 40, now));
    expect(task).toMatchObject({ state: 'active', progress_percent: 40, version: version+1 });
    expect(await loadContract(task.id)).toMatchObject({ state: 'active', progress_percent: 40, version: task.version, completed_at: null });
    expect((await pool!.query('SELECT event_type,evidence FROM contract_events WHERE contract_id=$1 AND event_type=$2', [task.id, 'progress_self_reported'])).rows).toEqual([
      { event_type: 'progress_self_reported', evidence: { source: 'owner_reported', previousPercent: 0, progressPercent: 40, reportedAt: now.toISOString() } },
    ]);
    await userTransaction(user, db => reportTaskProgress(db, task, 0, now));
    expect((await loadContract(task.id)).progress_percent).toBe(0);
    const late = new Date(task.due_at.getTime()+MINUTE);
    await userTransaction(user, db => observeTaskDeadline(db, task, late));
    const missed = await loadContract(task.id) as TaskContract;
    await userTransaction(user, db => reportTaskProgress(db, missed, 75, late));
    expect(missed).toMatchObject({ state: 'missed', progress_percent: 75, missed_at: task.due_at });
    expect((await loadContract(task.id)).version).toBe(missed.version);
    await userTransaction(user, db => reportTaskProgress(db, missed, 100, late));
    expect(missed).toMatchObject({ state: 'completed', progress_percent: 100, completed_at: late });
    expect(await loadContract(task.id)).toMatchObject({ state: 'completed', progress_percent: 100, version: missed.version });
    expect((await pool!.query("SELECT * FROM scheduled_jobs WHERE contract_id=$1 AND status<>'done'", [task.id])).rows).toHaveLength(0);
    expect((await pool!.query('SELECT evidence FROM contract_events WHERE contract_id=$1 AND event_type=$2', [task.id, 'completed_self_reported'])).rows[0]?.evidence).toMatchObject({ source: 'owner_reported', late: true });
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 AND event_type=$2', [task.id, 'progress_self_reported'])).rows).toHaveLength(3);
  });

  it('rejects invalid progress and reports for completed or cancelled tasks without writes', async () => {
    const user = await newUser();
    const task = await userTransaction(user, db => createTaskContract(db, user, 'Draft the pitch', new Date(Date.now()+120*MINUTE), 'mild'));
    await userTransaction(user, db => confirmContract(db, task, new Date()));
    const version = task.version;
    for (const invalid of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(userTransaction(user, db => reportTaskProgress(db, task, invalid))).rejects.toThrow('whole number');
    }
    expect(await loadContract(task.id)).toMatchObject({ state: 'active', progress_percent: 0, version });
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1', [task.id])).rows).toHaveLength(2);
    await expect(pool!.query('UPDATE contracts SET progress_percent=-1 WHERE id=$1', [task.id])).rejects.toThrow();
    await expect(pool!.query('UPDATE contracts SET progress_percent=101 WHERE id=$1', [task.id])).rejects.toThrow();
    await userTransaction(user, db => reportTaskProgress(db, task, 100));
    const completedSnapshot = await loadContract(task.id);
    const completedEvents = (await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [task.id])).rows;
    await expect(userTransaction(user, db => reportTaskProgress(db, task, 90))).rejects.toThrow('pending, active or missed');
    await expect(userTransaction(user, db => reportTaskProgress(db, task, 100))).rejects.toThrow('pending, active or missed');
    expect(await loadContract(task.id)).toEqual(completedSnapshot);
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [task.id])).rows).toEqual(completedEvents);
    const cancelled = await userTransaction(user, db => createTaskContract(db, user, 'Discard the draft', new Date(Date.now()+120*MINUTE), 'mild'));
    await userTransaction(user, db => cancelContract(db, cancelled));
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.version).toBe((await loadContract(cancelled.id)).version);
    const cancelledSnapshot = await loadContract(cancelled.id);
    const cancelledEvents = (await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [cancelled.id])).rows;
    await expect(userTransaction(user, db => reportTaskProgress(db, cancelled, 100))).rejects.toThrow('pending, active or missed');
    await expect(userTransaction(user, db => reportTaskComplete(db, cancelled))).rejects.toThrow('cancelled -> completed');
    expect(await loadContract(cancelled.id)).toEqual(cancelledSnapshot);
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [cancelled.id])).rows).toEqual(cancelledEvents);
  });

  it.each(['pending', 'active', 'completed'] as const)('rejects runtime GitHub self-report attempts in %s state without altering proof or audit history', async (state) => {
    const user = await newUser();
    const github = await newContract(user);
    if (state === 'active') await userTransaction(user, db => confirmContract(db, github, new Date()));
    if (state === 'completed') await pool!.query("UPDATE contracts SET state='completed',completed_at=now() WHERE id=$1", [github.id]);
    const saved = await loadContract(github.id);
    const events = (await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [github.id])).rows;
    const jobs = (await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1 ORDER BY id', [github.id])).rows;
    const incorrectlyTyped = saved as unknown as TaskContract;
    await expect(userTransaction(user, db => reportTaskComplete(db, incorrectlyTyped))).rejects.toThrow('ordinary tasks');
    await expect(userTransaction(user, db => reportTaskProgress(db, incorrectlyTyped, 40))).rejects.toThrow('ordinary task');
    await expect(userTransaction(user, db => reportTaskProgress(db, incorrectlyTyped, 100))).rejects.toThrow('ordinary task');
    expect(await loadContract(github.id)).toEqual(saved);
    expect((await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [github.id])).rows).toEqual(events);
    expect((await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1 ORDER BY id', [github.id])).rows).toEqual(jobs);
  });

  it('changes the owner preference and current contracts without rewriting finished work or other owners', async () => {
    const user = await newUser();
    const other = await newUser();
    const states = ['pending', 'active', 'missed', 'completed', 'cancelled'] as const;
    const tasks: TaskContract[] = [];
    for (const state of states) {
      const c = await userTransaction(user, db => createTaskContract(db, user, `${state} task`, new Date(Date.now()+120*MINUTE), 'savage'));
      await pool!.query('UPDATE contracts SET state=$2 WHERE id=$1', [c.id, state]);
      tasks.push(await loadContract(c.id) as TaskContract);
    }
    const otherTask = await userTransaction(other, db => createTaskContract(db, other, 'Other owner task', new Date(Date.now()+120*MINUTE), 'mild'));
    await userTransaction(user, db => setIntensity(db, user, 'nuclear'));
    expect(user.intensity).toBe('nuclear');
    expect((await pool!.query('SELECT intensity FROM users WHERE id=$1', [user.id])).rows[0]?.intensity).toBe('nuclear');
    for (const c of tasks) {
      const current = ['pending', 'active', 'missed'].includes(c.state);
      expect(await loadContract(c.id)).toMatchObject({ intensity: current ? 'nuclear' : 'savage', version: c.version+(current ? 1 : 0) });
      const audit = (await pool!.query('SELECT evidence FROM contract_events WHERE contract_id=$1 AND event_type=$2', [c.id, 'intensity_changed'])).rows;
      expect(audit).toEqual(current ? [{ evidence: { from: 'savage', to: 'nuclear' } }] : []);
    }
    expect(await loadContract(otherTask.id)).toMatchObject({ intensity: 'mild', version: otherTask.version });
    const future = await userTransaction(user, db => createTaskContract(db, user, 'Future task', new Date(Date.now()+120*MINUTE), user.intensity));
    expect(future.intensity).toBe('nuclear');
    await userTransaction(user, db => setIntensity(db, user, 'nuclear'));
    expect((await pool!.query("SELECT * FROM contract_events WHERE event_type='intensity_changed'")).rows).toHaveLength(3);
  });

  it('keeps numeric references across cancellation and clears a deleted selected contract', async () => {
    const user = await newUser();
    const first = await userTransaction(user, db => createTaskContract(db, user, 'First task', new Date(Date.now()+120*MINUTE), 'mild'));
    const second = await newContract(user);
    expect(Number.isInteger(first.display_id)).toBe(true);
    expect(first.display_id).toBeGreaterThan(0);
    expect(second.display_id).toBeGreaterThan(first.display_id);
    expect(user.selected_contract_id).toBeNull();
    await pool!.query('UPDATE users SET selected_contract_id=$2 WHERE id=$1', [user.id, first.id]);
    await userTransaction(user, db => cancelContract(db, first));
    expect((await loadContract(first.id)).display_id).toBe(first.display_id);
    const third = await userTransaction(user, db => createTaskContract(db, user, 'Third task', new Date(Date.now()+120*MINUTE), 'mild'));
    expect(third.display_id).toBeGreaterThan(second.display_id);
    await pool!.query('DELETE FROM contracts WHERE id=$1', [first.id]);
    expect((await pool!.query('SELECT selected_contract_id FROM users WHERE id=$1', [user.id])).rows[0]?.selected_contract_id).toBeNull();
    await expect(pool!.query('UPDATE users SET selected_contract_id=$2 WHERE id=$1', [user.id, randomUUID()])).rejects.toThrow();
    expect((await loadContract(second.id)).display_id).toBe(second.display_id);
    expect((await loadContract(third.id)).display_id).toBe(third.display_id);
  });

  it('keeps the migrated GitHub-only target constraint and rejects incomplete or mixed artifact shapes', async () => {
    const user = await newUser();
    const github = await newContract(user) as GitHubContract;
    expect(github.artifact_type).toBe('pull_request');
    const task = await userTransaction(user, db => createTaskContract(db, user, 'Finish the report', new Date(Date.now()+MINUTE), 'mild'));
    await expect(pool!.query("UPDATE contracts SET artifact_url='https://github.com/acme/app/pull/99' WHERE id=$1", [task.id])).rejects.toThrow();
  });

  it('preserves commitments and reminder jobs across pool restart', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    await pool!.end();
    pool = scopedPool();
    expect((await loadContract(c.id)).state).toBe('active');
    expect((await loadContract(c.id)).display_id).toBe(c.display_id);
    expect((await pool.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1', [c.id])).rows).toHaveLength(6);
  });

  it('refreshes observation timestamps without invalidating replies until artifact facts change', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    const active = await loadContract(c.id) as GitHubContract;
    const refreshed = { ...active.last_observed_state!, observedAt: new Date(Date.now() + 1000).toISOString() };
    await userTransaction(user, (db) => observe(db, active, refreshed));
    const sameFacts = await loadContract(c.id);
    expect(sameFacts.version).toBe(active.version);
    expect(sameFacts.last_checked_at?.toISOString()).toBe(refreshed.observedAt);
    const changed = { ...refreshed, observedAt: new Date(Date.now() + 2000).toISOString(),
      checks: [{ name: 'tests', status: 'completed', conclusion: 'failure', url: null }] };
    await userTransaction(user, (db) => observe(db, sameFacts, changed));
    expect((await loadContract(c.id)).version).toBe(active.version + 1);
  });

  it('accepts on-time merge proof even when observation happens after the deadline', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    const active = await loadContract(c.id);
    const mergedAt = new Date(active.due_at.getTime() - MINUTE).toISOString();
    const e = evidence({ state: 'closed', mergedAt, closedAt: mergedAt });
    const result = await userTransaction(user, (db) => observe(db, active, e, new Date(active.due_at.getTime() + MINUTE)));
    expect(result).toEqual({ completed: true, newlyCompleted: true, missed: false });
    const saved = await loadContract(c.id);
    expect(saved.completed_at?.toISOString()).toBe(mergedAt);
    expect(saved.missed_at).toBeNull();
    expect((await pool!.query("SELECT * FROM scheduled_jobs WHERE contract_id=$1 AND status<>'done'", [c.id])).rows).toHaveLength(0);
  });

  it('marks an unmerged deadline missed and subsequently records a late verified merge', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    const active = await loadContract(c.id);
    const first = await userTransaction(user, (db) => observe(db, active, evidence({ state: 'closed', closedAt: active.due_at.toISOString() }), new Date(active.due_at.getTime() + MINUTE)));
    expect(first).toEqual({ completed: false, newlyCompleted: false, missed: true });
    expect((await loadContract(c.id)).state).toBe('missed');
    const late = new Date(active.due_at.getTime() + 10 * MINUTE).toISOString();
    const second = await userTransaction(user, (db) => observe(db, active, evidence({ state: 'closed', mergedAt: late, closedAt: late }), new Date(active.due_at.getTime() + 11 * MINUTE)));
    expect(second).toEqual({ completed: true, newlyCompleted: true, missed: true });
    expect((await loadContract(c.id)).missed_at?.getTime()).toBe(active.due_at.getTime());
    const replay = await userTransaction(user, (db) => observe(db, active, evidence({ state: 'closed', mergedAt: late }), new Date()));
    expect(replay.newlyCompleted).toBe(false);
  });

  it('cancels a contract and suppresses queued reminders and verdicts', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, async (db) => {
      await confirmContract(db, c, new Date());
      await queueMessage(db, { userId: user.id, spaceId: 'test-space', text: 'Reminder', key: 'reminder-key', contractId: c.id, kind: 'reminder' });
      await queueMessage(db, { userId: user.id, spaceId: 'test-space', text: 'Verdict', key: 'verdict-key', contractId: c.id, kind: 'verdict' });
    });
    await userTransaction(user, async (db) => cancelContract(db, (await db.query<Contract>('SELECT * FROM contracts WHERE id=$1 FOR UPDATE', [c.id])).rows[0]!));
    expect((await loadContract(c.id)).state).toBe('cancelled');
    expect((await loadContract(c.id)).display_id).toBe(c.display_id);
    expect((await pool!.query("SELECT * FROM scheduled_jobs WHERE contract_id=$1 AND status<>'done'", [c.id])).rows).toHaveLength(0);
    expect((await pool!.query("SELECT * FROM outbox WHERE contract_id=$1 AND status='suppressed'", [c.id])).rows).toHaveLength(2);
  });

  it('rejects creation of an already merged artifact without writing a contract', async () => {
    const user = await newUser();
    const e = evidence({ mergedAt: new Date().toISOString(), state: 'closed' });
    await expect(userTransaction(user, (db) => createContract(db, user, e.artifact, 'Already done', new Date(Date.now() + MINUTE), 'savage', e))).rejects.toThrow('already complete');
    expect((await pool!.query('SELECT * FROM contracts')).rows).toHaveLength(0);
  });

  it('deduplicates inbound provider IDs and outbound event keys durably', async () => {
    const user = await newUser();
    const message = { providerMessageId: 'provider-1', senderHandle: user.imessage_handle, spaceId: 'test-space', text: 'STATUS', receivedAt: new Date() };
    const inserted = await Promise.all([
      persistInbound(pool!, user.imessage_handle, user.id, message),
      persistInbound(pool!, user.imessage_handle, user.id, message),
    ]);
    expect(inserted.sort()).toEqual([false, true]);
    await userTransaction(user, async (db) => {
      const message = { userId: user.id, spaceId: 'test-space', text: 'Reply', key: 'inbound:provider-1' };
      await queueMessage(db, message);
      await queueMessage(db, message);
    });
    expect((await pool!.query('SELECT * FROM inbound_messages')).rows).toHaveLength(1);
    expect((await pool!.query('SELECT * FROM outbox')).rows).toHaveLength(1);
  });

  it('rolls back state and audit events together when a transaction fails', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await expect(userTransaction(user, async (db) => {
      await confirmContract(db, c, new Date());
      throw new Error('Simulated process failure before commit');
    })).rejects.toThrow('Simulated process failure');
    expect((await loadContract(c.id)).state).toBe('pending');
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toHaveLength(0);
    expect((await pool!.query('SELECT * FROM contract_events')).rows).toHaveLength(1);
  });

  it('rejects unrelated artifact proof before creating or completing a contract', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    const active = await loadContract(c.id) as GitHubContract;
    const unrelated = evidence({ mergedAt: new Date().toISOString(), state: 'closed' });
    unrelated.artifact = { ...unrelated.artifact, artifact_number: 8, artifact_url: 'https://github.com/acme/app/pull/8' };
    await expect(userTransaction(user, (db) => observe(db, active, unrelated))).rejects.toThrow('does not match');
    await expect(userTransaction(user, (db) => createContract(db, user, active, 'Wrong proof', new Date(Date.now() + MINUTE), 'savage', unrelated))).rejects.toThrow('does not match');
    expect((await loadContract(c.id)).state).toBe('active');
    expect((await pool!.query('SELECT * FROM contracts')).rows).toHaveLength(1);
  });

  it('corrects a missed classification when later proof establishes an on-time merge', async () => {
    const user = await newUser();
    const c = await newContract(user);
    await userTransaction(user, (db) => confirmContract(db, c, new Date()));
    const active = await loadContract(c.id);
    const afterDeadline = new Date(active.due_at.getTime() + MINUTE);
    await userTransaction(user, (db) => observe(db, active, evidence(), afterDeadline));
    const onTime = new Date(active.due_at.getTime() - MINUTE).toISOString();
    const result = await userTransaction(user, (db) => observe(db, active, evidence({ mergedAt: onTime, state: 'closed' }), afterDeadline));
    expect(result).toEqual({ completed: true, newlyCompleted: true, missed: false });
    expect((await loadContract(c.id)).missed_at).toBeNull();
  });

  it('rejects unauthorized inbound senders before persisting messages', async () => {
    const user = await newUser();
    const accepted = await persistInbound(pool!, user.imessage_handle, user.id, {
      providerMessageId: 'intruder-1', senderHandle: 'intruder@example.test', spaceId: 'untrusted-space', text: 'CONFIRM', receivedAt: new Date(),
    });
    expect(accepted).toBe(false);
    expect((await pool!.query('SELECT * FROM inbound_messages')).rows).toHaveLength(0);
    expect((await pool!.query('SELECT space_id FROM users WHERE id=$1', [user.id])).rows[0]?.space_id).toBe('test-space');
  });

  it.each(['inbound_messages', 'scheduled_jobs', 'outbox'] as const)('claims distinct %s rows concurrently using SKIP LOCKED', async (table) => {
    const user = await newUser();
    if (table === 'inbound_messages') {
      for (const id of ['concurrent-1', 'concurrent-2']) await persistInbound(pool!, user.imessage_handle, user.id, {
        providerMessageId: id, senderHandle: user.imessage_handle, spaceId: 'test-space', text: 'STATUS', receivedAt: new Date(),
      });
    } else if (table === 'scheduled_jobs') {
      const c = await newContract(user);
      await pool!.query("INSERT INTO scheduled_jobs(contract_id,job_type,run_at) VALUES($1,'deadline',now()),($1,'followup',now())", [c.id]);
    } else {
      await userTransaction(user, async (db) => {
        for (const key of ['claim-1', 'claim-2']) await queueMessage(db, { userId: user.id, spaceId: 'test-space', text: 'Reply', key });
      });
    }
    const first = await pool!.connect();
    const second = await pool!.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await second.query("SET LOCAL lock_timeout='500ms'");
      const a = await claim(first, table);
      // First claim remains uncommitted and locked while the second claim must succeed.
      const b = await claim(second, table);
      expect(a?.id).toBeTruthy();
      expect(b?.id).toBeTruthy();
      expect(a?.id).not.toBe(b?.id);
      expect(a?.attempts).toBe(1);
      expect(b?.attempts).toBe(1);
      expect(a?.locked_until).toBeInstanceOf(Date);
      await first.query('COMMIT');
      await second.query('COMMIT');
      expect((await pool!.query(`SELECT * FROM ${table} WHERE status='processing'`)).rows).toHaveLength(2);
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  });

  it.each(['ordinary', 'GitHub'] as const)('arms the first %s draft summary one hour out without postponing it for additional tasks', async (kind) => {
    const user = await newUser();
    expect(await summaryDue(user)).toBeNull();
    const before = Date.now();
    if (kind === 'ordinary') {
      await userTransaction(user, db => createTaskContract(db, user, 'First ordinary task', new Date(Date.now()+2*HOUR), 'mild'));
    } else await newContract(user);
    const after = Date.now();
    const firstDue = (await summaryDue(user))!;
    expect(firstDue.getTime()).toBeGreaterThanOrEqual(before+HOUR);
    expect(firstDue.getTime()).toBeLessThanOrEqual(after+HOUR);
    await userTransaction(user, db => createTaskContract(db, user, 'Additional draft', new Date(Date.now()+3*HOUR), 'mild'));
    await userTransaction(user, db => ensureHourlySummary(db, user.id, new Date(firstDue.getTime()+HOUR)));
    expect(await summaryDue(user)).toEqual(firstDue);
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toHaveLength(0);
    expect((await pool!.query('SELECT * FROM outbox')).rows).toHaveLength(0);
  });

  it('includes every unfinished task beyond the board limit and excludes other owners and finished work', async () => {
    const user = await newUser();
    const other = await newUser();
    const expected: string[] = [];
    for (let i = 0; i < 31; i++) {
      const task = await userTransaction(user, db => createTaskContract(db, user, `Unfinished task ${i}`, new Date(Date.now()+2*HOUR), 'mild'));
      await pool!.query('UPDATE contracts SET state=$2 WHERE id=$1', [task.id, ['pending', 'active', 'missed'][i%3]]);
      expected.push(task.id);
    }
    for (const state of ['completed', 'cancelled'] as const) {
      const task = await userTransaction(user, db => createTaskContract(db, user, `${state} task`, new Date(Date.now()+2*HOUR), 'mild'));
      await pool!.query('UPDATE contracts SET state=$2 WHERE id=$1', [task.id, state]);
    }
    await newContract(other);
    const unfinished = await userTransaction(user, db => unfinishedForSummary(db, user.id));
    expect(unfinished.map(c => c.id).sort()).toEqual(expected.sort());
    expect(new Set(unfinished.map(c => c.state))).toEqual(new Set(['pending', 'active', 'missed']));
  });

  it('queues one hourly slot under concurrent schedulers and preserves the next slot across pool restart', async () => {
    const user = await newUser();
    await userTransaction(user, db => createTaskContract(db, user, 'Concurrent summary task', new Date(Date.now()+3*HOUR), 'mild'));
    const now = new Date();
    const storedDue = new Date(now.getTime()-MINUTE);
    await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, storedDue]);
    await Promise.all([queueDueSummary(pool!, now), queueDueSummary(pool!, now), queueDueSummary(pool!, now)]);
    const rows = (await pool!.query<OutboxRow>("SELECT * FROM outbox WHERE kind='summary'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.id, contract_id: null, contract_version: null,
      event_key: `hourly:${user.id}:${storedDue.toISOString()}` });
    const nextDue = new Date(now.getTime()+HOUR);
    expect(await summaryDue(user)).toEqual(nextDue);
    await pool!.end();
    pool = scopedPool();
    expect(await summaryDue(user)).toEqual(nextDue);
    await queueDueSummary(pool!, new Date(nextDue.getTime()-1));
    expect((await pool!.query("SELECT * FROM outbox WHERE kind='summary'")).rows).toHaveLength(1);
    await queueDueSummary(pool!, nextDue);
    expect((await pool!.query("SELECT event_key FROM outbox WHERE kind='summary' ORDER BY event_key")).rows.map(r => r.event_key).sort()).toEqual([
      `hourly:${user.id}:${storedDue.toISOString()}`, `hourly:${user.id}:${nextDue.toISOString()}`,
    ].sort());
    expect(await summaryDue(user)).toEqual(new Date(nextDue.getTime()+HOUR));
  });

  it('skips missed hourly slots after downtime instead of queuing a backlog', async () => {
    const user = await newUser();
    await userTransaction(user, db => createTaskContract(db, user, 'Recovered task', new Date(Date.now()+HOUR), 'mild'));
    const now = new Date();
    await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, new Date(now.getTime()-4*HOUR)]);
    await queueDueSummary(pool!, now);
    await queueDueSummary(pool!, now);
    expect((await pool!.query("SELECT * FROM outbox WHERE kind='summary'")).rows).toHaveLength(1);
    expect(await summaryDue(user)).toEqual(new Date(now.getTime()+HOUR));
  });

  it.each(['paused', 'missing space', 'empty'] as const)('does not queue hourly summaries for an owner who is %s', async (reason) => {
    const user = await newUser();
    const task = await userTransaction(user, db => createTaskContract(db, user, 'Suppressed summary task', new Date(Date.now()+HOUR), 'mild'));
    const now = new Date();
    await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, new Date(now.getTime()-MINUTE)]);
    if (reason === 'paused') await pool!.query('UPDATE users SET paused=true WHERE id=$1', [user.id]);
    if (reason === 'missing space') await pool!.query('UPDATE users SET space_id=NULL WHERE id=$1', [user.id]);
    if (reason === 'empty') await userTransaction(user, db => cancelContract(db, task));
    await queueDueSummary(pool!, now);
    expect((await pool!.query("SELECT * FROM outbox WHERE kind='summary'")).rows).toHaveLength(0);
    expect(await summaryDue(user)).toEqual(reason === 'empty' ? null : new Date(now.getTime()+HOUR));
  });

  it('refreshes queued hourly progress and task membership at delivery without requesting AI or GitHub', async () => {
    const user = await newUser();
    const keep = await userTransaction(user, db => createTaskContract(db, user, 'Keep this task', new Date(Date.now()+2*HOUR), 'mild'));
    const finish = await userTransaction(user, db => createTaskContract(db, user, 'Finished after queuing', new Date(Date.now()+2*HOUR), 'mild'));
    const cancel = await userTransaction(user, db => createTaskContract(db, user, 'Cancelled after queuing', new Date(Date.now()+2*HOUR), 'mild'));
    const queued = await queueSummaryNow(user);
    await userTransaction(user, async db => {
      await confirmContract(db, keep, new Date());
      await reportTaskProgress(db, keep, 60);
      await confirmContract(db, finish, new Date());
      await reportTaskComplete(db, finish);
      await cancelContract(db, cancel);
    });
    const githubTask = await newContract(user);
    const offline = offlineDelivery();
    await userTransaction(user, db => deliverOutbox(db, queued, offline.github, offline.ai, offline.transport));
    const delivered = offline.send.mock.calls.map(([, text]) => text).join('\n');
    expect(delivered).toContain('Keep this task');
    expect(delivered).toContain('60%');
    expect(delivered).toContain('▰▰▰▰▰▰▱▱▱▱');
    expect(delivered).toContain(githubTask.title);
    expect(delivered).not.toContain('Finished after queuing');
    expect(delivered).not.toContain('Cancelled after queuing');
    expect(offline.send).toHaveBeenCalled();
    expect(offline.inspect).not.toHaveBeenCalled();
    expect(offline.generate).not.toHaveBeenCalled();
    expect(offline.parse).not.toHaveBeenCalled();
    expect((await pool!.query('SELECT status,message_text FROM outbox WHERE id=$1', [queued.id])).rows[0]).toMatchObject({ status: 'sent', message_text: expect.stringContaining('60%') });
    expect((await pool!.query('SELECT * FROM conversation_messages')).rows).toHaveLength(0);
  });

  it.each(['complete draft', 'complete active', 'cancel'] as const)('clears the hourly schedule and queued summary only when the last task is %s', async (action) => {
    const user = await newUser();
    const first = await userTransaction(user, db => createTaskContract(db, user, 'First cleanup task', new Date(Date.now()+2*HOUR), 'mild'));
    const last = await userTransaction(user, db => createTaskContract(db, user, 'Last cleanup task', new Date(Date.now()+2*HOUR), 'mild'));
    const queued = await queueSummaryNow(user);
    const due = await summaryDue(user);
    await userTransaction(user, db => cancelContract(db, first));
    expect(await summaryDue(user)).toEqual(due);
    expect((await pool!.query('SELECT status FROM outbox WHERE id=$1', [queued.id])).rows[0]?.status).toBe('pending');
    await userTransaction(user, async db => {
      if (action.startsWith('complete')) {
        if (action === 'complete active') await confirmContract(db, last, new Date());
        await reportTaskComplete(db, last);
      } else await cancelContract(db, last);
    });
    expect(await summaryDue(user)).toBeNull();
    expect((await pool!.query('SELECT status FROM outbox WHERE id=$1', [queued.id])).rows[0]?.status).toBe('suppressed');
    const before = Date.now();
    await userTransaction(user, db => createTaskContract(db, user, 'New task restarts clock', new Date(Date.now()+2*HOUR), 'mild'));
    expect((await summaryDue(user))!.getTime()).toBeGreaterThanOrEqual(before+HOUR);
    expect((await pool!.query("SELECT * FROM outbox WHERE kind='summary' AND status='pending'")).rows).toHaveLength(0);
  });

  it.each(['paused', 'empty', 'expired', 'wrong space', 'missing space'] as const)('suppresses an hourly summary which becomes %s before delivery', async (reason) => {
    const user = await newUser();
    const task = await userTransaction(user, db => createTaskContract(db, user, 'Guarded summary task', new Date(Date.now()+2*HOUR), 'mild'));
    const queued = await queueSummaryNow(user);
    if (reason === 'paused') await pool!.query('UPDATE users SET paused=true WHERE id=$1', [user.id]);
    if (reason === 'empty') await userTransaction(user, db => cancelContract(db, task));
    if (reason === 'expired') {
      // Retry run_at changes must not extend the original summary's lifetime.
      await pool!.query("UPDATE outbox SET created_at=now()-interval '61 minutes',run_at=now()+interval '1 minute' WHERE id=$1", [queued.id]);
    }
    if (reason === 'wrong space') await pool!.query("UPDATE users SET space_id='replacement-space' WHERE id=$1", [user.id]);
    if (reason === 'missing space') await pool!.query('UPDATE users SET space_id=NULL WHERE id=$1', [user.id]);
    const fresh = (await pool!.query<OutboxRow>('SELECT * FROM outbox WHERE id=$1', [queued.id])).rows[0]!;
    const offline = offlineDelivery();
    await userTransaction(user, db => deliverOutbox(db, fresh, offline.github, offline.ai, offline.transport));
    expect((await pool!.query('SELECT status FROM outbox WHERE id=$1', [queued.id])).rows[0]?.status).toBe('suppressed');
    expect(offline.send).not.toHaveBeenCalled();
    expect(offline.inspect).not.toHaveBeenCalled();
    expect(offline.generate).not.toHaveBeenCalled();
    expect(offline.parse).not.toHaveBeenCalled();
  });

  it('recovers expired leases while leaving future jobs and live leases untouched', async () => {
    const user = await newUser();
    await userTransaction(user, async (db) => {
      for (const key of ['expired', 'future']) await queueMessage(db, { userId: user.id, spaceId: 'test-space', text: 'Reply', key });
    });
    await pool!.query("UPDATE outbox SET status='processing',attempts=1,locked_until=now()-interval '1 minute' WHERE event_key='expired'");
    await pool!.query("UPDATE outbox SET run_at=now()+interval '1 hour' WHERE event_key='future'");
    const recovered = await transaction(pool!, (db) => claim(db, 'outbox'));
    expect(recovered?.event_key).toBe('expired');
    expect(recovered?.attempts).toBe(2);
    expect(await transaction(pool!, (db) => claim(db, 'outbox'))).toBeUndefined();
  });
});
