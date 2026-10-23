import type { JsonObject } from '../domain.js';
import { REVIEW_GIT_COMMANDS } from '../workflow/tools.js';
import type { SessionSnapshot } from './types.js';

// ADR-0009 requirements gates: the pure pieces apply() uses for a review step (the reviewer's
// prompt, its verdict, the feedback the worker gets back). See apply.ts §Requirements review.

/** The tool alias (workflow/tools.ts) a reviewer runs with: read-only plus exact git inspection. */
export const REVIEW_TOOLS = ['review'] as const;

/**
 * How long a reviewer may take before the review step goes to `on_unmet.else` (ADR-0009).
 * TD-092: a constant; the gate schema has no per-gate timeout.
 */
export const REVIEW_TIMEOUT = '10m';

/** `session.context` key the review step is persisted under (02; not a valid state name). */
export const REVIEW_CONTEXT_KEY = '__review';

/** The first line of every reviewer prompt (the e2e fake keys its reviewer scenario on it). */
export const REVIEW_PROMPT_HEADING = '# Requirements review';

/** The synthetic `workflow_state` of a review step, e.g. `implement → build (review)`. */
export function reviewStateLabel(from: string, to: string): string {
  return `${from} → ${to} (review)`;
}

/** `retry_counters` key of a gated transition's `on_unmet` loop. */
export function reviewCounterKey(from: string, outcome: string): string {
  return `requirements:${from}:${outcome}`;
}

export interface ReviewPromptInput {
  from: string;
  outcome: string;
  to: string;
  items: readonly string[];
  ticket: SessionSnapshot['ticket'];
  /** What the source state reported (see `reviewSubject`). */
  subject: string;
}

export function renderReviewPrompt(i: ReviewPromptInput): string {
  const t = i.ticket;
  return [
    REVIEW_PROMPT_HEADING,
    [
      'You are an independent reviewer. Do not change anything: no edits, no commits, no builds.',
      `The workflow wants to move this ticket from \`${i.from}\` to \`${i.to}\` (outcome \`${i.outcome}\`).`,
      'Before it may, check every requirement below against the work in this git worktree (your current directory).',
    ].join('\n'),
    [
      `## Ticket: ${t.title}`,
      '',
      t.body.trim() || '(no description)',
      '',
      `Repository: ${t.repo}`,
    ].join('\n'),
    `## What \`${i.from}\` reported\n\n${fenced(i.subject)}`,
    ['## Requirements to check', '', ...i.items.map((item, n) => `${n + 1}. ${item}`)].join('\n'),
    [
      '## How to check',
      '',
      'Read the files with Read, Glob and Grep. You may run exactly these git commands, nothing else:',
      ...REVIEW_GIT_COMMANDS.map((c) => `- \`${c}\``),
    ].join('\n'),
    [
      '## When you are done',
      '',
      'Call the `complete_state` tool once with a `result` of this shape, one entry per requirement, in the order above:',
      '',
      '```json',
      '{"verdict": [{"item": "<the requirement, copied exactly>", "met": true, "reason": "<one or two sentences>"}]}',
      '```',
      '',
      '`met` is true or false. Give a reason for every item, and say what is missing for an unmet one. Then stop.',
      'Do not call `ask_user`: if you cannot tell whether a requirement is met, mark it not met and say why.',
    ].join('\n'),
  ].join('\n\n');
}

/** The message that nudges a reviewer once after a missing or malformed verdict. */
export function reviewNudge(why: string, items: readonly string[]): string {
  return [
    `Your review did not produce a usable verdict (${why}).`,
    'Call `complete_state` now with `{"verdict": [{"item", "met", "reason"}, ...]}`: one entry per requirement, `met` a boolean:',
    ...items.map((item, n) => `${n + 1}. ${item}`),
  ].join('\n');
}

/** What a source state reported, for the reviewer's prompt. */
export function reviewSubject(p: {
  detail: string;
  result?: JsonObject | undefined;
  output?: string | undefined;
}): string {
  const lines = [`Outcome detail: ${p.detail}`];
  if (p.result !== undefined)
    lines.push('', 'complete_state result:', JSON.stringify(p.result, null, 2));
  if (p.output) lines.push('', 'Output tail:', p.output);
  return lines.join('\n');
}

export interface VerdictItem {
  item: string;
  met: boolean;
  reason: string;
}

export type ParsedVerdict = { ok: true; items: VerdictItem[] } | { ok: false; error: string };

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Check a reviewer's `complete_state` result against the gate's items. Entries are matched by
 * item text (whitespace and case ignored); if that misses any and the counts are equal, by
 * position (the prompt asks for the same order). Malformed: no `verdict` array, an entry without
 * a boolean `met` or a string `item`, a non-string `reason`, or a requirement left unanswered.
 * The result is in the gate's order with the gate's wording.
 */
export function parseVerdict(result: JsonObject, items: readonly string[]): ParsedVerdict {
  const v = result.verdict;
  if (!Array.isArray(v)) return { ok: false, error: 'result.verdict is not an array' };
  const entries: { item: string; met: boolean; reason: string }[] = [];
  for (const [n, e] of v.entries()) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: `verdict[${n}] is not an object` };
    }
    const o = e;
    if (typeof o.met !== 'boolean')
      return { ok: false, error: `verdict[${n}].met is not a boolean` };
    if (typeof o.item !== 'string')
      return { ok: false, error: `verdict[${n}].item is not a string` };
    if (o.reason !== undefined && typeof o.reason !== 'string') {
      return { ok: false, error: `verdict[${n}].reason is not a string` };
    }
    entries.push({
      item: o.item,
      met: o.met,
      reason: typeof o.reason === 'string' ? o.reason : '',
    });
  }
  const byText = new Map(entries.map((e) => [norm(e.item), e]));
  const matched = items.map((item) => byText.get(norm(item)));
  if (matched.every((m) => m !== undefined)) {
    return {
      ok: true,
      items: items.map((item, n) => ({ item, met: matched[n]!.met, reason: matched[n]!.reason })),
    };
  }
  if (entries.length === items.length) {
    return {
      ok: true,
      items: items.map((item, n) => ({ item, met: entries[n]!.met, reason: entries[n]!.reason })),
    };
  }
  const missing = items.filter((_, n) => matched[n] === undefined);
  return { ok: false, error: `no verdict for: ${missing.map((m) => `"${m}"`).join(', ')}` };
}

/** What `on_unmet.goto`'s next prompt receives (ADR-0009, like `attach: output`). */
export interface ReviewFeedback {
  from: string;
  to: string;
  unmet: { item: string; reason: string }[];
  instruction: string | null;
}

export function renderReviewFeedback(f: ReviewFeedback): string {
  const lines = [
    '## Requirements not met',
    '',
    `Requirements for ${f.from} → ${f.to} were not met:`,
    '',
    ...f.unmet.map((u) => `- ${u.item}: ${u.reason || '(no reason given)'}`),
  ];
  if (f.instruction) lines.push('', f.instruction);
  return lines.join('\n');
}

/** A Markdown code fence long enough that the text can't close it early. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\n$/, '')}\n${fence}`;
}
