import {
  GateStepSchema,
  REVIEW_CONTEXT_KEY,
  STEP_CONTEXT_KEY,
  WorkflowDefinitionSchema,
  type JsonObject,
  type SessionSnapshot,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import type { InputRequestRow, SessionRow, TicketRow } from '../db/types.js';

// Row ⇄ engine-shape conversions and the reads the EngineService needs (M1-T04b).

export interface LockedSession {
  session: SessionRow;
  ticket: TicketRow;
}

/** `SELECT … FOR UPDATE` the session (and its ticket). null = unknown session. */
export async function lockSession(tx: Queryable, sessionId: string): Promise<LockedSession | null> {
  const s = await tx.query<SessionRow>('SELECT * FROM session WHERE id = $1 FOR UPDATE', [
    sessionId,
  ]);
  const session = s.rows[0];
  if (!session) return null;
  const t = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [session.ticket_id]);
  return { session, ticket: t.rows[0]! };
}

export async function readSession(tx: Queryable, sessionId: string): Promise<SessionRow> {
  const s = await tx.query<SessionRow>('SELECT * FROM session WHERE id = $1', [sessionId]);
  return s.rows[0]!;
}

export async function readTicket(tx: Queryable, ticketId: string): Promise<TicketRow> {
  const t = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId]);
  return t.rows[0]!;
}

/** An input_request row with its origin (UX-4): the latest `state.entered` row's transition/from. */
export type OpenInputRow = InputRequestRow & {
  origin_transition: string | null;
  origin_from: string | null;
};

/**
 * UX-4: `SELECT ir.*` plus the origin columns, from `input_request ir` and the session's latest
 * `state.entered` row (`event_session_id_idx`). While the request is open and the session is
 * `needs_input`, that row is the move that entered the human state. Append WHERE / ORDER BY.
 */
export const OPEN_INPUT_SELECT =
  "SELECT ir.*, se.payload->>'transition' AS origin_transition, " +
  "se.payload->>'from' AS origin_from FROM input_request ir " +
  'LEFT JOIN LATERAL (SELECT e.payload FROM event e WHERE e.session_id = ir.session_id ' +
  "AND e.type = 'state.entered' ORDER BY e.id DESC LIMIT 1) se ON true ";

/** The session's newest open input_request, if any, with its origin. */
export async function readOpenInput(
  tx: Queryable,
  sessionId: string,
): Promise<OpenInputRow | null> {
  const r = await tx.query<OpenInputRow>(
    OPEN_INPUT_SELECT +
      'WHERE ir.session_id = $1 AND ir.answer IS NULL ORDER BY ir.created_at DESC, ir.id LIMIT 1',
    [sessionId],
  );
  return r.rows[0] ?? null;
}

/**
 * Workflow definitions are immutable per (id, version) (05 §Versioning), so a process-wide cache
 * is safe.
 */
export class DefinitionCache {
  private readonly cache = new Map<string, WorkflowDefinition>();

  async get(tx: Queryable, id: string, version: number): Promise<WorkflowDefinition> {
    const key = `${id}@${version}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = await tx.query<{ definition: unknown }>(
      'SELECT definition FROM workflow_definition WHERE id = $1 AND version = $2',
      [id, version],
    );
    if (!r.rows[0]) throw new Error(`workflow ${key} not found`);
    const def = WorkflowDefinitionSchema.parse(r.rows[0].definition);
    this.cache.set(key, def);
    return def;
  }
}

const iso = (d: Date): string => d.toISOString();

export function toSnapshot(session: SessionRow, ticket: TicketRow): SessionSnapshot {
  return {
    id: session.id,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      body: ticket.body,
      repo: ticket.repo,
      external_ref: ticket.external_ref,
      // ADR-0011: the `ticket.kind` column arrives with M1b-T04's migration (TicketRow gains it
      // then); `SELECT *` rows carry it from that moment, so this needs no change.
      kind: (ticket as Partial<Pick<SessionSnapshot['ticket'], 'kind'>>).kind ?? null,
    },
    machine_id: session.machine_id,
    workflow_id: session.workflow_id,
    workflow_version: session.workflow_version,
    workflow_state: session.workflow_state,
    status: session.status,
    fencing_token: Number(session.fencing_token),
    claude_session_id: session.claude_session_id,
    agent_command_id: session.agent_command_id,
    agent_process_live: session.agent_process_live,
    pending_answer: session.pending_answer,
    retry_counters: session.retry_counters,
    state_visits: session.state_visits,
    state_entered_at: iso(session.state_entered_at),
    state_deadline: session.state_deadline === null ? null : iso(session.state_deadline),
    return_to: session.return_to,
    spend_usd: Number(session.spend_usd),
    claude_spend_totals: session.claude_spend_totals,
    wall_seconds: Number(session.wall_seconds),
    ...splitStep(session.context),
  };
}

/**
 * The gate step (ADR-0009 review / ADR-0010 entry) lives in the `context` jsonb under
 * STEP_CONTEXT_KEY (no column, no migration); rows written before ADR-0010 have it under
 * REVIEW_CONTEXT_KEY. The snapshot carries it as `step` and a context without either key.
 */
export function splitStep(stored: SessionRow['context']): {
  context: SessionSnapshot['context'];
  step: SessionSnapshot['step'];
} {
  const { [STEP_CONTEXT_KEY]: raw, [REVIEW_CONTEXT_KEY]: legacy, ...context } = stored;
  const value = raw ?? legacy;
  if (value === undefined) return { context, step: null };
  const parsed = GateStepSchema.safeParse(value);
  return { context, step: parsed.success ? parsed.data : null };
}

/** The `context` jsonb to store: the snapshot's context plus its gate step, if any. */
export function joinStep(s: Pick<SessionSnapshot, 'context' | 'step'>): JsonObject {
  const { [STEP_CONTEXT_KEY]: _a, [REVIEW_CONTEXT_KEY]: _b, ...context } = s.context;
  void _a;
  void _b;
  return s.step === null ? context : { ...context, [STEP_CONTEXT_KEY]: s.step };
}

/** Write every apply-owned session column from the snapshot (plus updated_at). */
export async function writeSession(
  tx: Queryable,
  s: SessionSnapshot,
  fencingToken: string,
  now: Date,
): Promise<void> {
  await tx.query(
    `UPDATE session SET
       machine_id = $2, workflow_state = $3, status = $4, fencing_token = $5,
       claude_session_id = $6, agent_command_id = $7, agent_process_live = $8,
       pending_answer = $9, retry_counters = $10, state_visits = $11, state_entered_at = $12,
       state_deadline = $13, return_to = $14, spend_usd = $15, claude_spend_totals = $16,
       wall_seconds = $17, context = $18, updated_at = $19
     WHERE id = $1`,
    [
      s.id,
      s.machine_id,
      s.workflow_state,
      s.status,
      fencingToken,
      s.claude_session_id,
      s.agent_command_id,
      s.agent_process_live,
      s.pending_answer === null ? null : JSON.stringify(s.pending_answer),
      JSON.stringify(s.retry_counters),
      JSON.stringify(s.state_visits),
      s.state_entered_at,
      s.state_deadline,
      s.return_to,
      s.spend_usd,
      JSON.stringify(s.claude_spend_totals),
      s.wall_seconds,
      JSON.stringify(joinStep(s)),
      now,
    ],
  );
}
