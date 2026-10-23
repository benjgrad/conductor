import type { InputRequestKind, JsonObject, SessionStatus, TicketStatus } from '../domain.js';
import { evaluateGuard } from '../workflow/guards.js';
import {
  parseDuration,
  type AgentState,
  type RequirementsGate,
  type WorkflowDefinition,
  type WorkflowState,
} from '../workflow/schema.js';
import { renderPrompt, type PromptAttachment } from './render.js';
import {
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
  PendingAnswer,
  ReviewStep,
  SessionSnapshot,
} from './types.js';

export { renderPrompt, TICKET_TEMPLATE } from './render.js';
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
  if (st.s.review !== null) return handleReview(st, e);
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
  if (data !== undefined) st.s.context = { ...st.s.context, [from]: { event: name, ...data } };
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
    enter(st, target, { ...NO_ROUTE, kind: 'budget_exceeded', question });
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
    enter(st, t, { ...NO_ROUTE, kind, question, attachment: null });
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
    enterReview(st, { from, outcome, to: t.goto, attachment: null, info });
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
      enterReview(st, { from, outcome, to: t.goto, attachment, info });
      return;
    }
    enter(st, t.goto, { ...NO_ROUTE, kind, question, attachment });
    return;
  }
  const exhausted = withOutput(
    `"${from}" failed ${taken} time${taken === 1 ? '' : 's'} (${info.detail ?? outcome}; retry limit ${cap}). Retry, skip, or abort?`,
    info.output,
  );
  if (t.else !== undefined) {
    enter(st, t.else, { ...NO_ROUTE, kind: 'retries_exhausted', question: exhausted });
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
  enter(st, target, { ...NO_ROUTE, kind, question });
}

// ---------------------------------------------------------------- requirements review (ADR-0009)
//
// An outcome that selects a gated transition enters a review step instead of the target:
// `workflow_state` = reviewStateLabel(from, to), `review` = the step, status stays `running`, a
// 10m deadline, and a start_session for a FRESH reviewer (tools ['review'], never the worker's
// claude_session_id). The reviewer's `complete_state {verdict}` is the step's outcome:
// all met → `to`; unmet → `on_unmet.goto` with the reasons (counter `requirements:<from>:<outcome>`
// capped at `on_unmet.retries`), then `on_unmet.else` (a human state). No verdict (malformed,
// ask_user, exit) → one nudge, then `else`; daemon `no_outcome` (it already nudged) and the
// timeout → `else` directly. Every other event is ignored while reviewing.

function gateOf(def: WorkflowDefinition, from: string, outcome: string): RequirementsGate | null {
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return null;
  const t = state.on?.[outcome];
  return typeof t === 'object' ? (t.requirements ?? null) : null;
}

function enterReview(
  st: Step,
  p: {
    from: string;
    outcome: string;
    to: string;
    attachment: PromptAttachment | null;
    info: OutcomeInfo;
  },
): void {
  const s = st.s;
  const label = reviewStateLabel(p.from, p.to);
  addWallTime(st);
  const visit = (s.state_visits[label] ?? 0) + 1;
  s.state_visits = { ...s.state_visits, [label]: visit };
  s.workflow_state = label;
  s.return_to = null;
  s.pending_answer = null;
  s.review = {
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
  };
  st.emit({ type: 'state_entered', from: p.from, to: label, visit });
  if (s.machine_id === null) {
    st.setDeadline(label, null);
    requeue(st);
    return;
  }
  if (!emitReviewer(st, null)) return;
  st.setDeadline(label, reviewDeadline(st.now));
  st.setStatus('running');
}

function reviewDeadline(now: Date): string {
  return new Date(now.getTime() + parseDuration(REVIEW_TIMEOUT)).toISOString();
}

/**
 * The reviewer's start_session. `nudge` null → a fresh reviewer with the full prompt. Otherwise
 * resume the reviewer's OWN conversation with the nudge (or, before its id is known, a fresh one
 * with the full prompt plus the nudge). Never the worker's `claude_session_id`. false (and the
 * session failed) if the pinned definition has no gate here, which validation rules out.
 */
function emitReviewer(st: Step, nudge: string | null): boolean {
  const r = st.s.review!;
  const gate = gateOf(st.def, r.from, r.outcome);
  if (gate === null) {
    failSession(st, 'failed', `no requirements gate on "${r.from}" outcome "${r.outcome}"`);
    return false;
  }
  const resume = nudge !== null ? r.claude_session_id : null;
  const full = () =>
    renderReviewPrompt({
      from: r.from,
      outcome: r.outcome,
      to: r.to,
      items: gate.items,
      ticket: st.s.ticket,
      subject: r.subject,
    });
  const prompt = nudge === null ? full() : resume !== null ? nudge : `${full()}\n\n${nudge}`;
  st.emit({
    type: 'start_session',
    state: st.s.workflow_state ?? reviewStateLabel(r.from, r.to),
    prompt,
    tools: [...REVIEW_TOOLS],
    resume_claude_session_id: resume,
    ...(gate.model !== undefined ? { model: gate.model } : {}),
    max_budget_usd: Math.max(0, st.def.budget.usd - st.s.spend_usd),
    review: true,
  });
  return true;
}

function handleReview(st: Step, e: EngineEvent): ApplyIgnoreReason | null {
  const s = st.s;
  const r = s.review!;
  const gate = gateOf(st.def, r.from, r.outcome);
  if (gate === null) {
    failSession(st, 'failed', `no requirements gate on "${r.from}" outcome "${r.outcome}"`);
    return null;
  }
  switch (e.type) {
    case 'session.assigned':
      // Re-claim after a refused reviewer start: a fresh reviewer.
      if (s.status !== 'queued') return 'wrong_status';
      s.machine_id = e.machine_id;
      if (!emitReviewer(st, null)) return null;
      st.setStatus('assigned');
      st.setDeadline(s.workflow_state!, reviewDeadline(st.now));
      return null;
    case 'command.refused':
      if (e.command_kind === 'kill') return 'kill_refused';
      if (e.command_kind === 'send_message') return 'message_refused';
      if (e.command_kind !== 'start_session') return 'unexpected_event';
      if (e.command_id !== s.agent_command_id || s.agent_process_live) return 'command_id_mismatch';
      s.agent_command_id = null;
      s.agent_process_live = false;
      s.machine_id = null;
      requeue(st);
      return null;
    case 'session.started':
      return onStarted(st, e.command_id);
    case 'agent.claude_session_id':
      // The reviewer's conversation, kept apart from the worker's (never resumed into it).
      r.claude_session_id = e.claude_session_id;
      return null;
    case 'spend.reported':
      onSpend(st, e.claude_session_id, e.total_usd);
      return null;
    case 'agent.complete_state':
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      onVerdict(st, r, gate, e.result);
      return null;
    case 'agent.ask_user':
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      reviewNoVerdict(
        st,
        r,
        gate,
        'the reviewer called ask_user instead of reporting a verdict',
        true,
      );
      return null;
    case 'agent.no_outcome':
      // The daemon has already nudged this reviewer once (U-028).
      if (!AGENT_ACTIVE.has(s.status)) return 'wrong_status';
      reviewNoVerdict(st, r, gate, 'the reviewer stopped without reporting a verdict', false);
      return null;
    case 'agent.exited': {
      if (s.agent_command_id === null || e.command_id !== s.agent_command_id) {
        return 'command_id_mismatch';
      }
      s.agent_process_live = false;
      if (!AGENT_ACTIVE.has(s.status)) return null;
      const how = e.signal !== null ? `signal ${e.signal}` : `exit code ${String(e.code)}`;
      reviewNoVerdict(st, r, gate, `the reviewer exited (${how}) without a verdict`, true);
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
      reviewFail(
        st,
        gate,
        'timeout',
        `The requirements review for "${r.from}" → "${r.to}" timed out (review timed out after ${REVIEW_TIMEOUT}). Retry, skip, or abort?`,
      );
      return null;
    }
    case 'budget.exceeded': {
      const target = st.def.states[st.def.on_budget_exceeded];
      leaveReview(st, target?.type !== 'agent' && target?.type !== 'command');
      return onBudget(st, e);
    }
    case 'operator.cancel':
      failSession(st, 'cancelled', e.reason ?? 'operator_cancel');
      return null;
    case 'operator.message':
      // The reviewer judges independently: a human's live message is refused (ADR-0009 notes).
      return 'wrong_status';
    case 'input.provided':
      return 'wrong_status';
    case 'command.exited':
    case 'external.event':
      return 'unexpected_event';
  }
}

function onVerdict(st: Step, r: ReviewStep, gate: RequirementsGate, result: JsonObject): void {
  const verdict = parseVerdict(result, gate.items);
  if (!verdict.ok) {
    reviewNoVerdict(st, r, gate, `malformed verdict: ${verdict.error}`, true);
    return;
  }
  const label = st.s.workflow_state!;
  // The verdict is kept for the Details panel, keyed by the review step's label.
  st.s.context = {
    ...st.s.context,
    [label]: { verdict: verdict.items.map((v) => ({ ...v })) },
  };
  const unmet = verdict.items
    .filter((v) => !v.met)
    .map((v) => ({ item: v.item, reason: v.reason }));
  if (unmet.length === 0) {
    leaveReview(st, false);
    const kind = kindForOutcome(r.outcome);
    enter(st, r.to, {
      ...NO_ROUTE,
      kind,
      question: questionFor(r.from, r.outcome, kind, {}),
      attachment: r.attachment,
      auditFrom: label,
    });
    return;
  }
  const feedback: ReviewFeedback = {
    from: r.from,
    to: r.to,
    unmet,
    instruction: gate.on_unmet.instruction ?? null,
  };
  const key = reviewCounterKey(r.from, r.outcome);
  const cap = gate.on_unmet.retries;
  const taken = st.s.retry_counters[key] ?? 0;
  if (taken < cap) {
    st.s.retry_counters = { ...st.s.retry_counters, [key]: taken + 1 };
    leaveReview(st, false);
    enter(st, gate.on_unmet.goto, {
      ...NO_ROUTE,
      kind: 'retries_exhausted',
      question: `${renderReviewFeedback(feedback)}\n\nRetry, skip, or abort?`,
      feedback,
      auditFrom: label,
    });
    return;
  }
  const reviews = taken + 1;
  const question = [
    `Requirements for "${r.from}" → "${r.to}" were not met after ${reviews} review${reviews === 1 ? '' : 's'} (retry limit ${cap}):`,
    ...unmet.map((u) => `- ${u.item}: ${u.reason || '(no reason given)'}`),
    '',
    'Retry, skip, or abort?',
  ].join('\n');
  leaveReview(st, false);
  enter(st, gate.on_unmet.else, {
    ...NO_ROUTE,
    kind: 'retries_exhausted',
    question,
    auditFrom: label,
  });
}

function reviewNoVerdict(
  st: Step,
  r: ReviewStep,
  gate: RequirementsGate,
  why: string,
  canNudge: boolean,
): void {
  if (canNudge && !r.nudged) {
    r.nudged = true;
    emitReviewer(st, reviewNudge(why, gate.items));
    return;
  }
  reviewFail(
    st,
    gate,
    'retries_exhausted',
    `The requirements review for "${r.from}" → "${r.to}" produced no verdict (${why}). Retry, skip, or abort?`,
  );
}

/** A failed review (timeout, no verdict) → `on_unmet.else`, killing the reviewer. */
function reviewFail(
  st: Step,
  gate: RequirementsGate,
  kind: InputRequestKind,
  question: string,
): void {
  const label = st.s.workflow_state!;
  leaveReview(st, true);
  enter(st, gate.on_unmet.else, { ...NO_ROUTE, kind, question, auditFrom: label });
}

/**
 * End the review step: back in its source state (so `enter` counts the review's wall time and a
 * human target's `return_to` is the source), the reviewer process detached (its late exit is a
 * `command_id_mismatch`), optionally killed (a timed-out or parked reviewer).
 */
function leaveReview(st: Step, kill: boolean): void {
  const s = st.s;
  const r = s.review!;
  if (kill && s.machine_id !== null && s.agent_command_id !== null) {
    st.emit({ type: 'kill', reason: 'requirements review ended' });
  }
  s.workflow_state = r.from;
  s.review = null;
  s.agent_command_id = null;
  s.agent_process_live = false;
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
  /** ADR-0009: the unmet review that routed to an agent target (`on_unmet.goto`). */
  feedback?: ReviewFeedback | null;
  /** `state_entered.from` when it differs from the state being left (a review step's label). */
  auditFrom?: string;
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
  s.review = null;
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
