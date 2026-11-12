import { z } from 'zod';
import type { JsonObject } from '../domain.js';
import { stateTitle } from '../workflow/conductor.js';
import {
  isTriageState,
  MoveCauseSchema,
  type AgentState,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { triageLegs } from '../workflow/validate-triage.js';
import { PR_CONTEXT_KEY } from './review.js';
import { renderPrompt } from './render.js';
import { promptTransitions, ticketKind } from './transitions.js';
import type { Effect, GateStep, SessionSnapshot } from './types.js';

// ADR-0043: the triage role. Pure helpers; apply.ts routes to them only for a `role: 'triage'`
// state (or a leg of one), so a definition without one never reaches this file.

/** Session context key of the triage bookkeeping (TriageContext); in RESERVED_CONTEXT_KEYS. */
export const TRIAGE_CONTEXT_KEY = '__triage';

/** The longest evidence text kept (the question conductor would have asked a human). */
export const TRIAGE_EVIDENCE_MAX = 16_000;
/** The longest output kept per unmet item. */
const OUTPUT_MAX = 8_000;

/** The gate step that failed, enough to run it again (`$gate`), as `gate.retry` does. */
export const TriageGateSchema = z.object({
  kind: z.enum(['transition', 'entry', 'move']),
  from: z.string(),
  outcome: z.string(),
  to: z.string(),
  transition: z.string().nullable(),
  actor: z.enum(['agent', 'human', 'system']).nullable(),
  reason: z.string().nullable(),
});
export type TriageGate = z.infer<typeof TriageGateSchema>;

/**
 * `context.__triage`: what failed, written when a failure leg enters a triage state, kept while
 * the triage state and its legs (and a human it escalated to) work on it.
 */
export const TriageContextSchema = z.object({
  /** The gate step that failed; null when the failure was not a gate (a failed agent loop). */
  gate: TriageGateSchema.nullable(),
  /** The state that failed: `$return_to`'s target. */
  return_to: z.string(),
  /** Why it failed (ADR-0037 P7): `check_failed`, `retries_exhausted`, `timeout`, … */
  cause: MoveCauseSchema,
  /** The transition (or outcome) that failed: the metrics' and the counters' key. */
  transition: z.string(),
  /** The evidence: what conductor would have asked a human. */
  question: z.string(),
  unmet: z.array(z.object({ item: z.string(), reason: z.string(), output: z.string().optional() })),
  /** The triage session's own Claude conversation (never the worker's `claude_session_id`). */
  claude_session_id: z.string().nullable(),
});
export type TriageContext = z.infer<typeof TriageContextSchema>;

type Context = SessionSnapshot['context'];

export function triageOf(context: Context): TriageContext | null {
  const parsed = TriageContextSchema.safeParse(context[TRIAGE_CONTEXT_KEY]);
  return parsed.success ? parsed.data : null;
}

export function withTriage(context: Context, t: TriageContext | null): Context {
  const rest = { ...context };
  delete rest[TRIAGE_CONTEXT_KEY];
  return t === null ? rest : { ...rest, [TRIAGE_CONTEXT_KEY]: t as unknown as JsonObject };
}

export function patchTriage(context: Context, patch: Partial<TriageContext>): Context {
  const t = triageOf(context);
  return t === null ? context : withTriage(context, { ...t, ...patch });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The evidence of a failure route: the question without its "Retry, skip, or abort?" tail. */
export function planTriageEntry(p: {
  step: GateStep | null;
  from: string;
  cause: TriageContext['cause'];
  transition: string | null;
  question: string;
  unmet: { item: string; reason: string; output?: string }[];
}): TriageContext {
  const r = p.step;
  return {
    gate:
      r === null
        ? null
        : {
            kind: r.kind,
            from: r.from,
            outcome: r.outcome,
            to: r.to,
            transition: r.transition,
            actor: r.actor,
            reason: r.reason,
          },
    return_to: r?.from ?? p.from,
    cause: p.cause,
    transition: p.transition ?? r?.transition ?? r?.outcome ?? p.from,
    question: clip(
      p.question.replace(/\s*Retry, skip, or abort\?\s*$/, '').trim(),
      TRIAGE_EVIDENCE_MAX,
    ),
    unmet: p.unmet.map((u) => ({
      item: u.item,
      reason: u.reason,
      ...(u.output !== undefined ? { output: clip(u.output, OUTPUT_MAX) } : {}),
    })),
    claude_session_id: null,
  };
}

/**
 * Whether entering `target` keeps `__triage`: a triage state, a leg of one, or a human state the
 * triage escalated to (its `$return_to` comes back to triage, which needs the evidence again).
 */
export function keepsTriage(def: WorkflowDefinition, from: string | null, target: string): boolean {
  const to = def.states[target];
  if (isTriageState(to)) return true;
  const legs = triageLegs(def);
  if (legs.has(target)) return true;
  if (to?.type !== 'human' || from === null) return false;
  return isTriageState(def.states[from]) || legs.has(from);
}

/** `## What failed`: the evidence section of a triage prompt. */
export function renderTriageEvidence(
  def: WorkflowDefinition,
  t: TriageContext,
  context: Context,
): string {
  const lines = [
    '## What failed',
    '',
    `- State: "${stateTitle(def, t.return_to)}" (\`${t.return_to}\`)`,
    `- Transition: \`${t.transition}\``,
    `- Cause: \`${t.cause}\``,
  ];
  if (t.gate !== null) {
    lines.push(
      `- Gate: ${t.gate.kind} step "${t.gate.from}" → "${t.gate.to}" (\`$gate\` runs it again)`,
    );
  } else {
    lines.push('- Gate: none (this failure was not a gate step, so `$gate` is not available)');
  }
  const pr = context[PR_CONTEXT_KEY]?.pr_url;
  if (typeof pr === 'string') lines.push(`- Pull request: ${pr}`);
  lines.push('', '### Evidence', '', t.question || '(no evidence recorded)');
  for (const u of t.unmet) {
    if (u.output === undefined || t.question.includes(u.output)) continue;
    lines.push('', `Output of "${u.item}":`, '```', u.output, '```');
  }
  lines.push(
    '',
    '### Your job',
    '',
    "You are conductor triaging this failure on Ben's behalf. Read the evidence (the repository, `git`, and read-only `gh` for CI logs and PR checks), then pick exactly one declared transition. You cannot change the branch.",
    "- Sending the work back: put a precise, actionable instruction for the implementer in your result's `instruction` key.",
    '- Escalating: your `reason` is the diagnosis Ben reads first; say what you checked and what you think he should decide.',
  );
  return lines.join('\n');
}

/** The instruction a `$return_to` verdict carries: the result's `instruction`, else the reason. */
export function triageInstruction(result: JsonObject | undefined, reason: string | undefined) {
  const i = result?.instruction;
  if (typeof i === 'string' && i.trim() !== '') return i.trim();
  return reason !== undefined && reason.trim() !== '' ? reason.trim() : null;
}

/**
 * The triage's start: always a fresh Claude session (never the worker's), `review: true` (forced
 * dontAsk, no MCP, no skip-permissions), the `triage` tool alias whatever the state lists, no
 * checkout (it reads the worktree). A human's answer goes into the rendered prompt.
 */
export function triageStartSession(
  def: WorkflowDefinition,
  s: SessionSnapshot,
  name: string,
  state: AgentState,
  p: { answer: string | null },
): Extract<Effect, { type: 'start_session' }> {
  const transitions = promptTransitions(def, name, ticketKind(s));
  const t = triageOf(s.context);
  const prompt = [
    renderPrompt({
      stateName: name,
      state,
      snapshot: s,
      attachment: null,
      answer: p.answer,
      feedback: null,
      transitions,
    }),
    t !== null
      ? renderTriageEvidence(def, t, s.context)
      : '## What failed\n\nConductor recorded no failure for this visit: escalate to a human.',
  ].join('\n\n');
  return {
    type: 'start_session',
    state: name,
    prompt,
    tools: ['triage'],
    resume_claude_session_id: null,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.max_turns !== undefined ? { max_turns: state.max_turns } : {}),
    max_budget_usd: Math.max(0, def.budget.usd - s.spend_usd),
    review: true,
    ...(transitions !== null ? { transitions } : {}),
  };
}
