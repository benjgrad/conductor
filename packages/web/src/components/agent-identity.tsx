// The agent working a ticket: a human first name and a flat 2D avatar. UX-13a stores the name on
// the ticket (`ticket.agent_id` → `agent.name`, set by the claim) and the API sends it as
// `agent_name`; UX-13b shows that name and seeds the avatar from it, so a teammate has the same
// face on every ticket. A queued ticket holds no one ("Unassigned", neutral avatar). A ticket from
// before UX-13a (or an older server) falls back to the old per-ticket hash name and face, which
// are pure functions of the ticket id. The avatar itself lives in ./avatar/ (drawn procedurally
// as inline SVG: no image service, no library).
import { AGENT_NAMES, type BoardCard } from '@conductor/shared';
import { hashString } from './avatar/traits.js';

export { hashString };
export { AgentAvatar, type AgentAvatarProps } from './avatar/Avatar.js';
export { avatarTraits, HAIR_STYLES, type AvatarTraits, type HairStyle } from './avatar/traits.js';

/** The hiring pool (UX-13a: moved to @conductor/shared; re-exported for the old imports). */
export { AGENT_NAMES };

/** Legacy (pre-UX-13a) name: a pure function of the ticket id. */
export function agentName(ticketId: string): string {
  return AGENT_NAMES[hashString(`name:${ticketId}`) % AGENT_NAMES.length]!;
}

export const UNASSIGNED = 'Unassigned';

/** Who works a card: the name to show and the avatar seed (null ⇒ unassigned, neutral avatar). */
export interface CardAgent {
  name: string;
  seed: string | null;
}

/**
 * UX-13b FR-1: the one place that decides which agent a card shows.
 * 1. The stored teammate (`card.agent_name`, else the session detail's `agent_name`), seeded by
 *    name so the same teammate has the same face everywhere (FR-2).
 * 2. A queued ticket with no agent: "Unassigned" (a queued ticket holds no one, UX-13a FR-3).
 * 3. Otherwise a ticket from before UX-13a, or an older server: the old hash name and face.
 */
export function cardAgent(
  card: Pick<BoardCard, 'ticket_id' | 'column' | 'agent_name'>,
  detailName?: string | null,
): CardAgent {
  const stored = card.agent_name || detailName;
  if (stored) return { name: stored, seed: stored };
  if (card.column === 'queued') return { name: UNASSIGNED, seed: null };
  return { name: agentName(card.ticket_id), seed: card.ticket_id };
}
