import { conditionEnabled, type AgentState, type TicketKind } from '../workflow/schema.js';
import { transitionObject, type AgentTransitionOption } from '../workflow/transition-rules.js';
import { renderReviewFeedback, type ReviewFeedback } from './review.js';
import type { SessionSnapshot } from './types.js';

// Prompt rendering for agent states (05 §State types, 10-contracts §Engine). Pure: apply()
// calls it to build `start_session.prompt`. An agent state's `prompt` is either the name of a
// built-in template (M1: `ticket_template`) or literal prompt text; a `skill` state gets a short
// instruction to run that skill. Every prompt gets the same trailing sections: the state's
// inputs, the attached output of a failed step (`attach: output`), the human's answer, and how
// to finish the state (complete_state / ask_user, ADR-0005).

/** The built-in template both reference workflows use for `implement`. */
export const TICKET_TEMPLATE = 'ticket_template';

/**
 * ADR-0010 `conductor` Planning: read the repo and the ticket, write a plan; no code changes. The
 * state's tools are read-only, so the tool policy enforces what the prompt asks.
 */
export const PLAN_TEMPLATE = 'plan_template';

/** ADR-0010 `conductor` Implementing: change the code following the plan (`$planning.plan`). */
export const IMPLEMENT_TEMPLATE = 'implement_template';

/** Every built-in template name (an agent `prompt` equal to one of these renders it). */
export const PROMPT_TEMPLATES = [TICKET_TEMPLATE, PLAN_TEMPLATE, IMPLEMENT_TEMPLATE] as const;

/** What a retry loop with `attach: output` carries back into the agent state. */
export interface PromptAttachment {
  /** The state whose failure routed here (e.g. `build`). */
  from: string;
  /** One line on how it failed, e.g. `exit code 2`. */
  detail: string;
  /** The output tail (already capped at OUTPUT_TAIL_BYTES by the daemon). */
  output: string;
}

export interface RenderPromptInput {
  stateName: string;
  state: AgentState;
  /** Ticket facts and `context` (for `$state.key` inputs). */
  snapshot: Pick<SessionSnapshot, 'ticket' | 'context'>;
  attachment?: PromptAttachment | null;
  /** A human answer to include (a fresh, non-resumed start after needs_input). */
  answer?: string | null;
  /** ADR-0009: an unmet requirements review that routed here (`on_unmet.goto`). */
  feedback?: ReviewFeedback | null;
  /**
   * ADR-0011: the transitions the agent may name (`promptTransitions`, the same list as
   * `start_session.transitions`), listed under "How to finish". null/absent: the M1 "When you are
   * done" section (old versions).
   */
  transitions?: readonly AgentTransitionOption[] | null;
}

/** Placeholders a literal prompt may use. */
const PLACEHOLDERS: Record<string, (i: RenderPromptInput) => string> = {
  'ticket.title': (i) => i.snapshot.ticket.title,
  'ticket.body': (i) => i.snapshot.ticket.body,
  'ticket.repo': (i) => i.snapshot.ticket.repo,
  'ticket.external_ref': (i) => i.snapshot.ticket.external_ref ?? '',
  state: (i) => i.stateName,
};

export function renderPrompt(input: RenderPromptInput): string {
  const { state, stateName, snapshot } = input;
  const parts: string[] = [];

  if (state.prompt === TICKET_TEMPLATE) {
    parts.push(ticketSection(snapshot.ticket));
  } else if (state.prompt === PLAN_TEMPLATE) {
    parts.push(ticketSection(snapshot.ticket), PLAN_INSTRUCTIONS);
  } else if (state.prompt === IMPLEMENT_TEMPLATE) {
    parts.push(ticketSection(snapshot.ticket), IMPLEMENT_INSTRUCTIONS);
  } else if (state.prompt !== undefined) {
    parts.push(
      state.prompt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key: string) => {
        const fn = PLACEHOLDERS[key];
        return fn ? fn(input) : m;
      }),
    );
  } else if (state.skill !== undefined) {
    parts.push(
      `Run the \`${state.skill}\` skill for workflow step \`${stateName}\`.`,
      ticketSection(snapshot.ticket),
    );
  }

  const inputs = renderInputs(state, snapshot.context);
  if (inputs) parts.push(inputs);

  if (input.attachment) {
    const a = input.attachment;
    parts.push(
      [
        '## Previous attempt failed',
        `The \`${a.from}\` step failed (${a.detail}). The tail of its output:`,
        fenced(a.output),
        'Fix the cause before you finish this step again.',
      ].join('\n\n'),
    );
  }

  if (input.feedback) parts.push(renderReviewFeedback(input.feedback));

  if (input.answer != null) {
    parts.push(`## Answer from a human\n\n${input.answer}`);
  }

  // Ben, 2026-10-26 (M1b): a work repository is shared with developers who don't use conductor.
  if (snapshot.ticket.kind === 'work') parts.push(WORK_REPOSITORY);

  // M2-T35c (ADR-0026): a way out of this state checks the PR for screenshots of UI changes.
  const uiPaths = screenshotPaths(state, snapshot.ticket.kind ?? null);
  if (uiPaths.length > 0) parts.push(screenshotsSection(uiPaths));

  parts.push(
    input.transitions != null ? howToFinish(state, input.transitions) : finishSection(state),
  );
  return parts.join('\n\n');
}

/** The heading of the before/after screenshots instructions (M2-T35c). */
export const SCREENSHOTS_HEADING = '## Screenshots of UI changes';

/**
 * The `ui_paths` of every enabled `pr_screenshots` condition on this state's transitions that a
 * ticket of `kind` can take (a null kind sees every transition), without duplicates.
 */
function screenshotPaths(state: AgentState, kind: TicketKind | null): string[] {
  const out = new Set<string>();
  for (const raw of Object.values(state.on ?? {})) {
    const t = transitionObject(raw);
    if (kind !== null && t.kinds !== undefined && !t.kinds.includes(kind)) continue;
    for (const c of t.requires?.conditions ?? []) {
      if (c.type === 'pr_screenshots' && conditionEnabled(c)) c.ui_paths.forEach((p) => out.add(p));
    }
  }
  return [...out];
}

function screenshotsSection(uiPaths: readonly string[]): string {
  return [
    SCREENSHOTS_HEADING,
    '',
    `If your change alters anything a user sees (files matching ${uiPaths.map((p) => `\`${p}\``).join(', ')}), the pull request must show a before and an after screenshot of each changed view; conductor checks this and sends the work back without them.`,
    '',
    '1. Before: the default branch. Export it without touching this worktree, e.g. `git archive $(git merge-base HEAD origin/HEAD) | tar -x -C <a temporary dir>`, then build and serve it there.',
    '2. After: this branch, built and served from the worktree.',
    '3. Serve each on a port from your range (`$CONDUCTOR_PORT_BASE`, `$CONDUCTOR_PORT_COUNT` ports) and capture the same view of both with a headless browser: Chrome (`--headless=new --screenshot=<file> --window-size=1280,800 <url>`), or Playwright or Puppeteer.',
    '4. Save them as `$CONDUCTOR_SCREENSHOT_DIR/before-<view>.png` and `$CONDUCTOR_SCREENSHOT_DIR/after-<view>.png` (`<view>`: lower-case letters, digits and dashes; PNG, at most 5 MB each). Do not commit them: conductor attaches them to the pull request.',
    '',
    'If nothing a user sees changed, skip this.',
  ].join('\n');
}

const PLAN_INSTRUCTIONS = [
  '## Your step: planning',
  '',
  'Read the repository and work out how to do this ticket. Do not change any files, run builds or commit: this step only plans.',
  'Write a plan another agent can follow: the files to change, the approach, the tests to add or update, and anything risky or unclear.',
  'Finish with `complete_state` and a result `{"plan": "<the plan, in Markdown>", "summary": "<one or two sentences>"}`.',
].join('\n');

const IMPLEMENT_INSTRUCTIONS = [
  '## Your step: implementing',
  '',
  'Make the change, following the plan under Inputs (written in the planning step; adapt it where the code tells you otherwise).',
  'Add or update tests. Before you finish, commit everything on the current branch (`git add` and `git commit`) so that `git status` is clean: only committed changes are checked and pushed, and a worktree with uncommitted changes is sent back to you. Do not push. Conductor then checks that the build and the tests pass on your last commit, pushes it and opens the pull request itself.',
  'Finish with `complete_state` and a result that includes `"summary"`: a short description of the change, used as the pull request description.',
].join('\n');

function ticketSection(t: RenderPromptInput['snapshot']['ticket']): string {
  const lines = [`# Ticket: ${t.title}`, '', t.body.trim() || '(no description)', ''];
  lines.push(`Repository: ${t.repo}`);
  if (t.external_ref) lines.push(`External reference: ${t.external_ref}`);
  return lines.join('\n');
}

/** `input` values: literals as-is, `$state.key` resolved from `context` (05 rule 5). */
function renderInputs(state: AgentState, context: SessionSnapshot['context']): string | null {
  const entries = Object.entries(state.input ?? {});
  if (entries.length === 0) return null;
  const lines = entries.map(([key, value]) => {
    const resolved = formatInput(value, context);
    // M1b (T02 rule 5): a human move may reach this state without the step that produces a
    // `$ref` input (an operator override, like "skip to"); say so instead of "(missing)".
    return resolved === null ? notProduced(key) : `- ${key}: ${resolved}`;
  });
  return ['## Inputs', '', ...lines].join('\n');
}

function notProduced(key: string): string {
  return `- \`${key}\`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket.`;
}

/** A literal as text, a `$state.key` ref resolved from `context`; null when the ref resolves to nothing. */
function formatInput(
  value: string | number | boolean,
  context: SessionSnapshot['context'],
): string | null {
  if (typeof value !== 'string') return String(value);
  const ref = /^\$([^.]+)\.(.+)$/.exec(value);
  if (!ref) return value;
  const [, from = '', key = ''] = ref;
  const resolved = context[from]?.[key];
  if (resolved === undefined) return null;
  return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
}

/** The heading of the work-commit rule (a `kind: 'work'` ticket's agent prompts only). */
export const WORK_REPOSITORY_HEADING = '## Work repository';

const WORK_REPOSITORY = [
  WORK_REPOSITORY_HEADING,
  '',
  'This repository belongs to a team whose other developers do not use conductor. Commit only changes that make sense to them.',
  'Do not commit workflow or agent configuration, notes for conductor, or anything else specific to this tool.',
].join('\n');

/** The heading of the ADR-0011 finish section. */
export const HOW_TO_FINISH_HEADING = '## How to finish';

/**
 * ADR-0011: each transition the agent may take, `- <name>: <when>`, and how to name it in
 * `complete_state`. `ask_user` (the built-in fallback, U-061) gets a default `when`.
 */
function howToFinish(state: AgentState, transitions: readonly AgentTransitionOption[]): string {
  const keys = state.result ?? [];
  const result =
    keys.length > 0
      ? `a \`result\` object containing ${keys.map((k) => `\`${k}\``).join(', ')}`
      : 'a `result` object summarising what you did';
  const lines = transitions.map((t) => {
    const when =
      t.when ?? (t.name === 'ask_user' ? 'You are blocked and need a human decision.' : null);
    const ask = t.question ? ' Your `reason` is the question for the human.' : '';
    return when !== null ? `- ${t.name}: ${when}${ask}` : `- ${t.name}${ask ? `:${ask}` : ''}`;
  });
  return [
    HOW_TO_FINISH_HEADING,
    '',
    'When you finish this step, take exactly one of these transitions:',
    '',
    ...lines,
    '',
    `Call the \`complete_state\` tool once with \`transition\` set to its name, \`reason\` saying why in one or two sentences, and ${result}, then stop.`,
    'For a transition that asks a human, write the question in `reason`; the `result` may then be empty.',
    'Any other name is refused.',
  ].join('\n');
}

function finishSection(state: AgentState): string {
  const keys = state.result ?? [];
  const result =
    keys.length > 0
      ? `call the \`complete_state\` tool with a \`result\` object containing ${keys
          .map((k) => `\`${k}\``)
          .join(', ')}`
      : 'call the `complete_state` tool with a `result` object summarising what you did';
  return [
    '## When you are done',
    '',
    `When the work for this step is finished, ${result}, then stop.`,
    'If you are blocked and need a human decision, call `ask_user` with one clear question and end your turn.',
  ].join('\n');
}

/** A Markdown code fence long enough that the output can't close it early. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\n$/, '')}\n${fence}`;
}
