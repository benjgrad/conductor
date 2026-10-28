import type { AddressInfo } from 'node:net';
import { API_PATHS, SessionDetailSchema } from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, UI_ACTOR } from '../src/api/index.js';
import { InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { InputRequestRow } from '../src/db/types.js';
import { createEngineService } from '../src/engine/index.js';
import type { ApiHandle } from '../src/main.js';
import { useTestDatabase } from './db.js';
import { MACHINE, seedSession } from './engine/fixtures.js';

// POST /api/sessions/:id/fresh-conversation ("Start fresh conversation…", 10-contracts §Fresh
// conversation) through the real EngineService wrapper and the real apply. Needs `pnpm db:up`.

const db = useTestDatabase();
let api: ApiHandle;
let base: string;

const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
const TEXT = 'Start over; the tests live in test/.';

beforeAll(async () => {
  const boardBus = new InMemoryBoardBus();
  const { engine } = createEngineService({ db: db.pool, boardBus });
  api = createApi({ db: db.pool, engine, boardBus, outputBus: new InMemoryOutputBus() });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await api.close();
});

async function freshConversation(id: string, body: unknown) {
  const res = await fetch(base + API_PATHS.sessionFreshConversation(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** m1_basic parked in `needs_input` after the agent of `implement` failed, with an open request. */
async function stuck(overrides: Record<string, unknown> = {}) {
  const seeded = await seedSession(db.pool, {
    status: 'needs_input',
    machine_id: MACHINE,
    workflow_state: 'needs_input',
    return_to: 'implement',
    claude_session_id: CLAUDE,
    fencing_token: 5,
    ...overrides,
  });
  const ir = await db.pool.query<{ id: string }>(
    'INSERT INTO input_request (session_id, kind, question, return_to) ' +
      "VALUES ($1, 'retries_exhausted', 'implement: the agent exited (exit code 1: boom)', 'implement') RETURNING id",
    [seeded.sessionId],
  );
  return { ...seeded, inputId: ir.rows[0]!.id };
}

async function sessionRow(id: string) {
  const r = await db.pool.query<{
    status: string;
    workflow_state: string;
    claude_session_id: string | null;
    fencing_token: string;
  }>('SELECT status, workflow_state, claude_session_id, fencing_token FROM session WHERE id = $1', [
    id,
  ]);
  return r.rows[0]!;
}

describe('POST /api/sessions/:id/fresh-conversation', () => {
  it('202: forgets the conversation, answers the request, starts the full prompt fresh', async () => {
    const { sessionId, inputId } = await stuck();
    const res = await freshConversation(sessionId, { text: `  ${TEXT}  ` });
    expect(res).toEqual({ status: 202, body: { ok: true } });

    const s = await sessionRow(sessionId);
    expect(s).toMatchObject({
      status: 'running',
      workflow_state: 'implement',
      claude_session_id: null,
    });
    expect(Number(s.fencing_token)).not.toBe(5); // bumped: the old process is stale

    const ir = await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [
      inputId,
    ]);
    expect(ir.rows[0]).toMatchObject({ answer: TEXT, answered_by: UI_ACTOR });

    const out = await db.pool.query<{ kind: string; payload: Record<string, unknown> }>(
      'SELECT kind, payload FROM outbox WHERE session_id = $1 ORDER BY created_at',
      [sessionId],
    );
    const start = out.rows.find((r) => r.kind === 'start_session')!;
    expect(start.payload.resume_claude_session_id).toBeNull();
    expect(String(start.payload.prompt)).toContain(`## Answer from a human\n\n${TEXT}`);

    const ev = await db.pool.query<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM event WHERE session_id = $1 ORDER BY id',
      [sessionId],
    );
    expect(ev.rows.find((r) => r.type === 'conversation.reset')?.payload).toEqual({
      claude_session_id: CLAUDE,
      reason: 'user_requested',
    });
    expect(ev.rows.find((r) => r.type === 'human.fresh_conversation')?.payload).toMatchObject({
      text: TEXT,
      actor: UI_ACTOR,
      input_request_id: inputId,
    });

    const detail = SessionDetailSchema.parse(
      await (await fetch(`${base}/api/sessions/${sessionId}`)).json(),
    );
    expect(detail.moves?.at(-1)).toMatchObject({
      from: 'needs_input',
      to: 'implement',
      transition: 'fresh_conversation',
      reason: TEXT,
      actor: 'human',
    });
  });

  it('without a machine: queued with the answer pending', async () => {
    const { sessionId } = await stuck({ machine_id: null });
    expect((await freshConversation(sessionId, { text: TEXT })).status).toBe(202);
    const s = await sessionRow(sessionId);
    expect(s).toMatchObject({ status: 'queued', claude_session_id: null });
    const r = await db.pool.query<{ pending_answer: unknown }>(
      'SELECT pending_answer FROM session WHERE id = $1',
      [sessionId],
    );
    expect(r.rows[0]!.pending_answer).toMatchObject({ answer: TEXT });
  });

  it('409 conflict with a clear message when the session is not parked; nothing answered', async () => {
    const { sessionId, inputId } = await stuck({ status: 'running', workflow_state: 'implement' });
    const res = await freshConversation(sessionId, { text: TEXT });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict' });
    expect(String((res.body.error as { message: string }).message)).toContain(
      'not waiting on a human with an agent to return to',
    );
    const ir = await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [
      inputId,
    ]);
    expect(ir.rows[0]!.answer).toBeNull();
    expect((await sessionRow(sessionId)).claude_session_id).toBe(CLAUDE);
  });

  it('409 when return_to is not an agent state', async () => {
    const { sessionId } = await stuck({ return_to: 'build' });
    expect((await freshConversation(sessionId, { text: TEXT })).status).toBe(409);
  });

  it('404 for an unknown or malformed session id', async () => {
    const unknown = await freshConversation('00000000-0000-4000-8000-000000000000', {
      text: TEXT,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: 'not_found' });
    expect((await freshConversation('not-a-uuid', { text: TEXT })).status).toBe(404);
  });

  it('400 for a bad body', async () => {
    const { sessionId } = await stuck();
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(20_001) }]) {
      const res = await freshConversation(sessionId, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'bad_request' });
    }
    expect((await sessionRow(sessionId)).claude_session_id).toBe(CLAUDE);
  });
});
