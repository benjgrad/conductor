import { execFile } from 'node:child_process';
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
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RepoInventoryEntry } from '@conductor/shared';
import type { DaemonStore } from './store.js';

// Shared clones and per-session worktrees (07 §Code). One shared clone per repo under
// <root>/repos/; agents never edit it. Each session gets `git worktree add <root>/wt/<session_id>`
// on its own branch (`start_session.branch` = sessionBranch()) from `base_ref` (M1: HEAD).

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
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
 * TD-026: https with no auth, and the shared clone is never fetched after the first clone, so
 * `base_ref` resolves against a stale copy.
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
   */
  async ensureWorktree(opts: {
    repo: string;
    sessionId: string;
    branch: string;
    baseRef: string;
  }): Promise<string> {
    // The refs come from the orchestrator: never let one be read as a git option.
    for (const ref of [opts.branch, opts.baseRef]) {
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
      const hasBranch = await git(clone, ['branch', '--list', opts.branch]);
      if (hasBranch.trim() !== '') {
        await git(clone, ['worktree', 'add', '--quiet', path, opts.branch]);
      } else {
        await git(clone, ['worktree', 'add', '--quiet', '-b', opts.branch, path, opts.baseRef]);
      }
      return path;
    });
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

export function inventoryDigest(entries: readonly RepoInventoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
