import {
  CONDUCTOR_WORKFLOW_ID,
  TICKET_KINDS,
  type RepoSuggestion,
  type TicketKind,
} from '@conductor/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { TICKET_KIND_LABELS } from './format.js';
import { RepoCombobox } from './RepoCombobox.js';
import type { RichEditorHandle } from './ticket-editor/RichTicketEditor.js';
import { TicketBodyField } from './ticket-editor/TicketBodyField.js';
import { stripPlaceholders, TICKET_TEMPLATE } from './ticket-editor/template.js';

interface CreateTicketFormProps {
  api: ApiClient;
  onCreated?: () => void;
  /**
   * 11-web-ui §Create ticket: the phone's full-screen sheet (a modal dialog with a heading, Close
   * and a sticky Create ticket footer that says what's missing).
   */
  sheet?: boolean;
  /** Closes the sheet (its Close button and Escape). */
  onClose?: () => void;
}

/**
 * POST /api/tickets, always on the one `conductor` workflow (ADR-0010). Work or Personal is
 * required (ADR-0011: transitions filter on it; no triage until M4). The new card arrives on the
 * board stream (card.upserted), not from here.
 */
export function CreateTicketForm({
  api,
  onCreated,
  sheet = false,
  onClose,
}: CreateTicketFormProps) {
  const [title, setTitle] = useState('');
  // UX-3: markdown from the requirements template; untouched placeholders are dropped on submit.
  const [body, setBody] = useState(TICKET_TEMPLATE);
  const [bodyKey, setBodyKey] = useState(0);
  const bodyEditor = useRef<RichEditorHandle | null>(null);
  // Starts on the account's top repo (GET /api/repos) unless the user typed one first.
  const [repo, setRepo] = useState('');
  const repoTouched = useRef(false);
  const [repos, setRepos] = useState<RepoSuggestion[]>([]);
  const [reposKey, setReposKey] = useState(0);
  const [priority, setPriority] = useState('0');
  const [kind, setKind] = useState<TicketKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const hintId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Best effort: without the list the field is plain free text.
  useEffect(() => {
    let cancelled = false;
    api.listRepos().then(
      (list) => {
        if (cancelled) return;
        setRepos(list);
        if (!repoTouched.current) setRepo(list[0]?.repo ?? '');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, reposKey]);

  // The dialog takes focus when it opens (not the title field: that would pop the keyboard up).
  useEffect(() => {
    if (sheet) sheetRef.current?.focus();
  }, [sheet]);

  useEffect(() => {
    if (!sheet || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      // The repo list's Escape closes the list only.
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, onClose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (kind === null) return;
    // The rich editor exports on a debounce: take its latest text now, so a click that doesn't
    // move focus can't submit stale markdown.
    const markdown = bodyEditor.current?.flush() ?? body;
    setBusy(true);
    setError(null);
    try {
      await api.createTicket({
        title: title.trim(),
        body: stripPlaceholders(markdown),
        repo: repo.trim(),
        // ADR-0010: one workflow, so no picker. The server defaults workflow_id to it; sending it
        // explicitly also works with a server (and shared contract) where the field is required.
        workflow_id: CONDUCTOR_WORKFLOW_ID,
        priority: Number.parseInt(priority, 10) || 0,
        // Always sent: the shared contract makes it required once M1b-T04 merges.
        kind,
      });
      setTitle('');
      setBody(TICKET_TEMPLATE);
      setBodyKey((k) => k + 1);
      setKind(null);
      // The repo stays chosen; its ranking changed.
      repoTouched.current = true;
      setReposKey((k) => k + 1);
      onCreated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const valid = title.trim() !== '' && repo.trim() !== '' && kind !== null;
  const missing = [
    title.trim() === '' && 'a title',
    repo.trim() === '' && 'a repo',
    kind === null && 'Work or Personal',
  ].filter((m): m is string => m !== false);
  const form = (
    <form className="create-ticket" aria-label="Create ticket" onSubmit={(e) => void onSubmit(e)}>
      <label className="field-title">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <RepoCombobox
        value={repo}
        onChange={(r) => {
          repoTouched.current = true;
          setRepo(r);
        }}
        suggestions={repos}
      />
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
      <fieldset className="kind-choice" aria-required="true">
        <legend>Kind</legend>
        {TICKET_KINDS.map((k) => (
          <label key={k}>
            <input
              type="radio"
              name="ticket-kind"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              required
            />
            {TICKET_KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <div className="wide">
        <TicketBodyField
          value={body}
          onChange={setBody}
          resetKey={bodyKey}
          editorHandle={bodyEditor}
        />
      </div>
      <div className="form-actions">
        <button
          type="submit"
          disabled={busy || !valid}
          {...(sheet && !valid ? { 'aria-describedby': hintId } : {})}
        >
          Create ticket
        </button>
        {sheet && !valid && (
          <span id={hintId} className="form-hint muted">
            Still needed: {missing.join(', ')}
          </span>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </form>
  );
  if (!sheet) return form;
  return (
    <div
      ref={sheetRef}
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <header className="sheet-head">
        <h2 id={headingId}>New ticket</h2>
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {form}
    </div>
  );
}
