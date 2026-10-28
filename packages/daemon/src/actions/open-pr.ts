import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cliVersionAtLeast, GH_MIN_VERSION, GITHUB_PR_URL_RE } from '@conductor/shared';
import { cliVersionFrom } from '../inventory/version.js';
import {
  execFileCli,
  gitHooksOffArgs,
  gitSystemConfigEnv,
  mkdirPrivate,
} from '../platform/index.js';
import { cloneSource, RepoNotAllowedError, type RepoPolicy } from '../workspace.js';

// ADR-0010 `open_pr`: conductor (this daemon code, never an agent) pushes the session branch and
// opens a pull request against the repo's default branch with the GitHub CLI, or reuses the PR
// that already exists for the branch. Agents keep their `git push` deny (ADR-0006).
//
// Hardening (security reviews, 2026-10-23). This runs with Ben's own git / gh credentials, while
// the worktree's `.git` points into the shared clone, whose `config` and `hooks/` any session's
// agent can write, at any time (so checking that config first would be a check-then-use race).
// So the push never runs in, or reads the config of, an agent-writable repository:
// 1. the session branch is FETCHED into a fresh daemon-private bare repo (`mkdtemp` under
//    `<root>/private`, 0700, owner/lstat-checked, deleted after the push; git's minimal defaults;
//    no agent cwd is ever inside it), with hooks
//    off, only the file transport, and an explicit `--upload-pack=git-upload-pack`. Fetching from
//    a local path runs upload-pack in the source repo, which reads its config, but upload-pack runs
//    no hooks and honours `uploadpack.packObjectsHook` only from protected (system/global/command)
//    config, so nothing agent-written is executed;
// 2. the fetched tip must EQUAL the commit the entry checks ran on (`expected_sha`, reported by
//    the daemon with the first check's exit), else nothing is pushed;
// 3. exactly that commit (`<sha>:refs/heads/<branch>`) is pushed from the private repo to an explicit URL from the daemon's own store
//    (`cloneSource(ticket.repo)`), allow-listed to GitHub (`https://github.com/o/r`,
//    `git@github.com:o/r`, or an `allowedRepoHosts` host), never the config-resolved `origin`,
//    with hooks off (`core.hooksPath=/dev/null`, `--no-verify`), only https/ssh transports, no
//    system config (GIT_CONFIG_NOSYSTEM) and no inherited GIT_* overrides. Credentials and any
//    `insteadOf` therefore come only from Ben's global git config;
// 4. gh gets `--repo <owner>/<name>` from that trusted URL, explicit `--head` and `--base` (the
//    default branch from `gh repo view`), and runs in the daemon root, outside every repository.
//    Before anything is pushed, `gh --version` must be at least GH_MIN_VERSION (M2-T10): older gh
//    can't run `pr create` outside a repository; the refusal is an action error (a human decides).
// Residual risk (ADR-0010 implementation notes): agents run as the same uid with unconfined Bash
// (U-004, TD-083), so an agent could still write the private repo, Ben's global config or the gh
// binary; the sandbox is the real boundary.

export interface OpenPrInput {
  /** The session worktree (the objects to push). */
  worktree: string;
  /** The session branch, from the daemon's store. */
  branch: string;
  /** `ticket.repo` from the daemon's store (what the shared clone was cloned from). */
  repo: string;
  /**
   * The daemon's repo policy. `allowLocalRepos` (tests, the E2E fixture) also allows a local-path
   * repo here; real use only ever pushes to GitHub.
   */
  policy: RepoPolicy;
  title: string;
  body: string;
  /**
   * The daemon's root: gh runs here (outside every repository) and the private push repos live
   * under `<root>/private/`.
   */
  root: string;
  /**
   * The commit the entry checks ran on (`run_action.expected_sha`): the fetched branch tip must
   * equal it, and exactly it is pushed. null only for an entry without checks (the tip is pushed).
   */
  expectedSha: string | null;
  /**
   * How to run gh (default `gh` from PATH). Tests pass `{cmd: process.execPath, args: [fake]}`:
   * never a token, never a different GitHub.
   */
  gh?: { cmd: string; args: readonly string[] };
  /** Test hook: runs after the fetch into the private repo (its path), before the push. */
  afterFetch?: (privateRepo: string) => void;
  /** Environment for git and gh (default process.env); tests put a fake `gh` first on PATH. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type OpenPrResult =
  { ok: true; url: string; reused: boolean } | { ok: false; error: string };

/** Where to push and what gh calls the repository. */
export interface PushTarget {
  url: string;
  /** gh `--repo`: `owner/name`, or `host/owner/name` for a non-github.com host. */
  ghRepo: string;
  local: boolean;
}

const SEG = '[A-Za-z0-9_.-]+';
const HTTPS = new RegExp(`^https://([A-Za-z0-9.-]+)/(${SEG})/(${SEG}?)(?:\\.git)?/?$`);
const SCP = new RegExp(`^git@([A-Za-z0-9.-]+):(${SEG})/(${SEG}?)(?:\\.git)?$`);

/**
 * The push URL for `repo`, from the same rule the clone used (`cloneSource`), allow-listed:
 * GitHub (or an `allowedRepoHosts` host) over https or ssh, `owner/name` only. A local path only
 * with `allowLocalRepos` (tests). Anything else → an Error with a sentence for the human.
 */
export function pushTarget(repo: string, policy: RepoPolicy): PushTarget {
  let url: string;
  try {
    url = cloneSource(repo, policy);
  } catch (e) {
    throw new Error(e instanceof RepoNotAllowedError ? e.message : String(e), { cause: e });
  }
  if (url.startsWith('/') || /^file:/i.test(url)) {
    if (policy.allowLocalRepos !== true) {
      throw new Error(`${repo} is a local path, not a GitHub repository`);
    }
    // Test / E2E only: no real GitHub repo; the fake gh just needs a name.
    return { url, ghRepo: `local/${basename(url).replace(/\.git$/, '')}`, local: true };
  }
  const m = HTTPS.exec(url) ?? SCP.exec(url);
  const host = m?.[1]?.toLowerCase();
  const allowed = new Set(['github.com', ...(policy.allowedRepoHosts ?? [])]);
  if (!m || host === undefined || !allowed.has(host)) {
    throw new Error(
      `${repo} is not a GitHub repository conductor may push to (https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>)`,
    );
  }
  const name = m[3]!.replace(/\.git$/, '');
  if (name === '' || m[2]!.startsWith('-') || name.startsWith('-')) {
    throw new Error(`${repo} has no valid owner/name`);
  }
  return {
    url,
    ghRepo: host === 'github.com' ? `${m[2]}/${name}` : `${host}/${m[2]}/${name}`,
    local: false,
  };
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn failed (e.g. ENOENT: not on PATH). */
  spawnError: NodeJS.ErrnoException | null;
}

/** process env minus every variable that would point git at other config, dirs or commands. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^GIT_/.test(k)) continue;
    if (k === 'GH_REPO' || k === 'GH_HOST') continue;
    out[k] = v;
  }
  return {
    ...out,
    ...gitSystemConfigEnv(), // POSIX: no system gitconfig; win32 keeps it (ADR-0024 §5)
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  i: Pick<OpenPrInput, 'env' | 'signal'>,
): Promise<Run> {
  return new Promise((resolve) => {
    execFileCli(
      cmd,
      args,
      {
        cwd,
        env: cleanEnv(i.env ?? process.env),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5 * 60_000,
        ...(i.signal ? { signal: i.signal } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        const spawnError = e && typeof e.code === 'string' ? e : null;
        const code = e === null ? 0 : typeof e.code === 'number' ? e.code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), spawnError });
      },
    );
  });
}

export const tail = (s: string, n = 600) => {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

const URL_RE = /https?:\/\/\S+/g;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Hooks off for every daemon git call (`NUL` on win32, see platform/git.ts). */
export const NO_HOOKS = gitHooksOffArgs();

const GH_MISSING =
  'gh (the GitHub CLI) is not on PATH: install it and run `gh auth login` on this machine';

export async function openPr(i: OpenPrInput): Promise<OpenPrResult> {
  if (!BRANCH_RE.test(i.branch)) return { ok: false, error: `invalid branch name ${i.branch}` };
  let target: PushTarget;
  try {
    target = pushTarget(i.repo, i.policy);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const gh = i.gh ?? { cmd: 'gh', args: [] };
  // U-076: GH_MIN_VERSION is a safe floor, not a verified minimum.
  const ver = await run(gh.cmd, [...gh.args, '--version'], i.root, i);
  if (ver.spawnError) {
    return {
      ok: false,
      error:
        ver.spawnError.code === 'ENOENT'
          ? GH_MISSING
          : `gh could not run: ${ver.spawnError.message}`,
    };
  }
  const found = ver.code === 0 ? cliVersionFrom(ver.stdout) : null;
  if (found === null || !cliVersionAtLeast(found, GH_MIN_VERSION)) {
    const shown = found ?? (tail(ver.stdout || ver.stderr, 60) || 'unknown');
    return {
      ok: false,
      error: `gh ≥ ${GH_MIN_VERSION} required (found ${shown}): upgrade gh, e.g. brew upgrade gh`,
    };
  }
  const pushed = await pushChecked(i, target);
  if (!pushed.ok) return pushed;

  // Reuse the PR that already exists for the branch (a repeat of the same visit, or a retry).
  const repo = ['--repo', target.ghRepo];
  const view = await run(
    gh.cmd,
    [...gh.args, 'pr', 'view', i.branch, ...repo, '--json', 'url', '--jq', '.url'],
    i.root,
    i,
  );
  if (view.spawnError) {
    return {
      ok: false,
      error:
        view.spawnError.code === 'ENOENT'
          ? GH_MISSING
          : `gh could not run: ${view.spawnError.message}`,
    };
  }
  const existing = view.code === 0 ? view.stdout.trim().match(URL_RE)?.at(-1) : undefined;
  if (existing) return prResult(existing, true);

  const repoView = await run(
    gh.cmd,
    [
      ...gh.args,
      'repo',
      'view',
      target.ghRepo,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ],
    i.root,
    i,
  );
  const base = repoView.stdout.trim();
  if (repoView.code !== 0 || !BRANCH_RE.test(base)) {
    return {
      ok: false,
      error: `gh could not read the default branch of ${target.ghRepo}: ${tail(repoView.stderr || repoView.stdout)}`,
    };
  }
  const create = await run(
    gh.cmd,
    [
      ...gh.args,
      'pr',
      'create',
      ...repo,
      '--head',
      i.branch,
      '--base',
      base,
      '--title',
      i.title,
      '--body',
      i.body,
    ],
    i.root,
    i,
  );
  if (create.spawnError)
    return { ok: false, error: `gh could not run: ${create.spawnError.message}` };
  if (create.code !== 0) {
    return { ok: false, error: `gh pr create failed: ${tail(create.stderr || create.stdout)}` };
  }
  const created = create.stdout.match(URL_RE)?.at(-1);
  if (!created) return { ok: false, error: `gh pr create printed no URL: ${tail(create.stdout)}` };
  return prResult(created, false);
}

/** Only a `https://github.com/<o>/<r>/pull/<n>` URL is reported (the engine and board check too). */
function prResult(url: string, reused: boolean): OpenPrResult {
  if (!GITHUB_PR_URL_RE.test(url)) {
    return { ok: false, error: `gh reported an unexpected PR URL: ${url}` };
  }
  return { ok: true, url, reused };
}

/**
 * A fresh private bare repo for one push: `mkdtemp` under `<root>/private` (0700 and owned by this
 * uid, or an owner-only DACL on win32; never a symlink: platform/acl.ts), removed afterwards. No
 * agent cwd is ever inside it, and it lives only for this push, so nothing can be planted in it
 * ahead of time.
 */
export function privateDir(root: string, prefix = 'push-'): string | Error {
  try {
    const base = join(root, 'private');
    mkdirPrivate(base);
    const dir = mkdtempSync(join(base, prefix));
    mkdirPrivate(dir);
    return dir;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Fetch the session branch into a fresh private repo, check that its tip is exactly the commit the
 * entry checks ran on, and push exactly that commit to the trusted URL. Never runs in, or reads
 * the config of, an agent-writable repository (see the header).
 */
async function pushChecked(
  i: OpenPrInput,
  target: PushTarget,
): Promise<OpenPrResult | { ok: true }> {
  if (i.expectedSha !== null && !/^[0-9a-f]{40,64}$/.test(i.expectedSha)) {
    return { ok: false, error: `invalid checked commit ${i.expectedSha}` };
  }
  let priv: string;
  try {
    const d = privateDir(i.root);
    if (d instanceof Error) return { ok: false, error: `private push repo: ${d.message}` };
    priv = d;
  } catch (e) {
    return { ok: false, error: `private push repo: ${errText(e)}` };
  }
  try {
    const init = await run('git', [...NO_HOOKS, 'init', '--quiet', '--bare', priv], i.root, i);
    if (init.spawnError)
      return { ok: false, error: `git could not run: ${init.spawnError.message}` };
    if (init.code !== 0) return { ok: false, error: `git init failed: ${tail(init.stderr)}` };

    // 1. Fetch the branch, with untrusted config off.
    const ref = `refs/heads/${i.branch}`;
    const fetch = await run(
      'git',
      [
        ...NO_HOOKS,
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
      ],
      priv,
      i,
    );
    if (fetch.spawnError) {
      return { ok: false, error: `git could not run: ${fetch.spawnError.message}` };
    }
    if (fetch.code !== 0) {
      return { ok: false, error: `could not read the session branch: ${tail(fetch.stderr)}` };
    }
    // 2. The fetched tip must be exactly the checked commit.
    const tip = await run(
      'git',
      [...NO_HOOKS, 'rev-parse', '--verify', `${ref}^{commit}`],
      priv,
      i,
    );
    const sha = tip.stdout.trim();
    if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      return { ok: false, error: `the session branch ${i.branch} has no commit to push` };
    }
    if (i.expectedSha !== null && sha !== i.expectedSha) {
      return {
        ok: false,
        error: `the branch moved after the checks (they ran on ${i.expectedSha}, the branch is at ${sha}): refusing to push an unchecked commit`,
      };
    }
    i.afterFetch?.(priv);

    // 3. Push exactly that commit to the trusted URL.
    const push = await run(
      'git',
      [
        ...NO_HOOKS,
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        ...(target.local ? ['-c', 'protocol.file.allow=always'] : []),
        'push',
        '--quiet',
        '--no-verify',
        target.url,
        `${sha}:${ref}`,
      ],
      priv,
      i,
    );
    if (push.spawnError)
      return { ok: false, error: `git could not run: ${push.spawnError.message}` };
    if (push.code !== 0) {
      return { ok: false, error: `git push failed: ${tail(push.stderr || push.stdout)}` };
    }
    return { ok: true };
  } finally {
    rmSync(priv, { recursive: true, force: true });
  }
}

/**
 * The worktree's `HEAD` commit, for `cmd_exit.head_sha` (ADR-0010: the commit the entry checks
 * run on). Hooks off, no system config; null when it can't be resolved.
 */
export async function resolveHead(
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const r = await run('git', [...NO_HOOKS, 'rev-parse', '--verify', 'HEAD^{commit}'], worktree, {
    env,
  });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * ADR-0010 entry checks run only on a clean worktree: `git status --porcelain
 * --untracked-files=all` with hooks and fsmonitor off and no system config (.gitignore'd files,
 * e.g. build outputs, don't count). Clean → `{head}` (the commit the check runs on); dirty →
 * `{dirty}` (the status lines; a failed status is reported as one line, so it is never "clean").
 */
export async function checkClean(
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ head: string | null; dirty: null } | { head: null; dirty: string[] }> {
  // Agent-writable state can hide changes from a plain `git status` (final QA, 2026-10-26):
  // assume-unchanged / skip-worktree index bits, `.git/info/exclude`, a repo-config
  // `core.excludesFile`, the stat cache. So the tree is dirty if ANY of these says so:
  // 1. status with the stat and untracked caches and core.excludesFile off;
  const git = (args: string[]) =>
    run('git', ['-c', 'core.fsmonitor=false', ...NO_HOOKS, ...args], worktree, { env });
  const failed = (what: string, r: Run): { head: null; dirty: string[] } => ({
    head: null,
    dirty: [`(git ${what} failed: ${tail(r.stderr || r.stdout, 300)})`],
  });

  const lines = (r: Run) => r.stdout.split('\n').filter((l) => l.trim() !== '');
  const st = await git([
    '-c',
    'core.ignoreStat=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.excludesFile=',
    'status',
    '--porcelain',
    '--untracked-files=all',
    // QA 1b: submodule changes are not hidden by submodule.<name>.ignore / diff.ignoreSubmodules.
    '--ignore-submodules=none',
  ]);
  if (st.code !== 0) return failed('status', st);
  const dirty = lines(st);
  // 2. hidden index bits: assume-unchanged (a lowercase tag) or skip-worktree (`S`);
  const lv = await git(['ls-files', '-v']);
  if (lv.code !== 0) return failed('ls-files -v', lv);
  for (const l of lines(lv)) {
    const tag = l.charAt(0);
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) dirty.push(`hidden (${tag}): ${l.slice(2)}`);
  }
  // 3. untracked files, honouring only the .gitignore files in the tree (not info/exclude or
  //    core.excludesFile, which the agent can write outside the commit).
  const un = await git(['ls-files', '--others', '--exclude-per-directory=.gitignore']);
  if (un.code !== 0) return failed('ls-files --others', un);
  for (const l of lines(un)) {
    const entry = `?? ${l}`;
    if (!dirty.includes(entry)) dirty.push(entry);
  }
  // QA 1a: an uncommitted .gitignore that ignores itself (ls-files --others reads working-tree
  //    .gitignore files): any untracked-and-ignored .gitignore is dirty.
  const gi = await git([
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-per-directory=.gitignore',
    '--',
    '.gitignore',
    ':(glob)**/.gitignore',
  ]);
  if (gi.code !== 0) return failed('ls-files --ignored', gi);
  for (const l of lines(gi)) {
    const entry = `?? ${l} (ignores itself)`;
    if (!dirty.includes(entry)) dirty.push(entry);
  }
  if (dirty.length > 0) return { head: null, dirty: dirty.slice(0, 200) };
  return { head: await resolveHead(worktree, env), dirty: null };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
