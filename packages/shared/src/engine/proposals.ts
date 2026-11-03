import { z } from 'zod';
import type { JsonObject } from '../domain.js';
import { TicketKindSchema, type AgentState, type FollowUps } from '../workflow/schema.js';

// ADR-0034: follow-up tickets an agent proposes in its `complete_state` result. Pure: apply()
// parses them (`ticket_proposals` effect), the orchestrator stores them for a human to accept
// or dismiss one by one. The agent is encouraged, never required: a missing, malformed or
// oversized list never fails the step, the bad items are just dropped.

/** The reserved `result` key carrying the proposals. */
export const PROPOSED_TICKETS_KEY = 'proposed_tickets';

export const PROPOSAL_TITLE_MAX = 200;
export const PROPOSAL_BODY_MAX = 20_000;
export const PROPOSAL_WHY_MAX = 500;

/** One proposed ticket, as the agent writes it (and as the effect carries it). */
export const ProposedTicketSchema = z.object({
  title: z.string().trim().min(1).max(PROPOSAL_TITLE_MAX),
  body: z.string().max(PROPOSAL_BODY_MAX).default(''),
  kind: TicketKindSchema.optional(),
  /** Why it is worth doing, in a sentence. */
  why: z.string().trim().min(1).max(PROPOSAL_WHY_MAX).optional(),
});
export type ProposedTicket = z.output<typeof ProposedTicketSchema>;

/** The state's follow-up config when it is on, else null. */
export function followUpsOf(state: Pick<AgentState, 'follow_ups'> | undefined): FollowUps | null {
  const f = state?.follow_ups;
  return f?.enabled === true ? f : null;
}

export interface ParsedProposals {
  proposals: ProposedTicket[];
  /** Items left out: malformed, a repeated title, or over `max`. */
  dropped: number;
}

/**
 * The valid proposals in `result.proposed_tickets`, titles deduplicated case-insensitively (first
 * wins), at most `cfg.max`. A missing or non-array value is no proposals. Never throws.
 */
export function parseProposedTickets(
  result: JsonObject,
  cfg: Pick<FollowUps, 'max'>,
): ParsedProposals {
  const raw = result[PROPOSED_TICKETS_KEY];
  if (!Array.isArray(raw)) return { proposals: [], dropped: raw === undefined ? 0 : 1 };
  const proposals: ProposedTicket[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    const parsed = ProposedTicketSchema.safeParse(item);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const key = parsed.data.title.toLowerCase();
    if (seen.has(key) || proposals.length >= cfg.max) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    proposals.push(parsed.data);
  }
  return { proposals, dropped };
}

/** `result` without the proposals key (what is stored as `context.<state>`). */
export function withoutProposals(result: JsonObject): JsonObject {
  if (!(PROPOSED_TICKETS_KEY in result)) return result;
  return Object.fromEntries(Object.entries(result).filter(([k]) => k !== PROPOSED_TICKETS_KEY));
}

/** The heading of the prompt's optional follow-up section. */
export const FOLLOW_UPS_HEADING = '## Follow-up tickets (optional)';

/** The prompt section for a state with follow-ups on (`renderPrompt`). */
export function renderFollowUps(cfg: FollowUps): string {
  const lines = [
    FOLLOW_UPS_HEADING,
    '',
    'If you noticed separate work that could be done in parallel as its own ticket (not needed to finish this one), you may propose it.',
    `Add \`"${PROPOSED_TICKETS_KEY}": [{"title": "…", "body": "<Markdown: goal, context, what to do>", "why": "<one sentence>"}]\` to your \`result\`, at most ${cfg.max}.`,
    'A human confirms each one before it is queued. Do not propose work this ticket already covers. Leave the key out when there is nothing worth proposing.',
  ];
  if (cfg.guidance !== undefined) lines.push('', cfg.guidance);
  return lines.join('\n');
}
