import { z } from 'zod';
import { PathGlobSchema } from '../workflow/schema.js';

// ADR-0037 P4 (the evidence half of T7): a planning result may carry `files`, the repo-relative
// path globs the plan expects to create or edit. The built-in `plan_template` asks for it. The
// engine stores it in `context[<state>]` like any extra key and never fails on it (no engine
// change); this module reads it back, as api/pages.ts does for `pages`. A list that doesn't parse
// reads as null: no evidence, no hold.

/** The `complete_state` result key carrying the planned files (never a required `result` key). */
export const PLANNED_FILES_KEY = 'files';

/** The longest list a plan may give. */
export const PLANNED_FILES_MAX = 200;

/**
 * Repo-relative: no leading `/` or `./`, no drive letter, no backslash, no `..` segment, no
 * control characters (a newline would mean two entries were joined).
 */
export function isRepoRelativeGlob(glob: string): boolean {
  if (glob.startsWith('/') || glob.startsWith('./')) return false;
  if (/^[A-Za-z]:/.test(glob)) return false;
  if (glob.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(glob)) return false;
  return !glob.split('/').includes('..');
}

/** One planned path glob, e.g. `packages/web/src/**` (the `PathGlobSchema` shape, repo-relative). */
export const PlannedFileSchema = PathGlobSchema.refine(isRepoRelativeGlob, {
  message: 'a repo-relative path glob (no leading /, ./ or drive, no .., no backslash)',
});

/** A plan's `files`. Empty is allowed: the plan expects to change nothing. */
export const PlannedFilesSchema = z.array(PlannedFileSchema).max(PLANNED_FILES_MAX);
export type PlannedFiles = z.infer<typeof PlannedFilesSchema>;

/**
 * The `files` of a step's result, parsed and de-duplicated in order. null when the result isn't
 * an object, has no `files`, or any entry doesn't parse. Never throws.
 */
export function plannedFilesOf(result: unknown): string[] | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const raw = (result as Record<string, unknown>)[PLANNED_FILES_KEY];
  if (raw === undefined) return null;
  const parsed = PlannedFilesSchema.safeParse(raw);
  if (!parsed.success) return null;
  return [...new Set(parsed.data)];
}
