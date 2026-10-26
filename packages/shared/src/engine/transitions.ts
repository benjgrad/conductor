import {
  RETURN_TO,
  type TicketKind,
  type TransitionActor,
  type TransitionObject,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import {
  agentTransitionOptions,
  FALLBACK_TRANSITION_NAMES,
  transitionActor,
  transitionMatchesKind,
  transitionObject,
  transitionTitle,
  type AgentTransitionOption,
} from '../workflow/transition-rules.js';
import {
  unknownTransitionQuestion,
  type ApplyIgnoreReason,
  type SessionSnapshot,
} from './types.js';

// ADR-0011 (M1b-T03): which transition an agent's `complete_state` or a human's move takes. Pure
// decisions over the pinned definition and the snapshot; apply.ts carries them out (enter the
// target, or start a move step for `requires`, move-step.ts). 05 §Transitions.

/** The built-in fallback outcome of every agent state (U-061). */
export const ASK_USER = 'ask_user';
/** The name an agent's `complete_state` takes when it names none (old prompts). */
export const DEFAULT_AGENT_TRANSITION = 'done';

/** Who took a transition and why: the ADR-0011 fields of a `state_entered` record. */
export interface MoveRecord {
  transition: string;
  reason: string | null;
  actor: TransitionActor;
}

/** What an agent's `complete_state {transition, reason}` does. */
export type AgentTransitionPlan =
  /** No name, and the state declares no `done`: the M1 `done` outcome, unchanged. */
  | { type: 'legacy' }
  /**
   * Route to a human through the state's `ask_user` (the U-028 path): the agent named `ask_user`
   * (`named`), or a name it may not take (unknown, not agent-actor, or not for this ticket's kind).
   */
  | { type: 'ask_user'; question: string; named: boolean }
  /** Take transition `name`. `question`: its `reason` is the human's question. */
  | { type: 'take'; name: string; transition: TransitionObject; question: boolean };

/** The state an unmapped failure goes to: `needs_input` if it is human, else the first human state. */
export function fallbackHumanState(def: Pick<WorkflowDefinition, 'states'>): string | null {
  if (def.states.needs_input?.type === 'human') return 'needs_input';
  for (const [name, state] of Object.entries(def.states)) if (state.type === 'human') return name;
  return null;
}

/** The ticket's kind; absent (pre-M1b snapshots) ≡ null, which matches every transition (U-062). */
export function ticketKind(s: Pick<SessionSnapshot, 'ticket'>): TicketKind | null {
  return s.ticket.kind ?? null;
}

/**
 * ADR-0011 §Who takes a transition (agent). A null name means `done`. The name must be a
 * transition of the state, agent-actor, and match the ticket's kind; otherwise the agent is
 * routed to a human with `unknownTransitionQuestion` (ignoring it would change nothing: the
 * daemon has already refused it once, M1b-T05).
 */
export function planAgentTransition(
  def: Pick<WorkflowDefinition, 'states'>,
  stateName: string,
  kind: TicketKind | null,
  name: string | null | undefined,
  reason: string | null | undefined,
): AgentTransitionPlan {
  const state = def.states[stateName];
  const on = state !== undefined && state.type !== 'terminal' ? state.on : undefined;
  const named = name ?? null;
  const n = named ?? DEFAULT_AGENT_TRANSITION;
  const raw = on?.[n];
  if (named === null && raw === undefined) return { type: 'legacy' };
  const why = reason ?? null;
  if (n === ASK_USER) {
    return {
      type: 'ask_user',
      question: why ?? 'The agent asked for help without saying what it needs.',
      named: true,
    };
  }
  if (
    raw === undefined ||
    transitionActor(def, stateName, n, raw) !== 'agent' ||
    !transitionMatchesKind(raw, kind)
  ) {
    const q = unknownTransitionQuestion(n);
    return {
      type: 'ask_user',
      question: why !== null && why.trim() !== '' ? `${q}\n\nIts reason: ${why}` : q,
      named: false,
    };
  }
  const t = transitionObject(raw);
  return { type: 'take', name: n, transition: t, question: t.question === true };
}

/** The question a `question: true` transition asks: the agent's reason, else a stand-in. */
export function transitionQuestion(
  name: string,
  t: TransitionObject,
  reason: string | null,
): string {
  if (reason !== null && reason.trim() !== '') return reason;
  return `The agent chose "${transitionTitle(name, t)}" without saying why.`;
}

/** What a human's `human.transition {name}` does. */
export type HumanTransitionPlan =
  | { ok: false; reason: ApplyIgnoreReason }
  | {
      ok: true;
      name: string;
      transition: TransitionObject;
      /** The target, `RETURN_TO` resolved to `return_to` (else `def.start`). */
      goto: string;
      /** The target is the agent state that asked (`return_to`): the text is its answer. */
      continuation: boolean;
    };

/**
 * ADR-0011 §Who takes a transition (human). Accepted from a human state while `needs_input`, or
 * from an event state while `waiting_external` (for its `actor: human` transitions); otherwise
 * `wrong_status`. The name must be a human-actor transition of the state for the ticket's kind
 * (`unknown_transition` / `transition_not_allowed`, 409).
 */
export function planHumanTransition(
  def: Pick<WorkflowDefinition, 'states' | 'start'>,
  s: SessionSnapshot,
  name: string,
): HumanTransitionPlan {
  const from = s.workflow_state;
  const state = from === null ? undefined : def.states[from];
  if (from === null || state === undefined || s.step !== null) {
    return { ok: false, reason: 'wrong_status' };
  }
  const parked =
    (state.type === 'human' && s.status === 'needs_input') ||
    (state.type === 'event' && s.status === 'waiting_external');
  if (!parked) return { ok: false, reason: 'wrong_status' };
  const raw = state.on?.[name];
  if (raw === undefined) return { ok: false, reason: 'unknown_transition' };
  if (
    transitionActor(def, from, name, raw) !== 'human' ||
    !transitionMatchesKind(raw, ticketKind(s))
  ) {
    return { ok: false, reason: 'transition_not_allowed' };
  }
  const t = transitionObject(raw);
  const goto = t.goto === RETURN_TO ? (s.return_to ?? def.start) : t.goto;
  if (def.states[goto] === undefined) return { ok: false, reason: 'unexpected_event' };
  return {
    ok: true,
    name,
    transition: t,
    goto,
    continuation: s.return_to !== null && goto === s.return_to,
  };
}

/**
 * Whether taking `name` runs its `requires` as a move step: it has `requires`, and it isn't one
 * of the built-in routes to a human (FALLBACK_TRANSITION_NAMES never run requirements).
 */
export function runsRequirements(name: string, t: TransitionObject): boolean {
  return t.requires !== undefined && !FALLBACK_TRANSITION_NAMES.includes(name);
}

/**
 * The transitions an agent's prompt lists under "How to finish" and `start_session.transitions`
 * carries (one list, `agentTransitionOptions`). null for a state that only has the M1 outcomes
 * (`done` / `ask_user`): its prompt keeps the M1 "When you are done" section and the daemon
 * accepts any name (old versions run unchanged).
 */
export function promptTransitions(
  def: Pick<WorkflowDefinition, 'states'>,
  stateName: string,
  kind: TicketKind | null,
): AgentTransitionOption[] | null {
  const options = agentTransitionOptions(def, stateName, kind);
  const state = def.states[stateName];
  const declared =
    state !== undefined && state.type !== 'terminal' ? Object.keys(state.on ?? {}) : [];
  const legacy = declared.every(
    (n) => n === DEFAULT_AGENT_TRANSITION || n === ASK_USER || !isAgentName(def, stateName, n),
  );
  return legacy ? null : options;
}

function isAgentName(
  def: Pick<WorkflowDefinition, 'states'>,
  state: string,
  name: string,
): boolean {
  const s = def.states[state];
  const t = s !== undefined && s.type !== 'terminal' ? s.on?.[name] : undefined;
  return t !== undefined && transitionActor(def, state, name, t) === 'agent';
}
