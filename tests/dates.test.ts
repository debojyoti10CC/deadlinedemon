import { describe, expect, it } from 'vitest';
import { formatDeadline, parseDeadline } from '../src/utils/dates.js';

const now = new Date('2026-01-01T00:00:00Z');

describe('parseDeadline', () => {
  it('converts an exact local deadline using the stored IANA timezone', () => {
    expect(parseDeadline('2026-10-18T21:00', 'Asia/Kolkata', now).toISOString()).toBe('2026-10-18T15:30:00.000Z');
    expect(parseDeadline('2026-10-18T21:00:42', 'Asia/Calcutta', now).toISOString()).toBe('2026-10-18T15:30:42.000Z');
  });

  it.each(['2026-02-29T09:00', '2026-04-31T09:00', '2026-10-18T99:00'])('rejects an impossible calendar time: %s', (input) => {
    expect(() => parseDeadline(input, 'UTC', now)).toThrow();
  });

  it.each(['tomorrow', '2026-10-18', '2026-10-18 21:00', '2026-10-18T21:00Z', '2026-10-18T21:00+05:30', '2026-10-18T9:00'])('rejects implicit or offset-bearing date input: %s', (input) => {
    expect(() => parseDeadline(input, 'Asia/Kolkata', now)).toThrow(/exact local date and time/);
  });

  it('rejects a nonexistent DST time instead of moving it forward', () => {
    expect(() => parseDeadline('2026-03-08T02:30', 'America/New_York', now)).toThrow(/does not exist/);
  });

  it('rejects an ambiguous DST time instead of choosing an offset', () => {
    expect(() => parseDeadline('2026-11-01T01:30', 'America/New_York', now)).toThrow(/occurs twice/);
  });

  it('handles a half-hour DST change without rounding', () => {
    expect(() => parseDeadline('2026-10-04T02:15', 'Australia/Lord_Howe', now)).toThrow(/does not exist/);
    expect(parseDeadline('2026-10-04T02:45', 'Australia/Lord_Howe', now).toISOString()).toBe('2026-10-03T15:45:00.000Z');
  });

  it('rejects past and exactly-current deadlines', () => {
    expect(() => parseDeadline('2025-12-31T23:59', 'UTC', now)).toThrow(/future/);
    expect(() => parseDeadline('2026-01-01T00:00', 'UTC', now)).toThrow(/future/);
  });

  it('rejects invalid timezone or reference instant', () => {
    expect(() => parseDeadline('2026-10-18T21:00', 'IST', now)).toThrow(/IANA/);
    expect(() => parseDeadline('2026-10-18T21:00', 'UTC', new Date('bad'))).toThrow(/current time/);
  });
});

describe('formatDeadline', () => {
  it('includes the real local time, calendar date, and unambiguous timezone', () => {
    const text = formatDeadline(new Date('2026-10-18T15:30:00Z'), 'Asia/Kolkata');
    expect(text).toContain('18 Oct 2026');
    expect(text).toContain('9:00 PM');
    expect(text).toContain('(Asia/Kolkata)');
  });

  it('rejects invalid display inputs', () => {
    expect(() => formatDeadline(new Date('bad'), 'UTC')).toThrow();
    expect(() => formatDeadline(now, 'not/a/timezone')).toThrow();
  });
});
