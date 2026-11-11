import { pagesSpec, resultKeys, type AgentState, type FollowUps } from '../workflow/schema.js';
import type { SentBack } from './qa.js';
import type { AgentTransitionOption } from '../workflow/transition-rules.js';
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
  /** ADR-0020 §2 (`attach: 'result'`): the findings of the QA round that sent the ticket back. */
  sentBack?: SentBack | null;
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
    parts.push(ticketSection(snapshot.ticket), withHint(PLAN_INSTRUCTIONS, state));
    // ADR-0037 §4 (C2): an L ticket is split before implementing; S and M get no extra line.
    if (snapshot.ticket.size === 'L') {
      parts.push(
        state.follow_ups?.enabled === false
          ? PLAN_SIZE_NO_PROPOSALS_INSTRUCTION
          : PLAN_SIZE_INSTRUCTION,
      );
    }
  } else if (state.prompt === IMPLEMENT_TEMPLATE) {
    parts.push(ticketSection(snapshot.ticket), withHint(IMPLEMENT_INSTRUCTIONS, state));
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

  if (input.sentBack) parts.push(renderSentBack(input.sentBack));

  if (input.answer != null) {
    parts.push(`## Answer from a human\n\n${input.answer}`);
  }

  // Ben, 2026-10-26 (M1b): a work repository is shared with developers who don't use conductor.
  if (snapshot.ticket.kind === 'work') parts.push(WORK_REPOSITORY);

  // ADR-0034: a state's own follow-up settings replace the built-in templates' one-line hint.
  if (state.follow_ups?.enabled === true) {
    parts.push(renderFollowUps(state.follow_ups, snapshot.ticket.repo));
  }

  // ADR-0038: only a state with a `{pages: {max}}` result entry gets this section.
  const pages = renderPages(state);
  if (pages !== null) parts.push(pages);

  parts.push(
    input.transitions != null ? howToFinish(state, input.transitions) : finishSection(state),
  );
  return parts.join('\n\n');
}

/**
 * Optional follow-up tickets (06 §Proposed tickets): never in a state's `result` list, so a result
 * without `proposed_tickets` behaves as before. Read by `proposalsOfContext` (api/proposals.ts).
 */
export const PROPOSALS_HINT =
  'If you notice worthwhile work outside this ticket\'s scope, you may add `"proposed_tickets"` to your result: up to three `{"title", "repo", "why"}` entries. It\'s optional. Leave it out if nothing stands out, and don\'t do that work here.';

/**
 * The built-in instructions with PROPOSALS_HINT only while the state leaves `follow_ups` unset
 * (ADR-0034): set, it says itself whether (and how) the agent may propose follow-ups.
 */
function withHint(instructions: string, state: Pick<AgentState, 'follow_ups'>): string {
  if (state.follow_ups === undefined) return instructions;
  const text = instructions.replace(`\n${PROPOSALS_HINT}`, '');
  // C2: a state that reads no proposals must not be told to put out-of-scope work there.
  return state.follow_ups.enabled
    ? text
    : text.replace(IMPLEMENT_SCOPE_INSTRUCTION, IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION);
}

/** The heading of the follow-up section of a state with `follow_ups` on (ADR-0034). */
export const FOLLOW_UPS_HEADING = '## Follow-up tickets (optional)';

/** The prompt section of a state with `follow_ups` on: at most `max`, then its `guidance`. */
export function renderFollowUps(cfg: FollowUps, repo: string): string {
  const entry = `{"title": "…", "repo": ${JSON.stringify(repo)}, "why": "<one or two sentences>"}`;
  const lines = [
    FOLLOW_UPS_HEADING,
    '',
    "If you notice separate, worthwhile work outside this ticket's scope, you may propose it as its own ticket.",
    `Add \`"proposed_tickets": [${entry}]\` to your result, at most ${cfg.max} (\`repo\` is the repository the work belongs in).`,
    "A human approves or dismisses each one. It's optional: leave it out if nothing stands out, and don't do that work here.",
  ];
  if (cfg.guidance !== undefined) lines.push('', cfg.guidance);
  return lines.join('\n');
}

/** The heading of the ADR-0038 pages section. */
export const PAGES_HEADING = '## Pages (optional)';

/**
 * ADR-0038: how to attach rendered pages to the result, for a state with `{pages: {max}}` in its
 * `result`; and, when it also has the `pages` tool, how to publish one. null otherwise.
 */
export function renderPages(state: Pick<AgentState, 'result' | 'tools'>): string | null {
  const spec = pagesSpec(state);
  if (spec === null) return null;
  const lines = [
    PAGES_HEADING,
    '',
    'To show the human something rendered (a mockup, a diagram, a data walkthrough), add ' +
      `\`"pages": [{"url": "…", "title": "…"}]\` to your result, at most ${spec.max}. ` +
      'A page URL is https. The human opens each page from the card.',
  ];
  if ((state.tools ?? []).includes('pages')) {
    lines.push(
      'Publish a page with the `publish_page` tool: one self-contained HTML document, inline CSS and JavaScript only (no external URLs: they are blocked), images as data: URLs. It expires after 7 days. Put the URL it returns in `pages`.',
    );
  }
  lines.push(
    "Never commit pages to the repository. It's optional: leave `pages` out if words are enough.",
  );
  return lines.join('\n');
}

/**
 * ADR-0037 P4: the planning template asks for the paths the plan expects to touch, in the plan and
 * as the optional `files` result key (api/planned-files.ts reads it).
 */
export const PLAN_FILES_INSTRUCTION =
  'End the plan with a `## Files` heading: the repo-relative paths or path globs (e.g. `packages/web/src/**`) you expect to create or edit, one per line. Put the same list in the result as `"files": ["…"]`, or `[]` if the ticket changes no files.';

/**
 * ADR-0037 §4 (C2): the planning line an `L` ticket gets (`ticket.size`), after the instructions.
 * The `_NO_PROPOSALS_` variant is for a state whose `follow_ups` are off (no `proposed_tickets`).
 */
export const PLAN_SIZE_INSTRUCTION =
  'This ticket is sized L: unless its body says otherwise, plan only the first independently shippable piece and put the rest in `proposed_tickets` (title, repo, one-line why) before implementing.';
export const PLAN_SIZE_NO_PROPOSALS_INSTRUCTION =
  'This ticket is sized L: unless its body says otherwise, ask with `ask_user` whether to split it before planning the whole thing.';

/**
 * ADR-0037 §4 (C2): the implementing step's scope rule. The `_NO_PROPOSALS_` variant replaces it
 * in a state whose `follow_ups` are off.
 */
export const IMPLEMENT_SCOPE_INSTRUCTION =
  "Do only what the ticket's Goal and Functional requirements ask. Anything else you notice (a fix, a refactor, a missing gate) becomes a `proposed_tickets` entry with a one-line why, never a commit in this PR. If a requirement cannot be met without an out-of-scope change, ask with `ask_user` and name the change.";
export const IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION =
  "Do only what the ticket's Goal and Functional requirements ask. Anything else you notice (a fix, a refactor, a missing gate) becomes a line under a `Follow-ups` heading in your summary, never a commit in this PR. If a requirement cannot be met without an out-of-scope change, ask with `ask_user` and name the change.";

/** ADR-0037 §4 (C2): update tests alongside each change, not in one batch at the end. */
export const IMPLEMENT_TESTS_INSTRUCTION =
  'When you restructure UI or change a type that many tests match on, update the affected tests with each component or type change, not in one batch at the end, and run the targeted tests after each.';

const PLAN_INSTRUCTIONS = [
  '## Your step: planning',
  '',
  'Read the repository and work out how to do this ticket. Do not change any files, run builds or commit: this step only plans.',
  'Write a plan another agent can follow: the files to change, the approach, the tests to add or update, and anything risky or unclear.',
  PLAN_FILES_INSTRUCTION,
  PROPOSALS_HINT,
  'Finish with `complete_state` and a result `{"plan": "<the plan, in Markdown>", "summary": "<one or two sentences>", "files": ["<path or glob>", …]}`.',
].join('\n');

/**
 * The implement prompt's line on check-config failures: the repo checks are conductor's config,
 * which the agent may only propose a change to (ask_user `proposed_checks`), never edit.
 */
export const CHECK_CONFIG_HINT =
  "If a check or its setup fails because of conductor's check config rather than your branch (for example a setup command that can't work in a fresh checkout), don't retry: propose the fix with `ask_user`'s `proposed_checks` (the repo's full corrected checks) and Ben confirms it.";

/**
 * R4 (FR-4): the implement prompt's line on `run_gate`, the outcome server's tool that runs a
 * transition's gate checks in a fresh checkout before the agent takes it. A machine whose daemon
 * lacks the tool gets RUN_GATE_FALLBACK_NOTE after it (orchestrator `withRunGateFeature`).
 */
export const RUN_GATE_INSTRUCTION =
  'Before you call `complete_state` with a transition that runs checks, call `run_gate` with that `transition` and fix what fails (commit each fix) until it passes: it runs exactly the checks conductor runs when you take it, setup included, in a fresh checkout of your last commit. Do not guess the build or lint commands.';

const IMPLEMENT_INSTRUCTIONS = [
  '## Your step: implementing',
  '',
  'Make the change, following the plan under Inputs (written in the planning step; adapt it where the code tells you otherwise).',
  IMPLEMENT_SCOPE_INSTRUCTION,
  IMPLEMENT_TESTS_INSTRUCTION,
  'Add or update tests. Before you finish, commit everything on the current branch (`git add` and `git commit`) so that `git status` is clean: only committed changes are checked and pushed, and a worktree with uncommitted changes is sent back to you. Do not push. Conductor then checks that the build and the tests pass on your last commit, pushes it and opens the pull request itself.',
  RUN_GATE_INSTRUCTION,
  CHECK_CONFIG_HINT,
  PROPOSALS_HINT,
  'Finish with `complete_state` and a result that includes `"summary"`: a short description of the change, used as the pull request description.',
].join('\n');

function ticketSection(t: RenderPromptInput['snapshot']['ticket']): string {
  const lines = [`# Ticket: ${t.title}`, '', t.body.trim() || '(no description)', ''];
  lines.push(`Repository: ${t.repo}`);
  if (t.size) lines.push(`Size: ${t.size}`);
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
  const keys = resultKeys(state);
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
  const keys = resultKeys(state);
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
    'If you are blocked and need a human decision, call `ask_user` with one clear question (and `options` when the answer is one of a few choices) and end your turn.',
  ].join('\n');
}

/** The heading prefix of the `attach: 'result'` section. */
export const SENT_BACK_HEADING = '## Sent back by';

/**
 * ADR-0020 §2: what a QA's `qa_fail` sends the worker: the summary, the required fixes
 * (numbered), the blocker and major findings, and the instruction.
 */
export function renderSentBack(s: SentBack): string {
  const r = s.result;
  const lines = [`${SENT_BACK_HEADING} ${s.title}`, '', r.summary];
  if (r.required_fixes.length > 0) {
    lines.push('', 'Required fixes:', ...r.required_fixes.map((f, i) => `${i + 1}. ${f}`));
  }
  const serious = r.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  if (serious.length > 0) {
    lines.push(
      '',
      'Findings:',
      ...serious.map((f) => {
        const at =
          f.file !== undefined ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : '';
        return `- [${f.severity}] ${f.text}${at}`;
      }),
    );
  }
  lines.push('', 'Fix every required item, commit, then finish again.');
  return lines.join('\n');
}

/** A Markdown code fence long enough that the output can't close it early. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\n$/, '')}\n${fence}`;
}
