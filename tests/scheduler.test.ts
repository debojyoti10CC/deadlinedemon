import { describe, expect, it } from 'vitest';
import { reminderRelevant, reminderSchedule } from '../src/contracts/reminders.js';
import { taskSummary } from '../src/contracts/tasks.js';
import type { TaskContract } from '../src/types.js';

const MINUTE = 60_000;
const confirmed = new Date('2026-10-18T12:00:00Z');
const dueIn = (minutes: number) => new Date(confirmed.getTime() + minutes * MINUTE);

describe('deadline reminder cadence', () => {
  it('schedules two-hour, one-hour, thirty-minute, fifteen-minute, deadline, and follow-up milestones', () => {
    const due = dueIn(180);
    expect(reminderSchedule(confirmed, due).map((job) => ({ type: job.job_type, offset: (job.run_at.getTime() - due.getTime()) / MINUTE }))).toEqual([
      { type: 'before_120', offset: -120 }, { type: 'before_60', offset: -60 },
      { type: 'before_30', offset: -30 }, { type: 'before_15', offset: -15 },
      { type: 'deadline', offset: 0 }, { type: 'followup', offset: 15 },
    ]);
  });

  it('uses a two-minute warning and follow-up for deadlines under fifteen minutes', () => {
    const due = dueIn(10);
    expect(reminderSchedule(confirmed, due).map((job) => ({ type: job.job_type, offset: (job.run_at.getTime() - due.getTime()) / MINUTE }))).toEqual([
      { type: 'before_2', offset: -2 }, { type: 'deadline', offset: 0 }, { type: 'followup', offset: 2 },
    ]);
  });

  it.each([0.5, 1, 2])('omits elapsed warnings for a %s minute deadline', (minutes) => {
    const schedule = reminderSchedule(confirmed, dueIn(minutes));
    expect(schedule.map((job) => job.job_type)).toEqual(['deadline', 'followup']);
    expect(schedule.every((job) => job.run_at.getTime() > confirmed.getTime())).toBe(true);
  });

  it('does not replay the one-hour warning for a thirty-minute contract', () => {
    expect(reminderSchedule(confirmed, dueIn(30)).map((job) => job.job_type)).toEqual(['before_15', 'deadline', 'followup']);
  });

  it.each([
    [120, ['before_60', 'before_30', 'before_15', 'deadline', 'followup']],
    [60, ['before_30', 'before_15', 'deadline', 'followup']],
    [30, ['before_15', 'deadline', 'followup']],
    [15, ['deadline', 'followup']],
  ] as const)('omits the checkpoint at confirmation for a %s-minute commitment', (minutes, expected) => {
    expect(reminderSchedule(confirmed, dueIn(minutes)).map(job => job.job_type)).toEqual(expected);
  });

  it('uses normal cadence at exactly fifteen minutes and avoids a warning at confirmation', () => {
    const schedule = reminderSchedule(confirmed, dueIn(15));
    expect(schedule.map((job) => job.job_type)).toEqual(['deadline', 'followup']);
    expect(schedule[1]?.run_at.getTime()).toBe(dueIn(30).getTime());
  });

  it.each([0, -1, -60])('rejects deadlines already reached (%s minutes)', (minutes) => {
    expect(() => reminderSchedule(confirmed, dueIn(minutes))).toThrow('future');
  });

  it('rejects invalid dates instead of silently creating an empty reminder schedule', () => {
    expect(() => reminderSchedule(new Date('invalid'), dueIn(60))).toThrow('Valid');
    expect(() => reminderSchedule(confirmed, new Date('invalid'))).toThrow('Valid');
  });

  it('produces unique milestones ordered in the future', () => {
    for (const minutes of [0.5, 2, 5, 14.99, 15, 30, 60, 120, 1440]) {
      const schedule = reminderSchedule(confirmed, dueIn(minutes));
      expect(new Set(schedule.map((job) => job.job_type)).size).toBe(schedule.length);
      expect(schedule.filter((job) => job.job_type === 'deadline')).toHaveLength(1);
      expect(schedule.every((job, index) => job.run_at > confirmed && (index === 0 || job.run_at > schedule[index - 1]!.run_at))).toBe(true);
    }
  });
});

describe('reminder recovery after downtime', () => {
  it.each([
    ['before_120', 120, 60], ['before_60', 60, 30], ['before_30', 30, 15],
    ['before_15', 15, 0], ['before_2', 2, 0],
  ] as const)('delivers %s only within its current checkpoint window', (type, checkpoint, next) => {
    const due = dueIn(180);
    const atRemaining = (minutes: number) => new Date(due.getTime() - minutes * MINUTE);
    expect(reminderRelevant(type, due, atRemaining(checkpoint + 0.001))).toBe(false);
    expect(reminderRelevant(type, due, atRemaining(checkpoint))).toBe(true);
    expect(reminderRelevant(type, due, atRemaining(next + 0.001))).toBe(true);
    expect(reminderRelevant(type, due, atRemaining(next))).toBe(false);
    expect(reminderRelevant(type, due, due)).toBe(false);
    expect(reminderRelevant(type, due, new Date(due.getTime() + MINUTE))).toBe(false);
  });

  it('recovery with fourteen minutes remaining suppresses older checkpoints', () => {
    const due = dueIn(180);
    const now = new Date(due.getTime() - 14 * MINUTE);
    expect(['before_120', 'before_60', 'before_30', 'before_15']
      .filter(type => reminderRelevant(type, due, now))).toEqual(['before_15']);
  });

  it.each(['before_', 'before_invalid', 'before_-2', 'before_0'])('suppresses malformed warning %s', (type) => {
    expect(reminderRelevant(type, dueIn(10), confirmed)).toBe(false);
  });

  it('suppresses a predeadline warning when either date is invalid', () => {
    expect(reminderRelevant('before_15', new Date('invalid'), confirmed)).toBe(false);
    expect(reminderRelevant('before_15', dueIn(10), new Date('invalid'))).toBe(false);
  });

  it.each(['deadline', 'followup', 'monitor'])('keeps %s relevant for fresh evidence after recovery', (type) => {
    expect(reminderRelevant(type, dueIn(10), dueIn(30))).toBe(true);
  });
});

describe('ordinary task status labels', () => {
  it('distinguishes an unreported deadline from a late self-reported completion', () => {
    const task: TaskContract = {
      id: 'c823f849-ff6c-4e41-8181-01c5e065e191', user_id: 'c823f849-ff6c-4e41-8181-01c5e065e190',
      title: 'Finish the front end', artifact_type: 'task', repo_owner: null, repo_name: null, display_id: 1, progress_percent: 0,
      artifact_number: null, artifact_url: null, due_at: new Date('2026-10-19T05:00:00Z'), state: 'missed',
      intensity: 'mild', created_at: confirmed, confirmed_at: confirmed, completed_at: null,
      last_checked_at: null, last_observed_state: null, version: 1, missed_at: new Date('2026-10-19T05:00:00Z'),
    };
    expect(taskSummary(task, 'Asia/Kolkata')).toContain('DEADLINE PASSED — completion unreported');
    task.state = 'completed';
    task.completed_at = new Date('2026-10-19T06:00:00Z');
    expect(taskSummary(task, 'Asia/Kolkata')).toContain('COMPLETED LATE — self-reported');
  });
});
