import { z } from 'zod';

// A machine's repo inventory (ADR-0013 §Inventory, U-060; 10-contracts §Machines protocol v2).
// Reported by the daemon (M2-T10) in WS `inventory`, stored in `machine_repo` (M2-T09/T16).

/**
 * How sessions get a working copy of a repo (U-060): `reference` = worktrees of a daemon
 * reference clone (`git clone --reference` to the user's checkout; the user's `.git` is never
 * touched; the default), `checkout` = worktrees directly off the user's own checkout (opt-in per
 * repo, with the `.git` tamper check).
 */
export const WorkingCopyModeSchema = z.enum(['reference', 'checkout']);
export type WorkingCopyMode = z.infer<typeof WorkingCopyModeSchema>;

// The M1-T14 grammar (daemon/src/workspace.ts `CANONICAL`): a DNS host, then two or more path
// segments (GitLab subgroups). Canonical form, as T01's `canonicalRepo` produces it: the host is
// lower-case; org / repo keep their case (T16 compares github.com org/repo case-insensitively).
// TD-107: this repo grammar is duplicated in daemon/src/workspace.ts and T01's `canonicalRepo`.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*`;
const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]*';

/**
 * A canonical remote: `host/org/repo[/sub…]` with a lower-case host, no scheme, no user, no port,
 * no `.git` suffix (any case) and no `.` / `..` segment. What the inventory reports as `remote` and what `ticket.repo` names.
 */
export const CANONICAL_REMOTE_RE = new RegExp(`^${HOST}(?:/${SEGMENT}){2,}$`);

export function isCanonicalRemote(s: string): boolean {
  return (
    CANONICAL_REMOTE_RE.test(s) &&
    !/\.git$/i.test(s) &&
    !s.split('/').some((seg) => seg === '.' || seg === '..')
  );
}

/** An absolute POSIX path with no NUL and no `.` / `..` segment (Windows is out of M2, U-071). */
export const AbsolutePathSchema = z
  .string()
  .min(2)
  .refine(
    (p) =>
      p.startsWith('/') &&
      !p.includes('\0') &&
      !p.split('/').some((seg) => seg === '.' || seg === '..'),
    'expected an absolute path without . or .. segments',
  );

/** `origin/HEAD`'s branch, else `main` / `master`. A plain ref name. */
const BranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (b) => !/[\s\0]/.test(b) && !b.startsWith('-') && !b.includes('..'),
    'expected a branch name',
  );

export const InventoryRepoSchema = z.object({
  /** The user's checkout (the work tree root), absolute. Unique per machine. */
  path: AbsolutePathSchema,
  /**
   * The `origin` fetch URL canonicalised to `host/org/repo` (CANONICAL_REMOTE_RE). null = no
   * GitHub / allowed-host remote: reported, but no ticket is routed to it.
   */
  remote: z.string().refine(isCanonicalRemote, 'expected host/org/repo').nullable(),
  default_branch: BranchNameSchema,
  /** The checkout's HEAD (SHA-1 or SHA-256). A repo without commits is not reported. */
  head_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  mode: WorkingCopyModeSchema,
});
export type InventoryRepo = z.infer<typeof InventoryRepoSchema>;

/**
 * `start_session.working_copy`: the `machine_repo` the claim matched. The daemon re-checks
 * `repo_path` against its own inventory (same path, same mode) and never trusts the message.
 */
export const WorkingCopySchema = z.object({
  repo_path: AbsolutePathSchema,
  mode: WorkingCopyModeSchema,
});
export type WorkingCopy = z.infer<typeof WorkingCopySchema>;

/**
 * `session.context` key holding the claim's chosen WorkingCopy (set by the claim, M2-T16, in the
 * claim transaction; no migration). `commandPayloadForEffect` copies it into every start_session
 * of the session, re-emits included. Absent = the M1 clone path (local mode).
 */
export const WORKING_COPY_CONTEXT_KEY = '__working_copy';
