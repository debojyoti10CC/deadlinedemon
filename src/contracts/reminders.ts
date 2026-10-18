export interface Milestone { job_type: string; run_at: Date }
export function reminderSchedule(confirmedAt: Date, dueAt: Date): Milestone[] {
 const duration = dueAt.getTime() - confirmedAt.getTime();
 if (!Number.isFinite(duration)) throw new Error('Valid confirmation and deadline dates are required');
 if (duration <= 0) throw new Error('Deadline must be in the future before confirmation');
 const minute = 60000;
 const short = duration < 15 * minute;
 const offsets = short ? [-2 * minute,0,2 * minute] : [-120 * minute,-60 * minute,-30 * minute,-15 * minute,0,15 * minute];
 return offsets.filter(o => dueAt.getTime()+o > confirmedAt.getTime()).map(offset => ({
   job_type: offset === 0 ? 'deadline' : offset > 0 ? 'followup' : `before_${Math.abs(offset)/minute}`,
   run_at: new Date(dueAt.getTime()+offset),
 }));
}
export function reminderRelevant(type: string, dueAt: Date, now: Date): boolean {
 if (!type.startsWith('before_')) return true;
 const checkpoint = Number(type.slice('before_'.length));
 if (!Number.isFinite(checkpoint) || checkpoint <= 0) return false;
 const remaining = (dueAt.getTime() - now.getTime()) / 60000;
 // A recovered worker sends only the current checkpoint, never a burst of old alerts.
 const nextCheckpoint: Record<number, number> = {120: 60, 60: 30, 30: 15};
 return remaining <= checkpoint && remaining > (nextCheckpoint[checkpoint] ?? 0);
}
