import type { AddressInfo } from 'node:net';
import { API_PATHS, SessionDetailSchema, type EngineEvent } from '@conductor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, UI_ACTOR } from '../src/api/index.js';
import { InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { InputRequestRow } from '../src/db/types.js';
import { createEngineService } from '../src/engine/index.js';
import type { ApiHandle } from '../src/main.js';
import { useTestDatabase } from './db.js';
import { MACHINE, ScriptedApply, seedSession } from './engine/fixtures.js';

// M1b-T04: POST /api/sessions/:id/transition through the real EngineService wrapper with a
// scripted apply (the real transition logic is M1b-T03; the real-engine check is M1b-T10).
// Needs `pnpm db:up`.

const db = useTestDatabase();
let script: ScriptedApply;
let api: ApiHandle;
let base: string;

beforeAll(async () => {
  script = new ScriptedApply();
  const boardBus = new InMemoryBoardBus();
  const { engine } = createEngineService({
    db: db.pool,
    boardBus,
    apply: (...args) => script.apply(...args),
  });
  api = createApi({ db: db.pool, engine, boardBus, outputBus: new InMemoryOutputBus() });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  script = new ScriptedApply();
});

async function transition(id: string, body: unknown) {
  const res = await fetch(base + API_PATHS.sessionTransition(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A session parked in m1_basic's `needs_input` with an open agent question. */
async function waiting() {
  const seeded = await seedSession(db.pool, {
    status: 'needs_input',
    machine_id: MACHINE,
    workflow_state: 'needs_input',
    return_to: 'implement',
  });
  const ir = await db.pool.query<{ id: string }>(
    "INSERT INTO input_request (session_id, kind, question, return_to) VALUES ($1, 'agent_question', 'Who reviews?', 'implement') RETURNING id",
    [seeded.sessionId],
  );
  return { ...seeded, inputId: ir.rows[0]!.id };
}

const lastEvent = (): EngineEvent => script.calls.at(-1)!.event;

describe('POST /api/sessions/:id/transition', () => {
  it('202: human.transition with the ui actor and the open input_request; the session moves', async () => {
    const { sessionId, inputId } = await waiting();
    script.on('human.transition', (_s, ev) => ({
      snapshot: { status: 'waiting_external', workflow_state: 'build' },
      effects: [
        {
          type: 'state_entered',
          from: 'needs_input',
          to: 'build',
          visit: 1,
          transition: ev.type === 'human.transition' ? ev.name : null,
          reason: ev.type === 'human.transition' ? ev.text : null,
          actor: 'human',
        },
        { type: 'session_status', from: 'needs_input', to: 'waiting_external' },
      ],
    }));

    const res = await transition(sessionId, { name: 'waiting_on_someone', text: 'Dana' });
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(lastEvent()).toEqual({
      type: 'human.transition',
      name: 'waiting_on_someone',
      text: 'Dana',
      actor: UI_ACTOR,
      input_request_id: inputId,
    });

    const session = await db.pool.query<{ status: string; workflow_state: string }>(
      'SELECT status, workflow_state FROM session WHERE id = $1',
      [sessionId],
    );
    expect(session.rows[0]).toEqual({ status: 'waiting_external', workflow_state: 'build' });
    const ir = await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [
      inputId,
    ]);
    expect(ir.rows[0]).toMatchObject({ answer: 'Dana', answered_by: UI_ACTOR });

    const detail = SessionDetailSchema.parse(
      await (await fetch(`${base}/api/sessions/${sessionId}`)).json(),
    );
    expect(detail.moves).toEqual([
      {
        at: expect.any(String) as string,
        from: 'needs_input',
        to: 'build',
        transition: 'waiting_on_someone',
        reason: 'Dana',
        actor: 'human',
      },
    ]);
  });

  it('without text or an open request: text null, input_request_id null', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'waiting_external',
      machine_id: MACHINE,
      workflow_state: 'build',
    });
    script.on('human.transition', () => ({
      snapshot: { status: 'done', workflow_state: 'done' },
      effects: [{ type: 'session_status', from: 'waiting_external', to: 'done' }],
    }));
    expect((await transition(sessionId, { name: 'done' })).status).toBe(202);
    expect(lastEvent()).toEqual({
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: UI_ACTOR,
      input_request_id: null,
    });
  });

  it('409 conflict when apply ignores it; nothing answered', async () => {
    const { sessionId, inputId } = await waiting();
    for (const ignored of [
      'unknown_transition',
      'transition_not_allowed',
      'wrong_status',
    ] as const) {
      script.on('human.transition', () => ({ ignored }));
      const res = await transition(sessionId, { name: 'nope' });
      expect(res.status, ignored).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'conflict' });
      expect(String((res.body.error as { message: string }).message)).toContain(ignored);
    }
    const ir = await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [
      inputId,
    ]);
    expect(ir.rows[0]!.answer).toBeNull();
  });

  it('404 for an unknown or malformed session id', async () => {
    const unknown = await transition('00000000-0000-4000-8000-000000000000', { name: 'done' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: 'not_found' });
    expect((await transition('not-a-uuid', { name: 'done' })).status).toBe(404);
  });

  it('400 for a bad body', async () => {
    const { sessionId } = await waiting();
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'a', text: '  ' }]) {
      const res = await transition(sessionId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'bad_request' });
    }
    expect(script.calls).toEqual([]);
  });
});
