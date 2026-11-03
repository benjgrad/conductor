// ADR-0034: the session panel's "Proposed tickets" box. Follow-up tickets the agent proposed
// (`SessionDetail.proposed_tickets`), each with its title, Markdown body and why, and two answers:
// Queue ticket (optionally after editing the title and body: a new, independent ticket on the
// same repo and workflow) and Dismiss. Decided ones are listed below, collapsed.
import type { TicketProposalDto } from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { Markdown } from './markdown.js';
import './ProposedTickets.css';

export const PROPOSED_TICKETS_LABEL = 'Proposed tickets';

interface ProposedTicketsProps {
  api: ApiClient;
  proposals: readonly TicketProposalDto[];
  agent: string;
  onDone: () => void;
}

export function ProposedTickets({ api, proposals, agent, onDone }: ProposedTicketsProps) {
  const pending = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending');
  if (pending.length === 0 && decided.length === 0) return null;
  return (
    <section aria-label={PROPOSED_TICKETS_LABEL} className="pending proposed-tickets">
      <div className="pending-head">
        <span className="badge badge-proposals">{PROPOSED_TICKETS_LABEL}</span>
        <span className="muted">
          {pending.length > 0
            ? `${agent} suggests ${pending.length === 1 ? 'a follow-up' : `${pending.length} follow-ups`} that could run in parallel`
            : 'All decided'}
        </span>
      </div>
      {pending.map((p) => (
        <ProposalItem key={p.id} api={api} proposal={p} onDone={onDone} />
      ))}
      {decided.length > 0 && (
        <details className="proposal-decided">
          <summary className="muted">{decided.length} decided</summary>
          <ul>
            {decided.map((p) => (
              <li key={p.id}>
                {p.status === 'accepted' ? 'Queued' : 'Dismissed'}: {p.title}
                {p.created_ticket_id !== null && (
                  <>
                    {' '}
                    <a href={`#/?ticket=${p.created_ticket_id}`}>open</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ProposalItem({
  api,
  proposal,
  onDone,
}: {
  api: ApiClient;
  proposal: TicketProposalDto;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
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

  const accept = () =>
    run(() =>
      api.acceptProposal(
        proposal.id,
        editing
          ? {
              ...(title.trim() !== proposal.title ? { title: title.trim() } : {}),
              ...(body !== proposal.body ? { body } : {}),
            }
          : {},
      ),
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() === '') return;
    void accept();
  }

  return (
    <div className="proposal" role="group" aria-label={`Proposed: ${proposal.title}`}>
      {editing ? (
        <form onSubmit={submit} className="proposal-edit">
          <label htmlFor={`${ids}-title`}>Title</label>
          <input
            id={`${ids}-title`}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label htmlFor={`${ids}-body`}>Description</label>
          <textarea
            id={`${ids}-body`}
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="proposal-actions">
            <button type="submit" className="primary" disabled={busy || title.trim() === ''}>
              Queue ticket
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel edit
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="proposal-title">{proposal.title}</div>
          {proposal.why !== null && <p className="muted proposal-why">{proposal.why}</p>}
          {proposal.body.trim() !== '' && <Markdown text={proposal.body} />}
          <div className="proposal-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void accept()}>
              Queue ticket
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              Edit first
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.dismissProposal(proposal.id))}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
