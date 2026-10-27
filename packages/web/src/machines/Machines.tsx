import type { EnrollmentTokenCreated, MachineDetail, MachineRow } from '@conductor/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { ago } from '../components/format.js';
import { AddMachine } from './AddMachine.js';
import { ghTooOld, ghTooOldText } from './format.js';
import { MachineDrawer } from './MachineDrawer.js';
import './machines.css';

/** RenameMachineRequest's limit (10-contracts). */
const NAME_MAX = 64;

interface MachinesPageProps {
  api: ApiClient;
}

type List =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'loaded'; rows: MachineRow[]; details: ReadonlyMap<string, MachineDetail> };

/**
 * `#/machines` (ADR-0013 §Enrollment, M2-T11): the account's machines with rename and revoke, a
 * drawer with each one's inventory, and Add a machine (the one-time install command).
 */
export function MachinesPage({ api }: MachinesPageProps) {
  const [list, setList] = useState<List>({ kind: 'loading' });
  const [enrollment, setEnrollment] = useState<EnrollmentTokenCreated | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<MachineDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listMachines().then(
      async (rows) => {
        // TD-186: the gh version (outdated-gh flag) and the alert count are only in the detail, so
        // the list fetches each machine's detail (N+1); add them to MachineRow when the fleet grows.
        const settled = await Promise.allSettled(rows.map((r) => api.getMachine(r.id)));
        const details = new Map<string, MachineDetail>();
        for (const s of settled) if (s.status === 'fulfilled') details.set(s.value.id, s.value);
        setList({ kind: 'loaded', rows, details });
      },
      (err: unknown) => setList({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api]);

  useEffect(() => load(), [load]);

  /** Runs one action, then reloads the list. */
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setActionError(null);
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      setActionError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
      load();
    }
  }

  async function addMachine() {
    const created = await act(() => api.createEnrollmentToken());
    if (created) setEnrollment(created);
  }

  async function askRevoke(row: MachineRow) {
    // Always fresh: the confirmation names the sessions that go to a human now.
    const detail = await act(() => api.getMachine(row.id));
    if (detail) setConfirmRevoke(detail);
  }

  const details = list.kind === 'loaded' ? list.details : new Map<string, MachineDetail>();
  const opened = open ? details.get(open) : undefined;

  return (
    <section className="machines" aria-label="Machines">
      <div className="machines-head">
        <h2>Machines</h2>
        <button type="button" onClick={() => void addMachine()} disabled={busy || !!enrollment}>
          Add a machine
        </button>
      </div>
      {enrollment && (
        <AddMachine
          enrollment={enrollment}
          onClose={() => {
            setEnrollment(null);
            load();
          }}
        />
      )}
      {actionError && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      {confirmRevoke && (
        <RevokeConfirm
          machine={confirmRevoke}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => {
            const m = confirmRevoke;
            setConfirmRevoke(null);
            void act(() => api.revokeMachine(m.id));
          }}
        />
      )}
      {list.kind === 'loading' && <p className="loading">Loading…</p>}
      {list.kind === 'error' && (
        <p role="alert" className="error">
          {list.text}{' '}
          <button type="button" onClick={load}>
            Retry
          </button>
        </p>
      )}
      {list.kind === 'loaded' && list.rows.length === 0 && (
        <p className="muted">No machines yet. Add one to run sessions on it.</p>
      )}
      {list.kind === 'loaded' && list.rows.length > 0 && (
        <table className="machines-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Daemon</th>
              <th>Claude</th>
              <th>Repos</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((m) => {
              const detail = list.details.get(m.id);
              const oldGh = detail ? ghTooOld(detail.capabilities) : null;
              return (
                <tr key={m.id} className={m.revoked_at ? 'machine-revoked' : undefined}>
                  <td>
                    {renaming === m.id ? (
                      <RenameForm
                        name={m.name}
                        onCancel={() => setRenaming(null)}
                        onSave={(name) => {
                          setRenaming(null);
                          void act(() => api.renameMachine(m.id, { name }));
                        }}
                      />
                    ) : (
                      <>
                        <span className="machine-name">{m.name}</span>
                        {m.name !== m.hostname && <span className="muted"> {m.hostname}</span>}
                      </>
                    )}
                    {detail && detail.alerts.length > 0 && (
                      <span className="badge badge-alert">
                        {detail.alerts.length === 1 ? '1 alert' : `${detail.alerts.length} alerts`}
                      </span>
                    )}
                    {oldGh !== null && <p className="machine-warning">⚠ {ghTooOldText(oldGh)}</p>}
                  </td>
                  <td>
                    {m.revoked_at ? (
                      <span className="machine-status-revoked">Revoked {ago(m.revoked_at)}</span>
                    ) : (
                      <span className={`machine-status-${m.status}`}>{m.status}</span>
                    )}
                  </td>
                  <td>{m.last_heartbeat_at ? ago(m.last_heartbeat_at) : 'never'}</td>
                  <td>
                    {m.daemon_version ?? '—'}
                    {m.outdated && (
                      <span
                        className="badge badge-update"
                        title="A newer daemon is available: run the install command again"
                      >
                        update
                      </span>
                    )}
                  </td>
                  <td>{m.claude_version ?? '—'}</td>
                  <td>{m.repo_count}</td>
                  <td className="machines-actions">
                    <button
                      type="button"
                      aria-label={`Details of ${m.name}`}
                      disabled={!detail}
                      onClick={() => setOpen(m.id)}
                    >
                      Details
                    </button>
                    {!m.revoked_at && (
                      <>
                        <button
                          type="button"
                          aria-label={`Rename ${m.name}`}
                          onClick={() => setRenaming(m.id)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Revoke ${m.name}`}
                          disabled={busy}
                          onClick={() => void askRevoke(m)}
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {opened && <MachineDrawer machine={opened} onClose={() => setOpen(null)} />}
    </section>
  );
}

function RenameForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  const ok = trimmed !== '' && trimmed.length <= NAME_MAX;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ok) onSave(trimmed);
  }

  return (
    <form className="machine-rename" aria-label="Rename machine" onSubmit={onSubmit}>
      <input
        aria-label="Machine name"
        value={value}
        maxLength={NAME_MAX}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" disabled={!ok}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function RevokeConfirm({
  machine,
  onConfirm,
  onCancel,
}: {
  machine: MachineDetail;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="machine-panel" role="alertdialog" aria-label="Revoke machine">
      <p>
        Revoke {machine.name}? It disconnects at once and can't reconnect; to use this computer
        again, add it as a new machine.
      </p>
      {machine.live_sessions.length > 0 ? (
        <>
          <p>These sessions will go to a human:</p>
          <ul aria-label="Sessions that go to a human">
            {machine.live_sessions.map((s) => (
              <li key={s.session_id}>{s.title}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>No sessions are running on it.</p>
      )}
      <div className="machines-actions">
        <button type="button" className="danger" onClick={onConfirm}>
          Revoke
        </button>
        <button type="button" onClick={onCancel} autoFocus>
          Cancel
        </button>
      </div>
    </div>
  );
}
