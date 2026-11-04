import { z } from 'zod';
import { UuidSchema, type JsonObject } from '../domain.js';
import type { WorkflowDefinition } from '../workflow/schema.js';

// Agent-proposed follow-up tickets (06 §Proposed tickets). An agent may add `proposed_tickets`
// to its `complete_state` result (PROPOSALS_HINT in engine/render.ts). It is never in a state's
// `result` list, so the engine stores it in `context[<state>]` like any extra key and never
// fails on it. This module reads it back: malformed entries are dropped quietly. A human
// approves (a real ticket is created) or dismisses each one; the decision is stored per ticket
// in `ticket_proposal_decision`, keyed by the proposal's id.

/** The most proposals read from one state's result. */
export const PROPOSALS_PER_STATE_MAX = 3;

/** One entry of a result's `proposed_tickets`, as the agent writes it. */
export const ProposedTicketSchema = z.object({
  title: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(300),
  why: z.string().trim().min(1).max(4000),
});
export type ProposedTicket = z.infer<typeof ProposedTicketSchema>;

/** A proposal read from the session's context: the entry plus its id and the state it came from. */
export interface ParsedProposal extends ProposedTicket {
  id: string;
  state: string;
}

export const ProposalStatusSchema = z.enum(['pending', 'approved', 'dismissed']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** A proposal with its decision (GET session / ticket, get_ticket_artifacts). */
export const TicketProposalSchema = z.object({
  id: z.string(),
  state: z.string(),
  title: z.string(),
  repo: z.string(),
  why: z.string(),
  status: ProposalStatusSchema,
  /** The ticket an approval created; null while pending, dismissed, or once that ticket is gone. */
  created_ticket_id: UuidSchema.nullable(),
});
export type TicketProposal = z.infer<typeof TicketProposalSchema>;

/** FNV-1a 64-bit offset basis and prime. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

/**
 * A proposal's stable id: FNV-1a 64-bit over the UTF-8 of `JSON.stringify([state, title, repo])`
 * (unambiguous whatever the fields hold), as 16 hex
 * characters. A plain JS hash (not `node:crypto`): shared also runs in the browser. The same
 * proposal written again by a re-run of the state keeps its id (and its decision); a different
 * one gets a new id. Not a security boundary: ids are only compared within one ticket.
 */
export function proposalId(state: string, title: string, repo: string): string {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(JSON.stringify([state, title, repo]))) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

/** The names of a definition's agent states (the only results proposals are read from). */
export function agentStatesOf(def: Pick<WorkflowDefinition, 'states'>): Set<string> {
  return new Set(
    Object.entries(def.states)
      .filter(([, s]) => s.type === 'agent')
      .map(([name]) => name),
  );
}

/**
 * Every well-formed proposal in the session's context, in context order. `__`-prefixed keys are
 * conductor's bookkeeping, not results; with `agentStates`, other non-agent keys are skipped too.
 * A `proposed_tickets` that isn't an array is ignored; entries that don't parse are dropped; at
 * most PROPOSALS_PER_STATE_MAX are read per state; duplicates (same id) are kept once. Never throws.
 */
export function proposalsOfContext(
  context: Record<string, JsonObject> | null | undefined,
  agentStates?: ReadonlySet<string>,
): ParsedProposal[] {
  const out: ParsedProposal[] = [];
  const seen = new Set<string>();
  for (const [state, result] of Object.entries(context ?? {})) {
    if (state.startsWith('__')) continue;
    if (agentStates && !agentStates.has(state)) continue;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) continue;
    const raw = (result as Record<string, unknown>).proposed_tickets;
    if (!Array.isArray(raw)) continue;
    let taken = 0;
    for (const entry of raw) {
      if (taken >= PROPOSALS_PER_STATE_MAX) break;
      const parsed = ProposedTicketSchema.safeParse(entry);
      if (!parsed.success) continue;
      taken++;
      const id = proposalId(state, parsed.data.title, parsed.data.repo);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, state, ...parsed.data });
    }
  }
  return out;
}

/** A proposal's decision as stored (`ticket_proposal_decision`). */
export interface ProposalDecision {
  status: Exclude<ProposalStatus, 'pending'>;
  created_ticket_id: string | null;
}

/** The proposals with their decisions; no decision ≡ pending. */
export function withDecisions(
  proposals: readonly ParsedProposal[],
  decisions: ReadonlyMap<string, ProposalDecision>,
): TicketProposal[] {
  return proposals.map((p) => {
    const d = decisions.get(p.id);
    return {
      ...p,
      status: d?.status ?? 'pending',
      created_ticket_id: d?.created_ticket_id ?? null,
    };
  });
}

/** The default body of a ticket approved from a proposal: the why and a link to the parent. */
export function proposalTicketBody(
  p: Pick<ParsedProposal, 'why' | 'state'>,
  parent: { id: string; title: string },
): string {
  return (
    `${p.why.trim()}\n\n---\n` +
    `Proposed by the \`${p.state}\` step of [${parent.title}](/#/?ticket=${parent.id}) ` +
    `(follow-up of ticket ${parent.id}).`
  );
}

/** A proposal id (`proposalId`). */
export const ProposalIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * POST /api/tickets/:id/proposals/approve → ApproveProposalResponse (201 when it created the
 * ticket, 200 when the proposal was already approved: idempotent on the proposal id). `title` and
 * `body` are the edits made before confirming; absent ≡ the proposal's title, `proposalTicketBody`.
 */
export const ApproveProposalRequestSchema = z.object({
  proposal_id: ProposalIdSchema,
  title: z.string().trim().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
});
export type ApproveProposalRequest = z.input<typeof ApproveProposalRequestSchema>;

/** POST /api/tickets/:id/proposals/dismiss → TicketProposal (idempotent). */
export const DismissProposalRequestSchema = z.object({ proposal_id: ProposalIdSchema });
export type DismissProposalRequest = z.input<typeof DismissProposalRequestSchema>;
