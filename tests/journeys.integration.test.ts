import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/agent/orchestrator.js';
import { cancelContract, confirmContract, createTaskContract, reportTaskComplete, reportTaskProgress } from '../src/contracts/service.js';
import { migrate } from '../src/db/migrate.js';
import { lockUser, transaction } from '../src/db/pool.js';
import { getUser } from '../src/db/queries.js';
import { deliverOutbox, type OutboxRow } from '../src/scheduler/outbox.js';
import { queueDueSummary } from '../src/scheduler/summaries.js';
import type { Agent, Contract, GitHubReader, TaskContract, Transport, User } from '../src/types.js';

// Deliberately never loads .env or falls back to the live DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `dd_journey_${randomUUID().replaceAll('-', '')}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe.skipIf(!databaseUrl)('real PostgreSQL owner command journeys', () => {
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let schemaCreated = false;
  const parse = vi.fn(async () => { throw new Error('A task command must not call OpenAI parsing'); });
  const generate = vi.fn(async () => { throw new Error('A task command must not call OpenAI generation'); });
  const inspect = vi.fn(async () => { throw new Error('Ordinary tasks must not request GitHub'); });
  const ai: Agent = { parse, generate };
  const github: GitHubReader = { inspect };
  const router = new Orchestrator(ai, github, []);

  async function newUser(): Promise<User> {
    return (await pool!.query<User>(`INSERT INTO users(imessage_handle,timezone,space_id)
      VALUES($1,'Asia/Kolkata',$2) RETURNING *`, [`${randomUUID()}@example.test`, `space-${randomUUID()}`])).rows[0]!;
  }

  async function ownerTransaction<T>(user: User, work: (db: PoolClient) => Promise<T>): Promise<T> {
    return transaction(pool!, async db => {
      await lockUser(db, user.id);
      await db.query('SELECT id FROM contracts WHERE user_id=$1 FOR UPDATE', [user.id]);
      return work(db);
    });
  }

  async function task(user: User, title: string, due: Date): Promise<TaskContract> {
    return ownerTransaction(user, db => createTaskContract(db, user, title, due, 'savage'));
  }

  async function load(id: string): Promise<Contract> {
    return (await pool!.query<Contract>('SELECT * FROM contracts WHERE id=$1', [id])).rows[0]!;
  }

  async function command(user: User, text: string): Promise<OutboxRow> {
    const id = randomUUID();
    await ownerTransaction(user, async db => {
      const fresh = await getUser(db, user.id);
      await router.handle(db, fresh, text, fresh.space_id!, id);
    });
    const reply = (await pool!.query<OutboxRow>('SELECT * FROM outbox WHERE event_key=$1', [`inbound:${id}`])).rows[0];
    expect(reply, `The command ${text} must produce a reply`).toBeDefined();
    return reply!;
  }

  async function audit(id: string) {
    return (await pool!.query('SELECT * FROM contract_events WHERE contract_id=$1 ORDER BY id', [id])).rows;
  }

  async function jobs(id: string) {
    return (await pool!.query('SELECT * FROM scheduled_jobs WHERE contract_id=$1 ORDER BY id', [id])).rows;
  }

  beforeAll(async () => {
    if (!/^dd_journey_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe journey test schema');
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000, options: `-c search_path=${schema}`, application_name: 'deadline-demon-journey-tests' });
    await migrate(pool);
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool!.query('TRUNCATE users RESTART IDENTITY CASCADE');
  });

  afterEach(() => {
    expect(parse).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    try {
      await pool?.end();
      if (schemaCreated && /^dd_journey_[a-f0-9]{32}$/.test(schema)) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await admin?.end(); }
  }, 30_000);

  it('replays SELECT 1 → DONE 1 → DONE 1 → STATUS 1 → LIST without redirecting work or leaving a stale hourly task', async () => {
    const user = await newUser();
    const now = new Date();
    const front = await task(user, 'Finish the front end', new Date(now.getTime()-HOUR));
    const filler = await task(user, 'Discarded earlier draft', new Date(now.getTime()+HOUR));
    await ownerTransaction(user, db => cancelContract(db, filler));
    const video = await task(user, 'Finish the launch video', new Date(now.getTime()+6*HOUR));
    expect([front.display_id, video.display_id]).toEqual([1, 3]);
    await ownerTransaction(user, async db => {
      await confirmContract(db, video, now);
      await reportTaskProgress(db, video, 27, now);
    });
    const videoBefore = await load(video.id);
    const videoAudit = await audit(video.id);
    const videoJobs = await jobs(video.id);
    await pool!.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1', [user.id, new Date(now.getTime()-MINUTE)]);
    await queueDueSummary(pool!, now);
    const summary = (await pool!.query<OutboxRow>("SELECT * FROM outbox WHERE user_id=$1 AND kind='summary'", [user.id])).rows[0]!;
    expect(summary.message_text).toContain(front.title);

    expect((await command(user, 'Select 1')).message_text).toContain('Selected #1');
    const completion = await command(user, 'Done 1');
    expect(completion.message_text).toContain('Completion recorded · #1');
    expect(completion.message_text).toContain('100%');
    const completed = await load(front.id);
    expect(completed).toMatchObject({ state: 'completed', progress_percent: 100, confirmed_at: null, missed_at: front.due_at });
    expect(completed.completed_at).toBeInstanceOf(Date);
    expect(await jobs(front.id)).toEqual([]);
    expect((await audit(front.id)).map(row => row.event_type).sort()).toEqual(['completed_self_reported', 'created']);
    expect((await command(user, 'Done 1')).message_text).toContain('Already completed · #1');
    expect((await command(user, 'Status 1')).message_text).toContain('COMPLETED LATE');
    const board = (await command(user, 'List')).message_text;
    expect(board).toContain('Finish the launch video');
    expect(board).toContain('27%');
    expect(board).toContain('Recent history');
    expect(board).toContain('Finish the front end');
    // A terminal selected task remains the target of a bare command.
    expect((await command(user, 'Done')).message_text).toContain('Already completed · #1');
    expect(await load(front.id)).toEqual(completed);
    expect((await audit(front.id)).filter(row => row.event_type === 'completed_self_reported')).toHaveLength(1);
    expect(await load(video.id)).toEqual(videoBefore);
    expect(await audit(video.id)).toEqual(videoAudit);
    expect(await jobs(video.id)).toEqual(videoJobs);

    const send = vi.fn(async (_space: string, _text: string) => {});
    const transport: Transport = { send, stop: vi.fn(async () => {}), responding: async (_space, work) => work() };
    await ownerTransaction(user, db => deliverOutbox(db, summary, github, ai, transport));
    expect(send).toHaveBeenCalledOnce();
    const delivered = send.mock.calls[0]![1];
    expect(delivered).toContain(video.title);
    expect(delivered).toContain('27%');
    expect(delivered).not.toContain(front.title);
    expect((await pool!.query('SELECT status,message_text FROM outbox WHERE id=$1', [summary.id])).rows[0]).toMatchObject({
      status: 'sent', message_text: delivered,
    });
  });

  it.each([-HOUR, 6*HOUR])('accepts draft progress at a deadline %d ms away and completes it without confirmation', async offset => {
    const user = await newUser();
    const draft = await task(user, 'Work in progress', new Date(Date.now()+offset));
    const other = await task(user, 'Do not complete this one', new Date(Date.now()+12*HOUR));
    const untouched = await load(other.id);
    expect((await command(user, `PROGRESS ${draft.display_id} 40%`)).message_text).toContain('40%');
    expect(await load(draft.id)).toMatchObject({ state: 'pending', progress_percent: 40, confirmed_at: null, completed_at: null });
    expect((await command(user, `PROGRESS ${draft.display_id} 100`)).message_text).toContain('Completion recorded');
    expect(await load(draft.id)).toMatchObject({ state: 'completed', progress_percent: 100, confirmed_at: null,
      missed_at: offset < 0 ? draft.due_at : null });
    expect((await audit(draft.id)).map(row => row.event_type).sort()).toEqual(['completed_self_reported', 'created', 'progress_self_reported']);
    expect(await jobs(draft.id)).toEqual([]);
    expect(await load(other.id)).toEqual(untouched);
  });

  it('keeps cancelled tasks terminal and never applies their commands to another eligible task', async () => {
    const user = await newUser();
    const cancelled = await task(user, 'Cancel this task', new Date(Date.now()+4*HOUR));
    const other = await task(user, 'Keep this task', new Date(Date.now()+6*HOUR));
    const untouched = await load(other.id);
    await command(user, `SELECT ${cancelled.display_id}`);
    expect((await command(user, `CANCEL ${cancelled.display_id}`)).message_text).toContain('Cancelled');
    const snapshot = await load(cancelled.id);
    const events = await audit(cancelled.id);
    for (const text of [`DONE ${cancelled.display_id}`, `PROGRESS ${cancelled.display_id} 100`, `CONFIRM ${cancelled.display_id}`, `CANCEL ${cancelled.display_id}`]) {
      expect((await command(user, text)).message_text).toContain('is cancelled');
    }
    await command(user, `SELECT ${cancelled.display_id}`);
    expect((await command(user, 'DONE')).message_text).toContain('is cancelled');
    expect(await load(cancelled.id)).toEqual(snapshot);
    expect(await audit(cancelled.id)).toEqual(events);
    expect(await jobs(cancelled.id)).toEqual([]);
    expect(await load(other.id)).toEqual(untouched);
    expect((await audit(other.id)).map(row => row.event_type)).toEqual(['created']);
  });

  it('treats repeated CONFIRM as an explanation without duplicate activation, audit events or jobs', async () => {
    const user = await newUser();
    const draft = await task(user, 'Confirm only once', new Date(Date.now()+6*HOUR));
    expect((await command(user, `CONFIRM ${draft.display_id}`)).message_text).toContain('Task activated');
    const active = await load(draft.id);
    const events = await audit(draft.id);
    const scheduled = await jobs(draft.id);
    expect(active.state).toBe('active');
    expect(scheduled.length).toBeGreaterThan(0);
    expect((await command(user, `CONFIRM ${draft.display_id}`)).message_text).toContain('already been confirmed');
    await command(user, `SELECT ${draft.display_id}`);
    expect((await command(user, 'CONFIRM')).message_text).toContain('already been confirmed');
    expect(await load(draft.id)).toEqual(active);
    expect(await audit(draft.id)).toEqual(events);
    expect((await audit(draft.id)).filter(row => row.event_type === 'confirmed')).toHaveLength(1);
    expect(await jobs(draft.id)).toEqual(scheduled);
  });

  it('reaches every current task and old completed references beyond 30 rows while enforcing owner isolation', async () => {
    const user = await newUser();
    const other = await newUser();
    const due = new Date(Date.now()+6*HOUR);
    const old = await task(user, 'Oldest completed task', due);
    await ownerTransaction(user, db => reportTaskComplete(db, old));
    for (let index=0; index<4; index++) {
      const finished = await task(user, `Newer completed ${index}`, due);
      await ownerTransaction(user, db => reportTaskComplete(db, finished));
    }
    const current: TaskContract[] = [];
    for (let index=0; index<31; index++) current.push(await task(user, `Current task ${index+1}`, due));
    const foreign = await task(other, 'Private other owner task', due);
    const board = (await command(user, 'LIST')).message_text;
    for (const row of current) expect(board).toContain(row.title);
    expect(board).not.toContain(old.title);
    expect(board).not.toContain(foreign.title);
    expect((await command(user, `SELECT ${old.display_id}`)).message_text).toContain(old.title);
    expect((await command(user, 'DONE')).message_text).toContain('Already completed');
    expect((await command(user, `DONE ${old.display_id}`)).message_text).toContain('Already completed');
    expect((await command(user, `STATUS ${old.id}`)).message_text).toContain(old.title);
    const last = current.at(-1)!;
    expect((await command(user, `SELECT ${last.display_id}`)).message_text).toContain(last.title);
    expect((await command(user, `STATUS ${last.display_id}`)).message_text).toContain(last.title);
    expect((await command(user, `DONE ${last.display_id}`)).message_text).toContain('Completion recorded');
    expect((await load(last.id)).state).toBe('completed');
    const contractsBefore = (await pool!.query('SELECT * FROM contracts ORDER BY id')).rows;
    const auditBefore = (await pool!.query('SELECT * FROM contract_events ORDER BY id')).rows;
    for (const text of [`SELECT ${foreign.display_id}`, `DONE ${foreign.display_id}`, `DONE ${foreign.id}`, `PROGRESS ${foreign.id} 100`,
      `CONFIRM ${foreign.id}`, `CANCEL ${foreign.id}`, `STATUS ${foreign.id}`, 'DONE 2147483648', 'SELECT 99999999999999999999999',
      'DONE -1', 'PROGRESS 0 100']) {
      const reply = await command(user, text);
      expect(reply.message_text).not.toContain('Completion recorded');
      expect(reply.message_text).not.toContain(foreign.title);
    }
    expect((await pool!.query('SELECT * FROM contracts ORDER BY id')).rows).toEqual(contractsBefore);
    expect((await pool!.query('SELECT * FROM contract_events ORDER BY id')).rows).toEqual(auditBefore);
    expect((await pool!.query('SELECT * FROM scheduled_jobs')).rows).toEqual([]);
    expect((await load(foreign.id)).state).toBe('pending');
    expect((await audit(old.id)).filter(row => row.event_type === 'completed_self_reported')).toHaveLength(1);
  });
});
