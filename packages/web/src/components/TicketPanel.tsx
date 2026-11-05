// The panel for a card with no session yet (Queued): the ticket itself, readable in any column,
// and editable where the column allows it (`ticket_editable`, GET / PATCH /api/tickets/:id).
// A session's panel (DetailPanel) offers the same edit through EditTicket. UXR-86 / UXR-42 /
// UXR-34: a queued ticket can also be cancelled (and reopened), reprioritised, and says why no
// machine has taken it.
import {
  TICKET_PRIORITY_MAX,
  TICKET_PRIORITY_MIN,
  type BoardCardRouting,
  type TicketDetail,
} from '@conductor/shared';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { routingSentence } from '../machines/format.js';
import { routeHash } from '../nav.js';
import { AgentAttachments, AttachmentGallery } from './AttachmentGallery.js';
import { splitAttachments } from './attachment-groups.js';
import { ago, TICKET_KIND_LABELS } from './format.js';
import { Markdown } from './markdown.js';
import { TicketEditor } from './TicketEditor.js';

/** GET /api/tickets/:id, again whenever `version` (the card's updated_at) changes. */
export function useTicket(api: ApiClient, ticketId: string, version: string, enabled = true) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.getTicket(ticketId).then(
      (t) => {
        if (cancelled) return;
        setTicket(t);
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, ticketId, version, enabled, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ticket, error, reload, setTicket };
}

interface TicketPanelProps {
  api: ApiClient;
  ticketId: string;
  /** The card's updated_at on the board: a change refetches the ticket. */
  version: string;
  onClose: () => void;
  /** 11-web-ui §Detail panel: the phone's full-screen panel, with Back to board instead of ×. */
  fullScreen?: boolean;
  /** The card's routing (ADR-0013 §Routing): set while no online machine can take it. */
  routing?: BoardCardRouting | undefined;
}

export function TicketPanel({
  api,
  ticketId,
  version,
  onClose,
  fullScreen = false,
  routing,
}: TicketPanelProps) {
  const { ticket, error, reload, setTicket } = useTicket(api, ticketId, version);
  const [editing, setEditing] = useState(false);

  return (
    <aside className={`detail${fullScreen ? ' full-screen' : ''}`} aria-label="Ticket detail">
      <header className="detail-head">
        {fullScreen && (
          <button type="button" className="back" onClick={onClose} aria-label="Back to board">
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
        <div className="head-text">
          <h2>{ticket?.title ?? 'Loading…'}</h2>
          {ticket && (
            <div className="head-sub">
              <span className="chip status">{ticket.column_title}</span>
            </div>
          )}
        </div>
        {!fullScreen && (
          <button type="button" className="close" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="error detail-error">
          {error}
        </p>
      )}
      <div className="tab-body details-tab ticket-panel">
        {ticket &&
          (editing ? (
            <TicketEditor
              api={api}
              ticket={ticket}
              onSaved={(t) => {
                setTicket(t);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
              onReload={() => {
                setEditing(false);
                reload();
              }}
            />
          ) : (
            <TicketView
              api={api}
              ticket={ticket}
              routing={routing}
              onEdit={() => setEditing(true)}
              onChanged={setTicket}
              onReload={reload}
            />
          ))}
      </div>
    </aside>
  );
}

/** The ticket, read-only, with Edit when its column allows it. */
function TicketView({
  api,
  ticket,
  routing,
  onEdit,
  onChanged,
  onReload,
}: {
  api: ApiClient;
  ticket: TicketDetail;
  routing: BoardCardRouting | undefined;
  onEdit: () => void;
  onChanged: (t: TicketDetail) => void;
  onReload: () => void;
}) {
  const queued = ticket.column === 'queued';
  const finished = ticket.status === 'done' || ticket.status === 'cancelled';
  return (
    <>
      {queued && routing && <RoutingNote routing={routing} />}
      <section aria-label="Ticket">
        <dl className="ticket-meta">
          <dt>Repo</dt>
          <dd>
            <code>{ticket.repo}</code>
          </dd>
          {ticket.kind && (
            <>
              <dt>Kind</dt>
              <dd>{TICKET_KIND_LABELS[ticket.kind]}</dd>
            </>
          )}
          <dt>Priority</dt>
          <dd>
            {queued && ticket.editable && !finished ? (
              <PriorityStepper
                api={api}
                ticket={ticket}
                onChanged={onChanged}
                onReload={onReload}
              />
            ) : (
              <>P{ticket.priority}</>
            )}
          </dd>
          {ticket.external_ref && (
            <>
              <dt>Reference</dt>
              <dd>{ticket.external_ref}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{ago(ticket.created_at)}</dd>
        </dl>
        {ticket.editable ? (
          <button type="button" onClick={onEdit}>
            Edit ticket
          </button>
        ) : (
          <p className="muted">
            The {ticket.column_title} column doesn't allow editing the ticket.
          </p>
        )}
        <TicketLifecycle api={api} ticket={ticket} onDone={onReload} />
      </section>
      {/* FR-4 (UXR-86): an empty description shows nothing. */}
      {ticket.body.trim() && (
        <section aria-label="Description">
          <h3>Description</h3>
          <Markdown text={ticket.body} />
        </section>
      )}
      <TicketAttachmentSections api={api} ticket={ticket} />
    </>
  );
}

/** UXR-34: why no machine has picked the ticket up, in words, with the way to fix it. */
function RoutingNote({ routing }: { routing: BoardCardRouting }) {
  const why = routingSentence(routing);
  return (
    <p className="routing-note" role="status">
      No machine can take this{why === '' ? '.' : `: ${why}.`}{' '}
      <a href={routeHash({ view: 'machines' })}>Machines ›</a>
    </p>
  );
}

/**
 * UXR-42: raise or lower a queued ticket's priority via PATCH. P-scale (ADR-0036): the lower number
 * is more urgent and claimed first, so Raise steps towards P0 and Lower towards P4.
 */
function PriorityStepper({
  api,
  ticket,
  onChanged,
  onReload,
}: {
  api: ApiClient;
  ticket: TicketDetail;
  onChanged: (t: TicketDetail) => void;
  onReload: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = (delta: number) => {
    setSaving(true);
    setError(null);
    api
      .updateTicket(ticket.id, {
        expected_updated_at: ticket.updated_at,
        priority: ticket.priority + delta,
      })
      .then(onChanged, (err: unknown) => {
        setError(errorMessage(err));
        if (err instanceof ApiRequestError && err.code === 'conflict') onReload();
      })
      .finally(() => setSaving(false));
  };
  return (
    <span className="priority-stepper">
      <span>P{ticket.priority}</span>
      <button
        type="button"
        className="icon"
        aria-label="Raise priority"
        title="Raise priority"
        disabled={saving || ticket.priority <= TICKET_PRIORITY_MIN}
        onClick={() => step(-1)}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon"
        aria-label="Lower priority"
        title="Lower priority"
        disabled={saving || ticket.priority >= TICKET_PRIORITY_MAX}
        onClick={() => step(1)}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </span>
  );
}

/** UXR-86: Cancel ticket… (a reason, a confirmation) and, once cancelled, Reopen ticket. */
function TicketLifecycle({
  api,
  ticket,
  onDone,
}: {
  api: ApiClient;
  ticket: TicketDetail;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    call()
      .then(
        () => {
          setConfirming(false);
          setReason('');
          onDone();
        },
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => setBusy(false));
  };
  const errorLine = error && (
    <p role="alert" className="error">
      {error}
    </p>
  );
  if (ticket.status === 'done') return null;
  if (ticket.status === 'cancelled') {
    return (
      <div className="ticket-lifecycle">
        <p className="muted">Cancelled.</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => api.reopenTicket(ticket.id))}
        >
          Reopen ticket
        </button>
        {errorLine}
      </div>
    );
  }
  if (!confirming) {
    return (
      <div className="ticket-lifecycle">
        <button type="button" onClick={() => setConfirming(true)}>
          Cancel ticket…
        </button>
      </div>
    );
  }
  const trimmed = reason.trim();
  return (
    <div className="ticket-lifecycle ticket-cancel" role="alertdialog" aria-label="Cancel ticket">
      <p>Cancel this ticket? No machine will pick it up. You can reopen it later.</p>
      <textarea
        aria-label="Reason (optional)"
        placeholder="Reason (optional)"
        maxLength={500}
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="ticket-cancel-actions">
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => run(() => api.cancelTicket(ticket.id, trimmed ? { reason: trimmed } : {}))}
        >
          Cancel ticket
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} autoFocus>
          Keep ticket
        </button>
      </div>
      {errorLine}
    </div>
  );
}

interface EditTicketProps {
  api: ApiClient;
  ticketId: string;
  /** The session's state runs an agent: say that a live agent won't see the edit yet. */
  agentRunning: boolean;
  onSaved: () => void;
  /** The Edit sheet (TicketStrip.tsx): the editor from the start, no button. */
  startOpen?: boolean;
  /** Called after Save or Cancel closes the editor (the sheet closes too). */
  onClose?: () => void;
}

/** A session panel's "Edit ticket" (shown when `SessionDetail.ticket_editable`). */
export function EditTicket({
  api,
  ticketId,
  agentRunning,
  onSaved,
  startOpen = false,
  onClose,
}: EditTicketProps) {
  const [open, setOpen] = useState(startOpen);
  const { ticket, error, reload } = useTicket(api, ticketId, '', open);
  if (!open) {
    return (
      <div className="edit-ticket">
        <button type="button" onClick={() => setOpen(true)}>
          Edit ticket
        </button>
      </div>
    );
  }
  return (
    <section className="edit-ticket" aria-label="Edit ticket">
      {agentRunning && (
        <p className="muted">
          A running agent won't see the change until its next step; send it a message if it needs it
          now.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {ticket ? (
        <TicketEditor
          key={ticket.updated_at}
          api={api}
          ticket={ticket}
          onSaved={() => {
            setOpen(false);
            onSaved();
            onClose?.();
          }}
          onCancel={() => {
            setOpen(false);
            onClose?.();
          }}
          onReload={reload}
        />
      ) : (
        !error && <p className="muted">Loading the ticket…</p>
      )}
    </section>
  );
}

/**
 * 06 §Attachments: a session panel's view of the ticket's attachments (the session detail doesn't
 * carry them; GET /api/tickets/:id does). Nothing while there are none.
 */
export function TicketAttachments({
  api,
  ticketId,
  version,
}: {
  api: ApiClient;
  ticketId: string;
  version: string;
}) {
  const { ticket } = useTicket(api, ticketId, version);
  if (ticket === null) return null;
  return (
    <div className="ticket-attachments">
      <TicketAttachmentSections api={api} ticket={ticket} />
    </div>
  );
}

/**
 * 06 §Attachments: the human's attachments ("Attachments") and what the agents attached ("From
 * the agent", grouped by state). Each section only when it has files.
 */
export function TicketAttachmentSections({
  api,
  ticket,
}: {
  api: ApiClient;
  ticket: Pick<TicketDetail, 'attachments'>;
}) {
  const { human, agent } = splitAttachments(ticket.attachments ?? []);
  return (
    <>
      {human.length > 0 && (
        <section aria-label="Attachments">
          <h3>Attachments</h3>
          <AttachmentGallery api={api} attachments={human} />
        </section>
      )}
      <AgentAttachments api={api} attachments={agent} />
    </>
  );
}
