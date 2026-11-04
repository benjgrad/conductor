// The panel for a card with no session yet (Queued): the ticket itself, readable in any column,
// and editable where the column allows it (`ticket_editable`, GET / PATCH /api/tickets/:id).
// A session's panel (DetailPanel) offers the same edit through EditTicket.
import type { TicketDetail } from '@conductor/shared';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { AttachmentGallery } from './AttachmentGallery.js';
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
}

export function TicketPanel({
  api,
  ticketId,
  version,
  onClose,
  fullScreen = false,
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
            <TicketView api={api} ticket={ticket} onEdit={() => setEditing(true)} />
          ))}
      </div>
    </aside>
  );
}

/** The ticket, read-only, with Edit when its column allows it. */
function TicketView({
  api,
  ticket,
  onEdit,
}: {
  api: ApiClient;
  ticket: TicketDetail;
  onEdit: () => void;
}) {
  return (
    <>
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
          <dd>P{ticket.priority}</dd>
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
      </section>
      <section aria-label="Description">
        <h3>Description</h3>
        {ticket.body.trim() ? (
          <Markdown text={ticket.body} />
        ) : (
          <p className="muted">(no description)</p>
        )}
      </section>
      {(ticket.attachments?.length ?? 0) > 0 && (
        <section aria-label="Attachments">
          <h3>Attachments</h3>
          <AttachmentGallery api={api} attachments={ticket.attachments ?? []} />
        </section>
      )}
    </>
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
  const list = ticket?.attachments ?? [];
  if (list.length === 0) return null;
  return (
    <section className="ticket-attachments" aria-label="Attachments">
      <h3>Attachments</h3>
      <AttachmentGallery api={api} attachments={list} />
    </section>
  );
}
