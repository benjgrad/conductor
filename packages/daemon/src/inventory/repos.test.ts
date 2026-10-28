import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InventoryRepoSchema } from '@conductor/shared';
import { canonicalRemote, findWorkTrees, scanRepos } from './repos.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// M2-T10 acceptance: the repo scanner on a temp tree with real git.

let tmp: string;
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

/** A repo with one commit at `dir` (created), optional origin URL. */
function repo(dir: string, origin?: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', branch);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init');
  if (origin !== undefined) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-inv-')));
  root = join(tmp, 'code');
  mkdirSync(root);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('inventory repos (M2-T10)', () => {
  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('finds repos at depth 1–4, not 5', async () => {
    const d1 = repo(join(root, 'a'));
    const d2 = repo(join(root, 'b', 'r2'));
    const d3 = repo(join(root, 'c', 'x', 'r3'));
    const d4 = repo(join(root, 'd', 'x', 'y', 'r4'));
    repo(join(root, 'e', 'x', 'y', 'z', 'r5'));
    expect(findWorkTrees([root]).sort()).toEqual([d1, d2, d3, d4].sort());
    const repos = await scanRepos({ roots: [root] });
    expect(repos.map((r) => r.path)).toEqual([d1, d2, d3, d4].sort());
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('skips node_modules, dot-directories and symlinks', async () => {
    const real = repo(join(root, 'real'));
    repo(join(root, 'node_modules', 'pkg'));
    repo(join(root, '.cache', 'hidden'));
    const outside = repo(join(tmp, 'outside', 'linked'));
    symlinkSync(join(tmp, 'outside'), join(root, 'via-dir-link'));
    symlinkSync(outside, join(root, 'repo-link'));
    expect(findWorkTrees([root])).toEqual([real]);
    expect((await scanRepos({ roots: [root] })).map((r) => r.path)).toEqual([real]);
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('canonicalises origin to host/org/repo; no origin → remote null', async () => {
    const scp = repo(join(root, 'scp'), 'git@github.com:org/app.git');
    const https = repo(join(root, 'https'), 'https://github.com/org/app');
    const upper = repo(join(root, 'upper'), 'https://GitHub.com/Org/App.git');
    const none = repo(join(root, 'none'));
    const repos = await scanRepos({ roots: [root] });
    const remote = (p: string) => repos.find((r) => r.path === p)?.remote;
    expect(remote(scp)).toBe('github.com/org/app');
    expect(remote(https)).toBe('github.com/org/app');
    expect(remote(upper)).toBe('github.com/Org/App');
    expect(remote(none)).toBeNull();
    for (const r of repos) expect(InventoryRepoSchema.safeParse(r).success).toBe(true);
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('a remote that is not canonical is null for that repo only', async () => {
    const file = repo(join(root, 'file'), 'file:///srv/git/app.git');
    const http = repo(join(root, 'http'), 'http://github.com/org/app');
    const port = repo(join(root, 'port'), 'ssh://git@github.com:22/org/app.git');
    const good = repo(join(root, 'good'), 'git@github.com:org/good.git');
    const repos = await scanRepos({ roots: [root] });
    expect(repos).toHaveLength(4);
    const remote = (p: string) => repos.find((r) => r.path === p)?.remote;
    expect(remote(file)).toBeNull();
    expect(remote(http)).toBeNull();
    expect(remote(port)).toBeNull();
    expect(remote(good)).toBe('github.com/org/good');
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('allowedRepoHosts: another host is reported with remote null', async () => {
    const gl = repo(join(root, 'gl'), 'git@gitlab.com:org/app.git');
    const gh = repo(join(root, 'gh'), 'git@github.com:org/app.git');
    const repos = await scanRepos({ roots: [root], allowedRepoHosts: ['github.com'] });
    expect(repos.find((r) => r.path === gl)?.remote).toBeNull();
    expect(repos.find((r) => r.path === gh)?.remote).toBe('github.com/org/app');
    expect(canonicalRemote('git@gitlab.com:org/app.git', [])).toBe('gitlab.com/org/app');
  });

  it('a repo without commits is not reported', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '--quiet');
    expect(await scanRepos({ roots: [root] })).toEqual([]);
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)(
    'default_branch from origin/HEAD, else main / master; head_commit; mode from config',
    async () => {
      const upstream = repo(join(tmp, 'upstream'), undefined, 'trunk');
      const cloned = join(root, 'cloned');
      execFileSync('git', ['clone', '--quiet', upstream, cloned], { stdio: 'pipe' });
      const master = repo(join(root, 'm'), undefined, 'master');
      const main = repo(join(root, 'n'));
      const repos = await scanRepos({ roots: [root], modes: { [main]: 'checkout' } });
      const by = (p: string) => repos.find((r) => r.path === p)!;
      expect(by(cloned).default_branch).toBe('trunk');
      expect(by(master).default_branch).toBe('master');
      expect(by(main).default_branch).toBe('main');
      expect(by(main).head_commit).toBe(git(main, 'rev-parse', 'HEAD').trim());
      expect(by(main).mode).toBe('checkout');
      expect(by(master).mode).toBe('reference');
    },
  );

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)(
    'a planted hook / hooksPath / fsmonitor in a scanned repo never runs',
    async () => {
      const r = repo(join(root, 'evil'), 'git@github.com:org/evil.git');
      const marker = join(tmp, 'pwned');
      const script = `#!/bin/sh\ntouch ${marker}\n`;
      for (const h of ['post-checkout', 'post-index-change', 'reference-transaction']) {
        writeFileSync(join(r, '.git', 'hooks', h), script);
        chmodSync(join(r, '.git', 'hooks', h), 0o755);
      }
      const evilHooks = join(tmp, 'evil-hooks');
      mkdirSync(evilHooks);
      writeFileSync(join(evilHooks, 'post-checkout'), script);
      chmodSync(join(evilHooks, 'post-checkout'), 0o755);
      writeFileSync(join(tmp, 'fsmon.sh'), script);
      chmodSync(join(tmp, 'fsmon.sh'), 0o755);
      git(r, 'config', 'core.hooksPath', evilHooks);
      git(r, 'config', 'core.fsmonitor', join(tmp, 'fsmon.sh'));
      const repos = await scanRepos({ roots: [root] });
      expect(repos.map((x) => x.path)).toEqual([r]);
      expect(existsSync(marker)).toBe(false);
    },
  );

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('test remote aliases give a local repo a canonical remote', async () => {
    const r = repo(join(root, 'fixture'));
    const repos = await scanRepos({
      roots: [root],
      testRemoteAliases: { [r]: 'github.com/benjgrad/fixture-app' },
    });
    expect(repos[0]!.remote).toBe('github.com/benjgrad/fixture-app');
  });

  // MW-T09: repo scan of a win32 tree
  it.skipIf(onWin32)('a missing root is skipped, the others still scanned', async () => {
    const r = repo(join(root, 'ok'));
    const logs: string[] = [];
    const repos = await scanRepos({ roots: [join(tmp, 'nope'), root], log: (m) => logs.push(m) });
    expect(repos.map((x) => x.path)).toEqual([r]);
    expect(logs.join('\n')).toContain('nope');
  });
});
