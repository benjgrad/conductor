import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPr, privateRepoPath, pushTarget, type OpenPrInput } from './open-pr.js';

// ADR-0010 open_pr against a local bare repo as the ticket's repo and a fake `gh` first on PATH:
// no network, no GitHub. The fake records argv + cwd and keeps "the PR" in a state file. Includes
// the security review's hardening cases: planted hooks and repo-config redirects don't work.

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
appendFileSync(dir + '/gh-argv.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const [a, b] = process.argv.slice(2);
const state = dir + '/pr-url';
if (a === 'repo' && b === 'view') { process.stdout.write('main\\n'); process.exit(0); }
if (a === 'pr' && b === 'view') {
  if (existsSync(state)) { process.stdout.write(readFileSync(state, 'utf8') + '\\n'); process.exit(0); }
  process.stderr.write('no pull requests found for branch\\n'); process.exit(1);
}
if (a === 'pr' && b === 'create') {
  if (process.env.FAKE_GH_FAIL) { process.stderr.write('HTTP 401: Bad credentials\\n'); process.exit(1); }
  const url = 'https://github.com/benjgrad/fixture-app/pull/7';
  writeFileSync(state, url);
  process.stdout.write('Creating pull request...\\n' + url + '\\n');
  process.exit(0);
}
process.exit(2);
`;

const BRANCH = 'conductor/ticket/abcd1234';
let tmp: string;
let fakeBin: string;
let worktree: string;
let clone: string;
let origin: string;
let attacker: string;
let ghCwd: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const hasBranch = (bare: string) => {
  try {
    git(bare, 'rev-parse', '--verify', `refs/heads/${BRANCH}`);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-open-pr-')));
  origin = join(tmp, 'origin.git');
  attacker = join(tmp, 'attacker.git');
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', attacker);
  const seed = join(tmp, 'seed');
  git(tmp, 'clone', '--quiet', origin, seed);
  git(seed, 'config', 'user.email', 't@localhost');
  git(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'README.md'), '# x\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  // The shared clone (as the daemon makes it) and a session worktree with one commit.
  clone = join(tmp, 'clone');
  git(tmp, 'clone', '--quiet', origin, clone);
  worktree = join(tmp, 'wt');
  git(clone, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree);
  writeFileSync(join(worktree, 'health.txt'), 'ok\n');
  git(worktree, 'add', '.');
  git(
    worktree,
    '-c',
    'user.email=t@localhost',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '-m',
    'add health',
  );

  fakeBin = join(tmp, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'gh'), FAKE_GH);
  chmodSync(join(fakeBin, 'gh'), 0o755);
  ghCwd = join(tmp, 'daemon-root');
  mkdirSync(ghCwd);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function input(over: Partial<OpenPrInput> = {}): OpenPrInput {
  return {
    worktree,
    branch: BRANCH,
    repo: origin,
    policy: { allowLocalRepos: true },
    title: 'Add /health',
    body: 'added /health\n\nOpened by conductor.',
    root: ghCwd,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GH_DIR: tmp,
    },
    ...over,
  };
}

const ghCalls = () =>
  existsSync(join(tmp, 'gh-argv.jsonl'))
    ? readFileSync(join(tmp, 'gh-argv.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
    : [];

describe('open_pr (ADR-0010)', () => {
  it('pushes the branch to the ticket repo and opens the PR with gh --repo/--head/--base', async () => {
    const r = await openPr(input());
    expect(r).toEqual({
      ok: true,
      url: 'https://github.com/benjgrad/fixture-app/pull/7',
      reused: false,
    });
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(
      git(worktree, 'rev-parse', 'HEAD').trim(),
    );
    const calls = ghCalls();
    expect(calls.map((c) => c.argv)).toEqual([
      ['pr', 'view', BRANCH, '--repo', 'local/origin', '--json', 'url', '--jq', '.url'],
      [
        'repo',
        'view',
        'local/origin',
        '--json',
        'defaultBranchRef',
        '--jq',
        '.defaultBranchRef.name',
      ],
      [
        'pr',
        'create',
        '--repo',
        'local/origin',
        '--head',
        BRANCH,
        '--base',
        'main',
        '--title',
        'Add /health',
        '--body',
        'added /health\n\nOpened by conductor.',
      ],
    ]);
    // gh runs outside the worktree (it reads no repo config); no token anywhere in argv.
    for (const c of calls) expect(realpathSync(c.cwd)).toBe(ghCwd);
    expect(calls.flatMap((c) => c.argv).join(' ')).not.toMatch(/token/i);
  });

  it('reuses the existing PR for the branch (idempotent repeat)', async () => {
    await openPr(input());
    const again = await openPr(input());
    expect(again).toEqual({
      ok: true,
      url: 'https://github.com/benjgrad/fixture-app/pull/7',
      reused: true,
    });
    expect(ghCalls().filter((c) => c.argv[1] === 'create')).toHaveLength(1);
  });

  it('a missing gh is a clear error', async () => {
    const onlyGit = join(tmp, 'only-git');
    mkdirSync(onlyGit);
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(onlyGit, 'git'));
    const r = await openPr(input({ env: { ...process.env, PATH: onlyGit } }));
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('gh (the GitHub CLI) is not on PATH') as unknown,
    });
  });

  it('a failed gh pr create reports the error', async () => {
    const r = await openPr(input({ env: { ...input().env, FAKE_GH_FAIL: '1' } }));
    expect(!r.ok && r.error).toContain('gh pr create failed: HTTP 401: Bad credentials');
  });
});

describe('open_pr hardening (security review 2026-10-23)', () => {
  it('an agent-planted pre-push hook in the shared clone does not run', async () => {
    const marker = join(tmp, 'hook-ran');
    const hook = join(clone, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(hook, 0o755);
    const r = await openPr(input());
    expect(r.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(hasBranch(origin)).toBe(true);
  });

  it('a rewritten remote.origin.url does not redirect the push (explicit trusted URL)', async () => {
    git(clone, 'config', 'remote.origin.url', attacker);
    const r = await openPr(input());
    expect(r.ok).toBe(true);
    expect(hasBranch(origin)).toBe(true);
    expect(hasBranch(attacker)).toBe(false);
  });

  /** Plant everything an agent could write into the shared clone to hijack the push. */
  function plant(): string {
    const marker = join(tmp, 'pwned');
    const evilHooks = join(tmp, 'evil-hooks');
    mkdirSync(evilHooks, { recursive: true });
    for (const h of ['pre-push', 'reference-transaction', 'post-checkout']) {
      writeFileSync(join(evilHooks, h), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(evilHooks, h), 0o755);
    }
    writeFileSync(join(tmp, 'evil.gitconfig'), `[url "${attacker}"]\n\tinsteadOf = ${origin}\n`);
    const set = (k: string, v: string) => git(clone, 'config', '--add', k, v);
    set('remote.origin.url', attacker);
    set('remote.origin.pushurl', attacker);
    set(`url.${attacker}.insteadOf`, origin);
    set(`url.${attacker}.pushInsteadOf`, origin);
    set('core.hooksPath', evilHooks);
    set('credential.helper', `!touch ${marker}`);
    set('core.sshCommand', `touch ${marker}`);
    set('core.fsmonitor', `touch ${marker}`);
    set('uploadpack.packObjectsHook', `touch ${marker}`);
    set('include.path', join(tmp, 'evil.gitconfig'));
    return marker;
  }

  it("the push never reads the shared clone's config: planted redirects and hooks are ignored", async () => {
    const marker = plant();
    const r = await openPr(input());
    expect(r.ok).toBe(true);
    expect(hasBranch(origin)).toBe(true);
    expect(hasBranch(attacker)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("a config change racing between the fetch and the push can't matter", async () => {
    let marker = '';
    const r = await openPr(input({ afterFetch: () => (marker = plant()) }));
    expect(r.ok).toBe(true);
    expect(marker).not.toBe('');
    expect(hasBranch(origin)).toBe(true);
    expect(hasBranch(attacker)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("the push repo is daemon-private (under <root>/private) with git's minimal config", async () => {
    await openPr(input());
    const priv = privateRepoPath(ghCwd, origin);
    expect(priv.startsWith(join(ghCwd, 'private'))).toBe(true);
    const keys = git(priv, 'config', '--local', '--list')
      .trim()
      .split('\n')
      .map((l) => l.split('=')[0]);
    for (const k of keys) expect(k).toMatch(/^core\./);
    expect(git(priv, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(
      git(worktree, 'rev-parse', 'HEAD').trim(),
    );
  });

  it('a non-allowlisted repo (local path, another host) is a clear error, nothing pushed', async () => {
    const local = await openPr(input({ policy: { allowLocalRepos: false } }));
    expect(!local.ok && local.error).toMatch(/local/);
    expect(hasBranch(origin)).toBe(false);
    const other = await openPr(input({ repo: 'https://gitlab.com/o/r.git' }));
    expect(!other.ok && other.error).toContain('is not a GitHub repository');
    expect(ghCalls()).toEqual([]);
  });

  it('pushTarget: GitHub over https / ssh only, owner/name for gh', () => {
    expect(pushTarget('github.com/benjgrad/app', {})).toEqual({
      url: 'https://github.com/benjgrad/app.git',
      ghRepo: 'benjgrad/app',
      local: false,
    });
    expect(pushTarget('git@github.com:benjgrad/app.git', {}).ghRepo).toBe('benjgrad/app');
    expect(
      pushTarget('https://ghe.acme.io/o/r', { allowedRepoHosts: ['ghe.acme.io'] }).ghRepo,
    ).toBe('ghe.acme.io/o/r');
    expect(() => pushTarget('https://gitlab.com/o/r', {})).toThrow(/not a GitHub repository/);
    expect(() => pushTarget('/tmp/x.git', {})).toThrow();
    expect(() => pushTarget('ext::sh -c touch', {})).toThrow();
  });
});
