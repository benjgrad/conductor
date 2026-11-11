import { z } from 'zod';
import type { JsonObject } from '../domain.js';
import type { QuestionOptions } from '../protocol/question-options.js';
import { transitionObject } from '../workflow/transition-rules.js';
import type { DefaultAnswer, WorkflowDefinition } from '../workflow/schema.js';
import type { SessionSnapshot } from './types.js';

// ADR-0041: a question no human answers within its transition's `default.after` is answered with
// the agent's own recommended answer. apply.ts drives it: landing in the human state arms
// `context.__default` (and the request's `default_at`, the sweep's timer); `default.fired`
// delivers the answer to `return_to` as `input.provided` would; `human.overrule` hands a human's
// correction to the agent afterwards. These are the pure parts.

/** The armed default of the current human-state visit. */
export const DEFAULT_CONTEXT_KEY = '__default';
/** The last default conductor took, while a human may still overrule it. */
export const DEFAULT_TAKEN_CONTEXT_KEY = '__default_taken';
/** The longest recommended answer conductor keeps (longer → no default). */
export const MAX_RECOMMENDED_CHARS = 4_000;

export const DefaultRuntimeSchema = z.object({
  /** The human state the question waits in. */
  state: z.string(),
  /** Its visit (`state_visits[state]`) when armed. */
  visit: z.number().int().positive(),
  /** Where the answer goes: the asking state. */
  return_to: z.string(),
  /** The transition the agent took to ask. */
  transition: z.string(),
  recommended: z.string().min(1),
  /** The transition's `default.after`, for the words. */
  after: z.string(),
  /** When the default is taken (ISO): the request's `default_at`. */
  at: z.string(),
});
export type DefaultRuntime = z.infer<typeof DefaultRuntimeSchema>;

export const DefaultTakenSchema = z.object({
  input_request_id: z.string(),
  /** The agent state the answer went to, and that visit. */
  state: z.string(),
  visit: z.number().int().positive(),
  /** The recommended answer conductor gave. */
  answer: z.string(),
  at: z.string(),
});
export type DefaultTaken = z.infer<typeof DefaultTakenSchema>;

type Context = SessionSnapshot['context'];

function read<T>(context: Context, key: string, schema: z.ZodType<T>): T | null {
  const raw = context[key];
  if (raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function write(context: Context, key: string, value: unknown): Context {
  const { [key]: _old, ...rest } = context;
  void _old;
  return value === null ? rest : { ...rest, [key]: value as never };
}

export function defaultRuntime(context: Context): DefaultRuntime | null {
  return read(context, DEFAULT_CONTEXT_KEY, DefaultRuntimeSchema);
}

export function withDefault(context: Context, rt: DefaultRuntime | null): Context {
  return write(context, DEFAULT_CONTEXT_KEY, rt);
}

export function defaultTakenOf(context: Context): DefaultTaken | null {
  return read(context, DEFAULT_TAKEN_CONTEXT_KEY, DefaultTakenSchema);
}

export function withDefaultTaken(context: Context, taken: DefaultTaken | null): Context {
  return write(context, DEFAULT_TAKEN_CONTEXT_KEY, taken);
}

/** `retry_counters` key of the defaults taken for questions asked from `state`. */
export function defaultCounterKey(state: string): string {
  return `default:${state}`;
}

function cleanRecommended(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t === '' || t.length > MAX_RECOMMENDED_CHARS ? null : t;
}

/** `complete_state`'s `result.recommended`, when it is a usable answer; else null. */
export function recommendedFromResult(result: JsonObject | undefined): string | null {
  return cleanRecommended(result?.recommended);
}

/**
 * The `ask_user` tool's recommended answer: the first option of a single-select list (the tool
 * asks for the recommended one first, and the card's one-click button is that option). None for
 * a multi-select list or no options.
 */
export function recommendedFromOptions(options: QuestionOptions | undefined): string | null {
  if (options === undefined || options.multi_select) return null;
  return cleanRecommended(options.items[0]?.label);
}

/** The `default` of transition `outcome` out of `from`, or null. */
export function defaultSpec(
  def: WorkflowDefinition,
  from: string,
  outcome: string,
): DefaultAnswer | null {
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return null;
  const raw = state.on?.[outcome];
  if (raw === undefined) return null;
  return transitionObject(raw).default ?? null;
}

/** What the agent is told when conductor answers for the human. */
export function defaultAnswerText(recommended: string, after: string): string {
  return (
    `No human answered within ${after}, so conductor took your recommended answer: ${recommended}\n\n` +
    'A human may still overrule it; if a correction arrives, follow it.'
  );
}

/** What the agent is told when a human overrules that answer. */
export function overruleText(answer: string, text: string): string {
  return (
    `A human overruled the answer conductor gave on their behalf ("${answer}"). ` +
    `Use this instead:\n\n${text}`
  );
}

/**
 * May a human overrule the default `taken` now? While the session is still on the visit of the
 * agent state the answer went to, before it moved on or asked again, and the correction can
 * reach the agent: it is `queued` (the correction joins the pending answer the next start
 * delivers) or `running` with a live process (a `send_message`). An agent that is still starting
 * can't be reached (a start already sent carries the old answer): refused until it runs. The
 * engine's `human.overrule` and the session detail's `overrulable` both read this.
 */
export function canOverrule(
  s: Pick<
    SessionSnapshot,
    'status' | 'workflow_state' | 'state_visits' | 'context' | 'step' | 'agent_process_live'
  >,
): DefaultTaken | null {
  const taken = defaultTakenOf(s.context);
  if (taken === null || s.step !== null) return null;
  if (s.workflow_state !== taken.state) return null;
  if ((s.state_visits[taken.state] ?? 0) !== taken.visit) return null;
  if (s.status === 'queued') return taken;
  if (s.status === 'running' && s.agent_process_live) return taken;
  return null;
}
