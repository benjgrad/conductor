// ADR-0045: the ticket's requirements checklist (`context.__requirements`), in the Details tab.
// The planning agent writes it; conductor's reviewer checks each item off at every review; a human
// can edit it here. After planning an agent can only propose a change (with a question): the
// proposal shows here, and in the Messages tab next to the question, with Apply / Keep current.
import {
  proposalDiff,
  requirementsOfContext,
  requirementsProgress,
  type RequirementItem,
  type Requirements,
  type SessionDetail,
} from '@conductor/shared';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { useId, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import './RequirementsSection.css';

interface Props {
  api: ApiClient;
  detail: Pick<SessionDetail, 'context' | 'card'>;
  onReload: () => void;
}

/** What each status reads as: an icon and words, never colour alone. */
export const REQUIREMENT_STATUS_LABELS: Record<RequirementItem['status'], string> = {
  met: 'Met',
  unmet: 'Not met',
  pending: 'Not checked yet',
};

function StatusIcon({ status }: { status: RequirementItem['status'] }) {
  const Icon = status === 'met' ? CircleCheck : status === 'unmet' ? CircleX : CircleDashed;
  return <Icon size={16} aria-hidden="true" className={`req-icon req-${status}`} />;
}

/** Whether the session is finished (nothing changes the checklist any more). */
function finished(detail: Props['detail']): boolean {
  const s = detail.card.status;
  return s === 'done' || s === 'failed' || s === 'lost';
}

/** The Details tab's Requirements section; nothing for a session without a checklist. */
export function RequirementsSection({ api, detail, onReload }: Props) {
  const reqs = requirementsOfContext(detail.context);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  if (reqs === null) return null;
  const sessionId = detail.card.session_id;
  const reviewing = detail.card.checking?.phase === 'review';
  const readOnly = finished(detail) || sessionId === null;
  const { met, total } = requirementsProgress(reqs);

  const save = (body: { items: string[] } | { apply_proposal: true }) => {
    if (sessionId === null) return;
    setBusy(true);
    setError(null);
    api
      .setRequirements(sessionId, body)
      .then(() => {
        setEditing(false);
        onReload();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-label="Requirements" className="requirements">
      <h3>Requirements</h3>
      {total > 0 ? (
        <p className="req-summary">
          <strong>
            {met} of {total} met
          </strong>
          <span className="muted"> · {setByLine(reqs)}</span>
        </p>
      ) : (
        <p className="muted">No requirements yet.</p>
      )}
      {reqs.proposed !== null && !readOnly && (
        <RequirementsProposal reqs={reqs} busy={busy || reviewing} onSave={save} />
      )}
      {editing ? (
        <form
          className="req-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save({ items: draft.split('\n') });
          }}
        >
          <label htmlFor={textId}>One requirement per line</label>
          <textarea
            id={textId}
            rows={Math.min(12, Math.max(4, reqs.items.length + 1))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p className="muted">
            Unchanged lines keep their status; new ones start as not checked yet.
          </p>
          <div className="quick-actions">
            <button type="submit" className="primary" disabled={busy}>
              Save requirements
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {total > 0 && (
            <ul className="req-list">
              {reqs.items.map((i) => (
                <li key={i.text} className={`req-item req-${i.status}`}>
                  <StatusIcon status={i.status} />
                  <div>
                    <span className="req-text">{i.text}</span>{' '}
                    <span className="req-status">{REQUIREMENT_STATUS_LABELS[i.status]}</span>
                    {i.reason !== null && <p className="req-reason muted">{i.reason}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {reqs.ignored !== null && (
            <p className="muted req-ignored">
              The {reqs.ignored.from_state} agent tried to change this list without asking;
              conductor ignored it. Only a person can change the requirements.
            </p>
          )}
          {!readOnly && (
            <div className="quick-actions">
              <button
                type="button"
                disabled={busy || reviewing}
                onClick={() => {
                  setDraft(reqs.items.map((i) => i.text).join('\n'));
                  setEditing(true);
                }}
              >
                Edit requirements
              </button>
              {reviewing && (
                <span className="muted">
                  Conductor is reviewing them now; edit when it is done.
                </span>
              )}
            </div>
          )}
        </>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function setByLine(r: Requirements): string {
  const who = r.set_by === 'agent' ? `set in ${r.set_in}` : 'edited by you';
  return r.revision > 1 ? `${who} (revision ${r.revision})` : who;
}

/** An agent's proposed change: what it adds and removes, and Apply / Keep current. */
export function RequirementsProposal({
  reqs,
  busy,
  onSave,
}: {
  reqs: Requirements;
  busy: boolean;
  onSave: (body: { items: string[] } | { apply_proposal: true }) => void;
}) {
  if (reqs.proposed === null) return null;
  const current = reqs.items.map((i) => i.text);
  const { added, removed } = proposalDiff(current, reqs.proposed.items);
  return (
    <div className="req-proposal" role="group" aria-label="Proposed requirements change">
      <h4>The {reqs.proposed.from_state} agent proposes changing the requirements</h4>
      <p className="muted">
        Nothing changes until you apply it. Then answer its question as usual.
      </p>
      {removed.length > 0 && (
        <>
          <p>Removes:</p>
          <ul className="req-diff">
            {removed.map((t) => (
              <li key={t} className="req-removed">
                <span className="req-diff-mark">−</span> {t}
              </li>
            ))}
          </ul>
        </>
      )}
      {added.length > 0 && (
        <>
          <p>Adds:</p>
          <ul className="req-diff">
            {added.map((t) => (
              <li key={t} className="req-added">
                <span className="req-diff-mark">+</span> {t}
              </li>
            ))}
          </ul>
        </>
      )}
      {removed.length === 0 && added.length === 0 && <p>Reorders the list.</p>}
      <div className="quick-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onSave({ apply_proposal: true })}
        >
          Apply proposed requirements
        </button>
        <button type="button" disabled={busy} onClick={() => onSave({ items: current })}>
          Keep current
        </button>
      </div>
    </div>
  );
}

/**
 * The proposal by itself, for the Messages tab next to the agent's question. Nothing without one.
 */
export function PendingRequirementsProposal({ api, detail, onReload }: Props) {
  const reqs = requirementsOfContext(detail.context);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = detail.card.session_id;
  if (reqs === null || reqs.proposed === null || sessionId === null) return null;
  return (
    <section className="requirements" aria-label="Proposed requirements">
      <RequirementsProposal
        reqs={reqs}
        busy={busy}
        onSave={(body) => {
          setBusy(true);
          setError(null);
          api
            .setRequirements(sessionId, body)
            .then(onReload)
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
