import {
  CONDUCTOR_WORKFLOW_ID,
  toBoardCard,
  type BoardCard,
  type BoardColumnInfo,
  type BoardResponse,
  type MachineDto,
  type TicketDto,
  type WorkflowDetail,
  type WorkflowSummary,
  WorkflowDefinitionSchema,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { CardViews } from '../engine/board-view.js';
import type { Db } from '../main.js';
import type {
  InputRequestRow,
  MachineRow,
  SessionRow,
  TicketRow,
  WorkflowDefinitionRow,
} from '../db/types.js';
import { maxBoardEventId } from '../stream/board.js';

// Read models for the REST API (M1-T08). Cards always come from `toBoardCard` (10-contracts).

/** Statuses that hold a machine slot, for the fleet view's `running_sessions`. */
const SLOT_STATUSES = ['assigned', 'running', 'needs_input', 'waiting_external'];

/** Run `fn` in a read-only REPEATABLE READ transaction (one consistent snapshot). */
async function withSnapshot<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const ms = (t: string): number => Date.parse(t);

/** 06 §Kanban columns sort order, by the column's kind (ADR-0010). */
function sortColumn(kind: BoardColumnInfo['kind'], cards: BoardCard[]): BoardCard[] {
  const byCreated = (a: BoardCard, b: BoardCard) => ms(a.created_at) - ms(b.created_at);
  const recentFirst = (a: BoardCard, b: BoardCard) => ms(b.updated_at) - ms(a.updated_at);
  switch (kind) {
    case 'queued':
      return cards.sort((a, b) => b.priority - a.priority || byCreated(a, b));
    case 'agent':
    case 'command':
    case 'connector':
      return cards.sort(recentFirst);
    case 'human':
      // Oldest open input_request first; a card without one (shouldn't happen) goes last.
      return cards.sort((a, b) => {
        const ta = a.input_request ? ms(a.input_request.created_at) : Infinity;
        const tb = b.input_request ? ms(b.input_request.created_at) : Infinity;
        return ta - tb || byCreated(a, b);
      });
    case 'event':
      return cards.sort(byCreated);
    case 'terminal':
      return cards.sort(recentFirst);
  }
}

/**
 * GET /api/board. One snapshot transaction, so `last_event_id` matches the cards exactly: board
 * rows are written in the same transaction as the state they describe and commit in id order,
 * so the snapshot contains precisely the board events ≤ last_event_id.
 */
export function loadBoard(db: Db): Promise<BoardResponse> {
  return withSnapshot(db, async (q) => {
    const tickets = await q.query<TicketRow>('SELECT * FROM ticket ORDER BY created_at');
    const sessions = await q.query<SessionRow>(
      'SELECT DISTINCT ON (ticket_id) * FROM session ORDER BY ticket_id, created_at DESC',
    );
    const inputs = await q.query<InputRequestRow>(
      'SELECT DISTINCT ON (session_id) * FROM input_request WHERE answer IS NULL ' +
        'ORDER BY session_id, created_at DESC',
    );
    const lastEventId = await maxBoardEventId(q);

    const sessionByTicket = new Map(sessions.rows.map((s) => [s.ticket_id, s]));
    const inputBySession = new Map(inputs.rows.map((i) => [i.session_id, i]));
    const views = new CardViews(q);
    const layout = await views.boardColumns();
    const cards = new Map<string, BoardCard[]>(layout.map((c) => [c.id, []]));
    for (const ticket of tickets.rows) {
      const session = sessionByTicket.get(ticket.id) ?? null;
      const view = await views.view(
        session?.workflow_id ?? ticket.workflow_id,
        session?.workflow_version ?? ticket.workflow_version,
      );
      const card = toBoardCard(
        ticket,
        session,
        session ? (inputBySession.get(session.id) ?? null) : null,
        view,
      );
      // placeCard only returns ids of `layout`; anything else would be a bug, shown in Queued.
      (cards.get(card.column) ?? cards.get(layout[0]!.id)!).push(card);
    }
    const columns = layout.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      cards: sortColumn(c.kind, cards.get(c.id)!),
    }));
    return { columns, last_event_id: lastEventId };
  });
}

export function toTicketDto(row: TicketRow): TicketDto {
  return {
    id: row.id,
    external_ref: row.external_ref,
    repo: row.repo,
    title: row.title,
    body: row.body,
    workflow_id: row.workflow_id,
    workflow_version: row.workflow_version,
    required_tags: row.required_tags,
    repo_allow_machines: row.repo_allow_machines,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at.toISOString(),
    kind: row.kind,
  };
}

/**
 * Latest version of each workflow id. ADR-0010: only `conductor` unless `all` (older workflows
 * stay in the database so their tickets still render, but nothing offers them any more).
 */
export async function listWorkflows(db: Queryable, all = false): Promise<WorkflowSummary[]> {
  const res = await db.query<WorkflowDefinitionRow>(
    'SELECT DISTINCT ON (id) * FROM workflow_definition WHERE $1::boolean OR id = $2 ' +
      'ORDER BY id, version DESC',
    [all, CONDUCTOR_WORKFLOW_ID],
  );
  return res.rows.map((r) => ({
    id: r.id,
    version: r.version,
    start: r.definition.start,
    state_count: Object.keys(r.definition.states).length,
    created_at: r.created_at.toISOString(),
  }));
}

/**
 * GET /api/workflows/:id[?version=N] (ADR-0009): that version (default the latest) and the list
 * of saved versions. null = unknown id or version.
 */
export async function loadWorkflowDetail(
  db: Queryable,
  id: string,
  version: number | null,
): Promise<WorkflowDetail | null> {
  const res = await db.query<WorkflowDefinitionRow>(
    'SELECT * FROM workflow_definition WHERE id = $1 AND ($2::int IS NULL OR version = $2::int) ' +
      'ORDER BY version DESC LIMIT 1',
    [id, version],
  );
  const row = res.rows[0];
  if (!row) return null;
  const versions = await db.query<{ version: number }>(
    'SELECT version FROM workflow_definition WHERE id = $1 ORDER BY version',
    [id],
  );
  return {
    id: row.id,
    version: row.version,
    created_at: row.created_at.toISOString(),
    // Stored definitions were parsed on save; parsing again applies defaults to older rows.
    definition: WorkflowDefinitionSchema.parse(row.definition),
    versions: versions.rows.map((r) => r.version),
  };
}

export async function listMachines(db: Queryable): Promise<MachineDto[]> {
  const res = await db.query<MachineRow & { running_sessions: number }>(
    'SELECT m.*, (SELECT count(*)::int FROM session s ' +
      'WHERE s.machine_id = m.id AND s.status = ANY($1::session_status[])) AS running_sessions ' +
      'FROM machine m ORDER BY m.id',
    [SLOT_STATUSES],
  );
  return res.rows.map((m) => ({
    id: m.id,
    hostname: m.hostname,
    status: m.status,
    tags: m.tags,
    last_heartbeat_at: m.last_heartbeat_at ? m.last_heartbeat_at.toISOString() : null,
    max_sessions: m.max_sessions,
    running_sessions: m.running_sessions,
    cpu_free: m.cpu_free,
    mem_free_mb: m.mem_free_mb,
  }));
}
