import {
  agentStatesOf,
  proposalsOfContext,
  withDecisions,
  type JsonObject,
  type ParsedProposal,
  type ProposalDecision,
  type TicketProposal,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { DefinitionCache } from './rows.js';

// 06 §Proposed tickets: the read side. Proposals live in the latest session's `context` (each
// agent state's stored result); decisions in `ticket_proposal_decision`. Nothing here writes.

/** Definitions are immutable per (id, version), so one process-wide cache is safe. */
const defs = new DefinitionCache();

/** What reading a session's proposals needs. */
export interface ProposalSession {
  context: Record<string, JsonObject>;
  workflow_id: string;
  workflow_version: number;
}

/** The card column whose cards show proposals (and their count badge). */
export const PROPOSALS_COLUMN = 'needs_input';

/**
 * The well-formed proposals of the session's agent states. The agent states come from the
 * session's pinned definition; when it can't be read, every non-bookkeeping result is read.
 */
export async function sessionProposals(
  q: Queryable,
  session: ProposalSession,
): Promise<ParsedProposal[]> {
  const def = await defs.get(q, session.workflow_id, session.workflow_version).catch(() => null);
  return proposalsOfContext(session.context, def ? agentStatesOf(def) : undefined);
}

/** Every decision of the tickets, by ticket then proposal id. */
export async function readDecisions(
  q: Queryable,
  ticketIds: readonly string[],
): Promise<Map<string, Map<string, ProposalDecision>>> {
  const out = new Map<string, Map<string, ProposalDecision>>();
  if (ticketIds.length === 0) return out;
  const r = await q.query<{
    ticket_id: string;
    proposal_id: string;
    status: ProposalDecision['status'];
    created_ticket_id: string | null;
  }>(
    'SELECT ticket_id, proposal_id, status, created_ticket_id FROM ticket_proposal_decision ' +
      'WHERE ticket_id = ANY($1::uuid[])',
    [ticketIds],
  );
  for (const row of r.rows) {
    const m = out.get(row.ticket_id) ?? new Map<string, ProposalDecision>();
    m.set(row.proposal_id, { status: row.status, created_ticket_id: row.created_ticket_id });
    out.set(row.ticket_id, m);
  }
  return out;
}

/** The ticket's proposals (from its latest session) with their decisions; [] without a session. */
export async function loadProposals(
  q: Queryable,
  ticketId: string,
  session: ProposalSession | null,
): Promise<TicketProposal[]> {
  if (session === null) return [];
  const parsed = await sessionProposals(q, session);
  if (parsed.length === 0) return [];
  const decisions = (await readDecisions(q, [ticketId])).get(ticketId) ?? new Map();
  return withDecisions(parsed, decisions);
}

export function pendingCount(proposals: readonly TicketProposal[]): number {
  return proposals.filter((p) => p.status === 'pending').length;
}
