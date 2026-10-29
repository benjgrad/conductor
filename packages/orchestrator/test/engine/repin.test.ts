import { randomUUID } from 'node:crypto';
import { CONDUCTOR_V2_DEF, CONDUCTOR_V4_DEF, type WorkflowDefinition } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { EventRow, SessionRow, TicketRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, seedSession } from './fixtures.js';

// M2-T34: a human acting on a parked session re-pins it, and its ticket, to the newest version of
// the workflow (repin.ts `repinParked`). A workflow of its own per test: version 1 is conductor
// v2 (with the personal `done` that closed UX-11 twice), version 2 is conductor v4. Needs
// `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-10-29T16:00:00.000Z');

let script: ScriptedApply;
let bus: InMemoryBoardBus;
/** The definition version each apply call was given. */
let seenVersions: number[];

beforeEach(() => {
  script = new ScriptedApply();
  bus = new InMemoryBoardBus();
  seenVersions = [];
});

const make = () =>
  createEngineService({
    db: db.pool,
    boardBus: bus,
    now: () => NOW,
    apply: (def, snap, event, now) => {
      seenVersions.push(def.version);
      return script.apply(def, snap, event, now);
    },
  });

/** A session on its own workflow (v2 then v4), parked at `state`. */
async function parked(overrides: Partial<Record<keyof SessionRow, unknown>> = {}) {
  const id = `repin_${randomUUID().slice(0, 8)}`;
  const defs: [number, WorkflowDefinition][] = [
    [1, CONDUCTOR_V2_DEF],
    [2, CONDUCTOR_V4_DEF],
  ];
  for (const [version, def] of defs) {
    await db.pool.query(
      'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, $2, $3)',
      [id, version, JSON.stringify({ ...def, id, version })],
    );
  }
  const seeded = await seedSession(db.pool, {
    status: 'needs_input',
    machine_id: MACHINE,
    workflow_state: 'needs_input',
    return_to: 'implementing',
    ...overrides,
  });
  await db.pool.query('UPDATE ticket SET workflow_id = $2 WHERE id = $1', [seeded.ticketId, id]);
  await db.pool.query('UPDATE session SET workflow_id = $2 WHERE id = $1', [seeded.sessionId, id]);
  return seeded;
}

const versions = async (sessionId: string, ticketId: string) => ({
  session: (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [sessionId]))
    .rows[0]!.workflow_version,
  ticket: (await db.pool.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId]))
    .rows[0]!.workflow_version,
});
const repinRows = async (sessionId: string) =>
  (
    await db.pool.query<EventRow>(
      "SELECT * FROM event WHERE session_id = $1 AND type = 'workflow.repinned'",
      [sessionId],
    )
  ).rows.map((r) => r.payload);

const answer = {
  type: 'human.transition' as const,
  name: 'answer',
  text: 'Yes, open the PR',
  actor: 'ui',
};

describe('repinParked (M2-T34)', () => {
  it('answering Needs input moves the session and ticket to the newest version before apply', async () => {
    const { sessionId, ticketId } = await parked();
    const { engine } = make();
    await engine.applyEvent(sessionId, answer);
    expect(seenVersions).toEqual([2]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 2, ticket: 2 });
    expect(await repinRows(sessionId)).toEqual([{ from: 1, to: 2 }]);
  });

  it('Waiting external (an event state) re-pins on a human move too', async () => {
    const { sessionId, ticketId } = await parked({
      status: 'waiting_external',
      workflow_state: 'waiting_external',
      return_to: null,
    });
    const { engine } = make();
    await engine.applyEvent(sessionId, {
      type: 'human.transition',
      name: 'back_to_implementing',
      text: null,
      actor: 'ui',
    });
    expect(seenVersions).toEqual([2]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 2, ticket: 2 });
  });

  it('a live agent process is never moved', async () => {
    const { sessionId, ticketId } = await parked({ agent_process_live: true });
    const { engine } = make();
    await engine.applyEvent(sessionId, answer);
    expect(seenVersions).toEqual([1]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 1, ticket: 1 });
    expect(await repinRows(sessionId)).toEqual([]);
  });

  it('a session in an agent state is not moved, even by a human event', async () => {
    const { sessionId, ticketId } = await parked({
      status: 'running',
      workflow_state: 'implementing',
      return_to: null,
    });
    const { engine } = make();
    await engine.applyEvent(sessionId, {
      type: 'human.fresh_conversation',
      text: 'Start over',
      actor: 'ui',
    });
    expect(seenVersions).toEqual([1]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 1, ticket: 1 });
  });

  it('a move the newest version does not have stays on the pinned one', async () => {
    const { sessionId, ticketId } = await parked();
    const { engine } = make();
    await engine.applyEvent(sessionId, { ...answer, name: 'no_such_move' });
    expect(seenVersions).toEqual([1]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 1, ticket: 1 });
  });

  it('a machine event (not a human) never re-pins', async () => {
    const { sessionId, ticketId } = await parked();
    const { engine } = make();
    await engine.applyEvent(sessionId, { type: 'external.event', name: 'ui.approve' });
    expect(seenVersions).toEqual([1]);
    expect(await versions(sessionId, ticketId)).toEqual({ session: 1, ticket: 1 });
  });
});
