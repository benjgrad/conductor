import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirPrivate } from '../platform/index.js';
import { envWithPath, pathWith, writeFakeBin } from '../test-support/fake-bin.js';
import { openPr, type OpenPrInput } from './open-pr.js';

// M2-T10: open_pr refuses a gh older than GH_MIN_VERSION (2.40.0, U-076) before anything is
// pushed. The fake `gh` is an executable on PATH (no `gh` override), as the daemon finds it.

const FAKE_GH = `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_GH_DIR, 'gh-calls'), a.join(' ') + '\\n');
const is = (x, y) => a[0] === x && (y === undefined || a[1] === y);
if (is('--version')) { console.log(process.env.FAKE_GH_VERSION_OUT); process.exit(0); }
if (is('repo', 'view')) { console.log('main'); process.exit(0); }
if (is('pr', 'view')) { console.error('no pull requests found'); process.exit(1); }
if (is('pr', 'create')) { console.log('https://github.com/benjgrad/fixture-app/pull/7'); process.exit(0); }
process.exit(2);
`;

const BRANCH = 'conductor/ticket/abcd1234';
let tmp: string;
let origin: string;
let worktree: string;
let bin: string;
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const pushed = () => {
  try {
    git(origin, 'rev-parse', '--verify', `refs/heads/${BRANCH}`);
    return true;
  } catch {
    return false;
  }
};
const calls = () => {
  const f = join(tmp, 'gh-calls');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-gh-version-')));
  mkdirPrivate(tmp);
  origin = join(tmp, 'origin.git');
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const seed = join(tmp, 'seed');
  git(tmp, 'clone', '--quiet', origin, seed);
  writeFileSync(join(seed, 'README.md'), '# x\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  const clone = join(tmp, 'clone');
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
    'health',
  );
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFakeBin(bin, 'gh', FAKE_GH);
  root = join(tmp, 'daemon-root');
  mkdirPrivate(root);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function input(versionOut: string): OpenPrInput {
  return {
    worktree,
    branch: BRANCH,
    repo: origin,
    policy: { allowLocalRepos: true },
    title: 'Add /health',
    body: 'Opened by conductor.',
    root,
    expectedSha: git(worktree, 'rev-parse', 'HEAD').trim(),
    env: {
      ...envWithPath(process.env, pathWith(bin, process.env.PATH ?? '')),
      FAKE_GH_DIR: tmp,
      FAKE_GH_VERSION_OUT: versionOut,
    },
  };
}

describe('open_pr gh version floor (M2-T10)', () => {
  it('gh 2.14.0 → refused with the upgrade message; nothing is pushed', async () => {
    const r = await openPr(input('gh version 2.14.0 (2022-07-20)'));
    expect(r).toEqual({
      ok: false,
      error: 'gh ≥ 2.40.0 required (found 2.14.0): upgrade gh, e.g. brew upgrade gh',
    });
    expect(pushed()).toBe(false);
    expect(calls()).toEqual(['--version']);
  });

  it('an unparsable version is refused too; nothing is pushed', async () => {
    const r = await openPr(input('gh version unknown'));
    expect(!r.ok && r.error).toContain('gh ≥ 2.40.0 required (found gh version unknown)');
    expect(pushed()).toBe(false);
  });

  it.each(['2.40.0', '2.103.3'])('gh %s proceeds: pushed and the PR opened', async (v) => {
    const r = await openPr(input(`gh version ${v} (2025-01-01)`));
    expect(r).toEqual({
      ok: true,
      url: 'https://github.com/benjgrad/fixture-app/pull/7',
      reused: false,
    });
    expect(pushed()).toBe(true);
    expect(calls()[0]).toBe('--version');
  });
});
