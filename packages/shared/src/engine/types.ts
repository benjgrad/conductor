import { z } from 'zod';
import {
  InputRequestKindSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  OutboxKindSchema,
  SessionStatusSchema,
  TicketStatusSchema,
  UuidSchema,
} from '../domain.js';
import type { WorkflowDefinition } from '../workflow/schema.js';

// FSM engine contract (05). `apply()` is pure: no clock (pass `now`), no ids, no I/O.
// The orchestrator's EngineService (orchestrator/src/contracts.ts) persists the result
// (event row + session row + outbox rows) in one transaction. Implementation: M1-T04.

// ---------------------------------------------------------------- snapshot

/** Read-only ticket facts the engine needs to render prompts. */
export const SnapshotTicketSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  body: z.string(),
  repo: z.string(),
  external_ref: z.string().nullable(),
});

/**
 * `session.pending_answer` (02): the answer waiting to be delivered as a start_session prompt.
 * `input_request_id` is null for a reopen message (ADR-0008): the human's text for the reopened
 * session's first start, which answers no input_request.
 */
export const PendingAnswerSchema = z.object({
  input_request_id: UuidSchema.nullable(),
  answer: z.string(),
});
export type PendingAnswer = z.infer<typeof PendingAnswerSchema>;

/**
 * The session as the engine sees it. Mirrors the `session` row (02) with DB encodings
 * removed (numbers are numbers, timestamps ISO strings), plus the ticket facts.
 */
export const SessionSnapshotSchema = z.object({
  id: UuidSchema,
  ticket: SnapshotTicketSchema,
  machine_id: z.string().nullable(),
  workflow_id: z.string(),
  workflow_version: z.number().int().positive(),
  /** null until the first `session.assigned` enters `def.start`. */
  workflow_state: z.string().nullable(),
  status: SessionStatusSchema,
  fencing_token: z.number().int().nonnegative(),
  claude_session_id: z.string().nullable(),
  /**
   * command_id of the current `start_session` (the agent process this visit owns). Written by the
   * EngineService wrapper when it allocates a start_session effect's command_id (apply never
   * assigns ids). apply ignores `session.started` / `agent.exited` whose command_id differs.
   */
  agent_command_id: UuidSchema.nullable(),
  /**
   * A live Claude process exists for `agent_command_id`. The wrapper sets it false when it
   * allocates a start_session; apply sets it true on a matching `session.started` and false on a
   * matching `agent.exited` or on `command.refused` with reason `no_live_process`. When false,
   * apply answers an `input.provided` with start_session(resume_claude_session_id, prompt =
   * answer) instead of send_input (10-contracts §Resume).
   */
  agent_process_live: z.boolean(),
  /**
   * The human answer apply has accepted but the agent has not started running on yet (10-contracts
   * §Pending answer). `input.provided` stores it; every start_session apply emits while it is set
   * (the `no_live_process` re-answer, the exit-while-parked resume, and the `session.assigned`
   * re-emit after a requeue) uses `answer` as its `prompt` with `resume_claude_session_id`.
   * Cleared when the agent is running on it: a matching `session.started`, or (live send_input
   * path, whose accepted ack is not an engine event) the agent's next `complete_state` /
   * `ask_user`; also cleared when apply enters a different state. A reopened session (ADR-0008)
   * is created with it set (`input_request_id: null`, the human's message) and `workflow_state`
   * null: its first `session.assigned` enters `def.start` delivering it.
   */
  pending_answer: PendingAnswerSchema.nullable(),
  /** `"<from>-><goto>"` → times taken (05 §Retry loops). */
  retry_counters: z.record(z.string(), z.number().int().nonnegative()),
  /** state → times entered; the `visit_n` of idempotency keys (05 §Idempotency). */
  state_visits: z.record(z.string(), z.number().int().nonnegative()),
  state_entered_at: IsoDateTimeSchema,
  /** When the current state's `timeout` fires; null if it has none. */
  state_deadline: IsoDateTimeSchema.nullable(),
  /** The state that routed into the current `human` state (05 §needs_input). */
  return_to: z.string().nullable(),
  spend_usd: z.number().nonnegative(),
  /** claude_session_id → last cumulative `total_usd` seen (ADR-0005; 02 `claude_spend_totals`). */
  claude_spend_totals: z.record(z.string(), z.number().nonnegative()),
  /**
   * Maintained by apply (10-contracts §Wall time): on every state transition it adds
   * `now - state_entered_at` for the state being left, except `human` and `event` states (parked
   * time does not count toward `budget.minutes`, 09), then resets `state_entered_at = now`.
   */
  wall_seconds: z.number().nonnegative(),
  /** state name → its `complete_state` result, e.g. `{open_pr: {pr_url}}`. */
  context: z.record(z.string(), JsonObjectSchema),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

// ---------------------------------------------------------------- events

/**
 * Engine events. `type` doubles as `event.type` in the event table (02). Sources:
 * D = daemon session_event via gateway (T11), O = orchestrator internal, U = REST (T08).
 */
export const EngineEventSchema = z.discriminatedUnion('type', [
  /**
   * O: the claim (T11) assigned the session to a machine. Accepted only from `queued`. Enters
   * `def.start` if `workflow_state` is null, else re-emits the current state's command (a
   * start_session resumes when `claude_session_id` is set; its prompt is `pending_answer.answer`
   * when set). Into an agent state → `assigned` + start_session (→ `running` on `session.started`).
   * Into a command state → straight to `running` + run_cmd: no `started` exists for run_cmd
   * (U-024).
   */
  z.object({ type: z.literal('session.assigned'), machine_id: z.string() }),
  /**
   * O: the daemon refused an outbox command (`command_ack accepted=false`). T11 emits it for every
   * refused ack, in the tx that marks the outbox row `failed`; T04's dispatcher emits it for a
   * start_session ack timeout (reason `ack_timeout`). apply routing (10-contracts §Refusals):
   * start_session → queued + ticket ready + agent_command_id = null + agent_process_live = false
   * (the wrapper also bumps fencing_token), so a process the timed-out command spawned anyway can't
   * move the session to running and its events go stale (10-contracts §Orphaned processes);
   * send_input `no_live_process` → agent_process_live = false and re-answer via
   * start_session(resume); run_cmd → outcome `fail`; kill → ignored (`kill_refused`);
   * send_message → ignored (`message_refused`, ADR-0007: best effort, never re-routes).
   * U-025: a start_session refusal is ignored (`command_id_mismatch`) unless `command_id` equals
   * `agent_command_id` AND `agent_process_live` is false (a matching `started` already arrived:
   * the process is up and only the ack was lost). The wrapper bumps fencing_token only when the
   * refusal was not ignored.
   */
  z.object({
    type: z.literal('command.refused'),
    command_id: UuidSchema,
    command_kind: OutboxKindSchema,
    reason: z.string(),
  }),
  /**
   * D `started` (emitted only for start_session, never run_cmd): worktree ready, Claude process
   * running. → running, agent_process_live = true. Ignored unless `command_id` equals
   * `agent_command_id` (null after a refused/timed-out start_session); when ignored, the gateway
   * kills that process (`kill.target_command_id` = this command_id). The wrapper (not apply) UPDATEs session.worktree_path, branch and
   * port_range (`[base, base+count)`) from it in the same transaction.
   */
  z.object({
    type: z.literal('session.started'),
    command_id: UuidSchema,
    worktree_path: z.string(),
    branch: z.string(),
    port_range: z.object({
      base: z.number().int().positive(),
      count: z.number().int().positive(),
    }),
  }),
  /** D `claude_session_id`. */
  z.object({ type: z.literal('agent.claude_session_id'), claude_session_id: z.string() }),
  /** D `complete_state`: outcome `done` (after the state's guard; failed guard → `fail`). */
  z.object({ type: z.literal('agent.complete_state'), result: JsonObjectSchema }),
  /** D `ask_user`: outcome `ask_user`, input_request kind `agent_question`. */
  z.object({ type: z.literal('agent.ask_user'), question: z.string() }),
  /**
   * D `no_outcome` (U-028, ADR-0005 addendum): two turns in a row ended without complete_state or
   * ask_user (the second one after the daemon's nudge). Routed like `agent.ask_user` (outcome
   * `ask_user`, input_request kind `agent_question`) with the question `NO_OUTCOME_QUESTION`
   * plus the last output. The process stays alive, so the answer goes back via send_input.
   */
  z.object({ type: z.literal('agent.no_outcome'), last_output: z.string() }),
  /**
   * D `exit`: the Claude process of start_session `command_id` exited. Ignored unless
   * `command_id` equals `agent_command_id` (a late exit of an earlier visit's process). Otherwise
   * agent_process_live = false; while `running` without a prior complete_state this is outcome
   * `fail`; while parked (`needs_input`) it only clears agent_process_live.
   */
  z.object({
    type: z.literal('agent.exited'),
    command_id: UuidSchema,
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  /**
   * D `cmd_exit`: exit_code 0 → `exit_0`; otherwise `fail`. `timed_out` → `timeout` if the
   * state maps it, else `fail`. `output_tail` is what `attach: output` attaches.
   */
  z.object({
    type: z.literal('command.exited'),
    command_id: UuidSchema,
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    output_tail: z.string(),
  }),
  /**
   * D `spend`: cumulative per claude_session_id (ADR-0005). apply adds only
   * max(0, total_usd - claude_spend_totals[id]) to spend_usd (see engine/spend.ts).
   */
  z.object({
    type: z.literal('spend.reported'),
    claude_session_id: z.string(),
    total_usd: z.number().nonnegative(),
  }),
  /** U: answer to the open input_request. `goto` = "skip to <state>" (06). */
  z.object({
    type: z.literal('input.provided'),
    input_request_id: UuidSchema,
    answer: z.string(),
    goto: z.string().optional(),
  }),
  /** O/U: a named external event for an `event` state's `wait_for` (e.g. `ui.approve`). */
  z.object({
    type: z.literal('external.event'),
    name: z.string().min(1),
    data: JsonObjectSchema.optional(),
  }),
  /** O: timeout sweep. Ignored unless `state` and `deadline` match the snapshot. */
  z.object({
    type: z.literal('timer.fired'),
    state: z.string(),
    deadline: IsoDateTimeSchema,
  }),
  /**
   * O: budget exceeded → `def.on_budget_exceeded`, kind `budget_exceeded`.
   * TD-015: routed by apply (T04) but nothing emits it in M1 (no enforcement trigger; 10-contracts).
   */
  z.object({
    type: z.literal('budget.exceeded'),
    dimension: z.enum(['usd', 'minutes']),
    spent: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  }),
  /** U: operator cancel (POST /cancel). → failed, kill. */
  z.object({ type: z.literal('operator.cancel'), reason: z.string().optional() }),
  /**
   * U: a human's message to the running agent (POST /messages, ADR-0007). Accepted only while
   * `running` an `agent` state with `agent_process_live`; otherwise ignored (`wrong_status`).
   * Accepted → one `send_message` effect and nothing else: no state change, no transition
   * (transitions only on outcomes). A `/...` text is passed through; Claude Code runs it as a
   * slash command.
   */
  z.object({ type: z.literal('operator.message'), text: z.string().min(1) }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;
export type EngineEventType = EngineEvent['type'];

// ---------------------------------------------------------------- effects

/**
 * Effects. The first six map 1:1 to an outbox kind (02) and, except connector_call, to the
 * same-named WS message (03). The rest are orchestrator-internal. Mapping: 10-contracts.
 * Ids (command_id, input_request_id) are assigned by the wrapper, never by apply.
 */
export const EffectSchema = z.discriminatedUnion('type', [
  /** outbox `start_session` → WS start_session to `machine:<snapshot.machine_id>`. */
  z.object({
    type: z.literal('start_session'),
    state: z.string(),
    prompt: z.string(),
    /** The state's workflow `tools` list; the daemon maps it to an ADR-0005 ToolPolicy. */
    tools: z.array(z.string()),
    /** Set → `--resume`; null → the daemon pre-assigns a new Claude session id. */
    resume_claude_session_id: z.string().nullable(),
    model: z.string().optional(),
    max_turns: z.number().int().positive().optional(),
    /** Remaining workflow budget, the driver's `--max-budget-usd` backstop. */
    max_budget_usd: z.number().nonnegative().optional(),
  }),
  /** outbox `send_input` → WS send_input (live stdin). */
  z.object({
    type: z.literal('send_input'),
    input_request_id: UuidSchema,
    text: z.string(),
  }),
  /**
   * outbox `send_message` → WS send_message (ADR-0007): a human's message written to the live
   * process's stdin, folded into its current turn. Best effort: a refusal changes nothing.
   */
  z.object({ type: z.literal('send_message'), text: z.string() }),
  /** outbox `run_cmd` → WS run_cmd. */
  z.object({
    type: z.literal('run_cmd'),
    state: z.string(),
    cmd: z.string(),
    cwd: z.string().nullable(),
    timeout_ms: z.number().int().positive().nullable(),
  }),
  /**
   * outbox `kill` → WS kill with `target_command_id: null` (every process of the session at or
   * below the envelope fencing token, i.e. the row's token; 10-contracts §Effect → WS).
   */
  z.object({ type: z.literal('kill'), reason: z.string() }),
  /** outbox `connector_call` (target `connector:<name>`). No WS message; not in M1. */
  z.object({
    type: z.literal('connector_call'),
    state: z.string(),
    actions: z.array(z.string()).min(1),
    args: JsonObjectSchema,
    idempotency_key: z.string(),
  }),
  /** Internal: INSERT input_request; SSE `input.requested`. */
  z.object({
    type: z.literal('create_input_request'),
    kind: InputRequestKindSchema,
    question: z.string(),
    return_to: z.string().nullable(),
  }),
  /** Internal: (re)arm or clear the timeout sweep for the current state. */
  z.object({
    type: z.literal('set_deadline'),
    state: z.string(),
    deadline: IsoDateTimeSchema.nullable(),
  }),
  /** Internal: event row `state.entered` (audit, detail panel). */
  z.object({
    type: z.literal('state_entered'),
    from: z.string().nullable(),
    to: z.string(),
    visit: z.number().int().positive(),
  }),
  /** Internal: event row `session.status`; SSE `session.status` (+ `card.moved` if the column changes). */
  z.object({
    type: z.literal('session_status'),
    from: SessionStatusSchema,
    to: SessionStatusSchema,
  }),
  /** Internal: UPDATE ticket.status (e.g. done/failed on terminal, ready on a refused start_session). */
  z.object({ type: z.literal('ticket_status'), to: TicketStatusSchema }),
]);
export type Effect = z.infer<typeof EffectSchema>;
export type EffectType = Effect['type'];
export type OutboxEffect = Extract<
  Effect,
  {
    type: 'start_session' | 'send_input' | 'send_message' | 'run_cmd' | 'kill' | 'connector_call';
  }
>;

export const OUTBOX_EFFECT_TYPES = [
  'start_session',
  'send_input',
  'send_message',
  'run_cmd',
  'kill',
  'connector_call',
] as const satisfies readonly OutboxEffect['type'][];

export function isOutboxEffect(e: Effect): e is OutboxEffect {
  return (OUTBOX_EFFECT_TYPES as readonly string[]).includes(e.type);
}

// ---------------------------------------------------------------- apply

/**
 * Why apply() ignored an event (TD-016: one exported list, so T04 (producer) and T11 / T08
 * (consumers) can't drift). Adding a reason is a contract change (10-contracts).
 */
export const APPLY_IGNORE_REASONS = [
  /**
   * `session.started` / `agent.exited` / start_session `command.refused` whose command_id is not
   * `agent_command_id` (or a refusal after its `started`, U-025). T11 keys the `superseded_start`
   * orphan kill on this reason for `session.started`.
   */
  'command_id_mismatch',
  /** `timer.fired` whose state/deadline no longer match the snapshot. */
  'stale_timer',
  /** The event is not valid in the session's current status (e.g. `session.assigned` unless queued). */
  'wrong_status',
  /** The event doesn't fit the current state's type (e.g. `command.exited` in an agent state). */
  'unexpected_event',
  /** `external.event` whose name is not in the current event state's `wait_for`. */
  'not_awaited',
  /** Any event for a `done` / `failed` session. */
  'session_terminal',
  /** `command.refused` for a `kill` (logged only). */
  'kill_refused',
  /**
   * `command.refused` for a `send_message` (ADR-0007): a live message is best effort and never
   * re-routes the workflow, so the refusal is logged only.
   */
  'message_refused',
] as const;
export const ApplyIgnoreReasonSchema = z.enum(APPLY_IGNORE_REASONS);
export type ApplyIgnoreReason = z.infer<typeof ApplyIgnoreReasonSchema>;

/**
 * Why the EngineService rejected an event before apply (nothing written). Lives here (not in
 * the orchestrator) so the REST error map in api/rest.ts can key on it.
 */
export const APPLY_REJECT_REASONS = [
  'unknown_session',
  'stale_fencing_token',
  'input_request_not_found',
  'input_already_answered',
  'invalid_goto',
] as const;
export const ApplyRejectReasonSchema = z.enum(APPLY_REJECT_REASONS);
export type ApplyRejectReason = z.infer<typeof ApplyRejectReasonSchema>;

export const ApplyResultSchema = z.object({
  snapshot: SessionSnapshotSchema,
  effects: z.array(EffectSchema),
  /** Non-null when the event was a no-op (stale timer, wrong status…); snapshot unchanged. */
  ignored: ApplyIgnoreReasonSchema.nullable(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export type ApplyFn = (
  def: WorkflowDefinition,
  snapshot: SessionSnapshot,
  event: EngineEvent,
  now: Date,
) => ApplyResult;

/** The pure FSM step. Stub until M1-T04 (engine/apply*.ts) replaces it. */
export const apply: ApplyFn = () => {
  throw new Error('not implemented (M1-T04)');
};
