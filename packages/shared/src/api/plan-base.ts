import { PlanBaseSchema, type PlanBase } from '../workflow/schema.js';

// ADR-0039 (FR-3): a planning result may carry `base` ({name | ref, pr_into?, reason}), the base
// the planner chose (e.g. `master` for a body of work spanning several Jira tickets). It is used
// only when the ticket has no `base` of its own (B2). Like `files` (planned-files.ts), it is an
// extra result key the engine stores in `context[<state>]`; this reads it back. A value that
// doesn't parse reads as null: no choice.

/** The `complete_state` result key carrying the planner's base (never a required `result` key). */
export const PLAN_BASE_KEY = 'base';

/** The `base` of a step's result, parsed; null when absent or invalid. Never throws. */
export function planBaseOf(result: unknown): PlanBase | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const raw = (result as Record<string, unknown>)[PLAN_BASE_KEY];
  if (raw === undefined) return null;
  const parsed = PlanBaseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
