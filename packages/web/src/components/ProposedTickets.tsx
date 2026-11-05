// 06 §Proposed tickets: follow-up tickets the agent proposed, shown while the ticket waits in
// Needs input. Approve creates a real ticket (title and body editable first); Dismiss hides it.
// Neither moves this ticket: it still waits for its own answer or transition. The section is a
// disclosure, collapsed by default (the header carries the count), remembered per ticket.
import {
  proposalTicketBody,
  type TicketProposal,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { displayState } from '../workflow/review.js';

/** The column whose cards show proposals (the board badge uses the same rule). */
export const PROPOSALS_COLUMN = 'needs_input';

const storageKey = (ticketId: string) => `conductor.proposals.open.${ticketId}`;

function readOpen(ticketId: string): boolean {
  try {
    return localStorage.getItem(storageKey(ticketId)) === 'open';
  } catch {
    return false;
  }
}

function writeOpen(ticketId: string, open: boolean) {
  try {
    localStorage.setItem(storageKey(ticketId), open ? 'open' : 'closed');
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

/** Pending proposals to show for a card in `column`; none outside Needs input. */
export function visibleProposals(
  column: string | null | undefined,
  proposals: readonly TicketProposal[] | undefined,
): TicketProposal[] {
  if (column !== PROPOSALS_COLUMN) return [];
  return (proposals ?? []).filter((p) => p.status === 'pending');
}

interface ProposedTicketsProps {
  api: ApiClient;
  ticketId: string;
  /** The parent's title, for the default body's link back. */
  ticketTitle: string;
  /** Already filtered (`visibleProposals`). */
  proposals: readonly TicketProposal[];
  workflow?: WorkflowDefinition;
  /** After an approve or dismiss (reload the detail). */
  onDone?: () => void;
}

export function ProposedTickets({
  api,
  ticketId,
  ticketTitle,
  proposals,
  workflow,
  onDone,
}: ProposedTicketsProps) {
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(() => readOpen(ticketId));
  // Decided here: hidden at once, before the reload brings the new status.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const shown = proposals.filter((p) => !decided.has(p.id));
  if (shown.length === 0) return null;
  const done = (id: string) => {
    setDecided((d) => new Set(d).add(id));
    onDone?.();
  };
  return (
    <section className="proposals" aria-labelledby={headingId}>
      <h3>
        <button
          type="button"
          className="proposals-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            writeOpen(ticketId, !open);
          }}
        >
          <span className="proposals-chevron" aria-hidden="true">
            ▸
          </span>
          <span id={headingId}>Proposed follow-up tickets</span>
          <span className="proposals-count">{shown.length}</span>
        </button>
      </h3>
      <div id={bodyId} className="proposals-body" hidden={!open}>
        <p className="muted proposals-note">
          The agent noticed these outside this ticket. Approving one queues it as a new ticket; this
          ticket keeps waiting for you either way.
        </p>
        <ul>
          {shown.map((p) => (
            <ProposalCard
              key={p.id}
              api={api}
              ticketId={ticketId}
              ticketTitle={ticketTitle}
              proposal={p}
              stateLabel={workflow ? displayState(p.state, workflow) : p.state}
              onDone={() => done(p.id)}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

interface ProposalCardProps {
  api: ApiClient;
  ticketId: string;
  ticketTitle: string;
  proposal: TicketProposal;
  stateLabel: string;
  onDone: () => void;
}

function ProposalCard({
  api,
  ticketId,
  ticketTitle,
  proposal: p,
  stateLabel,
  onDone,
}: ProposalCardProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(p.title);
  const [body, setBody] = useState(() =>
    proposalTicketBody(p, { id: ticketId, title: ticketTitle }),
  );
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  async function run(fn: () => Promise<unknown>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() === '') return;
    void run(() => api.approveProposal(ticketId, { proposal_id: p.id, title: title.trim(), body }));
  }

  return (
    <li className="proposal" aria-label={p.title}>
      <div className="proposal-head">
        <strong className="proposal-title">{p.title}</strong>
        <span className="ref proposal-repo">{p.repo}</span>
      </div>
      <p className="proposal-why">{p.why}</p>
      <p className="muted proposal-from">Proposed in {stateLabel}</p>
      {editing ? (
        <form className="proposal-edit" aria-label={`Approve ${p.title}`} onSubmit={submit}>
          <label htmlFor={`${ids}-title`}>Title</label>
          <input
            id={`${ids}-title`}
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <label htmlFor={`${ids}-body`}>Description</label>
          <textarea
            id={`${ids}-body`}
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="proposal-actions">
            <button type="submit" className="primary" disabled={busy || title.trim() === ''}>
              Create ticket
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <span className="proposal-actions">
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            Approve…
          </button>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => void run(() => api.dismissProposal(ticketId, { proposal_id: p.id }))}
          >
            Dismiss
          </button>
        </span>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
}
