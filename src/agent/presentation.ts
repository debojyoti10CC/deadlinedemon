import { DateTime } from 'luxon';
import type { Contract } from '../types.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Stable owner-facing references never expose the database UUID. */
export function publicRef(c: Contract): string { return `#${c.display_id}`; }

/** Preserve a complete emoji/combined character when shortening a mobile card. */
export function displayTitle(c: Contract, limit = 90): string {
 const clean = c.title.replace(/\s+/gu, ' ').trim() || 'Untitled task';
 const length = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 90;
 if (!length) return '';
 const parts = Array.from(graphemes.segment(clean), part => part.segment);
 return parts.length > length ? `${parts.slice(0, length - 1).join('')}…` : clean;
}

/** HP represents a recorded owner report, never elapsed time or GitHub activity. */
export function hpLine(c: Contract, compact = false): string {
 const reported = Number.isFinite(c.progress_percent) ? c.progress_percent : 0;
 const percent = c.state === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(reported)));
 const filled = Math.floor(percent / 10);
 return `HP ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${percent}%${compact ? '' : ' · self-reported'}`;
}

/** One supplied clock keeps every label in a message on the same side of a deadline. */
export function taskState(c: Contract, now: Date = new Date()): string {
 if (c.state === 'pending') return c.due_at.getTime() <= now.getTime()
  ? 'DRAFT · deadline passed' : 'DRAFT · awaiting confirmation';
 if (c.state === 'missed' || c.state === 'active' && c.due_at.getTime() <= now.getTime()) {
  return c.artifact_type === 'task' ? 'DEADLINE PASSED — completion unreported' : 'DEADLINE PASSED · proof not recorded';
 }
 if (c.state === 'completed') return `COMPLETED${c.missed_at ? ' LATE' : ''}${c.artifact_type === 'task' ? ' — self-reported' : ''}`;
 return c.state.toUpperCase();
}

export function deadlineText(due: Date, timezone: string): string {
 const local = DateTime.fromJSDate(due, { zone: timezone });
 return local.isValid ? local.toFormat('d LLL yyyy, h:mm a') : 'Deadline unavailable';
}

/** Concise countdown facts; reaching a deadline never implies completion. */
export function remainingTime(due: Date, now: Date): string {
 const difference = due.getTime() - now.getTime();
 if (!Number.isFinite(difference)) return 'Deadline unavailable';
 if (difference === 0) return 'Due now';
 const suffix = difference > 0 ? 'left' : 'overdue';
 const minutes = Math.floor(Math.abs(difference) / 60_000);
 if (!minutes) return `less than 1m ${suffix}`;
 const days = Math.floor(minutes / 1440);
 const hours = Math.floor(minutes % 1440 / 60);
 const remainder = minutes % 60;
 const units = days ? [`${days}d`, hours ? `${hours}h` : '']
  : hours ? [`${hours}h`, remainder ? `${remainder}m` : ''] : [`${remainder}m`];
 return `${units.filter(Boolean).join(' ')} ${suffix}`;
}
