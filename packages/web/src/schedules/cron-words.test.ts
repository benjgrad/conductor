import { describe, expect, it } from 'vitest';
import { parseHash, routeHash } from '../nav.js';
import {
  cronFromPreset,
  describeSchedule,
  isOpenStatus,
  ordinal,
  presetFromCron,
  showSkipped,
  until,
  zoneCity,
} from './cron-words.js';

describe('presets ↔ cron (UXR-83 FR-3)', () => {
  it.each([
    ['0 9 * * *', { kind: 'daily', time: '09:00' }],
    ['30 7 * * 1-5', { kind: 'weekdays', time: '07:30' }],
    ['30 8 * * 1,4', { kind: 'weekly', time: '08:30', days: [1, 4] }],
    ['0 10 1 * *', { kind: 'monthly', time: '10:00', dayOfMonth: 1 }],
  ])('%s is a preset and round-trips', (cron, expected) => {
    const p = presetFromCron(cron);
    expect(p).toMatchObject(expected);
    expect(cronFromPreset(p)).toBe(cron);
  });

  it('weekly days sort and 7 is Sunday', () => {
    expect(presetFromCron('0 6 * * 7,3')).toMatchObject({ kind: 'weekly', days: [0, 3] });
    expect(cronFromPreset({ kind: 'weekly', time: '06:05', days: [5, 1], dayOfMonth: 1 })).toBe(
      '5 6 * * 1,5',
    );
  });

  it.each(['*/30 * * * *', '0 9 * 1 *', '0 9-17 * * *', '0 9 1 * 1', '0 9 * *', '61 9 * * *'])(
    '%s is advanced',
    (cron) => {
      expect(presetFromCron(cron)).toEqual({ kind: 'advanced', cron });
    },
  );
});

describe('describeSchedule', () => {
  it.each([
    ['0 9 * * 1-5', 'America/Toronto', 'Weekdays at 09:00 (Toronto)'],
    ['30 7 * * *', 'UTC', 'Daily at 07:30 (UTC)'],
    ['30 8 * * 1,4', 'Europe/London', 'Weekly on Mon, Thu at 08:30 (London)'],
    ['0 10 1 * *', 'Europe/London', 'Monthly on the 1st at 10:00 (London)'],
    ['0 */2 * * *', 'America/Argentina/Buenos_Aires', 'Custom: 0 */2 * * * (Buenos Aires)'],
  ])('%s in %s', (cron, tz, words) => {
    expect(describeSchedule(cron, tz)).toBe(words);
  });

  it('zones and ordinals', () => {
    expect(zoneCity('UTC')).toBe('UTC');
    expect(zoneCity('America/New_York')).toBe('New York');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '31st',
    ]);
  });
});

describe('last run', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h)).toISOString();

  it('open statuses', () => {
    expect(['ready', 'claimed', 'in_progress'].every((s) => isOpenStatus(s as never))).toBe(true);
    expect(['done', 'failed', 'cancelled'].some((s) => isOpenStatus(s as never))).toBe(false);
  });

  it('shows the skip only when it is the latest thing that happened', () => {
    const skip = { last_skip_reason: 'previous_run_open' as const, last_skipped_at: at(10) };
    expect(showSkipped({ ...skip, last_run_at: at(9) })).toBe(true);
    expect(showSkipped({ ...skip, last_run_at: null })).toBe(true);
    expect(showSkipped({ ...skip, last_run_at: at(11) })).toBe(false);
    expect(
      showSkipped({
        last_skip_reason: 'invalid_schedule',
        last_skipped_at: at(10),
        last_run_at: null,
      }),
    ).toBe(false);
    expect(showSkipped({ last_skip_reason: null, last_skipped_at: null, last_run_at: null })).toBe(
      false,
    );
  });

  it('until', () => {
    const now = Date.parse(at(9));
    expect(until(at(9), now)).toBe('now');
    expect(until(new Date(now + 5 * 60_000).toISOString(), now)).toBe('in 5 min');
    expect(until(at(12), now)).toBe('in 3 h');
    expect(until(new Date(now + 50 * 3_600_000).toISOString(), now)).toBe('in 2 d');
  });
});

describe('#/schedules route', () => {
  it('round-trips with and without an id', () => {
    expect(parseHash('#/schedules')).toEqual({ view: 'schedules', scheduleId: null });
    const id = 'e5000000-0000-4000-8000-000000000001';
    expect(parseHash(`#/schedules/${id}`)).toEqual({ view: 'schedules', scheduleId: id });
    expect(routeHash({ view: 'schedules', scheduleId: id })).toBe(`#/schedules/${id}`);
    expect(routeHash({ view: 'schedules', scheduleId: null })).toBe('#/schedules');
  });
});
