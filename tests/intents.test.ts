import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Contract, IntentContext } from '../src/types.js';
import { OpenAIAgent, parseCommand } from '../src/agent/intents.js';
import { IntentSchema } from '../src/agent/schemas.js';
import { commandTaskReference } from '../src/agent/commands.js';

const mocks = vi.hoisted(() => ({ parse: vi.fn(), construct: vi.fn() }));
vi.mock('openai', () => ({ default: class {
  constructor(options: unknown) { mocks.construct(options); }
  responses = { parse: mocks.parse };
} }));

const id = 'c823f849-ff6c-4e41-8181-01c5e065e19c';
const secondId = 'd523f849-ff6c-4e41-8181-01c5e065e19c';
const savedTask = (displayId: number, contractId = id): Contract => ({
  id: contractId, display_id: displayId, progress_percent: 0, title: `Task ${displayId}`,
  state: 'active', due_at: new Date('2026-10-19T15:30Z'), artifact_url: null,
} as Contract);
const context = (): IntentContext => ({
  now: '2026-10-18T12:00:00.000Z', timezone: 'Asia/Kolkata', intensity: 'savage', contracts: [], history: [],
});
const extracted = (overrides: Record<string, unknown> = {}) => ({
  intent: 'create_contract', title: 'Merge PR #42', artifact_url: 'https://github.com/owner/repo/pull/42',
  deadline_local: '2026-10-18T21:00', timezone: 'Asia/Kolkata', intensity: null, contract_id: null,
  deadline_sources: ['9 PM tonight'], milestones: null,
  needs_clarification: false, clarification: null, ...overrides,
});
const complete = (value: unknown) => mocks.parse.mockResolvedValue({ status: 'completed', output_parsed: value });

beforeEach(() => { mocks.parse.mockReset(); mocks.construct.mockReset(); });

describe('owner-scoped task history references',()=>{
 it.each(['DONE 1','STATUS #1','SELECT 1','MOVE 1 2026-10-20 08:00','PROGRESS 1 40%','task 1','#1'])('extracts only the explicit task reference from %s',text=>{
  expect(commandTaskReference(text)).toBe('1');
 });
 it.each(['1','DONE','PROGRESS 40%','DONE 0','SELECT -1','hi','CONFIRM next'])('does not borrow a reference from %s',text=>{
  expect(commandTaskReference(text)).toBeNull();
 });
 it('normalizes an exact UUID without taking a task number from a percentage',()=>{
  expect(commandTaskReference(`DONE ${id.toUpperCase()}`)).toBe(id);
  expect(commandTaskReference('PROGRESS 27%')).toBeNull();
 });
 it('does not let a loaded historical selection change the ordinal position of unfinished tasks',()=>{
  const completed={...savedTask(1),state:'completed'} as Contract;
  const active=savedTask(9,secondId);
  expect(parseCommand('first task',[completed,active],completed.id)).toMatchObject({intent:'select_contract',contract_id:active.id});
 });
});

describe('OpenAI request budget', () => {
  it('constructs the SDK with a bounded timeout and no automatic retries', () => {
    new OpenAIAgent('test-key', 'test-model');
    expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'test-key', timeout: 30_000, maxRetries: 0,
    });
  });

  it('makes exactly one model request for a diagnostic generation', async () => {
    complete({ message: 'The requested diagnostic completed.' });
    const agent = new OpenAIAgent('test-key', 'test-model');
    await agent.generate('connectivity_diagnostic', { diagnostic: true }, 'mild');
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.parse.mock.calls[0]![0]).toMatchObject({ model: 'test-model', store: false });
  });
});

describe('deterministic controls', () => {
  it('resolves a draft deadline edit locally with a stable task number', async () => {
    const current=context();current.contracts=[savedTask(7)];
    const parsed=await new OpenAIAgent('test-key','test-model').parse('MOVE #7 2026-10-20 08:00',current);
    expect(parsed).toMatchObject({intent:'reschedule_contract',contract_id:id,deadline_local:'2026-10-20T08:00'});
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(parseCommand('MOVE 7 whenever',current.contracts)).toMatchObject({needs_clarification:true});
  });
  it.each(['Hi', 'hello!', 'HELP', 'What can you do?'])('answers %s with task and optional GitHub help without an API call', async (message) => {
    const result = await new OpenAIAgent('test-key', 'test-model').parse(message, context());
    expect(result).toMatchObject({ intent: 'unknown', needs_clarification: true });
    expect(result.clarification).toMatch(/any task/i);
    expect(result.clarification).toMatch(/GitHub link optional/i);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each([
    ['PAUSE', 'pause'], [' resume ', 'resume'], ['LIST', 'list_contracts'],
    ['STATUS', 'get_status'], ['DONE', 'verify_completion'], ['RECHECK', 'verify_completion'],
    ['CONFIRM', 'confirm_contract'], ['CANCEL', 'cancel_contract'],
  ])('maps %s without an API call', async (message, intent) => {
    const result = await new OpenAIAgent('test-key', 'test-model').parse(message!, context());
    expect(result.intent).toBe(intent);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each(['CONFIRM', 'CANCEL', 'STATUS', 'DONE', 'RECHECK'])('retains an explicit UUID for %s', (command) => {
    expect(parseCommand(`${command} ${id.toUpperCase()}`)?.contract_id).toBe(id);
  });

  it('sets the requested intensity without LLM interpretation', () => {
    expect(parseCommand('MODE nuclear')).toMatchObject({ intent: 'change_intensity', intensity: 'nuclear' });
    expect(parseCommand('mode Mild')).toMatchObject({ intensity: 'mild' });
  });

  it.each(['mild', 'SAVAGE', 'nuclear'])('sets bare %s mode without an API call', async (message) => {
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, context())).toMatchObject({
      intent: 'change_intensity', intensity: message.toLowerCase(),
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('explains MODE options and samples without an API call', async () => {
    const result = await new OpenAIAgent('test-key', 'test-model').parse('MODE', context());
    expect(result).toMatchObject({ intent: 'unknown', needs_clarification: true });
    expect(result.clarification).toMatch(/MILD:.*\nSAVAGE:.*\nNUCLEAR:/);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFIRM', 'confirm_contract'], ['CANCEL', 'cancel_contract'], ['STATUS', 'get_status'],
    ['DONE', 'verify_completion'], ['RECHECK', 'verify_completion'], ['RESCUE', 'request_rescue'],
  ])('resolves %s numeric references to the owner UUID locally', async (command, expected) => {
    const current = context();
    current.contracts = [savedTask(8, secondId), savedTask(2)];
    for (const reference of ['2', '#2']) {
      expect(await new OpenAIAgent('test-key', 'test-model').parse(`${command} ${reference}`, current)).toMatchObject({
        intent: expected, contract_id: id, needs_clarification: false,
      });
    }
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each(['CONFIRM 1', 'STATUS #99', 'DONE 0', 'RESCUE -1', 'CANCEL #01', 'SELECT 1'])('rejects missing or invalid task numbers: %s', (message) => {
    expect(parseCommand(message, [savedTask(2)])).toMatchObject({
      intent: 'unknown', contract_id: null, needs_clarification: true,
    });
  });

  it('never resolves an ambiguous duplicate task number', () => {
    expect(parseCommand('CONFIRM 2', [savedTask(2), savedTask(2, secondId)])).toMatchObject({
      intent: 'unknown', contract_id: null, needs_clarification: true,
    });
  });

  it.each(['SELECT 2', '#2', 'task 2', 'task #2', 'first task'])('selects an existing task with %s without an API call', async (message) => {
    const current = context();
    current.contracts = [savedTask(8, secondId), savedTask(2)];
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, current)).toMatchObject({
      intent: 'select_contract', contract_id: id, needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('uses display order for ordinals without renumbering stable task numbers', () => {
    const tasks = [savedTask(8, secondId), savedTask(2)];
    expect(parseCommand('second task', tasks)).toMatchObject({ intent: 'select_contract', contract_id: secondId });
    expect(parseCommand('task 8', tasks)).toMatchObject({ intent: 'select_contract', contract_id: secondId });
    expect(parseCommand('task 1', tasks)).toMatchObject({ needs_clarification: true });
    expect(parseCommand('third task', tasks)).toMatchObject({ needs_clarification: true });
    expect(tasks.map(task => task.display_id)).toEqual([8, 2]);
  });

  it('selects a full owner UUID but rejects another UUID', () => {
    expect(parseCommand(`SELECT ${id.toUpperCase()}`, [savedTask(2)])).toMatchObject({
      intent: 'select_contract', contract_id: id,
    });
    expect(parseCommand(`SELECT ${secondId}`, [savedTask(2)])).toMatchObject({ needs_clarification: true });
  });

  it.each(['CONFIRM', 'STATUS', 'DONE', 'RESCUE', 'CANCEL'])('leaves bare %s resolution to the selected or sole eligible task', (command) => {
    expect(parseCommand(command, [savedTask(2)], id)).toMatchObject({ contract_id: null, needs_clarification: false });
  });

  it.each(['PROGRESS 2 40', 'PROGRESS #2 40%', `PROGRESS ${id.toUpperCase()} 40%`])('records an explicit progress percentage locally: %s', async (message) => {
    const current = context();
    current.contracts = [savedTask(2)];
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, current)).toMatchObject({
      intent: 'report_progress', contract_id: id, progress_percent: 40, needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each([0, 40, 100])('leaves bare PROGRESS %s%% resolution to the selected or sole eligible task', (percent) => {
    expect(parseCommand(`PROGRESS ${percent}%`, [savedTask(2)], id)).toMatchObject({
      intent: 'report_progress', contract_id: null, progress_percent: percent, needs_clarification: false,
    });
  });

  it.each(['PROGRESS 40', 'PROGRESS 2 -1%', 'PROGRESS 2 101', 'PROGRESS 2 40.5%', 'PROGRESS 99 40%', 'PROGRESS 2 40% extra'])('clarifies malformed or unsafe progress: %s', (message) => {
    expect(parseCommand(message, [savedTask(2)], id)).toMatchObject({ intent: 'unknown', needs_clarification: true });
  });

  it.each(['CONFIRM 18', 'CONFIRM everything', `CONFIRM ${id} extra`, 'CANCEL all', 'MODE dangerous'])('clarifies malformed control instead of authorizing it: %s', (message) => {
    expect(parseCommand(message)).toMatchObject({ intent: 'unknown', needs_clarification: true });
  });

  it('does not replay commands from history', async () => {
    complete(extracted({ intent: 'get_status', title: null, artifact_url: null, deadline_local: null, timezone: null }));
    const current = context();
    current.history = [{ role: 'user', content: `CONFIRM ${id}` }];
    expect((await new OpenAIAgent('test-key', 'test-model').parse('What is happening?', current)).intent).toBe('get_status');
    expect(JSON.parse(mocks.parse.mock.calls[0]![0].input).latest_message).toBe('What is happening?');
  });
});

describe('ordinary task creation preserves the exact new task', () => {
  const morningContext = (): IntentContext => ({
    ...context(), now: '2026-10-18T23:30:00.000Z',
    contracts: [{ ...savedTask(3), title: 'Finish the Aurora video', progress_percent: 27 }],
    selected_contract_id: id,
  });

  it.each([
    ['I need to finish the Cedar video by 10 AM today', 'finish the Cedar video'],
    ['I need to finish the Cedar video at 10 AM today', 'finish the Cedar video'],
    ['Finish the CEDAR video on October 19, 2026 at 10 AM', 'Finish the CEDAR video'],
    ['I need to finish the Cedar video at 10 AM today, and add that as a task', 'finish the Cedar video'],
    ['I need to finish the Cedar video at 10 AM today, and at that as a task', 'finish the Cedar video'],
    ['Please finish the Cedar video by today 10 AM, please add that as a task.', 'finish the Cedar video'],
  ])('creates a distinct pending proposal with owner spelling for %s', async (message, title) => {
    const current = morningContext();
    const before = structuredClone(current.contracts);
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, current)).toMatchObject({
      intent: 'create_contract', title, artifact_url: null, contract_id: null, milestones: null,
      deadline_local: '2026-10-19T10:00', timezone: 'Asia/Kolkata', needs_clarification: false,
    });
    expect(current.contracts).toEqual(before);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('keeps distinct deadline clauses for interpretation instead of dropping the first task', async () => {
    const message = 'Finish the Cedar video at 9 AM and ship the launch by 10 AM today';
    complete(extracted({
      artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish the Cedar video', deadline_local: '2026-10-19T09:00', deadline_sources: [message] },
        { title: 'Ship the launch', deadline_local: '2026-10-19T10:00', deadline_sources: [message] },
      ],
    }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, morningContext())).toMatchObject({
      intent: 'create_contract', needs_clarification: false,
      milestones: [{ title: 'Finish the Cedar video' }, { title: 'Ship the launch' }],
    });
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it('does not strip another command as if it were an add-task suffix', async () => {
    complete(extracted({ intent: 'unknown', needs_clarification: true, clarification: 'Send each change separately.' }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(
      'Finish the Cedar video at 10 AM today, and cancel task 3', morningContext(),
    )).toMatchObject({ needs_clarification: true });
    expect(mocks.parse).toHaveBeenCalledOnce();
  });
});

describe('ordinary task deadline regressions after local midnight', () => {
  const midnightContext = (): IntentContext => ({ ...context(), now: '2026-10-18T18:45:00.000Z' });
  const taskProposal = (deadline: string, sources: string[]) => extracted({
    title: 'Finish the launch video', artifact_url: null, deadline_local: deadline, deadline_sources: sources,
  });
  const deadlineQuestion = 'What exact date and time should I use for Finish the launch video in Asia/Kolkata?';

  it.each(['tomorrow', 'tommorow', 'tommorrow', 'tomorow'])('creates an ordinary proposal for %s at 9 AM without an API call', async (spelling) => {
    const message = `Finish the launch video by ${spelling} 9 am`;
    complete(taskProposal('2026-10-20T09:00', [`${spelling} 9 am`]));
    const result = await new OpenAIAgent('test-key', 'test-model').parse(message, midnightContext());
    expect(result).toMatchObject({
      intent: 'create_contract', title: 'Finish the launch video', artifact_url: null,
      deadline_local: '2026-10-20T09:00', timezone: 'Asia/Kolkata', needs_clarification: false,
    });
    expect(result.intent).not.toBe('confirm_contract');
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each(['9 am 19th october', '9AM 19 October', '19th October 9AM', '9AM19October', '19thOctober9AM'])('accepts the explicit day-first deadline %s without an API call', async (deadline) => {
    complete(taskProposal('2026-10-19T09:00', [deadline]));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(`Finish the launch video by ${deadline}`, midnightContext())).toMatchObject({
      intent: 'create_contract', title: 'Finish the launch video', artifact_url: null,
      deadline_local: '2026-10-19T09:00', needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it.each(['9 am 19th october', '9AM 19 October', '19th October 9AM', '9AM19October', '19thOctober9AM'])('uses the latest explicit date in the task clarification: %s', async (answer) => {
    complete(taskProposal('2026-10-19T09:00', [answer]));
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by tommorow 9 am' },
      { role: 'assistant', content: deadlineQuestion },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse(answer, current)).toMatchObject({
      intent: 'create_contract', title: 'Finish the launch video', artifact_url: null,
      deadline_local: '2026-10-19T09:00', needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('treats Yes after Did you mean as an owner-grounded pending proposal without an API call', async () => {
    complete(taskProposal('2026-10-20T09:00', ['tommorow 9 am']));
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by tommorow 9 am' },
      { role: 'assistant', content: 'Did you mean tomorrow, October 20, at 9 AM in Asia/Kolkata?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      intent: 'create_contract', title: 'Finish the launch video', artifact_url: null,
      deadline_local: '2026-10-20T09:00', needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('anchors an acknowledged tomorrow to the original owner message across local midnight', async () => {
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by tomorrow 9 am', created_at: new Date('2026-10-18T18:25:00.000Z') },
      { role: 'assistant', content: 'Did you mean tomorrow at 9 AM in Asia/Kolkata?' },
      { role: 'user', content: 'Yes' },
      { role: 'assistant', content: deadlineQuestion },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Confirmed', current)).toMatchObject({
      intent: 'create_contract', title: 'Finish the launch video', deadline_local: '2026-10-19T09:00',
      needs_clarification: false,
    });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('defers to interpretation when a newer owner correction cannot be parsed locally', async () => {
    complete(taskProposal('2026-10-21T10:00', ['October 21 at 10 am']));
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by tomorrow 9 am' },
      { role: 'assistant', content: 'Did you mean tomorrow at 9 AM?' },
      { role: 'user', content: 'No, October 21 at 10 am instead' },
      { role: 'assistant', content: deadlineQuestion },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      intent: 'create_contract', deadline_local: '2026-10-21T10:00', needs_clarification: false,
    });
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it('does not reuse an older task title across a substantive task change', async () => {
    complete({ ...taskProposal('2026-10-19T09:00', ['9 am 19th october']), title: 'Publish the homepage' });
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by 9 am' },
      { role: 'assistant', content: deadlineQuestion },
      { role: 'user', content: 'Actually publish the homepage instead' },
      { role: 'assistant', content: 'What exact date and time should I use for publishing the homepage?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('9 am 19th october', current)).toMatchObject({
      intent: 'create_contract', title: 'Publish the homepage', deadline_local: '2026-10-19T09:00',
      needs_clarification: false,
    });
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it.each(['tomorrow', 'tommorow', 'around tomorrow 9 am'])('keeps a missing or vague task time unconfirmed: %s', async (deadline) => {
    complete(taskProposal('2026-10-20T09:00', [deadline]));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(`Finish the launch video by ${deadline}`, midnightContext())).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('does not borrow the date supplied only by a Did you mean question', async () => {
    complete(taskProposal('2026-10-20T09:00', ['tomorrow', '9 am']));
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by 9 am' },
      { role: 'assistant', content: 'Did you mean tomorrow, October 20, at 9 AM in Asia/Kolkata?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('does not replay the task after Yes to an unrelated status question', async () => {
    complete(taskProposal('2026-10-20T09:00', ['tommorow 9 am']));
    const current = midnightContext();
    current.history = [
      { role: 'user', content: 'Finish the launch video by tommorow 9 am' },
      { role: 'assistant', content: 'Status: no active contracts. Do you want another status update?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });
});

describe('strict extraction schema', () => {
  it('emits a strict root object with all nullable fields required', () => {
    const format = zodTextFormat(IntentSchema, 'test_intent');
    expect(format.strict).toBe(true);
    expect(format.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(format.schema.required).toContain('clarification');
    expect(format.schema.required).toContain('deadline_local');
  });

  it('rejects unapproved fields, omitted nullable fields, and privileged model intents', () => {
    expect(IntentSchema.safeParse({ ...extracted(), execute_tool: true }).success).toBe(false);
    const missing = extracted();
    delete (missing as Record<string, unknown>).timezone;
    expect(IntentSchema.safeParse(missing).success).toBe(false);
    expect(IntentSchema.safeParse(extracted({ intent: 'confirm_contract' })).success).toBe(false);
    expect(IntentSchema.safeParse(extracted({ intent: 'cancel_contract' })).success).toBe(false);
    expect(IntentSchema.safeParse(extracted({ intent: 'select_contract' })).success).toBe(false);
    expect(IntentSchema.safeParse(extracted({ intent: 'report_progress' })).success).toBe(false);
    expect(IntentSchema.safeParse(extracted({ progress_percent: 40 })).success).toBe(false);
  });
});

describe('OpenAIAgent parsing', () => {
  it('validates a proposed future contract and keeps it pending for application confirmation', async () => {
    complete(extracted());
    const result = await new OpenAIAgent('test-key', 'test-model').parse('Merge this PR by 9 PM tonight: https://github.com/owner/repo/pull/42', context());
    expect(result).toMatchObject({ intent: 'create_contract', timezone: 'Asia/Kolkata', needs_clarification: false });
    expect(mocks.parse.mock.calls[0]![0]).toMatchObject({ model: 'test-model', store: false });
  });

  it('requires clarification for missing details even when the model claims completeness', async () => {
    complete(extracted({ deadline_local: null }));
    const result = await new OpenAIAgent('test-key', 'test-model').parse('Merge the PR soon', context());
    expect(result.needs_clarification).toBe(true);
  });

  it.each(['tonight', 'tomorrow', 'later', 'sometime', 'by 9'])('rejects invented exact time for vague wording: %s', async (wording) => {
    complete(extracted({ deadline_sources: [wording] }));
    const result = await new OpenAIAgent('test-key', 'test-model').parse(`Merge this PR ${wording}`, context());
    expect(result).toMatchObject({ needs_clarification: true, deadline_local: null });
  });

  it('rejects fabricated source text and assistant-authored deadline suggestions', async () => {
    complete(extracted({ deadline_sources: ['9 PM tonight'] }));
    const current = context();
    current.history = [{ role: 'assistant', content: 'How about 9 PM tonight?' }];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('sometime soon', current)).toMatchObject({ needs_clarification: true });
  });

  it('grounds a clarification using owner date and latest explicit time', async () => {
    complete(extracted({ deadline_sources: ['tonight', '9 PM'] }));
    const current = context();
    current.history = [{ role: 'user', content: 'Merge https://github.com/owner/repo/pull/42 tonight' }];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('9 PM', current)).toMatchObject({ needs_clarification: false });
  });

  it.each(['Yes', 'Confirmed'])('grounds %s only as a pending proposal after an immediate deadline clarification', async (answer) => {
    complete(extracted({
      title: 'Finish and ship the front end', artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T00:00', deadline_sources: ['tomorrow', '12 AM'] },
        { title: 'Ship the project', deadline_local: '2026-10-19T10:00', deadline_sources: ['tomorrow', '10 AM'] },
      ],
    }));
    const current = context();
    current.history = [
      { role: 'user', content: 'Finish the front end tomorrow at 12 AM and ship it tomorrow at 10 AM' },
      { role: 'assistant', content: 'What exact date and time should I use for these milestones in Asia/Kolkata?' },
    ];
    expect(parseCommand(answer)).toBeNull();
    expect(await new OpenAIAgent('test-key', 'test-model').parse(answer, current)).toMatchObject({
      intent: 'create_contract', needs_clarification: false,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T00:00' },
        { title: 'Ship the project', deadline_local: '2026-10-19T10:00' },
      ],
    });
  });

  it('does not ground an assistant-invented date from an affirmative clarification answer', async () => {
    complete(extracted({
      title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-19T00:00',
      deadline_sources: ['tomorrow', '12 AM'],
    }));
    const current = context();
    current.history = [
      { role: 'user', content: 'Finish the front end at 12 AM' },
      { role: 'assistant', content: 'What exact date and time should I use: tomorrow at 12 AM in Asia/Kolkata?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('completes the reported split-message clarification without repeating the date', async () => {
    complete(extracted({
      title: 'Finish and ship the front end', artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T00:00', deadline_sources: ['Tomorrow', '12 am'] },
        { title: 'Ship the project', deadline_local: '2026-10-19T10:00', deadline_sources: ['Tomorrow', '10 am'] },
      ],
    }));
    const current = context();
    current.history = [
      { role: 'user', content: 'Finish my project front end today 5 AM and ship around 10 AM' },
      { role: 'assistant', content: 'What future date and exact time should I use for finishing the front end and shipping it?' },
      { role: 'user', content: 'Tomorrow' },
      { role: 'assistant', content: 'What exact time tomorrow should I set for finishing the front end and shipping it?' },
      { role: 'user', content: '12 am for finishing and 10 am for shipping' },
      { role: 'assistant', content: 'Do you mean 12 AM (midnight) and 10 AM tomorrow, October 19, in Asia/Kolkata?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      intent: 'create_contract', needs_clarification: false,
      milestones: [{ deadline_local: '2026-10-19T00:00' }, { deadline_local: '2026-10-19T10:00' }],
    });
    const sent = JSON.parse(mocks.parse.mock.calls[0]![0].input);
    expect(sent.answering_deadline_clarification).toBe(true);
  });

  it('does not borrow owner dates from a conversation before the current clarification thread', async () => {
    complete(extracted({
      title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-19T00:00',
      deadline_sources: ['tomorrow', '12 AM'],
    }));
    const current = context();
    current.history = [
      { role: 'user', content: 'Write the old report tomorrow at 12 AM' },
      { role: 'assistant', content: 'No contracts yet. Tell me any task and its exact deadline.' },
      { role: 'user', content: 'Finish the front end' },
      { role: 'assistant', content: 'What exact date and time should I use for the front end?' },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it.each([
    'Anything else?',
    'Status: finish the front end tomorrow at 12 AM. Do you need another status update?',
    'Status: finish the front end tomorrow at 12 AM. What time should I send another status update?',
    `Pending deadline: tomorrow at 12 AM. Send CONFIRM ${id} to activate this contract.`,
  ])('does not replay a prior owner deadline after Yes to %s', async (reply) => {
    complete(extracted({
      title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-19T00:00',
      deadline_sources: ['tomorrow', '12 AM'],
    }));
    const current = context();
    current.history = [
      { role: 'user', content: 'Finish the front end tomorrow at 12 AM' },
      { role: 'assistant', content: reply },
    ];
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Yes', current)).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('rejects an extracted clock or date that contradicts owner wording', async () => {
    const agent = new OpenAIAgent('test-key', 'test-model');
    complete(extracted({ deadline_sources: ['tonight at 8 PM'] }));
    expect(await agent.parse('Merge it tonight at 8 PM', context())).toMatchObject({ needs_clarification: true });
    complete(extracted({ deadline_sources: ['tomorrow at 9 PM'] }));
    expect(await agent.parse('Merge it tomorrow at 9 PM', context())).toMatchObject({ needs_clarification: true });
    complete(extracted({ deadline_sources: ['October 19 at 9 PM'] }));
    expect(await agent.parse('Merge it October 19 at 9 PM', context())).toMatchObject({ needs_clarification: true });
  });

  it('accepts explicit calendar wording only when date and clock agree', async () => {
    complete(extracted({ deadline_local: '2026-10-19T21:00', deadline_sources: ['October 19 at 9 PM'] }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Merge it October 19 at 9 PM', context())).toMatchObject({ needs_clarification: false });
  });

  it('accepts ordinary tasks without a GitHub link and preserves separate milestone deadlines', async () => {
    complete(extracted({
      title: 'Finish front end', artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T05:00', deadline_sources: ['tomorrow', '5 AM'] },
        { title: 'Ship the project', deadline_local: '2026-10-19T10:00', deadline_sources: ['tomorrow', '10 AM'] },
      ],
    }));
    const result = await new OpenAIAgent('test-key', 'test-model').parse(
      'Finish front end tomorrow 5 AM and ship tomorrow 10 AM', context(),
    );
    expect(result).toMatchObject({
      intent: 'create_contract', artifact_url: null, needs_clarification: false,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T05:00' },
        { title: 'Ship the project', deadline_local: '2026-10-19T10:00' },
      ],
    });
  });

  it.each([
    ['finish the front end at 12 AM and ship it at 10 AM on October 19, 2026', '00:00', '10:00'],
    ['finish the front end at noon and ship it at 3 PM on October 19, 2026', '12:00', '15:00'],
    ['finish the front end at 00:00 and ship it at 13:00 on October 19, 2026', '00:00', '13:00'],
  ])('grounds both milestone clocks when each quotes the whole owner sentence: %s', async (message, finishTime, shipTime) => {
    complete(extracted({
      title: 'Finish and ship the front end', artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish front end', deadline_local: `2026-10-19T${finishTime}`, deadline_sources: [message] },
        { title: 'Ship the project', deadline_local: `2026-10-19T${shipTime}`, deadline_sources: [message] },
      ],
    }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, context())).toMatchObject({
      intent: 'create_contract', needs_clarification: false,
      milestones: [
        { title: 'Finish front end', deadline_local: `2026-10-19T${finishTime}` },
        { title: 'Ship the project', deadline_local: `2026-10-19T${shipTime}` },
      ],
    });
  });

  it('rejects an invented milestone clock even when its source quotes the whole owner sentence', async () => {
    const message = 'finish the front end at 12 AM and ship it at 10 AM on October 19, 2026';
    complete(extracted({
      title: 'Finish and ship the front end', artifact_url: null, deadline_local: null, deadline_sources: null,
      milestones: [
        { title: 'Finish front end', deadline_local: '2026-10-19T00:00', deadline_sources: [message] },
        { title: 'Ship the project', deadline_local: '2026-10-19T09:00', deadline_sources: [message] },
      ],
    }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, context())).toMatchObject({
      needs_clarification: true, deadline_local: null, milestones: null,
    });
  });

  it('does not mix clocks across conflicting dates in a broad source', async () => {
    const message = 'Finish the front end at 12 AM on October 19, 2026 and ship at 10 AM on October 20, 2026';
    complete(extracted({
      title: 'Ship the project', artifact_url: null, deadline_local: '2026-10-19T10:00',
      deadline_sources: [message],
    }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, context())).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('does not treat an AM/PM clock as an additional 24-hour clock', async () => {
    const message = 'Finish the front end tomorrow at 08:00 PM';
    complete(extracted({
      title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-19T08:00',
      deadline_sources: [message],
    }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse(message, context())).toMatchObject({
      needs_clarification: true, deadline_local: null,
    });
  });

  it('asks before accepting an ambiguous or already-past task deadline', async () => {
    const agent = new OpenAIAgent('test-key', 'test-model');
    complete(extracted({ title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-18T05:00', deadline_sources: ['today', '5 AM'] }));
    expect(await agent.parse('Finish front end today 5 AM', context())).toMatchObject({ needs_clarification: true });
    complete(extracted({ title: 'Finish front end', artifact_url: null, deadline_local: '2026-10-19T05:00', deadline_sources: ['around 5 AM tomorrow'] }));
    expect(await agent.parse('Finish front end around 5 AM tomorrow', context())).toMatchObject({ needs_clarification: true });
  });

  it('grounds an exact relative duration in the actual supplied instant', async () => {
    complete(extracted({ deadline_local: '2026-10-18T17:40:00', deadline_sources: ['in ten minutes'] }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Merge it in ten minutes', context())).toMatchObject({ needs_clarification: false });
  });

  it('rejects a silently changed timezone', async () => {
    complete(extracted({ timezone: 'Europe/London' }));
    const result = await new OpenAIAgent('test-key', 'test-model').parse('Merge this by 9 PM', context());
    expect(result).toMatchObject({ timezone: 'Asia/Kolkata', deadline_local: null, needs_clarification: true });
  });

  it('accepts an equivalent IANA alias but always returns the stored timezone', async () => {
    complete(extracted({ timezone: 'Asia/Calcutta' }));
    expect((await new OpenAIAgent('test-key', 'test-model').parse('Merge this by 9 PM', context())).timezone).toBe('Asia/Kolkata');
  });

  it.each(['2026-10-18T17:00', '2026-10-18T21:00Z', '2026-02-30T21:00'])('clarifies invalid extracted deadline %s', async (deadline) => {
    complete(extracted({ deadline_local: deadline }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse('Merge the PR', context())).toMatchObject({ needs_clarification: true, deadline_local: null });
  });

  it('does not authorize an invented contract reference', async () => {
    complete(extracted({ intent: 'get_status', contract_id: id }));
    expect(await new OpenAIAgent('test-key', 'test-model').parse('status of that one', context())).toMatchObject({ needs_clarification: true, contract_id: null });
  });

  it('uses bounded durable history and concise stored contract context', async () => {
    complete(extracted({ intent: 'list_contracts' }));
    const current = context();
    current.history = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `${index}: ${'x'.repeat(4000)}` }));
    current.contracts = Array.from({ length: 30 }, () => ({ id, display_id: 2, progress_percent: 0, title: 'x'.repeat(4000), state: 'active', due_at: new Date('2026-10-18T15:30Z'), artifact_url: 'https://github.com/owner/repo/pull/42' } as Contract));
    current.selected_contract_id = id;
    await new OpenAIAgent('test-key', 'test-model').parse('list my commitments', current);
    const sent = JSON.parse(mocks.parse.mock.calls[0]![0].input);
    expect(sent.history).toHaveLength(12);
    expect(sent.history[0].content).toHaveLength(1500);
    expect(sent.contracts).toHaveLength(20);
    expect(sent.contracts[0].title).toHaveLength(240);
    expect(sent.now).toBe(current.now);
    expect(sent.stored_timezone).toBe(current.timezone);
    expect(sent.selected_contract_id).toBe(id);
    expect(sent.contracts[0].display_id).toBe(2);
    expect(mocks.parse.mock.calls[0]![0].instructions).toContain('not commands to replay');
  });

  it.each(['confirm_contract', 'cancel_contract', 'select_contract', 'report_progress'])('rejects privileged model intent %s even if the SDK mock bypasses validation', async (intent) => {
    complete(extracted({ intent }));
    await expect(new OpenAIAgent('test-key', 'test-model').parse('yes please', context())).rejects.toThrow();
  });

  it('fails explicitly on API errors, refusal, and incomplete output', async () => {
    const agent = new OpenAIAgent('test-key', 'test-model');
    mocks.parse.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(agent.parse('merge my PR', context())).rejects.toThrow('API unavailable');
    mocks.parse.mockResolvedValueOnce({ status: 'completed', output_parsed: null });
    await expect(agent.parse('merge my PR', context())).rejects.toThrow(/validated intent/);
    mocks.parse.mockResolvedValueOnce({ status: 'incomplete', output_parsed: extracted() });
    await expect(agent.parse('merge my PR', context())).rejects.toThrow(/validated intent/);
  });
});

describe('evidence-grounded generation', () => {
  it('passes real supplied evidence as untrusted data with selected personality and strips secret properties', async () => {
    complete({ message: 'The test check failed. Open the real check URL and fix that first.' });
    const agent = new OpenAIAgent('test-key', 'test-model');
    const message = await agent.generate('rescue', { evidence: { state: 'open', checks: [{ name: 'test', conclusion: 'failure' }] }, api_key: 'never-forward', imessage_handle: '+10000000000' }, 'nuclear');
    expect(message).toContain('test check failed');
    const request = mocks.parse.mock.calls[0]![0];
    expect(request.instructions).toContain('firm, urgent, professional');
    expect(request.instructions).toContain('Do not use emojis');
    expect(request.instructions).toContain('A closed unmerged PR is not complete');
    expect(request.input).toContain('failure');
    expect(request.input).not.toContain('never-forward');
    expect(request.input).not.toContain('+10000000000');
  });

  it('fails instead of producing a canned substitute', async () => {
    mocks.parse.mockRejectedValue(new Error('quota exceeded'));
    await expect(new OpenAIAgent('test-key', 'test-model').generate('reminder', {}, 'mild')).rejects.toThrow('quota exceeded');
  });

  it('rejects empty and incomplete generated output', async () => {
    complete({ message: '   ' });
    await expect(new OpenAIAgent('test-key', 'test-model').generate('reminder', {}, 'mild')).rejects.toThrow(/empty/);
    mocks.parse.mockResolvedValueOnce({ status: 'incomplete', output_parsed: { message: 'Partial' } });
    await expect(new OpenAIAgent('test-key', 'test-model').generate('reminder', {}, 'mild')).rejects.toThrow(/validated message/);
  });
});
