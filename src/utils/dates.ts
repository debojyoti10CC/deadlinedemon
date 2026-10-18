import { DateTime, IANAZone } from 'luxon';

export class DeadlineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineValidationError';
  }
}

export function isValidTimezone(timezone: string): boolean {
  // Intl also accepts abbreviations such as IST on some hosts. Reject these
  // ambiguous labels; accept explicit IANA area names and the universal UTC.
  return (timezone === 'UTC' || /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/.test(timezone))
    && IANAZone.isValidZone(timezone);
}

/** Parse a wall-clock deadline in the owner's stored IANA zone, without guessing. */
export function parseDeadline(local: string, timezone: string, now: Date = new Date()): Date {
  if (!isValidTimezone(timezone)) {
    throw new DeadlineValidationError('The stored timezone must be a valid IANA timezone.');
  }
  if (!Number.isFinite(now.getTime())) {
    throw new DeadlineValidationError('The current time is invalid.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) {
    throw new DeadlineValidationError('Specify an exact local date and time as YYYY-MM-DDTHH:mm in your stored timezone.');
  }
  const value = DateTime.fromISO(local, { zone: timezone, setZone: true });
  if (!value.isValid) {
    throw new DeadlineValidationError('That deadline is not a valid calendar date and time.');
  }
  const normalizedInput = local.length === 16 ? `${local}:00` : local;
  if (value.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== normalizedInput) {
    throw new DeadlineValidationError('That local time does not exist because of a daylight-saving transition. Choose another time.');
  }
  if (value.getPossibleOffsets().length !== 1) {
    throw new DeadlineValidationError('That local time occurs twice because of a daylight-saving transition. Choose an unambiguous time.');
  }
  if (value.toMillis() <= now.getTime()) {
    throw new DeadlineValidationError('The deadline must be in the future. Specify a new date and time.');
  }
  return value.toJSDate();
}

export function formatDeadline(date: Date, timezone: string): string {
  if (!isValidTimezone(timezone) || !Number.isFinite(date.getTime())) {
    throw new DeadlineValidationError('Cannot format an invalid date or timezone.');
  }
  return `${DateTime.fromJSDate(date, { zone: timezone }).toFormat('ccc, dd LLL yyyy, h:mm a ZZZZ')} (${timezone})`;
}
