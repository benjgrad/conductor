import {
  CONDUCTOR_WORKFLOW_ID,
  foldLegacyRequirements,
  type WorkflowDefinition,
  type WorkflowDetail,
} from '@conductor/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiRequestError,
  errorMessage,
  type ApiClient,
  type ApiErrorDetail,
} from '../api/client.js';
import { useIsMobile } from '../components/useMediaQuery.js';
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
import { ProposalsPanel, type DiagramHighlight } from './ProposalsPanel.js';
import { detailHistory, detailVersions, savedBy, savedOn, versionLabel } from './review.js';
import { SaveBar } from './SaveBar.js';
import { SaveReviewDialog } from './SaveReviewDialog.js';
import { affectedOf, diffVersions, type ReadableChange } from './version-diff.js';
import { VersionDiff } from './VersionDiff.js';
import { TransitionEditor } from './TransitionEditor.js';
import { ArrowEditor } from './ArrowEditor.js';
import { addTransition, arrowTransitions, getTransitionObject, parentOf } from './transitions.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';
import type { DirtyDraft } from './draft-guard.js';

// The Workflow view (ADR-0010, ADR-0011): the one workflow, `conductor`, drawn as its board
// columns. Pick a version; click a column to edit its title and work, or an arrow to edit the
// transitions it stands for (who takes them, for which tickets, what they require), in a local
// draft. Save opens a review of what changes from the latest version, with an optional note
// (UXR-70), then folds an old version's requirements onto transitions (`foldLegacyRequirements`)
// and POSTs the whole definition, which the server stores as a new version. History lists every
// version (when, who, note) and compares any two in the editor's words; a comparison or an open
// advisor proposal highlights what it changes on the diagram. While a draft exists the save bar
// (UXR-69) sticks to the bottom: its problems, Discard and Save. A newly added item's problems
// wait until it loses focus or Save is pressed (UXR-71, deferred.ts).

export interface WorkflowsViewProps {
  api: ApiClient;
  /** The workflow id with unsaved changes, or null; the app guards navigation with it. */
  onDirtyChange?: (dirty: DirtyDraft | null) => void;
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
  /** UXR-44: below the phone breakpoint the editors open full-screen over the page. */
  const fullScreen = useIsMobile();
  /** UXR-70: the History panel is open. */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** UXR-70: the versions being compared, and their diff (null while it loads). */
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);
  const [compareChanges, setCompareChanges] = useState<ReadableChange[] | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  /** The Compare form's picks (default: the version shown and the latest). */
  const [pickFrom, setPickFrom] = useState<number | null>(null);
  const [pickTo, setPickTo] = useState<number | null>(null);
  /** UXR-73: what the open advisor proposal changes. */
  const [proposalHighlight, setProposalHighlight] = useState<DiagramHighlight | null>(null);
  /** UXR-70: the Save review dialog: open, and the latest version it diffs against. */
  const [reviewing, setReviewing] = useState(false);
  const [reviewBase, setReviewBase] = useState<{ version: number; def: WorkflowDefinition } | null>(
    null,
  );
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** Path prefixes of still-new items whose problems are held back (UXR-71). */
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const [problemsOpen, setProblemsOpen] = useState(false);
  /** Definitions read for Compare and the review, by version (versions never change). */
  const defs = useRef(new Map<number, WorkflowDefinition>());

  useEffect(() => {
    onDirtyChange?.(draft !== null ? { kind: 'workflow', id: ID } : null);
  }, [draft, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(null), [onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    api.getWorkflow(ID, version ?? undefined).then(
      (d) => {
        if (cancelled) return;
        defs.current.set(d.version, d.definition);
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
  /** Another version is shown: nothing of the last one's editing carries over. */
  const showVersion = (v: number | null) => {
    setVersion(v);
    setSelected(null);
    setServerErrors([]);
    setNotice(null);
    setDeferred(new Set());
  };

  /** A version's definition: from the cache, else the server. */
  const definitionOf = useCallback(
    async (v: number): Promise<WorkflowDefinition> => {
      const known = defs.current.get(v);
      if (known) return known;
      const d = await api.getWorkflow(ID, v);
      defs.current.set(d.version, d.definition);
      return d.definition;
    },
    [api],
  );

  /** UXR-70 (FR-3): Save opens the review: the diff from the latest version, and a note. */
  function openReview() {
    if (!draft) return;
    if (clientIssues.length > 0) {
      // Save shows every problem, new items' too, instead of saving (UXR-71).
      setDeferred(new Set());
      setProblemsOpen(true);
      return;
    }
    setReviewing(true);
    setReviewError(null);
    setReviewBase(null);
    // The diff is from the latest version, what the save actually replaces (the draft may have
    // started from an older one).
    api.getWorkflow(ID).then(
      (d) => {
        defs.current.set(d.version, d.definition);
        setLatestSeen((v) => Math.max(v, d.version));
        setReviewBase({ version: d.version, def: d.definition });
      },
      (err: unknown) => setReviewError(errorMessage(err)),
    );
  }

  const reviewChanges = useMemo(
    () =>
      reviewing && reviewBase && draft
        ? diffVersions(reviewBase.def, foldLegacyRequirements(draft))
        : null,
    [reviewing, reviewBase, draft],
  );

  async function save(note: string) {
    if (!draft || clientIssues.length > 0) return;
    // ADR-0011: an old version's `entry` / ADR-0009 gates become transition `requires`. The
    // folded draft stays on a failure, so the server's paths match what the editor shows.
    const folded = foldLegacyRequirements(draft);
    if (folded !== draft) setDraft(folded);
    setSaving(true);
    setServerErrors([]);
    setError(null);
    try {
      const res = await api.saveWorkflow(folded, note.trim() !== '' ? { note } : {});
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
      setReviewing(false);
    }
  }

  /** UXR-70 (FR-2): compare two versions, in the editor's words. */
  function runCompare(from: number, to: number) {
    setCompare({ from, to });
    setCompareChanges(null);
    setCompareError(null);
    Promise.all([definitionOf(from), definitionOf(to)]).then(
      ([a, b]) => setCompareChanges(diffVersions(a, b)),
      (err: unknown) => setCompareError(errorMessage(err)),
    );
  }
  const closeCompare = () => {
    setCompare(null);
    setCompareChanges(null);
    setCompareError(null);
  };

  // Every saved version: from the server when it says (gaps allowed), else 1..latest.
  const known = detail ? detailVersions(detail) : null;
  const latest = Math.max(latestSeen, ...(known ?? []));
  const versions = known ?? Array.from({ length: latest }, (_, i) => i + 1);
  const currentVersion = version ?? latest;
  const warning = dirty ? oldVersionWarning(currentVersion, latest, versions) : null;
  const history = detail ? detailHistory(detail) : null;
  const infoOf = (v: number) => history?.find((h) => h.version === v);
  const shownInfo = infoOf(currentVersion);

  // A comparison's changes, else the open proposal's, on the diagram (not while editing).
  const highlight =
    compare !== null && compareChanges !== null
      ? affectedOf(compareChanges)
      : !dirty
        ? proposalHighlight
        : null;

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
      <section className="wf-main" aria-label="Workflow" inert={panelOpen && fullScreen}>
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
                  showVersion(v === latest ? null : v);
                }}
              >
                {[...versions].reverse().map((v) => (
                  <option key={v} value={v}>
                    {versionLabel(v, infoOf(v), v === latest)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {latest > 0 && (
            <button
              type="button"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              History
            </button>
          )}
          {notice && (
            <span className="muted" role="status">
              {notice}
            </span>
          )}
        </div>
        {shown === null && !error && <p className="muted">Loading…</p>}
        {!dirty && detail && version !== null && version !== latest && (
          <p className="wf-old-version" role="note">
            <span>
              You’re viewing v{currentVersion}
              {shownInfo ? `, saved ${savedOn(shownInfo.created_at)}` : ''}
              {savedBy(shownInfo?.created_by) !== null
                ? ` by ${savedBy(shownInfo?.created_by)}`
                : ''}
              {shownInfo?.note ? `: ${shownInfo.note}` : ''}.
            </span>
            <button type="button" onClick={() => runCompare(currentVersion, latest)}>
              Compare with latest
            </button>
          </p>
        )}
        {historyOpen && latest > 0 && (
          <section className="wf-diff-section" aria-label="Version history">
            <h3>Version history</h3>
            <table className="wf-history">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Saved</th>
                  <th scope="col">By</th>
                  <th scope="col">Note</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {[...versions].reverse().map((v) => {
                  const info = infoOf(v);
                  return (
                    <tr key={v} aria-current={v === currentVersion ? 'true' : undefined}>
                      <td>
                        v{v}
                        {v === latest ? ' (latest)' : ''}
                      </td>
                      <td>{info ? savedOn(info.created_at) : '—'}</td>
                      <td>{savedBy(info?.created_by) ?? <span className="muted">unknown</span>}</td>
                      <td>{info?.note ?? <span className="muted">—</span>}</td>
                      <td>
                        <span className="wf-history-actions">
                          {v !== currentVersion && (
                            <button
                              type="button"
                              disabled={dirty}
                              aria-label={`View v${v}`}
                              onClick={() => showVersion(v === latest ? null : v)}
                            >
                              View
                            </button>
                          )}
                          {v !== latest && (
                            <button
                              type="button"
                              aria-label={`Compare v${v} with latest`}
                              onClick={() => runCompare(v, latest)}
                            >
                              Compare with latest
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {versions.length > 1 && (
              <form
                className="wf-compare"
                aria-label="Compare two versions"
                onSubmit={(e) => {
                  e.preventDefault();
                  const from =
                    pickFrom ?? (currentVersion === latest ? versions[0]! : currentVersion);
                  const to = pickTo ?? latest;
                  if (from !== to) runCompare(from, to);
                }}
              >
                <label>
                  From{' '}
                  <select
                    value={pickFrom ?? (currentVersion === latest ? versions[0]! : currentVersion)}
                    onChange={(e) => setPickFrom(Number(e.target.value))}
                  >
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        v{v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  To{' '}
                  <select
                    value={pickTo ?? latest}
                    onChange={(e) => setPickTo(Number(e.target.value))}
                  >
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        v{v}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit">Compare</button>
              </form>
            )}
          </section>
        )}
        {compare !== null && (
          <section
            className="wf-diff-section"
            aria-label={`Changes from v${compare.from} to v${compare.to}`}
          >
            <div className="wf-toolbar">
              <h3>
                Changes from v{compare.from} to v{compare.to}
              </h3>
              <button type="button" onClick={closeCompare}>
                Close
              </button>
            </div>
            {compareError && (
              <p role="alert" className="error">
                {compareError}
              </p>
            )}
            {compareChanges === null && !compareError && <p className="muted">Loading…</p>}
            {compareChanges !== null && (
              <>
                {compareChanges.length > 0 && asColumns && (
                  <p className="muted">Highlighted on the diagram below.</p>
                )}
                <VersionDiff
                  changes={compareChanges}
                  label={`Changes from v${compare.from} to v${compare.to}`}
                  empty="These versions are the same."
                />
              </>
            )}
          </section>
        )}
        {warning !== null && (
          <p className="wf-note wf-version-warning" role="alert">
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
            {...(highlight
              ? { changedStates: highlight.states, changedEdges: highlight.edges }
              : {})}
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
          onHighlight={setProposalHighlight}
          onWorkflowApplied={() => {
            // Unsaved edits stay; the panel warned that saving them stores the draft (made from
            // the older version) on top of the applied change.
            if (dirty) return;
            setVersion(null);
            setReloads((n) => n + 1);
          }}
        />
      </section>
      {reviewing && (
        <SaveReviewDialog
          latest={reviewBase?.version ?? null}
          changes={reviewChanges}
          error={reviewError}
          saving={saving}
          onSave={(note) => void save(note)}
          onCancel={() => setReviewing(false)}
        />
      )}

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
          fullScreen={fullScreen}
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
          fullScreen={fullScreen}
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
          fullScreen={fullScreen}
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
          onSave={openReview}
        />
      )}
    </div>
  );
}
