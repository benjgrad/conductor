import {
  CONDUCTOR_WORKFLOW_ID,
  foldLegacyRequirements,
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
import {
  arrowId,
  columnStates,
  issueAt,
  LANE_KIND_ICONS,
  LANE_KIND_LABELS,
  LANE_KINDS,
  QUEUED_LANE,
  QUEUED_TITLE,
  setQueuedTicketEditable,
  ticketEditableOf,
  validateColumns,
  type ColumnIssue,
  type LaneEdge,
} from './columns.js';
import {
  oldVersionWarning,
  visibleIssues,
  withDeferred,
  withoutDeferred,
  withoutUnder,
} from './deferred.js';
import { ProposalsPanel } from './ProposalsPanel.js';
import { detailVersions } from './review.js';
import { SaveBar } from './SaveBar.js';
import { TransitionEditor } from './TransitionEditor.js';
import { ArrowEditor } from './ArrowEditor.js';
import { addTransition, arrowTransitions, getTransitionObject, parentOf } from './transitions.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';

// The Workflow view (ADR-0010, ADR-0011): the one workflow, `conductor`, drawn as its board
// columns. Pick a version; click a column to edit its title and work, or an arrow to edit the
// transitions it stands for (who takes them, for which tickets, what they require), in a local
// draft. Save folds an old version's requirements onto transitions (`foldLegacyRequirements`) and
// POSTs the whole definition, which the server stores as a new version. While a draft exists the
// save bar (UXR-69) sticks to the bottom: its problems, Discard and Save. A newly added item's
// problems wait until it loses focus or Save is pressed (UXR-71, deferred.ts).

export interface WorkflowsViewProps {
  api: ApiClient;
  /** The workflow id with unsaved changes, or null; the app guards navigation with it. */
  onDirtyChange?: (workflowId: string | null) => void;
}

const ID = CONDUCTOR_WORKFLOW_ID;

type Selection =
  | { kind: 'column'; state: string }
  | { kind: 'arrow'; from: string; to: string }
  | { kind: 'transition'; from: string; name: string };

export function WorkflowsView({ api, onDirtyChange }: WorkflowsViewProps) {
  /** null = latest. */
  const [version, setVersion] = useState<number | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  /** The highest version seen (the latest, when the server sends no `versions` list). */
  const [latestSeen, setLatestSeen] = useState(0);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [serverErrors, setServerErrors] = useState<ApiErrorDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped when an applied change proposal saved a new version: the latest is fetched again. */
  const [reloads, setReloads] = useState(0);
  /** Path prefixes of still-new items whose problems are held back (UXR-71). */
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const [problemsOpen, setProblemsOpen] = useState(false);

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
  }, [api, version, reloads]);

  const shown = draft ?? detail?.definition ?? null;
  const dirty = draft !== null;
  /** Old versions without `columns` (pre ADR-0010) still draw as the UML state diagram. */
  const asColumns = shown?.columns !== undefined;

  const clientIssues = useMemo(() => (shown ? validateColumns(shown) : []), [shown]);
  const serverIssues = useMemo<ColumnIssue[]>(
    () => (shown ? serverErrors.map((d) => issueAt(shown, d.path, d.message)) : []),
    [serverErrors, shown],
  );
  // Server problems are never held back: they answer a Save.
  const allIssues = useMemo(
    () => [...visibleIssues(clientIssues, deferred), ...serverIssues],
    [clientIssues, serverIssues, deferred],
  );
  // A transition's problem marks its arrow; one whose arrow isn't drawn (`$return_to`, a loop to
  // its own column) marks the column, like every other problem in a column.
  const { errorStates, errorEdges } = useMemo(() => {
    const states = new Set<string>();
    const edges = new Set<string>();
    for (const i of allIssues) {
      const t =
        i.transition && shown
          ? getTransitionObject(shown, i.transition.from, i.transition.name)
          : null;
      if (t && i.transition && shown?.states[t.goto] && t.goto !== i.transition.from) {
        edges.add(arrowId(i.transition.from, t.goto));
      } else if (i.state !== null) states.add(i.state);
    }
    return { errorStates: states, errorEdges: edges };
  }, [allIssues, shown]);

  const edit = (next: WorkflowDefinition) => {
    setDraft(next);
    setNotice(null);
  };

  const discard = () => {
    setDraft(null);
    setServerErrors([]);
    setNotice(null);
    setDeferred(new Set());
    setProblemsOpen(false);
  };

  async function save() {
    if (!draft) return;
    if (clientIssues.length > 0) {
      // Save shows every problem, new items' too, instead of saving.
      setDeferred(new Set());
      setProblemsOpen(true);
      return;
    }
    // ADR-0011: an old version's `entry` / ADR-0009 gates become transition `requires`. The
    // folded draft stays on a failure, so the server's paths match what the editor shows.
    const folded = foldLegacyRequirements(draft);
    if (folded !== draft) setDraft(folded);
    setSaving(true);
    setServerErrors([]);
    setError(null);
    try {
      const res = await api.saveWorkflow(folded);
      setLatestSeen((v) => Math.max(v, res.version));
      setDraft(null);
      setDeferred(new Set());
      setProblemsOpen(false);
      setVersion(res.version);
      setNotice(`Saved as v${res.version}.`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.details.length > 0) {
        setServerErrors(err.details);
        setProblemsOpen(true);
      }
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
  const warning = dirty ? oldVersionWarning(currentVersion, latest, versions) : null;

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

  const selectedState =
    selected?.kind === 'column' && shown?.states[selected.state] ? selected.state : null;
  const selectedTransition =
    selected?.kind === 'transition' && shown
      ? getTransitionObject(shown, selected.from, selected.name)
      : null;
  // UXR-64: an arrow that stands for several transitions opens on their list.
  const selectedArrow =
    selected?.kind === 'arrow' &&
    shown &&
    arrowTransitions(shown, selected.from, selected.to).length > 0
      ? selected
      : null;
  const selectedEdge =
    selected?.kind === 'transition' && selectedTransition
      ? arrowId(selected.from, selectedTransition.goto)
      : selectedArrow
        ? arrowId(selectedArrow.from, selectedArrow.to)
        : null;
  const panelOpen =
    asColumns && (selectedState !== null || selectedTransition !== null || selectedArrow !== null);

  const selectEdge = (edge: LaneEdge) => {
    if (edge.owner) setSelected({ kind: 'transition', ...edge.owner });
    else if (edge.transitions?.length === 1) {
      setSelected({ kind: 'transition', from: edge.from, name: edge.transitions[0]! });
    } else if (edge.transitions !== undefined && edge.transitions.length > 1) {
      setSelected({ kind: 'arrow', from: edge.from, to: edge.to });
    }
  };
  const selectColumn = (state: string) => setSelected({ kind: 'column', state });
  const selectArrow = (from: string, to: string) => setSelected({ kind: 'arrow', from, to });
  const showIssue = (i: ColumnIssue) => {
    if (i.transition && shown && getTransitionObject(shown, i.transition.from, i.transition.name)) {
      setSelected({ kind: 'transition', ...i.transition });
    } else if (i.state !== null) setSelected({ kind: 'column', state: i.state });
  };

  return (
    <div
      className={`wf-view${panelOpen ? ' with-editor' : ''}${
        panelOpen && selectedTransition !== null ? ' with-transition' : ''
      }`}
    >
      <section className="wf-main" aria-label="Workflow">
        {/* 11-web-ui: the editor needs room; shown only below the phone breakpoint (CSS). */}
        <p className="mobile-note muted">The workflow editor is best on a larger screen.</p>
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
                  setDeferred(new Set());
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
          {notice && (
            <span className="muted" role="status">
              {notice}
            </span>
          )}
        </div>
        {shown === null && !error && <p className="muted">Loading…</p>}
        {warning !== null && (
          <p className="wf-note wf-old-version" role="alert">
            {warning}
          </p>
        )}
        {dirty && (
          <p className="muted wf-note">
            Running tickets keep the version they started on; new tickets and reopened ones use the
            new version.
          </p>
        )}
        {!dirty && shown && asColumns && (
          <p className="muted wf-note">
            Each column is a state on the board, and each arrow the transitions between two columns.
            Click a column to edit its title and work, or an arrow to edit who takes the move, for
            which tickets and what it requires (or Tab to it and press Enter).
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
        {shown && asColumns && (
          <label className="wf-toggle">
            <input
              type="checkbox"
              checked={ticketEditableOf(shown, QUEUED_LANE)}
              onChange={(e) => edit(setQueuedTicketEditable(shown, e.target.checked))}
            />
            People can edit tickets in the {QUEUED_TITLE} column
          </label>
        )}
        {shown && asColumns && (
          <ColumnsDiagram
            definition={shown}
            selected={selectedState}
            errors={errorStates}
            onSelectColumn={selectColumn}
            onSelectEdge={selectEdge}
            selectedEdge={selectedEdge}
            errorEdges={errorEdges}
          />
        )}
        {shown && !asColumns && <WorkflowDiagram definition={shown} />}
        {shown && asColumns && (
          <div className="wf-legend muted" aria-label="Legend" role="group">
            <span className="wf-legend-kinds">
              {LANE_KINDS.map((k) => (
                <span key={k} className={`wf-legend-kind wf-lane-kind-${k}`}>
                  <span className="wf-legend-icon" aria-hidden="true">
                    {LANE_KIND_ICONS[k]}
                  </span>
                  {LANE_KIND_LABELS[k]}
                </span>
              ))}
            </span>
            <span>→ a transition (click to edit) · N ways: several on one arrow</span>
            <span>✓ has rules (checks, review, actions or conditions)</span>
            <span>- - - requirements not met: back, a bounded number of times</span>
          </div>
        )}
        <ProposalsPanel
          api={api}
          dirty={dirty}
          onWorkflowApplied={() => {
            // Unsaved edits stay; the panel warned that saving them stores the draft (made from
            // the older version) on top of the applied change.
            if (dirty) return;
            setVersion(null);
            setReloads((n) => n + 1);
          }}
        />
      </section>

      {selectedState && shown && asColumns && (
        <ColumnEditor
          key={selectedState}
          definition={shown}
          state={selectedState}
          issues={allIssues.filter((i) => i.state === selectedState)}
          onChange={edit}
          onSelectTransition={(name) =>
            setSelected({ kind: 'transition', from: selectedState, name })
          }
          onAddTransition={() => {
            const { definition, name } = addTransition(shown, selectedState, columnStates(shown));
            edit(definition);
            setSelected({ kind: 'transition', from: selectedState, name });
          }}
          onClose={() => setSelected(null)}
        />
      )}
      {selectedArrow && shown && asColumns && (
        <ArrowEditor
          definition={shown}
          from={selectedArrow.from}
          to={selectedArrow.to}
          issues={allIssues.filter((i) => i.transition?.from === selectedArrow.from)}
          onSelectTransition={(name) =>
            setSelected({ kind: 'transition', from: selectedArrow.from, name })
          }
          onSelectColumn={selectColumn}
          onClose={() => setSelected(null)}
        />
      )}
      {selected?.kind === 'transition' && selectedTransition && shown && asColumns && (
        <TransitionEditor
          definition={shown}
          from={selected.from}
          name={selected.name}
          issues={allIssues.filter((i) => i.transition?.from === selected.from)}
          onChange={edit}
          onSelect={(name) => setSelected({ kind: 'transition', from: selected.from, name })}
          onRemoved={() => {
            // Back to the arrow's list while it still stands for several, else the column.
            const goto = selectedTransition.goto;
            setSelected(
              goto !== selected.from && arrowTransitions(shown, selected.from, goto).length > 2
                ? { kind: 'arrow', from: selected.from, to: goto }
                : { kind: 'column', state: selected.from },
            );
          }}
          onSelectColumn={selectColumn}
          onSelectArrow={selectArrow}
          onBack={() => setSelected(parentOf(shown, selected.from, selected.name))}
          onClose={() => setSelected(null)}
          onDefer={(prefix) => setDeferred((d) => withDeferred(d, prefix))}
          onReveal={(prefix) => setDeferred((d) => withoutDeferred(d, prefix))}
          onRevealUnder={(prefix) => setDeferred((d) => withoutUnder(d, prefix))}
        />
      )}
      {dirty && shown && (
        <SaveBar
          definition={shown}
          issues={allIssues}
          nextVersion={latest + 1}
          warning={warning}
          saving={saving}
          problemsOpen={problemsOpen}
          onProblemsOpen={setProblemsOpen}
          canShow={asColumns}
          onShow={showIssue}
          onDiscard={discard}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}
