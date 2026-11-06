// ADR-0039: "Skip permissions" (Claude Code's `--permission-mode bypassPermissions`) for a
// ticket's working agents, or as a machine's default. Turning it on always asks first, with what it
// removes and what still applies. A ticket's setting can change in any column, while its agent runs:
// pending permission prompts are allowed at once, and the mode applies from the next process start.
import { effectiveSkipPermissions, type TicketDetail } from '@conductor/shared';
import { useId, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { ModalDialog } from './ModalDialog.js';

export const SKIP_PERMISSIONS_LABEL = 'Skip permissions';

/** What the confirmation says, for a ticket or for a machine's default. */
export function skipPermissionsRisk(scope: 'ticket' | 'machine'): string {
  const who =
    scope === 'ticket'
      ? "This ticket's agents"
      : 'Agents on this machine (unless their ticket says otherwise)';
  return (
    `${who} will run without permission checks: no auto-mode classifier and no prompts, so ` +
    'any command or edit the agent tries runs at once. Deny rules (git push stays denied) and ' +
    'the worktree edit guard still apply. Reviewers and QA keep their read-only mode.'
  );
}

/** The confirmation before turning skip permissions on. */
export function SkipPermissionsConfirm({
  scope,
  onConfirm,
  onCancel,
}: {
  scope: 'ticket' | 'machine';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  return (
    <ModalDialog labelledBy={headingId} onClose={onCancel}>
      <h2 id={headingId}>
        {scope === 'ticket' ? 'Skip permissions for this ticket?' : 'Skip permissions by default?'}
      </h2>
      <p>{skipPermissionsRisk(scope)}</p>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Skip permissions
        </button>
      </div>
    </ModalDialog>
  );
}

type Choice = 'default' | 'on' | 'off';

const toChoice = (v: boolean | null | undefined): Choice =>
  v === true ? 'on' : v === false ? 'off' : 'default';
const fromChoice = (c: Choice): boolean | null => (c === 'on' ? true : c === 'off' ? false : null);

/**
 * The ticket's "Agent permissions" section: machine default / skip permissions / ask (auto mode),
 * editable in any column.
 */
export function SkipPermissionsSection({
  api,
  ticket,
  onChanged,
}: {
  api: ApiClient;
  ticket: Pick<TicketDetail, 'id' | 'skip_permissions' | 'machine_skip_permissions_default'>;
  onChanged: (t: TicketDetail) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const machineDefault = ticket.machine_skip_permissions_default ?? null;
  const on = effectiveSkipPermissions(ticket.skip_permissions, machineDefault);

  async function save(value: boolean | null) {
    setSaving(true);
    setError(null);
    try {
      onChanged(await api.setSkipPermissions(ticket.id, { skip_permissions: value }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Agent permissions" className="skip-permissions">
      <h3>Agent permissions</h3>
      <label htmlFor={selectId}>Permission checks</label>{' '}
      <select
        id={selectId}
        value={toChoice(ticket.skip_permissions)}
        disabled={saving}
        onChange={(e) => {
          const c = e.target.value as Choice;
          if (c === 'on') setConfirming(true);
          else void save(fromChoice(c));
        }}
      >
        <option value="default">
          Machine default
          {machineDefault === null ? '' : machineDefault ? ' (skip)' : ' (ask)'}
        </option>
        <option value="off">Ask (auto mode)</option>
        <option value="on">{SKIP_PERMISSIONS_LABEL}</option>
      </select>
      {on && (
        <p className="machine-warning">
          ⚠ This ticket's agents skip permission checks (from their next start; pending prompts are
          allowed).
        </p>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {confirming && (
        <SkipPermissionsConfirm
          scope="ticket"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void save(true);
          }}
        />
      )}
    </section>
  );
}

/** The Needs-permission box's "Skip permissions for this ticket…" (allows what is pending). */
export function SkipPermissionsButton({
  api,
  ticketId,
  onDone,
}: {
  api: ApiClient;
  ticketId: string;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="skip-permissions-action">
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        Skip permissions for this ticket…
      </button>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {confirming && (
        <SkipPermissionsConfirm
          scope="ticket"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            api.setSkipPermissions(ticketId, { skip_permissions: true }).then(
              () => onDone(),
              (err: unknown) => setError(errorMessage(err)),
            );
          }}
        />
      )}
    </div>
  );
}
