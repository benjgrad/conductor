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

/** `"build"` or `{ goto, attach?, retries?, else? }` (05 §Retry loops). */
export const TransitionObjectSchema = z.strictObject({
  goto: StateNameSchema,
  attach: z.literal('output').optional(),
  retries: z.number().int().nonnegative().optional(),
  else: StateNameSchema.optional(),
});
export const TransitionSchema = z.union([StateNameSchema, TransitionObjectSchema]);
export type Transition = z.infer<typeof TransitionSchema>;

/** outcome name → transition. Outcome names per state type: see 05 §State types. */
export const TransitionMapSchema = z.record(z.string().min(1), TransitionSchema);

const common = {
  guard: z.string().min(1).optional(),
  timeout: DurationSchema.optional(),
  on: TransitionMapSchema.optional(),
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
});
/** A parsed definition (defaults applied). */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
/** The JSON as stored / authored (defaults optional). */
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;
