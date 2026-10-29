import {
  SESSION_INPUT_REQUESTS_LIMIT,
  SESSION_MOVES_LIMIT,
  WorkflowDefinitionSchema,
  toBoardCard,
  toInputRequestDto,
  toMoveDto,
  toSessionInputRequest,
  type MoveDto,
  type SessionDetail,
  type SessionInputRequest,
} from '@conductor/shared';
import type { OutputBus, Queryable } from '../contracts.js';
import { cardView } from '../engine/board-view.js';
import {
  OPEN_INPUT_SELECT,
  splitStep,
  TICKET_SELECT,
  type OpenInputRow,
  type TicketCardRow,
} from '../engine/rows.js';
import { readCardPermission, withPermission } from '../permissions/store.js';
import type { EventRow, InputRequestRow, SessionRow, WorkflowDefinitionRow } from '../db/types.js';

// GET /api/sessions/:id (M1-T08).

/**
 * The output ring is in memory (U-005): a session created before this process started may have
 * had output the ring never saw (`output_complete`).
 */
const PROCESS_STARTED_AT = Date.now();

export async function sessionExists(db: Queryable, id: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM session WHERE id = $1', [id]);
  return res.rowCount === 1;
}

/**
 * ADR-0011: the session's last SESSION_MOVES_LIMIT `state.entered` rows, oldest first. One query
 * on `event_session_id_idx (session_id, id)`, newest first, reversed here.
 */
export async function loadMoves(db: Queryable, id: string): Promise<MoveDto[]> {
  const res = await db.query<Pick<EventRow, 'ts' | 'payload'>>(
    "SELECT ts, payload FROM event WHERE session_id = $1 AND type = 'state.entered' " +
      'ORDER BY id DESC LIMIT $2',
    [id, SESSION_MOVES_LIMIT],
  );
  const moves: MoveDto[] = [];
  for (const row of res.rows.reverse()) {
    // A malformed row (none are written; hand-edited data) drops out of the timeline rather than
    // failing the whole detail.
    try {
      moves.push(toMoveDto(row));
    } catch {
      continue;
    }
  }
  return moves;
}

/**
 * UX-7: the session's last SESSION_INPUT_REQUESTS_LIMIT input requests, answered or not, oldest
 * first; question and answer clipped (`toSessionInputRequest`).
 */
export async function loadInputRequests(db: Queryable, id: string): Promise<SessionInputRequest[]> {
  const res = await db.query<
    Pick<InputRequestRow, 'id' | 'kind' | 'question' | 'created_at' | 'answer' | 'answered_at'>
  >(
    'SELECT id, kind, question, created_at, answer, answered_at FROM input_request ' +
      'WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [id, SESSION_INPUT_REQUESTS_LIMIT],
  );
  return res.rows.reverse().map(toSessionInputRequest);
}

/** null = no such session. */
export async function loadSessionDetail(
  db: Queryable,
  outputBus: OutputBus,
  id: string,
): Promise<SessionDetail | null> {
  const s = await db.query<SessionRow & { created_at: Date }>(
    'SELECT * FROM session WHERE id = $1',
    [id],
  );
  const session = s.rows[0];
  if (!session) return null;
  const [t, wd, ir, moves, inputRequests, permission] = await Promise.all([
    db.query<TicketCardRow>(TICKET_SELECT + 'WHERE t.id = $1', [session.ticket_id]),
    db.query<WorkflowDefinitionRow>(
      'SELECT * FROM workflow_definition WHERE id = $1 AND version = $2',
      [session.workflow_id, session.workflow_version],
    ),
    db.query<OpenInputRow>(
      OPEN_INPUT_SELECT +
        'WHERE ir.session_id = $1 AND ir.answer IS NULL ORDER BY ir.created_at DESC LIMIT 1',
      [id],
    ),
    loadMoves(db, id),
    loadInputRequests(db, id),
    readCardPermission(db, id),
  ]);
  const ticket = t.rows[0];
  const defRow = wd.rows[0];
  if (!ticket || !defRow) {
    throw new Error(`session ${id}: ticket or workflow ${session.workflow_id} missing`);
  }
  const workflow = WorkflowDefinitionSchema.parse(defRow.definition);
  // A cancel leaves the request unanswered; only a needs_input session is waiting on it (TD-079).
  const openInput = session.status === 'needs_input' ? (ir.rows[0] ?? null) : null;
  return {
    card: withPermission(
      toBoardCard(
        ticket,
        session,
        openInput,
        await cardView(db, session.workflow_id, session.workflow_version),
      ),
      permission,
    ),
    workflow,
    workflow_version: session.workflow_version,
    // ADR-0009: the in-progress review step is engine state, not a state result.
    context: splitStep(session.context).context,
    retry_counters: session.retry_counters,
    state_visits: session.state_visits,
    return_to: session.return_to,
    state_entered_at: session.state_entered_at.toISOString(),
    state_deadline: session.state_deadline ? session.state_deadline.toISOString() : null,
    spend_usd: Number(session.spend_usd),
    wall_seconds: Number(session.wall_seconds),
    budget: { usd: workflow.budget.usd, minutes: workflow.budget.minutes },
    branch: session.branch,
    worktree_path: session.worktree_path,
    pending_input: openInput ? toInputRequestDto(openInput) : null,
    recent_output: outputBus.snapshot(id),
    output_complete: outputBus.complete(id) && session.created_at.getTime() >= PROCESS_STARTED_AT,
    moves,
    ticket_body: ticket.body,
    input_requests: inputRequests,
    agent_name: ticket.agent_name,
  };
}
