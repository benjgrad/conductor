// ADR-0023 (M2-T29d): the session panel's "Needs permission" box. The agent's held tool calls
// (`GET /api/sessions/:id/permission-requests`, pending ones), each with its tool and input (a
// Bash command as code, anything else as JSON, long input collapsed) and three answers: Allow
// once, Allow always (only when the request has an exact `always_rule`), Deny with an optional
// note. Answers post `POST /api/permission-requests/:id/decision`.
import type { BoardCard, PermissionDecisionRequest, PermissionRequestDto } from '@conductor/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import './PermissionRequests.css';

export const NEEDS_PERMISSION_LABEL = 'Needs permission';

/** Input longer than this is collapsed behind "Show all". */
const LONG_INPUT_CHARS = 1200;
const LONG_INPUT_LINES = 20;

interface PermissionRequestsProps {
  api: ApiClient;
  sessionId: string;
  /** The card's `permission` (the oldest pending request); refetches when it changes. */
  permission: NonNullable<BoardCard['permission']>;
  agent: string;
  onDone: () => void;
}

export function PermissionRequests({
  api,
  sessionId,
  permission,
  agent,
  onDone,
}: PermissionRequestsProps) {
  const [requests, setRequests] = useState<PermissionRequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a decision to refetch. */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.listPermissionRequests(sessionId).then(
      (res) => {
        if (!live) return;
        setRequests(res.requests.filter((r) => r.status === 'pending'));
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, permission.request_id, permission.pending_count, tick]);

  return (
    <section aria-label={NEEDS_PERMISSION_LABEL} className="pending permission-requests">
      <div className="pending-head">
        <span className="badge badge-permission">{NEEDS_PERMISSION_LABEL}</span>
        <span className="muted">
          {agent} wants to use {permission.tool}
          {permission.pending_count > 1 ? ` (+${permission.pending_count - 1} more)` : ''}
        </span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {requests === null && !error && <p className="muted">Loading…</p>}
      {requests?.map((r) => (
        <PermissionRequestItem
          key={r.id}
          api={api}
          request={r}
          onDone={() => {
            setTick((t) => t + 1);
            onDone();
          }}
        />
      ))}
    </section>
  );
}

function PermissionRequestItem({
  api,
  request,
  onDone,
}: {
  api: ApiClient;
  request: PermissionRequestDto;
  onDone: () => void;
}) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  async function decide(req: PermissionDecisionRequest) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.decidePermission(request.id, req);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function submitDeny(e: FormEvent) {
    e.preventDefault();
    const message = note.trim();
    void decide({ behavior: 'deny', scope: 'once', ...(message !== '' ? { message } : {}) });
  }

  return (
    <div className="permission-request" role="group" aria-label={`${request.tool} request`}>
      <div className="permission-tool">
        <code>{request.tool}</code>
        <span className="muted">
          {' '}
          · expires {new Date(request.expires_at).toLocaleTimeString()}
        </span>
      </div>
      <PermissionInput tool={request.tool} input={request.input} />
      {!denying && (
        <div className="permission-actions">
          <button
            type="button"
            className="primary permission-allow"
            disabled={busy}
            onClick={() => void decide({ behavior: 'allow', scope: 'once' })}
          >
            Allow once
          </button>
          {request.always_rule !== null && (
            <button
              type="button"
              disabled={busy}
              title={`Records ${request.always_rule} for this ticket`}
              onClick={() => void decide({ behavior: 'allow', scope: 'always' })}
            >
              Allow always
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setDenying(true);
            }}
          >
            Deny…
          </button>
        </div>
      )}
      {denying && (
        <form className="transition-text" aria-label="Deny" onSubmit={submitDeny}>
          <label htmlFor={`${ids}-note`}>Note for the agent (optional)</label>
          <textarea
            id={`${ids}-note`}
            rows={2}
            value={note}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDenying(false);
            }}
          />
          <span className="transition-text-actions">
            <button type="submit" disabled={busy}>
              Deny
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setDenying(false)}
            >
              Back
            </button>
          </span>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** A Bash command as code (its description under it); any other input as JSON. */
export function PermissionInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const [all, setAll] = useState(false);
  const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : null;
  const text = command ?? JSON.stringify(input, null, 2);
  const description =
    command !== null && typeof input.description === 'string' ? input.description : null;
  const long = text.length > LONG_INPUT_CHARS || text.split('\n').length > LONG_INPUT_LINES;
  return (
    <div className="permission-input" role="region" aria-label="Tool input">
      <pre className={`permission-code${long && !all ? ' clamped' : ''}`}>
        <code>{text}</code>
      </pre>
      {description && <p className="muted permission-description">{description}</p>}
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
