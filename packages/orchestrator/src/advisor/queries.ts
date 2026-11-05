import type { AdvisorRows, CheckRunRow, InputRow, MoveRow, PermissionRow } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0033 (workflow advisor, P1): the rows the process metrics read, for one account and a
// window of days. Every query is scoped through `session.account_id`: `event`, `input_request` and
// `outbox` rows written by the engine carry the TD-109 default account, not the session's, so
// their own `account_id` can't be trusted for isolation.

export const WINDOW_DEFAULT_DAYS = 30;
export const WINDOW_MAX_DAYS = 180;
/** Newest rows kept per kind; a window past it is reported in `truncated`. */
export const ROW_LIMIT = 20_000;

/** `days` as a whole number of days in 1..WINDOW_MAX_DAYS (default WINDOW_DEFAULT_DAYS). */
export function clampWindow(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return WINDOW_DEFAULT_DAYS;
  return Math.min(WINDOW_MAX_DAYS, Math.max(1, Math.round(days)));
}

export interface AdvisorFilter {
  accountId: string;
  windowDays: number;
  /** host/org/repo; matched case-insensitively. */
  repo?: string | undefined;
  workflowId?: string | undefined;
  /** P2: one session only (the analyst job's digest). */
  sessionId?: string | undefined;
  now?: Date;
  /**
   * P3 (the change-proposal review): the window ends here instead of now: `[until - windowDays, until)`. A
   * window into the past (the time before a change was applied).
   */
  until?: Date | undefined;
}

export interface LoadedRows extends AdvisorRows {
  since: string;
  /** The row kinds that hit ROW_LIMIT (only their newest rows were read). */
  truncated: ('moves' | 'checks' | 'inputs' | 'permissions')[];
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * The session and ticket filter every query shares: $1 account, $2 since, $3 repo, $4 workflow,
 * $6 session ($5 is the row limit); $7 the window's end (null = now), checked by each query.
 */
const SCOPE =
  'FROM session s JOIN ticket t ON t.id = s.ticket_id ' +
  'WHERE s.account_id = $1 AND ($3::text IS NULL OR lower(t.repo) = lower($3)) ' +
  'AND ($4::text IS NULL OR s.workflow_id = $4) AND ($6::uuid IS NULL OR s.id = $6)';

function windowArgs(f: AdvisorFilter, limit: number) {
  const now = f.until ?? f.now ?? new Date();
  const until = f.until ?? null;
  const since = new Date(now.getTime() - clampWindow(f.windowDays) * 86_400_000);
  return {
    since,
    args: [
      f.accountId,
      since,
      f.repo ?? null,
      f.workflowId ?? null,
      limit,
      f.sessionId ?? null,
      until,
    ],
  };
}

/**
 * The finished checks (a `run_cmd` and its `command.exited`) in the window, newest first, at most
 * `limit`. `get_process_metrics group_by=check` and the Repo checks run history (UXR-80) read these.
 */
export async function loadCheckRuns(
  db: Queryable,
  f: AdvisorFilter,
  limit: number = ROW_LIMIT,
): Promise<{ rows: CheckRunRow[]; since: string; truncated: boolean }> {
  const { since, args } = windowArgs(f, limit);
  const checks = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    machine_id: string | null;
    state: string | null;
    cmd: string | null;
    exit_code: number | null;
    timed_out: boolean;
    setup_failed: boolean;
    started_at: Date;
    ts: Date;
  }>(
    'SELECT e.session_id, s.ticket_id, t.repo, s.machine_id, ' +
      "o.payload->>'state' AS state, o.payload->>'cmd' AS cmd, " +
      "(e.payload->>'exit_code')::int AS exit_code, " +
      "COALESCE((e.payload->>'timed_out')::boolean, false) AS timed_out, " +
      "COALESCE((e.payload->>'setup_failed')::boolean, false) AS setup_failed, " +
      'o.created_at AS started_at, e.ts ' +
      `${SCOPE.replace(
        'FROM session s',
        'FROM event e ' +
          "JOIN outbox o ON o.command_id::text = e.payload->>'command_id' AND o.kind = 'run_cmd' " +
          'JOIN session s ON s.id = e.session_id',
      )} ` +
      "AND e.type = 'command.exited' AND e.ts >= $2 " +
      'AND ($7::timestamptz IS NULL OR e.ts < $7) ' +
      'ORDER BY e.id DESC LIMIT $5',
    args,
  );

  const rows = checks.rows.map((r): CheckRunRow => ({
    session_id: r.session_id,
    ticket_id: r.ticket_id,
    repo: r.repo,
    machine_id: r.machine_id,
    state: r.state ?? 'unknown',
    cmd: r.cmd ?? '(unknown)',
    exit_code: r.exit_code,
    timed_out: r.timed_out,
    setup_failed: r.setup_failed,
    started_at: r.started_at.toISOString(),
    at: r.ts.toISOString(),
  }));
  return { rows, since: since.toISOString(), truncated: checks.rows.length >= limit };
}

export async function loadAdvisorRows(db: Queryable, f: AdvisorFilter): Promise<LoadedRows> {
  const { since, args } = windowArgs(f, ROW_LIMIT);

  const moves = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    workflow_id: string;
    machine_id: string | null;
    from: string | null;
    to: string;
    transition: string | null;
    visit: number;
    ts: Date;
  }>(
    'SELECT e.session_id, s.ticket_id, t.repo, s.workflow_id, s.machine_id, ' +
      `e.payload->>'from' AS "from", e.payload->>'to' AS "to", ` +
      "e.payload->>'transition' AS transition, " +
      "COALESCE((e.payload->>'visit')::int, 1) AS visit, e.ts " +
      `${SCOPE.replace('FROM session s', 'FROM event e JOIN session s ON s.id = e.session_id')} ` +
      "AND e.type = 'state.entered' AND e.ts >= $2 AND e.payload ? 'to' " +
      'AND ($7::timestamptz IS NULL OR e.ts < $7) ' +
      'ORDER BY e.id DESC LIMIT $5',
    args,
  );

  const checks = await loadCheckRuns(db, f);

  const inputs = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    machine_id: string | null;
    state: string | null;
    kind: string;
    created_at: Date;
    answered_at: Date | null;
  }>(
    'SELECT i.session_id, s.ticket_id, t.repo, s.machine_id, i.return_to AS state, ' +
      'i.kind::text AS kind, i.created_at, i.answered_at ' +
      `${SCOPE.replace('FROM session s', 'FROM input_request i JOIN session s ON s.id = i.session_id')} ` +
      'AND i.created_at >= $2 AND ($7::timestamptz IS NULL OR i.created_at < $7) ORDER BY i.created_at DESC LIMIT $5',
    args,
  );

  const perms = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    machine_id: string;
    tool: string;
    always_rule: string | null;
    status: PermissionRow['status'];
    scope: PermissionRow['scope'];
    created_at: Date;
  }>(
    'SELECT p.session_id, s.ticket_id, t.repo, p.machine_id, p.tool, p.always_rule, p.status, ' +
      'p.scope, p.created_at ' +
      `${SCOPE.replace('FROM session s', 'FROM permission_request p JOIN session s ON s.id = p.session_id')} ` +
      'AND p.created_at >= $2 AND ($7::timestamptz IS NULL OR p.created_at < $7) ORDER BY p.created_at DESC LIMIT $5',
    args,
  );

  const truncated: LoadedRows['truncated'] = [];
  if (moves.rows.length >= ROW_LIMIT) truncated.push('moves');
  if (checks.truncated) truncated.push('checks');
  if (inputs.rows.length >= ROW_LIMIT) truncated.push('inputs');
  if (perms.rows.length >= ROW_LIMIT) truncated.push('permissions');

  return {
    since: since.toISOString(),
    truncated,
    moves: moves.rows.map((r): MoveRow => ({
      session_id: r.session_id,
      ticket_id: r.ticket_id,
      repo: r.repo,
      workflow_id: r.workflow_id,
      machine_id: r.machine_id,
      from: r.from,
      to: r.to,
      transition: r.transition,
      visit: r.visit,
      at: r.ts.toISOString(),
    })),
    checks: checks.rows,
    inputs: inputs.rows.map((r): InputRow => ({
      session_id: r.session_id,
      ticket_id: r.ticket_id,
      repo: r.repo,
      machine_id: r.machine_id,
      state: r.state,
      kind: r.kind,
      created_at: r.created_at.toISOString(),
      answered_at: iso(r.answered_at),
    })),
    permissions: perms.rows.map((r): PermissionRow => ({
      session_id: r.session_id,
      ticket_id: r.ticket_id,
      repo: r.repo,
      machine_id: r.machine_id,
      tool: r.tool,
      always_rule: r.always_rule,
      status: r.status,
      scope: r.scope,
      created_at: r.created_at.toISOString(),
    })),
  };
}
