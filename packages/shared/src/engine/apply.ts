import {
  isGithubPrUrl,
  type InputRequestKind,
  type JsonObject,
  type SessionStatus,
  type TicketStatus,
} from '../domain.js';
import { evaluateGuard } from '../workflow/guards.js';
import { stateTitle } from '../workflow/conductor.js';
import {
  parseDuration,
  type AgentState,
  type EntryAction,
  type EntryCheck,
  type OnUnmet,
  type RequirementsGate,
  type WorkflowDefinition,
  type WorkflowState,
} from '../workflow/schema.js';
import { renderPrompt, type PromptAttachment } from './render.js';
import {
  DEFAULT_CHECK_TIMEOUT,
  ENTRY_ACTION_TIMEOUT,
  PR_CONTEXT_KEY,
  entryCounterKey,
  entryStateLabel,
  feedbackHeading,
  parseVerdict,
  renderReviewFeedback,
  renderReviewPrompt,
  REVIEW_TIMEOUT,
  REVIEW_TOOLS,
  reviewCounterKey,
  reviewNudge,
  reviewStateLabel,
  reviewSubject,
  type ReviewFeedback,
} from './review.js';
import { applySpend } from './spend.js';
import type {
  ApplyFn,
  ApplyIgnoreReason,
  ApplyResult,
  Effect,
  EngineEvent,
  GateStep,
  PendingAnswer,
  SessionSnapshot,
} from './types.js';

export {
  IMPLEMENT_TEMPLATE,
  PLAN_TEMPLATE,
  PROMPT_TEMPLATES,
  renderPrompt,
  TICKET_TEMPLATE,
} from './render.js';
export type { PromptAttachment, RenderPromptInput } from './render.js';

// The pure FSM step (05 §Execution, 10-contracts §Engine). Every rule below cites the contract
// it implements; the doc comments on EngineEvent / SessionSnapshot in types.ts are the spec.
//
// Shape: `apply` copies the snapshot into a Step, runs the event's handler, and either returns
// the Step's snapshot + effects or (handler returned an ignore reason) the input snapshot
// unchanged with no effects. apply never assigns ids and never reads a clock.

/** Statuses after which every event is ignored (`session_terminal`). */
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set(['done', 'failed', 'lost']);
/** Statuses in which the agent of the current agent state may report. */
const AGENT_ACTIVE: ReadonlySet<SessionStatus> = new Set(['assigned', 'running']);

class Step {
  readonly s: SessionSnapshot;
  readonly effects: Effect[] = [];

  constructor(
    readonly def: WorkflowDefinition,
    base: SessionSnapshot,
    readonly now: Date,
  ) {
    this.s = structuredClone(base);
  }

  get stateName(): string | null {
    return this.s.workflow_state;
  }

  get state(): WorkflowState | undefined {
    const name = this.s.workflow_state;
    return name === null ? undefined : this.def.states[name];
  }

  emit(e: Effect): void {
    this.effects.push(e);
  }

  /** Status change + `session_status`; a move to `running` from the queue marks the ticket in progress. */
  setStatus(to: SessionStatus): void {
    const from = this.s.status;
    if (from === to) return;
    this.s.status = to;
    this.emit({ type: 'session_status', from, to });
    if (to === 'running' && (from === 'queued' || from === 'assigned')) this.ticket('in_progress');
  }

  ticket(to: TicketStatus): void {
    this.emit({ type: 'ticket_status', to });
  }

  setDeadline(state: string, deadline: string | null): void {
    this.s.state_deadline = deadline;
    this.emit({ type: 'set_deadline', state, deadline });
  }
}

export const apply: ApplyFn = (def, snapshot, event, now) => {
  if (TERMINAL_STATUSES.has(snapshot.status)) return ignore(snapshot, 'session_terminal');
  const step = new Step(def, snapshot, now);
  const reason = handle(step, event);
  if (reason !== null) return ignore(snapshot, reason);
  return { snapshot: step.s, effects: step.effects, ignored: null };
};

function ignore(snapshot: SessionSnapshot, reason: ApplyIgnoreReason): ApplyResult {
  return { snapshot, effects: [], ignored: reason };
}

// ---------------------------------------------------------------- event handlers

function handle(st: Step, e: EngineEvent): ApplyIgnoreReason | null {
  if (st.s.step !== null) return handleStep(st, e);
  switch (e.type) {
    case 'session.assigned':
      return onAssigned(st, e.machine_id);
    case 'command.refused':
      return onRefused(st, e);
    case 'session.started':
      return onStarted(st, e.command_id);
    case 'agent.claude_session_id':
      st.s.claude_session_id = e.claude_session_id;
      return null;
    case 'agent.complete_state':
      return onComplete(st, e.result);
    case 'agent.ask_user':
      return onAskUser(st, e.question);
    case 'agent.no_outcome':
      return onAskUser(st, withOutput(NO_OUTCOME_QUESTION, e.last_output));
    case 'agent.exited':
      return onAgentExited(st, e);
    case 'command.exited':
      return onCommandExited(st, e);
    case 'spend.reported':
      onSpend(st, e.claude_session_id, e.total_usd);
      return null;
    case 'input.provided':
      return onInput(st, e);
    case 'external.event':
      return onExternal(st, e.name, e.data);
    case 'timer.fired':
      return onTimer(st, e.state, e.deadline);
    case 'budget.exceeded':
      return onBudget(st, e);
    case 'operator.cancel':
      failSession(st, 'cancelled', e.reason ?? 'operator_cancel');
      return null;
    case 'operator.message':
      return onMessage(st, e.text);
    case 'action.completed':
      // Only an entry step's actions phase waits for one (handleStep).
      return 'unexpected_event';
  }
}

/** ADR-0005: cumulative per Claude session; a reviewer's own id counts the same way (ADR-0009). */
function onSpend(st: Step, claudeSessionId: string, totalUsd: number): void {
  const next = applySpend(st.s, claudeSessionId, totalUsd);
  st.s.spend_usd = next.spend_usd;
  st.s.claude_spend_totals = next.claude_spend_totals;
}

/**
 * ADR-0007: a human's message to the running agent. Only while `running` an agent state whose
 * process is live (a parked `needs_input` session is answered through input.provided instead).
 * One `send_message` effect; nothing else changes: no transition, no status, no deadline.
 */
function onMessage(st: Step, text: string): ApplyIgnoreReason | null {
  if (st.s.status !== 'running' || st.state?.type !== 'agent' || !st.s.agent_process_live) {
    return 'wrong_status';
  }
  st.emit({ type: 'send_message', text });
  return null;
}

/**
 * Claim (T11). Only from `queued`. First claim enters `def.start`; a re-claim (after a refused or
 * timed-out start_session) re-emits the current state's command. U-024: a command state goes
 * straight to `running` (run_cmd has no `started`).
 */
function onAssigned(st: Step, machineId: string): ApplyIgnoreReason | null {
  if (st.s.status !== 'queued') return 'wrong_status';
  st.s.machine_id = machineId;
  const name = st.stateName;
  const state = st.state;
  if (name === null || state === undefined) {
    // ADR-0008: a reopened session is created with the human's message as its pending answer;
    // its first start delivers it (resuming the old Claude conversation when there is one).
    enter(st, st.def.start, { ...NO_ROUTE, assigning: true, answer: st.s.pending_answer });
    return null;
  }
  switch (state.type) {
    case 'agent': {
      // 10-contracts §Pending answer: a requeued resume re-answers with the pending answer.
      // TD: a requeued retry visit re-renders its prompt without the `attach: output` text
      // (the snapshot doesn't keep the attachment); the resumed Claude session still has it
      // only if the earlier start ran.
      const answer = st.s.pending_answer;
      st.emit(startSession(st, name, state, { attachment: null, answer: answer?.answer ?? null }));
      st.setStatus('assigned');
      st.setDeadline(name, deadlineFor(state, st.now));
      return null;
    }
    case 'command':
      st.emit(runCmd(name, state));
      st.setStatus('running');
      return null;
    case 'connector':
      st.emit(connectorCall(st, name, state));
      st.setStatus('running');
      st.setDeadline(name, deadlineFor(state, st.now));
      return null;
    case 'event':
      st.setStatus('waiting_external');
      return null;
    case 'human':
      st.setStatus('needs_input');
      return null;
    case 'terminal':
      st.setStatus('done');
      return null;
  }
}

/** 10-contracts §Refusals (incl. U-025). */
function onRefused(
  st: Step,
  e: Extract<EngineEvent, { type: 'command.refused' }>,
): ApplyIgnoreReason | null {
  const state = st.state;
  const name = st.stateName;
  switch (e.command_kind) {
    case 'kill':
      return 'kill_refused';
    case 'send_message':
      // ADR-0007: best effort. The process is gone (its `exit` follows) or parked; either way a
      // refused message does not re-route the workflow.
      return 'message_refused';
    case 'start_session': {
      // U-025: only the current start, and only before its `started` arrived.
      if (e.command_id !== st.s.agent_command_id || st.s.agent_process_live) {
        return 'command_id_mismatch';
      }
      st.s.agent_command_id = null;
      st.s.agent_process_live = false;
      // The session already left the agent state that start was for (e.g. its timer fired into
      // needs_input before `started`): nothing needs the process now, so don't requeue a parked
      // session. A later answer finds agent_process_live false and resumes via start_session.
      if (state?.type !== 'agent') return null;
      st.s.machine_id = null;
      // pending_answer is kept so the re-claim re-answers (U-026).
      requeue(st);
      return null;
    }
    case 'send_input': {
      if (state?.type !== 'agent' || name === null || !AGENT_ACTIVE.has(st.s.status)) {
        return 'unexpected_event';
      }
      if (e.reason === 'no_live_process') {
        st.s.agent_process_live = false;
        const answer = st.s.pending_answer;
        if (answer !== null) {
          st.emit(startSession(st, name, state, { attachment: null, answer: answer.answer }));
        }
        return null;
      }
      takeOutcome(st, 'fail', { detail: `send_input refused: ${e.reason}` });
      return null;
    }
    case 'run_cmd': {
      if (state?.type !== 'command' || st.s.status !== 'running') return 'unexpected_event';
      takeOutcome(st, 'fail', {
        detail: `run_cmd refused: ${e.reason}`,
        output: `The daemon refused to run the command (${e.reason}).`,
      });
      return null;
    }
    case 'connector_call': {
      if (state?.type !== 'connector') return 'unexpected_event';
      takeOutcome(st, 'error', { detail: `connector_call refused: ${e.reason}` });
      return null;
    }
    case 'run_action':
      // Only an entry step runs actions (handleStep).
      return 'unexpected_event';
  }
}

/** 10-contracts §Agent process correlation. */
function onStarted(st: Step, commandId: string): ApplyIgnoreReason | null {
  if (st.s.agent_command_id === null || commandId !== st.s.agent_command_id) {
    return 'command_id_mismatch';
  }
  st.s.agent_process_live = true;
  st.s.pending_answer = null; // the agent is running on it (§Pending answer)
  if (st.s.status === 'assigned') st.setStatus('running');
  return null;
}

/** 05 §Outcomes, not opinions; 10-contracts §Guards (fail closed, TD-017). */
function onComplete(st: Step, result: JsonObject): ApplyIgnoreReason | null {
  const state = st.state;
  const name = st.stateName;
  if (state?.type !== 'agent' || name === null) return 'unexpected_event';
  if (!AGENT_ACTIVE.has(st.s.status)) return 'wrong_status';
  st.s.pending_answer = null;
  const missing = (state.result ?? []).filter((k) => !(k in result));
  if (missing.length > 0) {
    takeOutcome(st, 'fail', { detail: `complete_state result is missing ${missing.join(', ')}` });
    return null;
  }
  if (state.guard !== undefined) {
    const ok = evaluateGuard(state.guard, { def: st.def, snapshot: st.s, result });
    if (!ok) {
      takeOutcome(st, 'fail', { detail: `guard ${state.guard} failed` });
      return null;
    }
  }
  st.s.context = { ...st.s.context, [name]: result };
  takeOutcome(st, 'done', { result });
  return null;
}

/** U-028: the question of the input_request an `agent.no_outcome` opens (+ the last output). */
export const NO_OUTCOME_QUESTION =
  'Agent stopped without reporting an outcome; last output attached';

function onAskUser(st: Step, question: string): ApplyIgnoreReason | null {
  if (st.state?.type !== 'agent') return 'unexpected_event';
  if (!AGENT_ACTIVE.has(st.s.status)) return 'wrong_status';
  st.s.pending_answer = null;
  takeOutcome(st, 'ask_user', { question });
  return null;
}

/**
 * A matching exit clears agent_process_live. While the agent state is active it is outcome
 * `fail`, unless an accepted answer is pending (the agent never ran on it): then resume with the
 * answer (§Pending answer). While parked it only clears the flag.
 */
function onAgentExited(
  st: Step,
  e: Extract<EngineEvent, { type: 'agent.exited' }>,
): ApplyIgnoreReason | null {
  if (st.s.agent_command_id === null || e.command_id !== st.s.agent_command_id) {
    return 'command_id_mismatch';
  }
  st.s.agent_process_live = false;
  const state = st.state;
  const name = st.stateName;
  if (state?.type !== 'agent' || name === null || !AGENT_ACTIVE.has(st.s.status)) return null;
  const answer = st.s.pending_answer;
  if (answer !== null) {
    st.emit(startSession(st, name, state, { attachment: null, answer: answer.answer }));
    return null;
  }
  const how = e.signal !== null ? `signal ${e.signal}` : `exit code ${String(e.code)}`;
  takeOutcome(st, 'fail', { detail: `the agent exited (${how}) without calling complete_state` });
  return null;
}

/** `cmd_exit`: 0 → exit_0; timed_out → timeout if mapped, else fail; anything else → fail. */
function onCommandExited(
  st: Step,
  e: Extract<EngineEvent, { type: 'command.exited' }>,
): ApplyIgnoreReason | null {
  const state = st.state;
  if (state?.type !== 'command') return 'unexpected_event';
  if (st.s.status !== 'running') return 'wrong_status';
  let outcome: string;
  let detail: string;
  if (e.timed_out) {
    outcome = state.on?.timeout !== undefined ? 'timeout' : 'fail';
    detail = state.timeout !== undefined ? `timed out after ${state.timeout}` : 'timed out';
  } else if (e.exit_code === 0) {
    outcome = 'exit_0';
    detail = 'exit code 0';
  } else {
    outcome = 'fail';
    detail = e.exit_code === null ? 'killed by a signal' : `exit code ${e.exit_code}`;
  }
  takeOutcome(st, outcome, { detail, output: e.output_tail });
  return null;
}

/**
 * 05 §needs_input, 06: the answer returns to `return_to` (or the `goto` the human chose). The
 * wrapper has already checked the request is open and `goto` exists (`invalid_goto`).
 */
function onInput(
  st: Step,
  e: Extract<EngineEvent, { type: 'input.provided' }>,
): ApplyIgnoreReason | null {
  if (st.s.status !== 'needs_input' || st.state?.type !== 'human') return 'wrong_status';
  const target = e.goto ?? st.s.return_to ?? st.def.start;
  const targetState = st.def.states[target];
  if (targetState === undefined) return 'unexpected_event';
  const answer: PendingAnswer = { input_request_id: e.input_request_id, answer: e.answer };
  const continuation = target === st.s.return_to;
  enter(st, target, {
    ...NO_ROUTE,
    kind: 'approval',
    question: `Routed here by the answer to the previous request: ${e.answer}`,
    answer,
    sendInput: continuation && st.s.agent_process_live,
    continuation,
    outcome: 'answered',
    info: { detail: `a human answered: ${e.answer}` },
  });
  return null;
}

function onExternal(
  st: Step,
  name: string,
  data: JsonObject | undefined,
): ApplyIgnoreReason | null {
  const state = st.state;
  const from = st.stateName;
  if (state?.type !== 'event' || from === null) return 'unexpected_event';
  if (!state.wait_for.includes(name)) return 'not_awaited';
  // Merged with what is already recorded for this state.
  if (data !== undefined) {
    st.s.context = {
      ...st.s.context,
      [from]: { ...(st.s.context[from] ?? {}), event: name, ...data },
    };
  }
  takeOutcome(st, name, { detail: `event ${name}` });
  return null;
}

function onTimer(st: Step, state: string, deadline: string): ApplyIgnoreReason | null {
  const current = st.s.state_deadline;
  if (
    state !== st.stateName ||
    current === null ||
    Date.parse(deadline) !== Date.parse(current) ||
    st.s.status === 'queued'
  ) {
    return 'stale_timer';
  }
  const timeout = st.state && 'timeout' in st.state ? st.state.timeout : undefined;
  takeOutcome(st, 'timeout', { detail: timeout ? `timed out after ${timeout}` : 'timed out' });
  return null;
}

/** 09 §Budgets: → `def.on_budget_exceeded`, kind `budget_exceeded`. Nothing emits it in M1 (TD-015). */
function onBudget(
  st: Step,
  e: Extract<EngineEvent, { type: 'budget.exceeded' }>,
): ApplyIgnoreReason | null {
  const name = st.stateName;
  if (name === null || st.state?.type === 'human') return 'wrong_status';
  const unit = e.dimension === 'usd' ? 'USD' : 'minutes';
  const question = `Budget exceeded in "${name}": spent ${e.spent} of ${e.limit} ${unit}. Raise the budget, skip, or abort?`;
  const target = st.def.states[st.def.on_budget_exceeded] ? st.def.on_budget_exceeded : null;
  if (target === null) {
    toFallbackHuman(st, 'budget_exceeded', question);
  } else {
    enter(st, target, { ...NO_ROUTE, kind: 'budget_exceeded', question, skipEntry: true });
  }
  return null;
}

// ---------------------------------------------------------------- outcomes and routing

interface OutcomeInfo {
  /** One line on why (`exit code 2`, `guard x failed`); goes into generated questions. */
  detail?: string;
  /** Output attached on `attach: output` and to generated questions. */
  output?: string;
  /** The agent's question (`ask_user`). */
  question?: string;
  /** The agent's `complete_state` result (`done`), for a requirements reviewer's prompt. */
  result?: JsonObject;
}

/**
 * Take `outcome` out of the current state (05 §Retry loops). A string target is followed; an
 * object takes `goto` while `retry_counters["<from>-><goto>"]` < `retries` (default
 * `budget.max_loop_retries`), else `else`. An unmapped outcome (or an exhausted loop without
 * `else`) goes to the fallback human state: every failure path ends at a human.
 */
function takeOutcome(st: Step, outcome: string, info: OutcomeInfo): void {
  const from = st.stateName ?? st.def.start;
  const state = st.state;
  const t = state && state.type !== 'terminal' ? state.on?.[outcome] : undefined;
  const kind = kindForOutcome(outcome);
  const question = questionFor(from, outcome, kind, info);

  if (t === undefined) {
    toFallbackHuman(st, kind, question);
    return;
  }
  if (typeof t === 'string') {
    enter(st, t, { ...NO_ROUTE, kind, question, attachment: null, outcome, info });
    return;
  }
  const gate = t.requirements;
  // ADR-0009: an object that only carries `requirements` (no attach / retries / else) is a plain
  // forward transition, like a string target: no counter on its goto leg.
  if (
    gate !== undefined &&
    t.attach === undefined &&
    t.retries === undefined &&
    t.else === undefined
  ) {
    enterStep(st, { kind: 'transition', from, outcome, to: t.goto, attachment: null, info });
    return;
  }
  const key = `${from}->${t.goto}`;
  const cap = t.retries ?? st.def.budget.max_loop_retries;
  const taken = st.s.retry_counters[key] ?? 0;
  if (taken < cap) {
    st.s.retry_counters = { ...st.s.retry_counters, [key]: taken + 1 };
    const attachment: PromptAttachment | null =
      t.attach === 'output'
        ? { from, detail: info.detail ?? outcome, output: info.output ?? '' }
        : null;
    if (gate !== undefined) {
      enterStep(st, { kind: 'transition', from, outcome, to: t.goto, attachment, info });
      return;
    }
    enter(st, t.goto, { ...NO_ROUTE, kind, question, attachment, outcome, info });
    return;
  }
  const exhausted = withOutput(
    `"${from}" failed ${taken} time${taken === 1 ? '' : 's'} (${info.detail ?? outcome}; retry limit ${cap}). Retry, skip, or abort?`,
    info.output,
  );
  if (t.else !== undefined) {
    enter(st, t.else, {
      ...NO_ROUTE,
      kind: 'retries_exhausted',
      question: exhausted,
      outcome,
      info,
    });
  } else {
    toFallbackHuman(st, 'retries_exhausted', exhausted);
  }
}

function kindForOutcome(outcome: string): InputRequestKind {
  switch (outcome) {
    case 'ask_user':
      return 'agent_question';
    case 'timeout':
      return 'timeout';
    case 'fail':
    case 'error':
      // NEW UNKNOWN (reported): no kind for "failed without a retry loop" (guard, agent exit).
      return 'retries_exhausted';
    default:
      return 'approval';
  }
}

function questionFor(from: string, outcome: string, kind: InputRequestKind, info: OutcomeInfo) {
  if (kind === 'agent_question' && info.question !== undefined) return info.question;
  const why = info.detail ? ` (${info.detail})` : '';
  if (kind === 'timeout') return `"${from}" timed out${why}. Retry, skip, or abort?`;
  if (kind === 'retries_exhausted') {
    return withOutput(`"${from}" failed${why}. Retry, skip, or abort?`, info.output);
  }
  return `"${from}" finished with "${outcome}"${why}. Continue, skip, or abort?`;
}

function withOutput(text: string, output: string | undefined): string {
  return output ? `${text}\n\nLast output:\n${output}` : text;
}

/** The state an unmapped failure goes to: `needs_input` if it is human, else the first human state. */
export function fallbackHumanState(def: WorkflowDefinition): string | null {
  if (def.states.needs_input?.type === 'human') return 'needs_input';
  for (const [name, state] of Object.entries(def.states)) if (state.type === 'human') return name;
  return null;
}

function toFallbackHuman(st: Step, kind: InputRequestKind, question: string): void {
  const target = fallbackHumanState(st.def);
  if (target === null) {
    failSession(st, 'failed', `no human state to route to: ${question}`);
    return;
  }
  enter(st, target, { ...NO_ROUTE, kind, question, skipEntry: true });
}

// ---------------------------------------------------------------- gate steps (ADR-0009, ADR-0010)
//
// A gate step stands between an outcome and the state it selects. Two kinds, one representation
// (`session.step`, GateStepSchema):
// - `transition` (ADR-0009, older versions): an outcome selected a transition carrying
//   `requirements`. The step only runs a reviewer.
// - `entry` (ADR-0010): an outcome selected a state with `entry` requirements. The step runs the
//   checks (one run_cmd each, in the worktree), then the reviewer (if `review`), then conductor's
//   actions (one run_action each, e.g. open_pr), one `phase` at a time.
// While the step runs, `workflow_state` is its label (reviewStateLabel / entryStateLabel), status
// `running`, and the card stays in the source column with a `checking` badge. Its outcomes are the
// only things that move the ticket: a check's exit code, the reviewer's verdict, an action's
// result. Everything passes → enter `to`. A failed check or unmet item → `on_unmet.goto` with the
// evidence (counter `entry:<to>` / `requirements:<from>:<outcome>`, capped at `on_unmet.retries`),
// then `on_unmet.else` (a human state). A failed action, a timeout, no verdict → `else` directly.
// Every other event is ignored while the step runs.

/** What a gate step checks, from the pinned definition. */
interface GateSpec {
  /** The target's column title (ADR-0010) or name (ADR-0009). */
  title: string;
  checks: readonly EntryCheck[];
  review: { items: readonly string[]; model?: string | undefined } | null;
  actions: readonly EntryAction[];
  on_unmet: OnUnmet;
}

function gateOf(def: WorkflowDefinition, from: string, outcome: string): RequirementsGate | null {
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return null;
  const t = state.on?.[outcome];
  return typeof t === 'object' ? (t.requirements ?? null) : null;
}

function gateSpecOf(def: WorkflowDefinition, r: GateStep): GateSpec | null {
  if (r.kind === 'transition') {
    const gate = gateOf(def, r.from, r.outcome);
    if (gate === null) return null;
    return {
      title: r.to,
      checks: [],
      review: { items: gate.items, model: gate.model },
      actions: [],
      on_unmet: gate.on_unmet,
    };
  }
  const entry = def.states[r.to]?.entry;
  if (entry === undefined) return null;
  return {
    title: stateTitle(def, r.to),
    checks: entry.checks ?? [],
    review: entry.review ?? null,
    actions: entry.actions ?? [],
    on_unmet: entry.on_unmet,
  };
}

function noGate(r: GateStep): string {
  return r.kind === 'transition'
    ? `no requirements gate on "${r.from}" outcome "${r.outcome}"`
    : `no entry requirements on "${r.to}"`;
}

/** Start a gate step instead of entering `to` (the source state is still `workflow_state`). */
function enterStep(
  st: Step,
  p: {
    kind: GateStep['kind'];
    from: string;
    outcome: string;
    to: string;
    attachment: PromptAttachment | null;
    info: OutcomeInfo;
  },
): void {
  const s = st.s;
  const label = p.kind === 'entry' ? entryStateLabel(p.from, p.to) : reviewStateLabel(p.from, p.to);
  addWallTime(st);
  const visit = (s.state_visits[label] ?? 0) + 1;
  s.state_visits = { ...s.state_visits, [label]: visit };
  s.workflow_state = label;
  s.return_to = null;
  s.pending_answer = null;
  // The worker is done with this visit: kill exactly its process (it would end itself after
  // complete_state, but it must not keep writing the worktree while the step checks it), and detach
  // it, so its late exit is a command_id_mismatch and never reads as the step's outcome. The
  // wrapper also bumps the fencing token (10-contracts §EngineService wrapper).
  if (s.machine_id !== null && s.agent_command_id !== null) {
    st.emit({
      type: 'kill',
      reason: 'gate step started: the worker is done',
      target_command_id: s.agent_command_id,
    });
  }
  s.agent_command_id = null;
  s.agent_process_live = false;
  s.step = {
    kind: p.kind,
    from: p.from,
    outcome: p.outcome,
    to: p.to,
    attachment: p.attachment,
    subject: reviewSubject({
      detail: p.info.detail ?? p.outcome,
      result: p.info.result,
      output: p.info.output,
    }),
    claude_session_id: null,
    nudged: false,
    phase: p.kind === 'entry' ? 'checks' : 'review',
    index: 0,
    head_sha: null,
  };
  st.emit({ type: 'state_entered', from: p.from, to: label, visit });
  if (s.machine_id === null) {
    st.setDeadline(label, null);
    requeue(st);
    return;
  }
  runPhase(st, false);
}

function deadlineIn(now: Date, duration: string): string {
  return new Date(now.getTime() + parseDuration(duration)).toISOString();
}

/**
 * Run the step's current phase from `index`: emit the next check's run_cmd, the reviewer's
 * start_session or the next action's run_action; a phase with nothing (left) to do moves on to the
 * next. All done → enter `to`. `assigning`: a re-claim (`session.assigned`) after a requeue.
 */
function runPhase(st: Step, assigning: boolean): void {
  const s = st.s;
  const r = s.step!;
  const spec = gateSpecOf(st.def, r);
  if (spec === null) {
    failSession(st, 'failed', noGate(r));
    return;
  }
  const label = s.workflow_state!;
  for (;;) {
    if (r.phase === 'checks') {
      const check = spec.checks[r.index];
      if (check !== undefined) {
        st.emit({
          type: 'run_cmd',
          state: label,
          cmd: check.cmd,
          cwd: null,
          timeout_ms: parseDuration(check.timeout ?? DEFAULT_CHECK_TIMEOUT),
        });
        // The daemon enforces the check's timeout (`cmd_exit timed_out`), as for command states.
        st.setDeadline(label, null);
        st.setStatus('running');
        return;
      }
      r.phase = 'review';
      r.index = 0;
      continue;
    }
    if (r.phase === 'review') {
      if (spec.review !== null) {
        r.claude_session_id = null;
        r.nudged = false;
        emitReviewer(st, spec, null);
        if (assigning) {
          st.setStatus('assigned');
          st.setDeadline(label, deadlineIn(st.now, REVIEW_TIMEOUT));
        } else {
          st.setDeadline(label, deadlineIn(st.now, REVIEW_TIMEOUT));
          st.setStatus('running');
        }
        return;
      }
      r.phase = 'actions';
      r.index = 0;
      continue;
    }
    const action = spec.actions[r.index];
    if (action !== undefined) {
      if (spec.checks.length > 0 && r.head_sha === null) {
        // The pushed commit must be the checked one; without it, nothing is pushed.
        stepFail(
          st,
          spec,
          'retries_exhausted',
          `Conductor could not tell which commit the checks for "${spec.title}" ran on, so it did not ${actionLabel(action)}. Retry, skip, or abort?`,
          false,
        );
        return;
      }
      st.emit(runAction(st, r, action));
      st.setDeadline(label, deadlineIn(st.now, ENTRY_ACTION_TIMEOUT));
      st.setStatus('running');
      return;
    }
    passStep(st);
    return;
  }
}

/** Every requirement met: enter `to` (an ADR-0009 review's target may still have its own entry). */
function passStep(st: Step): void {
  const r = st.s.step!;
  const label = st.s.workflow_state!;
  leaveStep(st, false);
  const kind = kindForOutcome(r.outcome);
  enter(st, r.to, {
    ...NO_ROUTE,
    kind,
    question: questionFor(r.from, r.outcome, kind, {}),
    attachment: r.attachment,
    auditFrom: label,
    skipEntry: r.kind === 'entry',
    outcome: r.outcome,
  });
}

/**
 * The reviewer's start_session. `nudge` null → a fresh reviewer with the full prompt. Otherwise
 * resume the reviewer's OWN conversation with the nudge (or, before its id is known, a fresh one
 * with the full prompt plus the nudge). Never the worker's `claude_session_id`.
 */
function emitReviewer(st: Step, spec: GateSpec, nudge: string | null): void {
  const r = st.s.step!;
  const review = spec.review!;
  const resume = nudge !== null ? r.claude_session_id : null;
  const full = () =>
    renderReviewPrompt({
      from: r.from,
      outcome: r.outcome,
      to: r.to,
      items: review.items,
      ticket: st.s.ticket,
      subject: r.subject,
      ...(r.kind === 'entry' ? { entering: spec.title, commit: r.head_sha } : {}),
    });
  const prompt = nudge === null ? full() : resume !== null ? nudge : `${full()}\n\n${nudge}`;
  st.emit({
    type: 'start_session',
    state: st.s.workflow_state ?? reviewStateLabel(r.from, r.to),
    prompt,
    tools: [...REVIEW_TOOLS],
    resume_claude_session_id: resume,
    ...(review.model !== undefined ? { model: review.model } : {}),
    max_budget_usd: Math.max(0, st.def.budget.usd - st.s.spend_usd),
    review: true,
  });
}

function handleStep(st: Step, e: EngineEvent): ApplyIgnoreReason | null {
  const s = st.s;
  const r = s.step!;
  const spec = gateSpecOf(st.def, r);
  if (spec === null) {
    failSession(st, 'failed', noGate(r));
    return null;
  }
  switch (e.type) {
    case 'session.assigned':
      // Re-claim after a requeue: run the current phase again (a fresh reviewer, the same check).
      if (s.status !== 'queued') return 'wrong_status';
      s.machine_id = e.machine_id;
      runPhase(st, true);
      return null;
    case 'command.refused':
      switch (e.command_kind) {
        case 'kill':
          return 'kill_refused';
        case 'send_message':
          return 'message_refused';
        case 'start_session':
          if (e.command_id !== s.agent_command_id || s.agent_process_live) {
            return 'command_id_mismatch';
          }
          s.agent_command_id = null;
          s.agent_process_live = false;
          s.machine_id = null;
          requeue(st);
          return null;
        case 'run_cmd': {
          const check = r.phase === 'checks' ? spec.checks[r.index] : undefined;
          if (check === undefined || s.status !== 'running') return 'unexpected_event';
          // The machine could not run it: not the agent's fault, so a human decides.
          stepFail(
            st,
            spec,
            'retries_exhausted',
            `Could not run the check "${check.name}" (\`${check.cmd}\`) to enter "${spec.title}": the daemon refused it (${e.reason}). Retry, skip, or abort?`,
            false,
          );
          return null;
        }
        case 'run_action': {
          const action = r.phase === 'actions' ? spec.actions[r.index] : undefined;
          if (action === undefined || s.status !== 'running') return 'unexpected_event';
          stepFail(
            st,
            spec,
            'retries_exhausted',
            `Conductor could not ${actionLabel(action)} to enter "${spec.title}": the daemon refused it (${e.reason}). Retry, skip, or abort?`,
            false,
          );
          return null;
        }
        default:
          return 'unexpected_event';
      }
    case 'session.started':
      return onStarted(st, e.command_id);
    case 'agent.claude_session_id':
      // The reviewer's conversation, kept apart from the worker's (never resumed into it).
      if (r.phase !== 'review') return 'unexpected_event';
      r.claude_session_id = e.claude_session_id;
      return null;
    case 'spend.reported':
      onSpend(st, e.claude_session_id, e.total_usd);
      return null;
    case 'agent.complete_state':
      if (r.phase !== 'review') return 'unexpected_event';
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      onVerdict(st, spec, r, e.result);
      return null;
    case 'agent.ask_user':
      if (r.phase !== 'review') return 'unexpected_event';
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      reviewNoVerdict(
        st,
        spec,
        r,
        'the reviewer called ask_user instead of reporting a verdict',
        true,
      );
      return null;
    case 'agent.no_outcome':
      // The daemon has already nudged this reviewer once (U-028).
      if (r.phase !== 'review') return 'unexpected_event';
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      reviewNoVerdict(st, spec, r, 'the reviewer stopped without reporting a verdict', false);
      return null;
    case 'agent.exited': {
      if (s.agent_command_id === null || e.command_id !== s.agent_command_id) {
        return 'command_id_mismatch';
      }
      s.agent_process_live = false;
      if (r.phase !== 'review' || !AGENT_ACTIVE.has(s.status)) return null;
      const how = e.signal !== null ? `signal ${e.signal}` : `exit code ${String(e.code)}`;
      reviewNoVerdict(st, spec, r, `the reviewer exited (${how}) without a verdict`, true);
      return null;
    }
    case 'command.exited': {
      const check = r.phase === 'checks' ? spec.checks[r.index] : undefined;
      if (check === undefined) return 'unexpected_event';
      if (s.status !== 'running') return 'wrong_status';
      onCheckExited(st, spec, r, check, e);
      return null;
    }
    case 'action.completed': {
      const action = r.phase === 'actions' ? spec.actions[r.index] : undefined;
      if (action === undefined || action !== e.action) return 'unexpected_event';
      if (s.status !== 'running') return 'wrong_status';
      onActionCompleted(st, spec, r, action, e);
      return null;
    }
    case 'timer.fired': {
      const current = s.state_deadline;
      if (
        e.state !== s.workflow_state ||
        current === null ||
        Date.parse(e.deadline) !== Date.parse(current) ||
        s.status === 'queued'
      ) {
        return 'stale_timer';
      }
      if (r.phase === 'review') {
        const question =
          r.kind === 'transition'
            ? `The requirements review for "${r.from}" → "${r.to}" timed out (review timed out after ${REVIEW_TIMEOUT}). Retry, skip, or abort?`
            : `The requirements review to enter "${spec.title}" timed out (review timed out after ${REVIEW_TIMEOUT}). Retry, skip, or abort?`;
        stepFail(st, spec, 'timeout', question, true);
      } else {
        const action = spec.actions[r.index];
        const what = action !== undefined ? actionLabel(action) : 'finish the entry step';
        stepFail(
          st,
          spec,
          'timeout',
          `Conductor did not ${what} to enter "${spec.title}" in time (timed out after ${ENTRY_ACTION_TIMEOUT}). Retry, skip, or abort?`,
          true,
        );
      }
      return null;
    }
    case 'budget.exceeded': {
      const target = st.def.states[st.def.on_budget_exceeded];
      leaveStep(st, target?.type !== 'agent' && target?.type !== 'command');
      return onBudget(st, e);
    }
    case 'operator.cancel':
      failSession(st, 'cancelled', e.reason ?? 'operator_cancel');
      return null;
    case 'operator.message':
      // The step judges independently: a human's live message is refused (ADR-0009, ADR-0010).
      return 'wrong_status';
    case 'input.provided':
      return 'wrong_status';
    case 'external.event':
      return 'unexpected_event';
  }
}

/** A check's exit: 0 → the next check (or phase); anything else is unmet with its output tail. */
function onCheckExited(
  st: Step,
  spec: GateSpec,
  r: GateStep,
  check: EntryCheck,
  e: Extract<EngineEvent, { type: 'command.exited' }>,
): void {
  // The first check records the commit the checks run on; later checks must see the same one.
  const head = e.head_sha ?? null;
  if (r.index === 0) {
    r.head_sha = head;
  } else if (head !== null && r.head_sha !== null && head !== r.head_sha) {
    stepUnmet(st, spec, r, [
      {
        item: check.name,
        reason: `the branch moved while the checks ran (from ${r.head_sha} to ${head}); nothing may change it after you finish`,
      },
    ]);
    return;
  }
  if (e.exit_code === 0 && !e.timed_out) {
    r.index += 1;
    runPhase(st, false);
    return;
  }
  const detail = e.timed_out
    ? `timed out after ${check.timeout ?? DEFAULT_CHECK_TIMEOUT}`
    : e.exit_code === null
      ? 'killed by a signal'
      : `exit code ${e.exit_code}`;
  stepUnmet(st, spec, r, [
    { item: check.name, reason: `\`${check.cmd}\` failed (${detail})`, output: e.output_tail },
  ]);
}

/**
 * An action's result: success → recorded and the next action; failure → else. open_pr's URL is
 * recorded only under `context.__pr` (PR_CONTEXT_KEY), and only a GitHub PR URL; anything else is
 * a failed action.
 */
function onActionCompleted(
  st: Step,
  spec: GateSpec,
  r: GateStep,
  action: EntryAction,
  e: Extract<EngineEvent, { type: 'action.completed' }>,
): void {
  if (e.error !== null || e.result === null) {
    stepFail(
      st,
      spec,
      'retries_exhausted',
      `Conductor could not ${actionLabel(action)} to enter "${spec.title}": ${e.error ?? 'no result'}. Retry, skip, or abort?`,
      false,
    );
    return;
  }
  const s = st.s;
  switch (action) {
    case 'open_pr': {
      const url = e.result.pr_url;
      if (!isGithubPrUrl(url)) {
        stepFail(
          st,
          spec,
          'retries_exhausted',
          `Conductor could not ${actionLabel(action)} to enter "${spec.title}": it reported no valid pull request URL. Retry, skip, or abort?`,
          false,
        );
        return;
      }
      s.context = { ...s.context, [PR_CONTEXT_KEY]: { pr_url: url, state: r.to } };
      break;
    }
  }
  r.index += 1;
  runPhase(st, false);
}

function onVerdict(st: Step, spec: GateSpec, r: GateStep, result: JsonObject): void {
  const items = spec.review!.items;
  const verdict = parseVerdict(result, items);
  if (!verdict.ok) {
    reviewNoVerdict(st, spec, r, `malformed verdict: ${verdict.error}`, true);
    return;
  }
  const label = st.s.workflow_state!;
  // The verdict is kept for the Details panel, keyed by the step's label.
  st.s.context = {
    ...st.s.context,
    [label]: { verdict: verdict.items.map((v) => ({ ...v })) },
  };
  const unmet = verdict.items
    .filter((v) => !v.met)
    .map((v) => ({ item: v.item, reason: v.reason }));
  if (unmet.length > 0) {
    stepUnmet(st, spec, r, unmet);
    return;
  }
  // All met: the reviewer is done (it ends itself); detach it and go on to the actions.
  st.s.agent_command_id = null;
  st.s.agent_process_live = false;
  r.phase = 'actions';
  r.index = 0;
  runPhase(st, false);
}

/**
 * Unmet (a failed check, unmet review items): back to `on_unmet.goto` with the evidence while the
 * counter allows, else `on_unmet.else` with a question listing what is unmet.
 */
function stepUnmet(st: Step, spec: GateSpec, r: GateStep, unmet: ReviewFeedback['unmet']): void {
  const label = st.s.workflow_state!;
  const feedback: ReviewFeedback = {
    heading: feedbackHeading({ kind: r.kind, from: r.from, to: r.to, title: spec.title }),
    unmet,
    instruction: spec.on_unmet.instruction ?? null,
  };
  const key = r.kind === 'entry' ? entryCounterKey(r.to) : reviewCounterKey(r.from, r.outcome);
  const cap = spec.on_unmet.retries;
  const taken = st.s.retry_counters[key] ?? 0;
  if (taken < cap) {
    st.s.retry_counters = { ...st.s.retry_counters, [key]: taken + 1 };
    leaveStep(st, false);
    enter(st, spec.on_unmet.goto, {
      ...NO_ROUTE,
      kind: 'retries_exhausted',
      question: `${renderReviewFeedback(feedback)}\n\nRetry, skip, or abort?`,
      feedback,
      auditFrom: label,
      skipEntry: true,
    });
    return;
  }
  const n = taken + 1;
  const head =
    r.kind === 'transition'
      ? `Requirements for "${r.from}" → "${r.to}" were not met after ${n} review${n === 1 ? '' : 's'} (retry limit ${cap}):`
      : `Requirements to enter "${spec.title}" were not met after ${n} attempt${n === 1 ? '' : 's'} (retry limit ${cap}):`;
  const lines = [head, ...unmet.map((u) => `- ${u.item}: ${u.reason || '(no reason given)'}`)];
  for (const u of unmet) if (u.output) lines.push('', `Last output of "${u.item}":`, u.output);
  lines.push('', 'Retry, skip, or abort?');
  leaveStep(st, false);
  enter(st, spec.on_unmet.else, {
    ...NO_ROUTE,
    kind: 'retries_exhausted',
    question: lines.join('\n'),
    auditFrom: label,
    skipEntry: true,
  });
}

function reviewNoVerdict(
  st: Step,
  spec: GateSpec,
  r: GateStep,
  why: string,
  canNudge: boolean,
): void {
  if (canNudge && !r.nudged) {
    r.nudged = true;
    emitReviewer(st, spec, reviewNudge(why, spec.review!.items));
    return;
  }
  const question =
    r.kind === 'transition'
      ? `The requirements review for "${r.from}" → "${r.to}" produced no verdict (${why}). Retry, skip, or abort?`
      : `The requirements review to enter "${spec.title}" produced no verdict (${why}). Retry, skip, or abort?`;
  stepFail(st, spec, 'retries_exhausted', question, true);
}

/** A step that can't finish (timeout, no verdict, a failed or refused action) → `on_unmet.else`. */
function stepFail(
  st: Step,
  spec: GateSpec,
  kind: InputRequestKind,
  question: string,
  kill: boolean,
): void {
  const label = st.s.workflow_state!;
  leaveStep(st, kill);
  enter(st, spec.on_unmet.else, { ...NO_ROUTE, kind, question, auditFrom: label, skipEntry: true });
}

/**
 * End the gate step: back in its source state (so `enter` counts the step's wall time and a human
 * target's `return_to` is the source), the reviewer process detached (its late exit is a
 * `command_id_mismatch`), optionally killed (a timed-out reviewer, check or action).
 */
function leaveStep(st: Step, kill: boolean): void {
  const s = st.s;
  const r = s.step!;
  if (kill && s.machine_id !== null && (s.agent_command_id !== null || r.phase !== 'review')) {
    st.emit({
      type: 'kill',
      reason: r.kind === 'transition' ? 'requirements review ended' : 'entry step ended',
    });
  }
  s.workflow_state = r.from;
  s.step = null;
  s.agent_command_id = null;
  s.agent_process_live = false;
}

function actionLabel(action: EntryAction): string {
  switch (action) {
    case 'open_pr':
      return 'open the pull request (open_pr)';
  }
}

/** The run_action effect (05 §Idempotency: `<session_id>:<state>:<visit>`, the step's visit). */
function runAction(
  st: Step,
  r: GateStep,
  action: EntryAction,
): Extract<Effect, { type: 'run_action' }> {
  const s = st.s;
  const label = s.workflow_state!;
  const visit = s.state_visits[label] ?? 1;
  return {
    type: 'run_action',
    state: label,
    target_state: r.to,
    action,
    idempotency_key: `${s.id}:${r.to}:${visit}`,
    args: actionArgs(st, r, action),
    expected_sha: r.head_sha,
  };
}

/** open_pr: title = the ticket title; body = the source state's summary + the ticket ref. */
function actionArgs(st: Step, r: GateStep, action: EntryAction): JsonObject {
  switch (action) {
    case 'open_pr': {
      const t = st.s.ticket;
      const summary = summaryOf(st.s.context, r.from);
      const ref = t.external_ref ?? `conductor ticket ${t.id}`;
      return {
        title: t.title,
        body: [summary ?? '(no summary)', '', `Ticket: ${ref}`, '', 'Opened by conductor.'].join(
          '\n',
        ),
      };
    }
  }
}

/** `context.<from>.summary`, else the last `summary` any state reported. */
function summaryOf(context: SessionSnapshot['context'], from: string): string | null {
  const own = context[from]?.summary;
  if (typeof own === 'string' && own.trim() !== '') return own;
  let found: string | null = null;
  for (const [key, value] of Object.entries(context)) {
    if (key.startsWith('__')) continue;
    const s = value.summary;
    if (typeof s === 'string' && s.trim() !== '') found = s;
  }
  return found;
}

// ---------------------------------------------------------------- entering a state

interface EnterOpts {
  /** input_request kind/question if the target is a human state. */
  kind: InputRequestKind;
  question: string;
  /** `attach: output` for an agent target. */
  attachment: PromptAttachment | null;
  /** input.provided: the answer to deliver (send_input or the start_session prompt). */
  answer: PendingAnswer | null;
  /** input.provided back into the live agent of `return_to`: send_input, no new process. */
  sendInput: boolean;
  /**
   * input.provided back into `return_to` (the agent that asked): a resume's prompt is the bare
   * answer. A `goto` into another agent state renders that state's prompt with the answer in it.
   */
  continuation: boolean;
  /** session.assigned: an agent target goes to `assigned`, not `running`. */
  assigning: boolean;
  /** ADR-0009/0010: the unmet requirements that routed to an agent target (`on_unmet.goto`). */
  feedback?: ReviewFeedback | null;
  /** `state_entered.from` when it differs from the state being left (a gate step's label). */
  auditFrom?: string;
  /**
   * ADR-0010: enter the target even if it has `entry` requirements (a passed entry step, and
   * every failure route to a human: fallback, budget, on_unmet).
   */
  skipEntry?: boolean;
  /** The outcome that selected the target (an entry step's `outcome`). */
  outcome?: string;
  /** What the source state reported (an entry step's reviewer subject). */
  info?: OutcomeInfo;
}

const NO_ROUTE: EnterOpts = {
  kind: 'approval',
  question: '',
  attachment: null,
  answer: null,
  sendInput: false,
  continuation: true,
  assigning: false,
};

/**
 * Transition into `target`: wall time (10-contracts §Wall time), visit counter, `state_entered`,
 * `return_to`, deadline, then the target type's status and command.
 */
function enter(st: Step, target: string, opts: EnterOpts): void {
  const s = st.s;
  const toState = st.def.states[target];
  if (toState === undefined) {
    failSession(st, 'failed', `workflow has no state "${target}"`);
    return;
  }
  const from = s.workflow_state;
  // ADR-0010: an outcome into a state with `entry` requirements runs the entry step first; the
  // session stays in `from` (its column) until every requirement is met.
  if (toState.entry !== undefined && opts.skipEntry !== true && !opts.assigning && from !== null) {
    enterStep(st, {
      kind: 'entry',
      from,
      outcome: opts.outcome ?? 'routed',
      to: target,
      attachment: opts.attachment,
      info: opts.info ?? {},
    });
    return;
  }
  addWallTime(st);
  const visit = (s.state_visits[target] ?? 0) + 1;
  s.state_visits = { ...s.state_visits, [target]: visit };
  s.workflow_state = target;
  s.return_to = toState.type === 'human' ? from : null;
  st.emit({ type: 'state_entered', from: opts.auditFrom ?? from, to: target, visit });

  // 10-contracts §Pending answer: cleared when apply enters a different state, unless this apply
  // delivers an answer (input.provided). A same-state re-entry keeps it for the re-answer.
  if (from !== target && opts.answer === null) s.pending_answer = null;

  // Agent and command states need a machine. Without one (e.g. an answer routed while the session
  // was requeued) the session waits in the queue; the next session.assigned re-emits.
  const needsMachine = toState.type === 'agent' || toState.type === 'command';
  if (needsMachine && s.machine_id === null) {
    if (toState.type === 'agent') s.pending_answer = opts.answer ?? s.pending_answer;
    else s.pending_answer = null;
    st.setDeadline(target, null);
    requeue(st);
    return;
  }

  st.setDeadline(target, deadlineFor(toState, st.now));

  switch (toState.type) {
    case 'agent': {
      if (opts.sendInput && opts.answer !== null && opts.answer.input_request_id !== null) {
        // Live process of return_to: the answer goes to stdin; it stays pending until the agent's
        // next complete_state / ask_user (§Pending answer).
        s.pending_answer = opts.answer;
        st.emit({
          type: 'send_input',
          input_request_id: opts.answer.input_request_id,
          text: opts.answer.answer,
        });
      } else {
        const answer = opts.answer ?? s.pending_answer;
        s.pending_answer = answer;
        st.emit(
          startSession(st, target, toState, {
            attachment: opts.attachment,
            answer: answer?.answer ?? null,
            verbatim: opts.continuation,
            feedback: opts.feedback ?? null,
          }),
        );
      }
      st.setStatus(opts.assigning ? 'assigned' : 'running');
      return;
    }
    case 'command':
      s.pending_answer = null;
      st.emit(runCmd(target, toState));
      st.setStatus('running');
      return;
    case 'connector':
      s.pending_answer = null;
      st.emit(connectorCall(st, target, toState));
      st.setStatus('running');
      return;
    case 'event':
      s.pending_answer = null;
      st.setStatus('waiting_external');
      return;
    case 'human':
      s.pending_answer = null;
      st.emit({
        type: 'create_input_request',
        kind: opts.kind,
        question: opts.question || `Waiting in "${target}".`,
        return_to: from,
      });
      st.setStatus('needs_input');
      return;
    case 'terminal':
      s.pending_answer = null;
      st.setStatus('done');
      st.ticket('done');
      return;
  }
}

/**
 * 10-contracts §Wall time: add `now - state_entered_at` for the state being left unless it is a
 * parked (`human` / `event`) state, then restart the clock. A review step is not in `def.states`;
 * its time is added when it is left, after `leaveReview` has put its source state back.
 */
function addWallTime(st: Step): void {
  const s = st.s;
  const from = s.workflow_state;
  const fromState = from === null ? undefined : st.def.states[from];
  if (fromState !== undefined && fromState.type !== 'human' && fromState.type !== 'event') {
    const elapsed = (st.now.getTime() - Date.parse(s.state_entered_at)) / 1000;
    if (elapsed > 0) s.wall_seconds += elapsed;
  }
  s.state_entered_at = st.now.toISOString();
}

/**
 * When the state's timeout fires (null = no timer). Command states hand their timeout to the
 * daemon (`run_cmd.timeout_ms` → `cmd_exit timed_out`) instead: `command.exited` carries no
 * run_cmd id, so a timer that left the state could let a late exit land on a later visit.
 * A human state is timed only if it maps `timeout`.
 */
export function deadlineFor(state: WorkflowState, now: Date): string | null {
  if (state.type === 'terminal' || state.type === 'command' || state.timeout === undefined) {
    return null;
  }
  if (state.type === 'human' && state.on?.timeout === undefined) return null;
  return new Date(now.getTime() + parseDuration(state.timeout)).toISOString();
}

/** Back to the queue: the ticket is re-claimable and no timer runs while queued. */
function requeue(st: Step): void {
  st.setStatus('queued');
  st.ticket('ready');
  if (st.s.state_deadline !== null && st.stateName !== null) st.setDeadline(st.stateName, null);
}

/** → failed; kill whatever runs on the machine. Cancel → ticket `cancelled`, else `failed`. */
function failSession(st: Step, ticket: TicketStatus, reason: string): void {
  const s = st.s;
  if (s.machine_id !== null) st.emit({ type: 'kill', reason });
  if (s.state_deadline !== null && s.workflow_state !== null)
    st.setDeadline(s.workflow_state, null);
  s.pending_answer = null;
  s.step = null;
  st.setStatus('failed');
  st.ticket(ticket);
}

// ---------------------------------------------------------------- command effects

function startSession(
  st: Step,
  name: string,
  state: AgentState,
  p: {
    attachment: PromptAttachment | null;
    answer: string | null;
    verbatim?: boolean;
    feedback?: ReviewFeedback | null;
  },
): Extract<Effect, { type: 'start_session' }> {
  const resume = st.s.claude_session_id;
  // §Pending answer: a resume's prompt is the answer itself. A fresh Claude session (no id yet)
  // has no conversation to resume, and a `goto` into another agent state needs that state's
  // instructions, so both get the full rendered prompt with the answer in it.
  // TD: a re-claim after a refused `goto` start re-emits the bare answer (the snapshot doesn't
  // record that the answer came with a goto).
  const prompt =
    p.answer !== null && resume !== null && p.verbatim !== false
      ? p.answer
      : renderPrompt({
          stateName: name,
          state,
          snapshot: st.s,
          attachment: p.attachment,
          answer: p.answer,
          feedback: p.feedback ?? null,
        });
  return {
    type: 'start_session',
    state: name,
    prompt,
    tools: [...(state.tools ?? [])],
    resume_claude_session_id: resume,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.max_turns !== undefined ? { max_turns: state.max_turns } : {}),
    max_budget_usd: Math.max(0, st.def.budget.usd - st.s.spend_usd),
  };
}

function runCmd(
  name: string,
  state: Extract<WorkflowState, { type: 'command' }>,
): Extract<Effect, { type: 'run_cmd' }> {
  return {
    type: 'run_cmd',
    state: name,
    cmd: state.cmd,
    cwd: state.cwd ?? null,
    timeout_ms: state.timeout !== undefined ? parseDuration(state.timeout) : null,
  };
}

/** 05 §Idempotency: `<session_id>:<state>:<visit_n>`. No connector results reach apply in M1. */
function connectorCall(
  st: Step,
  name: string,
  state: Extract<WorkflowState, { type: 'connector' }>,
): Extract<Effect, { type: 'connector_call' }> {
  const actions = state.actions ?? (state.action !== undefined ? [state.action] : []);
  const visit = st.s.state_visits[name] ?? 1;
  return {
    type: 'connector_call',
    state: name,
    actions: actions.length > 0 ? actions : [name],
    args: state.args ?? {},
    idempotency_key: `${st.s.id}:${name}:${visit}`,
  };
}
