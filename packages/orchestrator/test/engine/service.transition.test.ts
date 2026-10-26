import { toMoveDto, type BoardSseEvent } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { EventRow, InputRequestRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, seedSession } from './fixtures.js';

// M1b-T01: the EngineService wrapper's ADR-0011 writes, with a scripted apply (the real one
// lands in M1b-T03): `state_entered` carries transition / reason / actor into the event row,
// and an applied `human.transition` answers the open input_request. Needs `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-10-26T12:00:00.000Z');

let script: ScriptedApply;
let bus: InMemoryBoardBus;
const make = () =>
  createEngineService({ db: db.pool, boardBus: bus, now: () => NOW, apply: script.apply });

beforeEach(() => {
  script = new ScriptedApply();
  bus = new InMemoryBoardBus();
});

describe('EngineService: ADR-0011 wrapper writes', () => {
  it('human.transition answers the open input_request and the move lands in state.entered', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'running',
      machine_id: MACHINE,
      workflow_state: 'implement',
      agent_process_live: true,
    });
    script
      .on('agent.ask_user', () => ({
        snapshot: { status: 'needs_input', workflow_state: 'needs_input', return_to: 'implement' },
        effects: [
          { type: 'session_status', from: 'running', to: 'needs_input' },
          {
            type: 'create_input_request',
            kind: 'agent_question',
            question: 'Who reviews?',
            return_to: 'implement',
          },
        ],
      }))
      .on('human.transition', (_s, ev) => ({
        snapshot: { status: 'waiting_external', workflow_state: 'waiting_external' },
        effects: [
          {
            type: 'state_entered',
            from: 'needs_input',
            to: 'waiting_external',
            visit: 1,
            transition: ev.type === 'human.transition' ? ev.name : null,
            reason: ev.type === 'human.transition' ? ev.text : null,
            actor: 'human',
          },
          { type: 'session_status', from: 'needs_input', to: 'waiting_external' },
        ],
      }));
    const { engine } = make();
    await engine.applyEvent(sessionId, { type: 'agent.ask_user', question: 'Who reviews?' });
    bus.published.length = 0;

    const res = await engine.applyEvent(sessionId, {
      type: 'human.transition',
      name: 'waiting_on_someone',
      text: 'Dana, for the API review',
      actor: 'ui',
    });
    expect(res.status).toBe('applied');

    const ir = (
      await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE session_id = $1', [
        sessionId,
      ])
    ).rows[0]!;
    expect(ir).toMatchObject({ answer: 'Dana, for the API review', answered_by: 'ui' });
    expect(ir.answered_at).toEqual(NOW);
    const answered = bus.published.find((e) => e.type === 'input.answered') as Extract<
      BoardSseEvent,
      { type: 'input.answered' }
    >;
    expect(answered).toMatchObject({ input_request_id: ir.id, answered_by: 'ui' });

    const rows = (
      await db.pool.query<EventRow>(
        "SELECT * FROM event WHERE session_id = $1 AND type = 'state.entered' ORDER BY id",
        [sessionId],
      )
    ).rows;
    // event.ts is the database clock (DEFAULT now()), not the wrapper's `now`.
    expect(rows.map((r) => toMoveDto(r))).toEqual([
      {
        at: rows[0]!.ts.toISOString(),
        from: 'needs_input',
        to: 'waiting_external',
        transition: 'waiting_on_someone',
        reason: 'Dana, for the API review',
        actor: 'human',
      },
    ]);
  });

  it('a human.transition without text answers "[<name>]"; an ignored one answers nothing', async () => {
    const { sessionId } = await seedSession(db.pool, {
      status: 'needs_input',
      machine_id: MACHINE,
      workflow_state: 'needs_input',
    });
    await db.pool.query(
      "INSERT INTO input_request (id, session_id, kind, question, return_to) VALUES (gen_random_uuid(), $1, 'agent_question', 'q', 'implement')",
      [sessionId],
    );
    const { engine } = make();
    // unscripted → ignored (unexpected_event): nothing answered
    const ignored = await engine.applyEvent(sessionId, {
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
    });
    expect(ignored.status).toBe('ignored');
    const open = async () =>
      (
        await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE session_id = $1', [
          sessionId,
        ])
      ).rows[0]!;
    expect((await open()).answer).toBeNull();

    script.on('human.transition', () => ({
      snapshot: { status: 'done', workflow_state: 'done' },
      effects: [{ type: 'session_status', from: 'needs_input', to: 'done' }],
    }));
    await engine.applyEvent(sessionId, {
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
    });
    expect(await open()).toMatchObject({ answer: '[done]', answered_by: 'ui' });
  });

  it('a pre-M1b state.entered row (from, to, visit only) still reads as a move', () => {
    expect(toMoveDto({ ts: NOW, payload: { from: null, to: 'implement', visit: 1 } })).toEqual({
      at: NOW.toISOString(),
      from: null,
      to: 'implement',
      transition: null,
      reason: null,
      actor: null,
    });
  });
});
