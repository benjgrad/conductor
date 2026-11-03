import {
  CreateScheduleRequestSchema,
  ROUTINE_WORKFLOW_ID,
  SCHEDULE_PREVIEW_RUNS,
  UpdateScheduleRequestSchema,
  UuidSchema,
  canonicalRepo,
  nextRunAfter,
  nextRuns,
  validateSchedule,
  type AccountScope,
  type ApiErrorCode,
  type BoardSseEvent,
  type ScheduleDto,
  type ScheduleListResponse,
  type ScheduleWarning,
  type TicketStatus,
} from '@conductor/shared';
import type { AuthConfig } from '../auth/config.js';
import { accountHasRepo } from '../api/tickets.js';
import { pathString, type ErrorDetail } from '../api/errors.js';
import type { BoardBus, Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { TicketScheduleRow } from '../db/types.js';
import { seedRoutineWorkflow } from '../engine/seed.js';
import type { Db } from '../main.js';
import { fireSchedule } from './fire.js';

// ADR-0032: recurring tickets. One set of functions behind both the REST routes (/api/schedules)
// and the MCP tools (list_schedules, save_schedule, delete_schedule, run_schedule_now), always
// scoped to the caller's account. The sweep (sweep.ts) fires due runs.

export interface ScheduleDeps {
  db: Db;
  boardBus: BoardBus;
  auth: AuthConfig;
  now?: () => Date;
}

export type ScheduleFailure = {
  ok: false;
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: ErrorDetail[];
};

export type ScheduleResult<T> = ({ ok: true } & T) | ScheduleFailure;

const fail = (
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: ErrorDetail[],
): ScheduleFailure => ({ ok: false, status, code, message, ...(details ? { details } : {}) });

const badRequest = (path: string, message: string) =>
  fail(400, 'bad_request', message, [{ path, message }]);

const notFound = (id: string) => fail(404, 'not_found', `no schedule ${id}`);

type ScheduleListRow = TicketScheduleRow & { last_ticket_status: TicketStatus | null };

const SELECT =
  'SELECT s.*, t.status AS last_ticket_status FROM ticket_schedule s ' +
  'LEFT JOIN ticket t ON t.id = s.last_ticket_id ';

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function previewRuns(row: TicketScheduleRow, now: Date): string[] {
  if (!row.enabled) return [];
  try {
    return nextRuns(row.cron, row.timezone, now, SCHEDULE_PREVIEW_RUNS).map((d) => d.toISOString());
  } catch {
    return [];
  }
}

export function toScheduleDto(
  row: ScheduleListRow,
  now: Date,
  warnings: ScheduleWarning[] = [],
): ScheduleDto {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    title: row.title,
    body: row.body,
    repo: row.repo,
    workflow_id: row.workflow_id,
    kind: row.kind,
    priority: row.priority,
    required_tags: row.required_tags,
    machine_ids: row.machine_ids,
    next_run_at: iso(row.next_run_at),
    next_runs: previewRuns(row, now),
    last_run_at: iso(row.last_run_at),
    last_ticket:
      row.last_ticket_id !== null && row.last_ticket_status !== null
        ? { id: row.last_ticket_id, status: row.last_ticket_status }
        : null,
    last_skipped_at: iso(row.last_skipped_at),
    last_skip_reason:
      row.last_skip_reason === 'previous_run_open' || row.last_skip_reason === 'invalid_schedule'
        ? row.last_skip_reason
        : null,
    ...(warnings.length > 0 ? { warnings } : {}),
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

interface MachineRef {
  id: string;
  name: string | null;
  hostname: string;
}

async function accountMachines(q: Queryable, accountId: string): Promise<MachineRef[]> {
  const r = await q.query<MachineRef>(
    'SELECT id, name, hostname FROM machine WHERE account_id = $1 AND revoked_at IS NULL ' +
      'ORDER BY id',
    [accountId],
  );
  return r.rows;
}

/**
 * Machine ids or names (name or hostname, case-insensitive) → the account's unrevoked machine ids.
 * null / [] = any machine.
 */
async function resolveMachines(
  q: Queryable,
  accountId: string,
  refs: readonly string[] | null,
): Promise<{ ok: true; ids: string[] | null } | ScheduleFailure> {
  if (refs === null || refs.length === 0) return { ok: true, ids: null };
  const machines = await accountMachines(q, accountId);
  const ids: string[] = [];
  for (const ref of refs) {
    const lower = ref.toLowerCase();
    const byId = machines.find((m) => m.id === ref);
    const byName = machines.filter(
      (m) => m.name?.toLowerCase() === lower || m.hostname.toLowerCase() === lower,
    );
    const hit = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (hit === undefined) {
      return badRequest(
        'machines',
        byName.length > 1
          ? `more than one machine is called ${ref}: use its id`
          : `unknown machine ${ref} (an id, name or hostname of one of your machines)`,
      );
    }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ok: true, ids };
}

/** Why the schedule's runs may never be claimed (it is saved anyway). */
async function warningsOf(
  q: Queryable,
  row: Pick<TicketScheduleRow, 'account_id' | 'repo' | 'machine_ids'>,
): Promise<ScheduleWarning[]> {
  const out: ScheduleWarning[] = [];
  if (!(await accountHasRepo(q, row.account_id, row.repo))) out.push('no_machine_has_repo');
  if (row.machine_ids !== null) {
    const live = new Set((await accountMachines(q, row.account_id)).map((m) => m.id));
    const pinned = row.machine_ids.filter((id) => live.has(id));
    if (pinned.length < row.machine_ids.length) out.push('pinned_machine_revoked');
    if (!out.includes('no_machine_has_repo') && pinned.length > 0) {
      const has = await q.query<{ machine_id: string }>(
        'SELECT DISTINCT machine_id FROM machine_repo WHERE machine_id = ANY($1::text[]) ' +
          'AND (lower(remote) = lower($2) OR repo = $3)',
        [pinned, canonicalRepo(row.repo) ?? row.repo, row.repo],
      );
      if (has.rows.length < pinned.length) out.push('machine_lacks_repo');
    }
  }
  return out;
}

function repoFor(auth: AuthConfig, repo: string): { ok: true; repo: string } | ScheduleFailure {
  // As POST /api/tickets (M2-T17): canonical host/org/repo in `password` mode.
  if (auth.mode !== 'password') return { ok: true, repo };
  const canonical = canonicalRepo(repo);
  if (canonical === null) return badRequest('repo', 'repo must be host/org/repo');
  return { ok: true, repo: canonical };
}

async function workflowExists(q: Queryable, id: string): Promise<boolean> {
  if (id === ROUTINE_WORKFLOW_ID) await seedRoutineWorkflow(q);
  const r = await q.query('SELECT 1 FROM workflow_definition WHERE id = $1 LIMIT 1', [id]);
  return (r.rowCount ?? 0) > 0;
}

function checkRule(cron: string, timezone: string, now: Date): ScheduleFailure | null {
  const err = validateSchedule(cron, timezone, now);
  if (err === null) return null;
  return badRequest(err.code === 'invalid_timezone' ? 'timezone' : 'cron', err.message);
}

function zodFailure(issues: { path: PropertyKey[]; message: string }[]): ScheduleFailure {
  return fail(
    400,
    'bad_request',
    'invalid schedule',
    issues.map((i) => ({ path: pathString(i.path), message: i.message })),
  );
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';

const nameTaken = (name: string) =>
  fail(409, 'conflict', `a schedule named ${name} already exists`, [
    { path: 'name', message: 'already used by another schedule' },
  ]);

async function readOne(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<ScheduleListRow | null> {
  if (!UuidSchema.safeParse(id).success) return null;
  const r = await q.query<ScheduleListRow>(SELECT + 'WHERE s.id = $1 AND s.account_id = $2', [
    id,
    accountId,
  ]);
  return r.rows[0] ?? null;
}

export async function listSchedules(
  q: Queryable,
  accountId: string,
  now: Date = new Date(),
): Promise<ScheduleListResponse> {
  const r = await q.query<ScheduleListRow>(SELECT + 'WHERE s.account_id = $1 ORDER BY s.name', [
    accountId,
  ]);
  const schedules: ScheduleDto[] = [];
  for (const row of r.rows) schedules.push(toScheduleDto(row, now, await warningsOf(q, row)));
  return { schedules };
}

export async function getSchedule(
  q: Queryable,
  accountId: string,
  id: string,
  now: Date = new Date(),
): Promise<ScheduleDto | null> {
  const row = await readOne(q, accountId, id);
  return row === null ? null : toScheduleDto(row, now, await warningsOf(q, row));
}

export async function createSchedule(
  deps: ScheduleDeps,
  scope: AccountScope,
  input: unknown,
  by: string | null,
): Promise<ScheduleResult<{ dto: ScheduleDto }>> {
  const now = deps.now?.() ?? new Date();
  const parsed = CreateScheduleRequestSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error.issues);
  const body = parsed.data;
  const repo = repoFor(deps.auth, body.repo);
  if (!repo.ok) return repo;
  const rule = checkRule(body.cron, body.timezone, now);
  if (rule) return rule;
  if (!(await workflowExists(deps.db, body.workflow_id))) {
    return badRequest('workflow_id', `unknown workflow ${body.workflow_id}`);
  }
  const machines = await resolveMachines(deps.db, scope.account_id, body.machines);
  if (!machines.ok) return machines;
  try {
    const r = await deps.db.query<TicketScheduleRow>(
      'INSERT INTO ticket_schedule (account_id, name, cron, timezone, enabled, title, body, repo, ' +
        'workflow_id, kind, priority, required_tags, machine_ids, next_run_at, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *',
      [
        scope.account_id,
        body.name,
        body.cron,
        body.timezone,
        body.enabled,
        body.title,
        body.body,
        repo.repo,
        body.workflow_id,
        body.kind,
        body.priority,
        body.required_tags,
        machines.ids,
        body.enabled ? nextRunAfter(body.cron, body.timezone, now) : null,
        by,
      ],
    );
    const row = { ...r.rows[0]!, last_ticket_status: null };
    return { ok: true, dto: toScheduleDto(row, now, await warningsOf(deps.db, row)) };
  } catch (err) {
    if (isUniqueViolation(err)) return nameTaken(body.name);
    throw err;
  }
}

export async function updateSchedule(
  deps: ScheduleDeps,
  scope: AccountScope,
  id: string,
  input: unknown,
): Promise<ScheduleResult<{ dto: ScheduleDto }>> {
  const now = deps.now?.() ?? new Date();
  const parsed = UpdateScheduleRequestSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error.issues);
  const patch = parsed.data;
  if (!UuidSchema.safeParse(id).success) return notFound(id);
  let repo: string | undefined;
  if (patch.repo !== undefined) {
    const r = repoFor(deps.auth, patch.repo);
    if (!r.ok) return r;
    repo = r.repo;
  }
  if (patch.workflow_id !== undefined && !(await workflowExists(deps.db, patch.workflow_id))) {
    return badRequest('workflow_id', `unknown workflow ${patch.workflow_id}`);
  }
  let machineIds: string[] | null | undefined;
  if (patch.machines !== undefined) {
    const m = await resolveMachines(deps.db, scope.account_id, patch.machines);
    if (!m.ok) return m;
    machineIds = m.ids;
  }
  try {
    const res = await withTransaction(deps.db, async (tx) => {
      const cur = await tx.query<TicketScheduleRow>(
        'SELECT * FROM ticket_schedule WHERE id = $1 AND account_id = $2 FOR UPDATE',
        [id, scope.account_id],
      );
      const row = cur.rows[0];
      if (row === undefined) return notFound(id);
      if (
        patch.expected_updated_at !== undefined &&
        Date.parse(patch.expected_updated_at) !== row.updated_at.getTime()
      ) {
        return fail(409, 'conflict', 'the schedule changed since you read it: read it again');
      }
      const cron = patch.cron ?? row.cron;
      const timezone = patch.timezone ?? row.timezone;
      const enabled = patch.enabled ?? row.enabled;
      const ruleChanged = cron !== row.cron || timezone !== row.timezone;
      if (ruleChanged || (enabled && !row.enabled)) {
        const rule = checkRule(cron, timezone, now);
        if (rule) return rule;
      }
      // A new rule, or a resume, starts from now; otherwise the next run stays where it was.
      const nextRunAt = !enabled
        ? null
        : ruleChanged || !row.enabled || row.next_run_at === null
          ? nextRunAfter(cron, timezone, now)
          : row.next_run_at;
      const u = await tx.query<TicketScheduleRow>(
        'UPDATE ticket_schedule SET name = $2, cron = $3, timezone = $4, enabled = $5, ' +
          'title = $6, body = $7, repo = $8, workflow_id = $9, kind = $10, priority = $11, ' +
          'required_tags = $12, machine_ids = $13, next_run_at = $14, ' +
          // Strictly later than the read value, so `expected_updated_at` always sees an edit.
          "updated_at = greatest(now(), updated_at + interval '1 millisecond') " +
          'WHERE id = $1 RETURNING *',
        [
          id,
          patch.name ?? row.name,
          cron,
          timezone,
          enabled,
          patch.title ?? row.title,
          patch.body ?? row.body,
          repo ?? row.repo,
          patch.workflow_id ?? row.workflow_id,
          patch.kind ?? row.kind,
          patch.priority ?? row.priority,
          patch.required_tags ?? row.required_tags,
          machineIds === undefined ? row.machine_ids : machineIds,
          nextRunAt,
        ],
      );
      return { ok: true as const, row: u.rows[0]! };
    });
    if (!res.ok) return res;
    const full = (await readOne(deps.db, scope.account_id, id)) ?? {
      ...res.row,
      last_ticket_status: null,
    };
    return { ok: true, dto: toScheduleDto(full, now, await warningsOf(deps.db, full)) };
  } catch (err) {
    if (isUniqueViolation(err)) return nameTaken(patch.name ?? '');
    throw err;
  }
}

/** true = it existed (and is gone); its past tickets stay, unlinked. */
export async function deleteSchedule(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<boolean> {
  if (!UuidSchema.safeParse(id).success) return false;
  const r = await q.query('DELETE FROM ticket_schedule WHERE id = $1 AND account_id = $2', [
    id,
    accountId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Run the schedule now (a manual run): a ticket at once, `next_run_at` unchanged. Refused with
 * `previous_run_open` (409) while the last run's ticket is open, unless `force`.
 */
export async function runScheduleNow(
  deps: ScheduleDeps,
  scope: AccountScope,
  id: string,
  opts: { force?: boolean } = {},
): Promise<ScheduleResult<{ ticket_id: string; dto: ScheduleDto }>> {
  const now = deps.now?.() ?? new Date();
  if (!UuidSchema.safeParse(id).success) return notFound(id);
  const at = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const res = await withTransaction(
    deps.db,
    async (tx): Promise<ScheduleResult<{ ticket_id: string; events: BoardSseEvent[] }>> => {
      const cur = await tx.query<TicketScheduleRow>(
        'SELECT * FROM ticket_schedule WHERE id = $1 AND account_id = $2 FOR UPDATE',
        [id, scope.account_id],
      );
      const row = cur.rows[0];
      if (row === undefined) return notFound(id);
      if (row.workflow_id === ROUTINE_WORKFLOW_ID) await seedRoutineWorkflow(tx);
      const fired = await fireSchedule(tx, row, at, now, {
        manual: true,
        force: opts.force === true,
      });
      switch (fired.outcome.status) {
        case 'created':
          return { ok: true, ticket_id: fired.outcome.ticket.id, events: fired.events };
        case 'refused':
          return fail(
            409,
            'previous_run_open',
            'the last run of this schedule is still open; finish it first, or pass force',
          );
        default:
          return fail(409, 'conflict', 'this schedule already ran this second: try again');
      }
    },
  );
  if (!res.ok) return res;
  for (const ev of res.events) deps.boardBus.publish(ev);
  const dto = await getSchedule(deps.db, scope.account_id, id, now);
  return { ok: true, ticket_id: res.ticket_id, dto: dto! };
}
