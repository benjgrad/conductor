import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { NO_HOOKS, privateDir, run, tail } from './open-pr.js';

// ADR-0010 (Ben, 2026-10-26): entry checks run in a fresh, conductor-owned checkout of the exact
// commit, never in the agent's worktree. The checkout is an ephemeral repo under
// `<root>/private/check-*` (0700, lstat/owner-checked, like open_pr's push repo), created by the
// daemon with git's minimal config (only Ben's global config applies: no repo-config filter
// drivers, hooks off). The session branch is fetched in with the open_pr hardening
// (`--upload-pack=git-upload-pack`, file protocol only, `GIT_CONFIG_NOSYSTEM`, inherited `GIT_*`
// dropped), its tip must equal the commit to check, and that commit is checked out detached.
// M2-T30: the setup and the npm-style checks follow the repo's lockfile (pnpm / yarn / npm).
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

export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/**
 * M2-T30: the lockfiles that name a package manager, in precedence order, with the install each
 * implies. A repo with only a `package.json` is npm (`npm install`); one with neither is not a
 * Node repo (no setup, commands run as written).
 */
const LOCKFILES: readonly { file: string; manager: PackageManager; install: string }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', manager: 'yarn', install: 'yarn install --immutable' },
  { file: 'package-lock.json', manager: 'npm', install: 'npm ci' },
];

export interface DetectedManager {
  manager: PackageManager;
  /** The lockfile that decided it; null = only a `package.json`. */
  lockfile: string | null;
  install: string;
}

/** The package manager of the repo at `dir`, from its committed lockfile; null = not a Node repo. */
export function detectPackageManager(dir: string): DetectedManager | null {
  for (const l of LOCKFILES) {
    if (existsSync(join(dir, l.file))) {
      return { manager: l.manager, lockfile: l.file, install: l.install };
    }
  }
  if (existsSync(join(dir, 'package.json'))) {
    return { manager: 'npm', lockfile: null, install: 'npm install' };
  }
  return null;
}

/**
 * The fresh checkout's setup: `configured` when set ('' = none), else auto-detect from the
 * committed lockfile (M2-T30): `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` →
 * `yarn install --immutable`, `package-lock.json` → `npm ci`, a bare `package.json` →
 * `npm install`, else none.
 */
export function detectSetup(dir: string, configured: string | null): string | null {
  if (configured !== null) return configured.trim() === '' ? null : configured;
  return detectPackageManager(dir)?.install ?? null;
}

// A command segment starts the string or follows `&&`, `||`, `;` or a newline. Only these npm
// forms are rewritten (the ones workflows use); anything else runs exactly as written.
const NPM_SCRIPT_RE = /(^|&&|\|\||;|\n)(\s*)npm (run|run-script|test)(?=\s|$)/g;

/**
 * M2-T30: a workflow check written for npm (`npm run <script>`, `npm test`) runs with the repo's
 * own package manager: `pnpm run build` in a pnpm repo, `yarn run build` in a yarn repo. npm repos
 * and non-Node repos get `cmd` unchanged.
 */
export function managedCommand(dir: string, cmd: string): string {
  const pm = detectPackageManager(dir)?.manager;
  if (pm === undefined || pm === 'npm') return cmd;
  return cmd.replace(NPM_SCRIPT_RE, (_m, sep: string, ws: string, sub: string) => {
    return `${sep}${ws}${pm} ${sub === 'test' ? 'test' : 'run'}`;
  });
}

const MANAGER_RE = /(?:^|&&|\|\||;|\n)\s*(pnpm|yarn|npm)(?=\s|$)/g;

/** Is `bin` an executable file in one of `path`'s directories? */
function onPath(bin: string, path: string): boolean {
  for (const d of path.split(delimiter)) {
    if (d === '') continue;
    const f = join(d, bin);
    try {
      if (!statSync(f).isFile()) continue;
      accessSync(f, constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/**
 * M2-T30: when `cmd` runs a package manager (at the start of a command segment) that is not on
 * `path` (default: the daemon's PATH, which the command runner inherits), a message naming it for
 * the check's output; null = every one it uses is there.
 */
export function missingManager(cmd: string, path = process.env.PATH ?? ''): string | null {
  const used = new Set([...cmd.matchAll(MANAGER_RE)].map((m) => m[1]!));
  const missing = [...used].filter((b) => !onPath(b, path));
  if (missing.length === 0) return null;
  const names = missing.map((b) => `\`${b}\``).join(' and ');
  return (
    `${names} ${missing.length === 1 ? 'is' : 'are'} not on this machine's PATH, so \`${cmd}\` ` +
    `cannot run: install ${missing.join(' and ')} for the daemon's user and restart the daemon`
  );
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
