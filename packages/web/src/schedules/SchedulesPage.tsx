import type { ScheduleDto, ScheduleWarning } from '@conductor/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { TICKET_KIND_LABELS } from '../components/format.js';
import {
  describeSchedule,
  formatNextRun,
  showSkipped,
  TICKET_STATUS_LABELS,
} from './cron-words.js';
import { ScheduleSheet } from './ScheduleSheet.js';
import './schedules.css';

/** Where a ticket opens: the board selects it (notify/open-ticket.ts). */
export const ticketHref = (ticketId: string) => `#/?ticket=${encodeURIComponent(ticketId)}`;

export const WARNING_TEXT: Record<ScheduleWarning, string> = {
  no_machine_has_repo: 'No machine has this repo checked out, so runs wait.',
  machine_lacks_repo: 'A pinned machine doesn’t have this repo checked out.',
  pinned_machine_revoked: 'A pinned machine was removed.',
};

interface SchedulesPageProps {
  api: ApiClient;
  /** The schedule whose edit sheet is open (from the route), or none. */
  scheduleId: string | null;
  /** Open a schedule's sheet (null closes it), by moving the route. */
  onOpen: (scheduleId: string | null) => void;
  /** The sheet has unsaved edits (the app's draft guard holds navigation back). */
  onDirtyChange?: (dirty: boolean) => void;
}

type List =
  { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'loaded'; rows: ScheduleDto[] };

type RowNote =
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'started'; ticketId: string }
  | { kind: 'confirm-run' };

/**
 * `#/schedules[/<id>]` (ADR-0032, UXR-83): the account's recurring jobs. Each row says when it
 * runs, when next, how the last run went, and pauses, runs now or opens its sheet. The same
 * functions as the MCP tools list_schedules / save_schedule / delete_schedule / run_schedule_now.
 */
export function SchedulesPage({ api, scheduleId, onOpen, onDirtyChange }: SchedulesPageProps) {
  const [list, setList] = useState<List>({ kind: 'loading' });
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.listSchedules().then(
      (res) => setList({ kind: 'loaded', rows: res.schedules }),
      (err: unknown) => setList({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api]);
  useEffect(() => load(), [load]);

  const setNote = (id: string, note: RowNote | null) =>
    setNotes((all) => {
      const next = { ...all };
      if (note === null) delete next[id];
      else next[id] = note;
      return next;
    });

  const replaceRow = (dto: ScheduleDto) =>
    setList((l) =>
      l.kind !== 'loaded'
        ? l
        : {
            kind: 'loaded',
            rows: l.rows.some((r) => r.id === dto.id)
              ? l.rows.map((r) => (r.id === dto.id ? dto : r))
              : [...l.rows, dto].sort((a, b) => a.name.localeCompare(b.name)),
          },
    );

  async function toggle(row: ScheduleDto) {
    setNote(row.id, { kind: 'busy' });
    // Shown at once; put back on failure.
    replaceRow({ ...row, enabled: !row.enabled });
    try {
      replaceRow(
        await api.saveSchedule(row.id, {
          enabled: !row.enabled,
          expected_updated_at: row.updated_at,
        }),
      );
      setNote(row.id, null);
    } catch (err) {
      replaceRow(row);
      setNote(row.id, { kind: 'error', text: errorMessage(err) });
      if (err instanceof ApiRequestError && err.code === 'conflict') load();
    }
  }

  async function runNow(row: ScheduleDto, force: boolean) {
    setNote(row.id, { kind: 'busy' });
    try {
      const res = await api.runScheduleNow(row.id, { force });
      replaceRow(res.schedule);
      setNote(row.id, { kind: 'started', ticketId: res.ticket_id });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'previous_run_open') {
        setNote(row.id, { kind: 'confirm-run' });
      } else if (err instanceof ApiRequestError && err.code === 'conflict') {
        setNote(row.id, { kind: 'error', text: 'It just ran: try again in a second.' });
      } else {
        setNote(row.id, { kind: 'error', text: errorMessage(err) });
      }
    }
  }

  const rows = list.kind === 'loaded' ? list.rows : [];
  const editing = scheduleId === null ? null : (rows.find((r) => r.id === scheduleId) ?? null);
  const missing = list.kind === 'loaded' && scheduleId !== null && editing === null;

  function closeSheet() {
    setCreating(false);
    onDirtyChange?.(false);
    if (scheduleId !== null) onOpen(null);
  }

  return (
    <section className="schedules" aria-label="Schedules">
      <div className="sc-head">
        <h2>Schedules</h2>
        <button type="button" onClick={() => setCreating(true)} aria-haspopup="dialog">
          New schedule
        </button>
      </div>
      <p className="muted sc-note">
        Recurring jobs: each run makes a ticket from the template, and an agent does what it says. A
        run is skipped while the last one is still open.
      </p>
      {missing && (
        <p role="status" className="muted">
          That schedule no longer exists.
        </p>
      )}
      {list.kind === 'loading' && <p className="loading">Loading…</p>}
      {list.kind === 'error' && (
        <p role="alert" className="error">
          {list.text}
        </p>
      )}
      {list.kind === 'loaded' && rows.length === 0 && (
        <p className="muted">No recurring jobs yet.</p>
      )}
      {rows.length > 0 && (
        <div className="sc-scroll">
          <table className="sc-table" aria-label="Recurring jobs">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>Last run</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ScheduleRow
                  key={row.id}
                  row={row}
                  note={notes[row.id] ?? null}
                  onEdit={() => onOpen(row.id)}
                  onToggle={() => void toggle(row)}
                  onRun={(force) => void runNow(row, force)}
                  onDismiss={() => setNote(row.id, null)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(creating || editing !== null) && (
        <ScheduleSheet
          // A new sheet per schedule (and per version, after a Reload): the form starts from it.
          key={editing ? `${editing.id}:${editing.updated_at}` : 'new'}
          api={api}
          schedule={creating ? null : editing}
          onClose={closeSheet}
          onSaved={(dto) => {
            replaceRow(dto);
            closeSheet();
          }}
          onDeleted={(id) => {
            setList((l) =>
              l.kind === 'loaded' ? { kind: 'loaded', rows: l.rows.filter((r) => r.id !== id) } : l,
            );
            closeSheet();
          }}
          onReloaded={replaceRow}
          {...(onDirtyChange ? { onDirtyChange } : {})}
        />
      )}
    </section>
  );
}

interface ScheduleRowProps {
  row: ScheduleDto;
  note: RowNote | null;
  onEdit: () => void;
  onToggle: () => void;
  onRun: (force: boolean) => void;
  onDismiss: () => void;
}

function ScheduleRow({ row, note, onEdit, onToggle, onRun, onDismiss }: ScheduleRowProps) {
  const busy = note?.kind === 'busy';
  const last = row.last_ticket;
  return (
    <>
      <tr className={row.enabled ? undefined : 'sc-paused'}>
        <td data-label="Name">
          <button type="button" className="link sc-name" onClick={onEdit}>
            {row.name}
          </button>
          <div className="sc-sub">
            <span className="sc-repo">{row.repo}</span>{' '}
            <span className={`tag tag-kind tag-${row.kind}`}>{TICKET_KIND_LABELS[row.kind]}</span>
          </div>
          {row.warnings?.map((w) => (
            <p key={w} className="sc-warning muted">
              {WARNING_TEXT[w]}
            </p>
          ))}
        </td>
        <td data-label="Schedule">{describeSchedule(row.cron, row.timezone)}</td>
        <td data-label="Next run">
          {row.next_run_at === null ? (
            <span className="muted">Paused</span>
          ) : (
            formatNextRun(row.next_run_at)
          )}
        </td>
        <td data-label="Last run">
          {last === null ? (
            <span className="muted">Never</span>
          ) : (
            <a href={ticketHref(last.id)}>
              {TICKET_STATUS_LABELS[last.status]}
              <span className="visually-hidden"> (open the last run’s ticket)</span>
            </a>
          )}
          {showSkipped(row) && <p className="sc-skipped">Skipped: last run still open</p>}
        </td>
        <td className="sc-actions">
          <label className="sc-switch">
            <input
              type="checkbox"
              role="switch"
              checked={row.enabled}
              disabled={busy}
              onChange={onToggle}
              aria-label={`Enabled: ${row.name}`}
            />
            <span aria-hidden="true">{row.enabled ? 'On' : 'Off'}</span>
          </label>
          <button type="button" disabled={busy} onClick={() => onRun(false)}>
            Run now
          </button>
          <button type="button" onClick={onEdit} aria-label={`Edit ${row.name}`}>
            Edit
          </button>
        </td>
      </tr>
      {note !== null && note.kind !== 'busy' && (
        <tr className="sc-note-row">
          <td colSpan={5}>
            {note.kind === 'error' && (
              <p role="alert" className="error">
                {note.text}
              </p>
            )}
            {note.kind === 'started' && (
              <p role="status">
                Started: <a href={ticketHref(note.ticketId)}>open the new ticket</a>{' '}
                <button type="button" className="link" onClick={onDismiss}>
                  Dismiss
                </button>
              </p>
            )}
            {note.kind === 'confirm-run' && (
              <div
                className="sheet-confirm"
                role="alertdialog"
                aria-label={`Run ${row.name} anyway?`}
              >
                <span>
                  The last run (
                  {last ? (
                    <a href={ticketHref(last.id)}>{TICKET_STATUS_LABELS[last.status]}</a>
                  ) : (
                    'its ticket'
                  )}
                  ) is still open. Runs are skipped while it is, so they don’t pile up. Run anyway?
                </span>
                <button type="button" className="danger" onClick={() => onRun(true)}>
                  Run anyway
                </button>
                <button type="button" onClick={onDismiss} autoFocus>
                  Cancel
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
