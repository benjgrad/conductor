import {
  BoardResponseSchema,
  BoardSseEventSchema,
  CONDUCTOR_WORKFLOW_ID,
  type CreateTicketRequest,
  SessionDetailSchema,
  validateWorkflow,
  WorkflowDetailSchema,
  type BoardSseEvent,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './client.js';
import { SEED_IDS } from './mock-data.js';
import { createMockApi } from './mock.js';
import { detailVersions } from '../workflow/review.js';

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
    expect(col('needs_input')).toHaveLength(3);
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
    await api.createTicket({ title: 'a', body: '', repo: 'r', workflow_id: 'm1_basic' });
    await api.createTicket({ title: 'b', body: '', repo: 'r', workflow_id: 'm1_basic' });
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
    expect(latest.version).toBe(2);
    expect(detailVersions(latest)).toEqual([1, 2]);
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
    for (const def of [v1, latest.definition]) {
      const res = validateWorkflow(def);
      expect(res.ok ? [] : res.errors).toEqual([]);
    }
    // Saving it as is stores v3.
    expect(await api.saveWorkflow(latest.definition)).toEqual({ id: 'conductor', version: 3 });
  });

  it('createTicket defaults workflow_id to conductor', async () => {
    const api = createMockApi({ now });
    // Omitting workflow_id, as a client may once the shared contract makes it optional. Typed
    // loosely so this compiles whether or not the field is still required.
    const req: Record<string, unknown> = { title: 'a', body: '', repo: 'r' };
    const ticket = await api.createTicket(req as unknown as CreateTicketRequest);
    expect(ticket.workflow_id).toBe('conductor');
  });

  it('serves version history; m1_basic v2 has the example gate', async () => {
    const api = createMockApi({ now });
    const list = await api.listWorkflows();
    expect(list.map((w) => [w.id, w.version])).toEqual([
      ['conductor', 2],
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
