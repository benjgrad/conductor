import { TICKET_KINDS, type TicketDetail, type TicketKind } from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { AttachmentPicker, AttachmentThumb, useAttachmentUploads } from './AttachmentPicker.js';
import { priorityChoices, priorityLabel, TICKET_KIND_LABELS } from './format.js';
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
  const [priority, setPriority] = useState(ticket.priority);
  const [kind, setKind] = useState<TicketKind | null>(ticket.kind ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const kindName = useId();
  // 06 §Attachments: new uploads are linked on Save; existing ones can be marked for removal.
  const uploads = useAttachmentUploads(api);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const existing = ticket.attachments ?? [];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The rich editor exports on a debounce: take its latest text now.
    const markdown = bodyEditor.current?.flush() ?? body;
    const patch = {
      ...(title.trim() !== ticket.title ? { title: title.trim() } : {}),
      ...(markdown !== ticket.body ? { body: markdown } : {}),
      ...(priority !== ticket.priority ? { priority } : {}),
      ...(kind !== null && kind !== (ticket.kind ?? null) ? { kind } : {}),
      ...(uploads.ids.length > 0 ? { add_attachment_ids: uploads.ids } : {}),
      ...(removed.size > 0 ? { remove_attachment_ids: [...removed] } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateTicket(ticket.id, {
        expected_updated_at: ticket.updated_at,
        ...patch,
      });
      uploads.reset();
      onSaved(saved);
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
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
          {priorityChoices(ticket.priority).map((p) => (
            <option key={p} value={p}>
              {priorityLabel(p)}
            </option>
          ))}
        </select>
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
      <div className="wide" onPasteCapture={uploads.onPaste}>
        <TicketBodyField value={body} onChange={setBody} editorHandle={bodyEditor} />
      </div>
      <div className="wide">
        {existing.length > 0 && (
          <ul className="attachment-uploads" aria-label="Attachments">
            {existing.map((a) => {
              const gone = removed.has(a.id);
              return (
                <li key={a.id} className={`attachment-upload${gone ? ' removed' : ''}`}>
                  <AttachmentThumb api={api} attachment={a} />
                  <span className="attachment-name">{gone ? <s>{a.name}</s> : a.name}</span>
                  <button
                    type="button"
                    aria-label={`${gone ? 'Keep' : 'Remove'} ${a.name}`}
                    onClick={() =>
                      setRemoved((prev) => {
                        const next = new Set(prev);
                        if (gone) next.delete(a.id);
                        else next.add(a.id);
                        return next;
                      })
                    }
                  >
                    {gone ? 'Keep' : 'Remove'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <AttachmentPicker api={api} uploads={uploads} />
      </div>
      <div className="form-actions">
        <button type="submit" disabled={busy || title.trim() === '' || uploads.uploading}>
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
