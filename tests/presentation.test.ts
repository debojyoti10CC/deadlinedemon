import { describe, expect, it, vi } from 'vitest';
import { deadlineText, displayTitle, hpLine, publicRef, remainingTime, taskState } from '../src/agent/presentation.js';
import { githubDeadlineAlert, taskActions, taskCard, taskReminder, taskSummary } from '../src/contracts/tasks.js';
import type { GitHubContract, TaskContract } from '../src/types.js';

const now = new Date('2026-10-19T01:00:00Z');
const due = new Date('2026-10-19T07:45:00Z');
function task(overrides: Partial<TaskContract> = {}): TaskContract {
 return {
  id: 'c823f849-ff6c-4e41-8181-01c5e065e191', user_id: 'owner', display_id: 3,
  title: 'Finish the design', due_at: due, state: 'active', progress_percent: 27,
  intensity: 'mild', created_at: now, confirmed_at: now, completed_at: null,
  last_checked_at: null, last_observed_state: null, version: 1, missed_at: null,
  artifact_type: 'task', repo_owner: null, repo_name: null, artifact_number: null, artifact_url: null,
  ...overrides,
 };
}
function github(): GitHubContract {
 return { ...task(), artifact_type: 'pull_request', repo_owner: 'owner', repo_name: 'repo', artifact_number: 42, artifact_url: 'https://github.com/owner/repo/pull/42' };
}

describe('shared mobile card facts', () => {
 it('uses a stable public number and collapses multiline titles', () => {
  const c = task({ title: '  Finish\n\t the   design   ' });
  expect(publicRef(c)).toBe('#3');
  expect(displayTitle(c)).toBe('Finish the design');
  expect(taskCard(c, 'Asia/Kolkata', now).split('\n')[0]).toBe('#3 · Finish the design');
  expect(taskCard(c, 'Asia/Kolkata', now)).not.toContain(c.id);
 });

 it('shortens at grapheme boundaries instead of splitting a family emoji or accent', () => {
  const family = '👨‍👩‍👧‍👦';
  expect(displayTitle(task({ title: `${family} cafe\u0301 notes` }), 3)).toBe(`${family} …`);
  expect(displayTitle(task({ title: `e\u0301${family}end` }), 3)).toBe(`e\u0301${family}…`);
  expect(displayTitle(task({ title: 'one' }), 1)).toBe('…');
  expect(displayTitle(task(), 0)).toBe('');
  expect(displayTitle(task({ title: '\n\t ' }))).toBe('Untitled task');
 });

 it.each([
  [0, 0], [9, 0], [10, 1], [27, 2], [99, 9], [100, 10], [-10, 0], [110, 10], [NaN, 0],
 ])('keeps ten blocks and exact bounded progress for %s percent', (reported, filled) => {
  const line = hpLine(task({ progress_percent: reported }));
  expect(line.match(/[▰▱]/gu)).toHaveLength(10);
  expect(line.match(/▰/gu)?.length ?? 0).toBe(filled);
  expect(line).toContain('self-reported');
 });

 it('shows exact progress independent of the clock, with explicit compact provenance control', () => {
  const c = task();
  expect(hpLine(c)).toBe('HP ▰▰▱▱▱▱▱▱▱▱ 27% · self-reported');
  expect(hpLine(c, true)).toBe('HP ▰▰▱▱▱▱▱▱▱▱ 27%');
  expect(hpLine(task({ state: 'completed' }))).toContain('▰▰▰▰▰▰▰▰▰▰ 100%');
  expect(taskCard(c, 'Asia/Kolkata', new Date('2026-10-20T00:00Z'))).toContain('27%');
  expect(c.progress_percent).toBe(27);
 });

 it('distinguishes clock boundaries, owner reports, and GitHub proof', () => {
  expect(taskState(task(), now)).toBe('ACTIVE');
  expect(taskState(task(), due)).toBe('DEADLINE PASSED — completion unreported');
  expect(taskState(task({ state: 'pending' }), due)).toBe('DRAFT · deadline passed');
  expect(taskState(task({ state: 'pending' }), now)).toBe('DRAFT · awaiting confirmation');
  expect(taskState(task({ state: 'completed', missed_at: due }), now)).toBe('COMPLETED LATE — self-reported');
  expect(taskState(github(), due)).toBe('DEADLINE PASSED · proof not recorded');
  expect(taskState({ ...github(), state: 'completed' }, due)).toBe('COMPLETED');
  expect(taskState(task({ state: 'cancelled' }), due)).toBe('CANCELLED');
 });

 it('formats explicit local deadlines with year and meridiem', () => {
  expect(deadlineText(due, 'Asia/Kolkata')).toBe('19 Oct 2026, 1:15 PM');
  expect(deadlineText(new Date('2026-10-18T18:30Z'), 'Asia/Kolkata')).toBe('19 Oct 2026, 12:00 AM');
  expect(deadlineText(new Date('invalid'), 'Asia/Kolkata')).toBe('Deadline unavailable');
  expect(deadlineText(due, 'Invalid/Timezone')).toBe('Deadline unavailable');
 });

 it.each([
  [0, 'Due now'], [1, 'less than 1m left'], [59_999, 'less than 1m left'],
  [-1, 'less than 1m overdue'], [-59_999, 'less than 1m overdue'],
  [60_000, '1m left'], [-60_000, '1m overdue'],
  [24_300_000, '6h 45m left'], [-7_200_000, '2h overdue'],
  [86_400_000, '1d left'], [93_600_000, '1d 2h left'],
 ])('gives a factual countdown at offset %s', (offset, expected) => {
  expect(remainingTime(new Date(now.getTime() + offset), now)).toBe(expected);
 });

 it('does not leak invalid date text from countdowns', () => {
  expect(remainingTime(new Date('invalid'), now)).toBe('Deadline unavailable');
  expect(remainingTime(due, new Date('invalid'))).toBe('Deadline unavailable');
 });
});

describe('task snapshots and concise action footers', () => {
 it('separates facts from controls and offers a reference-free acknowledgement body', () => {
  const c = task();
  const card = taskCard(c, 'Asia/Kolkata', now);
  expect(card).toContain('6h 45m left');
  expect(card).toContain('Due: 19 Oct 2026, 1:15 PM (Asia/Kolkata)');
  expect(card).toContain('Time remaining: 6h 45m left');
  expect(card).not.toMatch(/PROGRESS|DONE|RESCUE|CONFIRM|MOVE/);
  expect(taskCard(c, 'Asia/Kolkata', now, false).split('\n')[0]).toBe(c.title);
  expect(taskCard(c, 'Asia/Kolkata', now, false)).not.toContain('#3');
  expect(taskSummary(c, 'Asia/Kolkata', now)).toBe(`${card}\n\n${taskActions(c, now)}`);
 });

 it.each(['active', 'missed', 'pending', 'completed', 'cancelled'] as const)('keeps %s controls scoped and at most two lines', state => {
  const c = task({ state });
  const actions = taskActions(c, now);
  expect(actions.split('\n').length).toBeLessThanOrEqual(2);
  expect(actions).toContain('DELETE 3');
  if (state === 'completed' || state === 'cancelled') {
   expect(actions).toBe('Remove from board: DELETE 3');
   expect(taskCard(c, 'Asia/Kolkata', now)).not.toContain('left');
   expect(taskCard(c, 'Asia/Kolkata', now)).not.toContain('overdue');
  } else {
   expect(actions).toContain('DONE 3');
   expect(actions).toContain('PROGRESS 3 50');
  }
 });

 it.each(['active', 'pending', 'missed', 'completed', 'cancelled'] as const)('keeps deleted %s task views factual and free of controls', state => {
  const c = task({ state, deleted_at: now });
  expect(taskCard(c, 'Asia/Kolkata', now)).toBe('#3 · Finish the design\nDELETED\nReminders stopped.');
  expect(taskCard(c, 'Asia/Kolkata', now, false)).toBe('Finish the design\nDELETED\nReminders stopped.');
  expect(taskActions(c, now)).toBe('');
  expect(taskSummary(c, 'Asia/Kolkata', now)).toBe(taskCard(c, 'Asia/Kolkata', now));
  expect(taskReminder(c, 'Asia/Kolkata', now, false, 'before_15')).toBe(taskCard(c, 'Asia/Kolkata', now));
  expect(taskReminder(c, 'Asia/Kolkata', now, true, 'followup')).not.toMatch(/HP|ACTIVE|CONFIRM|PROGRESS|DONE 3|RESCUE|DELETE 3|left|overdue/);
  expect(c.state).toBe(state);
 });

 it('does not display GitHub evidence claims or interactive controls in a deleted direct alert view', () => {
  const text = githubDeadlineAlert({ ...github(), deleted_at: now }, 'Asia/Kolkata', now, 'Old GitHub evidence');
  expect(text).toBe('#3 · Finish the design\nDELETED\nReminders stopped.');
  expect(text).not.toMatch(/Deadline alert|GitHub|STATUS|DONE|RESCUE|DELETE 3|left/);
 });

 it('uses the supplied clock for draft controls, countdown, and overdue state together', () => {
  const c = task({ state: 'pending' });
  const summary = taskSummary(c, 'Asia/Kolkata', new Date(due.getTime() + 60_000));
  expect(summary).toContain('DRAFT · deadline passed');
  expect(summary).toContain('1m overdue');
  expect(summary).toContain('MOVE 3 YYYY-MM-DD HH:mm');
  expect(summary).not.toContain('CONFIRM 3');
 });

 it('renders reminders against the supplied timestamp even when the host clock disagrees', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2099-01-01T00:00Z'));
  try {
   const c = task();
   const text = taskReminder(c, 'Asia/Kolkata', now);
   expect(text).toContain('\nACTIVE\n');
   expect(text).toContain('6h 45m left');
   expect(text).not.toContain('overdue');
   expect(text).not.toContain('unreported');
   expect(c.state).toBe('active');
  } finally { vi.useRealTimers(); }
 });

 it('varies local nudge wording across milestone buckets without randomness or changed facts', () => {
  const c = task();
  const times = [0, 15, 30].map(minutes => new Date(now.getTime() + minutes * 60_000));
  const leads = times.map(time => taskReminder(c, 'Asia/Kolkata', time).split('\n')[1]);
  expect(new Set(leads).size).toBe(3);
  expect(taskReminder(c, 'Asia/Kolkata', now)).toBe(taskReminder(c, 'Asia/Kolkata', now));
  for (const time of times) expect(taskReminder(c, 'Asia/Kolkata', time)).toContain('27%\nProgress · self-reported');
 });

 it.each([[120, '2h'], [60, '1h'], [30, '30m'], [15, '15m']] as const)('formats a professional %s-minute task alert with recorded progress', (minutes, countdown) => {
  const c = task({ due_at: new Date(now.getTime() + minutes * 60_000) });
  const text = taskReminder(c, 'Asia/Kolkata', now, false, `before_${minutes}`);
  expect(text).toMatch(new RegExp(`^Deadline alert · ${countdown} left\\n`));
  expect(text).toContain('#3 · Finish the design');
  expect(text).toContain('HP ▰▰▱▱▱▱▱▱▱▱ 27%');
  expect(text).toContain('PROGRESS 3 50 · DONE 3');
  expect(text).not.toContain(c.id);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
 });

 it('keeps ordinary nudges, deadline checks, and follow-ups distinct from approaching-deadline alerts', () => {
  const c = task();
  expect(taskReminder(c, 'Asia/Kolkata', now)).toMatch(/^Reminder\n/);
  expect(taskReminder(c, 'Asia/Kolkata', due, false, 'deadline')).toMatch(/^Deadline check\n/);
  expect(taskReminder(c, 'Asia/Kolkata', due, true, 'followup')).toMatch(/^Follow-up\n/);
  expect(taskReminder(task({ state: 'pending' }), 'Asia/Kolkata', now, false, 'before_15')).toMatch(/^Draft check\n/);
 });

 it('keeps GitHub checkpoint facts and evidence controls separate from owner-reported HP', () => {
  const c = { ...github(), due_at: new Date(now.getTime() + 90 * 60_000) };
  const text = githubDeadlineAlert(c, 'Asia/Kolkata', now, 'GitHub reports PR open; no merge verified.');
  expect(text).toMatch(/^Deadline alert · 1h 30m left\n/);
  expect(text).toContain('#3 · Finish the design');
  expect(text).toContain('Due: 19 Oct 2026, 8:00 AM (Asia/Kolkata)');
  expect(text).toContain('GitHub PR owner/repo#42');
  expect(text).toContain('no merge verified');
  expect(text).toContain('STATUS 3 · DONE 3');
  expect(text).toContain(c.artifact_url);
  expect(text).not.toMatch(/HP|PROGRESS|self-reported|\p{Extended_Pictographic}/u);
 });

 it.each(['mild', 'savage', 'nuclear'] as const)('keeps %s reminders professional across deadline and follow-up variants', intensity => {
  for (const overdue of [false, true]) {
   for (const followup of [false, true]) {
    for (const minutes of [0, 15, 30]) {
     const reference = overdue ? due : now;
     const time = new Date(reference.getTime() + minutes * 60_000);
     const text = taskReminder(task({ intensity }), 'Asia/Kolkata', time, followup);
     expect(text).not.toMatch(/\p{Extended_Pictographic}|court|season finale|plot development|left the chat|roast/iu);
     expect(text).toContain('#3 · Finish the design');
     expect(text).toContain('HP ▰▰▱▱▱▱▱▱▱▱ 27%');
     expect(text).toContain('Progress · self-reported');
     expect(text).toContain('Due: 19 Oct 2026, 1:15 PM (Asia/Kolkata)');
     expect(text).toContain('PROGRESS 3 50 · DONE 3');
    }
   }
  }
 });

 it.each(['completed', 'cancelled'] as const)('does not nag a %s task even after its deadline', state => {
  const c = task({ state });
  const text = taskReminder(c, 'Asia/Kolkata', new Date('2026-10-20T00:00Z'), true);
  expect(text).toBe(taskCard(c, 'Asia/Kolkata', now));
  expect(text).not.toMatch(/unreported|overdue|Follow-up|Update:|RESCUE|DONE 3/);
 });
});
