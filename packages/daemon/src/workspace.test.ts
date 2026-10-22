// M1-T14 regression tests: repo resolution policy and the untrusted CLAUDE.md read.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonStore } from './store.js';
import { cloneSource, MAX_CLAUDE_MD_BYTES, RepoNotAllowedError, Workspace } from './workspace.js';

describe('cloneSource policy', () => {
  it('accepts canonical host/org/repo, https URLs and scp-style ssh', () => {
    expect(cloneSource('github.com/org/app')).toBe('https://github.com/org/app.git');
    expect(cloneSource('github.com/org/app.git')).toBe('https://github.com/org/app.git');
    expect(cloneSource('gitlab.example.org/group/sub/app')).toBe(
      'https://gitlab.example.org/group/sub/app.git',
    );
    expect(cloneSource('https://github.com/org/app.git')).toBe('https://github.com/org/app.git');
    expect(cloneSource('https://git.example.org:8443/org/app')).toBe(
      'https://git.example.org:8443/org/app',
    );
    expect(cloneSource('git@github.com:org/app.git')).toBe('git@github.com:org/app.git');
  });

  it('rejects absolute paths and file:// unless allowLocalRepos', () => {
    for (const repo of ['/srv/repos/app', 'file:///tmp/x', 'FILE:///tmp/x']) {
      expect(() => cloneSource(repo)).toThrow(RepoNotAllowedError);
      expect(() => cloneSource(repo, { allowLocalRepos: false })).toThrow(/allowLocalRepos/);
      expect(cloneSource(repo, { allowLocalRepos: true })).toBe(repo);
    }
  });

  it('rejects other schemes, transports, relative paths and traversal', () => {
    for (const repo of [
      'http://github.com/org/app',
      'ssh://git@github.com/org/app',
      'git://github.com/org/app',
      'ext::sh -c touch% /tmp/pwned',
      'ext::sh',
      'fd::17',
      '../other/repo',
      './repo',
      'repo',
      'github.com/app',
      'github.com/../../etc',
      'github.com/org/..',
      'https://github.com/org/../x',
      'https://github.com/org/app?x=1',
      'https://github.com/',
      'git@github.com:/abs/path',
      'git@github.com:-oProxyCommand=x/y',
      '-uhost/org/app',
      'github.com/org/app ',
      '',
    ]) {
      expect(() => cloneSource(repo, { allowLocalRepos: true }), repo).toThrow(RepoNotAllowedError);
    }
  });

  it('checks the host against allowedRepoHosts when it is set', () => {
    const policy = { allowedRepoHosts: ['github.com'] };
    expect(cloneSource('github.com/org/app', policy)).toBe('https://github.com/org/app.git');
    expect(cloneSource('https://GitHub.com/org/app', policy)).toBe('https://GitHub.com/org/app');
    expect(cloneSource('git@github.com:org/app', policy)).toBe('git@github.com:org/app');
    for (const repo of [
      'evil.example/org/app',
      'https://evil.example/org/app',
      'git@evil.example:org/app',
      'https://github.com.evil.example/org/app',
    ]) {
      expect(() => cloneSource(repo, policy), repo).toThrow(/allowedRepoHosts/);
    }
    // an empty list means any host
    expect(cloneSource('evil.example/org/app', { allowedRepoHosts: [] })).toBe(
      'https://evil.example/org/app.git',
    );
  });
});

describe('Workspace', () => {
  let dir: string;
  let wt: string;
  let logs: string[];
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-test-'));
    wt = join(dir, 'wt', 's1');
    mkdirSync(wt, { recursive: true });
    logs = [];
    ws = new Workspace(join(dir, 'root'), DaemonStore.forRoot(join(dir, 'root')), {
      log: (m) => logs.push(m),
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureWorktree refuses a local repo before cloning when allowLocalRepos is off', async () => {
    await expect(
      ws.ensureWorktree({
        repo: join(dir, 'origin'),
        sessionId: 's1',
        branch: 'b',
        baseRef: 'HEAD',
      }),
    ).rejects.toThrow(RepoNotAllowedError);
    await expect(
      ws.ensureWorktree({ repo: 'ext::sh', sessionId: 's1', branch: 'b', baseRef: 'HEAD' }),
    ).rejects.toThrow(RepoNotAllowedError);
  });

  it('reads a regular CLAUDE.md inside the worktree', () => {
    writeFileSync(join(wt, 'CLAUDE.md'), '# hi\n');
    expect(ws.readClaudeMd(wt)).toBe('# hi\n');
    expect(logs).toEqual([]);
  });

  it('returns null without a log line when CLAUDE.md is absent', () => {
    expect(ws.readClaudeMd(wt)).toBeNull();
    expect(logs).toEqual([]);
  });

  it('skips a CLAUDE.md symlink (outside or inside the worktree) and logs it', () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'TOKEN=hunter2\n');
    symlinkSync(secret, join(wt, 'CLAUDE.md'));
    expect(ws.readClaudeMd(wt)).toBeNull();
    expect(logs.join('\n')).toMatch(/symlink/);

    rmSync(join(wt, 'CLAUDE.md'));
    writeFileSync(join(wt, 'real.md'), 'inside\n');
    symlinkSync(join(wt, 'real.md'), join(wt, 'CLAUDE.md'));
    expect(ws.readClaudeMd(wt)).toBeNull();
  });

  it('resolves the worktree path itself through symlinks (macOS /var → /private/var)', () => {
    const real = join(dir, 'real-wt');
    mkdirSync(real);
    writeFileSync(join(real, 'CLAUDE.md'), 'ok\n');
    symlinkSync(real, join(dir, 'wt', 'linked'));
    expect(ws.readClaudeMd(join(dir, 'wt', 'linked'))).toBe('ok\n');
  });

  it('skips a directory named CLAUDE.md and a file over 64 KB', () => {
    mkdirSync(join(wt, 'CLAUDE.md'));
    expect(ws.readClaudeMd(wt)).toBeNull();
    expect(logs.join('\n')).toMatch(/not a regular file/);
    rmSync(join(wt, 'CLAUDE.md'), { recursive: true });

    writeFileSync(join(wt, 'CLAUDE.md'), 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1));
    expect(ws.readClaudeMd(wt)).toBeNull();
    expect(logs.join('\n')).toMatch(/larger than 65536 bytes/);

    writeFileSync(join(wt, 'CLAUDE.md'), 'x'.repeat(MAX_CLAUDE_MD_BYTES));
    expect(ws.readClaudeMd(wt)).toHaveLength(MAX_CLAUDE_MD_BYTES);
  });
});
