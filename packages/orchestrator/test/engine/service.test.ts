import {
  BOARD_SSE_EVENT_TYPES,
  StartSessionPayloadSchema,
  boardSseEventFromRow,
  type BoardSseEvent,
} from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import { withTransaction } from '../../src/db/index.js';
import type { EventRow, InputRequestRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, assignScript, seedSession } from './fixtures.js';

// M1-T04b EngineService: the single-transaction write around apply(). Needs `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-10-22T12:00:00.000Z');

let script: ScriptedApply;
let bus: InMemoryBoardBus;
const make = () =>
  createEngineService({ db: db.pool, boardBus: bus, now: () => NOW, apply: script.apply });

beforeEach(() => {
  script = new ScriptedApply();
  bus = new InMemoryBoardBus();
});

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const events = async (id: string) =>
  (await db.pool.query<EventRow>('SELECT * FROM event WHERE session_id = $1 ORDER BY id', [id]))
    .rows;
const outbox = async (id: string) =>
  (await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [id]))
    .rows;

describe('applyEvent: rejections write nothing', () => {
  it('unknown session', async () => {
    const { engine } = make();
    const res = await engine.applyEvent('00000000-0000-4000-8000-000000000000', {
      type: 'operator.cancel',
    });
    expect(res).toEqual({ status: 'rejected', reason: 'unknown_session' });
  });

  it('stale fencing token', async () => {
    const { sessionId } = await seedSession(db.pool);
    const token = Number((await session(sessionId)).fencing_token);
    const { engine } = make();
    script.on('operator.cancel', () => ({ snapshot: { status: 'failed' } }));
    const res = await engine.applyEvent(
      sessionId,
      { type: 'operator.cancel' },
      { fencingToken: token - 1 },
    );
    expect(res).toEqual({ status: 'rejected', reason: 'stale_fencing_token' });
    expect(await events(sessionId)).toHaveLength(0);
    expect(script.calls).toHaveLength(0);
  });
});

describe('applyEvent: session.assigned (one transaction)', () => {
  it('writes the event, session, outbox and board rows, then publishes after commit', async () => {
    const { sessionId, ticketId, branch } = await seedSession(db.pool);
    script.on('session.assigned', assignScript);
    const { engine } = make();
    const res = await engine.applyEvent(sessionId, {
      type: 'session.assigned',
      machine_id: MACHINE,
    });
    expect(res.status).toBe('applied');
    if (res.status !== 'applied') return;

    // apply saw the DB row as a snapshot
    expect(script.calls[0]!.snap).toMatchObject({
      id: sessionId,
      status: 'queued',
      workflow_state: null,
      ticket: { id: ticketId, title: 'Add /health' },
    });

    const s = await session(sessionId);
    expect(s).toMatchObject({
      status: 'assigned',
      machine_id: MACHINE,
      workflow_state: 'implement',
      agent_process_live: false,
      state_visits: { implement: 1 },
    });
    expect(s.state_deadline?.toISOString()).toBe('2026-10-22T12:30:00.000Z');
    const t = await db.pool.query<{ status: string }>('SELECT status FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(t.rows[0]!.status).toBe('in_progress');

    // outbox: start_session with the wrapper's command_id, rendered prompt, row token
    const rows = await outbox(sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: 'start_session',
      target: `machine:${MACHINE}`,
      status: 'pending',
      attempts: 0,
      fencing_token: s.fencing_token,
    });
    expect(s.agent_command_id).toBe(row.command_id);
    const payload = StartSessionPayloadSchema.parse(row.payload);
    expect(payload).toMatchObject({
      command_id: row.command_id,
      ticket_id: ticketId,
      repo: 'github.com/x/app',
      base_ref: 'HEAD',
      branch,
      workflow_state: 'implement',
      tools: ['edit', 'bash', 'git'],
      resume_claude_session_id: null,
      env: { CONDUCTOR_SESSION_ID: sessionId, CONDUCTOR_TICKET_ID: ticketId },
    });
    expect(payload.prompt).toContain('Add /health');
    expect(payload.prompt).toContain('Return 200');
    expect(payload.prompt).not.toContain('{{');

    // event rows: engine event, state.entered (audit), then board rows in order
    const evs = await events(sessionId);
    expect(evs.map((e) => e.type)).toEqual([
      'session.assigned',
      'state.entered',
      'session.status',
      'card.upserted',
    ]);
    expect(res.eventId).toBe(Number(evs[0]!.id));
    expect(evs[0]!.payload).toEqual({ machine_id: MACHINE });
    expect(evs[1]!.payload).toEqual({ from: null, to: 'implement', visit: 1 });

    // queued → assigned stays in the Queued column: no card.moved
    const board = evs.map((e) => boardSseEventFromRow(e)).filter((e) => e !== null);
    expect(res.boardEvents).toEqual(board);
    expect(bus.published).toEqual(board);
    const card = res.boardEvents.at(-1) as Extract<BoardSseEvent, { type: 'card.upserted' }>;
    expect(card.card).toMatchObject({
      ticket_id: ticketId,
      session_id: sessionId,
      status: 'assigned',
      column: 'queued',
      workflow_state: 'implement',
      machine_id: MACHINE,
    });
  });

  it('with opts.tx: the caller commits and publishes; ROLLBACK leaves nothing', async () => {
    const { sessionId } = await seedSession(db.pool);
    script.on('session.assigned', assignScript);
    const { engine } = make();
    await expect(
      withTransaction(db.pool, async (tx) => {
        const res = await engine.applyEvent(
          sessionId,
          { type: 'session.assigned', machine_id: MACHINE },
          { tx },
        );
        expect(res.status).toBe('applied');
        throw new Error('caller aborts');
      }),
    ).rejects.toThrow('caller aborts');
    expect(bus.published).toHaveLength(0);
    expect(await events(sessionId)).toHaveLength(0);
    expect(await outbox(sessionId)).toHaveLength(0);
    expect((await session(sessionId)).status).toBe('queued');

    const res = await withTransaction(db.pool, (tx) =>
      engine.applyEvent(sessionId, { type: 'session.assigned', machine_id: MACHINE }, { tx }),
    );
    expect(bus.published).toHaveLength(0); // caller's job
    expect(res.status === 'applied' && res.boardEvents.length).toBe(2);
    expect(await outbox(sessionId)).toHaveLength(1);
  });

  it('is atomic: a failure after apply rolls everything back', async () => {
    const { sessionId } = await seedSession(db.pool);
    // start_session with no machine: commandPayloadForEffect throws mid-transaction
    script.on('session.assigned', (snap, ev, now, def) => {
      const out = assignScript(snap, ev, now, def);
      return { ...out, snapshot: { ...out.snapshot, machine_id: null } };
    });
    const { engine } = make();
    await expect(
      engine.applyEvent(sessionId, { type: 'session.assigned', machine_id: MACHINE }),
    ).rejects.toThrow(/without a machine/);
    expect(await events(sessionId)).toHaveLength(0);
    expect(await outbox(sessionId)).toHaveLength(0);
    expect((await session(sessionId)).status).toBe('queued');
    expect(bus.published).toHaveLength(0);
  });
});

describe('applyEvent: ignored', () => {
  it('writes only the engine event row (with the reason)', async () => {
    const { sessionId } = await seedSession(db.pool);
    const { engine } = make();
    const res = await engine.applyEvent(sessionId, {
      type: 'timer.fired',
      state: 'implement',
      deadline: NOW.toISOString(),
    });
    expect(res).toMatchObject({ status: 'ignored', reason: 'unexpected_event' });
    const evs = await events(sessionId);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ state: 'implement', ignored: 'unexpected_event' });
    expect(bus.published).toHaveLength(0);
  });

  it('records the arriving fencing token on the event row', async () => {
    const { sessionId } = await seedSession(db.pool);
    const token = Number((await session(sessionId)).fencing_token);
    const { engine } = make();
    await engine.applyEvent(
      sessionId,
      { type: 'agent.claude_session_id', claude_session_id: 'c1' },
      { fencingToken: token },
    );
    expect((await events(sessionId))[0]!.fencing_token).toBe(String(token));
  });
});

describe('applyEvent: wrapper-owned writes', () => {
  it('session.started writes worktree_path, branch and port_range', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'assigned',
      machine_id: MACHINE,
      workflow_state: 'implement',
    });
    script.on('session.started', () => ({
      snapshot: { status: 'running', agent_process_live: true },
      effects: [{ type: 'session_status', from: 'assigned', to: 'running' }],
    }));
    const { engine } = make();
    const res = await engine.applyEvent(sessionId, {
      type: 'session.started',
      command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
      worktree_path: '/w/x',
      branch: 'conductor/x/y',
      port_range: { base: 41000, count: 10 },
    });
    expect(res.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({
      worktree_path: '/w/x',
      branch: 'conductor/x/y',
      port_range: '[41000,41010)',
      status: 'running',
      agent_process_live: true,
    });
    // assigned (Queued) → running (Running): session.status, card.moved, card.upserted
    expect(bus.published.map((e) => e.type)).toEqual([
      'session.status',
      'card.moved',
      'card.upserted',
    ]);
    expect(bus.published[1]).toMatchObject({ from: 'queued', to: 'running' });
  });

  it('a non-ignored start_session refusal bumps the fencing token; an ignored one does not', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'assigned',
      machine_id: MACHINE,
      workflow_state: 'implement',
    });
    const t0 = BigInt((await session(sessionId)).fencing_token);
    const { engine } = make();
    script.on('command.refused', (snap, ev) =>
      ev.type === 'command.refused' && ev.reason === 'stale'
        ? { ignored: 'command_id_mismatch' }
        : {
            snapshot: { status: 'queued', machine_id: null, agent_command_id: null },
            effects: [
              { type: 'session_status', from: snap.status, to: 'queued' },
              { type: 'ticket_status', to: 'ready' },
            ],
          },
    );
    const refused = {
      type: 'command.refused' as const,
      command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
      command_kind: 'start_session' as const,
    };
    await engine.applyEvent(sessionId, { ...refused, reason: 'stale' });
    expect(BigInt((await session(sessionId)).fencing_token)).toBe(t0);
    const res = await engine.applyEvent(sessionId, { ...refused, reason: 'ack_timeout' });
    const s = await session(sessionId);
    expect(BigInt(s.fencing_token)).toBeGreaterThan(t0);
    expect(res.status === 'applied' && res.snapshot.fencing_token).toBe(Number(s.fencing_token));
    expect(s).toMatchObject({ status: 'queued', machine_id: null });
  });

  it('create_input_request inserts the row; input.provided records the answer', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'running',
      machine_id: MACHINE,
      workflow_state: 'implement',
      agent_process_live: true,
    });
    script
      .on('agent.ask_user', (_s, ev) => ({
        snapshot: { status: 'needs_input', workflow_state: 'needs_input', return_to: 'implement' },
        effects: [
          { type: 'session_status', from: 'running', to: 'needs_input' },
          {
            type: 'create_input_request',
            kind: 'agent_question',
            question: ev.type === 'agent.ask_user' ? ev.question : '',
            return_to: 'implement',
          },
        ],
      }))
      .on('input.provided', (_s, ev) => ({
        snapshot: {
          status: 'running',
          workflow_state: 'implement',
          pending_answer:
            ev.type === 'input.provided'
              ? { input_request_id: ev.input_request_id, answer: ev.answer }
              : null,
        },
        effects: [
          { type: 'session_status', from: 'needs_input', to: 'running' },
          {
            type: 'send_input',
            input_request_id: ev.type === 'input.provided' ? ev.input_request_id : '',
            text: 'yes',
          },
        ],
      }));
    const { engine } = make();
    const asked = await engine.applyEvent(sessionId, {
      type: 'agent.ask_user',
      question: 'Which port?',
    });
    expect(asked.status).toBe('applied');
    const ir = (
      await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE session_id = $1', [
        sessionId,
      ])
    ).rows[0]!;
    expect(ir).toMatchObject({ kind: 'agent_question', question: 'Which port?', answer: null });
    expect(bus.published.map((e) => e.type)).toEqual([
      'session.status',
      'card.moved',
      'input.requested',
      'card.upserted',
    ]);
    const upsert = bus.published.at(-1) as Extract<BoardSseEvent, { type: 'card.upserted' }>;
    expect(upsert.card.input_request?.id).toBe(ir.id);
    expect(upsert.card.column).toBe('needs_input');

    // rejections before apply
    const missing = await engine.applyEvent(sessionId, {
      type: 'input.provided',
      input_request_id: '00000000-0000-4000-8000-000000000000',
      answer: 'x',
    });
    expect(missing).toEqual({ status: 'rejected', reason: 'input_request_not_found' });
    const badGoto = await engine.applyEvent(sessionId, {
      type: 'input.provided',
      input_request_id: ir.id,
      answer: 'x',
      goto: 'nowhere',
    });
    expect(badGoto).toEqual({ status: 'rejected', reason: 'invalid_goto' });

    bus.published.length = 0;
    const answered = await engine.applyEvent(
      sessionId,
      { type: 'input.provided', input_request_id: ir.id, answer: '7400' },
      { actor: 'ben' },
    );
    expect(answered.status).toBe('applied');
    const after = (
      await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [ir.id])
    ).rows[0]!;
    expect(after).toMatchObject({ answer: '7400', answered_by: 'ben' });
    expect(after.answered_at?.toISOString()).toBe(NOW.toISOString());
    expect(bus.published.map((e) => e.type)).toEqual([
      'session.status',
      'card.moved',
      'input.answered',
      'card.upserted',
    ]);
    expect((await session(sessionId)).pending_answer).toEqual({
      input_request_id: ir.id,
      answer: '7400',
    });
    const rows = await outbox(sessionId);
    expect(rows.map((r) => r.kind)).toEqual(['send_input']);
    expect(rows[0]!.payload).toMatchObject({ input_request_id: ir.id, text: 'yes' });

    const again = await engine.applyEvent(sessionId, {
      type: 'input.provided',
      input_request_id: ir.id,
      answer: 'again',
    });
    expect(again).toEqual({ status: 'rejected', reason: 'input_already_answered' });
  });

  it('a resume prompt that is the pending answer is sent verbatim', async () => {
    const pending = {
      input_request_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      answer: 'use {{x}}',
    };
    const { sessionId } = await seedSession(db.pool, {
      workflow_state: 'implement',
      claude_session_id: 'c1',
      pending_answer: pending,
    });
    script.on('session.assigned', (_s, ev) => ({
      snapshot: {
        status: 'assigned',
        machine_id: ev.type === 'session.assigned' ? ev.machine_id : null,
      },
      effects: [
        { type: 'session_status', from: 'queued', to: 'assigned' },
        {
          type: 'start_session',
          state: 'implement',
          prompt: pending.answer,
          tools: ['edit'],
          resume_claude_session_id: 'c1',
        },
      ],
    }));
    const { engine } = make();
    await engine.applyEvent(sessionId, { type: 'session.assigned', machine_id: MACHINE });
    const payload = StartSessionPayloadSchema.parse((await outbox(sessionId))[0]!.payload);
    expect(payload.prompt).toBe('use {{x}}');
    expect(payload.resume_claude_session_id).toBe('c1');
  });

  it('every board row is decodable and backed by exactly one event row', async () => {
    const all = await db.pool.query<EventRow>(
      'SELECT * FROM event WHERE type = ANY($1) ORDER BY id',
      [BOARD_SSE_EVENT_TYPES],
    );
    expect(all.rows.length).toBeGreaterThan(0);
    for (const row of all.rows) expect(boardSseEventFromRow(row)).not.toBeNull();
  });
});
