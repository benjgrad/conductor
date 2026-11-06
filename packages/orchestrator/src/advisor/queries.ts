import {
  checkIdentity,
  defKey,
  inputClass,
  MoveCauseSchema,
  offeredPresets,
  pageLimitsOf,
  pagesOfContext,
  repoChecksKey,
  RepoChecksSchema,
  stateKey,
  waitsOnOthers,
  WorkflowDefinitionSchema,
  type AdvisorDefs,
  type AdvisorRows,
  type CheckRunRow,
  type InputRow,
  type JsonObject,
  type MoveCause,
  type MoveRow,
  type PageCountRow,
  type PermissionRow,
  type PresetTextRow,
  type RepoChecks,
  type WorkflowDefinition,
} from '@conductor/shared';
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

/** A check run and the workflow version of the session that ran it (to name it). */
export type LoadedCheckRun = CheckRunRow & { workflow_id: string; workflow_version: number | null };

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
): Promise<{ rows: LoadedCheckRun[]; since: string; truncated: boolean }> {
  const { since, args } = windowArgs(f, limit);
  const checks = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    machine_id: string | null;
    workflow_id: string;
    workflow_version: number | null;
    state: string | null;
    cmd: string | null;
    exit_code: number | null;
    timed_out: boolean;
    setup_failed: boolean;
    started_at: Date;
    ts: Date;
  }>(
    'SELECT e.session_id, s.ticket_id, t.repo, s.machine_id, s.workflow_id, s.workflow_version, ' +
      // The outbox holds the protocol payload (`workflow_state`); `state` is the effect's own key.
      "COALESCE(o.payload->>'workflow_state', o.payload->>'state') AS state, " +
      "o.payload->>'cmd' AS cmd, " +
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

  const rows = checks.rows.map((r): LoadedCheckRun => ({
    session_id: r.session_id,
    ticket_id: r.ticket_id,
    repo: r.repo,
    machine_id: r.machine_id,
    workflow_id: r.workflow_id,
    workflow_version: r.workflow_version,
    state: r.state === null ? 'unknown' : stateKey(r.state),
    cmd: r.cmd ?? '(unknown)',
    exit_code: r.exit_code,
    timed_out: r.timed_out,
    setup_failed: r.setup_failed,
    started_at: r.started_at.toISOString(),
    at: r.ts.toISOString(),
  }));
  return { rows, since: since.toISOString(), truncated: checks.rows.length >= limit };
}

/** A stored ADR-0037 cause; absent (a row before it) or unknown → null. */
function causeOf(raw: string | null): MoveCause | null {
  const p = MoveCauseSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export async function loadAdvisorRows(db: Queryable, f: AdvisorFilter): Promise<LoadedRows> {
  const { since, args } = windowArgs(f, ROW_LIMIT);

  const moves = await db.query<{
    session_id: string;
    ticket_id: string;
    repo: string;
    workflow_id: string;
    workflow_version: number | null;
    machine_id: string | null;
    from: string | null;
    to: string;
    transition: string | null;
    actor: string | null;
    cause: string | null;
    visit: number;
    ts: Date;
  }>(
    'SELECT e.session_id, s.ticket_id, t.repo, s.workflow_id, s.workflow_version, s.machine_id, ' +
      `e.payload->>'from' AS "from", e.payload->>'to' AS "to", ` +
      "e.payload->>'transition' AS transition, e.payload->>'actor' AS actor, " +
      "e.payload->>'cause' AS cause, " +
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
    workflow_id: string;
    workflow_version: number | null;
    state: string | null;
    kind: string;
    created_at: Date;
    answered_at: Date | null;
    transition: string | null;
    origin_from: string | null;
    origin_cause: string | null;
    answer: string | null;
    answered_by: string | null;
  }>(
    'SELECT i.session_id, s.ticket_id, t.repo, s.machine_id, s.workflow_id, s.workflow_version, ' +
      'i.return_to AS state, i.kind::text AS kind, i.created_at, i.answered_at, ' +
      'i.answer, i.answered_by, ' +
      "se.payload->>'transition' AS transition, se.payload->>'from' AS origin_from, " +
      "se.payload->>'cause' AS origin_cause " +
      `${SCOPE.replace(
        'FROM session s',
        'FROM input_request i JOIN session s ON s.id = i.session_id ' +
          // The move that opened it: the session's newest state.entered up to its creation (the
          // engine writes both in one transaction; the margin covers the two clocks), as
          // engine/rows.ts OPEN_INPUT_SELECT does for an open request.
          'LEFT JOIN LATERAL (SELECT e.payload FROM event e WHERE e.session_id = i.session_id ' +
          "AND e.type = 'state.entered' AND e.ts <= i.created_at + interval '5 seconds' " +
          'ORDER BY e.id DESC LIMIT 1) se ON true',
      )} ` +
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

  const pairs = new Map<string, { id: string; version: number }>();
  for (const r of [...moves.rows, ...checks.rows, ...inputs.rows]) {
    if (r.workflow_version !== null) {
      pairs.set(defKey(r.workflow_id, r.workflow_version), {
        id: r.workflow_id,
        version: r.workflow_version,
      });
    }
  }
  const [defs, repoChecks] = await Promise.all([
    loadDefinitions(db, [...pairs.values()]),
    loadRepoChecks(db, f.accountId),
  ]);
  const defOf = (id: string, version: number | null) =>
    version === null ? undefined : defs.get(defKey(id, version));

  const moveRows = moves.rows.map((r): MoveRow => ({
    session_id: r.session_id,
    ticket_id: r.ticket_id,
    repo: r.repo,
    workflow_id: r.workflow_id,
    workflow_version: r.workflow_version,
    machine_id: r.machine_id,
    from: r.from,
    to: r.to,
    transition: r.transition,
    actor: r.actor,
    cause: causeOf(r.cause),
    visit: r.visit,
    at: r.ts.toISOString(),
  }));
  const checkRows = checks.rows.map((r): CheckRunRow => ({
    ...r,
    ...checkIdentity({
      cmd: r.cmd,
      setup_failed: r.setup_failed,
      gateKey: r.state,
      def: defOf(r.workflow_id, r.workflow_version),
      repoChecks: repoChecks.get(repoChecksKey(r.repo)),
    }),
  }));

  const pages = await loadPageCounts(db, moveRows, defOf);

  const inputRows = inputs.rows.map((r) => ({
    raw: r,
    row: {
      session_id: r.session_id,
      ticket_id: r.ticket_id,
      repo: r.repo,
      machine_id: r.machine_id,
      state: r.state,
      kind: r.kind,
      created_at: r.created_at.toISOString(),
      answered_at: iso(r.answered_at),
      transition: r.transition,
      class: inputClass(
        {
          kind: r.kind,
          transition: r.transition,
          from: r.origin_from ?? r.state,
          cause: causeOf(r.origin_cause),
        },
        defOf(r.workflow_id, r.workflow_version),
      ),
    } satisfies InputRow,
  }));
  // ADR-0037 P5: a person's answer to a hand-off (the review: Request changes on the board posts
  // the transition, which answers the request with its text; the panel's composer answers it
  // directly), where the pinned definition offers saved replies.
  const presetTexts: PresetTextRow[] = [];
  for (const { raw, row } of inputRows) {
    if (row.class !== 'handoff' || raw.answer === null || raw.answered_by === null) continue;
    const def = defOf(raw.workflow_id, raw.workflow_version);
    const presets = def === undefined ? [] : offeredPresets(def);
    if (presets.length === 0) continue;
    presetTexts.push({
      session_id: raw.session_id,
      ticket_id: raw.ticket_id,
      workflow_id: raw.workflow_id,
      source: 'answer',
      transition: null,
      text: raw.answer,
      presets,
    });
  }

  return {
    since: since.toISOString(),
    truncated,
    ...(pages.length > 0 ? { pages } : {}),
    ...(presetTexts.length > 0 ? { preset_texts: presetTexts } : {}),
    moves: moveRows,
    checks: checkRows,
    inputs: inputRows.map((r) => r.row),
    waits: waitsOf(
      [...defs.values()],
      [...moveRows.map((m) => stateKey(m.to)), ...checkRows.map((c) => c.state)],
    ),
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

/**
 * ADR-0038 (Insights FR-6): the pages each agent state of the window's sessions attached, read
 * from the session's context with its pinned definition's limits, as the card reads them.
 */
async function loadPageCounts(
  db: Queryable,
  moves: readonly MoveRow[],
  defOf: (id: string, version: number | null) => WorkflowDefinition | undefined,
): Promise<PageCountRow[]> {
  const ids = [...new Set(moves.map((m) => m.session_id))];
  if (ids.length === 0) return [];
  const r = await db.query<{
    id: string;
    ticket_id: string;
    workflow_id: string;
    workflow_version: number | null;
    context: Record<string, JsonObject>;
  }>(
    'SELECT id, ticket_id, workflow_id, workflow_version, context FROM session ' +
      'WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const out: PageCountRow[] = [];
  for (const s of r.rows) {
    const def = defOf(s.workflow_id, s.workflow_version);
    if (def === undefined) continue;
    const perState = new Map<string, number>();
    for (const p of pagesOfContext(s.context, pageLimitsOf(def))) {
      perState.set(p.state, (perState.get(p.state) ?? 0) + 1);
    }
    for (const [state, count] of perState) {
      out.push({ ticket_id: s.ticket_id, session_id: s.id, state, count });
    }
  }
  return out;
}

/** `waitsOnOthers` for every key seen (`AdvisorRows.waits`). */
function waitsOf(
  defs: readonly WorkflowDefinition[],
  keys: readonly string[],
): NonNullable<AdvisorRows['waits']> {
  const out: NonNullable<AdvisorRows['waits']> = {};
  for (const key of new Set(keys)) {
    const w = waitsOnOthers(defs, key);
    if (w !== null) out[key] = w;
  }
  return out;
}

/** The workflow definitions of these (id, version) pairs; one that no longer parses is left out. */
export async function loadDefinitions(
  db: Queryable,
  pairs: readonly { id: string; version: number }[],
): Promise<AdvisorDefs> {
  const out = new Map<string, WorkflowDefinition>();
  if (pairs.length === 0) return out;
  const r = await db.query<{ id: string; version: number; definition: unknown }>(
    'SELECT d.id, d.version, d.definition FROM workflow_definition d ' +
      'JOIN unnest($1::text[], $2::int[]) AS p(id, version) ' +
      'ON p.id = d.id AND p.version = d.version',
    [pairs.map((p) => p.id), pairs.map((p) => p.version)],
  );
  for (const row of r.rows) {
    const parsed = WorkflowDefinitionSchema.safeParse(row.definition);
    if (parsed.success) out.set(defKey(row.id, row.version), parsed.data);
  }
  return out;
}

/**
 * The account's repo check overrides by `repoChecksKey`, as they are now (TD-201: a run is named
 * from the current config, so a check renamed since shows its new name).
 */
export async function loadRepoChecks(
  db: Queryable,
  accountId: string,
): Promise<Map<string, RepoChecks>> {
  const r = await db.query<{ repo: string; config: unknown }>(
    'SELECT repo, config FROM repo_checks WHERE account_id = $1',
    [accountId],
  );
  const out = new Map<string, RepoChecks>();
  for (const row of r.rows) {
    const parsed = RepoChecksSchema.safeParse(row.config);
    if (parsed.success) out.set(repoChecksKey(row.repo), parsed.data);
  }
  return out;
}
