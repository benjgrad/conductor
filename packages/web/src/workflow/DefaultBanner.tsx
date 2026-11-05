import { CONDUCTOR_WORKFLOW_ID, type WorkflowDefaultResponse } from '@conductor/shared';
import { useState } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { DiffTable } from './DiffTable.js';

// UXR-87: the Workflow page's "newer default available" banner, for instance admins. The user's
// edits kept the seed from installing a newer shipped `conductor` (ADR-0011,
// `WorkflowDetail.default_available`). Compare shows what adopting it changes from the latest
// version (`GET /api/workflows/conductor/default`); Adopt… confirms, then saves it as the next
// version (`POST …/default {base_version}`, like MCP `adopt_default_workflow`).

export interface DefaultBannerProps {
  api: ApiClient;
  /** The newer default's version (`default_available`). */
  available: number;
  /** The latest stored version: what adopting replaces, and the `base_version` it sends. */
  latest: number;
  /** The editor has unsaved changes: Adopt is disabled (it would discard them). */
  dirty: boolean;
  /** The default was saved as `version`: the editor reloads the latest. */
  onAdopted: (version: number) => void;
  /** The workflow changed since `latest` (409): the editor reloads to the new latest. */
  onStale: () => void;
}

type Compare =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'shown'; data: WorkflowDefaultResponse };

export function DefaultBanner({
  api,
  available,
  latest,
  dirty,
  onAdopted,
  onStale,
}: DefaultBannerProps) {
  const [compare, setCompare] = useState<Compare>({ kind: 'closed' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCompare() {
    if (compare.kind !== 'closed') {
      setCompare({ kind: 'closed' });
      return;
    }
    setCompare({ kind: 'loading' });
    api.getWorkflowDefault(CONDUCTOR_WORKFLOW_ID).then(
      (data) => setCompare({ kind: 'shown', data }),
      (err: unknown) => setCompare({ kind: 'error', message: errorMessage(err) }),
    );
  }

  async function adopt() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.adoptDefaultWorkflow(CONDUCTOR_WORKFLOW_ID, latest);
      setConfirming(false);
      onAdopted(res.version);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409 && err.code === 'conflict') {
        setError('The workflow changed since this page loaded; it has been reloaded. Try again.');
        setConfirming(false);
        onStale();
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wf-default-banner" aria-label="Newer default workflow">
      <div className="wf-default-row">
        <span>A newer default workflow (v{available}) is available</span>
        <span aria-hidden="true">·</span>
        <button type="button" aria-expanded={compare.kind !== 'closed'} onClick={toggleCompare}>
          Compare
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy || confirming || dirty}
          title={dirty ? 'Save or discard your unsaved changes first' : undefined}
        >
          Adopt…
        </button>
        {dirty && <span className="muted">Save or discard your changes to adopt it.</span>}
      </div>
      {confirming && (
        <div className="wf-default-confirm" role="group" aria-label="Adopt the default">
          <p>
            This replaces your edits since v{latest}: the default v{available} is saved as v
            {latest + 1}. Running tickets keep the version they started on.
          </p>
          <button type="button" onClick={() => void adopt()} disabled={busy}>
            {busy ? 'Adopting…' : `Adopt v${available}`}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {compare.kind === 'loading' && <p className="muted">Loading the comparison…</p>}
      {compare.kind === 'error' && (
        <p role="alert" className="error">
          {compare.message}
        </p>
      )}
      {compare.kind === 'shown' && (
        <div className="wf-default-compare">
          <h3>
            Changes from v{compare.data.base_version} to the default (v{compare.data.version})
          </h3>
          {compare.data.diff.changes.length === 0 ? (
            <p className="muted">No differences.</p>
          ) : (
            <DiffTable changes={compare.data.diff.changes} more={compare.data.diff.more_changes} />
          )}
        </div>
      )}
    </section>
  );
}
