import { z } from 'zod';

// WorkflowDefinition per docs/design/05-workflow-engine.md#definition-schema.
// This is the *shape* only. The six graph rules of "Validation on save" are M1-T03
// (workflow/validate*.ts), which builds on these types.

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse a workflow duration (`"90s"`, `"30m"`, `"3d"`) into milliseconds. Throws on bad input. */
export function parseDuration(text: string): number {
  const m = DURATION_RE.exec(text);
  if (!m) throw new Error(`invalid duration "${text}" (expected <int><ms|s|m|h|d>)`);
  const n = Number(m[1]);
  const unit = m[2] as keyof typeof UNIT_MS;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid duration "${text}"`);
  return n * UNIT_MS[unit];
}

export const DurationSchema = z
  .string()
  .regex(DURATION_RE, 'expected <int><ms|s|m|h|d>, e.g. "30m"')
  .refine((s) => {
    try {
      parseDuration(s);
      return true;
    } catch {
      return false;
    }
  }, 'duration must be > 0');

export const StateNameSchema = z.string().min(1);

/**
 * What happens when a requirements review fails (ADR-0009): go back to `goto` with the reviewer's
 * unmet reasons and `instruction` attached, at most `retries` times for this transition; then
 * `else`, which must be a human state (default `needs_input`), so every failure path ends at a
 * human and the loop is bounded.
 */
/**
 * ADR-0020 §4: the unmet reasons an action reports that `on_unmet.routes` can redirect (`inspect_pr`
 * / `merge_pr` `head_moved`, `merge_pr` `conflict`). Adding one is a contract change (10-contracts).
 */
export const UnmetRouteReasonSchema = z.enum(['head_moved', 'conflict']);
export type UnmetRouteReason = z.infer<typeof UnmetRouteReasonSchema>;
export const UNMET_ROUTE_REASONS = UnmetRouteReasonSchema.options;

export const OnUnmetSchema = z.strictObject({
  goto: StateNameSchema,
  /** Plain-language instruction for the agent on the way back. */
  instruction: z.string().trim().min(1).max(4_000).optional(),
  retries: z.number().int().min(0).max(10).default(2),
  else: StateNameSchema.default('needs_input'),
  /**
   * ADR-0020 §3: an action's unmet `reason` → a different `goto` (e.g. merge_pr `head_moved` →
   * `in_qa`), bounded by the same counter. Absent ≡ every unmet reason goes to `goto`. Targets are
   * validated like `goto` (T02).
   */
  routes: z.partialRecord(UnmetRouteReasonSchema, StateNameSchema).optional(),
});
export type OnUnmet = z.infer<typeof OnUnmetSchema>;

/**
 * A requirements gate on a transition (ADR-0009). Before the session enters the target state, an
 * independent, read-only reviewer agent checks every item against the work (diff, output, context)
 * and reports met/unmet with a reason per item. All met → the transition proceeds; otherwise
 * `on_unmet`.
 */
export const RequirementsGateSchema = z.strictObject({
  /** Each requirement in plain language, e.g. "New code paths have unit tests". */
  items: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  on_unmet: OnUnmetSchema,
  /** Reviewer model; omitted = the account default. */
  model: z.string().min(1).optional(),
});
export type RequirementsGate = z.infer<typeof RequirementsGateSchema>;

/** ADR-0010: the one workflow's id. New tickets always run its latest version. */
export const CONDUCTOR_WORKFLOW_ID = 'conductor';

/** A deterministic entry check: `cmd` runs in the session worktree and must exit 0 (ADR-0010). */
export const EntryCheckSchema = z.strictObject({
  /** Shown on the board and in the "not met" feedback, e.g. "Build passes". */
  name: z.string().trim().min(1).max(200),
  cmd: z.string().min(1),
  timeout: DurationSchema.optional(),
});
export type EntryCheck = z.infer<typeof EntryCheckSchema>;

/**
 * Actions conductor itself performs while a ticket enters a column, after every check and review
 * passed (ADR-0010). `open_pr`: push the session branch and open (or reuse) a pull request, by
 * conductor, never the agent. Idempotent per session + state + visit.
 */
export const EntryActionSchema = z.enum(['open_pr']);
export type EntryAction = z.infer<typeof EntryActionSchema>;

/**
 * Requirements to enter a column/state (ADR-0010, superseding ADR-0009's per-transition gates for
 * the one workflow). Before the ticket enters the state: the `checks` run (cheap, deterministic),
 * then the reviewer judges the `review` items (ADR-0009 reviewer), then conductor performs the
 * `actions`. Everything passes → the ticket enters. A failed check or unmet item → `on_unmet`
 * (back with the output / reasons + instruction, bounded, then a human state). A failed action is
 * not the agent's fault → straight to `on_unmet.else` with the error.
 */
export const EntryRequirementsSchema = z
  .strictObject({
    checks: z.array(EntryCheckSchema).max(20).optional(),
    /**
     * (Ben, 2026-10-26) Checks run in a fresh, conductor-owned checkout of the exact commit, never
     * the agent's worktree. `setup` runs once in it before the checks (e.g. `npm ci`). Omitted =
     * auto-detect from the lockfile (M2-T30): `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`,
     * `yarn.lock` → `yarn install --immutable`, `package-lock.json` → `npm ci`, else
     * `package.json` → `npm install`, else nothing. '' = no setup. A failed setup is unmet, like a
     * failed check.
     */
    setup: z.string().max(2_000).optional(),
    review: z
      .strictObject({
        items: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
        model: z.string().min(1).optional(),
      })
      .optional(),
    actions: z.array(EntryActionSchema).max(5).optional(),
    on_unmet: OnUnmetSchema,
  })
  .refine((e) => (e.checks?.length ?? 0) + (e.review ? 1 : 0) + (e.actions?.length ?? 0) > 0, {
    message: 'entry requirements need at least one check, review or action',
  });
export type EntryRequirements = z.infer<typeof EntryRequirementsSchema>;

// ---------------------------------------------------------------- transitions (ADR-0011)

/** ADR-0011: a ticket's kind. Transitions filter on it (`kinds`); a null kind matches both (U-062). */
export const TicketKindSchema = z.enum(['work', 'personal']);
export type TicketKind = z.infer<typeof TicketKindSchema>;
export const TICKET_KINDS = TicketKindSchema.options;

/**
 * ADR-0011: who may take a transition. `agent`: the worker names it in `complete_state`. `human`:
 * a button on the card (`POST /api/sessions/:id/transition`). `system`: timeouts, command exits,
 * connector results, an event state's `wait_for` names, `budget_exceeded`. Inferred when omitted
 * (`transitionActor`).
 */
export const TransitionActorSchema = z.enum(['agent', 'human', 'system']);
export type TransitionActor = z.infer<typeof TransitionActorSchema>;

/**
 * ADR-0011 (U-061): the `goto` of a human transition that returns to the state that routed into
 * the human state (`session.return_to`), e.g. `answer`. Only valid on a human-state transition
 * (validator rule 10).
 */
export const RETURN_TO = '$return_to';

/**
 * Conductor's own actions on a move (ADR-0010 / ADR-0011). `open_pr` now; `update_jira` and
 * `slack_message` parse but the validator refuses them until M5 (rule 14).
 */
export const TransitionActionSchema = z.enum([
  'open_pr',
  'update_jira',
  'slack_message',
  /** ADR-0020 §4: read the PR's head, files and mergeability (`InspectPrArgs` / `InspectPrResult`). */
  'inspect_pr',
  /** ADR-0020 §4: merge the PR with a merge commit, pinned to `expected_sha` (`MergePrArgs`). */
  'merge_pr',
  /** ADR-0020 §4: close the PR without merging, with a reason (`ClosePrArgs`). */
  'close_pr',
]);
export type TransitionAction = z.infer<typeof TransitionActionSchema>;
/**
 * The actions conductor can run (the validator refuses the others, "not available yet"). ADR-0020's
 * three PR actions run from M2r (M2r-T02).
 */
export const AVAILABLE_TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'open_pr',
  'inspect_pr',
  'merge_pr',
  'close_pr',
];

const conditionCommon = {
  /** Default true. A disabled condition is declared but skipped (Jira / Azure until M5). */
  enabled: z.boolean().optional(),
  /** Checklist label; default `conditionLabel(c)`. */
  label: z.string().trim().min(1).max(120).optional(),
};

/**
 * ADR-0011 external conditions, evaluated on the user's machine (`run_action evaluate_conditions`)
 * and re-polled until all are met, one turns false, or `condition_timeout` passes.
 * - `pr_checks_green`: every status check on conductor's PR (`context.__pr.pr_url`) succeeded;
 * - `pr_approvals`: at least `min` approving reviews, and no "changes requested";
 * - `pr_merged`: the PR is merged;
 * - `azure_pipeline_succeeded` / `jira_fields_set`: M5 (the daemon reports them `unsupported`).
 */
export const ConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pr_checks_green'), ...conditionCommon }),
  z.strictObject({
    type: z.literal('pr_approvals'),
    min: z.number().int().min(1).max(20),
    ...conditionCommon,
  }),
  z.strictObject({ type: z.literal('pr_merged'), ...conditionCommon }),
  z.strictObject({
    type: z.literal('azure_pipeline_succeeded'),
    pipeline: z.string().trim().min(1).max(200),
    ...conditionCommon,
  }),
  z.strictObject({
    type: z.literal('jira_fields_set'),
    fields: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
    ...conditionCommon,
  }),
]);
export type Condition = z.infer<typeof ConditionSchema>;
export const ConditionTypeSchema = z.enum([
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
  'azure_pipeline_succeeded',
  'jira_fields_set',
]);
export type ConditionType = z.infer<typeof ConditionTypeSchema>;
export const CONDITION_TYPES = ConditionTypeSchema.options;
/** Condition types the daemon can evaluate in M1b (with `gh`); the rest are `unsupported`. */
export const AVAILABLE_CONDITION_TYPES: readonly ConditionType[] = [
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
];

/** `enabled` defaults to true. */
export function conditionEnabled(c: Condition): boolean {
  return c.enabled !== false;
}

/** A condition's checklist label: its `label`, else a default per type. */
export function conditionLabel(c: Condition): string {
  if (c.label !== undefined) return c.label;
  switch (c.type) {
    case 'pr_checks_green':
      return 'PR checks green';
    case 'pr_approvals':
      return c.min === 1 ? 'PR approved' : `PR approvals ≥ ${c.min}`;
    case 'pr_merged':
      return 'PR merged';
    case 'azure_pipeline_succeeded':
      return `Pipeline ${c.pipeline} succeeded`;
    case 'jira_fields_set':
      return `Jira fields set: ${c.fields.join(', ')}`;
  }
}

/** ADR-0020 §5: an approval id, also a key of `InspectPrResult.matched`. */
export const ApprovalIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'lower-case slug')
  .max(40);
/** A path glob (minimatch style, e.g. `packages/orchestrator/migrations/**`). */
export const PathGlobSchema = z.string().trim().min(1).max(200);

/**
 * ADR-0020 §5: an explicit human checkbox on a move, *active* when the PR changes a file matching
 * `paths` (or its file list was truncated). Merge stays disabled until every active one is ticked
 * (`TransitionSessionRequest.approvals`). Only on `actor: human` transitions (T02).
 */
export const ApprovalSchema = z.strictObject({
  id: ApprovalIdSchema,
  /** The checkbox label, e.g. "Approve migration". */
  label: z.string().trim().min(1).max(60),
  paths: z.array(PathGlobSchema).min(1).max(20),
  /** Extra text under the checkbox. */
  text: z.string().trim().min(1).max(500).optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** `requires.condition_poll` when omitted (ADR-0011: every 2 minutes, with backoff). */
export const DEFAULT_CONDITION_POLL = '2m';
/** The backoff cap for condition polling (M1b-T08: doubling after each unchanged result). */
export const MAX_CONDITION_POLL = '15m';

/**
 * ADR-0011: what must hold before a ticket moves along a transition, checked in order: `checks`
 * (fresh checkout of the exact commit, after `setup`), the `review` (the fenced ADR-0009 reviewer),
 * conductor's `actions`, then the external `conditions`, re-polled every `condition_poll` until
 * all are met or `condition_timeout` passes. ADR-0010 `entry` and ADR-0009 `requirements` fold
 * into this (`foldLegacyRequirements`). Graph rules (timeout and `on_unmet` present, actions
 * available…) are the validator's (rules 13–14), not the schema's.
 */
export const TransitionRequiresSchema = z.strictObject({
  checks: z.array(EntryCheckSchema).max(20).optional(),
  /** ADR-0010 semantics: omitted = auto-detect, '' = none. */
  setup: z.string().max(2_000).optional(),
  review: z
    .strictObject({
      items: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
      model: z.string().min(1).optional(),
    })
    .optional(),
  actions: z.array(TransitionActionSchema).max(5).optional(),
  conditions: z.array(ConditionSchema).min(1).max(10).optional(),
  /** How long the conditions may stay pending before `on_unmet.else` (U-063). */
  condition_timeout: DurationSchema.optional(),
  /** First poll interval; default DEFAULT_CONDITION_POLL. Tests set it lower (e.g. "1s"). */
  condition_poll: DurationSchema.optional(),
  /** ADR-0020 §5: human checkboxes, checked before the move step starts. Ids unique (T02). */
  approvals: z.array(ApprovalSchema).min(1).max(5).optional(),
});
export type TransitionRequires = z.infer<typeof TransitionRequiresSchema>;

/**
 * `"build"` or an object (05 §Retry loops; ADR-0009 `requirements`; ADR-0011 for the rest). The
 * key in `on` is the transition's name.
 */
export const TransitionObjectSchema = z.strictObject({
  /** A state name, or RETURN_TO on a human-state transition. */
  goto: StateNameSchema,
  /**
   * `output`: the source's output goes to the target's prompt (05 §Retry loops). ADR-0020
   * `result`: the target's prompt gets "## Sent back by <title>" rendered from `context.<from>`
   * (a QA result's fixes and findings).
   */
  attach: z.enum(['output', 'result']).optional(),
  retries: z.number().int().nonnegative().optional(),
  else: StateNameSchema.optional(),
  /** ADR-0009 (old versions): folded into `requires.review` + `on_unmet` on save. */
  requirements: RequirementsGateSchema.optional(),
  /** ADR-0011: button and timeline label; default `transitionTitle` (the name, humanised). */
  title: z.string().trim().min(1).max(60).optional(),
  /** ADR-0011: when to take it, in the agent's prompt ("How to finish"). */
  when: z.string().trim().min(1).max(1_000).optional(),
  actor: TransitionActorSchema.optional(),
  /** Omitted = both kinds. */
  kinds: z.array(TicketKindSchema).min(1).max(2).optional(),
  /** A transition into a human state that asks a question: the agent's `reason` is the question. */
  question: z.boolean().optional(),
  /**
   * ADR-0020: a human button's text box. `required`: the button asks for text first (e.g.
   * `request_changes`, `close_without_merging`'s reason); `optional`: it offers one. Absent =
   * today's rule (`transitionNeedsText`).
   */
  text: z.enum(['required', 'optional']).optional(),
  requires: TransitionRequiresSchema.optional(),
  /** What happens when `requires` is not met (ADR-0010 semantics, U-063 for conditions). */
  on_unmet: OnUnmetSchema.optional(),
});
export type TransitionObject = z.infer<typeof TransitionObjectSchema>;
export const TransitionSchema = z.union([StateNameSchema, TransitionObjectSchema]);
export type Transition = z.infer<typeof TransitionSchema>;

/** transition name → transition. Built-in names per state type: see 05 §State types. */
export const TransitionMapSchema = z.record(z.string().min(1), TransitionSchema);

/** Fields every state has as a board column (ADR-0010). */
const columnFields = {
  /** Column title on the board, e.g. "Implementing". Defaults to the state name. */
  title: z.string().trim().min(1).max(60).optional(),
  /** Requirements to enter this state. */
  entry: EntryRequirementsSchema.optional(),
};

const common = {
  guard: z.string().min(1).optional(),
  timeout: DurationSchema.optional(),
  on: TransitionMapSchema.optional(),
  ...columnFields,
};

export const AgentStateSchema = z
  .strictObject({
    type: z.literal('agent'),
    ...common,
    prompt: z.string().min(1).optional(),
    skill: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    /** Literal values or `$state.key` refs (05 rule 5). */
    input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Keys the agent's `complete_state` result must carry. */
    result: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    max_turns: z.number().int().positive().optional(),
    /**
     * ADR-0020 §2: `qa` runs the state as an independent QA session (fresh conversation every
     * visit, fenced, forced dontAsk, its Claude id in `context.__qa`, never the session's).
     */
    role: z.literal('qa').optional(),
    /**
     * ADR-0020 §2: run in a fresh, conductor-owned checkout of the PR head (`context.__qa.head_sha`)
     * instead of the worktree. `setup` as `requires.setup`: null or absent = auto-detect, '' = none.
     * Only on `role: 'qa'` states (T02).
     */
    checkout: z.strictObject({ setup: z.string().max(2_000).nullable().optional() }).optional(),
  })
  .refine((s) => (s.prompt === undefined) !== (s.skill === undefined), {
    message: 'agent state needs exactly one of "prompt" or "skill"',
  });

export const CommandStateSchema = z.strictObject({
  type: z.literal('command'),
  ...common,
  cmd: z.string().min(1),
  /** Relative to the session worktree. */
  cwd: z.string().min(1).optional(),
});

export const EventStateSchema = z.strictObject({
  type: z.literal('event'),
  ...common,
  wait_for: z.array(z.string().min(1)).min(1),
  park: z.boolean().optional(),
  release_machine: z.boolean().optional(),
});

export const ConnectorStateSchema = z
  .strictObject({
    type: z.literal('connector'),
    ...common,
    action: z.string().min(1).optional(),
    actions: z.array(z.string().min(1)).min(1).optional(),
    args: z.record(z.string(), z.json()).optional(),
    idempotency: z.literal('session+state+visit').optional(),
  })
  .refine((s) => (s.action === undefined) !== (s.actions === undefined), {
    message: 'connector state needs exactly one of "action" or "actions"',
  });

export const HumanStateSchema = z.strictObject({
  type: z.literal('human'),
  ...common,
});

export const TerminalStateSchema = z.strictObject({
  type: z.literal('terminal'),
  ...columnFields,
});

export const StateSchema = z.discriminatedUnion('type', [
  AgentStateSchema,
  CommandStateSchema,
  EventStateSchema,
  ConnectorStateSchema,
  HumanStateSchema,
  TerminalStateSchema,
]);
export type WorkflowState = z.infer<typeof StateSchema>;
export type StateType = WorkflowState['type'];
export type AgentState = z.infer<typeof AgentStateSchema>;
export type CommandState = z.infer<typeof CommandStateSchema>;
export type EventState = z.infer<typeof EventStateSchema>;
export type ConnectorState = z.infer<typeof ConnectorStateSchema>;
export type HumanState = z.infer<typeof HumanStateSchema>;
export type TerminalState = z.infer<typeof TerminalStateSchema>;

/**
 * Session context keys conductor writes itself (`session.context.<key>`): never a state name
 * (validator rule 8), never an agent's result. ADR-0020 adds `__qa` (QA_CONTEXT_KEY). Literals here
 * (not imported from engine/) to keep workflow/ free of engine imports; `schema.m2r.test.ts` holds
 * them equal to the `*_CONTEXT_KEY` constants.
 */
export const RESERVED_CONTEXT_KEYS = [
  '__review',
  '__entry',
  '__pr',
  '__machine_lost',
  '__working_copy',
  '__qa',
] as const;
export type ReservedContextKey = (typeof RESERVED_CONTEXT_KEYS)[number];

export const BudgetSchema = z.strictObject({
  usd: z.number().positive(),
  minutes: z.number().positive(),
  max_loop_retries: z.number().int().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const WorkflowDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case id'),
  version: z.number().int().positive(),
  start: StateNameSchema,
  budget: BudgetSchema,
  /** State to route to on `budget.exceeded`. Default `needs_input` (05, 09). */
  on_budget_exceeded: StateNameSchema.default('needs_input'),
  states: z.record(StateNameSchema, StateSchema),
  /**
   * ADR-0010: the board's columns, left to right, as state names. Every state is a column in the
   * one workflow; the board also shows an implicit "Queued" column first (sessions no machine has
   * claimed). Required for `CONDUCTOR_WORKFLOW_ID`; older workflows omit it.
   */
  columns: z.array(StateNameSchema).min(1).optional(),
});
/** A parsed definition (defaults applied). */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
/** The JSON as stored / authored (defaults optional). */
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;
