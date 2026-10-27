// UX-2: the agent's initial prompt, from Claude's transcript (ADR-0008), and the ticket body
// inside it. The prompt starts with the engine's ticket section (shared engine/render.ts
// `ticketSection`): `# Ticket: <title>`, a blank line, the trimmed body, a blank line, then
// `Repository: <repo>`. Pure, like parse.ts.
import type { OutputChunk } from '@conductor/shared';

const TICKET_PREFIX = '# Ticket: ';

/** The first `user` chunk that is a rendered ticket prompt, else the first `user` chunk. */
export function initialPrompt(chunks: readonly OutputChunk[]): string | null {
  const users = chunks.filter((c) => c.stream === 'user');
  return (users.find((c) => c.text.startsWith(TICKET_PREFIX)) ?? users[0])?.text ?? null;
}

/** The ticket body inside a rendered prompt; null when the prompt doesn't have that shape. */
export function ticketBodyFromPrompt(prompt: string, title: string, repo: string): string | null {
  const head = `${TICKET_PREFIX}${title}\n\n`;
  if (!prompt.startsWith(head)) return null;
  const rest = prompt.slice(head.length);
  const end = rest.indexOf(`\n\nRepository: ${repo}`);
  if (end < 0) return null;
  const body = rest.slice(0, end).trim();
  return body === '(no description)' ? '' : body;
}
