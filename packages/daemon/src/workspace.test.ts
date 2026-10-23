// M1-T14 regression tests: repo resolution policy. (The untrusted CLAUDE.md read went with
// ADR-0006: Claude Code loads CLAUDE.md itself.)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonStore } from './store.js';
import { cloneSource, RepoNotAllowedError, Workspace } from './workspace.js';

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
});
