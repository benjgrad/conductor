import { TICKET_KINDS, type TicketDetail, type TicketKind } from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { TICKET_KIND_LABELS } from './format.js';
import type { RichEditorHandle } from './ticket-editor/RichTicketEditor.js';
import { TicketBodyField } from './ticket-editor/TicketBodyField.js';

interface TicketEditorProps {
  api: ApiClient;
  /** The ticket as loaded; its `updated_at` guards the edit against a newer change. */
  ticket: TicketDetail;
  onSaved: (ticket: TicketDetail) => void;
  onCancel: () => void;
  /** 409: the ticket changed since it was loaded; reload it (the edit is dropped). */
  onReload: () => void;
}

/**
 * PATCH /api/tickets/:id: title, body, priority and kind, in a column that allows edits
 * (`ticket_editable`). Only the changed fields are sent.
 */
export function TicketEditor({ api, ticket, onSaved, onCancel, onReload }: TicketEditorProps) {
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const bodyEditor = useRef<RichEditorHandle | null>(null);
  const [priority, setPriority] = useState(String(ticket.priority));
  const [kind, setKind] = useState<TicketKind | null>(ticket.kind ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const kindName = useId();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The rich editor exports on a debounce: take its latest text now.
    const markdown = bodyEditor.current?.flush() ?? body;
    const prio = Number.parseInt(priority, 10) || 0;
    const patch = {
      ...(title.trim() !== ticket.title ? { title: title.trim() } : {}),
      ...(markdown !== ticket.body ? { body: markdown } : {}),
      ...(prio !== ticket.priority ? { priority: prio } : {}),
      ...(kind !== null && kind !== (ticket.kind ?? null) ? { kind } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.updateTicket(ticket.id, { expected_updated_at: ticket.updated_at, ...patch }),
      );
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) setStale(true);
      else if (err instanceof ApiRequestError && err.code === 'ticket_not_editable') {
        setError(err.message);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="create-ticket ticket-editor-form"
      aria-label="Edit ticket"
      onSubmit={(e) => void onSubmit(e)}
    >
      <label className="field-title">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Priority
        <input
          type="number"
          inputMode="numeric"
          step={1}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </label>
      <fieldset className="kind-choice">
        <legend>Kind</legend>
        {TICKET_KINDS.map((k) => (
          <label key={k}>
            <input
              type="radio"
              name={kindName}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {TICKET_KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <div className="wide">
        <TicketBodyField value={body} onChange={setBody} editorHandle={bodyEditor} />
      </div>
      <div className="form-actions">
        <button type="submit" disabled={busy || title.trim() === ''}>
          Save
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {stale && (
          <p role="alert" className="error">
            This ticket changed since you opened it; reload to see the latest.{' '}
            <button type="button" onClick={onReload}>
              Reload
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
