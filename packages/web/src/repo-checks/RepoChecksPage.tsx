import type {
  RepoChecksDetail,
  RepoChecksDto,
  RepoChecksHealthResponse,
  RepoSuggestion,
} from '@conductor/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiRequestError,
  errorMessage,
  type ApiClient,
  type ApiErrorDetail,
} from '../api/client.js';
import { ago } from '../components/format.js';
import { RepoCombobox } from '../components/RepoCombobox.js';
import { HelpLink, REPO_CHECKS_HELP_URL } from '../help/HelpPage.js';
import {
  ChecksFields,
  checksFieldSuffixes,
  type ChecksIssue,
  type ChecksValue,
} from '../workflow/ChecksFields.js';
import { useToast } from '../components/Toast.js';
import { ProposalsPanel } from '../workflow/ProposalsPanel.js';
import { checkListIssues, type CheckListIssue } from '../workflow/transitions.js';
import { CheckHistory, HealthBadge } from './CheckHistory.js';
import '../workflow/workflow.css';
import './repo-checks.css';

/** How a gate's or override's `setup` reads (null = auto-detect, '' = none). */
export function setupText(setup: string | null): string {
  if (setup === null) return 'Auto-detect (npm ci / npm install)';
  if (setup === '') return 'None';
  return setup;
}

/** The draft for a repo: its override, else the workflow's first gate (a starting point). */
export function initialDraft(detail: RepoChecksDetail): ChecksValue {
  const from = detail.override ?? detail.effective[0] ?? null;
  if (from === null) return { checks: [{ name: '', cmd: '' }], setup: undefined };
  return { checks: structuredClone(from.checks), setup: from.setup ?? undefined };
}

/** `checkListIssues` plus the override's own rule: at least one check (RepoChecksSchema). */
export function overrideIssues(draft: ChecksValue): CheckListIssue[] {
  const issues = checkListIssues(draft.checks, draft.setup);
  if (draft.checks.length === 0) {
    issues.push({ suffix: 'checks', message: 'add at least one check' });
  }
  return issues;
}

interface RepoChecksPageProps {
  api: ApiClient;
  /** The selected repo (from the route), or none. */
  repo: string | null;
  onSelect: (repo: string | null) => void;
}

type List =
  { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'loaded'; rows: RepoChecksDto[] };

/**
 * `#/repo-checks[/<repo>]` (ADR-0030): the account's per-repo check overrides. A repo's override
 * replaces the checks and setup at every gate of the `conductor` workflow that runs checks; the
 * page lists them, shows what runs at each gate for one repo, and sets or clears its override.
 */
export function RepoChecksPage({ api, repo, onSelect }: RepoChecksPageProps) {
  const [list, setList] = useState<List>({ kind: 'loading' });
  const [suggestions, setSuggestions] = useState<RepoSuggestion[]>([]);
  const [pick, setPick] = useState('');
  // UXR-80: per-repo check results; null when they didn't load (the column then stays empty).
  const [health, setHealth] = useState<RepoChecksHealthResponse | null>(null);

  const loadList = useCallback(() => {
    api.listRepoChecks().then(
      (res) => setList({ kind: 'loaded', rows: res.repos }),
      (err: unknown) => setList({ kind: 'error', text: errorMessage(err) }),
    );
    api.getRepoChecksHealth().then(setHealth, () => setHealth(null));
  }, [api]);
  const healthOf = (repo: string) =>
    health === null ? undefined : (health.repos.find((h) => h.repo === repo) ?? null);

  useEffect(() => loadList(), [loadList]);
  useEffect(() => {
    let cancelled = false;
    api.listRepos().then(
      (rows) => {
        if (!cancelled) setSuggestions(rows);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  function open(e: FormEvent) {
    e.preventDefault();
    const next = pick.trim();
    if (next === '') return;
    setPick('');
    onSelect(next);
  }

  return (
    <section className="repo-checks" aria-label="Repo checks">
      <h2>Repo checks</h2>
      <p className="muted rc-note">
        Give a repo its own build and test commands, instead of the workflow’s.{' '}
        <HelpLink href={REPO_CHECKS_HELP_URL}>Help</HelpLink>
      </p>

      <h3>Repos with their own checks</h3>
      {list.kind === 'loading' && <p className="loading">Loading…</p>}
      {list.kind === 'error' && (
        <p role="alert" className="error">
          {list.text}
        </p>
      )}
      {list.kind === 'loaded' && list.rows.length === 0 && (
        <p className="muted">No repo has its own checks yet.</p>
      )}
      {list.kind === 'loaded' && list.rows.length > 0 && (
        <div className="rc-scroll">
          <table className="rc-table" aria-label="Repos with their own checks">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Checks</th>
                <th>Health</th>
                <th>Setup</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.repo} aria-current={row.repo === repo ? 'true' : undefined}>
                  <td>
                    <button type="button" className="link mono" onClick={() => onSelect(row.repo)}>
                      {row.repo}
                    </button>
                  </td>
                  <td>{row.checks.map((c) => c.name).join(', ')}</td>
                  <td>
                    <HealthBadge
                      health={healthOf(row.repo)}
                      windowDays={health?.window_days ?? 30}
                    />
                  </td>
                  <td className="mono">{setupText(row.setup)}</td>
                  <td className="muted">
                    {ago(row.updated_at)}
                    {row.updated_by !== null ? ` by ${row.updated_by}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="rc-pick" onSubmit={open} aria-label="Open a repo">
        <RepoCombobox value={pick} onChange={setPick} suggestions={suggestions} />
        <button type="submit" disabled={pick.trim() === ''}>
          Open
        </button>
      </form>

      {repo !== null && (
        <RepoDetailView key={repo} api={api} repo={repo} onChanged={loadList} onSelect={onSelect} />
      )}
    </section>
  );
}

type Detail =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'loaded'; detail: RepoChecksDetail };

function RepoDetailView({
  api,
  repo,
  onChanged,
  onSelect,
}: {
  api: ApiClient;
  repo: string;
  /** The list may have changed (saved or cleared). */
  onChanged: () => void;
  onSelect: (repo: string | null) => void;
}) {
  const [state, setState] = useState<Detail>({ kind: 'loading' });
  const [draft, setDraft] = useState<ChecksValue | null>(null);
  const [serverIssues, setServerIssues] = useState<ApiErrorDetail[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // UXR-80: bumped on every (re)load, so the run history follows the saved checks.
  const [loads, setLoads] = useState(0);
  const toast = useToast();

  const load = useCallback(() => {
    api.getRepoChecks(repo).then(
      (detail) => {
        setState({ kind: 'loaded', detail });
        setDraft(initialDraft(detail));
        setServerIssues([]);
        setLoads((n) => n + 1);
      },
      (err: unknown) => setState({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api, repo]);

  useEffect(() => load(), [load]);

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
  const initial = initialDraft(detail);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

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
      toast('Checks saved');
      onChanged();
      if (dto.repo !== repo) onSelect(dto.repo);
      else load();
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
      toast('Checks cleared');
      onChanged();
      load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const fields = (
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
  );

  return (
    <div className="rc-detail" aria-label={`Checks for ${detail.repo}`} role="region">
      <h3>
        <span className="mono">{detail.repo}</span>
      </h3>

      <h4>What runs at each gate</h4>
      {detail.effective.length === 0 ? (
        <p className="muted">The conductor workflow has no gate that runs checks.</p>
      ) : (
        <div className="rc-scroll">
          <table className="rc-table" aria-label="Effective checks">
            <thead>
              <tr>
                <th>Gate</th>
                <th>From</th>
                <th>Setup</th>
                <th>Checks</th>
              </tr>
            </thead>
            <tbody>
              {detail.effective.map((g) => (
                <tr key={g.at}>
                  <td className="mono">{g.at}</td>
                  <td>
                    <span className={`badge rc-source-${g.source}`}>
                      {g.source === 'override' ? 'Repo override' : 'Workflow default'}
                    </span>
                  </td>
                  <td className="mono">{setupText(g.setup)}</td>
                  <td>
                    <ul className="rc-checks">
                      {g.checks.map((c) => (
                        <li key={c.name}>
                          {c.name}: <code>{c.cmd}</code>
                          {c.timeout !== undefined ? ` (${c.timeout})` : ''}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CheckHistory api={api} repo={detail.repo} version={loads} />

      <h4>{override !== null ? 'This repo’s checks' : 'Give this repo its own checks'}</h4>
      {override === null && (
        <p className="muted rc-note">
          This repo runs the workflow’s checks. Starting from them, edit the list and set an
          override.
        </p>
      )}
      {override !== null && (
        <p className="muted rc-note">
          Set {ago(override.updated_at)}
          {override.updated_by !== null ? ` by ${override.updated_by}` : ''}.
        </p>
      )}
      <div className="rc-editor">{fields}</div>
      {rest.map((i) => (
        <p key={`${i.suffix}:${i.message}`} className="wf-field-error" role="alert">
          {i.suffix !== '' ? `${i.suffix}: ` : ''}
          {i.message}
        </p>
      ))}
      {actionError !== null && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      <div className="rc-actions">
        <button
          type="button"
          disabled={busy || issues.length > 0 || (override !== null && !dirty)}
          onClick={() => void save()}
        >
          {override !== null ? 'Save' : 'Set override'}
        </button>
        {dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(initial);
              setServerIssues([]);
            }}
          >
            Discard changes
          </button>
        )}
        {override !== null && !confirmClear && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setConfirmClear(true)}
          >
            Clear override
          </button>
        )}
      </div>
      {override !== null && confirmClear && (
        <div className="rc-confirm" role="group" aria-label="Clear override">
          <span>Use the workflow’s checks for this repo again?</span>
          <button type="button" className="danger" disabled={busy} onClick={() => void clear()}>
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
        </div>
      )}
      {/* UXR-73 (FR-5): the advisor's proposals for this repo's checks, here as well. */}
      <ProposalsPanel
        api={api}
        dirty={dirty}
        kind="repo_checks"
        target={detail.repo}
        onApplied={() => {
          onChanged();
          load();
        }}
      />
    </div>
  );
}
