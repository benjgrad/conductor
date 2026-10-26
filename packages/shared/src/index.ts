import { z } from 'zod';

// @conductor/shared: the frozen cross-package contracts (M1-T12). Index: docs/design/10-contracts.md.
export * from './domain.js';
export * from './workflow/schema.js';
export * from './workflow/conductor.js';
export * from './workflow/guards.js';
export * from './workflow/tools.js';
export * from './workflow/validate.js';
export * from './workflow/transition-rules.js';
export * from './workflow/fold.js';
export * from './workflow/fixtures.js';
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
export * from './engine/spend.js';
export * from './engine/fixtures.js';
export * from './protocol/ws.js';
export * from './protocol/commands.js';
export * from './protocol/outcome.js';
export * from './protocol/fixtures.js';
export * from './api/rest.js';
export * from './api/sse.js';
export * from './api/fixtures.js';

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
