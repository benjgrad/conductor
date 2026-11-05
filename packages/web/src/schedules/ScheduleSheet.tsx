import {
  DEFAULT_SCHEDULE_TIMEZONE,
  isValidTimezone,
  nextRuns,
  SCHEDULE_NAME_MAX,
  SCHEDULE_TITLE_MAX,
  TICKET_KINDS,
  validateSchedule,
  type MachineRow,
  type RepoSuggestion,
  type ScheduleDto,
  type TicketKind,
  type UpdateScheduleRequest,
} from '@conductor/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { TICKET_KIND_LABELS } from '../components/format.js';
import { RepoCombobox } from '../components/RepoCombobox.js';
import type { RichEditorHandle } from '../components/ticket-editor/RichTicketEditor.js';
import { TicketBodyField } from '../components/ticket-editor/TicketBodyField.js';
import {
  cronFromPreset,
  describeSchedule,
  presetFromCron,
  WEEKDAY_SHORT,
  type PresetKind,
} from './cron-words.js';

type PickerKind = PresetKind | 'advanced';

const PICKER_LABELS: Record<PickerKind, string> = {
  daily: 'Daily',
  weekdays: 'Weekdays (Mon–Fri)',
  weekly: 'Weekly on…',
  monthly: 'Monthly on…',
  advanced: 'Advanced (cron)',
};

/** The browser's own zone, else UTC. */
export function defaultTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : DEFAULT_SCHEDULE_TIMEZONE;
  } catch {
    return DEFAULT_SCHEDULE_TIMEZONE;
  }
}

function timezoneNames(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/** The form's values: from a schedule, or a new one's defaults. */
interface Draft {
  name: string;
  repo: string;
  kind: TicketKind | null;
  title: string;
  body: string;
  picker: PickerKind;
  time: string;
  days: number[];
  dayOfMonth: number;
  rawCron: string;
  timezone: string;
  machineIds: string[];
  enabled: boolean;
}

export function draftOf(s: ScheduleDto | null): Draft {
  const preset = presetFromCron(s?.cron ?? '0 9 * * 1-5');
  const p =
    preset.kind === 'advanced' ? { time: '09:00', days: [1], dayOfMonth: 1 } : { ...preset };
  return {
    name: s?.name ?? '',
    repo: s?.repo ?? '',
    kind: s?.kind ?? null,
    title: s?.title ?? '',
    body: s?.body ?? '',
    picker: preset.kind,
    time: p.time,
    days: p.days.length > 0 ? p.days : [1],
    dayOfMonth: p.dayOfMonth,
    rawCron: s?.cron ?? '0 9 * * 1-5',
    timezone: s?.timezone ?? defaultTimezone(),
    machineIds: s?.machine_ids ?? [],
    enabled: s?.enabled ?? true,
  };
}

/** The cron the picker writes. */
export function draftCron(d: Draft): string {
  if (d.picker === 'advanced') return d.rawCron.trim();
  return cronFromPreset({ kind: d.picker, time: d.time, days: d.days, dayOfMonth: d.dayOfMonth });
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Edit: only what changed, plus the guard. */
export function changedFields(
  s: ScheduleDto,
  d: Draft,
  body: string,
): UpdateScheduleRequest & { expected_updated_at: string } {
  const out: UpdateScheduleRequest & { expected_updated_at: string } = {
    expected_updated_at: s.updated_at,
  };
  const cron = draftCron(d);
  if (d.name.trim() !== s.name) out.name = d.name.trim();
  if (d.repo.trim() !== s.repo) out.repo = d.repo.trim();
  if (d.kind !== null && d.kind !== s.kind) out.kind = d.kind;
  if (d.title.trim() !== s.title) out.title = d.title.trim();
  if (body !== s.body) out.body = body;
  if (cron !== s.cron) out.cron = cron;
  if (d.timezone.trim() !== s.timezone) out.timezone = d.timezone.trim();
  if (!sameIds(d.machineIds, s.machine_ids ?? [])) {
    out.machines = d.machineIds.length > 0 ? d.machineIds : null;
  }
  return out;
}

interface ScheduleSheetProps {
  api: ApiClient;
  /** null = a new schedule. */
  schedule: ScheduleDto | null;
  onClose: () => void;
  onSaved: (dto: ScheduleDto) => void;
  onDeleted: (id: string) => void;
  /** After a conflict, the schedule as it is now (the sheet restarts from it). */
  onReloaded: (dto: ScheduleDto) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const FIELD_PATHS = ['name', 'repo', 'cron', 'timezone', 'machines', 'title', 'kind'] as const;
type FieldPath = (typeof FIELD_PATHS)[number];

/**
 * UXR-83 FR-3: the New / Edit schedule sheet, the New ticket sheet's shell (CreateTicketForm):
 * a modal dialog with Close, Escape and backdrop, and a sticky footer that says what's missing.
 * The picker writes the cron from a preset; Advanced takes it raw. Both are checked as the server
 * checks them (`validateSchedule`: 5 fields, a known timezone, runs at least 15 minutes apart).
 */
export function ScheduleSheet({
  api,
  schedule,
  onClose,
  onSaved,
  onDeleted,
  onReloaded,
  onDirtyChange,
}: ScheduleSheetProps) {
  const initial = useMemo(() => draftOf(schedule), [schedule]);
  const [d, setD] = useState<Draft>(initial);
  const bodyEditor = useRef<RichEditorHandle | null>(null);
  const [repos, setRepos] = useState<RepoSuggestion[]>([]);
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldPath, string>>>({});
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null);
  const headingId = useId();
  const hintId = useId();
  const zonesId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const repoTouched = useRef(schedule !== null);
  const zones = useMemo(() => timezoneNames(), []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setD((prev) => ({ ...prev, [key]: value }));
    onDirtyChange?.(true);
  };

  useEffect(() => {
    let cancelled = false;
    api.listRepos().then(
      (list) => {
        if (cancelled) return;
        setRepos(list);
        if (!repoTouched.current) setD((prev) => ({ ...prev, repo: list[0]?.repo ?? '' }));
      },
      () => undefined,
    );
    api.listMachines().then(
      (rows) => {
        if (!cancelled) setMachines(rows.filter((r) => r.revoked_at === null));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  const cron = draftCron(d);
  const ruleError = validateSchedule(cron, d.timezone.trim());
  const preview = useMemo(() => {
    if (ruleError !== null) return [];
    try {
      return nextRuns(cron, d.timezone.trim(), new Date(), 3);
    } catch {
      return [];
    }
  }, [cron, d.timezone, ruleError]);

  /** What closing would lose (a repo picked for a new schedule from the list is not an edit). */
  function isDirty(): boolean {
    const body = bodyEditor.current?.flush() ?? d.body;
    const base = repoTouched.current ? initial : { ...initial, repo: d.repo };
    // The rich editor may normalise markdown: compare the body by its text.
    if (body.trim() !== base.body.trim()) return true;
    return JSON.stringify({ ...d, body: '' }) !== JSON.stringify({ ...base, body: '' });
  }

  function requestClose() {
    if (isDirty()) setConfirm('discard');
    else onClose();
  }

  const onEscape = useRef<() => void>(() => undefined);
  useEffect(() => {
    onEscape.current = () => {
      if (confirm !== null) setConfirm(null);
      else requestClose();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onEscape.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function fail(err: unknown) {
    if (err instanceof ApiRequestError) {
      const byField: Partial<Record<FieldPath, string>> = {};
      for (const det of err.details) {
        const head = det.path.split('.')[0] as FieldPath;
        if ((FIELD_PATHS as readonly string[]).includes(head)) byField[head] = det.message;
      }
      setFieldErrors(byField);
      if (err.code === 'conflict' && byField.name === undefined) {
        setConflict(true);
        setError('Changed elsewhere since you opened it.');
        return;
      }
      if (Object.keys(byField).length > 0) {
        setError(null);
        return;
      }
    }
    setError(errorMessage(err));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (d.kind === null || ruleError !== null) return;
    const body = bodyEditor.current?.flush() ?? d.body;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setConflict(false);
    try {
      const dto =
        schedule === null
          ? await api.saveSchedule(null, {
              name: d.name.trim(),
              repo: d.repo.trim(),
              kind: d.kind,
              title: d.title.trim(),
              body,
              cron,
              timezone: d.timezone.trim(),
              enabled: d.enabled,
              machines: d.machineIds.length > 0 ? d.machineIds : null,
            })
          : await api.saveSchedule(schedule.id, changedFields(schedule, d, body));
      onDirtyChange?.(false);
      onSaved(dto);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (schedule === null) return;
    try {
      const fresh = (await api.listSchedules()).schedules.find((s) => s.id === schedule.id);
      onDirtyChange?.(false);
      if (fresh) onReloaded(fresh);
      else onDeleted(schedule.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    if (schedule === null) return;
    setBusy(true);
    try {
      await api.deleteSchedule(schedule.id);
      onDirtyChange?.(false);
      onDeleted(schedule.id);
    } catch (err) {
      setConfirm(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const missing = [
    d.name.trim() === '' && 'a name',
    d.repo.trim() === '' && 'a repo',
    d.kind === null && 'Work or Personal',
    d.title.trim() === '' && 'a title',
    d.picker === 'weekly' && d.days.length === 0 && 'a day of the week',
    ruleError !== null && 'a valid schedule',
  ].filter((m): m is string => m !== false);
  const valid = missing.length === 0;
  const ruleMessage =
    ruleError === null
      ? null
      : ruleError.code === 'schedule_too_frequent'
        ? 'Runs must be at least 15 minutes apart.'
        : ruleError.message;
  const fieldError = (path: FieldPath) =>
    fieldErrors[path] ? (
      <span className="field-error error" role="alert">
        {fieldErrors[path]}
      </span>
    ) : null;

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet schedule-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <header className="sheet-head">
          <h2 id={headingId}>{schedule === null ? 'New schedule' : 'Edit schedule'}</h2>
          <button type="button" className="sheet-close" onClick={requestClose} aria-label="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <form
          className="create-ticket schedule-form"
          aria-label={schedule === null ? 'New schedule' : 'Edit schedule'}
          onSubmit={(e) => void onSubmit(e)}
        >
          <label className="field-title">
            Name
            <input
              value={d.name}
              maxLength={SCHEDULE_NAME_MAX}
              onChange={(e) => set('name', e.target.value)}
              required
            />
            {fieldError('name')}
          </label>
          <div className="sc-repo-cell">
            <RepoCombobox
              value={d.repo}
              onChange={(r) => {
                repoTouched.current = true;
                set('repo', r);
              }}
              suggestions={repos}
            />
            {fieldError('repo')}
          </div>
          <fieldset className="kind-choice" aria-required="true">
            <legend>Kind</legend>
            {TICKET_KINDS.map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="schedule-kind"
                  value={k}
                  checked={d.kind === k}
                  onChange={() => set('kind', k)}
                  required
                />
                {TICKET_KIND_LABELS[k]}
              </label>
            ))}
          </fieldset>
          <label className="wide">
            Ticket title
            <input
              value={d.title}
              maxLength={SCHEDULE_TITLE_MAX}
              onChange={(e) => set('title', e.target.value)}
              required
            />
            <span className="muted sc-hint">
              Each run’s ticket is called this plus the run time.
            </span>
            {fieldError('title')}
          </label>

          <fieldset className="wide sc-when">
            <legend>When</legend>
            <div className="sc-when-row">
              <label>
                Repeats
                <select
                  value={d.picker}
                  onChange={(e) => {
                    const next = e.target.value as PickerKind;
                    // Advanced starts from the cron the picker wrote.
                    if (next === 'advanced') set('rawCron', cron);
                    set('picker', next);
                  }}
                >
                  {(Object.keys(PICKER_LABELS) as PickerKind[]).map((k) => (
                    <option key={k} value={k}>
                      {PICKER_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              {d.picker !== 'advanced' && (
                <label>
                  At
                  <input
                    type="time"
                    value={d.time}
                    onChange={(e) => set('time', e.target.value || '00:00')}
                    required
                  />
                </label>
              )}
              {d.picker === 'monthly' && (
                <label>
                  Day of the month
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={d.dayOfMonth}
                    onChange={(e) =>
                      set('dayOfMonth', Math.min(31, Math.max(1, Number(e.target.value) || 1)))
                    }
                  />
                </label>
              )}
              {d.picker === 'advanced' && (
                <label className="sc-cron">
                  Cron (minute hour day month weekday)
                  <input
                    value={d.rawCron}
                    onChange={(e) => set('rawCron', e.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                </label>
              )}
              <label>
                Timezone
                <input
                  value={d.timezone}
                  list={zones.length > 0 ? zonesId : undefined}
                  onChange={(e) => set('timezone', e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  required
                />
                {zones.length > 0 && (
                  <datalist id={zonesId}>
                    {zones.map((z) => (
                      <option key={z} value={z} />
                    ))}
                  </datalist>
                )}
                {fieldError('timezone')}
              </label>
            </div>
            {d.picker === 'weekly' && (
              <div className="sc-days" role="group" aria-label="Days of the week">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={d.days.includes(day)}
                    onClick={() =>
                      set(
                        'days',
                        d.days.includes(day)
                          ? d.days.filter((x) => x !== day)
                          : [...d.days, day].sort((a, b) => a - b),
                      )
                    }
                  >
                    {WEEKDAY_SHORT[day]}
                  </button>
                ))}
              </div>
            )}
            {d.picker === 'monthly' && d.dayOfMonth > 28 && (
              <p className="muted sc-hint">Months without a {d.dayOfMonth}th day are skipped.</p>
            )}
            {ruleMessage !== null ? (
              <p className="error" role="alert">
                {ruleMessage}
              </p>
            ) : (
              <p className="muted sc-preview" aria-live="polite">
                {describeSchedule(cron, d.timezone.trim())}. Next:{' '}
                {preview
                  .map((r) =>
                    new Intl.DateTimeFormat(undefined, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      hourCycle: 'h23',
                    }).format(r),
                  )
                  .join(', ')}
              </p>
            )}
            {fieldError('cron')}
          </fieldset>

          <fieldset className="wide sc-machines">
            <legend>Run only on these machines</legend>
            <p className="muted sc-hint">None checked: any machine with the repo.</p>
            {machines.length === 0 && <p className="muted">No machines yet.</p>}
            {machines.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  checked={d.machineIds.includes(m.id)}
                  onChange={(e) =>
                    set(
                      'machineIds',
                      e.target.checked
                        ? [...d.machineIds, m.id]
                        : d.machineIds.filter((x) => x !== m.id),
                    )
                  }
                />
                {m.name || m.hostname} <span className="muted">({m.status})</span>
              </label>
            ))}
            {fieldError('machines')}
          </fieldset>

          {schedule === null && (
            <label className="sc-enabled">
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              Enabled (runs on schedule)
            </label>
          )}

          <div className="wide">
            <TicketBodyField
              value={d.body}
              onChange={(md) => set('body', md)}
              editorHandle={bodyEditor}
            />
          </div>

          <div className="form-actions">
            {confirm === 'discard' && (
              <div className="sheet-confirm" role="alertdialog" aria-label="Discard your changes?">
                <span>Discard your changes?</span>
                <button type="button" className="danger" onClick={onClose}>
                  Discard
                </button>
                <button type="button" onClick={() => setConfirm(null)} autoFocus>
                  Keep editing
                </button>
              </div>
            )}
            {confirm === 'delete' && schedule !== null && (
              <div
                className="sheet-confirm"
                role="alertdialog"
                aria-label={`Delete ${schedule.name}?`}
              >
                <span>Delete {schedule.name}? Its past tickets stay on the board.</span>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete
                </button>
                <button type="button" onClick={() => setConfirm(null)} autoFocus>
                  Keep
                </button>
              </div>
            )}
            {confirm === null && (
              <>
                <button
                  type="submit"
                  disabled={busy || !valid}
                  {...(!valid ? { 'aria-describedby': hintId } : {})}
                >
                  {schedule === null ? 'Create schedule' : 'Save'}
                </button>
                {schedule !== null && (
                  <button type="button" className="danger" onClick={() => setConfirm('delete')}>
                    Delete…
                  </button>
                )}
                {!valid && (
                  <span id={hintId} className="form-hint muted">
                    Still needed: {missing.join(', ')}
                  </span>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}{' '}
                {conflict && (
                  <button type="button" onClick={() => void reload()}>
                    Reload
                  </button>
                )}
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
