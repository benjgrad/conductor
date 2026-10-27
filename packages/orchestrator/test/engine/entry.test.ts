import {
  boardSseEventFromRow,
  CONDUCTOR_V1,
  entryStateLabel,
  PR_CONTEXT_KEY,
  REVIEW_CONTEXT_KEY,
  RunActionPayloadSchema,
  STEP_CONTEXT_KEY,
  type BoardSseEvent,
  type EngineEvent,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { EventRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { joinStep, splitStep } from '../../src/engine/rows.js';
import { seedConductorWorkflow } from '../../src/engine/seed.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedSession } from './fixtures.js';

// ADR-0010 through the EngineService with the real apply(): the conductor seed, the entry step's
// commands in the outbox (run_cmd, run_action with its idempotency key), the step in `context`
// (no migration), the board events (the card stays in Implementing, badged checking, then moves),
// and the step's fencing. Needs `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-10-23T12:00:00.000Z');
const LABEL = entryStateLabel('implementing', 'waiting_external');
const PR = 'https://github.com/benjgrad/fixture-app/pull/7';
const HEAD = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';

beforeAll(async () => {
  await seedConductorWorkflow(db.pool);
});

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const outbox = async (id: string) =>
  (await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [id]))
    .rows;
const boardEvents = async (id: string): Promise<BoardSseEvent[]> =>
  (
    await db.pool.query<EventRow>('SELECT * FROM event WHERE session_id = $1 ORDER BY id', [id])
  ).rows.flatMap((r) => {
    const e = boardSseEventFromRow(r);
    return e ? [e] : [];
  });

async function implementing() {
  const { sessionId } = await seedSession(db.pool, { workflow_id: 'conductor' });
  const bus = new InMemoryBoardBus();
  const { engine } = createEngineService({ db: db.pool, boardBus: bus, now: () => NOW });
  const run = async (event: EngineEvent, fencingToken?: number) =>
    engine.applyEvent(sessionId, event, fencingToken === undefined ? {} : { fencingToken });
  const started = async () => {
    const s = await session(sessionId);
    await run({
      type: 'session.started',
      command_id: s.agent_command_id!,
      worktree_path: '/tmp/wt',
      branch: s.branch!,
      port_range: { base: 41000, count: 10 },
    });
  };
  const exit = (code: number, tail = '') =>
    run({
      type: 'command.exited',
      command_id: '00000000-0000-4000-8000-000000000001',
      exit_code: code,
      timed_out: false,
      output_tail: tail,
      head_sha: HEAD,
    });
  await run({ type: 'session.assigned', machine_id: MACHINE });
  await started();
  await run({ type: 'agent.complete_state', result: { plan: 'p', summary: 'plan' } });
  await started();
  expect((await session(sessionId)).workflow_state).toBe('implementing');
  return { sessionId, run, started, exit, bus };
}

describe('the step in context (no migration)', () => {
  const step = {
    kind: 'entry',
    from: 'implementing',
    outcome: 'done',
    to: 'waiting_external',
    attachment: null,
    subject: 's',
    claude_session_id: null,
    nudged: false,
    phase: 'checks',
    index: 0,
    head_sha: null,
    // ADR-0011 fields (M1b-T01): defaulted when a stored step lacks them.
    transition: null,
    actor: null,
    reason: null,
    conditions: [],
    conditions_deadline: null,
    conditions_poll_ms: null,
    conditions_note: null,
  };

  it('splitStep reads __entry and the legacy ADR-0009 __review; joinStep writes __entry only', () => {
    const fromNew = splitStep({ a: { x: 1 }, [STEP_CONTEXT_KEY]: step });
    expect(fromNew).toEqual({ context: { a: { x: 1 } }, step });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { kind: _k, phase: _p, index: _i, ...legacy } = step;
    const fromOld = splitStep({ [REVIEW_CONTEXT_KEY]: legacy });
    expect(fromOld.step).toMatchObject({ kind: 'transition', phase: 'review', index: 0 });
    expect(joinStep({ context: { a: { x: 1 } }, step: fromNew.step })).toEqual({
      a: { x: 1 },
      [STEP_CONTEXT_KEY]: step,
    });
    // A reopen carries splitStep(old.context).context: never the step.
    expect(joinStep({ context: fromNew.context, step: null })).toEqual({ a: { x: 1 } });
  });
});

describe('seed (ADR-0010)', () => {
  // The seed's own cases (v2 upgrade, edits, concurrency) are in seed.test.ts (M1b-T09).
  it('seeded conductor v1 (these sessions pin it) and v2; idempotent on concurrent starts', async () => {
    // beforeAll already seeded: every further call (also concurrent) is a no-op.
    const again = await Promise.all(
      [1, 2, 3, 4].map(() => seedConductorWorkflow(db.pool, { log: null })),
    );
    expect(again).toEqual([false, false, false, false]);
    const rows = await db.pool.query<{ version: number; definition: unknown }>(
      "SELECT version, definition FROM workflow_definition WHERE id = 'conductor' ORDER BY version",
    );
    expect(rows.rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.rows[0]!.definition).toMatchObject({
      start: 'planning',
      columns: CONDUCTOR_V1.columns,
    });
  });
});

describe('UX-5: card.checking while conductor runs the step', () => {
  it('each card.upserted carries the label and the items with their statuses', async () => {
    const { sessionId, run, exit } = await implementing();
    await run({ type: 'agent.complete_state', result: { summary: 'added /health' } });
    const checking = async () => {
      const last = (await boardEvents(sessionId)).filter((e) => e.type === 'card.upserted').at(-1)!;
      return last.type === 'card.upserted' ? last.card.checking : null;
    };
    const statuses = async () => (await checking())?.items?.map((i) => [i.label, i.status]);

    // Regression: before UX-5 the card had no label and no items while the checks ran.
    expect(await checking()).toMatchObject({
      phase: 'checks',
      label: 'Checks before Waiting external',
      transition: 'done',
      current: 0,
    });
    expect(await statuses()).toEqual([
      ['Build passes', 'running'],
      ['Tests pass', 'todo'],
      ['PR opened', 'todo'],
    ]);
    await exit(0);
    expect(await statuses()).toEqual([
      ['Build passes', 'passed'],
      ['Tests pass', 'running'],
      ['PR opened', 'todo'],
    ]);
    await exit(0);
    expect(await checking()).toMatchObject({ phase: 'actions', current: 2 });
    expect(await statuses()).toEqual([
      ['Build passes', 'passed'],
      ['Tests pass', 'passed'],
      ['PR opened', 'running'],
    ]);
  });
});

describe('entry step through the EngineService', () => {
  it('checks → open_pr → Waiting external; the card stays in Implementing while checking', async () => {
    const { sessionId, run, exit } = await implementing();
    await run({ type: 'agent.complete_state', result: { summary: 'added /health' } });
    let s = await session(sessionId);
    expect(s.workflow_state).toBe(LABEL);
    expect(s.context[STEP_CONTEXT_KEY]).toMatchObject({ kind: 'entry', phase: 'checks', index: 0 });
    let rows = await outbox(sessionId);
    expect(rows.at(-1)).toMatchObject({ kind: 'run_cmd', payload: { cmd: 'npm run build' } });

    let card = (await boardEvents(sessionId)).filter((e) => e.type === 'card.upserted').at(-1)!;
    expect(card.type === 'card.upserted' && card.card).toMatchObject({
      column: 'implementing',
      badges: ['checking'],
      checking: { to: 'waiting_external', title: 'Waiting external', phase: 'checks' },
    });

    await exit(0);
    await exit(0);
    rows = await outbox(sessionId);
    const act = rows.at(-1)!;
    expect(act.kind).toBe('run_action');
    expect(act.idempotency_key).toBe(`${sessionId}:waiting_external:1`);
    const payload = RunActionPayloadSchema.parse(act.payload);
    expect(payload).toMatchObject({
      action: 'open_pr',
      target_state: 'waiting_external',
      branch: s.branch,
      expected_sha: HEAD, // the commit the checks ran on
      args: { title: 'Add /health' },
    });
    card = (await boardEvents(sessionId)).filter((e) => e.type === 'card.upserted').at(-1)!;
    expect(card.type === 'card.upserted' && card.card.checking).toMatchObject({ phase: 'actions' });

    const token = Number((await session(sessionId)).fencing_token);
    const res = await run(
      {
        type: 'action.completed',
        command_id: payload.command_id,
        action: 'open_pr',
        result: { pr_url: PR },
        error: null,
      },
      token,
    );
    expect(res.status).toBe('applied');
    s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'waiting_external', status: 'waiting_external' });
    expect(s.context).toMatchObject({ [PR_CONTEXT_KEY]: { pr_url: PR } });
    expect(s.context[STEP_CONTEXT_KEY]).toBeUndefined();

    const evs = await boardEvents(sessionId);
    const moved = evs
      .filter((e) => e.type === 'card.moved')
      .map((e) => e.type === 'card.moved' && [e.from, e.to]);
    expect(moved).toEqual([
      ['queued', 'planning'],
      ['planning', 'implementing'],
      ['implementing', 'waiting_external'],
    ]);
    const last = evs.filter((e) => e.type === 'card.upserted').at(-1)!;
    expect(last.type === 'card.upserted' && last.card).toMatchObject({
      column: 'waiting_external',
      badges: [],
      checking: null,
      pr_url: PR,
    });
  });

  it('a failed check goes back to implementing with the output; the worker is fenced out of the step', async () => {
    const { sessionId, run, exit } = await implementing();
    const worker = Number((await session(sessionId)).fencing_token);
    await run({ type: 'agent.complete_state', result: { summary: 'x' } }, worker);
    const step = Number((await session(sessionId)).fencing_token);
    expect(step).toBeGreaterThan(worker);
    // A worker event after its complete_state is stale; nothing moves.
    const stale = await run({ type: 'agent.complete_state', result: { summary: 'again' } }, worker);
    expect(stale).toMatchObject({ status: 'rejected', reason: 'stale_fencing_token' });
    expect((await session(sessionId)).workflow_state).toBe(LABEL);

    await exit(1, 'build broke');
    const s = await session(sessionId);
    expect(s).toMatchObject({
      workflow_state: 'implementing',
      retry_counters: { 'entry:waiting_external': 1 },
    });
    expect(Number(s.fencing_token)).toBeGreaterThan(step);
    const start = (await outbox(sessionId)).at(-1)!;
    expect(start.kind).toBe('start_session');
    expect((start.payload as { prompt: string }).prompt).toContain('build broke');
  });
});
