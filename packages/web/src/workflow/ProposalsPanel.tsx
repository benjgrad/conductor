import type {
  ChangeKind,
  ChangeProposalDetail,
  ChangeProposalSummary,
  ProposalReview,
  StructuralChange,
} from '@conductor/shared';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { affectedOf, diffRepoChecks, diffVersions, type ReadableChange } from './version-diff.js';
import { VersionDiff } from './VersionDiff.js';

// ADR-0033 P3 (MA-T07): the workflow advisor's change proposals, under the workflow editor. The
// advisor (any MCP client, prompt `workflow_advisor`) proposes one change at a time; here a
// human reads its diff, evidence, expected effect and rollback, and applies or rejects it. Apply
// runs the same guards as the MCP `apply_change` (the admin gate for workflow changes, approvals,
// the base it was made from). An applied proposal shows the expected metric before vs after.
// UXR-73: the diff reads in the editor's words (version-diff.ts) from the proposal's whole change,
// and a workflow proposal highlights the columns and arrows it changes on the diagram. The Repo
// checks page shows one repo's proposals (`kind` / `target`).

/** What a proposal changes on the diagram (`affectedOf`). */
export interface DiagramHighlight {
  states: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

export interface ProposalsPanelProps {
  api: ApiClient;
  /** The editor has unsaved changes (applying a change makes them stale). */
  dirty: boolean;
  /** A workflow proposal was applied: the editor reloads the latest version. */
  onWorkflowApplied?: () => void;
  /** UXR-84: open this proposal on mount (the Insights page's "Open proposal"). */
  initialOpenId?: string | null | undefined;
  /** Any proposal was applied (the Repo checks page reloads the repo). */
  onApplied?: (p: ChangeProposalDetail) => void;
  /** UXR-73: only proposals of this kind, for this target (a repo). */
  kind?: ChangeKind;
  target?: string;
  /** UXR-73: the open workflow proposal's columns and arrows; null when none is open. */
  onHighlight?: (h: DiagramHighlight | null) => void;
}

/** A proposal's diff in the editor's words, from its whole change; null from an older server. */
export function readableOf(p: ChangeProposalDetail): ReadableChange[] | null {
  if (p.kind === 'workflow') {
    return p.base_definition && p.proposed_definition
      ? diffVersions(p.base_definition, p.proposed_definition)
      : null;
  }
  return p.checks_after !== undefined
    ? diffRepoChecks(p.checks_before ?? null, p.checks_after)
    : null;
}

type Filter = 'open' | 'all';

const STATUS_LABEL: Record<ChangeProposalSummary['status'], string> = {
  proposed: 'Proposed',
  applied: 'Applied',
  rejected: 'Rejected',
  conflict: 'Conflict',
  failed: 'Failed',
};

const METRIC_LABEL: Record<ProposalReview['metric'], string> = {
  median_stay: 'median time in state (min)',
  p90_stay: 'p90 time in state (min)',
  reentries: 're-entries per ticket',
  check_failure_rate: 'check failure rate',
  questions: 'questions per ticket',
  permission_denials: 'permission denials',
};

const show = (v: unknown): string =>
  v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

function DiffTable({ changes, more }: { changes: StructuralChange[]; more: number }) {
  return (
    <table className="cp-diff">
      <thead>
        <tr>
          <th scope="col">Change</th>
          <th scope="col">Where</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={`${c.op}:${c.path}`} className={`cp-op-${c.op}`}>
            <td>{c.op}</td>
            <td>
              <code>{c.path}</code>
            </td>
            <td>
              <code>{show(c.before)}</code>
            </td>
            <td>
              <code>{show(c.after)}</code>
            </td>
          </tr>
        ))}
        {more > 0 && (
          <tr>
            <td colSpan={4} className="muted">
              …and {more} more
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ReviewResult({ review }: { review: ProposalReview }) {
  if (review.too_early) {
    return <p className="muted">Too early to tell: check again a day or more after applying.</p>;
  }
  const v = (x: { value: number | null; sample: number }) =>
    x.value === null ? 'no data' : `${x.value} (${x.sample})`;
  const verdict =
    review.direction_met === null
      ? 'Not enough data to tell yet.'
      : review.direction_met
        ? 'It moved the expected way.'
        : 'It did not move the expected way: consider rolling it back.';
  return (
    <p aria-label="Review">
      {METRIC_LABEL[review.metric]}, {review.window_days} days each side: before {v(review.before)},
      after {v(review.after)}. <strong>{verdict}</strong>
    </p>
  );
}

function Detail({
  p,
  readable,
  highlighted,
  busy,
  onApply,
  onReject,
  onReview,
}: {
  p: ChangeProposalDetail;
  readable: ReadableChange[] | null;
  /** Its changes are highlighted on the diagram. */
  highlighted: boolean;
  busy: boolean;
  onApply: () => void;
  onReject: () => void;
  onReview: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="cp-detail">
      {p.warning && p.status === 'proposed' && (
        <p className="cp-warning" role="note">
          {p.warning}
        </p>
      )}
      <p>{p.rationale}</p>
      <h4>Evidence</h4>
      <ul>
        {p.evidence.map((e, i) => (
          <li key={i}>
            {e.text}
            {e.finding_id && (
              <>
                {' '}
                <code className="muted">{e.finding_id}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      <h4>Expected effect</h4>
      <p>
        {p.effect.text}{' '}
        <span className="muted">
          ({METRIC_LABEL[p.effect.metric]} {p.effect.direction === 'down' ? '↓' : '↑'})
        </span>
      </p>
      <h4>Rollback</h4>
      <p>{p.rollback}</p>
      <h4>What changes{p.base_version !== null ? ` (from v${p.base_version})` : ''}</h4>
      {highlighted && <p className="muted">Highlighted on the diagram above.</p>}
      {readable !== null ? (
        <VersionDiff changes={readable} label={`Changes in ${p.title}`} />
      ) : (
        <DiffTable changes={p.diff.changes} more={p.diff.more_changes} />
      )}
      {p.error && (
        <p className="error" role="alert">
          {p.error}
        </p>
      )}
      {p.status === 'applied' && (
        <>
          <h4>Review</h4>
          {p.review ? <ReviewResult review={p.review} /> : <p className="muted">Not reviewed.</p>}
          <button type="button" onClick={onReview} disabled={busy}>
            Check the effect
          </button>
        </>
      )}
      {p.status === 'proposed' && (
        <div className="cp-actions">
          {confirming ? (
            <>
              <span>Apply this change now?</span>
              <button type="button" onClick={onApply} disabled={busy}>
                Confirm apply
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setConfirming(true)} disabled={busy}>
                Apply…
              </button>
              <button type="button" onClick={onReject} disabled={busy}>
                Reject
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ProposalsPanel({
  api,
  dirty,
  onWorkflowApplied,
  initialOpenId = null,
  onApplied,
  kind,
  target,
  onHighlight,
}: ProposalsPanelProps) {
  const [filter, setFilter] = useState<Filter>('open');
  const [rows, setRows] = useState<ChangeProposalSummary[] | null>(null);
  const [open, setOpen] = useState<ChangeProposalDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // UXR-84: a deep link opens its proposal; one that is no longer open shows under "All".
  useEffect(() => {
    if (initialOpenId === null) return;
    let cancelled = false;
    api.getChangeProposal(initialOpenId).then(
      (p) => {
        if (cancelled) return;
        if (p.status !== 'proposed') setFilter('all');
        setOpen(p);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, initialOpenId]);

  /** Bumped after an action: the list is fetched again. */
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listChangeProposals({
        status: filter === 'open' ? 'proposed' : 'all',
        ...(kind !== undefined ? { kind } : {}),
        ...(target !== undefined ? { target } : {}),
      })
      .then(
        (res) => {
          if (!cancelled) setRows(res.proposals);
        },
        (err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, filter, refresh, kind, target]);

  const readable = useMemo(() => (open ? readableOf(open) : null), [open]);
  // UXR-73: an open workflow proposal's columns and arrows, on the diagram.
  const highlight = useMemo<DiagramHighlight | null>(() => {
    if (open?.kind !== 'workflow' || readable === null || readable.length === 0) return null;
    return affectedOf(readable);
  }, [open, readable]);
  useEffect(() => {
    onHighlight?.(highlight);
  }, [highlight, onHighlight]);
  useEffect(() => () => onHighlight?.(null), [onHighlight]);

  const toggle = async (id: string) => {
    if (open?.id === id) return setOpen(null);
    setError(null);
    try {
      setOpen(await api.getChangeProposal(id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const act = async (
    fn: () => Promise<ChangeProposalDetail>,
    done: (p: ChangeProposalDetail) => string,
    applying = false,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const p = await fn();
      setOpen(p);
      setNotice(done(p));
      if (applying) {
        if (p.kind === 'workflow') onWorkflowApplied?.();
        onApplied?.(p);
      }
    } catch (err) {
      setError(errorMessage(err));
      // A conflict or failure changed its status: show the stored reason.
      if (open) setOpen(await api.getChangeProposal(open.id).catch(() => open));
    } finally {
      setBusy(false);
      setRefresh((n) => n + 1);
    }
  };

  return (
    <section className="cp-panel" aria-label="Change proposals">
      <div className="wf-toolbar">
        <h3>
          {kind === 'repo_checks' ? 'Proposed changes to this repo’s checks' : 'Proposed changes'}
        </h3>
        <label>
          Show{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="open">Open</option>
            <option value="all">All</option>
          </select>
        </label>
        {notice && (
          <span className="muted" role="status">
            {notice}
          </span>
        )}
      </div>
      <p className="muted wf-note">
        The workflow advisor proposes one change at a time. Nothing changes until it is applied.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows?.length === 0 && (
        <p className="muted">No {filter === 'open' ? 'open ' : ''}proposals.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="cp-list">
          {rows.map((r) => (
            <li key={r.id} className={`cp-row cp-${r.status}`}>
              <button
                type="button"
                className="cp-summary"
                aria-expanded={open?.id === r.id}
                onClick={() => void toggle(r.id)}
              >
                <strong>{r.title}</strong>{' '}
                <span className="muted">
                  {r.kind === 'workflow' ? 'Workflow' : 'Repo checks'} · {r.target} · {r.changes}{' '}
                  change{r.changes === 1 ? '' : 's'}
                </span>{' '}
                <span className="cp-status">{STATUS_LABEL[r.status]}</span>
              </button>
              {open?.id === r.id && (
                <>
                  {dirty && open.status === 'proposed' && (
                    <p className="cp-warning" role="note">
                      {open.kind === 'workflow'
                        ? 'You have unsaved edits: applying this saves a new version, and saving ' +
                          'your draft afterwards would replace it.'
                        : 'You have unsaved edits: applying this replaces them.'}
                    </p>
                  )}
                  <Detail
                    p={open}
                    readable={readable}
                    highlighted={highlight !== null && onHighlight !== undefined}
                    busy={busy}
                    onApply={() =>
                      void act(
                        () => api.applyChangeProposal(open.id),
                        (p) =>
                          p.applied_version !== null
                            ? `Applied as v${p.applied_version}.`
                            : 'Applied.',
                        true,
                      )
                    }
                    onReject={() =>
                      void act(
                        () => api.rejectChangeProposal(open.id),
                        () => 'Rejected.',
                      )
                    }
                    onReview={() =>
                      void act(
                        () => api.reviewChangeProposal(open.id),
                        () => 'Reviewed.',
                      )
                    }
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
