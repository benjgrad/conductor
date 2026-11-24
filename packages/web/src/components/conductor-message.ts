// Messages in the conversation that look like the human's (`user` chunks) but are not: Claude
// Code's own notices (a background job finished: `<task-notification>`, often inside a
// `<system-reminder>`), conductor's nudge to finish the step, and the prompt of a later step.
// Transcript history (ADR-0008) replays every user line, so these showed as "You" with raw XML.
// Pure, so the Messages thread can label them "Conductor" (OutputLog.tsx).

export type ConductorNotice =
  /** A background job ended. `status`: completed, failed, stopped, killed, … */
  | {
      kind: 'task';
      status: string;
      summary: string;
      outputFile: string | null;
      taskId: string | null;
    }
  /** conductor's no-outcome nudge (U-028). */
  | { kind: 'nudge' }
  /** A later step's prompt (`renderPrompt`); `step` from its "## Your step: X" line. */
  | { kind: 'step-prompt'; step: string | null; text: string }
  /** Any other harness block (a reminder's text, a slash command's output, …). */
  | { kind: 'note'; tag: string; text: string };

export interface ConductorMessage {
  notices: ConductorNotice[];
  /** Free text after the last block, if any. */
  rest: string;
}

/**
 * The tags the Claude Code harness writes into user messages. Only these count, so a human who
 * types a literal `<b>` is still the human.
 */
const HARNESS_TAGS = [
  'task-notification',
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'user-prompt-submit-hook',
] as const;

const HARNESS_TAG_SET: ReadonlySet<string> = new Set(HARNESS_TAGS);

/** `NO_OUTCOME_NUDGE` (crates/conductor-daemon/src/daemon.rs): keep the two in step. */
export const NUDGE_TEXT =
  'You must finish by calling complete_state with your result, or ask_user if you need a human';
/** Matched by its start, so a reworded ending still counts. */
const NUDGE_PREFIX = 'You must finish by calling complete_state';

/** The heading `ticketSection()` opens every step prompt with (shared engine/render.ts). */
const STEP_PROMPT_PREFIX = '# Ticket: ';

const OPEN_TAG = /^<([a-z][a-z-]*)>/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/** The harness escapes `&`, `<` and `>` in a block's text (`&amp;&amp;` in a command). */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]!);
}

/** The text of `<tag>…</tag>` inside `body`, unescaped, or null. */
function child(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? unescape(m[1]!.trim()) : null;
}

function taskNotice(body: string): ConductorNotice {
  return {
    kind: 'task',
    status: child(body, 'status') ?? '',
    // A shape we don't know: show its text without the tags rather than nothing.
    summary:
      child(body, 'summary') ??
      unescape(
        body
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    outputFile: child(body, 'output-file'),
    taskId: child(body, 'task-id'),
  };
}

/**
 * Walk the leading harness blocks of `text`. Returns null when it doesn't start with one (or a
 * block is never closed): then it is not the harness's.
 */
function parseBlocks(text: string): ConductorMessage | null {
  const notices: ConductorNotice[] = [];
  let rest = text.trim();
  let matched = false;
  for (;;) {
    const open = OPEN_TAG.exec(rest);
    const tag = open?.[1];
    if (!tag || !HARNESS_TAG_SET.has(tag)) break;
    const close = `</${tag}>`;
    const end = rest.indexOf(close);
    if (end < 0) break;
    const body = rest.slice(open[0].length, end).trim();
    rest = rest.slice(end + close.length).trim();
    matched = true;
    if (tag === 'task-notification') notices.push(taskNotice(body));
    else if (tag === 'system-reminder') {
      // A reminder wraps other blocks (a notification) or plain text.
      const inner = parseBlocks(body);
      if (inner) {
        notices.push(...inner.notices);
        if (inner.rest !== '') notices.push({ kind: 'note', tag, text: inner.rest });
      } else if (body !== '') notices.push({ kind: 'note', tag, text: body });
    } else if (body !== '') notices.push({ kind: 'note', tag, text: body });
  }
  return matched ? { notices, rest } : null;
}

/**
 * Who wrote a `user` message: null for the human, else conductor's notices. `first`: it is the
 * conversation's opening message (the ticket prompt, shown as the Ticket, UXR-38).
 */
export function classifyUserText(text: string, opts: { first: boolean }): ConductorMessage | null {
  const trimmed = text.trim();
  if (trimmed.startsWith(NUDGE_PREFIX)) return { notices: [{ kind: 'nudge' }], rest: '' };
  if (!opts.first && trimmed.startsWith(STEP_PROMPT_PREFIX)) {
    const step = /^## Your step: (.+)$/m.exec(trimmed)?.[1]?.trim() ?? null;
    return { notices: [{ kind: 'step-prompt', step, text: trimmed }], rest: '' };
  }
  return parseBlocks(trimmed);
}

/** "background job" / "reminder" / "step prompt" / "note": what the bubble's label adds. */
export function conductorLabel(m: ConductorMessage): string {
  const kinds = new Set(m.notices.map((n) => n.kind));
  if (kinds.size !== 1) return 'Conductor';
  const [kind] = kinds;
  switch (kind) {
    case 'task':
      return m.notices.length === 1 ? 'Conductor · background job' : 'Conductor · background jobs';
    case 'nudge':
      return 'Conductor · reminder';
    case 'step-prompt':
      return 'Conductor · step prompt';
    default:
      return 'Conductor · note';
  }
}

/** The status icon's tone: ok, failed, stopped, or other. */
export function taskTone(status: string): 'ok' | 'failed' | 'stopped' | 'other' {
  switch (status.toLowerCase()) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return 'other';
  }
}
