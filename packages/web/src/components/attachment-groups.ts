// 06 §Attachments: what a human attached (instructions for the agent) and what an agent attached
// (its screenshots, GIFs and recordings: evidence for the human) are shown apart.
import { CHAT_ATTACHMENT_MARK, type AttachmentDto } from '@conductor/shared';

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

/**
 * A human's attachments: those of the ticket itself (`session_id` null: created or edited in) and
 * those sent with a chat message (filed under the session), each in upload order.
 */
export function splitHumanByOrigin(list: readonly AttachmentDto[]): {
  original: AttachmentDto[];
  chat: AttachmentDto[];
} {
  return {
    original: list.filter((a) => a.session_id === null),
    chat: list.filter((a) => a.session_id !== null),
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

/**
 * 06 §Attachments (chat): a `user` chunk's text and the files it names in its trailing
 * `📎 <name>` lines (the server appends one per file sent with the message).
 */
export function splitChatFiles(text: string): { text: string; names: string[] } {
  const lines = text.split('\n');
  const names: string[] = [];
  const prefix = `${CHAT_ATTACHMENT_MARK} `;
  while (lines.length > 0 && lines.at(-1)!.startsWith(prefix)) {
    names.unshift(lines.pop()!.slice(prefix.length));
  }
  return names.length === 0 ? { text, names } : { text: lines.join('\n').trimEnd(), names };
}

/**
 * The files `names` (one bubble's) among the human's chat attachments, in order: each name takes
 * the first file of that name not taken yet; `null` where none matches (shown as text).
 */
export function matchChatFiles(
  names: readonly string[],
  files: readonly AttachmentDto[],
): (AttachmentDto | null)[] {
  const used = new Set<string>();
  return names.map((n) => {
    const hit = files.find((a) => a.name === n && !used.has(a.id));
    if (hit) used.add(hit.id);
    return hit ?? null;
  });
}
