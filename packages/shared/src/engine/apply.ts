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
  AVAILABLE_TRANSITION_ACTIONS,
  parseDuration,
  type AgentState,
  type EntryCheck,
  type RequirementsGate,
  type TransitionAction,
  type WorkflowDefinition,
  type WorkflowState,
} from '../workflow/schema.js';
import {
  isCountedTransition,
  transitionActor,
  transitionObject,
} from '../workflow/transition-rules.js';
import {
  checklistLines,
  enabledIndexes,
  evaluateConditionsArgs,
  evaluationInFlight,
  failedEvidence,
  failWithoutPr,
  FALLBACK_CONDITION_TIMEOUT,
  basePollMs,
  initialStatuses,
  markRunning,
  mergeResults,
  nextPollMs,
  pollDeadline,
  unmarkRunning,
} from './conditions.js';
import {
  combineLostAnswer,
  isRevokedPark,
  lostAnswerOf,
  machineLostMarkOf,
  MACHINE_LOST_ANSWER_KEY,
  planMachineLost,
  withLostAnswer,
  withMachineLostMark,
  withoutMachineLost,
  type MachineLostEvent,
} from './machine-lost.js';
import { moveCounter, moveName, moveSpecOf, PIN_CHECK, type GateSpec } from './move-step.js';
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
import {
  ASK_USER,
  fallbackHumanState,
  planAgentTransition,
  planHumanTransition,
  promptTransitions,
  runsRequirements,
  ticketKind,
  transitionQuestion,
  type MoveRecord,
} from './transitions.js';
import {
  CONDITIONS_NO_MACHINE_NOTE,
  conditionsIdempotencyKey,
  MACHINE_LOST_KILL_REASON,
  MACHINE_LOST_KIND,
  machineLostQuestion,
  moveStateLabel,
  type ApplyFn,
  type ApplyIgnoreReason,
  type ApplyResult,
  type Effect,
  type EngineEvent,
  type GateStep,
  type PendingAnswer,
  type SessionSnapshot,
} from './types.js';

export {
  IMPLEMENT_TEMPLATE,
  PLAN_TEMPLATE,
  PROMPT_TEMPLATES,
  renderPrompt,
  TICKET_TEMPLATE,
} from './render.js';
export type { PromptAttachment, RenderPromptInput } from './render.js';
export { fallbackHumanState } from './transitions.js';
export { PIN_CHECK } from './move-step.js';

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
  // A finished session keeps no lost-machine pin: a reopen copies the context (ADR-0008).
  if (TERMINAL_STATUSES.has(step.s.status)) step.s.context = withoutMachineLost(step.s.context);
  return { snapshot: step.s, effects: step.effects, ignored: null };
};

function ignore(snapshot: SessionSnapshot, reason: ApplyIgnoreReason): ApplyResult {
  return { snapshot, effects: [], ignored: reason };
}

// ---------------------------------------------------------------- event handlers

function handle(st: Step, e: EngineEvent): ApplyIgnoreReason | null {
  if (e.type === 'machine.lost') return onMachineLost(st, e);
  // 10-contracts §Lost machines: a revoked machine can never come back, so Cancel only.
  if (isRevokedPark(st.s)) {
    if (e.type === 'human.transition') return 'transition_not_allowed';
    if (e.type === 'input.provided') return 'wrong_status';
  }
  if (e.type === 'session.assigned') {
    const reason = st.s.step !== null ? handleStep(st, e) : onAssigned(st, e.machine_id);
    // The lost-machine mark pins the claim until the agent runs again (`session.started`). A
    // re-emit with no start_session (a command, check, event or human state) never gets one.
    if (reason === null && !st.effects.some((x) => x.type === 'start_session')) {
      st.s.context = withoutMachineLost(st.s.context);
    }
    return reason;
  }
  if (st.s.step !== null) return handleStep(st, e);
  switch (e.type) {
    case 'command.refused':
      return onRefused(st, e);
    case 'session.started':
      return onStarted(st, e.command_id);
    case 'agent.claude_session_id':
      st.s.claude_session_id = e.claude_session_id;
      return null;
    case 'agent.complete_state':
      return onComplete(st, e);
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
    case 'human.transition':
      return onHumanTransition(st, e);
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
  st.s.context = withoutMachineLost(st.s.context); // running again (§Lost machines)
  if (st.s.status === 'assigned') st.setStatus('running');
  return null;
}

/**
 * 05 §Outcomes, not opinions; 10-contracts §Guards (fail closed, TD-017); ADR-0011 §Who takes a
 * transition (transitions.ts `planAgentTransition`):
 * - no name and no declared `done`: the M1 `done` outcome;
 * - `ask_user`, or a name the agent may not take: to a human through `ask_user` (U-028 path);
 * - a `question: true` transition: its target opens an `agent_question` with the reason; the
 *   state's `result` keys and guard are not checked (it is not a finished step);
 * - any other transition: result keys, then the guard (failed → `fail`), then it is taken.
 */
function onComplete(
  st: Step,
  e: Extract<EngineEvent, { type: 'agent.complete_state' }>,
): ApplyIgnoreReason | null {
  const state = st.state;
  const name = st.stateName;
  if (state?.type !== 'agent' || name === null) return 'unexpected_event';
  if (!AGENT_ACTIVE.has(st.s.status)) return 'wrong_status';
  st.s.pending_answer = null;
  const result = e.result;
  const reason = e.reason ?? null;
  const plan = planAgentTransition(st.def, name, ticketKind(st.s), e.transition, reason);
  if (plan.type === 'ask_user') {
    takeOutcome(
      st,
      ASK_USER,
      { question: plan.question },
      plan.named ? { move: { transition: ASK_USER, reason, actor: 'agent' } } : {},
    );
    return null;
  }
  const outcome = plan.type === 'take' ? plan.name : 'done';
  // Only a named transition is recorded on `state_entered` (no name = the M1 record, unchanged).
  const move: MoveRecord | undefined =
    plan.type === 'take' && e.transition != null
      ? { transition: plan.name, reason, actor: 'agent' }
      : undefined;
  if (plan.type === 'take' && plan.question) {
    takeOutcome(
      st,
      outcome,
      { question: transitionQuestion(plan.name, plan.transition, reason), result },
      { ...(move !== undefined ? { move } : {}), kind: 'agent_question' },
    );
    return null;
  }
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
  if (move === undefined) {
    takeOutcome(st, outcome, { result });
  } else {
    takeOutcome(
      st,
      outcome,
      { result, ...(reason !== null && reason.trim() !== '' ? { detail: reason } : {}) },
      { move },
    );
  }
  return null;
}

/**
 * ADR-0011 human transitions (transitions.ts `planHumanTransition`; 10 §Transitions): a button
 * on a parked card. With `requires` (not a fallback) the move runs as a move step. Otherwise the
 * target is entered: into the asking agent (`RETURN_TO` / `return_to`) the text is its answer,
 * as `input.provided` delivers one (send_input to a live parked process, else the pending answer
 * of a resume); into another agent state the text is an answer in its rendered prompt; anywhere
 * else it is the move's reason. The wrapper answers the open input_request.
 */
function onHumanTransition(
  st: Step,
  e: Extract<EngineEvent, { type: 'human.transition' }>,
): ApplyIgnoreReason | null {
  const plan = planHumanTransition(st.def, st.s, e.name);
  if (!plan.ok) return plan.reason;
  const from = st.stateName!;
  const target = st.def.states[plan.goto]!;
  const moveStep = runsRequirements(plan.name, plan.transition);
  const earlier = leaveLostPark(
    st,
    moveStep || target.type === 'agent' || target.type === 'command',
    !moveStep && target.type === 'agent',
  );
  const move: MoveRecord = { transition: plan.name, reason: e.text, actor: 'human' };
  const detail = e.text ?? `a human chose "${plan.name}"`;
  if (moveStep) {
    enterStep(st, {
      kind: 'move',
      from,
      outcome: plan.name,
      to: plan.goto,
      attachment: null,
      info: { detail },
      move,
    });
    return null;
  }
  const text =
    earlier !== null
      ? combineLostAnswer(earlier.answer, earlier.machine, e.text)
      : plan.continuation
        ? (e.text ?? `[${plan.name}]`)
        : e.text;
  const answer: PendingAnswer | null =
    target.type === 'agent' && text !== null
      ? { input_request_id: e.input_request_id ?? null, answer: text }
      : null;
  leaveParkedAgent(st, target);
  enter(st, plan.goto, {
    ...NO_ROUTE,
    kind: 'approval',
    question: withReason(`A human moved this ticket here ("${plan.name}").`, e.text),
    answer,
    sendInput: plan.continuation && st.s.agent_process_live,
    continuation: plan.continuation,
    outcome: plan.name,
    info: { detail },
    move,
  });
  return null;
}

// ---------------------------------------------------------------- lost machines (U-068, M2-T06)
//
// 10-contracts §Machines protocol v2, "Lost machines" (machine-lost.ts plans; 05 §Lost machines).
// (A) parks the session in the fallback human state with a `machine_lost` request and the
// `__machine_lost` mark; (B) re-asks a parked or pinned session as revoked. apply never changes
// `fencing_token`: the EngineService wrapper bumps it on an applied `machine.lost` (M2-T20).

function onMachineLost(st: Step, e: MachineLostEvent): ApplyIgnoreReason | null {
  const plan = planMachineLost(st.s, e);
  if (plan.type === 'ignore') return plan.reason;
  const s = st.s;
  const prevMark = machineLostMarkOf(s.context);
  const name = e.machine_name ?? prevMark?.machine_name ?? e.machine_id;
  const at = st.now.toISOString();
  if (plan.type === 'revoke_parked' && s.status === 'needs_input') {
    // (B), already parked in a human state: a new question; the wrapper supersedes the old one.
    s.context = withMachineLostMark(s.context, { ...prevMark!, reason: 'revoked', at });
    st.emit({
      type: 'create_input_request',
      kind: MACHINE_LOST_KIND,
      question: machineLostQuestion(name, 'revoked'),
      return_to: s.return_to,
    });
    return null;
  }
  // (A), and (B) for a queued session waiting on its pinned machine after "Continue".
  const prev = s.status;
  const target = fallbackHumanState(st.def);
  const question = machineLostQuestion(name, e.reason, e.offline_ms);
  if (s.step !== null) leaveStep(st, false);
  s.machine_id = e.machine_id;
  s.agent_process_live = false;
  const kill = plan.type === 'park' && plan.kill;
  if (kill) st.emit({ type: 'kill', reason: MACHINE_LOST_KILL_REASON });
  if (target === null) {
    failSession(st, 'failed', `no human state to route to: ${question}`, false);
    return null;
  }
  // The answer the agent never ran on (a reopen message, an earlier Continue) survives the park.
  const unread = s.pending_answer ?? lostAnswerOf(s.context);
  if (unread !== null) s.context = withLostAnswer(s.context, unread);
  s.context = withMachineLostMark(s.context, {
    machine_id: e.machine_id,
    machine_name: name,
    reason: e.reason,
    state: s.workflow_state,
    at,
  });
  enter(st, target, {
    ...NO_ROUTE,
    kind: MACHINE_LOST_KIND,
    question,
    skipEntry: true,
    noDeadline: true,
  });
  if (prev === 'queued') st.ticket('in_progress');
  return null;
}

/**
 * Leaving a lost-machine park (a human move or an answer; never a revoked one, refused earlier).
 * Into something that needs the machine: no live process, so `enter` requeues (machine_id null)
 * and the kept mark pins the claim to `mark.machine_id` (M2-T16). Anywhere else: the mark goes.
 * Returns the kept unread answer when the target is an agent state (`toAgent`), to be delivered
 * before the human's text; anywhere else it is dropped.
 */
function leaveLostPark(
  st: Step,
  needsMachine: boolean,
  toAgent: boolean,
): { answer: string; machine: string } | null {
  const s = st.s;
  const mark = machineLostMarkOf(s.context);
  if (mark === null) return null;
  const kept = lostAnswerOf(s.context);
  if (!needsMachine) {
    s.context = withoutMachineLost(s.context);
    return null;
  }
  s.machine_id = null;
  const rest = { ...s.context };
  delete rest[MACHINE_LOST_ANSWER_KEY];
  s.context = rest;
  return toAgent && kept !== null ? { answer: kept.answer, machine: mark.machine_name } : null;
}

/**
 * BUG-1 (lead decision 2026-10-27): a human moving the ticket off a parked agent into a state
 * that runs no agent (command, event, connector, human) ends the parked process: nothing will
 * answer it there, and a later return to the agent resumes it with start_session. Into an agent
 * state the process is answered (send_input) or superseded (start_session); into a terminal
 * state `enter` kills it.
 */
function leaveParkedAgent(st: Step, target: WorkflowState): void {
  if (target.type === 'agent' || target.type === 'terminal') return;
  releaseAgent(st, 'a human moved the ticket off the agent');
}

function withReason(text: string, reason: string | null): string {
  return reason !== null && reason.trim() !== '' ? `${text}\n\n${reason}` : text;
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
  const continuation = target === st.s.return_to;
  const earlier = leaveLostPark(
    st,
    targetState.type === 'agent' || targetState.type === 'command',
    targetState.type === 'agent',
  );
  const answer: PendingAnswer = {
    input_request_id: e.input_request_id,
    answer:
      earlier !== null ? combineLostAnswer(earlier.answer, earlier.machine, e.answer) : e.answer,
  };
  leaveParkedAgent(st, targetState);
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
 * Take `outcome` out of the current state (05 §Retry loops). A string target is followed; a
 * counted object (`isCountedTransition`: `attach` / `retries` / `else`) takes `goto` while
 * `retry_counters["<from>-><goto>"]` < `retries` (default `budget.max_loop_retries`), else `else`.
 * Any other object is a plain forward move. A transition with ADR-0009 `requirements` enters a
 * review step; one with ADR-0011 `requires` (not a fallback route) enters a move step, after its
 * counter if counted. An unmapped outcome (or an exhausted loop without `else`) goes to the
 * fallback human state: every failure path ends at a human.
 * `opts.move`: the named transition (ADR-0011), recorded on `state_entered`; `opts.kind`
 * overrides the input_request kind of a human target (a `question: true` transition).
 */
function takeOutcome(
  st: Step,
  outcome: string,
  info: OutcomeInfo,
  opts: { move?: MoveRecord; kind?: InputRequestKind } = {},
): void {
  const from = st.stateName ?? st.def.start;
  const state = st.state;
  const t = state && state.type !== 'terminal' ? state.on?.[outcome] : undefined;
  const kind = opts.kind ?? kindForOutcome(outcome);
  const question = questionFor(from, outcome, kind, info);
  const move = opts.move !== undefined ? { move: opts.move } : {};

  if (t === undefined) {
    toFallbackHuman(st, kind, question);
    return;
  }
  if (typeof t === 'string') {
    enter(st, t, { ...NO_ROUTE, kind, question, attachment: null, outcome, info, ...move });
    return;
  }
  const gate = t.requirements;
  const moveStep = gate === undefined && runsRequirements(outcome, t);
  const step = (attachment: PromptAttachment | null) =>
    enterStep(st, {
      kind: moveStep ? 'move' : 'transition',
      from,
      outcome,
      to: t.goto,
      attachment,
      info,
      // A move step always records who took it (a system outcome's actor when not named); an
      // ADR-0009 review keeps its M1 record.
      ...(moveStep
        ? {
            move: opts.move ?? {
              transition: outcome,
              reason: info.detail ?? null,
              actor: transitionActor(st.def, from, outcome, t),
            },
          }
        : {}),
    });
  // ADR-0009 / ADR-0011: an object that isn't a counted loop is a plain forward transition, like
  // a string target: no counter on its goto leg (requirement retries count under their own key).
  if (!isCountedTransition(t)) {
    if (gate !== undefined || moveStep) {
      step(null);
      return;
    }
    enter(st, t.goto, { ...NO_ROUTE, kind, question, attachment: null, outcome, info, ...move });
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
    if (gate !== undefined || moveStep) {
      step(attachment);
      return;
    }
    enter(st, t.goto, { ...NO_ROUTE, kind, question, attachment, outcome, info, ...move });
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

function gateOf(def: WorkflowDefinition, from: string, outcome: string): RequirementsGate | null {
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return null;
  const t = state.on?.[outcome];
  return typeof t === 'object' ? (t.requirements ?? null) : null;
}

function gateSpecOf(def: WorkflowDefinition, r: GateStep): GateSpec | null {
  if (r.kind === 'move') return moveSpecOf(def, r);
  if (r.kind === 'transition') {
    const gate = gateOf(def, r.from, r.outcome);
    if (gate === null) return null;
    return {
      title: r.to,
      goal: `enter "${r.to}"`,
      checks: [],
      setup: null,
      review: { items: gate.items, model: gate.model },
      actions: [],
      conditions: [],
      on_unmet: gate.on_unmet,
    };
  }
  const entry = def.states[r.to]?.entry;
  if (entry === undefined) return null;
  const title = stateTitle(def, r.to);
  return {
    title,
    goal: `enter "${title}"`,
    // An entry without checks still pins the commit first (review-only / action-only): a no-op
    // clean-tree check reports HEAD, so open_pr always pushes a recorded commit.
    checks: entry.checks !== undefined && entry.checks.length > 0 ? entry.checks : [PIN_CHECK],
    setup: entry.setup ?? null,
    review: entry.review ?? null,
    actions: entry.actions ?? [],
    conditions: [],
    on_unmet: entry.on_unmet,
  };
}

function noGate(r: GateStep): string {
  switch (r.kind) {
    case 'transition':
      return `no requirements gate on "${r.from}" outcome "${r.outcome}"`;
    case 'entry':
      return `no entry requirements on "${r.to}"`;
    case 'move':
      return `no requirements on "${r.from}" transition "${moveName(r)}"`;
  }
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
    /** ADR-0011 (`kind: 'move'`): the transition taken, by whom and why. */
    move?: MoveRecord;
  },
): void {
  const s = st.s;
  const label =
    p.kind === 'entry'
      ? entryStateLabel(p.from, p.to)
      : p.kind === 'move'
        ? moveStateLabel(p.from, p.to, p.move?.transition ?? p.outcome)
        : reviewStateLabel(p.from, p.to);
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
    phase: p.kind === 'transition' ? 'review' : 'checks',
    index: 0,
    head_sha: null,
    transition: p.move?.transition ?? null,
    actor: p.move?.actor ?? null,
    reason: p.move?.reason ?? null,
    conditions: [],
    conditions_deadline: null,
    conditions_poll_ms: null,
    conditions_note: null,
  };
  st.emit({ type: 'state_entered', from: p.from, to: label, visit, ...moveFields(p.move) });
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
          // Only committed changes are checked (and pushed): the daemon refuses a dirty tree.
          require_clean: true,
          // Ben, 2026-10-26: every real check runs in a fresh checkout of the one recorded commit
          // (the implicit pin check doesn't: it only records the clean HEAD).
          ...(check === PIN_CHECK
            ? {}
            : {
                checkout: {
                  sha: r.head_sha,
                  setup: spec.setup,
                  last: r.index === spec.checks.length - 1,
                },
              }),
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
    if (r.phase === 'actions') {
      const action = spec.actions[r.index];
      if (action === undefined) {
        r.phase = 'conditions';
        r.index = 0;
        continue;
      }
      if (!AVAILABLE_TRANSITION_ACTIONS.includes(action)) {
        // Parsed but refused by the validator until M5 (rule 14): never reached on a valid version.
        stepFail(
          st,
          spec,
          'retries_exhausted',
          `Conductor cannot ${actionLabel(action)} yet, so it did not ${spec.goal}. Retry, skip, or abort?`,
          false,
        );
        return;
      }
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
    // ADR-0011 conditions (a move's `requires.conditions`; none for older kinds).
    startConditions(st, spec);
    return;
  }
}

/** Every requirement met: enter `to` (an ADR-0009 review's target may still have its own entry). */
function passStep(st: Step): void {
  const r = st.s.step!;
  const label = st.s.workflow_state!;
  leaveStep(st, false);
  if (r.kind === 'move') {
    passMove(st, r, label);
    return;
  }
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
 * ADR-0011: a move's requirements are met: enter its target as the transition would have. A
 * `question: true` transition opens the agent's question; a human's text reaches an agent target
 * as an answer in its rendered prompt (the step ended the parked process, so it starts afresh).
 */
function passMove(st: Step, r: GateStep, label: string): void {
  const name = moveName(r);
  const move: MoveRecord = { transition: name, reason: r.reason, actor: r.actor ?? 'agent' };
  const raw = onOf(st.def, r.from)?.[name];
  const t = raw === undefined ? undefined : transitionObject(raw);
  const question = t?.question === true;
  const kind = question ? 'agent_question' : kindForOutcome(name);
  const humanText =
    move.actor === 'human' && r.reason !== null && st.def.states[r.to]?.type === 'agent'
      ? { input_request_id: null, answer: r.reason }
      : null;
  enter(st, r.to, {
    ...NO_ROUTE,
    kind,
    question:
      question && t !== undefined
        ? transitionQuestion(name, t, r.reason)
        : questionFor(r.from, name, kind, r.reason !== null ? { detail: r.reason } : {}),
    attachment: r.attachment,
    answer: humanText,
    continuation: false,
    auditFrom: label,
    outcome: name,
    move,
  });
}

/** The `on` map of a state, or undefined (terminal / unknown). */
function onOf(def: WorkflowDefinition, state: string) {
  const s = def.states[state];
  return s === undefined || s.type === 'terminal' ? undefined : s.on;
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
      ...(r.kind === 'move' ? { commit: r.head_sha } : {}),
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

function handleStep(
  st: Step,
  e: Exclude<EngineEvent, { type: 'machine.lost' }>,
): ApplyIgnoreReason | null {
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
            `Could not run the check "${check.name}" (\`${check.cmd}\`) to ${spec.goal}: the daemon refused it (${e.reason}). Retry, skip, or abort?`,
            false,
          );
          return null;
        }
        case 'run_action': {
          if (r.phase === 'conditions') {
            if (!evaluationInFlight(r) || s.status !== 'waiting_external') {
              return 'unexpected_event';
            }
            conditionsNoAnswer(st, spec, r, CONDITIONS_NO_MACHINE_NOTE);
            return null;
          }
          const action = r.phase === 'actions' ? spec.actions[r.index] : undefined;
          if (action === undefined || s.status !== 'running') return 'unexpected_event';
          stepFail(
            st,
            spec,
            'retries_exhausted',
            `Conductor could not ${actionLabel(action)} to ${spec.goal}: the daemon refused it (${e.reason}). Retry, skip, or abort?`,
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
      if (r.phase === 'conditions') {
        // TD-103: the answer isn't matched to its command (e.command_id is ignored), so a late
        // answer from a timed-out visit, or a second evaluation sent by a re-claim, can be taken
        // as this visit's answer.
        if (e.action !== EVALUATE_CONDITIONS || !evaluationInFlight(r)) return 'unexpected_event';
        if (s.status !== 'waiting_external') return 'wrong_status';
        onConditionsResult(st, spec, r, e);
        return null;
      }
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
      if (r.phase === 'conditions') {
        onConditionsTimer(st, spec, r, e.deadline);
        return null;
      }
      if (r.phase === 'review') {
        const question =
          r.kind === 'transition'
            ? `The requirements review for "${r.from}" → "${r.to}" timed out (review timed out after ${REVIEW_TIMEOUT}). Retry, skip, or abort?`
            : `The requirements review to ${spec.goal} timed out (review timed out after ${REVIEW_TIMEOUT}). Retry, skip, or abort?`;
        stepFail(st, spec, 'timeout', question, true);
      } else {
        const action = spec.actions[r.index];
        const what =
          action !== undefined
            ? actionLabel(action)
            : r.kind === 'move'
              ? 'finish the move step'
              : 'finish the entry step';
        stepFail(
          st,
          spec,
          'timeout',
          `Conductor did not ${what} to ${spec.goal} in time (timed out after ${ENTRY_ACTION_TIMEOUT}). Retry, skip, or abort?`,
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
    case 'human.transition':
      return 'wrong_status';
    case 'external.event':
      return conditionsOverride(st, r, e.name, e.data);
  }
}

// ---------------------------------------------------------------- the conditions phase (ADR-0011)
//
// The last phase of a move step (05 §Conditions; conditions.ts holds the pure parts). The session
// is paused (U-059): status `waiting_external`, the worker already ended by the step, no wall time,
// the card in the source column with the checklist (`step.conditions`). One `run_action
// evaluate_conditions` per poll on the session's machine; the timer is the next poll, never past
// `conditions_deadline`. All met → `to`; any failed → `on_unmet.goto` with the evidence (counter
// `move:<from>:<name>`), then `else`; the timeout → `on_unmet.else` (kind `timeout`, U-063).

const EVALUATE_CONDITIONS = 'evaluate_conditions';

/**
 * Start the conditions phase (or, after a re-claim, resume it without resetting its deadline).
 * No enabled condition → pass. Enabled PR conditions without conductor's PR → failed at once.
 */
function startConditions(st: Step, spec: GateSpec): void {
  const s = st.s;
  const r = s.step!;
  if (enabledIndexes(spec.conditions).length === 0) {
    passStep(st);
    return;
  }
  if (r.conditions_deadline === null) {
    // U-059: paused from here. Bank the step's time so far, as `enter` would on leaving it.
    bankWallTime(st, r.from);
    r.conditions = initialStatuses(spec.conditions);
    r.conditions_deadline = deadlineIn(
      st.now,
      spec.condition_timeout ?? FALLBACK_CONDITION_TIMEOUT,
    );
    r.conditions_poll_ms = basePollMs(spec.condition_poll);
    r.conditions_note = null;
    const failed = failWithoutPr(s, spec.conditions, r.conditions, st.now);
    if (failed !== null) {
      // The agent can't create conductor's PR, so retrying would only use up retries: straight
      // to `on_unmet.else` (a human), uncounted (lead decision).
      r.conditions = failed;
      const lines = [
        `Conductor could not check the conditions to ${spec.goal}:`,
        ...failed
          .filter((c) => c.status === 'failed')
          .map((c) => {
            const ev = failedEvidence(c);
            return `- ${ev.item}: ${ev.reason}`;
          }),
        '',
        'Retry, skip, or abort?',
      ];
      stepFail(st, spec, 'retries_exhausted', lines.join('\n'), false);
      return;
    }
  }
  st.setStatus('waiting_external');
  evaluateConditions(st, spec, r);
}

/**
 * One evaluation on the session's machine, then the next poll timer. Without a machine nothing is
 * sent; the checklist says so (U-058) and the timeout keeps running.
 */
function evaluateConditions(st: Step, spec: GateSpec, r: GateStep): void {
  const s = st.s;
  const label = s.workflow_state!;
  if (s.machine_id === null) {
    r.conditions_note = CONDITIONS_NO_MACHINE_NOTE;
  } else {
    // TD-104: conditions are re-checked on the session's machine only; ADR-0016 §Execution wants any
    // online machine of the account with the capability (M2: accounts, more than one machine).
    r.conditions = markRunning(r.conditions);
    st.emit({
      type: 'run_action',
      state: label,
      target_state: r.to,
      action: EVALUATE_CONDITIONS,
      idempotency_key: conditionsIdempotencyKey(s.id, label, st.now),
      args: evaluateConditionsArgs(s, r, spec.conditions),
      expected_sha: r.head_sha,
    });
  }
  armConditionsPoll(st, spec, r);
}

/** The next poll: `now + conditions_poll_ms`, never past `conditions_deadline`. */
function armConditionsPoll(st: Step, spec: GateSpec, r: GateStep): void {
  const poll = r.conditions_poll_ms ?? basePollMs(spec.condition_poll);
  r.conditions_poll_ms = poll;
  const until = r.conditions_deadline ?? deadlineIn(st.now, FALLBACK_CONDITION_TIMEOUT);
  r.conditions_deadline = until;
  st.setDeadline(st.s.workflow_state!, pollDeadline(st.now, poll, until));
}

/** An evaluation's answer: all met → `to`; any failed → unmet; else pending (backoff). */
function onConditionsResult(
  st: Step,
  spec: GateSpec,
  r: GateStep,
  e: Extract<EngineEvent, { type: 'action.completed' }>,
): void {
  if (e.error !== null) {
    conditionsNoAnswer(st, spec, r, `the last check failed: ${e.error}`);
    return;
  }
  const v = mergeResults(r.conditions, spec.conditions, e.result, st.now);
  if (v.type === 'malformed') {
    conditionsNoAnswer(st, spec, r, `the last check returned an unusable result (${v.why})`);
    return;
  }
  r.conditions = v.statuses;
  r.conditions_note = null;
  if (v.outcome === 'failed') {
    conditionsFailed(st, spec, r);
    return;
  }
  if (v.outcome === 'met') {
    passStep(st);
    return;
  }
  // `pending` and `unsupported`: poll again, doubling after an unchanged answer.
  r.conditions_poll_ms = nextPollMs(
    r.conditions_poll_ms,
    basePollMs(spec.condition_poll),
    v.unchanged,
  );
  armConditionsPoll(st, spec, r);
}

/**
 * The evaluation was refused, errored or unusable: still pending (not a requeue), a note on the
 * checklist, and the next poll (which sends a new evaluation).
 */
function conditionsNoAnswer(st: Step, spec: GateSpec, r: GateStep, note: string): void {
  r.conditions = unmarkRunning(r.conditions);
  r.conditions_note = note;
  armConditionsPoll(st, spec, r);
}

/**
 * The poll timer: past `conditions_deadline` → the timeout. Otherwise a new evaluation, unless
 * the last one is still unanswered (or there is no machine): the dispatcher never refuses a
 * `run_action` to an offline machine (only start_session ack timeouts become `command.refused`),
 * it waits in the outbox until the machine is back, so another one would only pile up. The
 * checklist then says "waiting for a machine" and the timer re-arms.
 */
function onConditionsTimer(st: Step, spec: GateSpec, r: GateStep, deadline: string): void {
  const until = r.conditions_deadline;
  if (until === null || Date.parse(deadline) >= Date.parse(until)) {
    conditionsTimedOut(st, spec, r);
    return;
  }
  if (st.s.machine_id === null || evaluationInFlight(r)) {
    // TD-105: an evaluation the daemon acked but never answered stays `running` until the timeout
    // (no re-send while one is in flight; the dispatcher has no run_action ack timeout).
    r.conditions_note = CONDITIONS_NO_MACHINE_NOTE;
    armConditionsPoll(st, spec, r);
    return;
  }
  evaluateConditions(st, spec, r);
}

/** U-063: the timeout → `on_unmet.else`, kind `timeout`, the checklist as the question. Kills nothing. */
function conditionsTimedOut(st: Step, spec: GateSpec, r: GateStep): void {
  const lines = [
    `The conditions to ${spec.goal} were not all met within ${spec.condition_timeout ?? FALLBACK_CONDITION_TIMEOUT}:`,
    ...checklistLines(unmarkRunning(r.conditions)),
  ];
  if (r.conditions_note !== null) lines.push('', `Note: ${r.conditions_note}.`);
  lines.push('', 'Retry, skip, or abort?');
  stepFail(st, spec, 'timeout', lines.join('\n'), false);
}

/** U-063: a condition is false → `on_unmet.goto` with the evidence (counted), then `else`. */
function conditionsFailed(st: Step, spec: GateSpec, r: GateStep): void {
  stepUnmet(st, spec, r, r.conditions.filter((c) => c.status === 'failed').map(failedEvidence));
}

/**
 * An `external.event` while the conditions are pending, out of an event state that awaits it:
 * still taken (a human's `ui.approve` overrides the conditions). The step ends; when the event is
 * the move being checked, its target is entered, else the event is taken as usual.
 */
function conditionsOverride(
  st: Step,
  r: GateStep,
  name: string,
  data: JsonObject | undefined,
): ApplyIgnoreReason | null {
  const source = st.def.states[r.from];
  if (r.phase !== 'conditions' || source?.type !== 'event') return 'unexpected_event';
  if (!source.wait_for.includes(name)) return 'not_awaited';
  const label = st.s.workflow_state!;
  leaveStep(st, false);
  if (name !== moveName(r)) return onExternal(st, name, data);
  if (data !== undefined) {
    st.s.context = {
      ...st.s.context,
      [r.from]: { ...(st.s.context[r.from] ?? {}), event: name, ...data },
    };
  }
  passMove(st, { ...r, reason: `${name} received while the conditions were pending` }, label);
  return null;
}

/** Add the time since `state_entered_at` as if `from` were being left (10 §Wall time), then restart. */
function bankWallTime(st: Step, from: string): void {
  const s = st.s;
  const fromState = st.def.states[from];
  if (fromState !== undefined && fromState.type !== 'human' && fromState.type !== 'event') {
    const elapsed = (st.now.getTime() - Date.parse(s.state_entered_at)) / 1000;
    if (elapsed > 0) s.wall_seconds += elapsed;
  }
  s.state_entered_at = st.now.toISOString();
}

/** A check's exit: 0 → the next check (or phase); anything else is unmet with its output tail. */
function onCheckExited(
  st: Step,
  spec: GateSpec,
  r: GateStep,
  check: EntryCheck,
  e: Extract<EngineEvent, { type: 'command.exited' }>,
): void {
  // The fresh checkout's setup failed: unmet like a failed check, its output as evidence.
  if (e.setup_failed === true) {
    if (r.index === 0) r.head_sha = e.head_sha ?? null;
    stepUnmet(st, spec, r, [
      {
        item: 'Setup',
        reason: `the setup in a fresh checkout failed (${e.timed_out ? 'timed out' : e.exit_code === null ? 'killed by a signal' : `exit code ${e.exit_code}`}), so \`${check.cmd}\` did not run`,
        output: e.output_tail,
      },
    ]);
    return;
  }
  // A dirty worktree: the check did not run. Only committed changes are checked and pushed, and
  // committing is the agent's job, so it is unmet (counted), back to on_unmet.goto.
  if (e.dirty !== undefined && e.dirty.length > 0) {
    stepUnmet(st, spec, r, [
      {
        item: 'Committed work',
        reason:
          'Uncommitted changes in the worktree: commit your work; only committed changes are checked and pushed. `git status --porcelain`:',
        output: e.dirty.join('\n'),
      },
    ]);
    return;
  }
  // The first check records the commit the checks run on; later checks must see the same one.
  const head = e.head_sha ?? null;
  if (r.index === 0) {
    r.head_sha = head;
  } else if (head === null || head !== r.head_sha) {
    // A later check must run on the same, known commit (a null head is never "the same").
    stepUnmet(st, spec, r, [
      {
        item: check.name,
        reason:
          head === null
            ? 'conductor could not tell which commit this check ran on; nothing may change the branch after you finish'
            : `the branch moved while the checks ran (from ${r.head_sha ?? 'unknown'} to ${head}); nothing may change it after you finish`,
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
  action: TransitionAction,
  e: Extract<EngineEvent, { type: 'action.completed' }>,
): void {
  if (e.error !== null || e.result === null) {
    stepFail(
      st,
      spec,
      'retries_exhausted',
      `Conductor could not ${actionLabel(action)} to ${spec.goal}: ${e.error ?? 'no result'}. Retry, skip, or abort?`,
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
          `Conductor could not ${actionLabel(action)} to ${spec.goal}: it reported no valid pull request URL. Retry, skip, or abort?`,
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
  const key =
    r.kind === 'entry'
      ? entryCounterKey(r.to)
      : r.kind === 'move'
        ? moveCounter(r)
        : reviewCounterKey(r.from, r.outcome);
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
      : `Requirements to ${spec.goal} were not met after ${n} attempt${n === 1 ? '' : 's'} (retry limit ${cap}):`;
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
      : `The requirements review to ${spec.goal} produced no verdict (${why}). Retry, skip, or abort?`;
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
      reason:
        r.kind === 'transition'
          ? 'requirements review ended'
          : r.kind === 'move'
            ? 'move step ended'
            : 'entry step ended',
    });
  }
  // U-059: a started conditions phase is paused time. Its start banked the step's earlier time,
  // so restart the clock: `enter` then adds nothing for the wait.
  if (r.phase === 'conditions' && r.conditions_deadline !== null) {
    s.state_entered_at = st.now.toISOString();
  }
  s.workflow_state = r.from;
  s.step = null;
  s.agent_command_id = null;
  s.agent_process_live = false;
}

function actionLabel(action: TransitionAction): string {
  switch (action) {
    case 'open_pr':
      return 'open the pull request (open_pr)';
    case 'update_jira':
      return 'update the Jira issue (update_jira)';
    case 'slack_message':
      return 'send the Slack message (slack_message)';
  }
}

/**
 * The run_action effect (05 §Idempotency: `<session_id>:<state>:<visit>`, the step's visit). An
 * entry keys on its target; a move on its label, since two transitions may share a target.
 */
function runAction(
  st: Step,
  r: GateStep,
  action: TransitionAction,
): Extract<Effect, { type: 'run_action' }> {
  const s = st.s;
  const label = s.workflow_state!;
  const visit = s.state_visits[label] ?? 1;
  return {
    type: 'run_action',
    state: label,
    target_state: r.to,
    action,
    idempotency_key: `${s.id}:${r.kind === 'move' ? label : r.to}:${visit}`,
    args: actionArgs(st, r, action),
    expected_sha: r.head_sha,
  };
}

/** open_pr: title = the ticket title; body = the source state's summary + the ticket ref. */
function actionArgs(st: Step, r: GateStep, action: TransitionAction): JsonObject {
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
    case 'update_jira':
    case 'slack_message':
      return {};
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
  /** ADR-0011: the named transition taken (agent / human / a move step): the `state_entered` record. */
  move?: MoveRecord;
  /** U-068: no deadline in the target (a lost-machine park: parked time doesn't count). */
  noDeadline?: boolean;
}

/** The ADR-0011 fields of a `state_entered` effect: only for a named transition (else legacy shape). */
function moveFields(move: MoveRecord | undefined) {
  return move === undefined
    ? {}
    : { transition: move.transition, reason: move.reason, actor: move.actor };
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
  st.emit({
    type: 'state_entered',
    from: opts.auditFrom ?? from,
    to: target,
    visit,
    ...moveFields(opts.move),
  });

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

  st.setDeadline(target, opts.noDeadline === true ? null : deadlineFor(toState, st.now));

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
      releaseAgent(st, 'session done');
      st.setStatus('done');
      st.ticket('done');
      return;
  }
}

/**
 * BUG-1: a session that ends must not leave its live agent process behind (a parked ADR-0007
 * process waits on stdin forever). Kill exactly that start_session's process, then detach it. A
 * start not yet `started` needs no kill here: the wrapper fences a terminal session, so its late
 * `started` is stale and the gateway kills it (10-contracts §Orphaned processes rule 6).
 */
function releaseAgent(st: Step, reason: string): void {
  const s = st.s;
  if (s.machine_id !== null && s.agent_command_id !== null && s.agent_process_live) {
    st.emit({ type: 'kill', reason, target_command_id: s.agent_command_id });
  }
  s.agent_command_id = null;
  s.agent_process_live = false;
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

/**
 * → failed; kill whatever runs on the machine (`kill` false: the caller already decided, e.g. a
 * lost machine). Cancel → ticket `cancelled`, else `failed`.
 */
function failSession(st: Step, ticket: TicketStatus, reason: string, kill = true): void {
  const s = st.s;
  // The session kill (null target) covers the agent process too (BUG-1); then detach it. A lost
  // machine's caller has already decided (its `machine_lost` kill, or none for a revoked one).
  if (kill && s.machine_id !== null) st.emit({ type: 'kill', reason });
  s.agent_command_id = null;
  s.agent_process_live = false;
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
  // ADR-0011: one list for the prompt's "How to finish" and the daemon's check of the name.
  const transitions = promptTransitions(st.def, name, ticketKind(st.s));
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
          transitions,
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
    ...(transitions !== null ? { transitions } : {}),
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
