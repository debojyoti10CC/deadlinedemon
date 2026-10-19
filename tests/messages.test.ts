import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activatedMessage, boardMessage, cancelledMessage, completionMessage, deletedMessage, hourlySummaryMessage, modeMessage, progressMessage, proposalMessage, publicRef, scheduledProblemMessage, selectedMessage, statusMessage, taskActionUnavailableMessage } from '../src/agent/messages.js';
import { GENERAL_HELP_REPLY, WELCOME_REPLY } from '../src/agent/help.js';
import { taskState } from '../src/agent/presentation.js';
import { taskReminder, taskSummary } from '../src/contracts/tasks.js';
import type { GitHubContract, Intensity, TaskContract, User } from '../src/types.js';

const user: User = {
 id: 'user', imessage_handle: 'owner', timezone: 'Asia/Kolkata', intensity: 'mild',
 paused: false, space_id: 'space', selected_contract_id: null,
};
function task(overrides: Partial<TaskContract> = {}): TaskContract {
 return {
  id: 'c823f849-ff6c-4e41-8181-01c5e065e191', user_id: user.id, display_id: 1,
  title: 'Finish the design', due_at: new Date('2026-10-18T23:30:00Z'), state: 'active',
  progress_percent: 0, intensity: 'mild', created_at: new Date('2026-10-18T12:00:00Z'),
  confirmed_at: new Date('2026-10-18T12:01:00Z'), completed_at: null,
  last_checked_at: null, last_observed_state: null, version: 1, missed_at: null,
  artifact_type: 'task', repo_owner: null, repo_name: null, artifact_number: null, artifact_url: null,
  ...overrides,
 };
}
function github(): GitHubContract {
 return { ...task(), artifact_type: 'pull_request', repo_owner: 'owner', repo_name: 'repo', artifact_number: 42, artifact_url: 'https://github.com/owner/repo/pull/42' };
}

beforeEach(() => {
 vi.useFakeTimers();
 vi.setSystemTime(new Date('2026-10-18T23:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('compact iMessage cards', () => {
 it('keeps greetings separate from the full command reference',()=>{
  expect(WELCOME_REPLY.length).toBeLessThan(GENERAL_HELP_REPLY.length);
  expect(WELCOME_REPLY).toContain('Any task');expect(WELCOME_REPLY).toContain('GitHub link optional');
  expect(WELCOME_REPLY).toContain('HELP');expect(WELCOME_REPLY).not.toContain('CANCEL 1');
 });
 it('offers five readable proposals with short IDs and one exact confirmation each', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task({ display_id: index + 1, state: 'pending', title: 'A long task title '.repeat(16) }));
  const message = proposalMessage(tasks, user);
  expect(message.length).toBeLessThanOrEqual(1200);
  expect(message).not.toContain(tasks[0]!.id);
  expect(message.match(/CONFIRM \d/g)).toHaveLength(5);
  expect(message.match(/Asia\/Kolkata/g)).toHaveLength(1);
  expect(message).toContain('19 Oct 2026, 5:00 AM');
  expect(message).toContain('Reminders start after confirmation');
  expect(message).not.toMatch(/\*\*|<br|<div/);
 });

 it('uses only public references through every normal ordinary-task view', () => {
  const c = task({ progress_percent: 40 });
  const messages = [proposalMessage([c], user), selectedMessage(c, user), activatedMessage(c, user),
   boardMessage([c], user), progressMessage(c, user), cancelledMessage(c, user), taskSummary(c, user.timezone)];
  expect(publicRef(c)).toBe('#1');
  for (const message of messages) {
   expect(message).toContain('#1');
   expect(message).not.toContain(c.id);
   expect(message.match(/Asia\/Kolkata/g)).toHaveLength(1);
  }
 });

 it('marks selection and paused reminders without changing the actual task mode', () => {
  const c = task({ intensity: 'nuclear' });
  const owner = { ...user, selected_contract_id: c.id, paused: true };
  expect(boardMessage([c], owner)).toContain('#1 · Finish the design [selected]');
  expect(boardMessage([c], owner)).toContain('PAUSED');
  expect(activatedMessage(c, owner)).toContain('Task activated · NUCLEAR');
  expect(activatedMessage(c, owner)).toContain('RESUME');
  expect(cancelledMessage(c, owner)).toContain('Future reminders stopped');
  expect(cancelledMessage(c, owner)).not.toContain('DONE 1');
 });

 it('keeps the greeting concise and teaches modes, numbers, and owner reporting', () => {
  expect(GENERAL_HELP_REPLY.length).toBeLessThan(450);
  for (const term of ['Any task', 'MILD', 'SAVAGE', 'NUCLEAR', 'PROGRESS 1 50', 'self-reported']) expect(GENERAL_HELP_REPLY).toContain(term);
 });

 it('keeps every current task and only the three newest history cards on the board', () => {
  const current = Array.from({ length: 10 }, (_, index) => task({ display_id: index + 1, title: `Current task ${index + 1}` }));
  const history = Array.from({ length: 8 }, (_, index) => task({ display_id: index + 11, state: 'completed', title: `History task ${index + 11}`, completed_at: new Date(`2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z`) }));
  const message = boardMessage([...history, ...current], user);
  for (const c of current) expect(message).toContain(c.title);
  expect(message).toContain('History task 18');
  expect(message).toContain('History task 16');
  expect(message).not.toContain('History task 15');
  expect(message).toContain('+ 5 older tasks in history');
  expect(message.indexOf('Current task 1')).toBeLessThan(message.indexOf('Recent history'));
 });
});

describe('message presentation contract',()=>{
 it.each(['mild','savage','nuclear'] as const)('keeps every %s reply professional without decorative emojis',intensity=>{
  const c=task({intensity,progress_percent:27});const owner={...user,intensity};
  const completed={...c,state:'completed' as const,progress_percent:100};
  const cancelled={...c,state:'cancelled' as const};
  const replies=[WELCOME_REPLY,GENERAL_HELP_REPLY,proposalMessage([{...c,state:'pending'}],owner),
   selectedMessage(c,owner),statusMessage(c,owner),activatedMessage(c,owner),progressMessage(c,owner),
   boardMessage([c,completed],owner),hourlySummaryMessage([c],owner),modeMessage(intensity),
   completionMessage(completed,owner),completionMessage(completed,owner,true),cancelledMessage(cancelled,owner),
   taskActionUnavailableMessage(cancelled,owner,'DONE'),deletedMessage({...c,deleted_at:new Date()},owner),scheduledProblemMessage(3,true),scheduledProblemMessage(3,false)];
  for(const reply of replies){
   expect(reply).not.toMatch(/\p{Extended_Pictographic}|\uFE0F/gu);
   expect(reply).not.toMatch(/court|plot development|season finale|roast|left the chat/iu);
  }
  expect(statusMessage(c,owner)).toContain('Due:');
  expect(statusMessage(c,owner)).toContain('Time remaining:');
  expect(statusMessage(c,owner)).toContain('27%');
 });
 it('uses a single task reference and title per acknowledgement instead of stacking duplicate cards',()=>{
  const c=task({progress_percent:27});
  const completed=task({state:'completed',progress_percent:100});
  for(const message of [selectedMessage(c,user),progressMessage(c,user),completionMessage(completed,user),cancelledMessage(c,user)]){
   expect(message.match(/#1\b/g)).toHaveLength(1);
   expect(message.match(/Finish the design/g)).toHaveLength(1);
   expect(message).not.toMatch(/\n{3,}|<number>|\*\*|```/);
  }
 });
 it('declares reporting once for a multi-task board and keeps every exact percentage',()=>{
  const rows=[task({display_id:1,progress_percent:27}),task({id:'another',display_id:2,progress_percent:83})];
  for(const message of [boardMessage(rows,user),hourlySummaryMessage(rows,user)]){
   expect(message.match(/HP = progress you report\./g)).toHaveLength(1);
   expect(message.match(/^HP [▰▱]{10} \d+%$/gm)).toHaveLength(2);
   expect(message).toContain('27%');expect(message).toContain('83%');
   expect(message.match(/Asia\/Kolkata/g)).toHaveLength(1);
  }
 });
 it('uses the supplied snapshot clock through the whole card and preserves all data',()=>{
  const c=task({progress_percent:27});const before=structuredClone(c);
  vi.setSystemTime(new Date('2030-01-01T00:00Z'));
  const snapshot=new Date('2026-10-18T23:00Z');
  for(const message of [selectedMessage(c,user,snapshot),statusMessage(c,user,snapshot),progressMessage(c,user,snapshot),hourlySummaryMessage([c],user,snapshot)]){
   expect(message).toContain('ACTIVE');expect(message).toContain('30m left');
   expect(message).not.toContain('DEADLINE PASSED');
  }
  expect(c).toEqual(before);
 });
 it('dates cached GitHub observations without implying a fresh integration request',()=>{
  const c={...github(),last_observed_state:{artifact:github(),observedAt:'2026-10-18T22:00:00Z',title:'PR',state:'open',mergedAt:null,closedAt:null,headSha:null,mergeable:null,draft:null,checks:[],reviews:[],files:[],limitations:[]}};
  for(const message of [statusMessage(c,user),hourlySummaryMessage([c],user)]){
   expect(message).toContain('Last GitHub observation: open');
   expect(message).toContain('Observed 19 Oct 2026, 3:30 AM');
   expect(message).not.toMatch(/freshly verified|just checked|HP/);
  }
 });
 it('makes a terminal saved selection visible without changing it or hiding unfinished work',()=>{
  const done=task({state:'completed',progress_percent:100});
  const next=task({id:'next',display_id:3,title:'Next task',progress_percent:27});
  const owner={...user,selected_contract_id:done.id};
  const message=boardMessage([done,next],owner);
  expect(message).toContain('#1 · Finish the design [selected]');expect(message).toContain('#3 · Next task');
  expect(message).toContain('Selected #1 is completed. SELECT 3 to switch.');
  expect(owner.selected_contract_id).toBe(done.id);
 });
 it('keeps scheduled failure copy task-specific and free of UUIDs or fabricated completion',()=>{
  for(const github of [false,true]){
   const message=scheduledProblemMessage(3,github);
   expect(message).toContain('#3');expect(message).toContain('retry automatically');
   expect(message.length).toBeLessThan(200);expect(message).not.toContain('completed');
  }
  expect(scheduledProblemMessage(3,true)).toContain('Completion is still unverified');
  expect(scheduledProblemMessage(3,false)).not.toContain('GitHub');
 });
});

describe('task-specific removal presentation',()=>{
 it('acknowledges only the removed task, retains history, and never exposes a database identifier',()=>{
  const removed=task({display_id:8,title:'Prepare the old checklist',deleted_at:new Date()});
  const snapshot=structuredClone(removed);
  for(const already of [false,true]){
   const message=deletedMessage(removed,user,already);
   expect(message).toContain(already?'#8 already removed':'#8 removed');
   expect(message.match(/#8\b/g)).toHaveLength(1);
   expect(message.match(/Prepare the old checklist/g)).toHaveLength(1);
   expect(message).toContain('Task reminders stopped');
   expect(message).toContain('saved history retained');
   expect(message).toContain('LIST');
   expect(message).not.toMatch(/permanently|CONFIRM|PROGRESS|DONE|SELECT|DELETE|#1\b/);
   expect(message).not.toContain(removed.id);
   expect(message.length).toBeLessThan(240);
  }
  expect(removed).toEqual(snapshot);
 });

 it('omits removed tasks from raw proposal, board, and hourly fixtures regardless of their saved state',()=>{
  const visible=task({display_id:9,id:'visible-task',title:'Current visible task'});
  const removed=(['pending','active','missed','completed','cancelled'] as const).map((state,index)=>task({
   id:`removed-${index}`,display_id:index+1,state,title:`Removed private task ${index}`,deleted_at:new Date(),
  }));
  const rows=[...removed,visible];const snapshot=structuredClone(rows);
  const owner={...user,selected_contract_id:removed[1]!.id};
  for(const message of [proposalMessage(rows,owner),boardMessage(rows,owner),hourlySummaryMessage(rows,owner)]){
   expect(message).toContain('Current visible task');
   expect(message).not.toContain('Removed private task');
   expect(message).not.toContain('[selected]');
   expect(message).not.toMatch(/(?:CONFIRM|DONE|PROGRESS|STATUS|DELETE|SELECT) [1-5]\b/);
  }
  for(const message of [boardMessage(rows,owner),hourlySummaryMessage(rows,owner)])expect(message).toContain('1 unfinished');
  expect(boardMessage(removed,owner)).toContain('No tasks yet');
  expect(hourlySummaryMessage(removed,owner)).toContain('No unfinished tasks');
  expect(proposalMessage(removed,owner)).toContain('Send a task');
  expect(rows).toEqual(snapshot);
 });

 it('keeps direct views on an already removed target without offering an action or claiming a fresh update',()=>{
  for(const artifact of [task(),github()]){
   const removed={...artifact,display_id:8,deleted_at:new Date()};
   const messages=[selectedMessage(removed,user),statusMessage(removed,user),activatedMessage(removed,user),
    progressMessage(removed,user),completionMessage(removed,user),cancelledMessage(removed,user),
    taskActionUnavailableMessage(removed,user,'CONFIRM')];
   for(const message of messages){
    expect(message).toContain('#8 already removed');
    expect(message).not.toMatch(/Task activated|Progress recorded|Completion recorded|CONFIRM|PROGRESS|DONE|DELETE|RESCUE/);
   }
  }
 });

 it('gives deletion precedence over every prior state and offers exact-number controls only on saved tasks',()=>{
  for(const state of ['pending','active','missed','completed','cancelled'] as const){
   expect(taskState(task({state,deleted_at:new Date()}))).toBe('DELETED');
  }
  expect(GENERAL_HELP_REPLY).toContain('DELETE 1 — remove from board');
  expect(proposalMessage([task({display_id:8,state:'pending'})],user)).toContain('DELETE 8');
  for(const c of [task({display_id:8}),{...github(),display_id:8}]){
   for(const message of [selectedMessage(c,user),statusMessage(c,user)])expect(message).toContain('DELETE 8');
  }
  expect(hourlySummaryMessage([task()],user)).not.toContain('DELETE');
 });
});

describe('honest task HP and state', () => {
 it('shows an expired draft with a deadline edit instead of asking for activation', () => {
  const expired=task({state:'pending',due_at:new Date('2000-01-01T00:00Z')});
  const message=selectedMessage(expired,user);
  expect(message).toContain('DRAFT · deadline passed');
  expect(message).toContain('MOVE 1 YYYY-MM-DD HH:mm');
  expect(message).not.toContain('CONFIRM 1');
  expect(message).toContain('Already finished? DONE 1');
  expect(message).toContain('Update: PROGRESS 1 50');
 });
 it('starts empty, displays exact reported progress, and does not infer it from time', () => {
  expect(taskSummary(task(), user.timezone)).toContain('HP ▱▱▱▱▱▱▱▱▱▱ 0%\nProgress · self-reported');
  const c = task({ progress_percent: 37 });
  expect(taskSummary(c, user.timezone)).toContain('HP ▰▰▰▱▱▱▱▱▱▱ 37%\nProgress · self-reported');
  const reminder = taskReminder(c, user.timezone, new Date('2026-10-19T00:00:00Z'));
  expect(reminder).toContain('completion unreported');
  expect(reminder).toContain('37%');
  expect(c.state).toBe('active');
  expect(c.progress_percent).toBe(37);
 });

 it('shows full HP only for the reported value or completion and keeps DONE explicit', () => {
  const uncompleted = task({ progress_percent: 100 });
  expect(taskSummary(uncompleted, user.timezone)).toContain('ACTIVE');
  expect(taskSummary(uncompleted, user.timezone)).toContain('DONE 1');
  const completed = task({ state: 'completed', progress_percent: 0, missed_at: new Date('2026-10-18T23:30:00Z') });
  const message = progressMessage(completed, user);
  expect(message).toContain('COMPLETED LATE — self-reported');
  expect(message).toContain('HP ▰▰▰▰▰▰▰▰▰▰ 100%');
  expect(message).not.toContain('DONE 1');
  expect(taskSummary(task({ state: 'pending', due_at: new Date('2099-01-01T00:00Z') }), user.timezone)).toContain('CONFIRM 1');
  expect(taskSummary(task({ state: 'cancelled' }), user.timezone)).not.toContain('DONE 1');
 });

 it('never invents HP, merge proof, or issue delivery proof for GitHub targets', () => {
  const c = github();
  for (const message of [proposalMessage([c], user), selectedMessage(c, user), activatedMessage(c, user), boardMessage([c], user)]) {
   expect(message).not.toContain('HP');
   expect(message).not.toContain('self-reported');
   expect(message).not.toMatch(/merged|verified|checks passed/i);
  }
  expect(progressMessage(c, user)).toContain('uses GitHub evidence');
  expect(progressMessage(c, user)).not.toContain('40%');
 });
});

describe('contextual task replies', () => {
 it('shows terminal task details without claiming or changing selection', () => {
  const owner = { ...user, selected_contract_id: 'another-task' };
  for (const state of ['completed', 'cancelled'] as const) {
   const c = task({ state });
   const message = statusMessage(c, owner);
   expect(message).toContain('Task details');
   expect(message).toContain('#1 · Finish the design');
   expect(message).toContain(state.toUpperCase());
   expect(message).toContain('LIST to see your other tasks');
   expect(message).not.toMatch(/Selected|CONFIRM 1|DONE 1/);
   expect(message).not.toContain(c.id);
   expect(owner.selected_contract_id).toBe('another-task');
  }
 });

 it('shows a passed deadline immediately, before the scheduler updates the active state', () => {
  const c = task({ due_at: new Date('2026-10-18T22:00Z'), progress_percent: 27 });
  const message = selectedMessage(c, user);
  expect(message).toContain('DEADLINE PASSED — completion unreported');
  expect(message).toContain('27%\nProgress · self-reported');
  expect(message).toContain('DONE 1');
  expect(c.state).toBe('active');
  const evidenceTask = { ...github(), due_at: c.due_at };
  expect(boardMessage([evidenceTask], user)).toContain('DEADLINE PASSED · proof not recorded');
  expect(boardMessage([evidenceTask], user)).not.toContain('completion unreported');
 });

 it('keeps a progress update on an unconfirmed task visibly a draft', () => {
  const pending = task({ state: 'pending', confirmed_at: null, progress_percent: 27 });
  const message = progressMessage(pending, user);
  expect(message).toContain('Progress recorded · #1');
  expect(message).toContain('DRAFT · awaiting confirmation');
  expect(message).toContain('27%\nProgress · self-reported');
  expect(message).toContain('CONFIRM 1 to start reminders');
  expect(message).toContain('DONE 1');
  expect(message).not.toContain('ACTIVE');
 });

 it('acknowledges a completed unconfirmed task with full HP and no remaining draft action', () => {
  const completed = task({ state: 'completed', confirmed_at: null, missed_at: task().due_at, completed_at: new Date('2026-10-19T00:00Z') });
  const message = completionMessage(completed, user);
  expect(message).toContain('Completion recorded · #1');
  expect(message).toContain('COMPLETED LATE — self-reported');
  expect(message).toContain('HP ▰▰▰▰▰▰▰▰▰▰ 100%');
  expect(message).toContain('No more reminders for this task');
  expect(message).not.toMatch(/CONFIRM 1|DONE 1|MOVE 1|PROGRESS 1/);
  expect(message).not.toContain(completed.id);
 });

 it('explains a repeated action on a completed task without presenting another task', () => {
  const completed = task({ state: 'completed', display_id: 7 });
  const message = taskActionUnavailableMessage(completed, user, 'verify_completion');
  expect(message).toContain('Already completed · #7');
  expect(message).not.toContain('Choose a task');
  expect(message).not.toContain('CONFIRM');
  expect(message).not.toContain('#1');
 });

 it('explains a cancelled task without claiming to cancel it again or allowing a progress update', () => {
  const cancelled = task({ state: 'cancelled', progress_percent: 27 });
  const message = taskActionUnavailableMessage(cancelled, user, 'report_progress');
  expect(message).toContain('#1 is cancelled');
  expect(message).toContain('27%\nProgress · self-reported');
  expect(message).toContain('new task + deadline');
  expect(message).not.toMatch(/Progress recorded|Completion recorded|CONFIRM 1|DONE 1/);
 });

 it('explains the evidence requirement for an unconfirmed GitHub task', () => {
  const draft = { ...github(), state: 'pending' as const, confirmed_at: null };
  const message = taskActionUnavailableMessage(draft, user, 'verify_completion');
  expect(message).toContain('GitHub draft hasn’t started monitoring');
  expect(message).toContain('CONFIRM 1 to start checks');
  expect(message).toContain('GitHub PR owner/repo#42');
  expect(message).not.toContain('HP');
  expect(message).not.toContain('DONE 1');
 });

 it('offers an expired GitHub draft a new deadline before confirmation', () => {
  const draft = { ...github(), state: 'pending' as const, due_at: new Date('2000-01-01T00:00Z') };
  const message = taskActionUnavailableMessage(draft, user, 'verify_completion');
  expect(message).toContain('DRAFT · deadline passed');
  expect(message).toContain('New deadline: MOVE 1 YYYY-MM-DD HH:mm');
  expect(message).toContain('Then CONFIRM 1');
  expect(message).not.toContain('Choose a task');
 });

 it('acknowledges an already confirmed task without offering activation again', () => {
  const message = taskActionUnavailableMessage(task(), user, 'confirm_contract');
  expect(message).toContain('#1 has already been confirmed');
  expect(message).toContain('ACTIVE');
  expect(message).not.toContain('CONFIRM 1');
 });

 it('uses concrete task numbers in board guidance and keeps new task dates unambiguous', () => {
  const c = task({ display_id: 4, due_at: new Date('2027-10-18T23:30Z') });
  const message = boardMessage([c], user);
  expect(message).toContain('STATUS 4');
  expect(message).toContain('19 Oct 2027, 5:00 AM');
  expect(message).not.toContain('<number>');
  expect(message).not.toContain('CONFIRM 4');
 });
});

describe('distinct deterministic reminder voices', () => {
 it('changes the reminder itself for each intensity while preserving the same facts', () => {
  const modes: Intensity[] = ['mild', 'savage', 'nuclear'];
  const before = new Date('2026-10-18T23:00:00Z');
  const after = new Date('2026-10-19T00:00:00Z');
  const reminders = modes.map(intensity => taskReminder(task({ intensity, progress_percent: 20 }), user.timezone, before));
  expect(new Set(reminders).size).toBe(3);
  for(const reminder of reminders)expect(reminder).not.toMatch(/\p{Extended_Pictographic}|season finale|Deadline court|plot development/iu);
  for (const intensity of modes) {
   const c = task({ intensity, progress_percent: 20 });
   const message = taskReminder(c, user.timezone, after, true);
   expect(message).toBe(taskReminder(c, user.timezone, after, true));
   expect(message).toContain('Follow-up');
   expect(message).toContain('completion unreported');
   expect(message).toContain('20%');
   expect(message).not.toContain(c.id);
   expect(modeMessage(intensity)).toContain(`${intensity.toUpperCase()} selected`);
   expect(modeMessage(intensity)).toContain('Voice preview');
   expect(modeMessage(intensity)).toContain('current and new tasks');
  }
 });

 it('does not accuse completed or cancelled tasks of missing their deadline', () => {
  for (const state of ['completed', 'cancelled'] as const) {
   const message = taskReminder(task({ state, intensity: 'nuclear' }), user.timezone, new Date('2026-10-20T00:00:00Z'));
   expect(message).not.toContain('unreported');
   expect(message).not.toContain('Submit your update');
  }
 });
});

describe('hourly task check-in', () => {
 const now = new Date('2026-10-18T23:00:00Z');

 it('includes every unfinished task, ordered by stable number, with exact local deadlines and honest HP', () => {
  const pending = task({ display_id: 1, state: 'pending' });
  const active = task({ display_id: 2, progress_percent: 37 });
  const missed = task({ display_id: 3, state: 'missed', progress_percent: 20 });
  const completed = task({ display_id: 4, state: 'completed', title: 'Completed title' });
  const cancelled = task({ display_id: 5, state: 'cancelled', title: 'Cancelled title' });
  const message = hourlySummaryMessage([missed, completed, active, cancelled, pending], user, now);
  expect(message).toContain('Hourly check-in · MILD');
  expect(message).toContain('DRAFT · awaiting confirmation');
  expect(message).toContain('ACTIVE');
  expect(message).toContain('DEADLINE PASSED — completion unreported');
  expect(message.match(/19 Oct 2026, 5:00 AM/g)).toHaveLength(3);
  expect(message.match(/Asia\/Kolkata/g)).toHaveLength(1);
  expect(message).toContain('HP ▰▰▰▱▱▱▱▱▱▱ 37%');
  expect(message).toContain('HP ▱▱▱▱▱▱▱▱▱▱ 0%');
  expect(message.match(/HP = progress you report\./g)).toHaveLength(1);
  expect(message).toContain('PROGRESS 2 50 · DONE 2');
  expect(message).toContain('CONFIRM 1');
  expect(message.indexOf('#1')).toBeLessThan(message.indexOf('#2'));
  expect(message.indexOf('#2')).toBeLessThan(message.indexOf('#3'));
  expect(message).not.toContain('Completed title');
  expect(message).not.toContain('Cancelled title');
  expect(message).not.toContain(active.id);
 });

 it('uses the supplied clock for overdue tasks and expired drafts without changing their state or HP', () => {
  const active = task({ progress_percent: 37 });
  const pending = task({ display_id: 2, state: 'pending' });
  const after = new Date('2026-10-19T00:00:00Z');
  const message = hourlySummaryMessage([active, pending], user, after);
  expect(message).toContain('DEADLINE PASSED — completion unreported');
  expect(message).toContain('DRAFT · deadline passed');
  expect(message).toContain('MOVE 2 YYYY-MM-DD HH:mm');
  expect(message).not.toContain('CONFIRM 2');
  expect(message).toContain('37%');
  expect(message).toContain('HP = progress you report.');
  expect(active.state).toBe('active');
  expect(active.progress_percent).toBe(37);
  expect(pending.state).toBe('pending');
 });

 it('shows cached GitHub evidence rather than invented HP or fresh verification', () => {
  const c = github();
  const first = hourlySummaryMessage([c], user, now);
  expect(first).toContain('GitHub PR owner/repo#42');
  expect(first).toContain('GitHub evidence: not checked yet');
  expect(first).not.toContain('HP');
  expect(first).not.toContain('PROGRESS');
  expect(first).not.toContain('DONE');
  const observed = { ...c, last_observed_state: { artifact: c, observedAt: now.toISOString(), title: c.title, state: 'open', mergedAt: null, closedAt: null, headSha: null, mergeable: null, draft: null, checks: [], reviews: [], files: [], limitations: [] } };
  expect(hourlySummaryMessage([observed], user, now)).toContain('Last GitHub observation: open');
  const overdue = hourlySummaryMessage([c], user, new Date('2026-10-19T00:00:00Z'));
  expect(overdue).toContain('DEADLINE PASSED · proof not recorded');
  expect(overdue).not.toContain('completion unreported');
 });

 it('keeps a reopened issue open when a prior closure timestamp remains in cached evidence', () => {
  const c = { ...github(), artifact_type: 'issue' as const, artifact_url: 'https://github.com/owner/repo/issues/42' };
  const observed = { ...c, last_observed_state: { artifact: c, observedAt: now.toISOString(), title: c.title, state: 'open', mergedAt: null, closedAt: '2026-10-17T12:00:00Z', headSha: null, mergeable: null, draft: null, checks: [], reviews: [], files: [], limitations: [] } };
  const message = hourlySummaryMessage([observed], user, now);
  expect(message).toContain('Last GitHub observation: open');
  expect(message).not.toContain('Last GitHub observation: closed');
 });

 it('keeps all current tasks and compacts long titles without adding a control menu', () => {
  const rows = Array.from({ length: 14 }, (_, index) => task({ display_id: index + 1, title: `${index + 1} ${'Title '.repeat(40)}` }));
  const message = hourlySummaryMessage(rows, user, now);
  for (const c of rows) expect(message).toContain(`#${c.display_id} · `);
  expect(message.match(/^HP [▰▱]/gm)).toHaveLength(14);
  expect(message).not.toContain(rows[0]!.title);
  expect(message).toContain('…');
  expect(message).not.toContain('SELECT');
  expect(message).not.toContain('CANCEL');
 });

 it('uses a distinct deterministic voice for every intensity and explains paused reminders', () => {
  const messages = (['mild', 'savage', 'nuclear'] as const).map(intensity => hourlySummaryMessage([task()], { ...user, intensity }, now));
  expect(new Set(messages).size).toBe(3);
  expect(messages[0]).toContain('Review your progress');
  expect(messages[1]).toContain('record a progress update');
  expect(messages[2]).toContain('Deadline review');
  expect(hourlySummaryMessage([task()], { ...user, paused: true }, now)).toContain('Reminders paused · RESUME');
 });

 it('returns an empty-board message when no unfinished tasks remain', () => {
  const message = hourlySummaryMessage([task({ state: 'completed' }), task({ state: 'cancelled' })], user, now);
  expect(message).toContain('No unfinished tasks');
  expect(message).not.toContain('HP');
  expect(message).not.toContain('PROGRESS');
 });
});
