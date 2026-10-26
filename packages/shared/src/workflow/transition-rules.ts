import { z } from 'zod';
import {
  RETURN_TO,
  type TicketKind,
  type Transition,
  type TransitionActor,
  type TransitionObject,
  type WorkflowDefinition,
} from './schema.js';

// ADR-0011: pure helpers over a definition's transitions, shared by the validator (T02), the
// engine (T03, T08), the card derivation (api/rest.ts) and the editor (T06). Contract (M1b-T01).

type Def = Pick<WorkflowDefinition, 'states'>;

/** Names that are always `system` (timeouts, command exits, connector results, the budget). */
export const SYSTEM_TRANSITION_NAMES: readonly string[] = [
  'timeout',
  'exit_0',
  'fail',
  'ok',
  'error',
  'budget_exceeded',
];

/**
 * Built-in routes to a human. They never run requirements (ADR-0011), and the legacy fold never
 * puts a state's `entry` on them.
 */
export const FALLBACK_TRANSITION_NAMES: readonly string[] = [
  'ask_user',
  'timeout',
  'budget_exceeded',
];

/** `"x"` → `{goto: "x"}`; an object is returned as is. */
export function transitionObject(t: Transition): TransitionObject {
  return typeof t === 'string' ? { goto: t } : t;
}

/** The transition's target, as written (`RETURN_TO` is not resolved). */
export function transitionGoto(t: Transition): string {
  return typeof t === 'string' ? t : t.goto;
}

/** A transition's button / timeline label: its `title`, else the name humanised. */
export function transitionTitle(name: string, t: Transition | undefined): string {
  if (t !== undefined && typeof t === 'object' && t.title !== undefined) return t.title;
  const words = name.replace(/[_.]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Who may take transition `name` out of `state` (ADR-0011 §Who takes a transition): an explicit
 * `actor`; else `system` for SYSTEM_TRANSITION_NAMES and an event state's `wait_for` names; else
 * `human` out of a human state; else `agent`.
 */
export function transitionActor(
  def: Def,
  state: string,
  name: string,
  t: Transition,
): TransitionActor {
  if (typeof t === 'object' && t.actor !== undefined) return t.actor;
  if (SYSTEM_TRANSITION_NAMES.includes(name)) return 'system';
  const s = def.states[state];
  if (s?.type === 'event' && s.wait_for.includes(name)) return 'system';
  if (s?.type === 'human') return 'human';
  return 'agent';
}

/** `kinds` omitted → both; a null ticket kind matches every transition (U-062). */
export function transitionMatchesKind(t: Transition, kind: TicketKind | null): boolean {
  if (kind === null || typeof t === 'string' || t.kinds === undefined) return true;
  return t.kinds.includes(kind);
}

export interface TransitionEntry {
  name: string;
  /** Normalised (`transitionObject`). */
  transition: TransitionObject;
  actor: TransitionActor;
}

/**
 * The transitions out of `state`, in definition order, optionally filtered by actor and by the
 * ticket's kind (pass `kind: null` for "matches both"; omit `kind` for no filter).
 */
export function transitionsOf(
  def: Def,
  state: string,
  filter: { actor?: TransitionActor; kind?: TicketKind | null } = {},
): TransitionEntry[] {
  const s = def.states[state];
  if (s === undefined || s.type === 'terminal' || s.on === undefined) return [];
  const out: TransitionEntry[] = [];
  for (const [name, t] of Object.entries(s.on)) {
    const actor = transitionActor(def, state, name, t);
    if (filter.actor !== undefined && actor !== filter.actor) continue;
    if (filter.kind !== undefined && !transitionMatchesKind(t, filter.kind)) continue;
    out.push({ name, transition: transitionObject(t), actor });
  }
  return out;
}

/**
 * One allowed agent transition, as the agent sees it: in the prompt's "How to finish" list and
 * in `start_session.transitions` (the daemon's outcome server checks names against it).
 */
export const AgentTransitionOptionSchema = z.object({
  name: z.string().min(1),
  /** The transition's `when`, or null. */
  when: z.string().nullable(),
  /** `question: true`: the agent's `reason` is the question for the human. */
  question: z.boolean(),
});
export type AgentTransitionOption = z.infer<typeof AgentTransitionOptionSchema>;

/**
 * The agent-actor transitions out of `state` for a ticket of `kind` (null = both). `ask_user`
 * is included when declared (U-061: the built-in fallback). Empty for a non-agent state.
 */
export function agentTransitionOptions(
  def: Def,
  state: string,
  kind: TicketKind | null,
): AgentTransitionOption[] {
  if (def.states[state]?.type !== 'agent') return [];
  return transitionsOf(def, state, { actor: 'agent', kind }).map((e) => ({
    name: e.name,
    when: e.transition.when ?? null,
    question: e.transition.question === true,
  }));
}

/**
 * Whether a human button for this transition asks for text first (ADR-0011 §Who takes a
 * transition): `RETURN_TO` (the text is the answer the agent resumes on) and a move into an event
 * state (who or what it waits on, stored as the reason). Optional text elsewhere.
 */
export function transitionNeedsText(def: Def, t: Transition): boolean {
  const goto = transitionGoto(t);
  if (goto === RETURN_TO) return true;
  return def.states[goto]?.type === 'event';
}

/** One human button on a card (BoardCard.human_transitions). */
export const HumanTransitionOptionSchema = z.object({
  name: z.string().min(1),
  /** `transitionTitle(name, t)`: the button label. */
  title: z.string(),
  /** The target state; `RETURN_TO` resolved to the session's `return_to` when known. */
  goto: z.string(),
  /** The button asks for text first (`transitionNeedsText`); it goes in the request's `text`. */
  needs_text: z.boolean(),
});
export type HumanTransitionOption = z.infer<typeof HumanTransitionOptionSchema>;

/** The human-actor transitions out of `state` for a ticket of `kind`, as card buttons. */
export function humanTransitionOptions(
  def: Def,
  state: string,
  kind: TicketKind | null,
  returnTo: string | null,
): HumanTransitionOption[] {
  return transitionsOf(def, state, { actor: 'human', kind }).map((e) => ({
    name: e.name,
    title: transitionTitle(e.name, e.transition),
    goto: e.transition.goto === RETURN_TO && returnTo !== null ? returnTo : e.transition.goto,
    needs_text: transitionNeedsText(def, e.transition),
  }));
}
