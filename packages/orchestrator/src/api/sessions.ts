import {
  WorkflowDefinitionSchema,
  toBoardCard,
  toInputRequestDto,
  type SessionDetail,
} from '@conductor/shared';
import type { OutputBus, Queryable } from '../contracts.js';
import { cardView } from '../engine/board-view.js';
import { splitStep } from '../engine/rows.js';
import type { InputRequestRow, SessionRow, TicketRow, WorkflowDefinitionRow } from '../db/types.js';

// GET /api/sessions/:id (M1-T08).

export async function sessionExists(db: Queryable, id: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM session WHERE id = $1', [id]);
  return res.rowCount === 1;
}

/** null = no such session. */
export async function loadSessionDetail(
  db: Queryable,
  outputBus: OutputBus,
  id: string,
): Promise<SessionDetail | null> {
  const s = await db.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);
  const session = s.rows[0];
  if (!session) return null;
  const [t, wd, ir] = await Promise.all([
    db.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [session.ticket_id]),
    db.query<WorkflowDefinitionRow>(
      'SELECT * FROM workflow_definition WHERE id = $1 AND version = $2',
      [session.workflow_id, session.workflow_version],
    ),
    db.query<InputRequestRow>(
      'SELECT * FROM input_request WHERE session_id = $1 AND answer IS NULL ' +
        'ORDER BY created_at DESC LIMIT 1',
      [id],
    ),
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
    card: toBoardCard(
      ticket,
      session,
      openInput,
      await cardView(db, session.workflow_id, session.workflow_version),
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
  };
}
