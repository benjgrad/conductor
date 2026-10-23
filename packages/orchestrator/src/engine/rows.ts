import {
  REVIEW_CONTEXT_KEY,
  ReviewStepSchema,
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

/** The session's newest open input_request, if any. */
export async function readOpenInput(
  tx: Queryable,
  sessionId: string,
): Promise<InputRequestRow | null> {
  const r = await tx.query<InputRequestRow>(
    'SELECT * FROM input_request WHERE session_id = $1 AND answer IS NULL ' +
      'ORDER BY created_at DESC, id LIMIT 1',
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
    ...splitReview(session.context),
  };
}

/**
 * ADR-0009: the review step lives in the `context` jsonb under REVIEW_CONTEXT_KEY (no column, no
 * migration); the snapshot carries it as `review` and a context without it.
 */
export function splitReview(stored: SessionRow['context']): {
  context: SessionSnapshot['context'];
  review: SessionSnapshot['review'];
} {
  const { [REVIEW_CONTEXT_KEY]: raw, ...context } = stored;
  if (raw === undefined) return { context, review: null };
  const parsed = ReviewStepSchema.safeParse(raw);
  return { context, review: parsed.success ? parsed.data : null };
}

/** The `context` jsonb to store: the snapshot's context plus its review step, if any. */
export function joinReview(s: Pick<SessionSnapshot, 'context' | 'review'>): JsonObject {
  const { [REVIEW_CONTEXT_KEY]: _dropped, ...context } = s.context;
  void _dropped;
  return s.review === null ? context : { ...context, [REVIEW_CONTEXT_KEY]: s.review };
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
      JSON.stringify(joinReview(s)),
      now,
    ],
  );
}
