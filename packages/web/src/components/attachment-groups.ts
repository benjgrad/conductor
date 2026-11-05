// 06 §Attachments: what a human attached (instructions for the agent) and what an agent attached
// (its screenshots, GIFs and recordings: evidence for the human) are shown apart.
import type { AttachmentDto } from '@conductor/shared';

/** The human's attachments and the agents', each in upload order. */
export function splitAttachments(list: readonly AttachmentDto[]): {
  human: AttachmentDto[];
  agent: AttachmentDto[];
} {
  return {
    human: list.filter((a) => a.source === 'human'),
    agent: list.filter((a) => a.source === 'agent'),
  };
}

export interface AttachmentGroup {
  /** The workflow state the agent captured them in; null when unknown. */
  state: string | null;
  items: AttachmentDto[];
}

/**
 * Agent attachments grouped by the workflow state they were captured in: the group with the most
 * recent upload first, files in upload order inside a group.
 */
export function groupByState(list: readonly AttachmentDto[]): AttachmentGroup[] {
  const groups = new Map<string | null, AttachmentDto[]>();
  const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const a of sorted) {
    const g = groups.get(a.workflow_state);
    if (g) g.push(a);
    else groups.set(a.workflow_state, [a]);
  }
  return [...groups.entries()]
    .map(([state, items]) => ({ state, items }))
    .sort((x, y) => y.items.at(-1)!.created_at.localeCompare(x.items.at(-1)!.created_at));
}

/** What `sessionId`'s agent attached, in upload order. */
export function sessionCaptures(
  list: readonly AttachmentDto[],
  sessionId: string | null,
): AttachmentDto[] {
  if (sessionId === null) return [];
  return list.filter((a) => a.source === 'agent' && a.session_id === sessionId);
}
