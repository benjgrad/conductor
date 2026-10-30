import { randomUUID } from 'node:crypto';
import {
  MACHINE_LOST_CONTEXT_KEY,
  sessionBranch,
  WORKING_COPY_CONTEXT_KEY,
  type BoardSseEvent,
  type TicketKind,
  type WorkingCopy,
} from '@conductor/shared';
import { assignAgent } from '../agents/team.js';
import type { EngineService } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { Db } from '../main.js';
import {
  CANONICAL_REMOTE_SQL,
  EFFECTIVE_VERSION_SQL,
  REPO_SCOPED_SQL,
  requiredCaps,
  type RequiredCaps,
} from './routing.js';

// The single-machine claim (M1-T11, M2-T16a; 04 §2, 10-contracts §Claim): FIFO by priority then
// age, hard filters only, FOR UPDATE SKIP LOCKED, one transaction. Filters: tags, allow-list,
// account, repo (ADR-0013 §Routing: a machine_repo whose lower(remote) = lower(ticket.repo); a
// non-canonical repo, which only local mode allows, skips it), capabilities (every requirement of
// the effective workflow version, 10-contracts "Matching"), and the reopen / `__machine_lost` pins.
// TD: no soft score (repo locality, affinity) yet (04 §2).

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

export interface ClaimOptions {
  /** The required-capabilities cache (tests inject their own requirement function). */
  required?: RequiredCaps;
  log?: (msg: string) => void;
}

export async function claimWork(
  db: Db,
  engine: EngineService,
  machineId: string,
  freeSlots: number,
  opts: ClaimOptions = {},
): Promise<ClaimResult> {
  const required = opts.required ?? requiredCaps;
  const log = opts.log ?? ((m: string) => console.warn(`[claim] ${m}`));
  if (freeSlots <= 0) return { status: 'no_work', reason: 'no_free_slots' };
  try {
    return await withTransaction(db, async (tx) => {
      // Machine-side hard filters (04 §1): online, not revoked, below max_sessions. FOR SHARE (not
      // KEY SHARE: revoke changes no key column) serialises the claim against revokeMachine's
      // machine UPDATE, so revoke sees and fails whatever a claim in flight commits (M2-T09b;
      // 10-contracts §Machines protocol v2 R4).
      // TD: no cpu/mem reservation headroom check (04 §1) in M1.
      const m = await tx.query<{
        tags: string[];
        max_sessions: number;
        live: string;
        account_id: string;
      }>(
        `SELECT m.tags, m.max_sessions, m.account_id,
                (SELECT count(*) FROM session s
                  WHERE s.machine_id = m.id AND s.status = ANY($2::session_status[])) AS live
           FROM machine m WHERE m.id = $1 AND m.status = 'online' AND m.revoked_at IS NULL
            FOR SHARE OF m`,
        [machineId, LIVE_STATUSES],
      );
      const machine = m.rows[0];
      if (!machine) return { status: 'no_work', reason: 'machine_not_online' } as const;
      if (Number(machine.live) >= machine.max_sessions) {
        return { status: 'no_work', reason: 'max_sessions' } as const;
      }

      // Requirements of every (workflow, effective version, kind) among the account's ready
      // tickets: one pre-pass per claim, not per ticket (NFR-1). A ticket whose combination isn't
      // in `known` (committed after this read, or a definition that won't load) isn't picked.
      const combos = await tx.query<{
        workflow_id: string;
        v: number | null;
        kind: TicketKind | null;
      }>(
        `SELECT DISTINCT t.workflow_id, ${EFFECTIVE_VERSION_SQL} AS v, t.kind
           FROM ticket t WHERE t.status = 'ready' AND t.account_id = $1`,
        [machine.account_id],
      );
      const known = { wf: [] as string[], v: [] as number[], kind: [] as (string | null)[] };
      const reqs = {
        wf: [] as string[],
        v: [] as number[],
        kind: [] as (string | null)[],
        req: [] as string[],
      };
      for (const c of combos.rows) {
        if (c.v === null) continue;
        let list: string[];
        try {
          list = await required.get(tx, c.workflow_id, c.v, c.kind);
        } catch (err) {
          log(`required capabilities of ${c.workflow_id}@${c.v}: ${String(err)}`);
          continue;
        }
        known.wf.push(c.workflow_id);
        known.v.push(c.v);
        known.kind.push(c.kind);
        for (const r of list) {
          reqs.wf.push(c.workflow_id);
          reqs.v.push(c.v);
          reqs.kind.push(c.kind);
          reqs.req.push(r);
        }
      }

      // Ticket side. A ticket whose workflow version is unpinned gets the latest definition;
      // one with no definition at all, or with a non-queued live session, is never picked
      // (the latter would violate one-live-session-per-ticket).
      // TD-088: the ADR-0008 reopen pin is hard: a reopened ticket whose machine never comes back
      // waits in Queued until a human cancels it (cross-machine reopen needs a pushed branch and
      // a shipped transcript).
      const t = await tx.query<{
        id: string;
        account_id: string;
        agent_id: string | null;
        workflow_id: string;
        workflow_version: number;
        repo: string;
        canonical: boolean;
      }>(
        `SELECT t.id, t.account_id, t.agent_id, t.workflow_id, wv.v AS workflow_version, t.repo,
                (t.repo ~ $4 AND t.repo !~* '\\.git$') AS canonical
           FROM ticket t
           CROSS JOIN LATERAL (SELECT ${EFFECTIVE_VERSION_SQL} AS v) wv
          WHERE t.status = 'ready'
            AND t.account_id = $3
            AND t.required_tags <@ $2::text[]
            AND (t.repo_allow_machines IS NULL OR $1 = ANY(t.repo_allow_machines))
            AND wv.v IS NOT NULL
            -- ADR-0013 §Routing: the machine has the repo (github.com org/repo compare
            -- case-insensitively); a non-canonical repo (local mode) skips this, as in M1.
            AND (NOT (t.repo ~ $4 AND t.repo !~* '\\.git$')
                 OR EXISTS (SELECT 1 FROM machine_repo r
                             WHERE r.machine_id = $1 AND r.remote IS NOT NULL
                               AND lower(r.remote) = lower(t.repo)))
            -- Requirements known for the ticket's combination…
            AND EXISTS (SELECT 1 FROM unnest($5::text[], $6::int[], $7::text[]) AS k(wf, v, kind)
                         WHERE k.wf = t.workflow_id AND k.v = wv.v
                           AND k.kind IS NOT DISTINCT FROM t.kind::text)
            -- …and every one of them met by a stored key (10-contracts "Matching").
            AND NOT EXISTS (
                  SELECT 1 FROM unnest($8::text[], $9::int[], $10::text[], $11::text[])
                                AS rq(wf, v, kind, req)
                   WHERE rq.wf = t.workflow_id AND rq.v = wv.v
                     AND rq.kind IS NOT DISTINCT FROM t.kind::text
                     AND NOT EXISTS (
                           SELECT 1 FROM machine_capability c
                            WHERE c.machine_id = $1
                              AND (c.key = rq.req
                                   OR (strpos(rq.req, '@') > 0 AND lower(c.key) = lower(rq.req))
                                   OR (rq.req ~ $12
                                       AND lower(c.key) = lower(rq.req || '@' || t.repo)))))
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
            -- U-068: a queued session carrying a machine-lost mark runs only on that machine.
            AND NOT EXISTS (SELECT 1 FROM session q
                             WHERE q.ticket_id = t.id AND q.status = 'queued'
                               AND q.context ? $13
                               AND (q.context -> $13 ->> 'machine_id') IS DISTINCT FROM $1)
          ORDER BY t.priority DESC, t.created_at, t.id
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED`,
        [
          machineId,
          machine.tags,
          machine.account_id,
          CANONICAL_REMOTE_SQL,
          known.wf,
          known.v,
          known.kind,
          reqs.wf,
          reqs.v,
          reqs.kind,
          reqs.req,
          REPO_SCOPED_SQL,
          MACHINE_LOST_CONTEXT_KEY,
        ],
      );
      const ticket = t.rows[0];
      if (!ticket) return { status: 'no_work', reason: 'no_ready_ticket' } as const;

      // 10-contracts §Working copy: the machine_repo the claim matched, into the session context
      // before session.assigned, so every start_session carries it. None for a non-canonical repo.
      let workingCopy: WorkingCopy | null = null;
      if (ticket.canonical) {
        const wc = await tx.query<{ path: string; mode: WorkingCopy['mode'] }>(
          `SELECT path, mode FROM machine_repo
            WHERE machine_id = $1 AND remote IS NOT NULL AND lower(remote) = lower($2)
            ORDER BY path LIMIT 1`,
          [machineId, ticket.repo],
        );
        const row = wc.rows[0];
        if (row) workingCopy = { repo_path: row.path, mode: row.mode };
      }
      const wcJson = workingCopy === null ? null : JSON.stringify(workingCopy);

      // UX-13a: the ticket's agent, assigned as work starts (a queued ticket holds no one).
      // Before session.assigned, so the card event the engine emits carries its name.
      const agent = await assignAgent(tx, {
        ticketId: ticket.id,
        accountId: ticket.account_id,
        currentAgentId: ticket.agent_id,
        log,
      });
      await tx.query(
        `UPDATE ticket SET status = 'claimed', workflow_version = $2, agent_id = $3,
                updated_at = now()
          WHERE id = $1`,
        [ticket.id, ticket.workflow_version, agent.agentId],
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
                  lease_expires_at = now() + ${LEASE_INTERVAL}, updated_at = now(),
                  context = CASE WHEN $3::jsonb IS NULL THEN context - $2
                                 ELSE jsonb_set(context, ARRAY[$2], $3::jsonb) END
            WHERE id = $1`,
          [sessionId, WORKING_COPY_CONTEXT_KEY, wcJson],
        );
      } else {
        sessionId = randomUUID();
        await tx.query(
          `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status,
                                workflow_state, machine_id, agent_command_id, agent_process_live,
                                lease_expires_at, branch, context)
           VALUES ($1, $2, $3, $4, 'queued', NULL, NULL, NULL, false,
                   now() + ${LEASE_INTERVAL}, $5,
                   CASE WHEN $7::jsonb IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object($6::text, $7::jsonb) END)`,
          [
            sessionId,
            ticket.id,
            ticket.workflow_id,
            ticket.workflow_version,
            sessionBranch(ticket.id, sessionId),
            WORKING_COPY_CONTEXT_KEY,
            wcJson,
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
