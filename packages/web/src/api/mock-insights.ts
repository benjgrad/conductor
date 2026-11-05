import {
  frictionReport,
  insightFindings,
  processMetrics,
  rankFindings,
  type AdvisorGroupBy,
  type AdvisorRows,
  type ChangeProposalDetail,
  type FindingsResponse,
  type ProcessMetricsResponse,
  type ProcessReportResponse,
  type SessionInsightResponse,
  type StoredInsight,
} from '@conductor/shared';
import { SEED_IDS } from './mock-data.js';

// UXR-84: the workflow advisor's data in the mock. A deterministic history over 90 days, computed
// with the same pure functions the orchestrator uses (processMetrics, rankFindings, frictionReport),
// so every window and grouping is consistent. It produces each kind of finding: a slow `qa`, a
// build that always fails in github.com/acme/api (cited by an open mock change proposal), a
// planning state that keeps asking, a denied tool on linux-box and a QA loop; and recurring
// analyst frictions. The done seed ("Rename user.fullname") has a session insight.

const DAY = 86_400_000;
const MIN = 60_000;
const FINDINGS_PAGE = 8;

const TICKETS = [
  SEED_IDS.done.ticket,
  SEED_IDS.failed.ticket,
  SEED_IDS.running.ticket,
  SEED_IDS.askNewer.ticket,
  SEED_IDS.askOlder.ticket,
  SEED_IDS.approval.ticket,
  SEED_IDS.review.ticket,
  SEED_IDS.stepFailed.ticket,
];
const REPOS = ['github.com/acme/api', 'github.com/acme/shop'];
const MACHINES = ['mbp-ben', 'linux-box'];

interface Stamped {
  rows: AdvisorRows;
  insights: (StoredInsight & { at: string })[];
  /** Per session: when it finished (for the report's coverage). */
  finished: { session_id: string; at: string }[];
}

const sessionId = (i: number) => `e6000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const FRICTION_DONE = {
  category: 'failing_check' as const,
  state: 'build',
  evidence: '`npm run build` exited 1: no package.json at the repo root.',
  severity: 2,
  suggestion: 'Give github.com/acme/api its own build check that runs inside m-one.',
};

/** The done seed's insight (the Details tab of "Rename user.fullname"). */
function doneInsight(now: Date): SessionInsightResponse {
  return {
    session_id: SEED_IDS.done.session,
    ticket_id: SEED_IDS.done.ticket,
    created_at: new Date(now.getTime() - 480 * MIN).toISOString(),
    model: 'haiku',
    model_written: true,
    schema_version: 1,
    summary:
      'Renamed the field across the API and the web app. The build check failed once on a ' +
      'missing env var; the agent asked which migration style to use before writing it.',
    outcome: 'completed',
    frictions: [
      {
        category: 'environment',
        state: 'build',
        evidence: 'DATABASE_URL was not set for the build step.',
        severity: 2,
        suggestion: 'Set DATABASE_URL in the repo checks’ setup.',
      },
      {
        category: 'unclear_requirements',
        state: 'implement',
        evidence: 'Asked whether to keep the old column for one release.',
        severity: 1,
        suggestion: 'Say in the ticket template whether renames keep a compatibility column.',
      },
    ],
    wasted_minutes: 12,
  };
}

function history(now: Date): Stamped {
  const rows: AdvisorRows = { moves: [], checks: [], inputs: [], permissions: [] };
  const insights: Stamped['insights'] = [];
  const finished: Stamped['finished'] = [];
  const at = (t: number) => new Date(t).toISOString();
  for (let i = 0; i < 26; i++) {
    const start = now.getTime() - (1 + i * 3.4) * DAY;
    const session_id = sessionId(i);
    const ticket_id = TICKETS[i % TICKETS.length]!;
    const repo = REPOS[i % 2]!;
    const machine_id = MACHINES[i % 3 === 0 ? 1 : 0]!;
    const base = { session_id, ticket_id, repo, workflow_id: 'conductor', machine_id };
    let t = start;
    let visitImpl = 0;
    const move = (from: string | null, to: string, transition: string | null, mins: number) => {
      if (to === 'implementing') visitImpl++;
      rows.moves.push({
        ...base,
        from,
        to,
        transition,
        visit: to === 'implementing' ? visitImpl : 1,
        at: at(t),
      });
      t += mins * MIN;
    };
    move(null, 'planning', null, 15 + (i % 4) * 6);
    move('planning', 'implementing', 'plan_ready', 35 + (i % 5) * 9);
    // Every fifth ticket fails QA twice and goes round again.
    const loops = i % 5 === 2 ? 2 : 0;
    for (let k = 0; k < loops; k++) {
      move('implementing', 'qa', 'ready_for_testing', 25);
      move('qa', 'implementing', 'qa_fail', 30);
    }
    move('implementing', 'qa', 'ready_for_testing', 240 + (i % 3) * 90);
    move('qa', 'done', 'qa_pass', 0);
    finished.push({ session_id, at: at(t) });

    // The checks: api's build always fails; shop's tests fail one run in four.
    const cmd = repo === REPOS[0] ? 'npm run build' : 'pnpm test';
    const runAt = start + 50 * MIN;
    rows.checks.push({
      ...base,
      state: 'implementing',
      cmd,
      exit_code: cmd === 'npm run build' || i % 4 === 1 ? 1 : 0,
      timed_out: false,
      setup_failed: false,
      started_at: at(runAt),
      at: at(runAt + (cmd === 'pnpm test' ? 6 : 2) * MIN),
    });
    // Planning asks a human in two tickets of five.
    if (i % 5 < 2) {
      rows.inputs.push({
        ...base,
        state: 'planning',
        kind: 'agent_question',
        created_at: at(start + 5 * MIN),
        answered_at: at(start + (5 + 20 + (i % 3) * 25) * MIN),
      });
    }
    // linux-box keeps being refused `docker compose up`.
    if (machine_id === 'linux-box') {
      rows.permissions.push({
        ...base,
        machine_id,
        tool: 'Bash',
        always_rule: 'Bash(docker compose up:*)',
        status: i % 2 === 0 ? 'denied' : 'expired',
        scope: null,
        created_at: at(start + 70 * MIN),
      });
    }
    // The analysts' insights: a failing build recurs in api; QA waits in shop.
    if (i < 14) {
      insights.push({
        session_id,
        ticket_id,
        at: at(t + 10 * MIN),
        insight: {
          schema_version: 1,
          summary: `Session ${i + 1}: shipped after ${loops > 0 ? 'two QA rounds' : 'one pass'}.`,
          outcome: i % 7 === 6 ? 'blocked' : 'completed',
          frictions:
            repo === REPOS[0]
              ? [FRICTION_DONE]
              : [
                  {
                    category: 'waiting_on_human',
                    state: 'qa',
                    evidence: 'The ticket sat in QA for hours before anyone looked.',
                    severity: 2,
                    suggestion: 'Notify the reviewer when a ticket enters QA.',
                  },
                ],
          wasted_minutes: 5 + (i % 4) * 5,
        },
      });
    }
  }
  return { rows, insights, finished };
}

function windowed(h: Stamped, now: Date, days: number) {
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const inside = <T extends { at?: string; created_at?: string; started_at?: string }>(list: T[]) =>
    list.filter((r) => (r.at ?? r.created_at ?? r.started_at ?? '') >= since);
  return {
    since,
    rows: {
      moves: inside(h.rows.moves),
      checks: inside(h.rows.checks),
      inputs: inside(h.rows.inputs),
      permissions: inside(h.rows.permissions),
    },
    insights: inside(h.insights),
    finished: inside(h.finished),
  };
}

const clampWindow = (d: number) => Math.min(180, Math.max(1, Math.round(d)));

export interface MockInsights {
  metrics(windowDays: number, groupBy: AdvisorGroupBy): ProcessMetricsResponse;
  findings(windowDays: number, cursor: number): FindingsResponse;
  report(windowDays: number): ProcessReportResponse;
  /** null = no insight for that session (the API's 404). */
  insight(sessionId: string): SessionInsightResponse | null;
}

export function mockInsights(now: Date, proposals: () => ChangeProposalDetail[]): MockInsights {
  const h = history(now);
  const done = doneInsight(now);
  return {
    metrics(windowDays, groupBy) {
      const days = clampWindow(windowDays);
      const w = windowed(h, now, days);
      return { window_days: days, since: w.since, ...processMetrics(w.rows, groupBy) };
    },
    findings(windowDays, cursor) {
      const days = clampWindow(windowDays);
      const w = windowed(h, now, days);
      const all = rankFindings(w.rows, insightFindings(w.insights));
      const start = Math.min(cursor, all.length);
      const end = start + FINDINGS_PAGE;
      const cited = (id: string) => {
        const p = proposals()
          .filter((x) => x.evidence.some((e) => e.finding_id === id))
          .sort(
            (a, b) =>
              Number(b.status === 'proposed') - Number(a.status === 'proposed') ||
              b.created_at.localeCompare(a.created_at),
          )[0];
        return p ? { id: p.id, status: p.status, title: p.title } : null;
      };
      return {
        window_days: days,
        since: w.since,
        findings: all.slice(start, end).map((f) => ({ ...f, proposal: cited(f.id) })),
        next_cursor: end < all.length ? end : null,
        total: all.length,
      };
    },
    report(windowDays) {
      const days = clampWindow(windowDays);
      const w = windowed(h, now, days);
      const analysed = new Set(w.insights.map((i) => i.session_id));
      return {
        window_days: days,
        since: w.since,
        insights_enabled: true,
        finished_sessions: w.finished.length,
        analysed_sessions: w.finished.filter((f) => analysed.has(f.session_id)).length,
        totals: processMetrics(w.rows, 'state').totals,
        ...frictionReport(w.insights),
      };
    },
    insight: (id) => (id === done.session_id ? done : null),
  };
}
