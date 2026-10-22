import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

/**
 * Where to clone `repo` from. An absolute path or a URL (scheme:// or scp-style user@host:path)
 * is used as is; a canonical name like `github.com/org/app` becomes `https://github.com/org/app.git`.
 * TD-026: https with no auth, and the shared clone is never fetched after the first clone, so
 * `base_ref` resolves against a stale copy.
 */
export function cloneSource(repo: string): string {
  if (
    isAbsolute(repo) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) ||
    /^[^@/\s]+@[^:/\s]+:/.test(repo)
  ) {
    return repo;
  }
  return `https://${repo.replace(/\.git$/, '')}.git`;
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

/** Max CLAUDE.md bytes passed via appendSystemPrompt. */
export const MAX_CLAUDE_MD_BYTES = 64 * 1024;

export class Workspace {
  private readonly cloning = new Map<string, Promise<string>>();

  constructor(
    readonly rootDir: string,
    private readonly store: DaemonStore,
  ) {}

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
      await git(reposDir, ['clone', '--quiet', '--', cloneSource(repo), path]);
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

  /** The worktree's CLAUDE.md (U-013), capped at MAX_CLAUDE_MD_BYTES; null if absent. */
  readClaudeMd(worktreePath: string): string | null {
    let text: string;
    try {
      text = readFileSync(join(worktreePath, 'CLAUDE.md'), 'utf8');
    } catch {
      return null;
    }
    if (Buffer.byteLength(text) > MAX_CLAUDE_MD_BYTES) {
      text = Buffer.from(text).subarray(0, MAX_CLAUDE_MD_BYTES).toString('utf8') + '\n…(truncated)';
    }
    return text;
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
