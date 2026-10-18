import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Agent, ArtifactRef, Contract, Evidence, GitHubContract, GitHubReader, Intent, TaskContract, User } from '../src/types.js';
import { Orchestrator } from '../src/agent/orchestrator.js';

const mocks = vi.hoisted(() => ({
  contractByReference: vi.fn(), contractsFor: vi.fn(), historyFor: vi.fn(), queueMessage: vi.fn(), recordConversation: vi.fn(),
  createContract: vi.fn(), createTaskContract: vi.fn(), confirmContract: vi.fn(), cancelContract: vi.fn(), observe: vi.fn(),
  observeTaskDeadline: vi.fn(), reportTaskComplete: vi.fn(), reportTaskProgress: vi.fn(), setIntensity: vi.fn(), reschedulePendingContract: vi.fn(),
}));
vi.mock('../src/db/queries.js', () => ({
  contractsFor: mocks.contractsFor, historyFor: mocks.historyFor,
  contractByReference: mocks.contractByReference,
  queueMessage: mocks.queueMessage, recordConversation: mocks.recordConversation,
}));
vi.mock('../src/contracts/service.js', () => ({
  createContract: mocks.createContract, createTaskContract: mocks.createTaskContract,
  confirmContract: mocks.confirmContract, cancelContract: mocks.cancelContract, observe: mocks.observe,
  observeTaskDeadline: mocks.observeTaskDeadline, reportTaskComplete: mocks.reportTaskComplete,
  reportTaskProgress: mocks.reportTaskProgress, setIntensity: mocks.setIntensity, reschedulePendingContract: mocks.reschedulePendingContract,
}));

const firstId = 'c823f849-ff6c-4e41-8181-01c5e065e19c';
const secondId = 'c823f849-ff6c-4e41-8181-01c5e065e19d';
const owner: User = {
  id: 'c823f849-ff6c-4e41-8181-01c5e065e190', imessage_handle: '+15551234567',
  timezone: 'Asia/Kolkata', intensity: 'savage', paused: false, space_id: 'owner-space', selected_contract_id: null,
};
const reference: ArtifactRef = {
  repo_owner: 'owner', repo_name: 'repo', artifact_type: 'pull_request', artifact_number: 42,
  artifact_url: 'https://github.com/owner/repo/pull/42',
};
const evidence = (ref: ArtifactRef = reference): Evidence => ({
  artifact: ref, observedAt: '2026-10-18T12:00:00.000Z', title: 'Fix the release', state: 'open',
  mergedAt: null, closedAt: null, headSha: 'a'.repeat(40), mergeable: true, draft: false,
  checks: [], reviews: [], files: [], limitations: [],
});
const contract = (changes: Partial<GitHubContract> = {}): GitHubContract => ({
  ...reference, id: firstId, user_id: owner.id, title: 'Merge the release PR', display_id: changes.id === secondId ? 2 : 1, progress_percent: 0,
  due_at: new Date('2026-10-18T15:30:00Z'), state: 'active', intensity: 'savage',
  created_at: new Date('2026-10-18T11:00Z'), confirmed_at: new Date('2026-10-18T11:00Z'),
  completed_at: null, last_checked_at: null, last_observed_state: null, version: 1, missed_at: null,
  ...changes,
});
const taskContract = (changes: Partial<TaskContract> = {}): TaskContract => ({
  artifact_type: 'task', repo_owner: null, repo_name: null, artifact_number: null, artifact_url: null,
  id: firstId, user_id: owner.id, title: 'Finish the front end', due_at: new Date('2026-10-19T05:00:00Z'), display_id: changes.id === secondId ? 2 : 1, progress_percent: 0,
  state: 'pending', intensity: 'savage', created_at: new Date('2026-10-18T11:00:00Z'), confirmed_at: null,
  completed_at: null, last_checked_at: null, last_observed_state: null, version: 1, missed_at: null,
  ...changes,
});
const intent = (name: Intent['intent'], changes: Partial<Intent> = {}): Intent => ({
  intent: name, title: null, artifact_url: null, deadline_local: null, timezone: null,
  intensity: null, contract_id: null, needs_clarification: false, clarification: null, ...changes,
});
const createIntent = (url = reference.artifact_url) => intent('create_contract', {
  title: 'Merge the release PR', artifact_url: url, deadline_local: '2026-10-18T21:00', timezone: owner.timezone,
});

let parse: ReturnType<typeof vi.fn>;
let generate: ReturnType<typeof vi.fn>;
let inspect: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let db: PoolClient;
let router: Orchestrator;
const lastReply = () => mocks.queueMessage.mock.calls.at(-1)?.[1]?.text as string;

beforeEach(() => {
  owner.selected_contract_id=null;owner.intensity='savage';owner.paused=false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.contractsFor.mockResolvedValue([]);
  mocks.contractByReference.mockResolvedValue(undefined);
  mocks.historyFor.mockResolvedValue([]);
  mocks.queueMessage.mockResolvedValue(undefined);
  mocks.recordConversation.mockResolvedValue(undefined);
  mocks.createContract.mockResolvedValue(contract({ state: 'pending', confirmed_at: null }));
  let taskIndex=0;
  mocks.createTaskContract.mockImplementation(async (_db: unknown,_user: unknown,title: string,due: Date,intensity: TaskContract['intensity']) => {
    taskIndex+=1;return taskContract({id:taskIndex===1?firstId:secondId,display_id:taskIndex,title,due_at:due,intensity});
  });
  mocks.confirmContract.mockResolvedValue(undefined);
  mocks.cancelContract.mockResolvedValue(undefined);
  mocks.observe.mockResolvedValue({ completed: false, newlyCompleted: false, missed: false });
  mocks.observeTaskDeadline.mockResolvedValue(undefined);
  mocks.reportTaskComplete.mockImplementation(async (_db: unknown,c: TaskContract,now: Date) => { c.state='completed';c.completed_at=now;c.progress_percent=100; });
  mocks.reportTaskProgress.mockImplementation(async (_db: unknown,c: TaskContract,percent: number) => { c.progress_percent=percent;if(percent===100){c.state='completed';c.completed_at=new Date();} });
  mocks.setIntensity.mockImplementation(async (_db: unknown,user: User,level: User['intensity']) => { user.intensity=level; });
  mocks.reschedulePendingContract.mockImplementation(async (_db: unknown,c: TaskContract,due: Date) => { c.due_at=due; });
  parse = vi.fn();
  generate = vi.fn().mockResolvedValue('The current evidence is open. Check the linked PR.');
  inspect = vi.fn().mockResolvedValue(evidence());
  query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  db = { query } as unknown as PoolClient;
  router = new Orchestrator({ parse, generate } as Agent, { inspect } as GitHubReader, ['owner/repo']);
});
afterEach(() => vi.useRealTimers());

describe('owner controls and contract selection', () => {
  it.each([['pause', 'PAUSE', true], ['resume', 'RESUME', false]] as const)('persists %s without GitHub or message-generation calls', async (name, text, paused) => {
    parse.mockResolvedValue(intent(name));
    await router.handle(db, owner, text, 'owner-space', 'inbound-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET paused'), [owner.id, paused]);
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(lastReply()).toMatch(paused ? /paused/i : /resumed/i);
  });

  it('asks which active contract when STATUS has no ID and multiple candidates', async () => {
    mocks.contractsFor.mockResolvedValue([contract(), contract({ id: secondId })]);
    parse.mockResolvedValue(intent('get_status'));
    await router.handle(db, owner, 'STATUS', 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(lastReply()).toContain('#1');
    expect(lastReply()).toContain('#2');
    expect(lastReply()).not.toContain(firstId);
  });

  it('refreshes only the explicitly selected active contract', async () => {
    const selected = contract({ id: secondId });
    mocks.contractsFor.mockResolvedValue([contract(), selected]);
    parse.mockResolvedValue(intent('get_status', { contract_id: secondId }));
    await router.handle(db, owner, `STATUS ${secondId}`, 'owner-space', 'inbound-1');
    expect(inspect).toHaveBeenCalledExactlyOnceWith(selected, false);
    expect(mocks.observe).toHaveBeenCalledWith(db, selected, expect.anything(), expect.any(Date));
  });

  it('does not silently select another contract when the supplied UUID is absent', async () => {
    mocks.contractsFor.mockResolvedValue([contract()]);
    parse.mockResolvedValue(intent('get_status', { contract_id: secondId }));
    await router.handle(db, owner, `STATUS ${secondId}`, 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it('creates a pending contract and requires exact confirmation before activation', async () => {
    parse.mockResolvedValue(createIntent());
    await router.handle(db, owner, `Merge ${reference.artifact_url} by 9 PM tonight`, 'owner-space', 'inbound-1');
    expect(mocks.createContract).toHaveBeenCalledOnce();
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('CONFIRM 1');
  });

  it('explains that GitHub is optional when a link is supplied without GitHub configuration', async () => {
    router = new Orchestrator({ parse, generate } as Agent, { inspect } as GitHubReader, []);
    parse.mockResolvedValue(createIntent());
    await router.handle(db, owner, `Merge ${reference.artifact_url} by 9 PM tonight`, 'owner-space', 'inbound-1');
    expect(lastReply()).toContain('Ordinary tasks work without it');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('creates ordinary commitments without GitHub and keeps each milestone deadline separate', async () => {
    parse.mockResolvedValue(intent('create_contract', { title: null, deadline_local: null, artifact_url: null, milestones: [
      { title: 'Finish the front end', deadline_local: '2026-10-19T05:00' },
      { title: 'Ship the project', deadline_local: '2026-10-19T10:00' },
    ] }));
    await router.handle(db, owner, 'Finish the front end tomorrow 5 AM, ship tomorrow 10 AM', 'owner-space', 'inbound-1');
    expect(mocks.createTaskContract).toHaveBeenCalledTimes(2);
    expect(mocks.createTaskContract.mock.calls.map(call => [call[2], call[3]])).toEqual([
      ['Finish the front end', new Date('2026-10-18T23:30:00.000Z')],
      ['Ship the project', new Date('2026-10-19T04:30:00.000Z')],
    ]);
    expect(inspect).not.toHaveBeenCalled();
    expect(lastReply()).toContain('CONFIRM');
    expect(lastReply()).toContain('Finish the front end');
    expect(lastReply()).toContain('Ship the project');
  });

  it('confirms an ordinary task without any GitHub request', async () => {
    const pending = taskContract();
    mocks.contractsFor.mockResolvedValue([pending]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    await router.handle(db, owner, `CONFIRM ${firstId}`, 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.confirmContract).toHaveBeenCalledWith(db, pending, expect.any(Date));
    expect(lastReply()).toContain('self-reported');
  });

  it('records explicit DONE as self-reported and never treats a natural-language claim as proof', async () => {
    const selected = taskContract({ state: 'active', confirmed_at: new Date('2026-10-18T12:00:00Z') });
    mocks.contractsFor.mockResolvedValue([selected]);
    parse.mockResolvedValue(intent('verify_completion', { contract_id: firstId }));
    await router.handle(db, owner, `DONE ${firstId}`, 'owner-space', 'inbound-1');
    expect(mocks.reportTaskComplete).toHaveBeenCalledWith(db, selected, expect.any(Date));
    expect(inspect).not.toHaveBeenCalled();
    expect(lastReply()).toContain('self-reported');

    selected.state = 'active';
    selected.progress_percent = 0;
    mocks.queueMessage.mockClear();
    await router.handle(db, owner, 'I finished it', 'owner-space', 'inbound-2');
    expect(mocks.reportTaskComplete).not.toHaveBeenCalledTimes(2);
    expect(lastReply()).toContain('DONE 1');
  });

  it('handles task status without GitHub reads or generated tokens', async () => {
    const selected = taskContract({ state: 'active', confirmed_at: new Date('2026-10-18T12:00:00Z') });
    mocks.contractsFor.mockResolvedValue([selected]);
    parse.mockResolvedValue(intent('get_status', { contract_id: firstId }));
    await router.handle(db, owner, `STATUS ${firstId}`, 'owner-space', 'inbound-1');
    expect(mocks.observeTaskDeadline).toHaveBeenCalledWith(db, selected, expect.any(Date));
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(lastReply()).toContain('self-reported');
  });

  it('activates the explicitly confirmed pending contract after refreshing real evidence', async () => {
    const pending = contract({ state: 'pending', confirmed_at: null });
    mocks.contractsFor.mockResolvedValue([pending]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    await router.handle(db, owner, `CONFIRM ${firstId}`, 'owner-space', 'inbound-1');
    expect(inspect).toHaveBeenCalledWith(pending);
    expect(mocks.confirmContract).toHaveBeenCalledWith(db, pending, expect.any(Date));
    expect(lastReply()).toContain('ACTIVE');
  });

  it('requires selection when CONFIRM could target two pending contracts', async () => {
    mocks.contractsFor.mockResolvedValue([contract({ state: 'pending' }), contract({ id: secondId, state: 'pending' })]);
    parse.mockResolvedValue(intent('confirm_contract'));
    await router.handle(db, owner, 'CONFIRM', 'owner-space', 'inbound-1');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(lastReply()).toContain('Which task?');
  });

  it('rejects inferred confirmation when the owner did not send the explicit command', async () => {
    mocks.contractsFor.mockResolvedValue([contract({ state: 'pending' })]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    await router.handle(db, owner, 'yes that sounds good', 'owner-space', 'inbound-1');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('CONFIRM');
  });

  it.each([
    ['confirm_contract', 'CONFIRM', 'pending'],
    ['cancel_contract', 'CANCEL', 'active'],
  ] as const)('binds %s to the UUID actually sent by the owner', async (name, command, state) => {
    const first=contract({state});
    mocks.contractsFor.mockResolvedValue([first, contract({ id: secondId, state })]);
    parse.mockResolvedValue(intent(name, { contract_id: secondId }));
    await router.handle(db, owner, `${command} ${firstId}`, 'owner-space', 'inbound-1');
    expect(parse).not.toHaveBeenCalled();
    if(name==='confirm_contract'){
      expect(mocks.confirmContract).toHaveBeenCalledExactlyOnceWith(db,first,expect.any(Date));
      expect(mocks.cancelContract).not.toHaveBeenCalled();
    }else{
      expect(mocks.cancelContract).toHaveBeenCalledExactlyOnceWith(db,first);
      expect(mocks.confirmContract).not.toHaveBeenCalled();
    }
  });

  it('refuses to activate a target that became merged before confirmation', async () => {
    mocks.contractsFor.mockResolvedValue([contract({ state: 'pending' })]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    inspect.mockResolvedValue({ ...evidence(), state: 'closed', mergedAt: '2026-10-18T11:59:00Z' });
    await router.handle(db, owner, `CONFIRM ${firstId}`, 'owner-space', 'inbound-1');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('already completed');
  });

  it('refuses an expired pending deadline', async () => {
    mocks.contractsFor.mockResolvedValue([contract({ state: 'pending', due_at: new Date('2026-10-18T11:59Z') })]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    await router.handle(db, owner, `CONFIRM ${firstId}`, 'owner-space', 'inbound-1');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(lastReply()).toContain('passed');
  });

  it('rechecks the actual current time after slow GitHub verification before activating', async () => {
    mocks.contractsFor.mockResolvedValue([contract({ state: 'pending', due_at: new Date('2026-10-18T12:01Z') })]);
    parse.mockResolvedValue(intent('confirm_contract', { contract_id: firstId }));
    inspect.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-18T12:02Z'));
      return evidence();
    });
    await router.handle(db, owner, `CONFIRM ${firstId}`, 'owner-space', 'inbound-1');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('passed while checking');
  });

  it('cancels only an explicit selected contract', async () => {
    const selected = contract({ id: secondId });
    mocks.contractsFor.mockResolvedValue([contract(), selected]);
    parse.mockResolvedValue(intent('cancel_contract', { contract_id: secondId }));
    await router.handle(db, owner, `CANCEL ${secondId}`, 'owner-space', 'inbound-1');
    expect(mocks.cancelContract).toHaveBeenCalledExactlyOnceWith(db, selected);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('verifies DONE through GitHub instead of marking open work complete', async () => {
    const selected = contract();
    mocks.contractsFor.mockResolvedValue([selected]);
    parse.mockResolvedValue(intent('verify_completion', { contract_id: firstId }));
    await router.handle(db, owner, `DONE ${firstId}`, 'owner-space', 'inbound-1');
    expect(inspect).toHaveBeenCalledOnce();
    expect(mocks.observe).toHaveBeenCalledWith(db, selected, expect.objectContaining({ state: 'open', mergedAt: null }), expect.any(Date));
    expect(generate).toHaveBeenCalledWith('proof_rejected', expect.objectContaining({ evidence: expect.objectContaining({ mergedAt: null }) }), 'savage');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
  });
});

describe('short task controls and reported HP', () => {
  it('moves the existing draft deadline and asks for confirmation without creating another task', async () => {
    const draft=taskContract();
    mocks.contractsFor.mockResolvedValue([draft]);
    await router.handle(db,owner,'MOVE 1 2026-10-20 08:00','owner-space','move-1');
    expect(mocks.reschedulePendingContract).toHaveBeenCalledExactlyOnceWith(db,draft,new Date('2026-10-20T02:30Z'),expect.any(Date));
    expect(mocks.createTaskContract).not.toHaveBeenCalled();
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('CONFIRM 1');
    expect(parse).not.toHaveBeenCalled();
  });

  it('does not move an active commitment through draft editing', async () => {
    mocks.contractsFor.mockResolvedValue([taskContract({state:'active'})]);
    await router.handle(db,owner,'MOVE 1 2026-10-20 08:00','owner-space','move-active');
    expect(mocks.reschedulePendingContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('already active');
  });
  it('remembers first task and lets a bare CONFIRM activate only that selection', async () => {
    const first=taskContract();
    const second=taskContract({id:secondId,display_id:2,title:'Ship the project'});
    mocks.contractsFor.mockResolvedValue([first,second]);
    await router.handle(db,owner,'First task','owner-space','select-1');
    expect(owner.selected_contract_id).toBe(firstId);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('selected_contract_id=$2'),[owner.id,firstId]);
    expect(lastReply()).toContain('#1');
    await router.handle(db,owner,'CONFIRM','owner-space','confirm-1');
    expect(mocks.confirmContract).toHaveBeenCalledExactlyOnceWith(db,first,expect.any(Date));
    expect(parse).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFIRM','active','pending'],
    ['DONE','cancelled','active'],
  ] as const)('never redirects %s from an ineligible selection to another eligible task', async (text,selectedState,otherState) => {
    mocks.contractsFor.mockResolvedValue([
      taskContract({state:selectedState}),
      taskContract({id:secondId,display_id:2,state:otherState}),
    ]);
    owner.selected_contract_id=firstId;
    await router.handle(db,owner,text,'owner-space','selection-guard');
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(mocks.reportTaskComplete).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it('updates only the numbered task HP without model or GitHub calls', async () => {
    const second=taskContract({id:secondId,display_id:2,state:'active'});
    mocks.contractsFor.mockResolvedValue([taskContract({state:'active'}),second]);
    await router.handle(db,owner,'PROGRESS 2 40','owner-space','hp-1');
    expect(mocks.reportTaskProgress).toHaveBeenCalledExactlyOnceWith(db,second,40,expect.any(Date));
    expect(lastReply()).toContain('40%');
    expect(lastReply()).toContain('self-reported');
    expect(lastReply()).not.toContain(secondId);
    expect(parse).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('uses saved selection for a percentage-only progress command', async () => {
    const second=taskContract({id:secondId,display_id:2,state:'active'});
    mocks.contractsFor.mockResolvedValue([taskContract({state:'active'}),second]);
    owner.selected_contract_id=secondId;
    await router.handle(db,owner,'PROGRESS 60%','owner-space','hp-selected');
    expect(mocks.reportTaskProgress).toHaveBeenCalledExactlyOnceWith(db,second,60,expect.any(Date));
  });

  it('records pending task progress without activating reminders', async () => {
    const pending=taskContract();
    mocks.contractsFor.mockResolvedValue([pending]);
    await router.handle(db,owner,'PROGRESS 1 40','owner-space','hp-pending');
    expect(mocks.reportTaskProgress).toHaveBeenCalledExactlyOnceWith(db,pending,40,expect.any(Date));
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('40%');
    expect(lastReply()).toContain('CONFIRM 1');
  });

  it('completes the explicitly named expired draft instead of choosing another active task', async () => {
    const draft=taskContract({due_at:new Date('2026-10-18T00:00Z')});
    const other=taskContract({id:secondId,state:'active',progress_percent:27});
    mocks.contractsFor.mockResolvedValue([draft,other]);
    owner.selected_contract_id=secondId;
    await router.handle(db,owner,'Done 1','owner-space','expired-draft-done');
    expect(mocks.reportTaskComplete).toHaveBeenCalledExactlyOnceWith(db,draft,expect.any(Date));
    expect(mocks.confirmContract).not.toHaveBeenCalled();
    expect(other.progress_percent).toBe(27);
    expect(other.state).toBe('active');
    expect(lastReply()).toContain('Completion recorded');
    expect(lastReply()).toContain('#1');
    expect(lastReply()).toContain('100%');
    expect(lastReply()).not.toContain('Which task');
    expect(parse).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
  });

  it('looks up an explicit completed task and acknowledges DONE without another completion write', async () => {
    const completed=taskContract({state:'completed',progress_percent:100});
    mocks.contractsFor.mockResolvedValue([taskContract({id:secondId,state:'active'})]);
    mocks.contractByReference.mockResolvedValue(completed);
    await router.handle(db,owner,'DONE 1','owner-space','done-again');
    expect(mocks.contractByReference).toHaveBeenCalledExactlyOnceWith(db,owner.id,'1');
    expect(mocks.reportTaskComplete).not.toHaveBeenCalled();
    expect(lastReply()).toContain('Already completed');expect(lastReply()).toContain('#1');
    expect(parse).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps a completed selection for a bare DONE instead of completing the remaining task', async () => {
    const completed=taskContract({state:'completed',progress_percent:100});
    mocks.contractsFor.mockResolvedValue([taskContract({id:secondId,state:'active'})]);
    owner.selected_contract_id=firstId;
    mocks.contractByReference.mockResolvedValue(completed);
    await router.handle(db,owner,'DONE','owner-space','done-selected-again');
    expect(lastReply()).toContain('Already completed');expect(lastReply()).toContain('#1');
    expect(mocks.reportTaskComplete).not.toHaveBeenCalled();
  });

  it.each(['DONE','CANCEL','CONFIRM','PROGRESS 1 50'] as const)('explains a cancelled task for %s without choosing another task', async text => {
    const cancelled=taskContract({state:'cancelled'});
    mocks.contractsFor.mockResolvedValue([cancelled,taskContract({id:secondId,state:'active'})]);
    owner.selected_contract_id=firstId;
    await router.handle(db,owner,text.includes(' ')?text:`${text} 1`,'owner-space',`cancelled-${text}`);
    expect(lastReply()).toContain('cancelled');expect(lastReply()).toContain('#1');
    expect(mocks.reportTaskComplete).not.toHaveBeenCalled();expect(mocks.reportTaskProgress).not.toHaveBeenCalled();
    expect(mocks.confirmContract).not.toHaveBeenCalled();expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it('responds to duplicate CONFIRM on an active task without another confirmation or GitHub call', async () => {
    mocks.contractsFor.mockResolvedValue([contract({state:'active'}),contract({id:secondId,state:'pending'})]);
    await router.handle(db,owner,'CONFIRM 1','owner-space','confirm-active');
    expect(lastReply()).toContain('already been confirmed');
    expect(mocks.confirmContract).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['DONE','RECHECK'])('explains the sole GitHub draft for bare %s without inventing completion or asking for a task number',async text=>{
    mocks.contractsFor.mockResolvedValue([contract({state:'pending',confirmed_at:null})]);
    await router.handle(db,owner,text,'owner-space',`github-draft-${text}`);
    expect(lastReply()).toContain('draft');expect(lastReply()).toContain('CONFIRM 1');
    expect(lastReply()).not.toContain('No unfinished tasks');
    expect(mocks.reportTaskComplete).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
  });

  it('returns terminal task status without falsely changing or claiming selection',async()=>{
    const completed=taskContract({state:'completed',progress_percent:100});
    mocks.contractByReference.mockResolvedValue(completed);
    owner.selected_contract_id=secondId;
    await router.handle(db,owner,'STATUS 1','owner-space','status-terminal');
    expect(lastReply()).toContain('#1');expect(lastReply()).toContain('100%');
    expect(lastReply()).not.toContain('Selected');expect(owner.selected_contract_id).toBe(secondId);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('selected_contract_id=$2'))).toBe(false);
  });

  it('switches mode through the service for current and new tasks without generation', async () => {
    await router.handle(db,owner,'NUCLEAR','owner-space','mode-1');
    expect(mocks.setIntensity).toHaveBeenCalledExactlyOnceWith(db,owner,'nuclear');
    expect(lastReply()).toMatch(/current and new tasks/);
    expect(lastReply()).toContain('NUCLEAR');
    expect(parse).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns the existing pending task when an identical proposal is repeated', async () => {
    const pending=taskContract({due_at:new Date('2026-10-18T23:30Z')});
    mocks.contractsFor.mockResolvedValue([pending]);
    parse.mockResolvedValue(intent('create_contract',{title:'Finish the front end',deadline_local:'2026-10-19T05:00'}));
    await router.handle(db,owner,'Finish the front end tomorrow 5 AM','owner-space','same-task');
    expect(mocks.createTaskContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('#1');
    expect(lastReply()).toContain('CONFIRM 1');
  });
});

describe('artifact authorization and failed integrations', () => {
  it('rejects an artifact URL fabricated by interpretation', async () => {
    parse.mockResolvedValue(createIntent());
    await router.handle(db, owner, 'Merge something by 9 PM tonight', 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
    expect(lastReply()).toContain('exact GitHub');
  });

  it('does not accept an assistant-suggested artifact as owner authorization', async () => {
    mocks.historyFor.mockResolvedValue([{ role: 'assistant', content: reference.artifact_url }]);
    parse.mockResolvedValue(createIntent());
    await router.handle(db, owner, 'Merge that by 9 PM tonight', 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('rejects a fabricated artifact that is only a URL prefix of the pasted artifact', async () => {
    parse.mockResolvedValue(createIntent(reference.artifact_url));
    await router.handle(db, owner, `Merge ${reference.artifact_url}0 by 9 PM tonight`, 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it.each([
    'https://github.com.evil.example/owner/repo/pull/42',
    'https://github.com/other/private/pull/42',
    'https://github.com/owner/repo/pull/42?next=https://evil.example',
    'https://github.com/owner/repo/pull/42#comment',
  ])('rejects a pasted disallowed or deceptive URL: %s', async (url) => {
    parse.mockResolvedValue(createIntent(url));
    await router.handle(db, owner, `Merge ${url} by 9 PM tonight`, 'owner-space', 'inbound-1');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('propagates GitHub failure without creating a fake pending contract', async () => {
    parse.mockResolvedValue(createIntent());
    inspect.mockRejectedValue(new Error('GitHub unavailable'));
    await expect(router.handle(db, owner, `Merge ${reference.artifact_url} by 9 PM tonight`, 'owner-space', 'inbound-1')).rejects.toThrow('GitHub unavailable');
    expect(mocks.createContract).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
  });

  it('propagates interpretation failure without GitHub calls or fabricated responses', async () => {
    parse.mockRejectedValue(new Error('OpenAI quota exceeded'));
    await expect(router.handle(db, owner, 'Merge my PR', 'owner-space', 'inbound-1')).rejects.toThrow('OpenAI quota exceeded');
    expect(inspect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
  });

  it('queues clarification without any GitHub side effect', async () => {
    parse.mockResolvedValue(intent('create_contract', { needs_clarification: true, clarification: 'Which exact time?' }));
    await router.handle(db, owner, 'tomorrow', 'owner-space', 'inbound-1');
    expect(lastReply()).toBe('Which exact time?');
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('answers unknown messages with deterministic help that includes ordinary tasks', async () => {
    parse.mockResolvedValue(intent('unknown'));
    await router.handle(db, owner, 'something unclear', 'owner-space', 'inbound-1');
    expect(lastReply()).toMatch(/any task/i);
    expect(lastReply()).toMatch(/GitHub link optional/i);
    expect(generate).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});
