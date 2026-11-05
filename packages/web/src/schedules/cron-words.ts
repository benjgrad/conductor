import type { ScheduleDto, TicketStatus } from '@conductor/shared';

// ADR-0032 / UXR-83: a schedule's cron in words, and the picker's presets. Pure, so the page and
// the sheet share one reading and the tests need no browser. The server stores and checks only
// the cron; a preset is how the sheet writes one.

export type PresetKind = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export type SchedulePreset =
  | {
      kind: PresetKind;
      /** `HH:MM`, 24-hour. */
      time: string;
      /** Weekly: days of the week, 0 = Sunday … 6 = Saturday, ascending. */
      days: number[];
      /** Monthly: 1..31. */
      dayOfMonth: number;
    }
  | { kind: 'advanced'; cron: string };

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const INT = /^\d{1,2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** `m h …` → `HH:MM` when both are plain in-range integers, else null. */
function timeOf(minute: string, hour: string): string | null {
  if (!INT.test(minute) || !INT.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** A list of weekdays (`1`, `1,4`, `0,6`; 7 = Sunday) → sorted unique days, else null. */
function daysOf(field: string): number[] | null {
  const parts = field.split(',');
  const days: number[] = [];
  for (const p of parts) {
    if (!/^\d$/.test(p)) return null;
    const d = Number(p) % 7;
    if (Number(p) > 7) return null;
    if (!days.includes(d)) days.push(d);
  }
  return days.sort((a, b) => a - b);
}

/** The preset a cron is, or `advanced` with the cron itself. */
export function presetFromCron(cron: string): SchedulePreset {
  const fields = cron.trim().split(/\s+/);
  const advanced: SchedulePreset = { kind: 'advanced', cron: cron.trim() };
  if (fields.length !== 5) return advanced;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const time = timeOf(minute, hour);
  if (time === null || month !== '*') return advanced;
  if (dom === '*' && dow === '*') return { kind: 'daily', time, days: [], dayOfMonth: 1 };
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time, days: [], dayOfMonth: 1 };
  if (dom === '*') {
    const days = daysOf(dow);
    return days === null ? advanced : { kind: 'weekly', time, days, dayOfMonth: 1 };
  }
  if (dow === '*' && INT.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { kind: 'monthly', time, days: [], dayOfMonth: Number(dom) };
  }
  return advanced;
}

/** The cron a preset writes (the inverse of `presetFromCron`). */
export function cronFromPreset(p: SchedulePreset): string {
  if (p.kind === 'advanced') return p.cron.trim();
  const [h = '0', m = '0'] = p.time.split(':');
  const time = `${Number(m)} ${Number(h)}`;
  switch (p.kind) {
    case 'daily':
      return `${time} * * *`;
    case 'weekdays':
      return `${time} * * 1-5`;
    case 'weekly':
      return `${time} * * ${[...p.days].sort((a, b) => a - b).join(',')}`;
    case 'monthly':
      return `${time} ${p.dayOfMonth} * *`;
  }
}

/** `America/Argentina/Buenos_Aires` → `Buenos Aires`; `UTC` stays `UTC`. */
export function zoneCity(tz: string): string {
  const last = tz.split('/').at(-1) ?? tz;
  return last.replace(/_/g, ' ');
}

/** 1 → 1st, 2 → 2nd, 11 → 11th, 22 → 22nd. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** "Weekdays at 09:00 (Toronto)"; a cron no preset reads is "Custom: `cron` (Toronto)". */
export function describeSchedule(cron: string, tz: string): string {
  const p = presetFromCron(cron);
  const zone = ` (${zoneCity(tz)})`;
  switch (p.kind) {
    case 'advanced':
      return `Custom: ${p.cron}${zone}`;
    case 'daily':
      return `Daily at ${p.time}${zone}`;
    case 'weekdays':
      return `Weekdays at ${p.time}${zone}`;
    case 'weekly':
      return `Weekly on ${p.days.map((d) => WEEKDAY_SHORT[d]).join(', ')} at ${p.time}${zone}`;
    case 'monthly':
      return `Monthly on the ${ordinal(p.dayOfMonth)} at ${p.time}${zone}`;
  }
}

/** A ticket still in play: a new run is skipped (or refused) while the last one is. */
export function isOpenStatus(status: TicketStatus): boolean {
  return status === 'ready' || status === 'claimed' || status === 'in_progress';
}

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  ready: 'Queued',
  claimed: 'Starting',
  in_progress: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Whether the latest due run was skipped because the one before was still open. */
export function showSkipped(
  dto: Pick<ScheduleDto, 'last_skip_reason' | 'last_skipped_at' | 'last_run_at'>,
): boolean {
  if (dto.last_skip_reason !== 'previous_run_open' || dto.last_skipped_at === null) return false;
  return dto.last_run_at === null || Date.parse(dto.last_skipped_at) > Date.parse(dto.last_run_at);
}

/** "in 5 min", "in 3 h", "in 2 d" (rounded down; "now" under a minute). */
export function until(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h`;
  return `in ${Math.floor(h / 24)} d`;
}

/** The next run in the viewer's own time, with how soon: "Thu 6 Nov, 09:00 · in 3 h". */
export function formatNextRun(iso: string, now = Date.now()): string {
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  return `${when} · ${until(iso, now)}`;
}
