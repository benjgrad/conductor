import { z } from 'zod';

// @conductor/shared: the frozen cross-package contracts (M1-T12). Index: docs/design/10-contracts.md.
export * from './domain.js';
export * from './workflow/schema.js';
export * from './workflow/conductor.js';
export * from './workflow/routine.js';
export * from './schedule/cron.js';
export * from './workflow/guards.js';
export * from './workflow/tools.js';
export * from './workflow/mcp.js';
export * from './workflow/validate.js';
export * from './workflow/transition-rules.js';
export * from './workflow/instructions.js';
export * from './workflow/bases.js';
export * from './workflow/validate-bases.js';
export * from './workflow/validate-answerer.js';
export * from './workflow/fold.js';
export * from './workflow/fixtures.js';
export * from './workflow/capabilities.js';
export * from './workflow/screenshots.js';
export * from './workflow/editable.js';
export * from './workflow/repo-checks.js';
export * from './workflow/approvals-guard.js';
export * from './engine/types.js';
export {
  apply,
  deadlineFor,
  fallbackHumanState,
  NO_OUTCOME_QUESTION,
  IMPLEMENT_TEMPLATE,
  PLAN_TEMPLATE,
  PROMPT_TEMPLATES,
  renderPrompt,
  TICKET_TEMPLATE,
  type PromptAttachment,
  type RenderPromptInput,
} from './engine/apply.js';
export * from './engine/review.js';
export * from './engine/setup-failure.js';
export * from './engine/notify.js';
export * from './engine/watch.js';
export { applyRepoChecks, moveSpecOf, PIN_CHECK, type GateSpec } from './engine/move-step.js';
export * from './engine/concurrency.js';
export * from './engine/spend.js';
export * from './engine/qa.types.js';
export * from './engine/fixtures.js';
export * from './protocol/ws.js';
export * from './protocol/question-options.js';
export * from './protocol/actions.js';
export * from './protocol/commands.js';
export * from './protocol/outcome.js';
export * from './protocol/fixtures.js';
export * from './machines/index.js';
export * from './api/rest.js';
export * from './api/proposals.js';
export * from './api/pages.js';
export * from './api/planned-files.js';
export * from './api/plan-base.js';
export * from './api/base-label.js';
export * from './api/attachments.js';
export * from './api/schedules.js';
export * from './api/repo-rank.js';
export * from './api/queue-order.js';
export * from './api/accounts.js';
export * from './api/sse.js';
export * from './api/plan.js';
export * from './api/fixtures.js';
export * from './agents/names.js';
export * from './advisor/gates.js';
export * from './advisor/metrics.js';
export * from './advisor/check-history.js';
export * from './advisor/insight.js';
export * from './advisor/diff.js';
export * from './advisor/proposal.js';
export * from './advisor/insights-api.js';

export const PACKAGE_NAME = '@conductor/shared';

// Scaffold health check (M1-T01), still used by the other packages' smoke tests.
export const HealthSchema = z.object({
  package: z.string(),
  ok: z.literal(true),
});

export type Health = z.infer<typeof HealthSchema>;

export function health(pkg: string): Health {
  return HealthSchema.parse({ package: pkg, ok: true });
}
