import {
  CONDUCTOR_WORKFLOW_ID,
  type WorkflowDefinition,
  type WorkflowDetail,
} from '@conductor/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  ApiRequestError,
  errorMessage,
  type ApiClient,
  type ApiErrorDetail,
} from '../api/client.js';
import { ColumnEditor } from './ColumnEditor.js';
import { ColumnsDiagram } from './ColumnsDiagram.js';
import { columnTitle, stateForPath, validateColumns, type ColumnIssue } from './columns.js';
import { detailVersions } from './review.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';

// The Workflow view (ADR-0010): the one workflow, `conductor`, drawn as its board columns. Pick a
// version; click a column to edit its title, work and requirements to enter in a local draft.
// Save POSTs the whole definition, which the server stores as a new version.

export interface WorkflowsViewProps {
  api: ApiClient;
  /** The workflow id with unsaved changes, or null; the app guards navigation with it. */
  onDirtyChange?: (workflowId: string | null) => void;
}

const ID = CONDUCTOR_WORKFLOW_ID;

export function WorkflowsView({ api, onDirtyChange }: WorkflowsViewProps) {
  /** null = latest. */
  const [version, setVersion] = useState<number | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  /** The highest version seen (the latest, when the server sends no `versions` list). */
  const [latestSeen, setLatestSeen] = useState(0);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<ApiErrorDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(draft !== null ? ID : null);
  }, [draft, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(null), [onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    api.getWorkflow(ID, version ?? undefined).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        setMissing(false);
        setError(null);
        setLatestSeen((v) => Math.max(v, d.version));
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 404 && version === null) {
          setMissing(true);
        } else setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, version]);

  const shown = draft ?? detail?.definition ?? null;
  const dirty = draft !== null;
  /** Old versions without `columns` (pre ADR-0010) still draw as the UML state diagram. */
  const asColumns = shown?.columns !== undefined;

  const clientIssues = useMemo(() => (shown ? validateColumns(shown) : []), [shown]);
  const serverIssues = useMemo<ColumnIssue[]>(
    () =>
      shown
        ? serverErrors.map((d) => ({
            state: stateForPath(shown, d.path),
            path: d.path,
            message: d.message,
          }))
        : [],
    [serverErrors, shown],
  );
  const allIssues = [...clientIssues, ...serverIssues];
  const errorStates = useMemo(() => {
    const s = new Set<string>();
    for (const i of [...clientIssues, ...serverIssues]) if (i.state !== null) s.add(i.state);
    return s;
  }, [clientIssues, serverIssues]);

  const edit = (next: WorkflowDefinition) => {
    setDraft(next);
    setNotice(null);
  };

  const discard = () => {
    setDraft(null);
    setServerErrors([]);
    setNotice(null);
  };

  async function save() {
    if (!draft || clientIssues.length > 0) return;
    setSaving(true);
    setServerErrors([]);
    setError(null);
    try {
      const res = await api.saveWorkflow(draft);
      setLatestSeen((v) => Math.max(v, res.version));
      setDraft(null);
      setVersion(res.version);
      setNotice(`Saved as v${res.version}.`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.details.length > 0) setServerErrors(err.details);
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Every saved version: from the server when it says (gaps allowed), else 1..latest.
  const known = detail ? detailVersions(detail) : null;
  const latest = Math.max(latestSeen, ...(known ?? []));
  const versions = known ?? Array.from({ length: latest }, (_, i) => i + 1);
  const currentVersion = version ?? latest;

  if (missing) {
    return (
      <div className="wf-view">
        <section className="wf-main wf-empty" aria-label="Workflow">
          <h2>No workflow yet</h2>
          <p>
            This orchestrator has no <code>{ID}</code> workflow. A current orchestrator seeds{' '}
            <code>{ID}</code> v1 when it starts: update it and restart it, then reload this page.
          </p>
        </section>
      </div>
    );
  }

  const selectedState = selected !== null && shown?.states[selected] ? selected : null;

  return (
    <div className={`wf-view${selectedState && asColumns ? ' with-editor' : ''}`}>
      <section className="wf-main" aria-label="Workflow">
        <div className="wf-toolbar">
          <h2>Workflow</h2>
          {latest > 0 && (
            <label>
              Version{' '}
              <select
                value={currentVersion}
                disabled={dirty}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVersion(v === latest ? null : v);
                  setSelected(null);
                  setServerErrors([]);
                  setNotice(null);
                }}
              >
                {[...versions].reverse().map((v) => (
                  <option key={v} value={v}>
                    v{v}
                    {v === latest ? ' (latest)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {dirty && <span className="wf-unsaved">Unsaved changes</span>}
          {dirty && (
            <button type="button" onClick={discard} disabled={saving}>
              Discard
            </button>
          )}
          {dirty && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || clientIssues.length > 0}
            >
              {saving ? 'Saving…' : 'Save as new version'}
            </button>
          )}
          {notice && (
            <span className="muted" role="status">
              {notice}
            </span>
          )}
        </div>
        {shown === null && !error && <p className="muted">Loading…</p>}
        {dirty && (
          <p className="muted wf-note">
            Saving creates v{latest + 1}. Running tickets keep the version they started on; new
            tickets and reopened ones use the new version.
          </p>
        )}
        {!dirty && shown && asColumns && (
          <p className="muted wf-note">
            Each column is a state on the board. Click a column (or Tab to it and press Enter) to
            edit its title, its work and its requirements to enter.
          </p>
        )}
        {shown && !asColumns && (
          <p className="muted wf-note">
            This version predates board columns; it is shown as a state diagram, read-only.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {allIssues.length > 0 && shown && (
          <ul className="wf-errors" aria-label="Problems">
            {allIssues.map((i, n) => (
              <li key={n}>
                {i.state !== null ? (
                  <>
                    <strong>{columnTitle(shown, i.state)}</strong>: {i.message}
                    {asColumns && (
                      <button type="button" onClick={() => setSelected(i.state)}>
                        Show
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <code>{i.path}</code>: {i.message}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {shown && asColumns && (
          <ColumnsDiagram
            definition={shown}
            selected={selectedState}
            errors={errorStates}
            onSelectColumn={setSelected}
          />
        )}
        {shown && !asColumns && <WorkflowDiagram definition={shown} />}
        {shown && asColumns && (
          <p className="wf-legend muted">
            <span>→ outcome</span>
            <span>- - - dashed: requirements not met (back, bounded) / else</span>
            <span>✓ checks · ◎ review · ↗ conductor action</span>
          </p>
        )}
      </section>

      {selectedState && shown && asColumns && (
        <ColumnEditor
          key={selectedState}
          definition={shown}
          state={selectedState}
          issues={allIssues.filter((i) => i.state === selectedState)}
          onChange={edit}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
