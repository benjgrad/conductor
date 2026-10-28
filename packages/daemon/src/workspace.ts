import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { RepoInventoryEntry } from '@conductor/shared';
import { execFileCli } from './platform/index.js';
import type { DaemonStore } from './store.js';

// Shared clones and per-session worktrees (07 §Code). One shared clone per repo under
// <root>/repos/; agents never edit it. Each session gets `git worktree add <root>/wt/<session_id>`
// on its own branch (`start_session.branch` = sessionBranch()). A NEW worktree is based on the
// freshly fetched `origin/<default_branch>` (M2-T13a, TD-026): `git fetch origin <default_branch>`
// runs before each new worktree, serialised per clone. Existing worktrees and branches are reused
// untouched (never fetched into or rebased).

/**
 * Run git in `cwd`; rejects like promisified execFile (the error carries `stdout`/`stderr`).
 * `execFileCli`: on win32 a bare `git` must never resolve from the cwd, which is often an
 * agent-writable worktree (a planted git.exe would run with the user's credentials).
 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCli(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const e: Error & { stdout?: string; stderr?: string } = err;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      },
    );
  });
}

/** Which `ticket.repo` values the daemon will clone (M1-T14; DaemonConfig). */
export interface RepoPolicy {
  /** Accept absolute paths and `file://` URLs (default false; the E2E fixture repo needs it). */
  allowLocalRepos?: boolean;
  /** When non-empty, the remote host must be one of these (case-insensitive). */
  allowedRepoHosts?: readonly string[];
}

export class RepoNotAllowedError extends Error {
  constructor(repo: string, why: string) {
    super(`repo not allowed: ${JSON.stringify(repo)}: ${why}`);
    this.name = 'RepoNotAllowedError';
  }
}

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*`;
const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const REPO_PATH = `${SEGMENT}(?:/${SEGMENT})+`;
/** `github.com/org/app` (two or more path segments, e.g. GitLab subgroups). */
const CANONICAL = new RegExp(`^(${HOST})/(${REPO_PATH})$`);
/** scp-style ssh: `git@github.com:org/app.git`. */
const SCP = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._-]*@(${HOST}):(${REPO_PATH})$`);
const HTTPS_PATH = new RegExp(`^/${REPO_PATH}$`);

/**
 * Validate `repo` against the policy and return where to clone it from (M1-T14). Accepted:
 *   - canonical `host/org/repo` → `https://host/org/repo.git`
 *   - `https://host[:port]/org/repo[.git]`, as is
 *   - scp-style ssh `user@host:org/repo[.git]`, as is
 *   - an absolute path or a `file://` URL, as is, only with `allowLocalRepos`
 * Anything else (relative paths, other schemes and transports such as `ext::`, `.`/`..`
 * segments, a leading `-`) is refused, and a remote host must be in `allowedRepoHosts` when that
 * list is non-empty. Throws RepoNotAllowedError.
 * TD-026: https with no auth (private repos can't clone; M2-T13). The stale-base half is paid:
 * Workspace.ensureWorktree fetches the default branch before each new worktree (M2-T13a).
 */
export function cloneSource(repo: string, policy: RepoPolicy = {}): string {
  if (repo === '' || /[\s\0]/.test(repo)) {
    throw new RepoNotAllowedError(repo, 'empty or contains whitespace');
  }
  if (isAbsolute(repo) || /^file:/i.test(repo)) {
    if (policy.allowLocalRepos !== true) {
      throw new RepoNotAllowedError(repo, 'local repos need allowLocalRepos');
    }
    return repo;
  }
  let host: string;
  let source: string;
  let m: RegExpExecArray | null;
  if (/^https:\/\//i.test(repo)) {
    let u: URL;
    try {
      u = new URL(repo);
    } catch {
      throw new RepoNotAllowedError(repo, 'not a valid URL');
    }
    if (u.search !== '' || u.hash !== '' || !HTTPS_PATH.test(u.pathname)) {
      throw new RepoNotAllowedError(repo, 'expected https://host/org/repo');
    }
    host = u.hostname;
    source = repo;
  } else if ((m = SCP.exec(repo))) {
    host = m[1]!;
    source = repo;
  } else if ((m = CANONICAL.exec(repo))) {
    host = m[1]!;
    source = `https://${repo.replace(/\.git$/, '')}.git`;
  } else {
    throw new RepoNotAllowedError(
      repo,
      'expected host/org/repo, https://host/org/repo or user@host:org/repo',
    );
  }
  if (repo.split(/[/:]/).some((seg) => seg === '..' || seg === '.')) {
    throw new RepoNotAllowedError(repo, 'path has . or .. segments');
  }
  const allowed = policy.allowedRepoHosts ?? [];
  if (allowed.length > 0 && !allowed.some((h) => h.toLowerCase() === host.toLowerCase())) {
    throw new RepoNotAllowedError(repo, `host ${host} is not in allowedRepoHosts`);
  }
  return source;
}

/** Filesystem-safe, collision-resistant directory name for a repo. */
export function repoSlug(repo: string): string {
  const readable = repo
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_.]+/, '')
    .slice(-60);
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  return `${readable || 'repo'}-${hash}`;
}

/** Max CLAUDE.md bytes passed via appendSystemPrompt; a larger file is skipped (M1-T14). */
export const MAX_CLAUDE_MD_BYTES = 64 * 1024;

export interface WorkspaceOptions extends RepoPolicy {
  log?: (msg: string) => void;
}

export class Workspace {
  private readonly cloning = new Map<string, Promise<string>>();
  private readonly log: (msg: string) => void;

  constructor(
    readonly rootDir: string,
    private readonly store: DaemonStore,
    private readonly opts: WorkspaceOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
  }

  worktreePath(sessionId: string): string {
    return join(this.rootDir, 'wt', sessionId);
  }

  /** The shared clone for `repo`, cloning it on first use. Returns its path. */
  ensureClone(repo: string): Promise<string> {
    const known = this.store.repos[repo];
    if (known !== undefined && existsSync(join(known, '.git'))) return Promise.resolve(known);
    let p = this.cloning.get(repo);
    if (!p) {
      p = this.clone(repo).finally(() => this.cloning.delete(repo));
      this.cloning.set(repo, p);
    }
    return p;
  }

  private async clone(repo: string): Promise<string> {
    const reposDir = join(this.rootDir, 'repos');
    mkdirSync(reposDir, { recursive: true });
    const path = join(reposDir, repoSlug(repo));
    if (!existsSync(join(path, '.git'))) {
      await git(reposDir, ['clone', '--quiet', '--', cloneSource(repo, this.opts), path]);
    }
    this.store.putRepo(repo, path);
    return path;
  }

  /**
   * Create (or reuse) the session worktree on `branch`. An existing worktree is reused (resume,
   * re-sent start_session); an existing branch without a worktree is checked out again.
   *
   * ADR-0008 (reopen): a reopened ticket's new session carries the earlier session's branch,
   * which is still checked out in that session's worktree (`<root>/wt/<old session>`), so
   * `git worktree add` would fail with "already checked out". When the branch is checked out in
   * another worktree directly under `<root>/wt`, that worktree is returned as is: same files
   * (uncommitted ones too), same cwd, so the resumed Claude conversation and its transcript stay
   * where they were. The caller must make sure no live process still uses it. A branch checked out
   * anywhere else is an error.
   *
   * M2-T13a (TD-026): only when a NEW branch is created, `git fetch origin <default_branch>` runs
   * first (inside the per-clone lock, so concurrent starts fetch one at a time) and the branch is
   * created from the fetched `origin/<default_branch>`, without upstream tracking. `baseRef`
   * `HEAD` (what the orchestrator sends, M1_BASE_REF) means exactly that; any other `baseRef` is
   * used as given after the fetch. A failed fetch throws an error naming the repo: never a silent
   * stale base.
   */
  async ensureWorktree(opts: {
    repo: string;
    sessionId: string;
    branch: string;
    baseRef: string;
    /**
     * The repo's default branch (`start_session.working_copy.default_branch` once the contract
     * carries it). Absent = the clone's `origin/HEAD`.
     */
    defaultBranch?: string | undefined;
  }): Promise<string> {
    // The refs come from the orchestrator: never let one be read as a git option.
    const refs = [opts.branch, opts.baseRef];
    if (opts.defaultBranch !== undefined) refs.push(opts.defaultBranch);
    for (const ref of refs) {
      if (ref === '' || ref.startsWith('-')) throw new Error(`invalid git ref: ${ref}`);
    }
    if (opts.repo.startsWith('-')) throw new Error(`invalid repo: ${opts.repo}`);
    cloneSource(opts.repo, this.opts); // RepoNotAllowedError before any clone or reuse (M1-T14)
    const clone = await this.ensureClone(opts.repo);
    const path = this.worktreePath(opts.sessionId);
    // Worktree mutations on one clone are serialized: a concurrent `worktree prune` could
    // otherwise drop another session's half-created worktree.
    return this.serialized(clone, async () => {
      if (existsSync(join(path, '.git'))) return path;
      mkdirSync(join(this.rootDir, 'wt'), { recursive: true });
      await git(clone, ['worktree', 'prune']);
      const holder = await this.worktreeHolding(clone, opts.branch);
      if (holder !== null) {
        const wtDir = join(this.rootDir, 'wt');
        if (sameDir(dirname(holder), wtDir) && existsSync(join(holder, '.git'))) {
          return join(wtDir, basename(holder));
        }
        throw new Error(`branch ${opts.branch} is already checked out at ${holder}`);
      }
      const hasBranch = await git(clone, ['branch', '--list', opts.branch]);
      if (hasBranch.trim() !== '') {
        await git(clone, ['worktree', 'add', '--quiet', path, opts.branch]);
      } else {
        const base = await this.freshBase(opts.repo, clone, opts.baseRef, opts.defaultBranch);
        await git(clone, [
          'worktree',
          'add',
          '--quiet',
          '--no-track',
          '-b',
          opts.branch,
          path,
          base,
        ]);
      }
      return path;
    });
  }

  /**
   * Fetch the default branch into the clone and return the ref a new session branch starts from.
   * Runs inside `serialized(clone)`. Hooks are disabled for the fetch (the repo is untrusted).
   */
  private async freshBase(
    repo: string,
    clone: string,
    baseRef: string,
    defaultBranch: string | undefined,
  ): Promise<string> {
    let branch: string;
    try {
      branch = defaultBranch ?? (await this.originHead(clone));
    } catch (err) {
      throw new Error(`cannot resolve the default branch of ${repo}: ${errText(err)}`, {
        cause: err,
      });
    }
    if (!isSafeBranchName(branch)) {
      throw new Error(`invalid default branch for ${repo}: ${JSON.stringify(branch)}`);
    }
    try {
      await git(clone, [
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
    } catch (err) {
      throw new Error(`git fetch origin ${branch} failed for ${repo}: ${errText(err)}`, {
        cause: err,
      });
    }
    return baseRef === 'HEAD' ? `refs/remotes/origin/${branch}` : baseRef;
  }

  /**
   * The clone's default branch from `refs/remotes/origin/HEAD`. When that ref is missing (an old
   * clone, or a remote whose HEAD was unborn at clone time) it is set once with
   * `git remote set-head origin --auto` and read again. The loose ref file is read first (a
   * symref is never packed), which saves a git spawn per session start.
   */
  private async originHead(clone: string): Promise<string> {
    const prefix = 'refs/remotes/origin/';
    const read = async (): Promise<string | null> => {
      try {
        const file = readFileSync(join(clone, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'utf8');
        const m = /^ref: refs\/remotes\/origin\/(\S+)\s*$/.exec(file);
        if (m) return m[1]!;
      } catch {
        // absent (or not a loose file): ask git
      }
      try {
        const ref = (await git(clone, ['symbolic-ref', '--quiet', `${prefix}HEAD`])).trim();
        return ref.startsWith(prefix) && ref.length > prefix.length
          ? ref.slice(prefix.length)
          : null;
      } catch {
        return null;
      }
    };
    const known = await read();
    if (known !== null) return known;
    await git(clone, ['remote', 'set-head', 'origin', '--auto']);
    const set = await read();
    if (set === null) throw new Error('origin/HEAD is not set');
    return set;
  }

  /** The worktree that has `branch` checked out (`git worktree list --porcelain`), or null. */
  private async worktreeHolding(clone: string, branch: string): Promise<string | null> {
    const out = await git(clone, ['worktree', 'list', '--porcelain']);
    for (const block of out.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (path !== undefined && lines.includes(`branch refs/heads/${branch}`)) return path;
    }
    return null;
  }

  private readonly locks = new Map<string, Promise<unknown>>();

  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  /**
   * The worktree's CLAUDE.md (U-013), or null. The repo is untrusted (M1-T14): the file is read
   * only when lstat says it is a regular file (not a symlink), its realpath is inside the
   * worktree, and it is at most MAX_CLAUDE_MD_BYTES; otherwise it is skipped with a log line.
   * The read uses O_NOFOLLOW and re-checks type and size on the open descriptor.
   */
  readClaudeMd(worktreePath: string): string | null {
    const path = join(worktreePath, 'CLAUDE.md');
    const skip = (why: string): null => {
      this.log(`skipping ${path}: ${why}`);
      return null;
    };
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return null; // absent
    }
    if (st.isSymbolicLink()) return skip('it is a symlink');
    if (!st.isFile()) return skip('not a regular file');
    if (st.size > MAX_CLAUDE_MD_BYTES) return skip(`larger than ${MAX_CLAUDE_MD_BYTES} bytes`);
    let fd: number;
    try {
      const rel = relative(realpathSync(worktreePath), realpathSync(path));
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return skip('it resolves outside the worktree');
      }
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      return skip(err instanceof Error ? err.message : String(err));
    }
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile()) return skip('not a regular file');
      if (fst.size > MAX_CLAUDE_MD_BYTES) return skip(`larger than ${MAX_CLAUDE_MD_BYTES} bytes`);
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  /** `repo_inventory` entries for every shared clone. */
  async inventory(): Promise<RepoInventoryEntry[]> {
    const out: RepoInventoryEntry[] = [];
    for (const [repo, path] of Object.entries(this.store.repos)) {
      if (!existsSync(join(path, '.git'))) continue;
      let head = '';
      let clean = false;
      try {
        head = (await git(path, ['rev-parse', 'HEAD'])).trim();
        clean = (await git(path, ['status', '--porcelain'])).trim() === '';
      } catch {
        // An empty repo has no HEAD; report it as not clean.
      }
      out.push({ repo, path, head_commit: head, tree_clean: clean });
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  }
}

/**
 * A conservative subset of `git check-ref-format --branch` (checked in JS to save a spawn): ASCII
 * letters, digits, `._/-`; no leading `-` / `/` / `.`, no `..`, `//`, `/.`, trailing `/` or `.lock`.
 */
export function isSafeBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name) &&
    !/\.\.|\/\/|\/\.|\/$|\.lock$|\.$/.test(name) &&
    !name.split('/').some((seg) => seg.endsWith('.lock'))
  );
}

/** An exec error's stderr (git's own message), else its message. */
function errText(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

/** Whether two paths name the same directory (realpaths; false if either is missing). */
function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function inventoryDigest(entries: readonly RepoInventoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
