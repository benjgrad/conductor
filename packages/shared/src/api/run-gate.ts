import { z } from 'zod';
import { EntryCheckSchema } from '../workflow/schema.js';
import { TRANSITION_NAME_MAX } from '../protocol/outcome.js';

// R4: `run_gate`, the daemon-hosted MCP tool a working agent calls to run the checks a transition's
// gate runs, in a fresh checkout of its HEAD, before it takes the transition. The daemon asks the
// orchestrator for the checks (POST API_PATHS.daemonSessionGate, which records the call as a
// `self_check_run`), runs them itself, then reports the outcome (API_PATHS.daemonSessionGateResult).
// Nothing reaches the engine: the session stays in its agent state.

/** POST API_PATHS.daemonSessionGate. */
export const RunGateRequestSchema = z.strictObject({
  transition: z.string().min(1).max(TRANSITION_NAME_MAX),
  /** The worktree's HEAD the daemon will check (40 hex). */
  sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type RunGateRequest = z.infer<typeof RunGateRequestSchema>;

/** The answer: what to run. `setup` null = auto-detect from the lockfile, '' = none. */
export const RunGateSpecSchema = z.object({
  run_id: z.string(),
  transition: z.string(),
  title: z.string(),
  setup: z.string().nullable(),
  checks: z.array(EntryCheckSchema),
});
export type RunGateSpec = z.infer<typeof RunGateSpecSchema>;

/** One item's outcome: `not_run` = conductor could not run it (no checkout, missing tool, …). */
export const RunGateStatusSchema = z.enum(['pass', 'fail', 'skipped', 'not_run']);
export type RunGateStatus = z.infer<typeof RunGateStatusSchema>;

export const RunGateCheckResultSchema = z.object({
  name: z.string().max(200),
  status: RunGateStatusSchema,
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
});
export type RunGateCheckResult = z.infer<typeof RunGateCheckResultSchema>;

/** POST API_PATHS.daemonSessionGateResult. */
export const RunGateResultSchema = z.object({
  /** RunGateSpec.run_id. */
  run_id: z.string().uuid(),
  passed: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  /** The setup that ran (after lockfile auto-detect), or null when none ran. */
  setup: z.object({ cmd: z.string().max(2_000), status: RunGateStatusSchema }).nullable(),
  results: z.array(RunGateCheckResultSchema).max(20),
  /** Why nothing ran (no commits ahead, the checkout failed), when that is the case. */
  not_run: z.string().max(2_000).optional(),
});
export type RunGateResult = z.infer<typeof RunGateResultSchema>;
