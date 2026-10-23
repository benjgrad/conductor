import { randomUUID } from 'node:crypto';
import { sessionBranch, type BoardSseEvent } from '@conductor/shared';
import type { EngineService } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { Db } from '../main.js';

// The single-machine claim (M1-T11; 04 §2, 10-contracts §Claim): FIFO by priority then age,
// hard filters only (tags, allow-list), FOR UPDATE SKIP LOCKED, one transaction.
// TD: no soft score (repo locality, affinity) and no short-hold rule (04 §2-3) in M1.

/** Lease set by the claim and renewed by each heartbeat (04 §Leases). */
export const LEASE_INTERVAL = "interval '2 minutes'";

export type ClaimResult =
  | {
      status: 'claimed';
      ticketId: string;
      sessionId: string;
      fencingToken: number;
      boardEvents: BoardSseEvent[];
    }
  | { status: 'no_work'; reason: string };

class ClaimAborted extends Error {}

/** Statuses in which a session keeps its machine slot (for the max_sessions filter). */
const LIVE_STATUSES = ['assigned', 'running', 'needs_input', 'waiting_external'];

export async function claimWork(
  db: Db,
  engine: EngineService,
  machineId: string,
  freeSlots: number,
): Promise<ClaimResult> {
  if (freeSlots <= 0) return { status: 'no_work', reason: 'no_free_slots' };
  try {
    return await withTransaction(db, async (tx) => {
      // Machine-side hard filters (04 §1): online, below max_sessions.
      // TD: no cpu/mem reservation headroom check (04 §1) in M1.
      const m = await tx.query<{ tags: string[]; max_sessions: number; live: string }>(
        `SELECT m.tags, m.max_sessions,
                (SELECT count(*) FROM session s
                  WHERE s.machine_id = m.id AND s.status = ANY($2::session_status[])) AS live
           FROM machine m WHERE m.id = $1 AND m.status = 'online'`,
        [machineId, LIVE_STATUSES],
      );
      const machine = m.rows[0];
      if (!machine) return { status: 'no_work', reason: 'machine_not_online' } as const;
      if (Number(machine.live) >= machine.max_sessions) {
        return { status: 'no_work', reason: 'max_sessions' } as const;
      }

      // Ticket side. A ticket whose workflow version is unpinned gets the latest definition;
      // one with no definition at all, or with a non-queued live session, is never picked
      // (the latter would violate one-live-session-per-ticket).
      // TD-088: the ADR-0008 reopen pin is hard: a reopened ticket whose machine never comes back
      // waits in Queued until a human cancels it (cross-machine reopen needs a pushed branch and
      // a shipped transcript).
      const t = await tx.query<{ id: string; workflow_id: string; workflow_version: number }>(
        `SELECT t.id, t.workflow_id,
                COALESCE(t.workflow_version,
                  (SELECT max(w.version) FROM workflow_definition w WHERE w.id = t.workflow_id))
                  AS workflow_version
           FROM ticket t
          WHERE t.status = 'ready'
            AND t.required_tags <@ $2::text[]
            AND (t.repo_allow_machines IS NULL OR $1 = ANY(t.repo_allow_machines))
            AND (t.workflow_version IS NOT NULL
                 OR EXISTS (SELECT 1 FROM workflow_definition w WHERE w.id = t.workflow_id))
            AND NOT EXISTS (SELECT 1 FROM session s WHERE s.ticket_id = t.id
                             AND s.status NOT IN ('queued', 'done', 'failed', 'lost'))
            -- ADR-0008 branch pin: a queued session on a branch an earlier session of the
            -- ticket ran on (a reopen) runs only on that machine: the worktree and Claude's
            -- transcript (for --resume) are there.
            AND NOT EXISTS (SELECT 1 FROM session q
                              JOIN session p ON p.ticket_id = q.ticket_id AND p.id <> q.id
                                            AND p.branch = q.branch
                             WHERE q.ticket_id = t.id AND q.status = 'queued'
                               AND p.machine_id IS NOT NULL AND p.machine_id <> $1)
          ORDER BY t.priority DESC, t.created_at, t.id
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED`,
        [machineId, machine.tags],
      );
      const ticket = t.rows[0];
      if (!ticket) return { status: 'no_work', reason: 'no_ready_ticket' } as const;

      await tx.query(
        `UPDATE ticket SET status = 'claimed', workflow_version = $2, updated_at = now()
          WHERE id = $1`,
        [ticket.id, ticket.workflow_version],
      );

      // Re-use the queued session left by a refused start_session; else create one.
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM session WHERE ticket_id = $1 AND status = 'queued' FOR UPDATE`,
        [ticket.id],
      );
      let sessionId: string;
      const reuse = existing.rows[0];
      if (reuse) {
        sessionId = reuse.id;
        await tx.query(
          `UPDATE session SET fencing_token = nextval('fencing_seq'),
                  lease_expires_at = now() + ${LEASE_INTERVAL}, updated_at = now()
            WHERE id = $1`,
          [sessionId],
        );
      } else {
        sessionId = randomUUID();
        await tx.query(
          `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status,
                                workflow_state, machine_id, agent_command_id, agent_process_live,
                                lease_expires_at, branch)
           VALUES ($1, $2, $3, $4, 'queued', NULL, NULL, NULL, false,
                   now() + ${LEASE_INTERVAL}, $5)`,
          [
            sessionId,
            ticket.id,
            ticket.workflow_id,
            ticket.workflow_version,
            sessionBranch(ticket.id, sessionId),
          ],
        );
      }

      const res = await engine.applyEvent(
        sessionId,
        { type: 'session.assigned', machine_id: machineId },
        { tx },
      );
      if (res.status !== 'applied') {
        throw new ClaimAborted(`session.assigned ${res.status}: ${res.reason}`);
      }
      return {
        status: 'claimed',
        ticketId: ticket.id,
        sessionId,
        fencingToken: res.snapshot.fencing_token,
        boardEvents: res.boardEvents,
      } as const;
    });
  } catch (err) {
    if (err instanceof ClaimAborted) return { status: 'no_work', reason: err.message };
    // A concurrent claim won the one-live-session-per-ticket race.
    if ((err as { code?: string }).code === '23505') {
      return { status: 'no_work', reason: 'conflict' };
    }
    throw err;
  }
}
