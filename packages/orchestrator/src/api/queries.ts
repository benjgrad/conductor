import {
  BOARD_COLUMNS,
  toBoardCard,
  type BoardCard,
  type BoardColumn,
  type BoardResponse,
  type MachineDto,
  type TicketDto,
  type WorkflowSummary,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
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

/** 06 §Kanban columns sort order. */
function sortColumn(column: BoardColumn, cards: BoardCard[]): BoardCard[] {
  const byCreated = (a: BoardCard, b: BoardCard) => ms(a.created_at) - ms(b.created_at);
  const recentFirst = (a: BoardCard, b: BoardCard) => ms(b.updated_at) - ms(a.updated_at);
  switch (column) {
    case 'queued':
      return cards.sort((a, b) => b.priority - a.priority || byCreated(a, b));
    case 'running':
      return cards.sort(recentFirst);
    case 'needs_input':
      // Oldest open input_request first; a card without one (shouldn't happen) goes last.
      return cards.sort((a, b) => {
        const ta = a.input_request ? ms(a.input_request.created_at) : Infinity;
        const tb = b.input_request ? ms(b.input_request.created_at) : Infinity;
        return ta - tb || byCreated(a, b);
      });
    case 'waiting_external':
      return cards.sort(byCreated);
    case 'done':
    case 'failed':
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
    const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardCard[]])) as Record<
      BoardColumn,
      BoardCard[]
    >;
    for (const ticket of tickets.rows) {
      const session = sessionByTicket.get(ticket.id) ?? null;
      // A ticket cancelled before any session ran has no column to live in.
      if (session === null && ticket.status === 'cancelled') continue;
      const card = toBoardCard(
        ticket,
        session,
        session ? (inputBySession.get(session.id) ?? null) : null,
      );
      columns[card.column].push(card);
    }
    for (const c of BOARD_COLUMNS) sortColumn(c, columns[c]);
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
  };
}

/** Latest version of each workflow id. */
export async function listWorkflows(db: Queryable): Promise<WorkflowSummary[]> {
  const res = await db.query<WorkflowDefinitionRow>(
    'SELECT DISTINCT ON (id) * FROM workflow_definition ORDER BY id, version DESC',
  );
  return res.rows.map((r) => ({
    id: r.id,
    version: r.version,
    start: r.definition.start,
    state_count: Object.keys(r.definition.states).length,
    created_at: r.created_at.toISOString(),
  }));
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
