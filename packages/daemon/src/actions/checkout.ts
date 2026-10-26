import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NO_HOOKS, privateDir, run, tail } from './open-pr.js';

// ADR-0010 (Ben, 2026-10-26): entry checks run in a fresh, conductor-owned checkout of the exact
// commit, never in the agent's worktree. The checkout is an ephemeral repo under
// `<root>/private/check-*` (0700, lstat/owner-checked, like open_pr's push repo), created by the
// daemon with git's minimal config (only Ben's global config applies: no repo-config filter
// drivers, hooks off). The session branch is fetched in with the open_pr hardening
// (`--upload-pack=git-upload-pack`, file protocol only, `GIT_CONFIG_NOSYSTEM`, inherited `GIT_*`
// dropped), its tip must equal the commit to check, and that commit is checked out detached.
// The checks are the agent's own code (`npm test`), so they can still do anything the daemon's
// user can (U-004); what is gone is checking a working tree that differs from the pushed commit,
// and running filters / attributes config the agent planted in the shared clone.

export interface FreshCheckoutInput {
  root: string;
  /** The session worktree (only read through a hardened fetch). */
  worktree: string;
  branch: string;
  /** The commit to check. */
  sha: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type FreshCheckout =
  | { ok: true; dir: string; sha: string }
  /** `head`: the branch tip actually found (when it differs from `sha`), else null. */
  | { ok: false; error: string; head: string | null };

const SHA_RE = /^[0-9a-f]{40,64}$/;

export async function freshCheckout(i: FreshCheckoutInput): Promise<FreshCheckout> {
  if (!SHA_RE.test(i.sha)) return { ok: false, error: `invalid commit ${i.sha}`, head: null };
  let dir: string;
  try {
    const d = privateDir(i.root, 'check-');
    if (d instanceof Error) return { ok: false, error: `fresh checkout: ${d.message}`, head: null };
    dir = d;
  } catch (e) {
    return { ok: false, error: `fresh checkout: ${String(e)}`, head: null };
  }
  const fail = (error: string, head: string | null = null): FreshCheckout => {
    removeCheckout(dir);
    return { ok: false, error, head };
  };
  try {
    const git = (args: string[]) => run('git', [...NO_HOOKS, ...args], dir, i);
    const init = await git(['init', '--quiet', dir]);
    if (init.code !== 0) return fail(`git init failed: ${tail(init.stderr)}`);
    const ref = `refs/heads/${i.branch}`;
    const fetch = await git([
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--upload-pack=git-upload-pack',
      i.worktree,
      `+${ref}:${ref}`,
    ]);
    if (fetch.code !== 0) return fail(`could not read the session branch: ${tail(fetch.stderr)}`);
    const tip = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
    if (!SHA_RE.test(tip)) return fail(`the session branch ${i.branch} has no commit`);
    if (tip !== i.sha) {
      return fail(`the branch moved: the checks are for ${i.sha}, the branch is at ${tip}`, tip);
    }
    const co = await git([
      '-c',
      'advice.detachedHead=false',
      'checkout',
      '--quiet',
      '--detach',
      '--force',
      i.sha,
    ]);
    if (co.code !== 0) return fail(`git checkout failed: ${tail(co.stderr)}`);
    return { ok: true, dir, sha: i.sha };
  } catch (e) {
    return fail(String(e));
  }
}

/**
 * The fresh checkout's setup: `configured` when set ('' = none), else auto-detect from the
 * committed files: `package-lock.json` → `npm ci`, `package.json` → `npm install`, else none.
 */
export function detectSetup(dir: string, configured: string | null): string | null {
  if (configured !== null) return configured.trim() === '' ? null : configured;
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm ci';
  if (existsSync(join(dir, 'package.json'))) return 'npm install';
  return null;
}

export function removeCheckout(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** On daemon start: remove fresh checkouts and push repos a previous daemon left behind. */
export function sweepPrivate(root: string): void {
  const base = join(root, 'private');
  if (!existsSync(base)) return;
  // Same rule as privateDir: a real directory owned by this uid, never followed through a symlink.
  const st = lstatSync(base);
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  if (process.getuid !== undefined && st.uid !== process.getuid()) return;
  for (const name of readdirSync(base)) {
    if (name.startsWith('check-') || name.startsWith('push-')) removeCheckout(join(base, name));
  }
}
