import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  canonicalRepo,
  InventoryRepoSchema,
  isCanonicalRemote,
  type InventoryRepo,
  type WorkingCopyMode,
} from '@conductor/shared';
import { gitRead } from './git.js';

// The repo half of the inventory (M2-T10; ADR-0013 §Inventory, 10-contracts §Machines protocol
// v2). Walks the configured roots for git work trees: depth ≤ 4, never through a symlink, skipping
// `node_modules` and dot-directories. Per repo it reads only refs and `remote.origin.url`, with
// hooks off and no system config (gitRead); it runs no repo code. Remotes are canonicalised with
// the shared `canonicalRepo` (TD-107: no copy of the grammar here).

/** The deepest directory level a repo is found at (the root is 0). */
export const MAX_DEPTH = 4;
/** Walk bounds: a huge home dir must not stall the daemon. */
export const MAX_DIRS = 50_000;
export const MAX_REPOS = 1_000;
const CONCURRENCY = 8;

export interface ScanReposOptions {
  roots: readonly string[];
  /** Per-repo working-copy mode from `config.json`, by absolute path. Default `reference`. */
  modes?: Readonly<Record<string, WorkingCopyMode>>;
  /** When non-empty, a remote on another host is reported as null (DaemonConfig.allowedRepoHosts). */
  allowedRepoHosts?: readonly string[];
  /** Tests only (CONDUCTOR_TEST_REMOTE_ALIASES): checkout path → canonical remote. */
  testRemoteAliases?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

function isWorkTree(dir: string): boolean {
  try {
    const st = lstatSync(join(dir, '.git'));
    // A directory, or a file (`gitdir: …`) for linked worktrees and submodules.
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** The work trees under `roots`, absolute, de-duplicated, in walk order. */
export function findWorkTrees(
  roots: readonly string[],
  log: (msg: string) => void = () => {},
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  for (const raw of roots) {
    let root: string;
    try {
      // The root the user chose may itself be a symlink; nothing under it is followed.
      root = realpathSync(resolve(raw));
    } catch {
      log(`inventory: root ${raw} is missing or unreadable; skipped`);
      continue;
    }
    const queue: [string, number][] = [[root, 0]];
    while (queue.length > 0) {
      const [dir, depth] = queue.shift()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (++visited > MAX_DIRS) {
        log(`inventory: stopped after ${MAX_DIRS} directories`);
        return found;
      }
      if (isWorkTree(dir)) {
        found.push(dir);
        if (found.length >= MAX_REPOS) {
          log(`inventory: stopped after ${MAX_REPOS} repos`);
          return found;
        }
        continue; // nested repos (submodules) are not separate inventory entries
      }
      if (depth >= MAX_DEPTH) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // EACCES, vanished
      }
      for (const e of entries) {
        // A symlink dirent is not a directory: symlinks are never followed.
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        queue.push([join(dir, e.name), depth + 1]);
      }
    }
  }
  return found;
}

/** `origin`'s URL as a canonical remote, or null (unparsable, refused or a disallowed host). */
export function canonicalRemote(
  url: string,
  allowedRepoHosts: readonly string[] = [],
): string | null {
  const c = canonicalRepo(url.trim());
  if (c === null || !isCanonicalRemote(c)) return null;
  const host = c.slice(0, c.indexOf('/'));
  if (allowedRepoHosts.length > 0 && !allowedRepoHosts.some((h) => h.toLowerCase() === host)) {
    return null;
  }
  return c;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

async function defaultBranch(dir: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const head = await gitRead(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], env);
  const prefix = 'refs/remotes/origin/';
  const ref = head.stdout.trim();
  if (head.code === 0 && ref.startsWith(prefix) && ref.length > prefix.length) {
    return ref.slice(prefix.length);
  }
  for (const b of ['main', 'master']) {
    for (const r of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) {
      if ((await gitRead(dir, ['show-ref', '--verify', '--quiet', r], env)).code === 0) return b;
    }
  }
  return 'main';
}

/** One repo's inventory entry, or null (no commit yet, or it fails InventoryRepoSchema). */
export async function scanRepo(
  dir: string,
  opts: Omit<ScanReposOptions, 'roots'> & { aliases?: ReadonlyMap<string, string> },
): Promise<InventoryRepo | null> {
  const env = opts.env;
  const head = await gitRead(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], env);
  if (head.code !== 0) return null;
  const alias = opts.aliases?.get(realOrSelf(dir));
  let remote: string | null;
  if (alias !== undefined) {
    remote = alias;
  } else {
    const url = await gitRead(dir, ['config', '--get', 'remote.origin.url'], env);
    remote = url.code === 0 ? canonicalRemote(url.stdout, opts.allowedRepoHosts) : null;
  }
  const entry = {
    path: dir,
    remote,
    default_branch: await defaultBranch(dir, env),
    head_commit: head.stdout.trim(),
    mode: opts.modes?.[dir] ?? 'reference',
  };
  const parsed = InventoryRepoSchema.safeParse(entry);
  if (!parsed.success) {
    opts.log?.(`inventory: ${dir} not reported: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return null;
  }
  return parsed.data;
}

/** Every reportable repo under the roots, sorted by path. Never throws for one bad repo. */
export async function scanRepos(opts: ScanReposOptions): Promise<InventoryRepo[]> {
  const dirs = findWorkTrees(opts.roots, opts.log);
  const aliases = new Map(
    Object.entries(opts.testRemoteAliases ?? {}).map(([p, r]) => [realOrSelf(p), r] as const),
  );
  const out: InventoryRepo[] = [];
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const dir = dirs[next++]!;
      try {
        const r = await scanRepo(dir, { ...opts, aliases });
        if (r) out.push(r);
      } catch (e) {
        opts.log?.(`inventory: ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
