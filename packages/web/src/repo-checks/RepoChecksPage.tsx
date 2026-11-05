import {
  canonicalRepo,
  checksGatesOf,
  CONDUCTOR_WORKFLOW_ID,
  repoChecksKey,
  type ChecksGate,
  type RepoChecksDetail,
  type RepoChecksDto,
  type RepoSuggestion,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ApiRequestError,
  errorMessage,
  type ApiClient,
  type ApiErrorDetail,
} from '../api/client.js';
import { ago } from '../components/format.js';
import { useIsMobile } from '../components/useMediaQuery.js';
import { HelpLink, REPO_CHECKS_HELP_URL } from '../help/HelpPage.js';
import {
  ChecksFields,
  checksFieldSuffixes,
  type ChecksIssue,
  type ChecksValue,
} from '../workflow/ChecksFields.js';
import type { DirtyDraft } from '../workflow/draft-guard.js';
import {
  compareRows,
  draftsDiffer,
  gateCountText,
  gateTitle,
  initialDraft,
  overrideIssues,
  repoRows,
  setupText,
  type RepoRow,
  type Spec,
} from './repo-checks-model.js';
import '../workflow/workflow.css';
import './repo-checks.css';

export { initialDraft, overrideIssues, setupText };

interface RepoChecksPageProps {
  api: ApiClient;
  /** The selected repo (from the route), or none. */
  repo: string | null;
  onSelect: (repo: string | null) => void;
  /** The app's draft guard (UXR-81): the repo with unsaved checks, or null. */
  onDirtyChange?: (dirty: DirtyDraft | null) => void;
}

type List =
  { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'loaded'; rows: RepoChecksDto[] };

/**
 * `#/repo-checks[/<repo>]` (ADR-0030): per-repo check overrides. A repo's override replaces the
 * checks and setup at every gate of the `conductor` workflow that runs checks. Two panes (UXR-76):
 * every known repo, grouped *Own checks* / *Workflow checks*, and the selected repo's editor. On a
 * phone the panes stack: the list, or the editor with Back.
 */
export function RepoChecksPage({ api, repo, onSelect, onDirtyChange }: RepoChecksPageProps) {
  const mobile = useIsMobile();
  const [list, setList] = useState<List>({ kind: 'loading' });
  const [suggestions, setSuggestions] = useState<RepoSuggestion[]>([]);
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [filter, setFilter] = useState('');

  const loadList = useCallback(() => {
    api.listRepoChecks().then(
      (res) => setList({ kind: 'loaded', rows: res.repos }),
      (err: unknown) => setList({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api]);

  useEffect(() => loadList(), [loadList]);
  useEffect(() => {
    let cancelled = false;
    api.listRepos().then(
      (rows) => {
        if (!cancelled) setSuggestions(rows);
      },
      () => {},
    );
    // Gate titles and the workflow's own checks; without it the compare table shows raw ids.
    api.getWorkflow(CONDUCTOR_WORKFLOW_ID).then(
      (w) => {
        if (!cancelled) setDef(w.definition);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const showList = !mobile || repo === null;
  const showDetail = !mobile || repo !== null;

  return (
    <section className="repo-checks" aria-label="Repo checks">
      <h2>Repo checks</h2>
      <p className="muted rc-note">
        Give a repo its own build and test commands, instead of the workflow’s.{' '}
        <HelpLink href={REPO_CHECKS_HELP_URL}>Help</HelpLink>
      </p>
      <div className={`rc-panes${mobile ? ' mobile' : ''}`}>
        {showList && (
          <RepoList
            list={list}
            suggestions={suggestions}
            filter={filter}
            onFilter={setFilter}
            selected={repo}
            onSelect={onSelect}
          />
        )}
        {showDetail && (
          <div className="rc-pane rc-pane-detail">
            {mobile && (
              <button type="button" className="rc-back" onClick={() => onSelect(null)}>
                ← Repos
              </button>
            )}
            {repo === null ? (
              <p className="muted rc-empty">Pick a repo to see what runs for it.</p>
            ) : (
              <RepoDetailView
                key={repo}
                api={api}
                repo={repo}
                def={def}
                onChanged={loadList}
                onSelect={onSelect}
                onDirtyChange={onDirtyChange}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function RepoList({
  list,
  suggestions,
  filter,
  onFilter,
  selected,
  onSelect,
}: {
  list: List;
  suggestions: RepoSuggestion[];
  filter: string;
  onFilter: (v: string) => void;
  selected: string | null;
  onSelect: (repo: string) => void;
}) {
  const overrides = list.kind === 'loaded' ? list.rows : [];
  const { own, workflow } = repoRows(suggestions, overrides, filter);
  const selectedKey = selected === null ? null : repoChecksKey(selected);
  // A repo nobody knows yet can still be opened by its name.
  const typed = canonicalRepo(filter.trim());
  const typedKey = typed === null ? null : repoChecksKey(typed);
  const known = [...own, ...workflow].some((r) => repoChecksKey(r.repo) === typedKey);
  const filtering = filter.trim() !== '';

  const row = (r: RepoRow) => (
    <li key={r.repo}>
      <button
        type="button"
        className="rc-repo"
        aria-current={repoChecksKey(r.repo) === selectedKey ? 'true' : undefined}
        onClick={() => onSelect(r.repo)}
      >
        <span className="rc-repo-name">{r.repo}</span>
        {r.override !== null && (
          <span className="rc-repo-meta muted">
            {r.override.checks.map((c) => c.name).join(', ')} · {ago(r.override.updated_at)}
          </span>
        )}
      </button>
    </li>
  );

  return (
    <nav className="rc-pane rc-pane-list" aria-label="Repos">
      <input
        type="search"
        className="rc-filter"
        aria-label="Filter repos"
        placeholder="Filter repos"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
      />
      {typed !== null && typedKey !== null && !known && (
        <button type="button" className="rc-repo rc-open" onClick={() => onSelect(typed)}>
          Open {typed}
        </button>
      )}
      <h3>
        Own checks <span className="muted">{own.length}</span>
      </h3>
      {list.kind === 'loading' && <p className="loading">Loading…</p>}
      {list.kind === 'error' && (
        <p role="alert" className="error">
          {list.text}
        </p>
      )}
      {list.kind === 'loaded' && own.length === 0 && (
        <p className="muted rc-empty">
          {filtering && list.rows.length > 0 ? 'None match.' : 'No repo has its own checks yet.'}
        </p>
      )}
      {own.length > 0 && (
        <ul className="rc-repos" aria-label="Own checks">
          {own.map(row)}
        </ul>
      )}
      <h3>
        Workflow checks <span className="muted">{workflow.length}</span>
      </h3>
      {workflow.length === 0 ? (
        <p className="muted rc-empty">
          {filtering ? 'None match.' : 'No other repos on your machines.'}
        </p>
      ) : (
        <ul className="rc-repos" aria-label="Workflow checks">
          {workflow.map(row)}
        </ul>
      )}
    </nav>
  );
}

type Detail =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'loaded'; detail: RepoChecksDetail };

function RepoDetailView({
  api,
  repo,
  def,
  onChanged,
  onSelect,
  onDirtyChange,
}: {
  api: ApiClient;
  repo: string;
  def: WorkflowDefinition | null;
  /** The list may have changed (saved or cleared). */
  onChanged: () => void;
  onSelect: (repo: string | null) => void;
  onDirtyChange?: ((dirty: DirtyDraft | null) => void) | undefined;
}) {
  const [state, setState] = useState<Detail>({ kind: 'loading' });
  const [draft, setDraft] = useState<ChecksValue | null>(null);
  const [serverIssues, setServerIssues] = useState<ApiErrorDetail[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const hintId = useId();

  const load = useCallback(() => {
    api.getRepoChecks(repo).then(
      (detail) => {
        setState({ kind: 'loaded', detail });
        setDraft(initialDraft(detail));
        setServerIssues([]);
      },
      (err: unknown) => setState({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api, repo]);

  useEffect(() => load(), [load]);

  const initial = state.kind === 'loaded' ? initialDraft(state.detail) : null;
  const dirty = draft !== null && initial !== null && draftsDiffer(draft, initial);

  // UXR-81: the app's guard holds navigation away from unsaved checks.
  useEffect(() => {
    onDirtyChange?.(dirty ? { kind: 'repo-checks', repo } : null);
  }, [dirty, repo, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(null), [onDirtyChange]);

  if (state.kind === 'loading' || (state.kind === 'loaded' && draft === null)) {
    return <p className="loading">Loading…</p>;
  }
  if (state.kind === 'error') {
    return (
      <p role="alert" className="error">
        {state.text}
      </p>
    );
  }
  const { detail } = state;
  const value = draft!;
  const override = detail.override;
  const issues = overrideIssues(value);
  const gateCount = detail.effective.length;

  // Client and server problems at the check fields; anything else goes at the end.
  const shown = checksFieldSuffixes(value.checks);
  const fieldIssues: ChecksIssue[] = [
    ...issues,
    ...serverIssues.map((i) => ({ suffix: i.path, message: i.message })),
  ];
  const rest = fieldIssues.filter((i) => !shown.has(i.suffix));

  async function save() {
    setBusy(true);
    setActionError(null);
    setServerIssues([]);
    try {
      const dto = await api.setRepoChecks({
        repo: detail.repo,
        checks: value.checks,
        ...(value.setup !== undefined ? { setup: value.setup } : {}),
      });
      onChanged();
      if (dto.repo !== repo) {
        // Saved: the canonical spelling's route isn't leaving unsaved work.
        onDirtyChange?.(null);
        onSelect(dto.repo);
      } else load();
    } catch (err) {
      if (err instanceof ApiRequestError && err.details.length > 0) setServerIssues(err.details);
      else setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setActionError(null);
    try {
      await api.clearRepoChecks(detail.repo);
      setConfirmClear(false);
      onChanged();
      load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // The workflow's own checks per gate: `effective` shows the override's once there is one.
  const workflowGates: ChecksGate[] =
    def !== null ? checksGatesOf(def) : detail.effective.filter((g) => g.source === 'workflow');
  const savedOverride: Spec | null =
    override === null ? null : { setup: override.setup, checks: override.checks };
  const rows = compareRows({
    workflowGates,
    savedOverride,
    draft: value,
    dirty,
    title: (at) => gateTitle(def, at),
  });

  const primaryLabel = override !== null ? 'Save' : 'Set override';
  const untouched = !dirty && override === null;

  return (
    <div className="rc-detail" aria-label={`Checks for ${detail.repo}`} role="region">
      <header className="rc-head">
        <h3 className="rc-repo-title">{detail.repo}</h3>
        <span className={`chip ${override !== null ? 'rc-chip-own' : 'rc-chip-workflow'}`}>
          {override !== null ? 'Own checks' : 'Workflow checks'}
        </span>
        <p className="muted rc-note rc-head-line">
          {gateCountText(gateCount)}
          {override !== null &&
            ` · set ${ago(override.updated_at)}${override.updated_by !== null ? ` by ${override.updated_by}` : ''}`}
        </p>
      </header>

      {override === null && (
        <p className="muted rc-note">
          Starting from the workflow’s checks. Change them to give this repo its own.
        </p>
      )}
      <div className="rc-editor">
        <ChecksFields
          checks={value.checks}
          setup={value.setup}
          setupLabel="Setup: runs first, in a fresh checkout"
          onChange={(next) => {
            setDraft(next);
            setServerIssues([]);
          }}
          issues={fieldIssues}
        />
      </div>
      {rest.map((i) => (
        <p key={`${i.suffix}:${i.message}`} className="wf-field-error" role="alert">
          {i.suffix !== '' ? `${i.suffix}: ` : ''}
          {i.message}
        </p>
      ))}

      <details className="rc-compare">
        <summary>
          Compare with the workflow’s checks
          {dirty && <span className="muted"> · unsaved changes</span>}
        </summary>
        {rows.length === 0 ? (
          <p className="muted">The conductor workflow has no gate that runs checks.</p>
        ) : (
          <div className="rc-scroll">
            <table className="rc-table" aria-label="Compare with the workflow’s checks">
              <thead>
                <tr>
                  <th>Gates</th>
                  <th>Workflow’s checks</th>
                  <th>This repo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.gates.join('|')} className={r.changed ? 'rc-changed' : undefined}>
                    <td>
                      {r.label}
                      {r.changed && <span className="badge rc-changed-badge">Changed</span>}
                    </td>
                    <td>
                      <SpecView spec={r.workflow} />
                    </td>
                    <td>
                      {r.repo === null ? (
                        <span className="muted">Same as the workflow</span>
                      ) : (
                        <SpecView spec={r.repo} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      {actionError !== null && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      {override !== null && confirmClear && (
        <div className="rc-confirm" role="group" aria-label="Use workflow checks">
          <span>Drop this repo’s own checks and use the workflow’s again?</span>
          <button type="button" className="danger" disabled={busy} onClick={() => void clear()}>
            Use workflow checks
          </button>
          <button type="button" disabled={busy} autoFocus onClick={() => setConfirmClear(false)}>
            Keep own checks
          </button>
        </div>
      )}
      <div className="rc-footer">
        {override !== null && (
          <MoreActions disabled={busy} onUseWorkflow={() => setConfirmClear(true)} />
        )}
        {untouched && (
          <span id={hintId} className="muted rc-hint">
            Change a check or the setup to set this repo’s own.
          </span>
        )}
        <span className="rc-footer-gap" />
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(initial);
            setServerIssues([]);
          }}
        >
          Discard
        </button>
        <button
          type="button"
          className="rc-primary"
          disabled={busy || issues.length > 0 || !dirty}
          aria-describedby={untouched ? hintId : undefined}
          onClick={() => void save()}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

function SpecView({ spec }: { spec: Spec }) {
  return (
    <>
      <div className="muted rc-spec-setup">Setup: {setupText(spec.setup)}</div>
      <ul className="rc-checks">
        {spec.checks.map((c, i) => (
          <li key={`${i}:${c.name}`}>
            {c.name}: <code>{c.cmd}</code>
            {c.timeout !== undefined ? ` (${c.timeout})` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The footer's overflow menu: clearing the override lives here (UXR-79), away from Save. */
function MoreActions({
  disabled,
  onUseWorkflow,
}: {
  disabled: boolean;
  onUseWorkflow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="rc-more" ref={ref}>
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="rc-menu" role="menu" aria-label="More actions">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onUseWorkflow();
            }}
          >
            Use workflow checks…
          </button>
        </div>
      )}
    </div>
  );
}
