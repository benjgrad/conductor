import {
  simulateTicket,
  type RecordedSession,
  type SessionStatus,
  type TicketSimulation,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { TicketRow } from '../db/types.js';
import type { Db } from '../main.js';
import { readRepoChecksWithMeta } from '../engine/rows.js';

// simulate_workflow (R17): read a ticket's recorded sessions and event rows, and replay them
// through a draft definition (shared simulateTicket). Read-only: SELECTs only.

/** At most this many event rows per ticket; the replay covers the oldest ones. */
export const SIMULATE_EVENTS_MAX = 5000;

export interface TicketSimulationResult extends TicketSimulation {
  ticket_id: string;
  short_id: string;
  title: string;
  /** The workflow id and version the ticket ran on (the latest session's). */
  recorded_workflow: { id: string; version: number | null };
  truncated_events?: true;
}

/** Replay one ticket of `accountId` through `def`; null when it is not in that account. */
export async function simulateRecordedTicket(
  db: Db,
  accountId: string,
  ticketId: string,
  def: WorkflowDefinition,
): Promise<TicketSimulationResult | null> {
  const t = await db.query<TicketRow>('SELECT * FROM ticket WHERE id = $1 AND account_id = $2', [
    ticketId,
    accountId,
  ]);
  const ticket = t.rows[0];
  if (ticket === undefined) return null;
  const s = await db.query<{
    id: string;
    branch: string | null;
    status: SessionStatus;
    workflow_id: string;
    workflow_version: number;
  }>(
    'SELECT id, branch, status, workflow_id, workflow_version FROM session ' +
      'WHERE ticket_id = $1 ORDER BY created_at, id',
    [ticketId],
  );
  const ids = s.rows.map((r) => r.id);
  const ev =
    ids.length === 0
      ? { rows: [] }
      : await db.query<{
          session_id: string;
          id: string;
          type: string;
          payload: unknown;
          ts: Date;
        }>(
          'SELECT session_id, id, type, payload, ts FROM event WHERE session_id = ANY($1::uuid[]) ' +
            'ORDER BY id LIMIT $2',
          [ids, SIMULATE_EVENTS_MAX + 1],
        );
  const truncated = ev.rows.length > SIMULATE_EVENTS_MAX;
  const sessions: RecordedSession[] = s.rows.map((r) => ({
    id: r.id,
    branch: r.branch,
    status: r.status,
    rows: [],
  }));
  const byId = new Map(sessions.map((x) => [x.id, x]));
  for (const row of ev.rows.slice(0, SIMULATE_EVENTS_MAX)) {
    byId.get(row.session_id)?.rows.push({
      id: Number(row.id),
      type: row.type,
      payload: row.payload,
      ts: row.ts.toISOString(),
    });
  }
  const repoChecks = await readRepoChecksWithMeta(db, accountId, ticket.repo);
  const out = simulateTicket({
    def,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      body: ticket.body,
      repo: ticket.repo,
      external_ref: ticket.external_ref,
      kind: ticket.kind,
      size: ticket.size ?? null,
    },
    sessions,
    repoChecks: repoChecks.checks,
  });
  const latest = s.rows[s.rows.length - 1];
  return {
    ticket_id: ticket.id,
    short_id: ticket.id.slice(0, 8),
    title: ticket.title,
    recorded_workflow: {
      id: latest?.workflow_id ?? ticket.workflow_id,
      version: latest?.workflow_version ?? ticket.workflow_version,
    },
    ...out,
    ...(truncated ? { truncated_events: true as const } : {}),
  };
}
