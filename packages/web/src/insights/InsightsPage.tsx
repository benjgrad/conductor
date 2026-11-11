import type {
  AdvisorGroupBy,
  FindingWithProposal,
  FindingsResponse,
  ProcessGroup,
  ProcessMetricsResponse,
  ProcessReportResponse,
  ReportFriction,
} from '@conductor/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { CopyButton } from '../components/details-sections.js';
import { CONNECT_CLAUDE_URL, followInApp } from '../help/HelpPage.js';
import { routeHash } from '../nav.js';
import { NOTIFY_MODE_TEXT } from '../workflow/notify-policy.js';
import './insights.css';

// UXR-84 (ADR-0033): `#/insights`, the workflow advisor's data on the board. The same reads as the
// MCP tools get_process_metrics, list_findings and get_process_report: time per group with its
// rework and failures, the ranked findings with the fix for each (an existing change proposal, or
// how to ask the advisor for one), and the analysts' frictions. Model-written text (frictions,
// suggestions) is shown as plain text, never markdown.

export interface InsightsPageProps {
  api: ApiClient;
  /** Open an example ticket on the board. */
  onOpenTicket: (ticketId: string) => void;
  /** A ticket's title when it is on the board (else its id's first 8 characters show). */
  ticketTitle?: ((ticketId: string) => string | null) | undefined;
}

export const WINDOWS = [7, 30, 90] as const;
const GROUP_BY: { value: AdvisorGroupBy; label: string }[] = [
  { value: 'state', label: 'State' },
  { value: 'repo', label: 'Repo' },
  { value: 'machine', label: 'Machine' },
  { value: 'check', label: 'Check' },
];

const SEVERITY: Record<number, string> = { 1: 'Worth a look', 2: 'Costs time', 3: 'Fix first' };

const CATEGORY_LABEL: Record<string, string> = {
  unclear_requirements: 'Unclear requirements',
  flaky_check: 'Flaky check',
  failing_check: 'Failing check',
  missing_permission: 'Missing permission',
  tool_error: 'Tool error',
  environment: 'Environment',
  rework: 'Rework',
  waiting_on_human: 'Waiting on a human',
  other: 'Other',
};
/** R13: what the analysts cost in the window, e.g. `12 analyst jobs, about $0.01`. */
export function analystCost(a: NonNullable<ProcessReportResponse['analyst']>): string {
  const jobs = `${a.jobs} analyst ${a.jobs === 1 ? 'job' : 'jobs'}`;
  if (a.priced_jobs === 0) return `${jobs}, cost not reported`;
  const usd =
    a.cost_usd > 0 && a.cost_usd < 0.01 ? 'under $0.01' : `about $${a.cost_usd.toFixed(2)}`;
  return `${jobs}, ${usd}`;
}

export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c.replace(/_/g, ' ');

/** Minutes as `42m`, or `3h 5m` from an hour up. */
export function formatMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m - h * 60);
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** A wait's ceiling: days from a day up (a 3-day approval timeout reads `3 d`). */
export const formatCeiling = (m: number): string =>
  m >= 1440 ? `${Math.round((m / 1440) * 10) / 10} d` : formatMinutes(m);

const humanise = (s: string) => {
  const w = s.replace(/_/g, ' ').replace(/\bpr\b/gi, 'PR');
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * A state grouping's key in words. The advisor keys a gate step as `<state>.<transition>` (or
 * `<state>.entry`, `<state>.review`) across workflow versions: "Implementing → PR ready for
 * review (gate)". A plain state shows as is.
 */
export function groupKeyLabel(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return key;
  const state = humanise(key.slice(0, dot));
  const tail = key.slice(dot + 1);
  if (tail === 'entry') return `Entering ${state} (gate)`;
  if (tail === 'review') return `${state} → review (gate)`;
  return `${state} → ${humanise(tail)
    .toLowerCase()
    .replace(/\bpr\b/g, 'PR')} (gate)`;
}

const shortId = (id: string) => id.slice(0, 8);

type TicketLink = { open: (id: string) => void; title: (id: string) => string | null };

/** An example ticket: its title (or short id), opening it on the board. */
function TicketButton({ id, link }: { id: string; link: TicketLink }) {
  const title = link.title(id);
  return (
    <button
      type="button"
      className={title === null ? 'link mono' : 'link'}
      title={id}
      aria-label={`Open ticket ${title ?? shortId(id)}`}
      onClick={() => link.open(id)}
    >
      {title ?? shortId(id)}
    </button>
  );
}

type Load<T> = { data: T | null; error: string | null };

/** `load()` whenever `key` changes; a result for an older key reads as still loading. */
function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [state, setState] = useState<Load<T> & { key: string | null }>({
    key: null,
    data: null,
    error: null,
  });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (data) => {
        if (!cancelled) setState({ key, data, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ key, data: null, error: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state.key === key ? state : { data: null, error: null };
}

export function InsightsPage({ api, onOpenTicket, ticketTitle }: InsightsPageProps) {
  const link: TicketLink = { open: onOpenTicket, title: ticketTitle ?? (() => null) };
  const [windowDays, setWindowDays] = useState<number>(30);
  const [groupBy, setGroupBy] = useState<AdvisorGroupBy>('state');
  const [machineNames, setMachineNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api.listMachines().then(
      (rows) => {
        if (!cancelled) setMachineNames(new Map(rows.map((m) => [m.id, m.name])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const metrics = useLoad(
    () => api.getProcessMetrics({ windowDays, groupBy }),
    `${windowDays}:${groupBy}`,
  );
  const report = useLoad(() => api.getProcessReport({ windowDays }), String(windowDays));

  return (
    <section className="insights" aria-labelledby="insights-title">
      <header className="ins-head">
        <h2 id="insights-title">Insights</h2>
        <div className="ins-controls">
          <div role="radiogroup" aria-label="Window" className="ins-segmented">
            {WINDOWS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={windowDays === d}
                onClick={() => setWindowDays(d)}
              >
                {d} days
              </button>
            ))}
          </div>
          <label>
            Group by{' '}
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as AdvisorGroupBy)}>
              {GROUP_BY.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <MetricsSection state={metrics} machineNames={machineNames} />
      <FindingsSection key={windowDays} api={api} windowDays={windowDays} link={link} />
      <FrictionsSection state={report} link={link} />
    </section>
  );
}

// ---------------------------------------------------------------- time per group

function MetricsSection({
  state,
  machineNames,
}: {
  state: Load<ProcessMetricsResponse>;
  machineNames: Map<string, string>;
}) {
  const { data, error } = state;
  const max = useMemo(() => Math.max(1, ...(data?.groups ?? []).map((g) => g.p90_minutes)), [data]);
  const heading = (
    <h3 id="ins-metrics" className="ins-section-title">
      Time per {data?.group_by ?? 'group'}
    </h3>
  );
  if (error) {
    return (
      <section aria-labelledby="ins-metrics">
        {heading}
        <p role="alert" className="error">
          {error}
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section aria-labelledby="ins-metrics">
        {heading}
        <p className="loading">Loading…</p>
      </section>
    );
  }
  const byCheck = data.group_by === 'check';
  const keyLabel = (g: ProcessGroup) =>
    data.group_by === 'machine'
      ? (machineNames.get(g.key) ?? g.key)
      : data.group_by === 'state'
        ? groupKeyLabel(g.key)
        : g.key;
  const t = data.totals;
  return (
    <section aria-labelledby="ins-metrics">
      {heading}
      <p className="ins-totals muted">
        {t.tickets} tickets · {t.sessions} sessions · {t.check_runs} check runs · {t.questions}{' '}
        questions · {t.handoffs} hand-offs in the last {data.window_days} days
      </p>
      {data.groups.length === 0 ? (
        <p className="muted">Nothing ran in this window.</p>
      ) : (
        <div className="ins-scroll">
          <table className="ins-table">
            <thead>
              <tr>
                <th scope="col">{GROUP_BY.find((g) => g.value === data.group_by)?.label}</th>
                <th scope="col">Time (median / p90)</th>
                <th scope="col">Re-entries</th>
                <th scope="col">Check failures</th>
                <th scope="col">Questions</th>
                <th scope="col">Hand-offs</th>
                {data.group_by !== 'state' && <th scope="col">Denials</th>}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.key}>
                  <th scope="row" className={byCheck ? 'mono' : undefined}>
                    {keyLabel(g)}
                    {g.waits_on_others && (
                      <span className="ins-wait">
                        Waiting on others
                        {g.ceiling_minutes !== null &&
                          ` · up to ${formatCeiling(g.ceiling_minutes)}`}
                      </span>
                    )}
                  </th>
                  <td>
                    {byCheck || g.stays === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="ins-bars">
                        <Bar kind="median" value={g.median_minutes} max={max} />
                        <Bar kind="p90" value={g.p90_minutes} max={max} />
                      </div>
                    )}
                  </td>
                  <td>{g.reentries}</td>
                  <td className={g.check_failures > 0 ? 'ins-bad' : undefined}>
                    {g.check_runs === 0 ? '—' : `${g.check_failures} / ${g.check_runs}`}
                  </td>
                  <td>{g.questions}</td>
                  <td>{g.handoffs}</td>
                  {data.group_by !== 'state' && <td>{g.permission_denials}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.more_groups > 0 && <p className="muted">And {data.more_groups} more.</p>}
      {data.presets && <SavedReplies presets={data.presets} />}
      {data.pushes && <Notifications pushes={data.pushes} />}
      {data.rows_truncated && (
        <p className="muted">
          Only the newest rows were read for: {data.rows_truncated.join(', ')}.
        </p>
      )}
    </section>
  );
}

/**
 * ADR-0037 P5: how often a person's review reply was exactly a saved reply, and how often they
 * typed something else where one was on offer: is the recipe still typed by hand?
 */
function SavedReplies({ presets }: { presets: NonNullable<ProcessMetricsResponse['presets']> }) {
  return (
    <div className="ins-scroll">
      <table className="ins-table" aria-label="Saved replies">
        <thead>
          <tr>
            <th scope="col">Saved reply</th>
            <th scope="col">Sent as is</th>
          </tr>
        </thead>
        <tbody>
          {presets.uses.map((u) => (
            <tr key={`${u.workflow_id}/${u.slug}`}>
              <th scope="row" className="mono">
                {u.slug}
              </th>
              <td>{u.used}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        {presets.typed} {presets.typed === 1 ? 'reply was' : 'replies were'} typed by hand where a
        saved reply was on offer.
      </p>
    </div>
  );
}

/**
 * ADR-0037 P6: what the notify policy decided over the window: moves that pushed, moves it kept
 * silent, pushes per ticket, and the decisions per transition (or engine cause). Absent in legacy
 * mode, when no move carried a decision.
 */
function Notifications({ pushes }: { pushes: NonNullable<ProcessMetricsResponse['pushes']> }) {
  const p = pushes.per_ticket;
  return (
    <div className="ins-scroll">
      <p className="muted">
        {pushes.total} {pushes.total === 1 ? 'push' : 'pushes'} sent · {pushes.silent} kept silent ·
        per ticket: median {p.median}, p90 {p.p90}, max {p.max}
      </p>
      <table className="ins-table" aria-label="Notifications">
        <thead>
          <tr>
            <th scope="col">Via</th>
            <th scope="col">Policy</th>
            <th scope="col">Decision</th>
            <th scope="col">Moves</th>
          </tr>
        </thead>
        <tbody>
          {pushes.by_via.map((v) => (
            <tr key={`${v.via}/${v.mode}/${v.decision}`}>
              <th scope="row" className="mono">
                {v.via}
              </th>
              <td>{(NOTIFY_MODE_TEXT as Record<string, string | undefined>)[v.mode] ?? v.mode}</td>
              <td>{v.decision === 'push' ? 'Pushed' : 'Silent'}</td>
              <td>{v.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ kind, value, max }: { kind: 'median' | 'p90'; value: number; max: number }) {
  const label = `${kind === 'median' ? 'Median' : 'p90'} ${formatMinutes(value)}`;
  return (
    <div className={`ins-bar ins-bar-${kind}`} title={label}>
      <span className="ins-bar-track" aria-hidden="true">
        <span className="ins-bar-fill" style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
      </span>
      <span className="ins-bar-value">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- findings

function FindingsSection({
  api,
  windowDays,
  link,
}: {
  api: ApiClient;
  windowDays: number;
  link: TicketLink;
}) {
  const [pages, setPages] = useState<FindingsResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const more = (cursor: number) => {
    setLoading(true);
    api.listFindings({ windowDays, cursor }).then(
      (page) => {
        setPages((p) => [...p, page]);
        setLoading(false);
      },
      (err: unknown) => {
        setError(errorMessage(err));
        setLoading(false);
      },
    );
  };
  // The parent remounts this on a new window (`key`), so the first page loads once per mount.
  useEffect(() => {
    let cancelled = false;
    api.listFindings({ windowDays }).then(
      (page) => {
        if (cancelled) return;
        setPages([page]);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, windowDays]);

  const findings = pages.flatMap((p) => p.findings);
  const last = pages.at(-1);
  return (
    <section aria-labelledby="ins-findings">
      <h3 id="ins-findings" className="ins-section-title">
        Findings{last ? ` (${last.total})` : ''}
      </h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!error && !loading && findings.length === 0 && (
        <p className="muted">No findings: nothing stands out in this window.</p>
      )}
      <ul className="ins-findings">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} link={link} />
        ))}
      </ul>
      {loading && <p className="loading">Loading…</p>}
      {!loading && last?.next_cursor != null && (
        <button type="button" onClick={() => more(last.next_cursor!)}>
          Show more
        </button>
      )}
    </section>
  );
}

function FindingCard({ f, link }: { f: FindingWithProposal; link: TicketLink }) {
  const titleId = `finding-${f.id.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <li className={`ins-card sev-${f.severity}`} aria-labelledby={titleId}>
      <div className="ins-card-head">
        <span className={`ins-pill sev-${f.severity}`}>{SEVERITY[f.severity] ?? f.severity}</span>
        <h4 id={titleId}>{f.title}</h4>
      </div>
      <p>{f.evidence}</p>
      <p className="muted">{f.suggestion}</p>
      {f.example_ticket_ids.length > 0 && (
        <p className="ins-examples">
          <span className="muted">Examples:</span>
          {f.example_ticket_ids.map((id) => (
            <TicketButton key={id} id={id} link={link} />
          ))}
        </p>
      )}
      <FixAction f={f} />
    </li>
  );
}

/** The fixing action: the proposal that cites the finding, or how to ask the advisor for one. */
function FixAction({ f }: { f: FindingWithProposal }) {
  if (f.proposal) {
    return (
      <p className="ins-fix">
        <a
          className="button"
          href={routeHash({ view: 'workflows', workflowId: null, proposalId: f.proposal.id })}
        >
          Open proposal
        </a>{' '}
        <span className="muted">
          {f.proposal.title} ({f.proposal.status})
        </span>
      </p>
    );
  }
  if (f.suggested_tool === 'board') {
    return (
      <p className="ins-fix muted">
        The fix is a decision on the board: answer the next permission prompt for this tool, or
        change the machine’s rules on the Machines page.
      </p>
    );
  }
  const prompt = `Use the workflow_advisor prompt to propose a fix for finding ${f.id}.`;
  return (
    <details className="ins-fix">
      <summary>Propose a fix</summary>
      <p>
        The workflow advisor proposes one change at a time, and you apply it from the Workflow page.
        In Claude, with{' '}
        <a href={CONNECT_CLAUDE_URL} onClick={(e) => followInApp(e, CONNECT_CLAUDE_URL)}>
          conductor connected
        </a>
        , run the <code>workflow_advisor</code> prompt and ask:
      </p>
      <p className="ins-prompt">
        <code>{prompt}</code> <CopyButton text={prompt} label="advisor prompt" />
      </p>
    </details>
  );
}

// ---------------------------------------------------------------- frictions

function FrictionsSection({
  state,
  link,
}: {
  state: Load<ProcessReportResponse>;
  link: TicketLink;
}) {
  const { data, error } = state;
  const grouped = useMemo(() => {
    const by = new Map<string, ReportFriction[]>();
    for (const f of data?.frictions ?? []) by.set(f.category, [...(by.get(f.category) ?? []), f]);
    return [...by.entries()];
  }, [data]);
  return (
    <section aria-labelledby="ins-frictions">
      <h3 id="ins-frictions" className="ins-section-title">
        Frictions the analysts reported
      </h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!error && !data && <p className="loading">Loading…</p>}
      {data && (
        <>
          <p className="muted">
            {data.analysed_sessions} of {data.finished_sessions} finished sessions analysed
            {data.finished_sessions > 0 &&
              ` (${Math.round((data.analysed_sessions / data.finished_sessions) * 100)} %)`}
            {data.analyst && ` · ${analystCost(data.analyst)}`}
            {data.analyst?.mode === 'sample' &&
              data.analyst.daily_cap !== null &&
              ` · sampling: ${data.analyst.daily_cap} a day`}
            {data.wasted_minutes_reported > 0 &&
              ` · about ${formatMinutes(data.wasted_minutes_reported)} lost in those ${data.analysed_sessions}, by their estimate`}
            . Written by a model: check them against the numbers above.
          </p>
          {data.sample_note && <p className="ins-note">{data.sample_note}</p>}
          {data.note && <p className="ins-note">{data.note}</p>}
          {grouped.length === 0 && !data.note && (
            <p className="muted">No frictions reported in this window.</p>
          )}
          {grouped.map(([category, list]) => (
            <section
              key={category}
              className="ins-friction-group"
              aria-label={categoryLabel(category)}
            >
              <h4>{categoryLabel(category)}</h4>
              <ul>
                {list.map((f) => (
                  <li key={`${f.category}:${f.state ?? ''}`}>
                    <span className="ins-friction-where">
                      {f.state ? <code>{f.state}</code> : 'Any state'} · {f.sessions}{' '}
                      {f.sessions === 1 ? 'session' : 'sessions'}
                      {f.max_severity >= 3 ? ' · blocked work' : ''}
                    </span>
                    <span>{f.top_suggestion}</span>
                    {f.ticket_ids.length > 0 && (
                      <span className="ins-examples">
                        {f.ticket_ids.map((id) => (
                          <TicketButton key={id} id={id} link={link} />
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {data.more_frictions > 0 && <p className="muted">And {data.more_frictions} more.</p>}
        </>
      )}
    </section>
  );
}
