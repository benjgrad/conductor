import { AGENT_NAMES, hireOrder, type TeamMember } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// UX-13a: the agent team (10-contracts §Claim, "Agent assignment"; 02 §agent). Each account has a
// team of named agents, reused across tickets; conductor hires from the hiring pool (AGENT_NAMES)
// only when nobody on the team is free. Runs inside the claim transaction.

/**
 * The agent `a` has another active ticket: one whose session is not done, failed or lost.
 * `session_status` has no `cancelled`: a cancel ends the session as `failed`. $2 = the ticket
 * being claimed. Uses ticket_agent_id_idx.
 */
const BUSY = `EXISTS (SELECT 1 FROM ticket t JOIN session s ON s.ticket_id = t.id
                WHERE t.agent_id = a.id AND t.id <> $2
                  AND s.status NOT IN ('done', 'failed', 'lost'))`;

export interface AssignAgentInput {
  ticketId: string;
  /** The ticket's account: the team is the account's, whichever machine claims. */
  accountId: string;
  /** `ticket.agent_id`; set = keep that agent (a retry, requeue or reopen). */
  currentAgentId: string | null;
  log: (msg: string) => void;
}

export interface AssignedAgent {
  agentId: string;
  name: string;
  hired: boolean;
}

/**
 * Pick the ticket's agent and stamp its `last_assigned_at`; the caller stores `ticket.agent_id`.
 * 1. Keep the ticket's agent. 2. Else the free teammate assigned longest ago (then oldest hire).
 * 3. Else hire the ticket's next untaken pool name. 4. Else (pool all hired, all busy) reuse the
 * teammate assigned longest ago, and log it.
 */
export async function assignAgent(tx: Queryable, input: AssignAgentInput): Promise<AssignedAgent> {
  const { ticketId, accountId, currentAgentId, log } = input;

  if (currentAgentId !== null) {
    const kept = await tx.query<{ name: string }>(
      'UPDATE agent SET last_assigned_at = now() WHERE id = $1 RETURNING name',
      [currentAgentId],
    );
    if (kept.rows[0]) return { agentId: currentAgentId, name: kept.rows[0].name, hired: false };
  }

  // A free teammate. SKIP LOCKED passes over one a concurrent claim is taking. The busy check is
  // repeated in a statement of its own once the row is locked: the locking SELECT's snapshot can
  // predate the commit of the claim that held the lock (EvalPlanQual re-checks only the agent
  // row, not the EXISTS), and a new statement sees that commit. Bounded by the team's size.
  const skipped: string[] = [];
  for (;;) {
    const free = await tx.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM agent a
        WHERE a.account_id = $1 AND NOT (a.id = ANY($3::uuid[])) AND NOT ${BUSY}
        ORDER BY a.last_assigned_at NULLS FIRST, a.hired_at, a.id
        LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
      [accountId, ticketId, skipped],
    );
    const agent = free.rows[0];
    if (!agent) break;
    const recheck = await tx.query<{ busy: boolean }>(
      `SELECT ${BUSY} AS busy FROM agent a WHERE a.id = $1`,
      [agent.id, ticketId],
    );
    if (recheck.rows[0]?.busy) {
      skipped.push(agent.id);
      continue;
    }
    await tx.query('UPDATE agent SET last_assigned_at = now() WHERE id = $1', [agent.id]);
    return { agentId: agent.id, name: agent.name, hired: false };
  }

  // Hire. ON CONFLICT: a concurrent claim hired the same name; walk on (a raw unique violation
  // would roll the whole claim back).
  const team = await tx.query<{ name: string }>('SELECT name FROM agent WHERE account_id = $1', [
    accountId,
  ]);
  const taken = new Set(team.rows.map((r) => r.name));
  for (const name of hireOrder(ticketId)) {
    if (taken.has(name)) continue;
    const hired = await tx.query<{ id: string }>(
      `INSERT INTO agent (account_id, name, last_assigned_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id, name) DO NOTHING RETURNING id`,
      [accountId, name],
    );
    if (hired.rows[0]) return { agentId: hired.rows[0].id, name, hired: true };
  }

  // The whole pool is on the team and busy: share the teammate assigned longest ago.
  const reuse = await tx.query<{ id: string; name: string }>(
    `UPDATE agent SET last_assigned_at = now()
      WHERE id = (SELECT id FROM agent WHERE account_id = $1
                   ORDER BY last_assigned_at NULLS FIRST, hired_at, id LIMIT 1 FOR UPDATE)
      RETURNING id, name`,
    [accountId],
  );
  const agent = reuse.rows[0]!;
  log(
    `team of account ${accountId} has all ${AGENT_NAMES.length} names hired and busy; ` +
      `reusing ${agent.name} for ticket ${ticketId}`,
  );
  return { agentId: agent.id, name: agent.name, hired: false };
}

/** GET /api/team: the account's team, oldest hire first, each with its active ticket (if any). */
export async function listTeam(q: Queryable, accountId: string): Promise<TeamMember[]> {
  const res = await q.query<{
    name: string;
    hired_at: Date;
    last_assigned_at: Date | null;
    active_ticket_id: string | null;
  }>(
    `SELECT a.name, a.hired_at, a.last_assigned_at, act.ticket_id AS active_ticket_id
       FROM agent a
       LEFT JOIN LATERAL (
         SELECT t.id AS ticket_id FROM ticket t JOIN session s ON s.ticket_id = t.id
          WHERE t.agent_id = a.id AND s.status NOT IN ('done', 'failed', 'lost')
          ORDER BY s.created_at DESC LIMIT 1) act ON true
      WHERE a.account_id = $1
      ORDER BY a.hired_at, a.name`,
    [accountId],
  );
  return res.rows.map((r) => ({
    name: r.name,
    hired_at: r.hired_at.toISOString(),
    last_assigned_at: r.last_assigned_at ? r.last_assigned_at.toISOString() : null,
    active_ticket_id: r.active_ticket_id,
  }));
}
