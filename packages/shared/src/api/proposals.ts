import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../domain.js';
import { PROPOSAL_BODY_MAX, PROPOSAL_TITLE_MAX } from '../engine/proposals.js';
import { TicketKindSchema } from '../workflow/schema.js';

// ADR-0034: follow-up tickets an agent proposed, accepted or dismissed one by one by a human
// (POST /api/proposals/:id/accept | dismiss, and the MCP `decide_proposed_ticket` tool).
// 10-contracts §Proposed tickets.

export const TicketProposalStatusSchema = z.enum(['pending', 'accepted', 'dismissed']);
export type TicketProposalStatus = z.infer<typeof TicketProposalStatusSchema>;

export const TicketProposalDtoSchema = z.object({
  id: UuidSchema,
  /** The ticket whose agent proposed it. */
  ticket_id: UuidSchema,
  session_id: UuidSchema,
  /** The agent state that proposed it. */
  state: z.string(),
  title: z.string(),
  body: z.string(),
  /** null = the source ticket's kind. */
  kind: TicketKindSchema.nullable(),
  why: z.string().nullable(),
  status: TicketProposalStatusSchema,
  /** The ticket an accept created; null until accepted (or when that ticket was deleted). */
  created_ticket_id: UuidSchema.nullable(),
  decided_by: z.string().nullable(),
  decided_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type TicketProposalDto = z.infer<typeof TicketProposalDtoSchema>;

/** The most proposals a session detail carries (newest kept). */
export const SESSION_PROPOSALS_LIMIT = 20;

/**
 * POST /api/proposals/:id/accept → 201 AcceptProposalResponse: queue it as a new, independent
 * ticket (the source ticket's repo, workflow, tags and machines). Edits replace the proposal's
 * text; `kind` defaults to the proposal's, then the source ticket's; `priority` to the source's.
 */
export const AcceptProposalRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(PROPOSAL_TITLE_MAX).optional(),
  body: z.string().max(PROPOSAL_BODY_MAX).optional(),
  kind: TicketKindSchema.optional(),
  priority: z.number().int().optional(),
});
export type AcceptProposalRequest = z.infer<typeof AcceptProposalRequestSchema>;

/** POST /api/proposals/:id/dismiss → TicketProposalDto. */
export const DismissProposalRequestSchema = z.strictObject({});
export type DismissProposalRequest = z.infer<typeof DismissProposalRequestSchema>;
