import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cloneSource, RepoNotAllowedError, type RepoPolicy } from '../workspace.js';

// ADR-0010 `open_pr`: conductor (this daemon code, never an agent) pushes the session branch and
// opens a pull request against the repo's default branch with the GitHub CLI, or reuses the PR
// that already exists for the branch. Agents keep their `git push` deny (ADR-0006).
//
// Hardening (security reviews, 2026-10-23). This runs with Ben's own git / gh credentials, while
// the worktree's `.git` points into the shared clone, whose `config` and `hooks/` any session's
// agent can write, at any time (so checking that config first would be a check-then-use race).
// So the push never runs in, or reads the config of, an agent-writable repository:
// 1. the session branch is FETCHED into a daemon-private bare repo (`<root>/private/<slug>.git`,
//    created by the daemon with git's minimal defaults; no agent cwd is ever inside it), with hooks
//    off, only the file transport, and an explicit `--upload-pack=git-upload-pack`. Fetching from
//    a local path runs upload-pack in the source repo, which reads its config, but upload-pack runs
//    no hooks and honours `uploadpack.packObjectsHook` only from protected (system/global/command)
//    config, so nothing agent-written is executed;
// 2. the fetched tip is re-verified (a commit);
// 3. the push runs from the private repo to an explicit URL from the daemon's own store
//    (`cloneSource(ticket.repo)`), allow-listed to GitHub (`https://github.com/o/r`,
//    `git@github.com:o/r`, or an `allowedRepoHosts` host), never the config-resolved `origin`,
//    with hooks off (`core.hooksPath=/dev/null`, `--no-verify`), only https/ssh transports, no
//    system config (GIT_CONFIG_NOSYSTEM) and no inherited GIT_* overrides. Credentials and any
//    `insteadOf` therefore come only from Ben's global git config;
// 4. gh gets `--repo <owner>/<name>` from that trusted URL, explicit `--head` and `--base` (the
//    default branch from `gh repo view`), and runs in the daemon root, outside every repository.
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
  /** Test hook: runs after the fetch into the private repo, before the push. */
  afterFetch?: () => void;
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

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn failed (e.g. ENOENT: not on PATH). */
  spawnError: NodeJS.ErrnoException | null;
}

/** process env minus every variable that would point git at other config, dirs or commands. */
function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^GIT_/.test(k)) continue;
    if (k === 'GH_REPO' || k === 'GH_HOST') continue;
    out[k] = v;
  }
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
}

function run(cmd: string, args: string[], cwd: string, i: OpenPrInput): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
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

const tail = (s: string, n = 600) => {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

const URL_RE = /https?:\/\/\S+/g;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The daemon-private bare repo the push runs from, one per ticket repo. */
export function privateRepoPath(root: string, repo: string): string {
  const slug = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return join(root, 'private', `${slug}.git`);
}

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

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

  // 1. Fetch the branch into the daemon-private repo (created on first use).
  const priv = privateRepoPath(i.root, i.repo);
  if (!existsSync(join(priv, 'HEAD'))) {
    mkdirSync(dirname(priv), { recursive: true });
    const init = await run('git', [...NO_HOOKS, 'init', '--quiet', '--bare', priv], i.root, i);
    if (init.spawnError)
      return { ok: false, error: `git could not run: ${init.spawnError.message}` };
    if (init.code !== 0) return { ok: false, error: `git init failed: ${tail(init.stderr)}` };
  }
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
  if (fetch.spawnError)
    return { ok: false, error: `git could not run: ${fetch.spawnError.message}` };
  if (fetch.code !== 0) {
    return { ok: false, error: `could not read the session branch: ${tail(fetch.stderr)}` };
  }
  // 2. Re-verify what was fetched.
  const tip = await run('git', [...NO_HOOKS, 'rev-parse', '--verify', `${ref}^{commit}`], priv, i);
  if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tip.stdout.trim())) {
    return { ok: false, error: `the session branch ${i.branch} has no commit to push` };
  }
  i.afterFetch?.();

  // 3. Push from the private repo to the trusted URL.
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
      `${ref}:${ref}`,
    ],
    priv,
    i,
  );
  if (push.spawnError) return { ok: false, error: `git could not run: ${push.spawnError.message}` };
  if (push.code !== 0) {
    return { ok: false, error: `git push failed: ${tail(push.stderr || push.stdout)}` };
  }

  // Reuse the PR that already exists for the branch (a repeat of the same visit, or a retry).
  const repo = ['--repo', target.ghRepo];
  const view = await run(
    'gh',
    ['pr', 'view', i.branch, ...repo, '--json', 'url', '--jq', '.url'],
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
  if (existing) return { ok: true, url: existing, reused: true };

  const repoView = await run(
    'gh',
    ['repo', 'view', target.ghRepo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
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
    'gh',
    [
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
  return { ok: true, url: created, reused: false };
}
