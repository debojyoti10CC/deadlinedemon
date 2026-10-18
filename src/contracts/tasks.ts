import type { GitHubContract, TaskContract } from '../types.js';
import { deadlineText, displayTitle, hpLine, publicRef, remainingTime, taskState } from '../agent/presentation.js';

/** A read-only snapshot, separate from the next action a reply chooses to offer. */
export function taskCard(c: TaskContract, timezone: string, now: Date = new Date(), includeReference = true): string {
 const unfinished = c.state !== 'completed' && c.state !== 'cancelled';
 const progress=`${hpLine(c,true)}${c.state==='completed'?'':'\nProgress · self-reported'}`;
 return `${includeReference ? `${publicRef(c)} · ` : ''}${displayTitle(c, 120)}\n${taskState(c, now)}\n${progress}\nDue: ${deadlineText(c.due_at, timezone)} (${timezone})${unfinished ? `\nTime remaining: ${remainingTime(c.due_at, now)}` : ''}`;
}

/** At most two useful control lines, always for the task actually displayed. */
export function taskActions(c: TaskContract, now: Date = new Date()): string {
 const update = `PROGRESS ${c.display_id} 50 · DONE ${c.display_id}`;
 if (c.state === 'completed' || c.state === 'cancelled') return '';
 if (c.state === 'pending') return c.due_at.getTime() <= now.getTime()
  ? `Already finished? DONE ${c.display_id} · Update: PROGRESS ${c.display_id} 50\nNew deadline: MOVE ${c.display_id} YYYY-MM-DD HH:mm`
  : `CONFIRM ${c.display_id} to start reminders.\nUpdate: ${update}`;
 return `Update: ${update}\nStuck? RESCUE ${c.display_id}`;
}

/** Kept as the complete detail-card API for scheduler and existing callers. */
export function taskSummary(c: TaskContract, timezone: string, now: Date = new Date()): string {
 const actions = taskActions(c, now);
 return `${taskCard(c, timezone, now)}${actions ? `\n\n${actions}` : ''}`;
}

/** Checkpoint facts stay current without regenerating a potentially stale countdown. */
export function githubDeadlineAlert(c: GitHubContract, timezone: string, now: Date, evidenceDescription: string): string {
 return [
  `Deadline alert · ${remainingTime(c.due_at, now)}`,
  `${publicRef(c)} · ${displayTitle(c, 120)}\n${taskState(c, now)}\nDue: ${deadlineText(c.due_at, timezone)} (${timezone})`,
  `GitHub ${c.artifact_type === 'pull_request' ? 'PR' : 'issue'} ${c.repo_owner}/${c.repo_name}#${c.artifact_number}\n${evidenceDescription}\n${c.artifact_url}`,
  `Check: STATUS ${c.display_id} · DONE ${c.display_id}\nStuck? RESCUE ${c.display_id}`,
 ].join('\n\n');
}

function variant(c: TaskContract, now: Date, followup: boolean): number {
 // Stable for a retry; new milestone/time buckets can use a different local line.
 const bucket = Math.floor(now.getTime() / (15 * 60_000));
 let hash = followup ? 1 : 0;
 for (const char of c.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
 return (hash + bucket) % 3;
}

/** Ordinary reminders are deterministic: no GitHub reads or generation calls. */
export function taskReminder(c: TaskContract, timezone: string, now: Date, followup = false, milestone?: string): string {
 // Terminal states are normally suppressed by the scheduler; direct calls stay factual.
 if (c.state === 'completed' || c.state === 'cancelled') return taskCard(c, timezone, now);
 const overdue = now.getTime() >= c.due_at.getTime();
 const index = variant(c, now, followup);
 const voice = overdue ? {
  mild: [
   'The deadline has passed. Please update your progress when you can.',
   'This task is past its deadline. Report completion or ask for help with the next step.',
   'A progress update will help you decide what to do next. The deadline has passed.',
  ],
  savage: [
   'The deadline has passed. Update your progress and choose the next action.',
   'This task is overdue. Record what is finished and address what remains.',
   'Completion is unreported after the deadline. Provide a status update.',
  ],
  nuclear: [
   'The deadline has passed. A status update is needed now.',
   'This task is overdue. Report completion or identify the blocker now.',
   'Completion remains unreported. Update this task before starting new work.',
  ],
 } : {
  mild: [
   'Choose a manageable next step and keep your progress current.',
   'Focus on one part you can complete before the deadline.',
   'Review what remains and take the next practical step.',
  ],
  savage: [
   'Keep this task moving. Complete the next step and update your progress.',
   'The deadline is approaching. Focus on the next deliverable.',
   'Review the remaining work and act on the highest priority.',
  ],
  nuclear: [
   'Prioritize this deadline. Start the next required step now.',
   'Keep your focus on this task until the next milestone is complete.',
   'Act on the remaining work now and report your progress.',
  ],
 };
 // Use the delivery clock, never the original checkpoint's duration after a delay.
 const deadlineAlert = !overdue && c.state !== 'pending' && milestone?.startsWith('before_');
 const heading = followup ? 'Follow-up' : overdue ? 'Deadline check' : c.state === 'pending' ? 'Draft check'
  : deadlineAlert ? `Deadline alert · ${remainingTime(c.due_at, now)}` : 'Reminder';
 return `${heading}\n${voice[c.intensity][index]}\n\n${taskSummary(c, timezone, now)}`;
}
