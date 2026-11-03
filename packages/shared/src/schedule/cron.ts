import { Cron } from 'croner';

// ADR-0032: when a recurring schedule runs. A 5-field cron expression read in an IANA timezone,
// evaluated with `croner` (no timers are started: a Cron without a callback only computes).
// Pure, so the orchestrator's sweep, the REST / MCP previews and the web share one answer.

/** The shortest gap allowed between two consecutive runs (ADR-0032 decision 2). */
export const MIN_SCHEDULE_INTERVAL_MS = 15 * 60_000;

/** How many upcoming runs `validateSchedule` checks against the minimum interval. */
export const SCHEDULE_INTERVAL_SAMPLE = 5;

export const DEFAULT_SCHEDULE_TIMEZONE = 'UTC';

export type ScheduleErrorCode = 'invalid_cron' | 'invalid_timezone' | 'schedule_too_frequent';

export interface ScheduleError {
  code: ScheduleErrorCode;
  message: string;
}

/** Whether `tz` is an IANA timezone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cronOf(cron: string, tz: string): Cron {
  return new Cron(cron.trim(), { timezone: tz, mode: '5-part', paused: true });
}

/** null = valid; else the first problem. */
export function validateSchedule(
  cron: string,
  tz: string,
  from: Date = new Date(),
): ScheduleError | null {
  if (!isValidTimezone(tz)) {
    return { code: 'invalid_timezone', message: `unknown timezone ${tz} (use an IANA name)` };
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    return {
      code: 'invalid_cron',
      message: 'cron must have 5 fields: minute hour day-of-month month day-of-week',
    };
  }
  let runs: Date[];
  try {
    runs = cronOf(cron, tz).nextRuns(SCHEDULE_INTERVAL_SAMPLE + 1, from);
  } catch (err) {
    return {
      code: 'invalid_cron',
      message: `invalid cron: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (runs.length === 0) return { code: 'invalid_cron', message: 'the cron never runs' };
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
      return {
        code: 'schedule_too_frequent',
        message: `runs must be at least ${MIN_SCHEDULE_INTERVAL_MS / 60_000} minutes apart`,
      };
    }
  }
  return null;
}

/** The next `n` run times strictly after `after`. Throws on an invalid cron or timezone. */
export function nextRuns(cron: string, tz: string, after: Date, n: number): Date[] {
  return cronOf(cron, tz).nextRuns(n, after);
}

/** The first run time strictly after `now`; null when the cron never runs again. */
export function nextRunAfter(cron: string, tz: string, now: Date): Date | null {
  return cronOf(cron, tz).nextRun(now);
}

/** `YYYY-MM-DD HH:mm` of `at` in `tz` (a scheduled ticket's title suffix). */
export function formatScheduleTime(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
