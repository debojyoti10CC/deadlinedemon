import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Agent, ArtifactRef, Contract, Evidence, GitHubContract, GitHubReader, TaskContract, Transport, User } from '../src/types.js';
import { deliverOutbox, type OutboxRow } from '../src/scheduler/outbox.js';

const owner: User = {
  id: 'c823f849-ff6c-4e41-8181-01c5e065e190', imessage_handle: '+15551234567',
  timezone: 'Asia/Kolkata', intensity: 'savage', paused: false, space_id: 'any;-;+15551234567', selected_contract_id: null,
};
const reference: ArtifactRef = {
  repo_owner: 'owner', repo_name: 'repo', artifact_type: 'pull_request', artifact_number: 42,
  artifact_url: 'https://github.com/owner/repo/pull/42',
};
const evidence = (changes: Partial<Evidence> = {}): Evidence => ({
  artifact: reference, observedAt: '2026-10-18T12:00:00.000Z', title: 'Release the feature', state: 'open',
  mergedAt: null, closedAt: null, headSha: 'a'.repeat(40), mergeable: true, draft: false,
  checks: [], reviews: [], files: [], limitations: [], ...changes,
});
const contract = (changes: Partial<GitHubContract> = {}): GitHubContract => ({
  ...reference, id: 'c823f849-ff6c-4e41-8181-01c5e065e191', user_id: owner.id, display_id: 1, progress_percent: 0,
  title: 'Merge the release', state: 'active', intensity: 'savage', due_at: new Date('2026-10-18T13:00:00Z'),
  created_at: new Date('2026-10-18T11:00:00Z'), confirmed_at: new Date('2026-10-18T11:01:00Z'),
  completed_at: null, last_checked_at: new Date('2026-10-18T12:00:00Z'),
  last_observed_state: evidence(), version: 3, missed_at: null, ...changes,
});
const taskContract = (changes: Partial<TaskContract> = {}): TaskContract => ({
  artifact_type: 'task', repo_owner: null, repo_name: null, artifact_number: null, artifact_url: null,
  id: 'c823f849-ff6c-4e41-8181-01c5e065e191', user_id: owner.id, title: 'Finish the front end', display_id: 1, progress_percent: 0,
  state: 'active', intensity: 'savage', due_at: new Date('2026-10-19T05:00:00Z'),
  created_at: new Date('2026-10-18T11:00:00Z'), confirmed_at: new Date('2026-10-18T11:01:00Z'),
  completed_at: null, last_checked_at: null, last_observed_state: null, version: 3, missed_at: null,
  ...changes,
});
const row = (changes: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'outbox-1', user_id: owner.id, contract_id: contract().id, contract_version: 3,
  space_id: owner.space_id!, event_key: 'contract:before_15', message_text: 'Previously generated reminder.',
  kind: 'reminder', attempts: 0, ...changes,
});

let query: ReturnType<typeof vi.fn>;
let inspect: ReturnType<typeof vi.fn>;
let generate: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let responding: ReturnType<typeof vi.fn>;
let db: PoolClient;
let github: GitHubReader;
let ai: Agent;
let transport: Transport;
let currentOwner: User;
let currentContract: Contract | undefined;

const hasSql = (fragment: string) => query.mock.calls.some(([sql]) => String(sql).includes(fragment));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:30Z'));
  currentOwner = { ...owner };
  currentContract = contract();
  query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM users')) return { rows: [currentOwner], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM contracts')) return { rows: currentContract ? [currentContract] : [], rowCount: currentContract ? 1 : 0 };
    return { rows: [], rowCount: 1 };
  });
  db = { query } as unknown as PoolClient;
  inspect = vi.fn().mockResolvedValue(evidence({ observedAt: '2026-10-18T12:00:30.000Z' }));
  generate = vi.fn().mockResolvedValue('Generated from the current evidence.');
  send = vi.fn().mockResolvedValue(undefined);
  responding = vi.fn(async (_spaceId: string, work: () => Promise<unknown>) => work());
  github = { inspect } as GitHubReader;
  ai = { parse: vi.fn(), generate } as Agent;
  transport = { send, responding, stop: vi.fn() } as Transport;
});
afterEach(() => { vi.useRealTimers(); });

describe('durable outbox delivery guards', () => {
  it('suppresses a contracted reply queued against a stale contract version', async () => {
    await deliverOutbox(db, row({ kind: 'reply', contract_version: 2 }), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled'] as const)('suppresses a stale reminder for a %s contract', async (state) => {
    currentContract = contract({ state });
    await deliverOutbox(db, row(), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['reminder', 'verdict', 'victory'] as const)('defers proactive %s delivery while paused', async (kind) => {
    currentOwner.paused = true;
    await deliverOutbox(db, row({ kind }), github, ai, transport);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("run_at=now()+interval '1 minute'"), ['outbox-1']);
    expect(send).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('allows a direct owner reply while paused and records its delivered conversation', async () => {
    currentOwner.paused = true;
    const reply = row({ kind: 'reply', contract_id: null, contract_version: null, message_text: 'Monitoring paused.' });
    await deliverOutbox(db, reply, github, ai, transport);
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, 'Monitoring paused.');
    expect(hasSql("status='sent'")).toBe(true);
    expect(hasSql('INSERT INTO conversation_messages')).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('suppresses a row routed to an obsolete owner conversation', async () => {
    await deliverOutbox(db, row({ space_id: 'any;-;+15557654321' }), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('suppresses an absent contract rather than sending an orphaned reminder', async () => {
    currentContract = undefined;
    await deliverOutbox(db, row(), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fresh evidence at delivery time', () => {
  it('refreshes GitHub before sending and does not generate again for only an observedAt change', async () => {
    await deliverOutbox(db, row(), github, ai, transport);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(currentContract);
    expect(inspect.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, 'Previously generated reminder.');
    expect(hasSql("status='sent'")).toBe(true);
  });

  it('queues a victory on a newly observed real merge and never sends the stale reminder', async () => {
    const merged = evidence({ state: 'closed', mergedAt: '2026-10-18T12:00:15.000Z', closedAt: '2026-10-18T12:00:15.000Z' });
    inspect.mockResolvedValue(merged);
    await deliverOutbox(db, row(), github, ai, transport);
    expect(currentContract?.state).toBe('completed');
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(generate).toHaveBeenCalledExactlyOnceWith('victory', expect.objectContaining({ evidence: merged }), 'savage');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox'), expect.arrayContaining([
      `completed:${contract().id}`, contract().id, 'victory',
    ]));
    expect(send).not.toHaveBeenCalled();
    expect(responding).not.toHaveBeenCalled();
  });

  it('regenerates a delayed reminder only when the GitHub facts actually changed', async () => {
    inspect.mockResolvedValue(evidence({ checks: [{ name: 'unit tests', status: 'completed', conclusion: 'failure', url: null }] }));
    await deliverOutbox(db, row(), github, ai, transport);
    expect(generate).toHaveBeenCalledExactlyOnceWith('reminder', expect.objectContaining({
      evidence: expect.objectContaining({ checks: [expect.objectContaining({ name: 'unit tests', conclusion: 'failure' })] }),
    }), 'savage');
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, expect.stringContaining('unit tests'));
    expect(query).toHaveBeenCalledWith('UPDATE outbox SET message_text=$2 WHERE id=$1', ['outbox-1', expect.stringContaining('Generated from the current evidence.')]);
  });

  it('refreshes a queued GitHub reminder after the owner changes its intensity even if evidence is unchanged', async () => {
    currentContract = contract({ intensity: 'mild', version: 4 });
    await deliverOutbox(db, row({ contract_version: 3, message_text: 'Old SAVAGE reminder.' }), github, ai, transport);
    expect(generate).toHaveBeenCalledExactlyOnceWith('reminder', expect.objectContaining({
      contract: expect.objectContaining({ intensity: 'mild' }),
    }), 'mild');
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, expect.stringContaining('Generated from the current evidence.'));
    expect(send.mock.calls[0]![1]).not.toContain('Old SAVAGE reminder.');
  });

  it('suppresses an expired pre-deadline warning after refreshing current evidence', async () => {
    currentContract = contract({ due_at: new Date('2026-10-18T11:59:00Z') });
    await deliverOutbox(db, row(), github, ai, transport);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing and leaves delivery retryable when GitHub cannot be reviewed', async () => {
    inspect.mockRejectedValue(new Error('GitHub unavailable'));
    await expect(deliverOutbox(db, row(), github, ai, transport)).rejects.toThrow('GitHub unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(hasSql("status='sent'")).toBe(false);
  });

  it('does not mark delivery sent when the real transport operation fails', async () => {
    send.mockRejectedValue(new Error('Photon send uncertain'));
    await expect(deliverOutbox(db, row(), github, ai, transport)).rejects.toThrow('Photon send uncertain');
    expect(hasSql("status='sent'")).toBe(false);
  });
});

describe('ordinary task reminders', () => {
  it('sends a task reminder without GitHub or generated AI calls', async () => {
    currentContract = taskContract({ due_at: new Date('2026-10-18T12:10:30Z') });
    const taskRow = row({ event_key: `milestone:${currentContract.id}:before_15`, message_text: 'Stale reminder.' });
    await deliverOutbox(db, taskRow, github, ai, transport);
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain('Finish the front end');
    expect(send.mock.calls[0]![1]).toContain('self-reported');
    expect(send.mock.calls[0]![1]).toMatch(/^Deadline alert · 10m left\n/);
  });

  it('reclassifies a delayed overdue task reminder honestly and does not count completion as external proof', async () => {
    currentContract = taskContract({ due_at: new Date('2026-10-18T11:59:00Z') });
    await deliverOutbox(db, row({ kind: 'verdict', event_key: `milestone:${currentContract.id}:followup` }), github, ai, transport);
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![1]).toMatch(/completion (?:is )?unreported/i);
  });
});

describe('deadline checkpoint freshness at delivery', () => {
  it.each(['task', 'pull_request'] as const)('drops expired %s checkpoints before any paid integration call', async artifactType => {
    currentContract = artifactType === 'task'
      ? taskContract({ due_at: new Date(Date.now() + 30 * 60_000) })
      : contract({ due_at: new Date(Date.now() + 30 * 60_000) });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_60` }), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([[120, 60], [60, 30], [30, 15], [15, 0], [2, 0]])('expires the %s-minute checkpoint exactly at its %s-minute boundary', async (checkpoint, left) => {
    currentContract = taskContract({ due_at: new Date(Date.now() + left * 60_000) });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_${checkpoint}` }), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([[120, '2h'], [60, '1h'], [30, '30m'], [15, '15m']] as const)('delivers the %s-minute alert with the actual countdown and task controls', async (checkpoint, countdown) => {
    currentContract = taskContract({ due_at: new Date(Date.now() + checkpoint * 60_000), progress_percent: 27 });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_${checkpoint}` }), github, ai, transport);
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, expect.stringMatching(new RegExp(`^Deadline alert · ${countdown} left\\n`)));
    expect(send.mock.calls[0]![1]).toContain('#1 · Finish the front end');
    expect(send.mock.calls[0]![1]).toContain('HP ▰▰▱▱▱▱▱▱▱▱ 27%');
    expect(send.mock.calls[0]![1]).toContain('PROGRESS 1 50 · DONE 1');
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('uses current time rather than claiming a delayed alert still has its original two hours', async () => {
    currentContract = taskContract({ due_at: new Date(Date.now() + 90 * 60_000) });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_120` }), github, ai, transport);
    expect(send.mock.calls[0]![1]).toMatch(/^Deadline alert · 1h 30m left\n/);
    expect(send.mock.calls[0]![1]).not.toContain('2h left');
  });

  it('suppresses a queued checkpoint after the deadline has moved beyond its window', async () => {
    currentContract = contract({ due_at: new Date(Date.now() + 3 * 60 * 60_000), version: 4 });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_30`, contract_version: 3 }), github, ai, transport);
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks a checkpoint if its window expires while GitHub is being inspected', async () => {
    currentContract = contract({ due_at: new Date(Date.now() + 30 * 60_000 + 30_000) });
    inspect.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 30_000));
      return evidence();
    });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_60` }), github, ai, transport);
    expect(inspect).toHaveBeenCalledOnce();
    expect(hasSql("status='suppressed'")).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('renders current deterministic GitHub checkpoint facts when the contract changes', async () => {
    currentContract = contract({ due_at: new Date(Date.now() + 15 * 60_000), version: 4 });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_15`, contract_version: 3 }), github, ai, transport);
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, expect.stringMatching(/^Deadline alert · 15m left\n/));
    expect(send.mock.calls[0]![1]).toContain('#1 · Merge the release');
    expect(send.mock.calls[0]![1]).toContain('Due: 18 Oct 2026, 5:45 PM (Asia/Kolkata)');
    expect(send.mock.calls[0]![1]).toContain('GitHub reports PR open; no merge verified');
    expect(send.mock.calls[0]![1]).toContain('STATUS 1 · DONE 1');
  });

  it('replaces a stale generated two-hour GitHub countdown with the current ninety minutes without another model call', async () => {
    currentContract = contract({ due_at: new Date(Date.now() + 90 * 60_000) });
    await deliverOutbox(db, row({ event_key: `milestone:${currentContract.id}:before_120`, message_text: 'Two hours left. Finish the release.' }), github, ai, transport);
    expect(inspect).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(owner.space_id, expect.stringMatching(/^Deadline alert · 1h 30m left\n/));
    expect(send.mock.calls[0]![1]).not.toContain('Two hours left');
    expect(send.mock.calls[0]![1]).toContain(reference.artifact_url);
  });

  it('does not apply checkpoint expiry rules to independent blocker reminders', async () => {
    currentContract = contract({ due_at: new Date(Date.now() + 10 * 60_000) });
    await deliverOutbox(db, row({ event_key: `blocker:${currentContract.id}:before_120` }), github, ai, transport);
    expect(inspect).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(hasSql("status='suppressed'")).toBe(false);
  });
});
