import type { ChangeProposalDetail } from '@conductor/shared';
import { useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { readableOf } from '../workflow/ProposalsPanel.js';
import { VersionDiff } from '../workflow/VersionDiff.js';

// An agent's proposed repo checks on its ticket (ask_user `proposed_checks`, 05 §Requirements to
// enter a column, "Setup failures"). The agent can only propose: the change does nothing until a
// human applies it here (or with MCP apply_change). Applying it answers the agent's question, so
// it finishes again and the checks re-run with the new config; tickets waiting on a check-config
// failure for the repo retry their checks on their own.

export interface TicketCheckProposalProps {
  api: ApiClient;
  ticketId: string;
  /** Applied or rejected: the panel reloads. */
  onDone?: () => void;
}

/** The ticket's open agent-proposed check changes, each with its diff and Apply / Reject. */
export function TicketCheckProposal({ api, ticketId, onDone }: TicketCheckProposalProps) {
  const [open, setOpen] = useState<ChangeProposalDetail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void api
      .listChangeProposals({ kind: 'repo_checks', status: 'proposed', ticketId })
      .then((r) => Promise.all(r.proposals.map((p) => api.getChangeProposal(p.id))))
      .then((ps) => {
        if (live) setOpen(ps);
      })
      .catch(() => {
        // An older server has no ticket filter: nothing to show.
        if (live) setOpen([]);
      });
    return () => {
      live = false;
    };
  }, [api, ticketId, reload]);

  if (open.length === 0) return null;
  const act = (p: ChangeProposalDetail, how: 'apply' | 'reject') => {
    setBusy(true);
    setError(null);
    (how === 'apply' ? api.applyChangeProposal(p.id) : api.rejectChangeProposal(p.id))
      .then(() => {
        setReload((n) => n + 1);
        onDone?.();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="check-proposals" aria-label="Proposed check changes">
      {open.map((p) => {
        const readable = readableOf(p);
        return (
          <div key={p.id} className="check-proposal">
            <h4>
              Proposed repo checks for {p.target}: {p.title}
            </h4>
            <p className="muted">
              The agent proposed this; nothing changes until you apply it. Applying it answers its
              question and the checks re-run.
            </p>
            <p>{p.rationale}</p>
            {readable !== null && (
              <VersionDiff changes={readable} label={`Changes in ${p.title}`} />
            )}
            <div className="quick-actions" role="group" aria-label="Proposal actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => act(p, 'apply')}
              >
                Apply checks
              </button>
              <button type="button" disabled={busy} onClick={() => act(p, 'reject')}>
                Reject
              </button>
            </div>
          </div>
        );
      })}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
