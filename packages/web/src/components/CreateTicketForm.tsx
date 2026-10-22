import type { WorkflowSummary } from '@conductor/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';

interface CreateTicketFormProps {
  api: ApiClient;
  onCreated?: () => void;
}

const DEFAULT_REPO = 'github.com/benjgrad/fixture-app';

/** POST /api/tickets. The new card arrives on the board stream (card.upserted), not from here. */
export function CreateTicketForm({ api, onCreated }: CreateTicketFormProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [workflowId, setWorkflowId] = useState('');
  const [priority, setPriority] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listWorkflows().then(
      (ws) => {
        if (cancelled) return;
        setWorkflows(ws);
        setWorkflowId((cur) => cur || (ws[0]?.id ?? ''));
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTicket({
        title: title.trim(),
        body,
        repo: repo.trim(),
        workflow_id: workflowId,
        priority: Number.parseInt(priority, 10) || 0,
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

  const valid = title.trim() !== '' && repo.trim() !== '' && workflowId !== '';
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
        Workflow
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} required>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} v{w.version}
            </option>
          ))}
        </select>
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
