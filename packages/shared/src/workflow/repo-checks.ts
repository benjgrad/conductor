import { z } from 'zod';
import { EntryCheckSchema, type EntryCheck, type WorkflowDefinition } from './schema.js';
import { transitionChecks, transitionObject, transitionTitle } from './transition-rules.js';

// ADR-0030: per-repo check overrides. A repo whose build doesn't fit the workflow's default checks
// (`npm run build` / `npm test` at the root) gets its own list, stored per account and repo in the
// `repo_checks` table and managed over REST and MCP (`set_repo_checks`). A repo-local config file
// is not an option: work repos must not carry conductor-specific commits (WORK_COMMIT_REVIEW_ITEM).

/** At most this many checks in one override (as `requires.checks`). */
export const REPO_CHECKS_MAX = 20;

/**
 * A repo's checks. They replace the `checks` and `setup` of every gate step that runs real checks
 * (`applyRepoChecks`). `setup` as `requires.setup`: absent = auto-detect from the lockfile, `''` =
 * none, otherwise the command. Every command runs with `sh -c` at the root of a fresh checkout
 * (Git Bash on Windows).
 */
export const RepoChecksSchema = z
  .strictObject({
    setup: z.string().max(2_000).optional(),
    checks: z.array(EntryCheckSchema).min(1).max(REPO_CHECKS_MAX),
  })
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    o.checks.forEach((c, i) => {
      const name = c.name.trim();
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checks', i, 'name'],
          message: `check "${name}" is listed twice`,
        });
      }
      seen.add(name);
      if (c.cmd.trim() === '') {
        ctx.addIssue({ code: 'custom', path: ['checks', i, 'cmd'], message: 'empty command' });
      }
    });
  });
export type RepoChecks = z.infer<typeof RepoChecksSchema>;

/**
 * An agent's proposed repo checks (`ask_user`'s `proposed_checks`): stored as a `repo_checks`
 * change proposal for the ticket's repo, which only a human applies. `checks: null` = remove the
 * override (the workflow's checks again).
 */
export const ProposedChecksSchema = z.object({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(1_000),
  checks: RepoChecksSchema.nullable(),
});
export type ProposedChecks = z.infer<typeof ProposedChecksSchema>;

/** A gate of a definition that runs real checks: where, and its own checks and setup. */
export interface ChecksGate {
  /** `state.transition` (a transition's `requires`) or `state` (an entry). */
  at: string;
  /** null = auto-detect, '' = none. */
  setup: string | null;
  checks: readonly EntryCheck[];
}

/**
 * ADR-0030: every gate of `def` with at least one declared check, in state order: each state's
 * `entry`, then its transitions' `requires`. These are the gates a repo override replaces.
 */
export function checksGatesOf(def: Pick<WorkflowDefinition, 'states'>): ChecksGate[] {
  const out: ChecksGate[] = [];
  for (const [name, state] of Object.entries(def.states)) {
    const entry = state.entry;
    if (entry?.checks !== undefined && entry.checks.length > 0) {
      out.push({ at: name, setup: entry.setup ?? null, checks: entry.checks });
    }
    if (!('on' in state) || state.on === undefined) continue;
    for (const [tName, raw] of Object.entries(state.on)) {
      const req = transitionObject(raw).requires;
      if (req?.checks !== undefined && req.checks.length > 0) {
        out.push({ at: `${name}.${tName}`, setup: req.setup ?? null, checks: req.checks });
      }
    }
  }
  return out;
}

/** R4: what `run_gate` runs for a transition: its gate's checks with the repo override applied. */
export interface SelfCheckSpec {
  /** The transition's title (`transitionTitle`). */
  title: string;
  /** null = auto-detect from the lockfile, '' = none. */
  setup: string | null;
  checks: readonly EntryCheck[];
}

/**
 * R4: the checks the gate of `name` out of `state` runs (`transitionChecks`), with the repo's
 * override applied the way `applyRepoChecks` does for a gate step (its checks and setup replace
 * the declared ones). null when the transition runs no checks.
 */
export function selfCheckSpecOf(
  def: Pick<WorkflowDefinition, 'states'>,
  state: string,
  name: string,
  override: RepoChecks | null | undefined,
): SelfCheckSpec | null {
  const declared = transitionChecks(def, state, name);
  if (declared === null) return null;
  const raw = def.states[state]?.type === 'terminal' ? undefined : def.states[state]?.on?.[name];
  const title = transitionTitle(name, raw);
  if (override !== null && override !== undefined) {
    return { title, setup: override.setup ?? null, checks: override.checks };
  }
  return { title, setup: declared.setup, checks: declared.checks };
}
