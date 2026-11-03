import { describe, expect, it } from 'vitest';
import {
  formatScheduleTime,
  isValidTimezone,
  nextRunAfter,
  nextRuns,
  validateSchedule,
} from './cron.js';

// ADR-0032: when a schedule runs. Pure.

const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

describe('schedule cron (ADR-0032)', () => {
  it('weekdays 09:00 in America/Toronto, across the end of DST', () => {
    // 2026-11-01 (a Sunday) ends DST in Toronto: 09:00 is 13:00Z before and 14:00Z after.
    expect(
      iso(nextRuns('0 9 * * 1-5', 'America/Toronto', new Date('2026-10-30T12:00:00Z'), 3)),
    ).toEqual(['2026-10-30T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  });

  it('accepts a weekday-morning cron, and refuses bad ones', () => {
    expect(validateSchedule('0 9 * * 1-5', 'UTC')).toBeNull();
    expect(validateSchedule('*/15 * * * *', 'UTC')).toBeNull();
    expect(validateSchedule('*/5 * * * *', 'UTC')?.code).toBe('schedule_too_frequent');
    expect(validateSchedule('0,5 9 * * *', 'UTC')?.code).toBe('schedule_too_frequent');
    expect(validateSchedule('not a cron', 'UTC')?.code).toBe('invalid_cron');
    expect(validateSchedule('0 0 9 * * 1', 'UTC')?.code).toBe('invalid_cron'); // 6 fields
    expect(validateSchedule('0 99 * * *', 'UTC')?.code).toBe('invalid_cron');
    expect(validateSchedule('0 0 30 2 *', 'UTC')?.code).toBe('invalid_cron'); // never runs
    expect(validateSchedule('0 9 * * *', 'Mars/Base')?.code).toBe('invalid_timezone');
  });

  it('isValidTimezone', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Nowhere/Land')).toBe(false);
  });

  it('nextRunAfter is strictly after now, also exactly on a run time', () => {
    expect(nextRunAfter('0 9 * * *', 'UTC', new Date('2026-11-03T09:00:00Z'))?.toISOString()).toBe(
      '2026-11-04T09:00:00.000Z',
    );
    expect(nextRunAfter('0 9 * * *', 'UTC', new Date('2026-11-03T08:59:59Z'))?.toISOString()).toBe(
      '2026-11-03T09:00:00.000Z',
    );
  });

  it('formatScheduleTime is local to the timezone', () => {
    expect(formatScheduleTime(new Date('2026-11-03T14:00:00Z'), 'America/Toronto')).toBe(
      '2026-11-03 09:00',
    );
    expect(formatScheduleTime(new Date('2026-11-03T00:05:00Z'), 'UTC')).toBe('2026-11-03 00:05');
  });
});
