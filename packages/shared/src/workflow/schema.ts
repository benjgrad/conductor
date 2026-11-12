import { z } from 'zod';
import { McpPolicySchema } from './mcp.js';
import { CapabilityRequirementSchema } from '../machines/capabilities.js';

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

/** ADR-0037 P5: a key of the workflow's `instructions` map. */
export const InstructionSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case slug')
  .max(40);
/** ADR-0037 P5: an instruction field: literal text, or a `$instructions.<slug>` ref. */
export const InstructionTextSchema = z.string().trim().min(1).max(4_000);
/** The prefix of an instruction ref (`$instructions.resync_main`). */
export const INSTRUCTION_REF_PREFIX = '$instructions.';
const INSTRUCTION_REF_RE = /^\$instructions\.([a-z][a-z0-9_]*)$/;

/**
 * ADR-0037 P5: an instruction field's reference. `null` for literal text; `{slug}` for a
 * well-formed ref; `{slug: null}` for text that starts with the prefix but is not a slug ref.
 */
export function instructionRef(text: string): { slug: string | null } | null {
  if (!text.startsWith(INSTRUCTION_REF_PREFIX)) return null;
  const m = INSTRUCTION_REF_RE.exec(text);
  return { slug: m ? m[1]! : null };
}

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
  /**
   * Plain-language instruction for the agent on the way back. ADR-0037 P5: or a
   * `$instructions.<slug>` ref into the workflow's `instructions` (rule 21), resolved at the move.
   */
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

/** At most this many globs in a check's `paths` (R3). */
export const CHECK_PATHS_MAX = 50;

/**
 * R3: why `glob` can't be a check's `paths` entry, or null when it can. Globs are repo-relative
 * with forward slashes (`globToRegExp`: `**`, `*`, `?`, `{a,b}`), as git prints changed paths.
 */
export function checkPathsProblem(glob: string): string | null {
  const g = glob.trim();
  if (g === '') return 'a path glob is empty';
  if (g.length > 200) return 'a path glob is longer than 200 characters';
  if (g.includes('\0')) return `"${g}" contains a NUL character`;
  if (g.includes('\\')) return `"${g}" contains a backslash: use forward slashes, as git does`;
  if (g.startsWith('/')) return `"${g}" starts with "/": paths are relative to the repo root`;
  if (g.split('/').includes('..')) return `"${g}" contains "..": paths are inside the repo`;
  const open = g.lastIndexOf('{');
  if (open !== -1 && g.indexOf('}', open) === -1) return `"${g}" has an unclosed "{"`;
  return null;
}

/** R3: one `paths` glob of a check (`checkPathsProblem`). */
export const CheckPathGlobSchema = z
  .string()
  .trim()
  .superRefine((g, ctx) => {
    const problem = checkPathsProblem(g);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

/** A deterministic entry check: `cmd` runs in the session worktree and must exit 0 (ADR-0010). */
export const EntryCheckSchema = z.strictObject({
  /** Shown on the board and in the "not met" feedback, e.g. "Build passes". */
  name: z.string().trim().min(1).max(200),
  cmd: z.string().min(1),
  timeout: DurationSchema.optional(),
  /**
   * R3: run the check only when the branch changes a path matching one of these globs since the
   * commit it started at (the daemon records it when it creates the branch). Otherwise it is
   * skipped (with the reason) and counts as passed. Anything unknown runs it: uncertainty runs
   * more. Absent = always run.
   */
  paths: z.array(CheckPathGlobSchema).min(1).max(CHECK_PATHS_MAX).optional(),
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
 * ADR-0037 §4 (C2): a ticket's optional size. Only the planning prompt reads it (an `L` ticket is
 * split via `proposed_tickets`); nothing enforces it.
 */
export const TicketSizeSchema = z.enum(['S', 'M', 'L']);
export type TicketSize = z.infer<typeof TicketSizeSchema>;
export const TICKET_SIZES = TicketSizeSchema.options;

/**
 * ADR-0011: who may take a transition. `agent`: the worker names it in `complete_state`. `human`:
 * a button on the card (`POST /api/sessions/:id/transition`). `system`: timeouts, command exits,
 * connector results, an event state's `wait_for` names, `budget_exceeded`. Inferred when omitted
 * (`transitionActor`).
 */
export const TransitionActorSchema = z.enum(['agent', 'human', 'system']);
export type TransitionActor = z.infer<typeof TransitionActorSchema>;

/**
 * Who made a recorded move (`state_entered`, MoveDto): a transition's actor. Since ADR-0037 (P7) a
 * route conductor took on its own is recorded with actor `system` and a `cause` other than
 * `transition`; `engine` is read on rows written before that (requirements not met, a step that
 * failed, a fallback to a human, the budget, a lost machine) and no longer written. Never valid in
 * a definition (`TransitionActorSchema`).
 */
export const MoveActorSchema = z.enum(['agent', 'human', 'system', 'engine']);
export type MoveActor = z.infer<typeof MoveActorSchema>;

/**
 * ADR-0037 P7: why a session entered a state, on every `state_entered` (`MoveDto.cause`; null on
 * rows written before it). `transition`: a named transition an agent, a human or an event took;
 * `start`: the first entry into the start state; `answer_routed`: a human's answer routed the
 * session; every other value is an engine move (actor `system`, `ENGINE_CAUSES`).
 */
export const MOVE_CAUSES = [
  'transition',
  'start',
  'check_failed',
  'review_unmet',
  'action_failed',
  'condition_unmet',
  'condition_timeout',
  'watch_broken',
  'concurrency_released',
  'timeout',
  'retry',
  'retries_exhausted',
  'budget_exceeded',
  'machine_lost',
  'answer_routed',
  'fallback',
  /** ADR-0041: no human answered a question in time; conductor delivered the recommended answer. */
  'default_taken',
] as const;
export const MoveCauseSchema = z.enum(MOVE_CAUSES);
export type MoveCause = z.infer<typeof MoveCauseSchema>;

/** The causes conductor produces on its own (recorded with actor `system`). */
export const ENGINE_CAUSES: readonly MoveCause[] = MOVE_CAUSES.filter(
  (c) => c !== 'transition' && c !== 'start' && c !== 'answer_routed',
);

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

/** A path glob (minimatch style, e.g. `packages/orchestrator/migrations/**`). */
export const PathGlobSchema = z.string().trim().min(1).max(200);

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
 *   with `no_checks_after`, a PR that still reports no checks that long after the conditions
 *   started counts as met (a repo without CI, U-072); without it, no checks stays pending;
 * - `pr_approvals`: at least `min` approving reviews, and no "changes requested";
 * - `pr_merged`: the PR is merged;
 * - `pr_screenshots` (M2-T35a): the PR changes no file matching `ui_paths`, or its body carries at
 *   least `min_pairs` before/after screenshot pairs (the table `open_pr` writes, M2-T35b);
 * - `azure_pipeline_succeeded` / `jira_fields_set`: M5 (the daemon reports them `unsupported`).
 */
/**
 * ADR-0037 P3: what `pr_checks_green` does when the PR still reports no checks `after` that long.
 * `pass` is today's `no_checks_after`; `require_mergeable` is met only when GitHub says the PR is
 * mergeable. Exclusive with `no_checks_after` (rule 25).
 */
export const NoChecksPolicySchema = z.strictObject({
  policy: z.enum(['pass', 'fail', 'require_mergeable']),
  after: DurationSchema,
});
export type NoChecksPolicy = z.infer<typeof NoChecksPolicySchema>;

export const ConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pr_checks_green'),
    no_checks_after: DurationSchema.optional(),
    /** ADR-0037 P3; read both spellings through `noChecksPolicy`. */
    no_checks: NoChecksPolicySchema.optional(),
    ...conditionCommon,
  }),
  z.strictObject({
    type: z.literal('pr_approvals'),
    min: z.number().int().min(1).max(20),
    ...conditionCommon,
  }),
  z.strictObject({ type: z.literal('pr_merged'), ...conditionCommon }),
  z.strictObject({
    type: z.literal('pr_screenshots'),
    ui_paths: z.array(PathGlobSchema).min(1).max(50),
    min_pairs: z.number().int().min(1).max(20).optional(),
    ...conditionCommon,
  }),
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
  /**
   * ADR-0037 P2: met when `cmd` exits 0, in the fresh conductor-owned checkout of the PR head;
   * `needs: checkout` skips the repo setup.
   */
  z.strictObject({
    type: z.literal('cmd'),
    name: z.string().trim().min(1).max(200),
    cmd: z.string().trim().min(1),
    timeout: DurationSchema.optional(),
    needs: z.enum(['checkout', 'setup']).default('setup'),
    ...conditionCommon,
  }),
  /** ADR-0037 P2: GitHub says the PR merges (`UNKNOWN` stays pending). */
  z.strictObject({ type: z.literal('pr_mergeable'), ...conditionCommon }),
  /**
   * ADR-0037 P2: met while the stay in the current state is shorter than `max`. Engine-side,
   * only in a `watch` (rule 24).
   */
  z.strictObject({ type: z.literal('age_below'), max: DurationSchema, ...conditionCommon }),
]);
export type Condition = z.infer<typeof ConditionSchema>;
export const ConditionTypeSchema = z.enum([
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
  'pr_screenshots',
  'azure_pipeline_succeeded',
  'jira_fields_set',
  'cmd',
  'pr_mergeable',
  'age_below',
]);
export type ConditionType = z.infer<typeof ConditionTypeSchema>;
export const CONDITION_TYPES = ConditionTypeSchema.options;
/** Condition types conductor can evaluate (rule 14); the rest are `unsupported`. */
export const AVAILABLE_CONDITION_TYPES: readonly ConditionType[] = [
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
  'pr_screenshots',
  'cmd',
  'pr_mergeable',
  'age_below',
];

/**
 * ADR-0037 P2: condition types the engine evaluates itself (never sent to the daemon):
 * `age_below` is the time in the current state.
 */
export const ENGINE_CONDITION_TYPES: ReadonlySet<ConditionType> = new Set(['age_below']);
/** ADR-0037 rule 24: condition types only allowed inside a `watch`. */
export const WATCH_ONLY_CONDITION_TYPES: ReadonlySet<ConditionType> = new Set(['age_below']);
/** The types a transition's `requires.conditions` may offer (the designer's select). */
export const REQUIRES_CONDITION_TYPES: readonly ConditionType[] = AVAILABLE_CONDITION_TYPES.filter(
  (t) => !WATCH_ONLY_CONDITION_TYPES.has(t),
);

/**
 * ADR-0037: the workflow primitives that parse but are refused "not available yet" (rule 14)
 * until their ticket marks them available here. Conditions `cmd` / `pr_mergeable` / `age_below`
 * are gated by AVAILABLE_CONDITION_TYPES instead.
 * - `watch` (P1, T6, available): a state's `watch`;
 * - `no_checks` (P3, T5, available): `pr_checks_green.no_checks`;
 * - `concurrency` (P4, T7, available): `requires.concurrency`;
 * - `instructions` (P5, T8): the `instructions` map, `$instructions.<slug>` refs and `presets`;
 * - `notify_policy` (P6, T4, available): the workflow `notify` block and string transition
 *   `notify` values;
 * - `handoff` (P8, T3, available): `handoff: true`.
 * - `bases` (ADR-0039, B1 → B2): `bases`, `base_default`, `$base` / `$base_sha` substitution, and a
 *   ticket's or planning result's `base`.
 * - `answerer` (ADR-0040, R5a-2): the workflow `answerer` block.
 * - `parallel` (ADR-0042, R10): `requires.parallel` lanes of legs.
 * - `default_answer` (ADR-0041, available): a question transition's `default`.
 */
export const WORKFLOW_FEATURES = [
  'watch',
  'no_checks',
  'concurrency',
  'instructions',
  'notify_policy',
  'handoff',
  'bases',
  'answerer',
  'parallel',
  'default_answer',
] as const;
export type WorkflowFeature = (typeof WORKFLOW_FEATURES)[number];
export const AVAILABLE_WORKFLOW_FEATURES: readonly WorkflowFeature[] = [
  'watch',
  'no_checks',
  'concurrency',
  'instructions',
  'notify_policy',
  'handoff',
  'default_answer',
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
    case 'pr_screenshots':
      return 'Before/after screenshots';
    case 'azure_pipeline_succeeded':
      return `Pipeline ${c.pipeline} succeeded`;
    case 'jira_fields_set':
      return `Jira fields set: ${c.fields.join(', ')}`;
    case 'cmd':
      return c.name;
    case 'pr_mergeable':
      return 'PR mergeable';
    case 'age_below':
      return `Here less than ${c.max}`;
  }
}

/**
 * ADR-0037 P3: a `pr_checks_green` condition's no-CI policy, with the legacy spelling folded in
 * (`no_checks_after: X` reads as `{policy: 'pass', after: X}`). `undefined`: no checks stays
 * pending, as today.
 */
export function noChecksPolicy(
  c: Extract<Condition, { type: 'pr_checks_green' }>,
): NoChecksPolicy | undefined {
  if (c.no_checks !== undefined) return c.no_checks;
  if (c.no_checks_after !== undefined) return { policy: 'pass', after: c.no_checks_after };
  return undefined;
}

/** ADR-0020 §5: an approval id, also a key of `InspectPrResult.matched`. */
export const ApprovalIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'lower-case slug')
  .max(40);

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
 * ADR-0037 P4: at most `max_in_flight` tickets with the same `key` in the `scope` states; the
 * move waits (`held`, before the checks) until one leaves, or `hold_timeout` → `on_unmet.else`.
 * With `overlap: planned_files`, only sessions whose planning `files` intersect hold each other.
 * Only on agent-actor transitions (rule 20); refused until T7 (rule 14).
 */
export const ConcurrencySchema = z.strictObject({
  key: z.enum(['$repo', '$repo+$kind']),
  max_in_flight: z.number().int().min(1).max(10),
  scope: z.array(StateNameSchema).min(1).max(10),
  order: z.literal('oldest_first').default('oldest_first'),
  overlap: z.literal('planned_files').optional(),
  hold_timeout: DurationSchema,
});
export type Concurrency = z.infer<typeof ConcurrencySchema>;

/**
 * ADR-0042: what a `cmd` leg needs on the machine that runs it: an ADR-0013 capability key
 * (`cli:gh:authed`, `mcp:slack`, …) or `os:<platform>`, satisfied by the machine's `os`. Local to
 * legs on purpose: the claim's capability keys (REQUIREMENT_RE) never see `os:`, and leg needs
 * route the leg, never the ticket (`requiredCapabilitiesOf` ignores them).
 */
export const LegNeedSchema = z.union([
  z.string().regex(/^os:(windows|darwin|linux)$/, 'expected os:windows, os:darwin or os:linux'),
  CapabilityRequirementSchema,
]);
export type LegNeed = z.infer<typeof LegNeedSchema>;

/**
 * ADR-0042: one leg of `requires.parallel`.
 * - `checks`: the transition's `requires.checks` (with the ADR-0030 repo override), session machine;
 * - `review`: the transition's `requires.review` (the fenced reviewer), session machine;
 * - `cmd`: a command in a fresh checkout of the pinned commit, on any eligible machine of the
 *   account that has the repo and every `needs` key; `leg_timeout` (default 30m) bounds the wait
 *   for such a machine and the run.
 */
export const ParallelLegSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('checks') }),
  z.strictObject({ type: z.literal('review') }),
  z.strictObject({
    type: z.literal('cmd'),
    name: z.string().trim().min(1).max(200),
    cmd: z.string().min(1),
    timeout: DurationSchema.optional(),
    /** The fresh checkout's setup: omitted = auto-detect, '' = none (as `requires.setup`). */
    setup: z.string().max(2_000).optional(),
    needs: z.array(LegNeedSchema).min(1).max(5),
    leg_timeout: DurationSchema.optional(),
  }),
]);
export type ParallelLeg = z.infer<typeof ParallelLegSchema>;
/** ADR-0042: a lane's legs run one after another; the lanes of `requires.parallel` run at once. */
export const ParallelLaneSchema = z.array(ParallelLegSchema).min(1).max(5);
export type ParallelLane = z.infer<typeof ParallelLaneSchema>;

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
  /** ADR-0037 P4: the `held` phase, before `checks`. */
  concurrency: ConcurrencySchema.optional(),
  /**
   * ADR-0042: lanes that run at the same time after the commit is pinned, joined (every leg must
   * pass; the first failure cancels the rest). Refused "not available yet" (rule 14, `parallel`).
   */
  parallel: z.array(ParallelLaneSchema).min(2).max(4).optional(),
});
export type TransitionRequires = z.infer<typeof TransitionRequiresSchema>;

/**
 * ADR-0037 P6 (amended by T4): a notification mode (the workflow `notify.default`, a transition's
 * `notify`). `once`: push the first time the transition is taken on the ticket, `every`: each
 * time, `never`: silent.
 */
export const NotifyModeSchema = z.enum(['never', 'once', 'every']);
export type NotifyMode = z.infer<typeof NotifyModeSchema>;
/**
 * ADR-0037 P6: a transition's `notify`: the legacy boolean (`true` ≡ `every`, `false` ≡ `never`),
 * a mode, or `inherit` the workflow default (absent ≡ `inherit`).
 */
export const TransitionNotifySchema = z.union([
  z.boolean(),
  NotifyModeSchema,
  z.literal('inherit'),
]);
export type TransitionNotify = z.infer<typeof TransitionNotifySchema>;

/**
 * ADR-0037 P6: the workflow's notification policy. Absent = legacy mode (every input_request
 * pushes, plus `notify: true` transitions). `engine_moves`: a move conductor made on its own
 * (any cause but `transition`) is silent (`never`) or takes the mode of the transition it was
 * taken for (`inherit`). `coalesce`: one push per ticket and state per window.
 */
export const NotifyPolicySchema = z.strictObject({
  default: NotifyModeSchema,
  engine_moves: z.enum(['never', 'inherit']).default('never'),
  /** ≤ 1d (rule 23). */
  coalesce: DurationSchema.optional(),
});
export type NotifyPolicy = z.infer<typeof NotifyPolicySchema>;

/**
 * ADR-0040: question transitions conductor never answers itself, whatever `answerer.applies_to`
 * says: each needs a human's authority (a plan that reverses an ADR or spends money, a message to
 * a person) or ends the work (rule 28).
 */
export const NEVER_AUTO_ANSWERED = [
  'plan_needs_approval',
  'needs_approval_to_message',
  'impossible',
] as const;
/** ADR-0040: `answerer.timeout` when omitted. */
export const DEFAULT_ANSWERER_TIMEOUT = '10m';
/** ADR-0040: the shortest `answerer.timeout` (rule 28). */
export const MIN_ANSWERER_TIMEOUT = '1m';
/** ADR-0040: the longest `answerer.timeout` (rule 28). */
export const MAX_ANSWERER_TIMEOUT = '30m';

/**
 * ADR-0040: before an agent's question on one of `applies_to` reaches a human, a fresh read-only
 * conductor agent tries to answer it from cited sources. It delivers its answer only with a
 * confidence of at least `min_confidence` and at least one citation; otherwise (or on timeout or
 * failure) the question opens as today, with its notes. Refused "not available yet" (rule 14,
 * feature `answerer`) until the engine ticket lands.
 */
export const AnswererSchema = z.strictObject({
  /** Question transition names (`ask_user`, or a `question: true` transition): rule 28. */
  applies_to: z.array(z.string().min(1)).min(1).max(10),
  /** The answerer's model; absent = the machine's default (as `review.model`). */
  model: z.string().min(1).optional(),
  /** The lowest confidence that is delivered without asking a human. */
  min_confidence: z.enum(['medium', 'high']).default('high'),
  /** How long the answerer may run before the question goes to a human (1m–30m, rule 28). */
  timeout: DurationSchema.optional(),
});
export type Answerer = z.infer<typeof AnswererSchema>;

/** ADR-0037 P6: the `via` of a watch's `notify: escalate` (T6): it always pushes. */
export const NOTIFY_VIA_WATCH_ESCALATE = 'watch_escalate';

/**
 * ADR-0037 P6: what the policy decided for one move (`notifyDecision`): `via` the transition
 * name (or the engine cause), the mode that applied, and push or not.
 */
export const NotifyDecisionSchema = z.object({
  via: z.string(),
  mode: NotifyModeSchema,
  decision: z.enum(['push', 'silent']),
});
export type NotifyDecision = z.infer<typeof NotifyDecisionSchema>;

/** ADR-0041: the `answer` of a transition `default`: the agent's own recommended answer. */
export const RECOMMENDED = '$recommended';
/** ADR-0041: the shortest and longest `default.after` (rule 29). */
export const MIN_DEFAULT_AFTER = '1m';
export const MAX_DEFAULT_AFTER = '7d';
/**
 * ADR-0041 (FR-5): question transitions that never take a default answer, whatever the
 * definition says (rule 29): approving a plan and a message to a person stay a human's call.
 */
export const NEVER_DEFAULTED = ['plan_needs_approval', 'needs_approval_to_message'] as const;

/**
 * ADR-0041: a question that no human answers within `after` is answered with the agent's own
 * recommended answer (`result.recommended`, or the `ask_user` tool's first option), delivered to
 * `$return_to` as an answer would be. Only on an agent-actor `question: true` / `ask_user`
 * transition into a human state, without `requires` or `handoff` (rule 29).
 */
export const DefaultAnswerSchema = z.strictObject({
  after: DurationSchema,
  answer: z.literal(RECOMMENDED),
});
export type DefaultAnswer = z.infer<typeof DefaultAnswerSchema>;

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
   * ADR-0037 P8: a transition into a human state that hands the work off for review (an
   * input_request of kind `handoff`, the reason as its summary). Exclusive with `question`
   * (rule 22); refused until T3 (rule 14).
   */
  handoff: z.boolean().optional(),
  /**
   * ADR-0020: a human button's text box. `required`: the button asks for text first (e.g.
   * `request_changes`, `close_without_merging`'s reason); `optional`: it offers one. Absent =
   * today's rule (`transitionNeedsText`).
   */
  text: z.enum(['required', 'optional']).optional(),
  /**
   * ADR-0037 P5: saved instructions offered as chips that fill this human button's text box. Only
   * on a human-actor transition with `text` (rule 21).
   */
  presets: z.array(InstructionSlugSchema).min(1).max(10).optional(),
  requires: TransitionRequiresSchema.optional(),
  /**
   * Taking this transition notifies the account's users (in-tab and Web Push), once the session
   * lands in a real state through it (its `goto`, or `else` when retries run out; after any gate
   * step passes). Absent = no notification. Needs-input notifications don't depend on it.
   * ADR-0037 P6: or a mode / `inherit` under the workflow's `notify` policy (rule 23); `true`
   * reads as `every`, `false` as `never`.
   */
  notify: TransitionNotifySchema.optional(),
  /** What happens when `requires` is not met (ADR-0010 semantics, U-063 for conditions). */
  on_unmet: OnUnmetSchema.optional(),
  /** ADR-0041: answer the question with the agent's recommended answer after `after`. */
  default: DefaultAnswerSchema.optional(),
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
  /**
   * May a person edit the ticket (title, body, priority, kind) while its card is in this column?
   * Absent: only `human` states allow it (`ticketEditable`). Reading is always allowed.
   */
  ticket_editable: z.boolean().optional(),
};

const common = {
  guard: z.string().min(1).optional(),
  timeout: DurationSchema.optional(),
  on: TransitionMapSchema.optional(),
  ...columnFields,
};

/**
 * ADR-0034: may this agent state's agent propose follow-up tickets? On: its prompt gets an
 * optional "Follow-up tickets" section, and a `proposed_tickets` list in its `complete_state`
 * result (at most `max`, `PROPOSED_TICKETS_KEY`) is stored for a human to accept or dismiss one by
 * one. Never required: nothing fails when the agent proposes nothing. Absent ≡ off.
 */
export const FollowUpsSchema = z.strictObject({
  enabled: z.boolean(),
  max: z.number().int().min(1).max(10).default(3),
  /** Extra prompt text, e.g. "Only propose test or documentation debt". */
  guidance: z.string().trim().min(1).max(1_000).optional(),
});
export type FollowUps = z.infer<typeof FollowUpsSchema>;
/** The longest follow-up list an agent state may allow. */
export const FOLLOW_UPS_MAX = 10;

/**
 * ADR-0038: a `result` entry that lets the agent attach rendered pages (`PageRef`, api/pages.ts)
 * to its result as `pages: [{url, title}]`, at most `max`. Never required: an agent that attaches
 * none still completes. Host-neutral: a Conductor `/p/:id` page (the `pages` tool's
 * `publish_page`) or any other https page URL.
 */
export const PAGES_RESULT_MAX = 5;
export const PagesResultSchema = z.strictObject({
  pages: z.strictObject({ max: z.number().int().min(1).max(PAGES_RESULT_MAX) }),
});
export type PagesResult = z.infer<typeof PagesResultSchema>;
/** One entry of an agent state's `result`: a required key, or a result kind (ADR-0038). */
export const ResultEntrySchema = z.union([z.string().min(1), PagesResultSchema]);
export type ResultEntry = z.infer<typeof ResultEntrySchema>;
/** The result kinds the validator accepts (rule 14, "not available yet" otherwise). */
export const RESULT_KINDS = ['pages'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];
export const AVAILABLE_RESULT_KINDS: readonly ResultKind[] = ['pages'];

/** The required result keys of an agent state (its string `result` entries). */
export function resultKeys(state: { result?: readonly ResultEntry[] | undefined }): string[] {
  return (state.result ?? []).filter((e): e is string => typeof e === 'string');
}

/** ADR-0038: the state's `{pages: {max}}` result entry, or null. */
export function pagesSpec(state: {
  result?: readonly ResultEntry[] | undefined;
}): { max: number } | null {
  for (const e of state.result ?? []) if (typeof e !== 'string') return e.pages;
  return null;
}

export const AgentStateSchema = z
  .strictObject({
    type: z.literal('agent'),
    ...common,
    prompt: z.string().min(1).optional(),
    skill: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    /** ADR-0029: the MCP servers this state's agent gets; replaces the workflow's `mcp`. */
    mcp: McpPolicySchema.optional(),
    /** Literal values or `$state.key` refs (05 rule 5). */
    input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /**
     * Keys the agent's `complete_state` result must carry, plus at most one ADR-0038 result kind
     * (`{pages: {max}}`), which is optional for the agent.
     */
    result: z
      .array(ResultEntrySchema)
      .refine((r) => r.filter((e) => typeof e !== 'string').length <= 1, {
        message: 'result lists at most one {"pages": …} entry',
      })
      .optional(),
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
    /** ADR-0034: follow-up ticket proposals; absent ≡ off. */
    follow_ups: FollowUpsSchema.optional(),
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

/** `watch.poll` floor (ADR-0037 P1); the default is DEFAULT_CONDITION_POLL. */
export const MIN_WATCH_POLL = '30s';

/**
 * ADR-0037 P1: conditions a human or event state keeps checking while a ticket sits in it, in
 * order, stopping at the first that is not met. A `failed` one takes `on_broken`: a counted
 * system move to `goto` (then `else`, a human state), or one escalation per stay. Rule 19;
 * available since T6 (engine: apply.ts §watch).
 */
export const WatchSchema = z.strictObject({
  poll: DurationSchema.optional(),
  conditions: z.array(ConditionSchema).min(1).max(10),
  on_broken: z.union([
    z.strictObject({
      goto: StateNameSchema,
      instruction: InstructionTextSchema.optional(),
      return_to: z.union([StateNameSchema, z.literal('$self')]).optional(),
      retries: z.number().int().min(0).max(10).default(2),
      else: StateNameSchema.default('needs_input'),
    }),
    z.strictObject({ notify: z.literal('escalate') }),
  ]),
});
export type Watch = z.infer<typeof WatchSchema>;

export const EventStateSchema = z.strictObject({
  type: z.literal('event'),
  ...common,
  /** ADR-0037 P1. */
  watch: WatchSchema.optional(),
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
  /** ADR-0037 P1. */
  watch: WatchSchema.optional(),
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
  '__default',
  '__default_taken',
] as const;
export type ReservedContextKey = (typeof RESERVED_CONTEXT_KEYS)[number];

// ---------------------------------------------------------------- base refs (ADR-0039)

/** ADR-0039: a key of the workflow's `bases` map (`sprint`, `hotfix`, `master`). */
export const BaseNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'lower-case slug (a-z, 0-9, _ and -)')
  .max(40);
export type BaseName = z.infer<typeof BaseNameSchema>;

/** ADR-0039: a `{ref}` base meaning the repo's default branch (`origin/HEAD`). */
export const DEFAULT_BRANCH_REF = '$default_branch';

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
/** ADR-0039: a full 40-hex commit sha. */
export const CommitShaSchema = z.string().regex(COMMIT_SHA_RE, 'expected a 40-hex commit sha');
/** True for a full 40-hex commit sha (a base ref that is not a branch). */
export function isCommitSha(ref: string): boolean {
  return COMMIT_SHA_RE.test(ref);
}

/** A git branch name (the inventory's rule): no whitespace, no leading `-`, no `..`. */
export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (b) => !/[\s\0]/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.startsWith('$'),
    'expected a branch name',
  );

/**
 * ADR-0039: where a ticket's branch starts. `{ref}`: a branch, or `$default_branch`. `{cmd}`: a
 * command run on the claiming machine that prints one ref (a branch or a 40-hex sha) on stdout;
 * `pr_into` is the PR target when it prints a sha (without it, a sha is refused at run time).
 */
export const BaseSpecSchema = z.union([
  z.strictObject({
    ref: z.union([z.literal(DEFAULT_BRANCH_REF), GitBranchNameSchema]),
  }),
  z.strictObject({
    cmd: z.string().trim().min(1).max(2_000),
    timeout: DurationSchema.optional(),
    pr_into: GitBranchNameSchema.optional(),
  }),
]);
export type BaseSpec = z.infer<typeof BaseSpecSchema>;

/** ADR-0039: the base per ticket kind; an absent kind starts from `$default_branch`. */
export const BaseDefaultSchema = z.partialRecord(TicketKindSchema, BaseNameSchema);
export type BaseDefault = z.infer<typeof BaseDefaultSchema>;

const explicitRef = {
  ref: z.union([CommitShaSchema, GitBranchNameSchema]),
  pr_into: GitBranchNameSchema.optional(),
};
const SHA_NEEDS_PR_INTO = 'a commit sha ref needs pr_into (the branch its PR goes to)';

/**
 * ADR-0039: a ticket's own base, winning over `base_default`: a name in the workflow's `bases`,
 * or an explicit `{ref, pr_into?}` (a sha ref needs `pr_into`).
 */
export const TicketBaseSchema = z.union([
  BaseNameSchema,
  z.strictObject(explicitRef).refine((b) => !isCommitSha(b.ref) || b.pr_into !== undefined, {
    message: SHA_NEEDS_PR_INTO,
    path: ['pr_into'],
  }),
]);
export type TicketBase = z.infer<typeof TicketBaseSchema>;

/**
 * ADR-0039: the planning result's `base`, used only when the ticket has none. Exactly one of
 * `name` / `ref`; `reason` says why (e.g. "spans several Jira tickets: branch off master").
 */
export const PlanBaseSchema = z
  .strictObject({
    name: BaseNameSchema.optional(),
    ref: explicitRef.ref.optional(),
    pr_into: GitBranchNameSchema.optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .refine((b) => (b.name === undefined) !== (b.ref === undefined), {
    message: 'set exactly one of name or ref',
  })
  .refine((b) => b.ref === undefined || !isCommitSha(b.ref) || b.pr_into !== undefined, {
    message: SHA_NEEDS_PR_INTO,
    path: ['pr_into'],
  });
export type PlanBase = z.infer<typeof PlanBaseSchema>;

/**
 * ADR-0039 (FR-7): `session.base_ref`, the base resolved when the session starts (B2 fills it).
 * `name` null for an explicit ref; `sha` the commit the branch started from; `pr_into` the PR
 * target when it isn't `ref`.
 */
export const SessionBaseSchema = z.object({
  name: BaseNameSchema.nullable(),
  ref: z.string().min(1),
  sha: CommitShaSchema.nullable(),
  pr_into: z.string().min(1).nullable(),
});
export type SessionBase = z.infer<typeof SessionBaseSchema>;

/**
 * 09 §Spend tracking. `usd` / `minutes` are declared but NOT enforced (removed 2026-11-11): stored
 * workflow versions carry them, so they stay required; spend and wall time are tracked for
 * reporting only. `max_loop_retries` does bound retry loops (validator rule 4).
 */
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
  /**
   * State to route to on `budget.exceeded`. Default `needs_input` (05, 09). Legacy: nothing emits
   * the event any more; kept so stored definitions and pre-removal requests stay valid.
   */
  on_budget_exceeded: StateNameSchema.default('needs_input'),
  states: z.record(StateNameSchema, StateSchema),
  /**
   * ADR-0029: the machine owner's MCP servers the workflow's agents get. Absent = `inherit` (all of
   * them); a state's own `mcp` replaces this. Requirements reviewers and QA states never get them.
   */
  mcp: McpPolicySchema.optional(),
  /**
   * ADR-0010: the board's columns, left to right, as state names. Every state is a column in the
   * one workflow; the board also shows an implicit "Queued" column first (sessions no machine has
   * claimed). Required for `CONDUCTOR_WORKFLOW_ID`; older workflows omit it.
   */
  columns: z.array(StateNameSchema).min(1).optional(),
  /** `ticket_editable` for the implicit Queued column (no state); absent ≡ true. */
  queued_ticket_editable: z.boolean().optional(),
  /** ADR-0037 P5: saved instructions, referenced as `$instructions.<slug>` and by `presets`. */
  instructions: z.record(InstructionSlugSchema, InstructionTextSchema).optional(),
  /** ADR-0037 P6: the notification policy; absent = legacy mode. */
  notify: NotifyPolicySchema.optional(),
  /** ADR-0040: conductor tries to answer listed questions before a human is asked. */
  answerer: AnswererSchema.optional(),
  /**
   * ADR-0039: named places a ticket's branch can start from (and its PR go to). Refused "not
   * available yet" (rule 14, feature `bases`) until B2.
   */
  bases: z.record(BaseNameSchema, BaseSpecSchema).optional(),
  /** ADR-0039: the base per ticket kind (a key of `bases`, rule 26); absent → `$default_branch`. */
  base_default: BaseDefaultSchema.optional(),
});
/** A parsed definition (defaults applied). */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
/** The JSON as stored / authored (defaults optional). */
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;
