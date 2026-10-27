// The Details tab's building blocks (UX-7 moved them here from DetailPanel, unchanged): the
// agent card, workflow, spend & time, and the approve/cancel actions.
import type { MachineDto, SessionDetail } from '@conductor/shared';
import { useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { AgentAvatar } from './agent-identity.js';
import { duration, TERMINAL_STATUSES, usd } from './format.js';
import { PendingChecklist } from './transitions.js';
import { SessionWorkflowDiagram } from '../workflow/SessionWorkflowDiagram.js';
import { displayState } from '../workflow/review.js';

/**
 * ADR-0011: an old workflow version offers no human transitions (`human_transitions` is empty),
 * so it keeps the M1 quick actions and /retry; a newer one has a button per transition instead.
 */
export function isOldVersion(detail: SessionDetail): boolean {
  return detail.card.human_transitions.length === 0;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function AgentCard({
  api,
  detail,
  sessionId,
  name,
}: {
  api: ApiClient;
  detail: SessionDetail;
  sessionId: string;
  name: string;
}) {
  const { card } = detail;
  const machineId = card.machine_id;
  const [machine, setMachine] = useState<MachineDto | null>(null);
  useEffect(() => {
    if (machineId === null) return;
    let cancelled = false;
    api.listMachines().then(
      (list) => {
        if (!cancelled) setMachine(list.find((m) => m.id === machineId) ?? null);
      },
      // Best effort: without the machine list the id alone is shown.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, machineId]);
  const shown = machine?.id === machineId ? machine : null;

  return (
    <section aria-label="Agent" className="agent-card">
      <div className="agent-who">
        <AgentAvatar ticketId={card.ticket_id} size={64} title={`${name}'s avatar`} />
        <div>
          <div className="agent-card-name">{name}</div>
          <div className="muted">Claude Code agent</div>
        </div>
      </div>
      <dl className="kv">
        <dt>Machine</dt>
        <dd>
          {machineId === null ? (
            <span className="muted">not on a machine right now</span>
          ) : (
            <span className="machine">
              {shown && (
                <span
                  className={`dot dot-${shown.status}`}
                  role="img"
                  aria-label={shown.status}
                  title={shown.status}
                />
              )}
              <strong>{shown?.hostname ?? machineId}</strong>
              {shown && shown.hostname !== machineId && (
                <span className="muted"> ({machineId})</span>
              )}
              {shown && <span className="muted"> · {shown.status}</span>}
            </span>
          )}
        </dd>
        <dt>Session</dt>
        <dd className="copyable">
          <code>{sessionId}</code>
          <CopyButton text={sessionId} label="session id" />
        </dd>
        {detail.branch && (
          <>
            <dt>Branch</dt>
            <dd>
              <code>{detail.branch}</code>
            </dd>
          </>
        )}
        <dt>Repo</dt>
        <dd>{card.repo}</dd>
        {detail.worktree_path && (
          <>
            <dt>Worktree</dt>
            <dd className="copyable">
              <code>{detail.worktree_path}</code>
              <CopyButton text={detail.worktree_path} label="worktree path" />
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

export function WorkflowSection({ detail }: { detail: SessionDetail }) {
  const { card, workflow } = detail;
  return (
    <section aria-label="Workflow">
      <h4>Workflow</h4>
      <p className="state-line">
        <strong>{card.workflow_state ? displayState(card.workflow_state, workflow) : '—'}</strong>{' '}
        <span className="muted">
          in {workflow.id} v{detail.workflow_version}
        </span>
        {card.badges.includes('waiting_for_build_slot') && (
          <span className="badge badge-slot">waiting for build slot</span>
        )}
      </p>
      {/* A compact list of states; the state diagram (SessionWorkflowDiagram, ADR-0009) follows. */}
      <ol className="states">
        {Object.entries(workflow.states).map(([name, state]) => (
          <li
            key={name}
            className={`state state-${state.type}${name === card.workflow_state ? ' current' : ''}`}
            aria-current={name === card.workflow_state ? 'step' : undefined}
          >
            {name}
          </li>
        ))}
      </ol>
      {card.pending && <PendingChecklist pending={card.pending} />}
      <SessionWorkflowDiagram detail={detail} />
      {detail.return_to && (
        <p className="muted returns-to">
          Returns to <strong>{detail.return_to}</strong> after the answer.
        </p>
      )}
    </section>
  );
}

/** Approve (event states waiting on ui.approve) and cancel. */
export function Actions({
  api,
  detail,
  onDone,
}: {
  api: ApiClient;
  detail: SessionDetail;
  onDone: () => void;
}) {
  const { card } = detail;
  const sessionId = card.session_id;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sessionId === null || card.status === null || TERMINAL_STATUSES.has(card.status)) return null;

  const state = card.workflow_state ? detail.workflow.states[card.workflow_state] : undefined;
  const canApprove =
    card.status === 'waiting_external' &&
    state?.type === 'event' &&
    state.wait_for.includes('ui.approve');
  // A pending non-agent request on an old version already offers Abort (the quick actions).
  const canCancel = !(
    detail.pending_input &&
    detail.pending_input.kind !== 'agent_question' &&
    isOldVersion(detail)
  );

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canApprove && !canCancel) return null;
  return (
    <section aria-label="Actions" className="actions">
      <h4>Actions</h4>
      <div className="actions-row">
        {canApprove && (
          <div className="approve">
            <input
              aria-label="Approval comment"
              placeholder="comment (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.approve(sessionId, comment.trim() ? { comment: comment.trim() } : {}),
                )
              }
            >
              Approve
            </button>
          </div>
        )}
        {canCancel && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void run(() => api.cancel(sessionId, { reason: 'cancelled from UI' }))}
          >
            Cancel session
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <meter min={0} max={max} value={Math.min(value, max)} high={max * 0.8} aria-label={label} />
      <span className={pct >= 100 ? 'over' : undefined}>{text}</span>
    </div>
  );
}

export function BudgetSection({ detail }: { detail: SessionDetail }) {
  const minutes = detail.wall_seconds / 60;
  return (
    <section aria-label="Budget" className="budget">
      <h4>Spend &amp; time</h4>
      <Meter
        label="Spend"
        value={detail.spend_usd}
        max={detail.budget.usd}
        text={`${usd(detail.spend_usd)} / ${usd(detail.budget.usd)}`}
      />
      <Meter
        label="Time"
        value={minutes}
        max={detail.budget.minutes}
        text={`${duration(detail.wall_seconds)} / ${detail.budget.minutes}m`}
      />
    </section>
  );
}
