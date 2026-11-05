import {
  ScheduleDtoSchema,
  ScheduleListResponseSchema,
  BoardResponseSchema,
  BoardSseEventSchema,
  checksGatesOf,
  CONDUCTOR_WORKFLOW_ID,
  EnrollmentTokenCreatedSchema,
  MachineDetailSchema,
  MachineListResponseSchema,
  RepoChecksDetailSchema,
  RepoCheckRunsResponseSchema,
  RepoChecksHealthResponseSchema,
  RepoChecksDtoSchema,
  RepoChecksListResponseSchema,
  RepoListResponseSchema,
  type CreateTicketRequest,
  TeamResponseSchema,
  SessionDetailSchema,
  TicketSearchResponseSchema,
  validateWorkflow,
  WorkflowDetailSchema,
  type BoardSseEvent,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './client.js';
import { SCHEDULE_IDS, SEED_IDS } from './mock-data.js';
import { createMockApi } from './mock.js';
import { detailVersions } from '../workflow/review.js';
import { planAnswerOption } from '../components/request-preview.js';

const now = () => new Date('2026-10-22T12:00:00.000Z');
const tick = () => new Promise((r) => setTimeout(r, 0));

function collect(api: ReturnType<typeof createMockApi>, from = 0) {
  const events: BoardSseEvent[] = [];
  const stop = api.streamBoard(from, { onEvent: (e) => events.push(e) });
  return { events, stop };
}

describe('mock ApiClient', () => {
  it('serves contract-valid board and session DTOs', async () => {
    const api = createMockApi({ now });
    const board = BoardResponseSchema.parse(await api.getBoard());
    const col = (id: string) => board.columns.find((c) => c.id === id)!.cards;
    expect(col('needs_input')).toHaveLength(6);
    // ADR-0010: old m1_* states map by type (build, implement → Implementing).
    expect(col('implementing').some((c) => c.badges.includes('waiting_for_build_slot'))).toBe(true);
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.session_id) SessionDetailSchema.parse(await api.getSession(card.session_id));
      }
    }
  });

  it('answers once: emits contract-valid events, then 409 input_already_answered', async () => {
    const api = createMockApi({ now });
    const { events } = collect(api);
    const { session, input } = SEED_IDS.askOlder;
    await api.answer(session, { input_request_id: input, answer: 'retry' });
    await tick();
    expect(events.map((e) => BoardSseEventSchema.parse(e).type)).toEqual([
      'input.answered',
      'session.status',
      'card.moved',
      'card.upserted',
    ]);
    const detail = await api.getSession(session);
    expect(detail.card).toMatchObject({ status: 'running', workflow_state: 'test' });
    expect(detail.pending_input).toBeNull();

    const again = api.answer(session, { input_request_id: input, answer: 'x' });
    await expect(again).rejects.toBeInstanceOf(ApiRequestError);
    await expect(again).rejects.toMatchObject({ status: 409, code: 'input_already_answered' });
  });

  it('honours goto ("skip to") and rejects an unknown state', async () => {
    const api = createMockApi({ now });
    const { session, input } = SEED_IDS.askOlder;
    await expect(
      api.answer(session, { input_request_id: input, answer: 'x', goto: 'nope' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await api.answer(session, { input_request_id: input, answer: 'skip', goto: 'done' });
    expect((await api.getSession(session)).card).toMatchObject({
      status: 'done',
      column: 'done',
    });
  });

  it('replays from Last-Event-ID', async () => {
    const api = createMockApi({ now });
    await api.createTicket({
      title: 'a',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
      kind: 'work',
    });
    await api.createTicket({
      title: 'b',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
      kind: 'work',
    });
    const { events } = collect(api, 1);
    await tick();
    expect(events.map((e) => e.id)).toEqual([2]);
    expect(events[0]).toMatchObject({ type: 'card.upserted', card: { title: 'b' } });
  });

  it('approve only when waiting for ui.approve; cancel only when not terminal', async () => {
    const api = createMockApi({ now });
    await expect(api.approve(SEED_IDS.running.session)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    await api.approve(SEED_IDS.approval.session);
    expect((await api.getSession(SEED_IDS.approval.session)).card.column).toBe('done');
    await expect(api.cancel(SEED_IDS.done.session)).rejects.toMatchObject({ code: 'conflict' });
    await api.cancel(SEED_IDS.running.session);
    expect((await api.getSession(SEED_IDS.running.session)).card.column).toBe('done');
  });

  it('streams output chunks pushed after subscribe', async () => {
    const api = createMockApi({ now });
    const chunks: string[] = [];
    const stop = api.streamOutput(SEED_IDS.running.session, {
      onEvent: (c) => chunks.push(c.text),
    });
    api.pushOutput(SEED_IDS.running.session, 'hello\n');
    stop();
    api.pushOutput(SEED_IDS.running.session, 'ignored\n');
    expect(chunks).toEqual(['hello\n']);
    const detail = await api.getSession(SEED_IDS.running.session);
    expect(detail.recent_output.at(-1)?.text).toBe('ignored\n');
  });
});

describe('mock workflows (ADR-0009)', () => {
  it('serves the one conductor workflow (ADR-0010), valid, with history', async () => {
    const api = createMockApi({ now });
    const latest = await api.getWorkflow(CONDUCTOR_WORKFLOW_ID);
    // v3 is the shipped ADR-0011 conductor v2 (M1b-T09); v2 the last entry-based one.
    expect(latest.version).toBe(3);
    expect(detailVersions(latest)).toEqual([1, 2, 3]);
    const planning = latest.definition.states.planning;
    expect(planning?.type === 'agent' && Object.keys(planning.on ?? {})).toContain('plan_ready');
    const v2 = (await api.getWorkflow(CONDUCTOR_WORKFLOW_ID, 2)).definition;
    const v1 = (await api.getWorkflow(CONDUCTOR_WORKFLOW_ID, 1)).definition;
    expect(v1.columns).toEqual([
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    expect(v1.states.waiting_external?.entry).toEqual({
      checks: [
        { name: 'Build passes', cmd: 'npm run build' },
        { name: 'Tests pass', cmd: 'npm test' },
      ],
      actions: ['open_pr'],
      on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
    });
    for (const def of [v1, v2, latest.definition]) {
      const res = validateWorkflow(def);
      expect(res.ok ? [] : res.errors).toEqual([]);
    }
    // Saving v2 as is stores v4.
    expect(await api.saveWorkflow(v2)).toEqual({ id: 'conductor', version: 4 });
  });

  it('createTicket defaults workflow_id to conductor', async () => {
    const api = createMockApi({ now });
    // Omitting workflow_id, as a client may once the shared contract makes it optional. Typed
    // loosely so this compiles whether or not the field is still required.
    const req: Record<string, unknown> = { title: 'a', body: '', repo: 'r', kind: 'work' };
    const ticket = await api.createTicket(req as unknown as CreateTicketRequest);
    expect(ticket.workflow_id).toBe('conductor');
  });

  it('serves version history; m1_basic v2 has the example gate', async () => {
    const api = createMockApi({ now });
    const list = await api.listWorkflows();
    expect(list.map((w) => [w.id, w.version])).toEqual([
      ['conductor', 3],
      ['m1_basic', 2],
      ['pr_flow', 2],
    ]);
    const latest = WorkflowDetailSchema.parse(await api.getWorkflow('m1_basic'));
    expect(latest.version).toBe(2);
    const impl = latest.definition.states.implement;
    expect(impl?.type === 'agent' && impl.on?.done).toMatchObject({
      goto: 'build',
      requirements: { on_unmet: { goto: 'implement', retries: 2 } },
    });
    const v1 = await api.getWorkflow('m1_basic', 1);
    expect(v1.definition.version).toBe(1);
    expect(detailVersions(v1)).toEqual([1, 2]);
    await expect(api.getWorkflow('m1_basic', 9)).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.getWorkflow('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('saveWorkflow validates, then stores a new version', async () => {
    const api = createMockApi({ now });
    const { definition } = await api.getWorkflow('m1_basic');
    expect(await api.saveWorkflow(definition)).toEqual({ id: 'm1_basic', version: 3 });
    expect((await api.getWorkflow('m1_basic')).version).toBe(3);
    expect((await api.listWorkflows())[1]).toMatchObject({ id: 'm1_basic', version: 3 });

    const bad = structuredClone(definition);
    const impl = bad.states.implement;
    if (impl?.type !== 'agent' || typeof impl.on?.done !== 'object') throw new Error('fixture');
    impl.on.done.requirements!.on_unmet.else = 'build';
    const err = await api.saveWorkflow(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_workflow',
      details: [
        {
          path: 'states.implement.on.done.requirements.on_unmet.else',
          message: expect.stringContaining('human') as unknown,
        },
      ],
    });
    expect((await api.getWorkflow('m1_basic')).version).toBe(3);
  });

  it('takes a human transition (ADR-0011): moves, records it, 409 when not offered', async () => {
    const api = createMockApi({ now });
    const { session, input } = SEED_IDS.transitions;
    const { events } = collect(api);
    await expect(api.transition(session, { name: 'nope' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    // An old version offers none.
    await expect(api.transition(SEED_IDS.askOlder.session, { name: 'done' })).rejects.toMatchObject(
      { status: 409 },
    );
    await api.transition(session, { name: 'waiting_on_someone', text: 'Dana' });
    await tick();
    expect(events.map((e) => BoardSseEventSchema.parse(e).type)).toEqual([
      'input.answered',
      'session.status',
      'card.moved',
      'card.upserted',
    ]);
    const detail = SessionDetailSchema.parse(await api.getSession(session));
    expect(detail.card).toMatchObject({
      status: 'waiting_external',
      workflow_state: 'waiting_external',
      column: 'waiting_external',
      input_request: null,
      human_transitions: [expect.objectContaining({ name: 'back_to_implementing' })],
    });
    expect(detail.moves?.at(-1)).toEqual({
      at: now().toISOString(),
      from: 'needs_input',
      to: 'waiting_external',
      transition: 'waiting_on_someone',
      reason: 'Dana',
      actor: 'human',
    });
    // The question it left behind is closed.
    await expect(
      api.answer(session, { input_request_id: input, answer: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('UX-4 seeds', () => {
  it('a review request with its PR and a failed step, both with their origin', async () => {
    const api = createMockApi({ now });
    const review = SessionDetailSchema.parse(await api.getSession(SEED_IDS.review.session));
    expect(review.card.pr_url).toBe('https://github.com/benjgrad/conductor/pull/42');
    expect(review.pending_input).toMatchObject({
      origin_transition: 'personal_pr_ready_for_review',
      step_failed: false,
    });
    const failed = SessionDetailSchema.parse(await api.getSession(SEED_IDS.stepFailed.session));
    expect(failed.pending_input).toMatchObject({ kind: 'retries_exhausted', step_failed: true });
  });

  it('a plan to approve, with its plan, its brief and the $return_to answer', async () => {
    const api = createMockApi({ now });
    const plan = SessionDetailSchema.parse(await api.getSession(SEED_IDS.planApproval.session));
    expect(plan.pending_input).toMatchObject({ origin_transition: 'plan_needs_approval' });
    expect(plan.return_to).toBe('planning');
    expect(plan.context.planning?.plan).toEqual(expect.stringContaining('rate limiting'));
    expect(plan.ticket_body).toBeTruthy();
    expect(planAnswerOption(plan.card.human_transitions, plan.return_to)).not.toBeNull();
  });
});

describe('mock repos', () => {
  it('ranks the seeded tickets’ repos, then the machines’; a new ticket’s repo goes first', async () => {
    const api = createMockApi({ now });
    const before = RepoListResponseSchema.parse(await api.listRepos());
    expect(before.length).toBeGreaterThan(0);
    // The machines' repos no ticket used come last, unused.
    expect(before.map((r) => r.repo)).toContain('github.com/acme/shop');
    const req: CreateTicketRequest = {
      title: 'T',
      body: '',
      repo: 'github.com/o/fresh',
      workflow_id: CONDUCTOR_WORKFLOW_ID,
      priority: 3,
      kind: 'work',
      required_tags: [],
      repo_allow_machines: null,
      external_ref: null,
    };
    for (let i = 0; i < 20; i++) await api.createTicket(req);
    const after = await api.listRepos();
    expect(after[0]).toMatchObject({ repo: 'github.com/o/fresh', ticket_count: 20 });
  });
});

describe('mock team (UX-13b FR-3)', () => {
  it('serves a contract-valid team, oldest hire first, active tickets from the live board', async () => {
    const api = createMockApi({ now });
    const team = TeamResponseSchema.parse(await api.listTeam());
    const hired = team.map((m) => m.hired_at);
    expect(hired).toEqual([...hired].sort());
    const byName = new Map(team.map((m) => [m.name, m]));
    expect(byName.get('Amara')?.active_ticket_id).toBe(SEED_IDS.askNewer.ticket);
    expect(byName.get('Kenji')?.active_ticket_id).toBe(SEED_IDS.runningSlot.ticket);
    expect(byName.get('Elif')).toMatchObject({ active_ticket_id: null });
    expect(byName.get('Elif')?.last_assigned_at).not.toBeNull();
    expect(byName.get('Tunde')).toMatchObject({ active_ticket_id: null, last_assigned_at: null });
    // The board agrees: the same names are on the seed cards.
    const board = await api.getBoard();
    const card = board.columns
      .flatMap((col) => col.cards)
      .find((c) => c.ticket_id === SEED_IDS.askNewer.ticket);
    expect(card?.agent_name).toBe('Amara');
  });

  it('frees a teammate when their ticket ends', async () => {
    const api = createMockApi({ now });
    await api.cancel(SEED_IDS.runningSlot.session);
    const team = await api.listTeam();
    expect(team.find((m) => m.name === 'Kenji')?.active_ticket_id).toBeNull();
  });
});

describe('mock machines (M2-T11)', () => {
  it('UX-8: `machines: none` starts empty; connectMachine enrolls one online', async () => {
    const api = createMockApi({ now, machines: 'none' });
    expect(await api.listMachines()).toEqual([]);
    const id = api.connectMachine({ name: 'my-laptop' });
    const rows = MachineListResponseSchema.parse(await api.listMachines());
    expect(rows.map((r) => [r.id, r.name, r.status, r.revoked_at])).toEqual([
      [id, 'my-laptop', 'online', null],
    ]);
    api.updateMachine(id, { repos: [] });
    expect(MachineDetailSchema.parse(await api.getMachine(id)).repos).toEqual([]);
  });

  it('serves two contract-valid machines, one with an open alert', async () => {
    const api = createMockApi({ now });
    const rows = MachineListResponseSchema.parse(await api.listMachines());
    expect(rows.map((r) => [r.id, r.outdated])).toEqual([
      ['mbp-ben', false],
      ['linux-box', true],
    ]);
    const mbp = MachineDetailSchema.parse(await api.getMachine('mbp-ben'));
    expect(mbp.alerts.map((a) => a.files)).toEqual([['.git/hooks/pre-commit']]);
    expect(mbp.live_sessions.length).toBeGreaterThan(0);
    expect(MachineDetailSchema.parse(await api.getMachine('linux-box')).alerts).toEqual([]);
    await expect(api.getMachine('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('renames (400 on a blank name), revokes (404 unknown), issues 30-minute tokens', async () => {
    const api = createMockApi({ now });
    expect((await api.renameMachine('linux-box', { name: ' Build box ' })).name).toBe('Build box');
    await expect(api.renameMachine('linux-box', { name: '  ' })).rejects.toMatchObject({
      status: 400,
    });
    await api.revokeMachine('linux-box');
    expect((await api.getMachine('linux-box')).revoked_at).toBe(now().toISOString());
    await expect(api.revokeMachine('nope')).rejects.toMatchObject({ status: 404 });

    const a = EnrollmentTokenCreatedSchema.parse(await api.createEnrollmentToken());
    const b = await api.createEnrollmentToken();
    expect(a.token).not.toBe(b.token);
    expect(a.command).toContain(a.token);
    expect(Date.parse(a.expires_at) - now().getTime()).toBe(30 * 60_000);
  });
});

describe('mock repo checks (ADR-0030)', () => {
  it('serves run history and health in the API shapes (UXR-80)', async () => {
    const api = createMockApi({ now });
    const shop = RepoCheckRunsResponseSchema.parse(
      await api.getRepoCheckRuns('github.com/Acme/Shop'),
    );
    expect(shop.checks.map((c) => c.name)).toEqual(['Build', 'Tests']);
    expect(shop.checks[1]!.runs[0]!.status).toBe('timed_out');
    const plain = RepoCheckRunsResponseSchema.parse(
      await api.getRepoCheckRuns('github.com/acme/api', 2),
    );
    const build = plain.checks.find((c) => c.cmd === 'npm run build')!;
    expect([build.runs.length, build.failures_in_window, build.runs_in_window]).toEqual([2, 6, 6]);
    const health = RepoChecksHealthResponseSchema.parse(await api.getRepoChecksHealth());
    expect(health.repos.find((r) => r.repo === 'github.com/acme/api')).toMatchObject({
      runs: 6,
      failures: 6,
    });
  });

  const checks = [
    { name: 'Build', cmd: 'make' },
    { name: 'Tests', cmd: 'make test', timeout: '10m' },
  ];

  it('seeds one override; set → list → get is the override at every gate', async () => {
    const api = createMockApi({ now });
    const seeded = RepoChecksListResponseSchema.parse(await api.listRepoChecks());
    expect(seeded.repos.map((r) => r.repo)).toEqual(['github.com/acme/shop']);

    const dto = RepoChecksDtoSchema.parse(
      await api.setRepoChecks({ repo: 'GitHub.com/Acme/App', setup: '', checks }),
    );
    expect(dto).toMatchObject({ repo: 'github.com/acme/app', setup: '', checks });
    // Case-insensitive: one key.
    await api.setRepoChecks({ repo: 'github.com/acme/app', checks });
    const list = await api.listRepoChecks();
    expect(list.repos.map((r) => [r.repo, r.setup])).toEqual([
      ['github.com/acme/app', null],
      ['github.com/acme/shop', 'pnpm install --frozen-lockfile'],
    ]);

    const detail = RepoChecksDetailSchema.parse(await api.getRepoChecks('github.com/ACME/app'));
    const gates = checksGatesOf((await api.getWorkflow(CONDUCTOR_WORKFLOW_ID)).definition);
    expect(gates.length).toBeGreaterThan(0);
    expect(detail.repo).toBe('github.com/acme/app');
    expect(detail.effective.map((g) => [g.at, g.source, g.setup])).toEqual(
      gates.map((g) => [g.at, 'override', null]),
    );
    expect(detail.effective[0]!.checks).toEqual(checks);
  });

  it('400 with field paths: a name listed twice, a blank command', async () => {
    const api = createMockApi({ now });
    const err = await api
      .setRepoChecks({
        repo: 'github.com/o/app',
        checks: [
          { name: 'a', cmd: 'x' },
          { name: 'a', cmd: ' ' },
        ],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 400,
      code: 'bad_request',
      details: [
        { path: 'checks.1.name', message: 'check "a" is listed twice' },
        { path: 'checks.1.cmd', message: 'empty command' },
      ],
    });
    expect((await api.getRepoChecks('github.com/o/app')).override).toBeNull();
  });

  it('clear → the workflow’s own checks; a second clear is 404', async () => {
    const api = createMockApi({ now });
    expect(await api.clearRepoChecks('github.com/Acme/Shop')).toEqual({ ok: true });
    const detail = await api.getRepoChecks('github.com/acme/shop');
    expect(detail.override).toBeNull();
    expect(detail.effective).toEqual(
      checksGatesOf((await api.getWorkflow(CONDUCTOR_WORKFLOW_ID)).definition).map((g) => ({
        at: g.at,
        source: 'workflow',
        setup: g.setup,
        checks: g.checks,
      })),
    );
    await expect(api.clearRepoChecks('github.com/acme/shop')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect((await api.listRepoChecks()).repos).toEqual([]);
  });
});

describe('mock searchTickets (UXR-85)', () => {
  it('finds tickets of any status, newest first, by status group, paged', async () => {
    const api = createMockApi({ now });
    const parse = (r: unknown) => TicketSearchResponseSchema.parse(r);

    const all = parse(await api.searchTickets());
    expect(all.total).toBeGreaterThan(5);
    const times = all.tickets.map((t) => t.updated_at);
    expect([...times].sort().reverse()).toEqual(times);

    const closed = parse(await api.searchTickets({ status: ['done', 'cancelled'] }));
    expect(closed.tickets.map((t) => [t.title, t.status])).toEqual([
      ['Rename user.fullname', 'done'],
      ['Try a GraphQL gateway', 'cancelled'],
    ]);

    const byBody = parse(await api.searchTickets({ q: 'graphql GATEWAY in front' }));
    expect(byBody.tickets.map((t) => t.id)).toEqual([SEED_IDS.cancelled.ticket]);
    expect(byBody.tickets[0]!.snippet).toContain('GraphQL gateway in front');
    const byId = parse(await api.searchTickets({ q: SEED_IDS.done.ticket.slice(0, 8) }));
    expect(byId.tickets.map((t) => t.id)).toContain(SEED_IDS.done.ticket);

    const first = parse(await api.searchTickets({ limit: 2 }));
    expect(first.next_cursor).toBe(2);
    const rest = parse(await api.searchTickets({ limit: 50, cursor: 2 }));
    expect(rest.next_cursor).toBeNull();
    expect([...first.tickets, ...rest.tickets].map((t) => t.id)).toEqual(
      all.total <= 20 ? all.tickets.map((t) => t.id) : expect.any(Array),
    );
  });
});

describe('mock schedules (ADR-0032, UXR-83)', () => {
  const create = {
    name: 'Nightly',
    cron: '0 2 * * *',
    timezone: 'UTC',
    title: 'Nightly sweep',
    repo: 'github.com/o/app',
    kind: 'work' as const,
  };
  const reject = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected a rejection');
      },
      (err: unknown) => err as ApiRequestError,
    );

  it('seeds three, by name; the PR sweep card names its schedule', async () => {
    const api = createMockApi({ now });
    const list = ScheduleListResponseSchema.parse(await api.listSchedules());
    expect(list.schedules.map((s) => s.name)).toEqual([
      'Monthly report',
      'PR sweep',
      'Weekly dependency bump',
    ]);
    const sweep = list.schedules.find((s) => s.id === SCHEDULE_IDS.prSweep)!;
    expect(sweep.next_runs).toHaveLength(3);
    expect(sweep.last_ticket).toEqual({ id: SEED_IDS.running.ticket, status: 'in_progress' });
    const board = await api.getBoard();
    const card = board.columns
      .flatMap((c) => c.cards)
      .find((c) => c.ticket_id === SEED_IDS.running.ticket);
    expect(card?.schedule).toEqual({ id: SCHEDULE_IDS.prSweep, name: 'PR sweep' });
  });

  it('create checks the rule, the timezone, the machines and the name', async () => {
    const api = createMockApi({ now });
    const dto = ScheduleDtoSchema.parse(await api.saveSchedule(null, create));
    expect(dto).toMatchObject({ name: 'Nightly', enabled: true, machine_ids: null });
    expect(dto.next_run_at).toBe('2026-10-23T02:00:00.000Z');

    const often = await reject(
      api.saveSchedule(null, { ...create, name: 'x', cron: '*/5 * * * *' }),
    );
    expect([often.status, often.code, often.details[0]?.path]).toEqual([
      400,
      'bad_request',
      'cron',
    ]);
    const tz = await reject(
      api.saveSchedule(null, { ...create, name: 'y', timezone: 'Mars/Base' }),
    );
    expect(tz.details[0]?.path).toBe('timezone');
    const m = await reject(api.saveSchedule(null, { ...create, name: 'z', machines: ['nope'] }));
    expect(m.details[0]?.path).toBe('machines');
    const dup = await reject(api.saveSchedule(null, create));
    expect([dup.status, dup.code, dup.details[0]?.path]).toEqual([409, 'conflict', 'name']);
    const pinned = await api.saveSchedule(null, { ...create, name: 'p', machines: ['mbp-ben'] });
    expect(pinned.machine_ids).toEqual(['mbp-ben']);
  });

  it('update: a stale guard is 409; pause clears the next run, resume recomputes it', async () => {
    const api = createMockApi({ now });
    const dto = await api.saveSchedule(null, create);
    const paused = await api.saveSchedule(dto.id, {
      enabled: false,
      expected_updated_at: dto.updated_at,
    });
    expect([paused.enabled, paused.next_run_at, paused.next_runs]).toEqual([false, null, []]);
    expect(Date.parse(paused.updated_at)).toBeGreaterThan(Date.parse(dto.updated_at));
    const stale = await reject(
      api.saveSchedule(dto.id, { enabled: true, expected_updated_at: dto.updated_at }),
    );
    expect([stale.status, stale.code]).toEqual([409, 'conflict']);
    const resumed = await api.saveSchedule(dto.id, { enabled: true });
    expect(resumed.next_run_at).toBe('2026-10-23T02:00:00.000Z');
  });

  it('run now: refused while the last run is open, forced, a queued card with the schedule', async () => {
    const api = createMockApi({ now });
    const refused = await reject(api.runScheduleNow(SCHEDULE_IDS.prSweep));
    expect([refused.status, refused.code]).toEqual([409, 'previous_run_open']);
    const res = await api.runScheduleNow(SCHEDULE_IDS.prSweep, { force: true });
    expect(res.schedule.last_ticket).toEqual({ id: res.ticket_id, status: 'ready' });
    const card = (await api.getBoard()).columns
      .flatMap((c) => c.cards)
      .find((c) => c.ticket_id === res.ticket_id);
    expect(card).toMatchObject({
      title: 'Sweep open PRs 2026-10-22 08:00',
      schedule: { id: SCHEDULE_IDS.prSweep, name: 'PR sweep' },
    });
    // The new run is queued (open), so a second one is refused again.
    expect((await reject(api.runScheduleNow(SCHEDULE_IDS.prSweep))).code).toBe('previous_run_open');
  });

  it('delete: gone, then 404', async () => {
    const api = createMockApi({ now });
    expect(await api.deleteSchedule(SCHEDULE_IDS.weekly)).toEqual({ ok: true });
    expect((await reject(api.deleteSchedule(SCHEDULE_IDS.weekly))).status).toBe(404);
    expect((await api.listSchedules()).schedules).toHaveLength(2);
  });
});
