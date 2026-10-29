import {
  WorkflowDefinitionSchema,
  type EngineEvent,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import type { SessionRow } from '../db/types.js';

// M2-T34 (Ben, 2026-10-29): a ticket follows the newest version of its workflow whenever no agent
// is running for it. A version pinned at the first claim used to stay for the ticket's life, so a
// workflow fix never reached the tickets already on the board: UX-11 was reopened on conductor v2
// and closed itself again through v2's personal `done`. Two moments re-pin:
// - a reopen (`reopenVersion`): the new session starts at `def.start`;
// - a human acting on a session parked in a human or event state (`repinParked`): Needs input's
//   answer goes back to Implementing on the new version, not the old one.
// A running agent is never moved: its state, tools and transitions stay those it was started with.

async function latestDefinition(
  tx: Queryable,
  workflowId: string,
): Promise<{ version: number; def: WorkflowDefinition } | null> {
  const r = await tx.query<{ version: number; definition: unknown }>(
    'SELECT version, definition FROM workflow_definition WHERE id = $1 ' +
      'ORDER BY version DESC LIMIT 1',
    [workflowId],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const parsed = WorkflowDefinitionSchema.safeParse(row.definition);
  return parsed.success ? { version: row.version, def: parsed.data } : null;
}

/**
 * The version a reopened session runs: the newest stored version of the workflow when it has the
 * start state (a reopen always enters `def.start`, ADR-0008), else the old session's.
 */
export async function reopenVersion(
  tx: Queryable,
  workflowId: string,
  oldVersion: number,
): Promise<number> {
  const latest = await latestDefinition(tx, workflowId);
  if (latest === null || latest.version <= oldVersion) return oldVersion;
  return latest.def.states[latest.def.start] !== undefined ? latest.version : oldVersion;
}

/** The events a human sends to a parked session. */
const HUMAN_EVENTS: ReadonlySet<EngineEvent['type']> = new Set([
  'input.provided',
  'human.transition',
  'human.fresh_conversation',
]);

/**
 * The newer version a human event re-pins `session` to, or null to stay. Only when no agent
 * process is live, the session sits in a human or event state that the newer version has with the
 * same type, the state it returns to (`return_to`) exists there, and a named move
 * (`human.transition`) is one of that state's transitions there. Anything else stays where it is
 * rather than risk an event the pinned version would have taken.
 */
export async function repinParked(
  tx: Queryable,
  session: SessionRow,
  current: WorkflowDefinition,
  event: EngineEvent,
): Promise<number | null> {
  if (!HUMAN_EVENTS.has(event.type) || session.agent_process_live) return null;
  const at = session.workflow_state;
  const state = at === null ? undefined : current.states[at];
  if (at === null || (state?.type !== 'human' && state?.type !== 'event')) return null;
  const latest = await latestDefinition(tx, session.workflow_id);
  if (latest === null || latest.version <= session.workflow_version) return null;
  const next = latest.def.states[at];
  if (next?.type !== state.type) return null;
  if (session.return_to !== null && latest.def.states[session.return_to] === undefined) return null;
  if (event.type === 'input.provided' && event.goto !== undefined) {
    if (latest.def.states[event.goto] === undefined) return null;
  }
  if (event.type === 'human.transition' && next.on?.[event.name] === undefined) return null;
  return latest.version;
}
