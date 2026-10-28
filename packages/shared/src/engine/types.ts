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
import {
  ApprovalIdSchema,
  ConditionTypeSchema,
  TicketKindSchema,
  TransitionActorSchema,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { AgentTransitionOptionSchema } from '../workflow/transition-rules.js';
import { GitShaSchema, PR_FILES_MAX, PrFilePathSchema, PrUrlSchema } from '../protocol/actions.js';

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
  /**
   * ADR-0011: `ticket.kind`; filters transitions (`kinds`). null = matches both (U-062). Optional
   * so snapshots built before M1b still parse; absent ≡ null.
   */
  kind: TicketKindSchema.nullable().optional(),
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
 * ADR-0011: the live status of one external condition of a move step (`GateStep.conditions`).
 * - `todo`: not evaluated yet; `running`: an evaluation is in flight;
 * - `met` / `pending` / `failed`: the daemon's last answer (`EvaluateConditionsResult`);
 * - `disabled`: declared with `enabled: false` (skipped, never evaluated);
 * - `unsupported`: the machine can't evaluate it (M5 types); counts as pending.
 */
export const ConditionStatusValueSchema = z.enum([
  'todo',
  'running',
  'met',
  'pending',
  'failed',
  'disabled',
  'unsupported',
]);
export type ConditionStatusValue = z.infer<typeof ConditionStatusValueSchema>;

export const ConditionStatusSchema = z.object({
  type: ConditionTypeSchema,
  /** `conditionLabel(condition)` at the time the step started. */
  label: z.string(),
  status: ConditionStatusValueSchema,
  /** The last observed value, e.g. `"1/2"` approvals; null before the first answer. */
  value: z.string().nullable(),
  /** Evidence for the human (a failing check's name, "gh not available: …"); null if none. */
  detail: z.string().nullable(),
  checked_at: IsoDateTimeSchema.nullable(),
});
export type ConditionStatus = z.infer<typeof ConditionStatusSchema>;

/**
 * A gate step (`session.step`): the session is checking whether it may enter a state.
 * - `kind: 'transition'`: ADR-0009, a requirements review on a gated transition (old versions).
 * - `kind: 'entry'`: ADR-0010, the requirements to enter a column (`states.<to>.entry`): checks,
 *   then the review, then conductor's actions, one `phase` at a time (old versions).
 * - `kind: 'move'`: ADR-0011, the `requires` of the transition `transition` out of `from`:
 *   checks → review → actions → conditions. Label `moveStateLabel(from, to, transition)`, counter
 *   `moveCounterKey(from, transition)`. In `conditions` the session is `waiting_external`
 *   (U-059: worker ended, no wall time) and `conditions` holds the live checklist.
 * While it is set, `workflow_state` is a synthetic label (`reviewStateLabel` / `entryStateLabel` /
 * `moveStateLabel`) that names no workflow state: the timeout sweep keys on it, and events meant
 * for a real state are ignored. The board shows the card in its source column (`from`) with a
 * `checking` badge and `pending` checklist.
 * Persisted inside the `session.context` jsonb under STEP_CONTEXT_KEY (no migration; the legacy
 * ADR-0009 key REVIEW_CONTEXT_KEY is still read); `toSnapshot` lifts it out. Every field added
 * after M1 has a default, so older rows parse.
 */
export const GateStepSchema = z.object({
  /** Legacy `__review` rows have no kind: they are ADR-0009 transition reviews. */
  kind: z.enum(['transition', 'entry', 'move']).default('transition'),
  /** The state whose outcome selected the target (the card's column while checking). */
  from: z.string(),
  /** The outcome / transition name that selected the target. */
  outcome: z.string(),
  /** The state entered when every requirement is met (`RETURN_TO` already resolved). */
  to: z.string(),
  /** `attach: output` text for `to` (a counted object transition's goto leg), or null. */
  attachment: z.object({ from: z.string(), detail: z.string(), output: z.string() }).nullable(),
  /** What the source state reported (complete_state result / command output tail), for the prompt. */
  subject: z.string(),
  /** The reviewer's own Claude session (never the worker's `claude_session_id`). */
  claude_session_id: z.string().nullable(),
  /** The engine already nudged the reviewer once about a missing or malformed verdict. */
  nudged: z.boolean(),
  /** The phase running now (a transition review is always `review`). */
  phase: z.enum(['checks', 'review', 'actions', 'conditions']).default('review'),
  /** ADR-0010: index of the check (phase `checks`) or action (phase `actions`) running now. */
  index: z.number().int().nonnegative().default(0),
  /**
   * ADR-0010: the worktree `HEAD` the checks ran on (reported with the first check's exit). The
   * review is told this commit and open_pr pushes exactly it. null before the first check.
   */
  head_sha: z.string().nullable().default(null),
  /** ADR-0011 (`kind: 'move'`): the transition's name (= `outcome`); null for older kinds. */
  transition: z.string().nullable().default(null),
  /** ADR-0011 (`kind: 'move'`): who took it, for the `state_entered` record. */
  actor: TransitionActorSchema.nullable().default(null),
  /** ADR-0011 (`kind: 'move'`): the agent's / human's reason, for the `state_entered` record. */
  reason: z.string().nullable().default(null),
  /**
   * ADR-0011: one status per declared condition, in declaration order (disabled ones included as
   * `disabled`). Empty until the conditions phase starts.
   */
  conditions: z.array(ConditionStatusSchema).default([]),
  /** ADR-0011: when `condition_timeout` passes (→ `on_unmet.else`, U-063); null outside it. */
  conditions_deadline: IsoDateTimeSchema.nullable().default(null),
  /**
   * ADR-0011: the current poll interval in ms (starts at `condition_poll`, doubles after an
   * unchanged result, capped at MAX_CONDITION_POLL). null outside the conditions phase.
   */
  conditions_poll_ms: z.number().int().positive().nullable().default(null),
  /**
   * ADR-0011 (U-058): a note for the checklist, e.g. CONDITIONS_NO_MACHINE_NOTE while the
   * evaluation was refused or timed out. null when there is nothing to say.
   */
  conditions_note: z.string().nullable().default(null),
  /**
   * ADR-0020 §5 (M2r-T04): the approvals the human gave for this move, for the audit and
   * `merge_pr.approved_paths`: who ticked them, the active approval ids, and each one's matched
   * files. null when none; defaults to null, so older rows parse.
   */
  approvals: z
    .object({
      who: z.string().min(1).max(200),
      ids: z.array(ApprovalIdSchema).max(5),
      files: z.record(ApprovalIdSchema, z.array(PrFilePathSchema).max(PR_FILES_MAX)),
    })
    .nullable()
    .default(null),
});
export type GateStep = z.infer<typeof GateStepSchema>;
/** ADR-0009 name of GateStepSchema. */
export const ReviewStepSchema = GateStepSchema;
export type ReviewStep = GateStep;

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
  /**
   * The worker's Claude conversation; every agent start_session resumes it when set. Its
   * transcript lives only on the machine that ran it: a start refused `no_conversation`
   * (NO_CONVERSATION_REASON, the claiming machine doesn't have it) sets it back to null, so the
   * re-claim starts a fresh conversation (10-contracts §Refusals).
   */
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
   * answer) instead of send_input (10-contracts §Resume). A refused start_session (any reason,
   * `no_conversation` included) leaves it false.
   */
  agent_process_live: z.boolean(),
  /**
   * The human answer apply has accepted but the agent has not started running on yet (10-contracts
   * §Pending answer). `input.provided` stores it; every start_session apply emits while it is set
   * (the `no_live_process` re-answer, the exit-while-parked resume, and the `session.assigned`
   * re-emit after a requeue) uses `answer` as its `prompt` with `resume_claude_session_id`. Kept
   * through a `no_conversation` refusal: with `claude_session_id` then null, the re-claim renders
   * the full state prompt with the answer in it instead.
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
  /** The gate step in progress (ADR-0009 review / ADR-0010 entry), or null. See GateStepSchema. */
  step: GateStepSchema.nullable(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

// ---------------------------------------------------------------- events

/** Why a machine was lost (`machine.lost.reason`, U-068; see the lost machines section). */
export const MACHINE_LOST_REASONS = ['lease_expired', 'revoked', 'pinned_machine_offline'] as const;
export const MachineLostReasonSchema = z.enum(MACHINE_LOST_REASONS);
export type MachineLostReason = z.infer<typeof MachineLostReasonSchema>;

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
  /**
   * D `claude_session_id`. While a review step runs (ADR-0009) it is the reviewer's and goes to
   * `review.claude_session_id`; `claude_session_id` stays the worker's.
   */
  z.object({ type: z.literal('agent.claude_session_id'), claude_session_id: z.string() }),
  /**
   * D `complete_state`: the agent takes transition `transition` (ADR-0011) with `reason`. A null or
   * absent `transition` means `done` (old prompts). The name must be an agent-actor transition
   * of the current state matching the ticket's kind, else apply routes to needs_input
   * (`agent_question`, `unknownTransitionQuestion(name)`, the U-028 path). The state's guard runs
   * first (failed guard → `fail`). While a review step runs it is the reviewer's verdict
   * (ADR-0009, apply.ts §Requirements review) and `transition` is ignored.
   */
  z.object({
    type: z.literal('agent.complete_state'),
    result: JsonObjectSchema,
    /** ADR-0011. Absent ≡ null ≡ `done`. */
    transition: z.string().nullable().optional(),
    /** ADR-0011: why; the question for a `question: true` transition. Absent ≡ null. */
    reason: z.string().nullable().optional(),
  }),
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
   * `fail`; while parked (`needs_input`) it only clears agent_process_live. `stderr_tail` (the
   * daemon's last stderr lines, optional): its last non-empty line goes into the failure question.
   */
  z.object({
    type: z.literal('agent.exited'),
    command_id: UuidSchema,
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    stderr_tail: z.string().optional(),
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
    /** ADR-0010: the worktree `HEAD` when the command started (null/absent = unknown). */
    head_sha: z.string().nullable().optional(),
    /**
     * ADR-0010: a `require_clean` command found uncommitted changes and did not run: the
     * `git status --porcelain` lines.
     */
    dirty: z.array(z.string()).optional(),
    /** ADR-0010: the fresh checkout's setup command failed (the check did not run). */
    setup_failed: z.boolean().optional(),
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
  /**
   * D `action_result` (ADR-0010): conductor finished an entry action (`run_action`), e.g. open_pr.
   * `result` (e.g. `{pr_url}`) on success, `error` (a sentence for the human) on failure. Accepted
   * only in an entry step's `actions` phase for that action; a failure goes to `on_unmet.else`.
   */
  z.object({
    type: z.literal('action.completed'),
    command_id: UuidSchema,
    action: z.string(),
    result: JsonObjectSchema.nullable(),
    error: z.string().nullable(),
  }),
  /**
   * U: a human takes transition `name` (ADR-0011; POST /api/sessions/:id/transition, actor =
   * who, e.g. `ui`). Accepted from a human state (`needs_input`), or from an event state for an
   * `actor: human` transition; ignored `wrong_status` elsewhere (incl. during a gate step), and
   * `unknown_transition` / `transition_not_allowed` for a name that isn't a human-actor
   * transition of the state for the ticket's kind. `RETURN_TO` resolves to `return_to`. `text`
   * is delivered like an answer when the target is the asking agent state (pending answer), and
   * is the move's reason otherwise. The wrapper closes the open input_request (answer = `text`
   * ?? `"[<name>]"`, answered_by = `actor`). `requires` on the transition runs as a move step.
   */
  z.object({
    type: z.literal('human.transition'),
    name: z.string().min(1),
    text: z.string().nullable(),
    actor: z.string().min(1),
    /**
     * The open input_request this move answers (the route fills it; null/absent when none).
     * apply uses it like `input.provided`'s: a RETURN_TO move into the asking agent whose
     * process is still parked live answers with `send_input {input_request_id}`.
     */
    input_request_id: UuidSchema.nullable().optional(),
    /**
     * ADR-0020 §5: the approval ids the human ticked (`TransitionSessionRequest.approvals`).
     * Absent ≡ []. A transition with an active approval not listed here is ignored
     * `approval_required` (M2r-T04).
     */
    approvals: z.array(ApprovalIdSchema).max(5).optional(),
  }),
  /**
   * O (M2-T20): the session's machine is gone (U-068). Full semantics: 10-contracts §Machines
   * protocol v2, Lost machines (M2-T06 implements them in apply). Sources: the reaper on a lease
   * past its expiry plus the 2-minute grace (`lease_expired`); `revokeMachine`'s caller
   * (`revoked`); the reaper for a pinned queued session whose machine has been offline for
   * `offline_ms` (`pinned_machine_offline`, TD-088). apply is pure and trusts the event: the pin
   * check is the reaper's SQL, and the snapshot has no pin field. `machine_name` is the display
   * name for the question (absent → `machine_id`).
   */
  z.object({
    type: z.literal('machine.lost'),
    machine_id: z.string().min(1),
    reason: MachineLostReasonSchema,
    machine_name: z.string().min(1).optional(),
    /**
     * `pinned_machine_offline` only: how long the machine has been offline (the reaper's
     * threshold, PINNED_MACHINE_OFFLINE_AFTER_MS unless CONDUCTOR_PIN_OFFLINE_MS overrides it).
     */
    offline_ms: z.number().int().positive().optional(),
  }),
  /**
   * U: operator cancel (POST /cancel). → failed, kill (null target: everything the session runs,
   * a parked agent process included; BUG-1), agent_command_id = null, agent_process_live = false.
   */
  z.object({ type: z.literal('operator.cancel'), reason: z.string().optional() }),
  /**
   * U: a human's message to the running agent (POST /messages, ADR-0007). Accepted only while
   * `running` an `agent` state with `agent_process_live`; otherwise ignored (`wrong_status`),
   * including during a requirements review (ADR-0009: the reviewer judges on its own). Accepted → one `send_message` effect and nothing else: no state change, no transition
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
    /**
     * ADR-0009: a requirements reviewer, not the worker. Always a fresh Claude session (or a
     * resume of the reviewer's own); the daemon keeps the worker's conversation as the session's
     * transcript.
     */
    review: z.literal(true).optional(),
    /**
     * ADR-0011: the agent transitions it may name (`agentTransitionOptions(def, state, kind)`),
     * the same list as the prompt's "How to finish". Absent or empty = any name (old versions,
     * reviewers).
     */
    transitions: z.array(AgentTransitionOptionSchema).optional(),
    /**
     * ADR-0020 §2: a `role: 'qa'` start runs in a fresh checkout of the PR head (WS
     * `start_session.checkout`). M2r-T03 sets it; `commandPayloadForEffect` copies it then.
     */
    checkout: z
      .object({ sha: GitShaSchema, pr_url: PrUrlSchema, setup: z.string().max(2_000).nullable() })
      .optional(),
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
    /**
     * ADR-0010 entry checks: run only on a clean worktree (only committed changes are checked
     * and pushed). A dirty tree is reported as `command.exited.dirty`, and the command doesn't run.
     */
    require_clean: z.literal(true).optional(),
    /**
     * ADR-0010 (Ben, 2026-10-26): run in a fresh, conductor-owned checkout of one commit, never
     * the agent's worktree. `sha` null = the worktree's clean HEAD (the first check); `setup` null
     * = auto-detect (`package-lock.json` → `npm ci`, `package.json` → `npm install`), '' = none;
     * runs once per checkout. `last`: the daemon deletes the checkout after this check (it also
     * does on any failure).
     */
    checkout: z
      .object({ sha: z.string().nullable(), setup: z.string().nullable(), last: z.boolean() })
      .optional(),
  }),
  /**
   * outbox `kill` → WS kill with `target_command_id: null` (every process of the session at or
   * below the envelope fencing token, i.e. the row's token; 10-contracts §Effect → WS).
   */
  z.object({
    type: z.literal('kill'),
    reason: z.string(),
    /**
     * ADR-0010: kill only this start_session's process (the worker, when a gate step starts; the
     * outstanding agent process when the session enters a terminal state, BUG-1).
     */
    target_command_id: UuidSchema.optional(),
  }),
  /**
   * outbox `run_action` → WS run_action (ADR-0010): conductor performs an entry action on the
   * session's machine (open_pr: push the branch, open or reuse the PR). `idempotency_key` =
   * `<session_id>:<to>:<visit>` (05 §Idempotency); the daemon reuses the PR on a repeat.
   */
  z.object({
    type: z.literal('run_action'),
    /** The entry step's label (the session's `workflow_state`). */
    state: z.string(),
    /** The state being entered. */
    target_state: z.string(),
    action: z.string(),
    idempotency_key: z.string(),
    /** Action arguments, e.g. open_pr `{title, body}`. */
    args: JsonObjectSchema,
    /**
     * The commit the checks ran on (`step.head_sha`): open_pr pushes exactly it and refuses when
     * the branch tip differs. null only for an entry without checks.
     */
    expected_sha: z.string().nullable(),
  }),
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
  /**
   * Internal: event row `state.entered` (audit; the detail panel's `moves`). Payload:
   * StateEnteredPayloadSchema.
   */
  z.object({
    type: z.literal('state_entered'),
    from: z.string().nullable(),
    to: z.string(),
    visit: z.number().int().positive(),
    /** ADR-0011: the transition taken (its name), null for a start / requeue / legacy route. */
    transition: z.string().nullable().optional(),
    /** ADR-0011: the agent's or human's reason, or the system's (e.g. "timed out"). */
    reason: z.string().nullable().optional(),
    actor: TransitionActorSchema.nullable().optional(),
  }),
  /**
   * Internal: event row `conversation.reset` (audit). A start_session was refused
   * `no_conversation`: the Claude conversation `claude_session_id` is not on the claiming
   * machine, so it was forgotten and the next start is a fresh conversation. Payload:
   * ConversationResetPayloadSchema.
   */
  z.object({
    type: z.literal('conversation_reset'),
    claude_session_id: z.string(),
    reason: z.literal('not_on_machine'),
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

/** The `conversation.reset` event row's payload (the `conversation_reset` effect). */
export const ConversationResetPayloadSchema = z.object({
  claude_session_id: z.string(),
  reason: z.literal('not_on_machine'),
});
export type ConversationResetPayload = z.infer<typeof ConversationResetPayloadSchema>;
export type EffectType = Effect['type'];
export type OutboxEffect = Extract<
  Effect,
  {
    type:
      | 'start_session'
      | 'send_input'
      | 'send_message'
      | 'run_cmd'
      | 'run_action'
      | 'kill'
      | 'connector_call';
  }
>;

export const OUTBOX_EFFECT_TYPES = [
  'start_session',
  'send_input',
  'send_message',
  'run_cmd',
  'run_action',
  'kill',
  'connector_call',
] as const satisfies readonly OutboxEffect['type'][];

export function isOutboxEffect(e: Effect): e is OutboxEffect {
  return (OUTBOX_EFFECT_TYPES as readonly string[]).includes(e.type);
}

// ---------------------------------------------------------------- moves (ADR-0011)

/** `retry_counters` key of a move step's `on_unmet` loop: `"move:<from>:<name>"`. */
export function moveCounterKey(from: string, name: string): string {
  return `move:${from}:${name}`;
}

/** The synthetic `workflow_state` of a move step, e.g. `implementing → waiting_external (move: ready_for_testing)`. */
export function moveStateLabel(from: string, to: string, name: string): string {
  return `${from} → ${to} (move: ${name})`;
}

/**
 * `run_action evaluate_conditions`'s `idempotency_key` (informational: the action is read-only
 * and the daemon does not dedupe on it): `<session>:<step label>:<now ISO>` of the apply that
 * emitted it.
 */
export function conditionsIdempotencyKey(sessionId: string, label: string, now: Date): string {
  return `${sessionId}:${label}:${now.toISOString()}`;
}

/** The needs_input question when an agent names a transition it may not take (ADR-0011). */
export function unknownTransitionQuestion(name: string): string {
  return `The agent named an unknown transition '${name}'.`;
}

// ---------------------------------------------------------------- lost machines (U-068, M2-T02)

/**
 * The `input_request.kind` of a lost-machine question. In InputRequestKindSchema, the DB enum and
 * the web label since M2-T03; T06 emits it.
 */
export const MACHINE_LOST_KIND = 'machine_lost' as const;

/** The `kill.reason` of the fenced kill sent to a lost machine's old worker. */
export const MACHINE_LOST_KILL_REASON = 'machine_lost';

/**
 * How long a pinned queued session waits for its offline machine before a human is asked
 * (TD-088, M2-T20): 15 minutes. T20 reads the override from PIN_OFFLINE_ENV.
 */
export const PINNED_MACHINE_OFFLINE_AFTER_MS = 900_000;
export const PIN_OFFLINE_ENV = 'CONDUCTOR_PIN_OFFLINE_MS';

/** `900000` → `15 minutes`, `3600000` → `1 hour`, `90000` → `2 minutes` (rounded, at least 1). */
export function formatOfflineDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The needs_input question for a lost machine. `name` is the display name (or the id);
 * `offlineMs` is the event's `offline_ms` (pinned_machine_offline only).
 */
export function machineLostQuestion(
  name: string,
  reason: MachineLostReason,
  offlineMs: number = PINNED_MACHINE_OFFLINE_AFTER_MS,
): string {
  switch (reason) {
    case 'lease_expired':
      return `${name} stopped responding`;
    case 'revoked':
      return `${name} was revoked`;
    case 'pinned_machine_offline':
      return `${name} has been offline for ${formatOfflineDuration(offlineMs)}`;
  }
}

/**
 * Whether the human may continue on the lost machine: not for `revoked` (Cancel only, R4: the
 * machine can never come back).
 */
export function machineLostCanContinue(reason: MachineLostReason): boolean {
  return reason !== 'revoked';
}

/**
 * The card title of the `$return_to` transition while a MACHINE_LOST_KIND request is open and
 * `machineLostCanContinue(mark.reason)`.
 */
export function machineLostContinueTitle(name: string): string {
  return `Continue on ${name}`;
}

/**
 * `session.context` key of the lost-machine mark (like STEP_CONTEXT_KEY: no migration). Set by
 * apply on `machine.lost`, kept through the requeue that "Continue" causes, cleared on the next
 * matching `session.started`. The claim (M2-T16) offers a queued session carrying it only to
 * `machine_id` (a hard filter, like the ADR-0008 reopen pin). apply reads only `reason` (to refuse
 * transitions after a revoke); it never checks a pin.
 */
export const MACHINE_LOST_CONTEXT_KEY = '__machine_lost';

export const MachineLostMarkSchema = z.object({
  machine_id: z.string().min(1),
  machine_name: z.string().min(1),
  reason: MachineLostReasonSchema,
  /** The workflow state the session was in (the step's `from`); null for a never-started one. */
  state: z.string().nullable(),
  at: IsoDateTimeSchema,
});
export type MachineLostMark = z.infer<typeof MachineLostMarkSchema>;

/** `GateStep.conditions_note` while no machine could evaluate the conditions (U-058). */
export const CONDITIONS_NO_MACHINE_NOTE = 'waiting for a machine to check conditions';

/**
 * The `event` row payload of a `state.entered` row (written by the wrapper from the
 * `state_entered` effect). Rows written before M1b have only `from`, `to`, `visit`.
 */
export const StateEnteredPayloadSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  visit: z.number().int().positive(),
  transition: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  actor: TransitionActorSchema.nullable().optional(),
});
export type StateEnteredPayload = z.infer<typeof StateEnteredPayloadSchema>;

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
  /**
   * ADR-0011: `human.transition` names no transition of the current state (→ 409). An agent's
   * unknown name is NOT ignored: apply routes it to needs_input (`agent_question`, the U-028
   * path, question `unknownTransitionQuestion(name)`), because ignoring would change nothing.
   */
  'unknown_transition',
  /**
   * ADR-0011: `human.transition` names a transition that isn't human-actor, or doesn't match the
   * ticket's kind (→ 409). An agent's disallowed name is routed like an unknown one.
   */
  'transition_not_allowed',
  /**
   * M2: `machine.lost` `lease_expired` / `revoked` for a machine that is not `snapshot.machine_id`
   * (a `pinned_machine_offline` is trusted: the pin check is the reaper's SQL).
   */
  'machine_mismatch',
  /**
   * ADR-0020 §5: `human.transition` for a move with an active approval (its globs match a file
   * of `context.__pr.inspect`, or the file list was truncated) that isn't in `approvals` (→ 409
   * `approval_required` with the approvals and their files; nothing changes).
   */
  'approval_required',
  /**
   * ADR-0020 §6: `human.transition` into a terminal state of a merge-aware definition while the
   * PR is open, other than through `merge_pr` / `close_pr` (→ 409 `pr_open`). An agent's is
   * routed to needs_input instead (M2r-T04).
   */
  'pr_open',
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
