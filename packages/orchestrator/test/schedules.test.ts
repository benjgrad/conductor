// ADR-0032: recurring tickets. The store and the sweep are mostly SQL (account scoping, the
// FOR UPDATE SKIP LOCKED claim, the run's unique key), so this runs against a test database.
// Needs `pnpm db:up`.
import { randomBytes } from 'node:crypto';
import { ROUTINE_WORKFLOW_ID, type AccountScope } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../src/contracts.js';
import type { TicketRow, TicketScheduleRow } from '../src/db/types.js';
import { sweepSchedulesOnce } from '../src/schedules/sweep.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type ScheduleDeps,
} from '../src/schedules/store.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const LOCAL = { mode: 'local' } as const;

async function account(): Promise<AccountScope> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO account (name) VALUES ($1) RETURNING id',
    [`acct-${randomBytes(4).toString('hex')}`],
  );
  return { account_id: r.rows[0]!.id } as AccountScope;
}

async function machine(scope: AccountScope, name: string, repo: string | null): Promise<string> {
  const id = `sch-m-${randomBytes(4).toString('hex')}`;
  await db.pool.query(
    'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
      'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
      "VALUES ($1, $2, $3, $4, 'darwin', 'arm64', 8, 16000, 100000, 4, 8000, 2, 1)",
    [id, scope.account_id, name, `${name.toLowerCase()}.local`],
  );
  if (repo !== null) {
    await db.pool.query(
      'INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, tree_clean, remote) ' +
        "VALUES ($1, $2, $3, '/src/app', 'abc', true, $3)",
      [id, scope.account_id, repo],
    );
  }
  return id;
}

const deps = (now: Date): ScheduleDeps & { bus: InMemoryBoardBus } => {
  const bus = new InMemoryBoardBus();
  return { db: db.pool, boardBus: bus, bus, auth: LOCAL, now: () => now };
};

const T0 = new Date('2026-11-03T08:00:00Z');
const at = (iso: string) => new Date(iso);

const base = (over: Record<string, unknown> = {}) => ({
  name: `PR sweep ${randomBytes(3).toString('hex')}`,
  cron: '0 9 * * 1-5',
  timezone: 'UTC',
  title: 'Keep my PRs and Jira up to date',
  body: 'Use the mtd skills to update every open PR and its Jira ticket.',
  repo: 'github.com/acme/app',
  kind: 'work',
  ...over,
});

async function created(d: ScheduleDeps, scope: AccountScope, over: Record<string, unknown> = {}) {
  const res = await createSchedule(d, scope, base(over), 'ben@example.test');
  if (!res.ok) throw new Error(`create failed: ${res.message}`);
  return res.dto;
}

const ticketsOf = async (scheduleId: string) =>
  (
    await db.pool.query<TicketRow>(
      'SELECT * FROM ticket WHERE schedule_id = $1 ORDER BY scheduled_for',
      [scheduleId],
    )
  ).rows;

const rowOf = async (id: string) =>
  (await db.pool.query<TicketScheduleRow>('SELECT * FROM ticket_schedule WHERE id = $1', [id]))
    .rows[0]!;

const sweep = (now: Date) =>
  sweepSchedulesOnce({ db: db.pool, boardBus: new InMemoryBoardBus(), now: () => now });

describe('schedules store (ADR-0032)', () => {
  it('creates with the next run, resolves machines by name, and warns', async () => {
    const scope = await account();
    const laptop = await machine(scope, 'WorkLaptop', 'github.com/acme/app');
    const other = await machine(scope, 'Mac', null);
    const d = deps(T0);
    const dto = await created(d, scope, { machines: ['worklaptop'] });
    expect(dto).toMatchObject({
      enabled: true,
      workflow_id: ROUTINE_WORKFLOW_ID,
      machine_ids: [laptop],
      next_run_at: '2026-11-03T09:00:00.000Z',
      created_by: 'ben@example.test',
      last_ticket: null,
    });
    expect(dto.next_runs).toHaveLength(3);
    expect(dto.warnings).toBeUndefined();
    // Pinned to a machine without the repo.
    const lacks = await created(d, scope, { machines: [other] });
    expect(lacks.warnings).toEqual(['machine_lacks_repo']);
    const noRepo = await created(d, scope, { repo: 'github.com/acme/nowhere' });
    expect(noRepo.warnings).toEqual(['no_machine_has_repo']);
    // The routine workflow was seeded on the way.
    const wf = await db.pool.query('SELECT 1 FROM workflow_definition WHERE id = $1', [
      ROUTINE_WORKFLOW_ID,
    ]);
    expect(wf.rowCount).toBe(1);
  });

  it('refuses bad rules, unknown machines and workflows, and a duplicate name', async () => {
    const scope = await account();
    const d = deps(T0);
    const codes = async (over: Record<string, unknown>) => {
      const r = await createSchedule(d, scope, base(over), null);
      return r.ok ? 'ok' : `${r.status}:${r.details?.[0]?.path ?? r.code}`;
    };
    expect(await codes({ cron: '*/5 * * * *' })).toBe('400:cron');
    expect(await codes({ cron: 'nope' })).toBe('400:cron');
    expect(await codes({ timezone: 'Mars/Base' })).toBe('400:timezone');
    expect(await codes({ machines: ['ghost'] })).toBe('400:machines');
    expect(await codes({ workflow_id: 'no_such_flow' })).toBe('400:workflow_id');
    expect(await codes({ kind: undefined })).toBe('400:kind');
    await created(d, scope, { name: 'Twice' });
    expect(await codes({ name: 'Twice' })).toBe('409:name');
  });

  it('updates: a new rule recomputes the next run, pause clears it, a stale read conflicts', async () => {
    const scope = await account();
    const d = deps(T0);
    const dto = await created(d, scope);
    const moved = await updateSchedule(d, scope, dto.id, {
      cron: '30 10 * * *',
      expected_updated_at: dto.updated_at,
    });
    expect(moved.ok && moved.dto.next_run_at).toBe('2026-11-03T10:30:00.000Z');
    const stale = await updateSchedule(d, scope, dto.id, {
      title: 'x',
      expected_updated_at: dto.updated_at,
    });
    expect(stale.ok ? 'ok' : stale.code).toBe('conflict');
    const paused = await updateSchedule(d, scope, dto.id, { enabled: false });
    expect(paused.ok && [paused.dto.next_run_at, paused.dto.next_runs]).toEqual([null, []]);
    const resumed = await updateSchedule(deps(at('2026-11-03T11:00:00Z')), scope, dto.id, {
      enabled: true,
    });
    expect(resumed.ok && resumed.dto.next_run_at).toBe('2026-11-04T10:30:00.000Z');
    const bad = await updateSchedule(d, scope, dto.id, { cron: '* * * * *' });
    expect(bad.ok ? 'ok' : bad.details?.[0]?.path).toBe('cron');
  });

  it('is scoped to the account', async () => {
    const a = await account();
    const b = await account();
    const d = deps(T0);
    const dto = await created(d, a);
    expect((await listSchedules(db.pool, b.account_id)).schedules).toEqual([]);
    expect(await getSchedule(db.pool, b.account_id, dto.id)).toBeNull();
    const patch = await updateSchedule(d, b, dto.id, { title: 'mine now' });
    expect(patch.ok ? 'ok' : patch.status).toBe(404);
    const run = await runScheduleNow(d, b, dto.id);
    expect(run.ok ? 'ok' : run.status).toBe(404);
    expect(await deleteSchedule(db.pool, b.account_id, dto.id)).toBe(false);
    expect(await deleteSchedule(db.pool, b.account_id, 'not-a-uuid')).toBe(false);
    expect((await listSchedules(db.pool, a.account_id)).schedules.map((s) => s.id)).toEqual([
      dto.id,
    ]);
  });
});

describe('schedule sweep (ADR-0032)', () => {
  // The sweep reads every account's schedules: start each case with none, so its stats are its own.
  beforeEach(async () => {
    await db.pool.query('DELETE FROM ticket_schedule');
  });

  it('a due run makes one ticket from the template, pinned to its machines', async () => {
    const scope = await account();
    const laptop = await machine(scope, 'Laptop', 'github.com/acme/app');
    const dto = await created(deps(T0), scope, { machines: [laptop], timezone: 'America/Toronto' });
    // 09:00 Toronto = 14:00Z.
    expect(dto.next_run_at).toBe('2026-11-03T14:00:00.000Z');
    expect((await sweep(at('2026-11-03T13:59:00Z'))).due).toBe(0);

    const now = at('2026-11-03T14:00:20Z');
    const bus = new InMemoryBoardBus();
    const stats = await sweepSchedulesOnce({ db: db.pool, boardBus: bus, now: () => now });
    expect(stats).toMatchObject({ due: 1, created: 1, errors: 0 });
    const [t, ...more] = await ticketsOf(dto.id);
    expect(more).toEqual([]);
    expect(t).toMatchObject({
      title: 'Keep my PRs and Jira up to date · 2026-11-03 09:00',
      body: dto.body,
      repo: 'github.com/acme/app',
      workflow_id: ROUTINE_WORKFLOW_ID,
      kind: 'work',
      status: 'ready',
      repo_allow_machines: [laptop],
      account_id: scope.account_id,
    });
    expect(t!.scheduled_for?.toISOString()).toBe('2026-11-03T14:00:00.000Z');
    // The card names its schedule.
    expect(bus.published.map((e) => [e.type, 'card' in e ? e.card.schedule : null])).toEqual([
      ['card.upserted', { id: dto.id, name: dto.name }],
    ]);
    const row = await rowOf(dto.id);
    expect(row.last_ticket_id).toBe(t!.id);
    expect(row.next_run_at?.toISOString()).toBe('2026-11-04T14:00:00.000Z');

    // The same pass again makes nothing.
    expect((await sweep(now)).due).toBe(0);
    expect(await ticketsOf(dto.id)).toHaveLength(1);
  });

  it('skips while the last run is open, runs again once it is done', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    await sweep(at('2026-11-03T09:00:00Z'));
    const [first] = await ticketsOf(dto.id);

    const skipped = await sweep(at('2026-11-04T09:00:05Z'));
    expect(skipped).toMatchObject({ due: 1, skipped: 1, created: 0 });
    let row = await rowOf(dto.id);
    expect([row.last_skip_reason, row.last_skipped_at?.toISOString()]).toEqual([
      'previous_run_open',
      '2026-11-04T09:00:05.000Z',
    ]);
    expect(row.next_run_at?.toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(await ticketsOf(dto.id)).toHaveLength(1);

    await db.pool.query("UPDATE ticket SET status = 'done' WHERE id = $1", [first!.id]);
    expect((await sweep(at('2026-11-05T09:00:00Z'))).created).toBe(1);
    expect(await ticketsOf(dto.id)).toHaveLength(2);
    row = await rowOf(dto.id);
    expect(row.last_ticket_id).not.toBe(first!.id);
  });

  it('does not catch up missed runs, and never fires a paused schedule', async () => {
    const scope = await account();
    const d = deps(T0);
    const dto = await created(d, scope);
    const paused = await created(d, scope);
    await updateSchedule(d, scope, paused.id, { enabled: false });
    // A week of runs missed (the orchestrator was down): one ticket, then the next future run.
    const stats = await sweep(at('2026-11-10T12:00:00Z'));
    expect(stats.created).toBe(1);
    const tickets = await ticketsOf(dto.id);
    expect(tickets.map((t) => t.scheduled_for?.toISOString())).toEqual([
      '2026-11-03T09:00:00.000Z',
    ]);
    expect((await rowOf(dto.id)).next_run_at?.toISOString()).toBe('2026-11-11T09:00:00.000Z');
    expect(await ticketsOf(paused.id)).toEqual([]);
  });

  it('two concurrent sweeps make one ticket', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    const now = at('2026-11-03T09:00:01Z');
    const [a, b] = await Promise.all([sweep(now), sweep(now)]);
    expect(a.created + b.created).toBe(1);
    expect(a.errors + b.errors).toBe(0);
    expect(await ticketsOf(dto.id)).toHaveLength(1);
  });

  it('a run that already has its ticket is not inserted twice', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    await sweep(at('2026-11-03T09:00:00Z'));
    // Put the schedule back on the same run, as a crash between insert and advance would.
    await db.pool.query("UPDATE ticket SET status = 'done' WHERE schedule_id = $1", [dto.id]);
    await db.pool.query(
      "UPDATE ticket_schedule SET next_run_at = '2026-11-03T09:00:00Z' WHERE id = $1",
      [dto.id],
    );
    const stats = await sweep(at('2026-11-03T09:01:00Z'));
    expect(stats).toMatchObject({ duplicate: 1, created: 0, errors: 0 });
    expect(await ticketsOf(dto.id)).toHaveLength(1);
  });

  it('disables a schedule whose rule no longer parses', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    await db.pool.query("UPDATE ticket_schedule SET timezone = 'Gone/Zone' WHERE id = $1", [
      dto.id,
    ]);
    const stats = await sweep(at('2026-11-03T09:00:00Z'));
    expect(stats.disabled).toBe(1);
    const row = await rowOf(dto.id);
    expect([row.enabled, row.next_run_at, row.last_skip_reason]).toEqual([
      false,
      null,
      'invalid_schedule',
    ]);
    expect(await ticketsOf(dto.id)).toEqual([]);
  });
});

describe('run now (ADR-0032)', () => {
  it('makes a ticket at once, keeps the next run, and refuses while the last is open', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    const now = at('2026-11-03T08:30:00.700Z');
    const first = await runScheduleNow(deps(now), scope, dto.id);
    if (!first.ok) throw new Error(first.message);
    expect(first.dto.next_run_at).toBe('2026-11-03T09:00:00.000Z');
    expect(first.dto.last_ticket).toEqual({ id: first.ticket_id, status: 'ready' });
    const [t] = await ticketsOf(dto.id);
    expect(t!.scheduled_for?.toISOString()).toBe('2026-11-03T08:30:00.000Z');

    const again = await runScheduleNow(deps(at('2026-11-03T08:31:00Z')), scope, dto.id);
    expect(again.ok ? 'ok' : [again.status, again.code]).toEqual([409, 'previous_run_open']);
    const forced = await runScheduleNow(deps(at('2026-11-03T08:31:00Z')), scope, dto.id, {
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(await ticketsOf(dto.id)).toHaveLength(2);
  });

  it('deleting a schedule keeps its tickets', async () => {
    const scope = await account();
    const dto = await created(deps(T0), scope);
    const run = await runScheduleNow(deps(T0), scope, dto.id);
    expect(run.ok).toBe(true);
    expect(await deleteSchedule(db.pool, scope.account_id, dto.id)).toBe(true);
    const t = await db.pool.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [
      run.ok ? run.ticket_id : '',
    ]);
    expect(t.rows[0]?.schedule_id).toBeNull();
  });
});
