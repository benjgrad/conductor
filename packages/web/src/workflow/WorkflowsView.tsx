import type { WorkflowDefinition, WorkflowDetail, WorkflowSummary } from '@conductor/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  ApiRequestError,
  errorMessage,
  type ApiClient,
  type ApiErrorDetail,
} from '../api/client.js';
import { TransitionEditor } from './TransitionEditor.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';
import { transitionForPath, transitionKey, validateGates, type GateIssue } from './model.js';

// The Workflows view (ADR-0009): pick a workflow and version, see it as a UML state diagram, and
// edit transition requirements in a local draft. Save POSTs the whole definition, which the
// server stores as a new version.

export interface WorkflowsViewProps {
  api: ApiClient;
  /** From the URL; null = the first workflow. */
  workflowId: string | null;
  /** `replace`: the view resolved "the first workflow" itself (no new history entry). */
  onSelectWorkflow: (id: string, replace?: boolean) => void;
  /** The workflow id with unsaved changes, or null; the app guards navigation with it. */
  onDirtyChange?: (workflowId: string | null) => void;
}

interface Selected {
  from: string;
  outcome: string;
}

export function WorkflowsView({
  api,
  workflowId,
  onSelectWorkflow,
  onDirtyChange,
}: WorkflowsViewProps) {
  const [summaries, setSummaries] = useState<WorkflowSummary[] | null>(null);
  /** null = latest. */
  const [version, setVersion] = useState<number | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  /** The draft is tagged with its workflow, so it can never show under another one. */
  const [draft, setDraft] = useState<{ id: string; def: WorkflowDefinition } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [serverErrors, setServerErrors] = useState<ApiErrorDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listWorkflows().then(
      (ws) => !cancelled && setSummaries(ws),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const id = workflowId ?? summaries?.[0]?.id ?? null;
  const summary = summaries?.find((w) => w.id === id);

  // Put the resolved workflow in the URL, so navigation guards and links see a concrete id.
  useEffect(() => {
    if (workflowId === null && id !== null) onSelectWorkflow(id, true);
  }, [workflowId, id, onSelectWorkflow]);

  const draftDef = draft !== null && draft.id === id ? draft.def : null;
  useEffect(() => {
    onDirtyChange?.(draftDef !== null ? id : null);
  }, [draftDef, id, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(null), [onDirtyChange]);

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    api.getWorkflow(id, version ?? undefined).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, version]);

  const shown = draftDef ?? (detail && detail.id === id ? detail.definition : null);
  const dirty = draftDef !== null;

  const clientIssues = useMemo(() => (shown ? validateGates(shown) : []), [shown]);
  const serverIssues = useMemo(
    () =>
      shown
        ? serverErrors.map((d) => {
            const t = transitionForPath(shown, d.path);
            return { ...d, from: t?.from ?? null, outcome: t?.outcome ?? null };
          })
        : [],
    [serverErrors, shown],
  );
  const errorKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const i of [...clientIssues, ...serverIssues]) {
      if (i.from !== null && i.outcome !== null) keys.add(transitionKey(i.from, i.outcome));
    }
    return keys;
  }, [clientIssues, serverIssues]);

  // The app keys this view by workflow id, so switching remounts it with fresh state. With a
  // dirty draft the app asks first (draft-guard.tsx).
  const selectWorkflow = (next: string) => {
    if (next !== id) onSelectWorkflow(next);
  };

  const edit = (next: WorkflowDefinition) => {
    if (id === null) return;
    setDraft({ id, def: next });
    setNotice(null);
  };

  const discard = () => {
    setDraft(null);
    setServerErrors([]);
    setNotice(null);
  };

  async function save() {
    if (!draftDef || clientIssues.length > 0) return;
    setSaving(true);
    setServerErrors([]);
    setError(null);
    try {
      const res = await api.saveWorkflow(draftDef);
      const ws = await api.listWorkflows();
      setSummaries(ws);
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

  const issuesFor = (s: Selected): GateIssue[] => [
    ...clientIssues.filter((i) => i.from === s.from && i.outcome === s.outcome),
    ...serverIssues
      .filter((i) => i.from === s.from && i.outcome === s.outcome)
      .map((i) => ({ from: s.from, outcome: s.outcome, path: i.path, message: i.message })),
  ];

  const latest = summary?.version ?? detail?.version ?? 1;
  const currentVersion = version ?? latest;
  const allIssues = [
    ...clientIssues.map((i) => ({ ...i, source: 'client' as const })),
    ...serverIssues.map((i) => ({ ...i, source: 'server' as const })),
  ];

  return (
    <div className={`wf-view${selected && shown ? ' with-editor' : ''}`}>
      <nav aria-label="Workflows">
        {summaries === null && !error && <p className="muted">Loading…</p>}
        <ul className="wf-list">
          {summaries?.map((w) => (
            <li key={w.id}>
              <button type="button" aria-current={w.id === id} onClick={() => selectWorkflow(w.id)}>
                <span>{w.id}</span>
                <span className="muted">v{w.version}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="wf-main" aria-label="Workflow">
        <div className="wf-toolbar">
          <h2>{id ?? 'No workflows'}</h2>
          {id && (
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
                {Array.from({ length: latest }, (_, i) => latest - i).map((v) => (
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
        {dirty && (
          <p className="muted wf-note">
            Saving creates v{latest + 1}. Running tickets keep the version they started on; new
            tickets and reopened ones use the new version.
          </p>
        )}
        {!dirty && shown && (
          <p className="muted wf-note">
            Click or tab to a transition (Enter) to see or edit its requirements.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {allIssues.length > 0 && (
          <ul className="wf-errors" aria-label="Problems">
            {allIssues.map((i, n) => (
              <li key={n}>
                {i.from !== null && i.outcome !== null ? (
                  <>
                    <strong>
                      {i.from} · {i.outcome}
                    </strong>
                    : {i.message}
                    <button
                      type="button"
                      onClick={() => setSelected({ from: i.from!, outcome: i.outcome! })}
                    >
                      Show
                    </button>
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
        {shown && (
          <WorkflowDiagram
            definition={shown}
            selected={selected ? transitionKey(selected.from, selected.outcome) : null}
            errors={errorKeys}
            onSelectTransition={(from, outcome) => setSelected({ from, outcome })}
          />
        )}
        {shown && (
          <p className="wf-legend muted">
            <span>«type» state</span>
            <span>● start</span>
            <span>◉ final state</span>
            <span>- - - dashed: else / requirements not met</span>
            <span>✓ gated by requirements</span>
          </p>
        )}
      </section>

      {selected && shown && (
        <TransitionEditor
          key={`${id ?? ''}:${transitionKey(selected.from, selected.outcome)}`}
          definition={shown}
          from={selected.from}
          outcome={selected.outcome}
          issues={issuesFor(selected)}
          onChange={edit}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
