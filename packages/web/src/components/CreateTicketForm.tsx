import { CONDUCTOR_WORKFLOW_ID } from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';

interface CreateTicketFormProps {
  api: ApiClient;
  onCreated?: () => void;
}

const DEFAULT_REPO = 'github.com/benjgrad/fixture-app';

/**
 * POST /api/tickets, always on the one `conductor` workflow (ADR-0010). The new card arrives on
 * the board stream (card.upserted), not from here.
 */
export function CreateTicketForm({ api, onCreated }: CreateTicketFormProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [priority, setPriority] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTicket({
        title: title.trim(),
        body,
        repo: repo.trim(),
        // ADR-0010: one workflow, so no picker. The server defaults workflow_id to it; sending it
        // explicitly also works with a server (and shared contract) where the field is required.
        workflow_id: CONDUCTOR_WORKFLOW_ID,
        priority: Number.parseInt(priority, 10) || 0,
        // ADR-0011: kind is required; M1b-T07 adds the picker. Until then every ticket is work.
        kind: 'work',
      });
      setTitle('');
      setBody('');
      onCreated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const valid = title.trim() !== '' && repo.trim() !== '';
  return (
    <form className="create-ticket" aria-label="Create ticket" onSubmit={(e) => void onSubmit(e)}>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Repo
        <input value={repo} onChange={(e) => setRepo(e.target.value)} required />
      </label>
      <label>
        Priority
        <input
          type="number"
          step={1}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </label>
      <label className="wide">
        Description
        <textarea value={body} rows={4} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={busy || !valid}>
          Create ticket
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
