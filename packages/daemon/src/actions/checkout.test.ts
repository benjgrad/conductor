import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSetup, freshCheckout, removeCheckout, sweepPrivate } from './checkout.js';

// ADR-0010 (Ben, 2026-10-26): entry checks run in a fresh, conductor-owned checkout of the exact
// commit. A shared clone + session worktree like the daemon's, with a planted filter driver.

const BRANCH = 'conductor/ticket/abcd1234';
let tmp: string;
let clone: string;
let worktree: string;
let root: string;
let head: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const commit = (cwd: string, msg: string) =>
  git(cwd, '-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '--quiet', '-m', msg);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-checkout-')));
  const origin = join(tmp, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(origin, 'package.json'), '{"name":"x","version":"0.0.0"}\n');
  writeFileSync(join(origin, '.gitignore'), 'ignored/\n');
  git(origin, 'add', '.');
  commit(origin, 'init');
  clone = join(tmp, 'clone');
  git(tmp, 'clone', '--quiet', origin, clone);
  worktree = join(tmp, 'wt');
  git(clone, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree);
  writeFileSync(join(worktree, 'health.txt'), 'committed\n');
  git(worktree, 'add', '.');
  commit(worktree, 'health');
  head = git(worktree, 'rev-parse', 'HEAD').trim();
  root = join(tmp, 'daemon-root');
  mkdirSync(root);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const fresh = (sha = head) => freshCheckout({ root, worktree, branch: BRANCH, sha });

describe('freshCheckout', () => {
  it('checks out exactly the commit in a 0700 dir under <root>/private, not the worktree', async () => {
    // Worktree-only state the checks must not see: an ignored file, an uncommitted edit.
    mkdirSync(join(worktree, 'ignored'));
    writeFileSync(join(worktree, 'ignored', 'make-tests-pass'), 'x');
    writeFileSync(join(worktree, 'health.txt'), 'uncommitted\n');
    const r = await fresh();
    if (!r.ok) throw new Error(r.error);
    expect(r.dir.startsWith(join(root, 'private', 'check-'))).toBe(true);
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(r.dir, 'health.txt'), 'utf8')).toBe('committed\n');
    expect(existsSync(join(r.dir, 'ignored', 'make-tests-pass'))).toBe(false);
    expect(git(r.dir, 'rev-parse', 'HEAD').trim()).toBe(head);
    // Its config is git's minimal defaults.
    const keys = git(r.dir, 'config', '--local', '--list')
      .trim()
      .split('\n')
      .map((l) => l.split('=')[0]!);
    for (const k of keys) expect(k).toMatch(/^(core\.|remote\.|branch\.)/);
    removeCheckout(r.dir);
    expect(existsSync(r.dir)).toBe(false);
  });

  it('a filter driver / hooks planted in the shared clone do not execute', async () => {
    const marker = join(tmp, 'pwned');
    // The commit itself asks for the filter (attributes are content; drivers are config).
    writeFileSync(join(worktree, '.gitattributes'), '* filter=evil\n');
    git(worktree, 'add', '.gitattributes');
    commit(worktree, 'attributes');
    const sha = git(worktree, 'rev-parse', 'HEAD').trim();
    // Then the agent plants the driver and a hook in the shared clone's config.
    git(clone, 'config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`);
    git(clone, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`);
    git(clone, 'config', 'core.hooksPath', tmp);
    writeFileSync(join(tmp, 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
    const r = await fresh(sha);
    if (!r.ok) throw new Error(r.error);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(r.dir, 'health.txt'), 'utf8')).toBe('committed\n');
  });

  it('refuses when the branch tip is not the commit to check (reports the tip), leaving nothing', async () => {
    writeFileSync(join(worktree, 'later.txt'), 'x');
    git(worktree, 'add', '.');
    commit(worktree, 'later');
    const tip = git(worktree, 'rev-parse', 'HEAD').trim();
    const r = await fresh(head);
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('the branch moved') as unknown,
      head: tip,
    });
    expect(readdirSync(join(root, 'private'))).toEqual([]);
  });

  it('setup: configured, "" = none, else auto-detect (lockfile → npm ci, package.json → npm install)', async () => {
    const r = await fresh();
    if (!r.ok) throw new Error(r.error);
    expect(detectSetup(r.dir, null)).toBe('npm install');
    writeFileSync(join(r.dir, 'package-lock.json'), '{}');
    expect(detectSetup(r.dir, null)).toBe('npm ci');
    expect(detectSetup(r.dir, '')).toBeNull();
    expect(detectSetup(r.dir, 'make deps')).toBe('make deps');
    expect(detectSetup(tmp, null)).toBeNull();
  });

  it('sweepPrivate does not follow a symlinked <root>/private', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(join(elsewhere, 'check-victim'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'private'));
    sweepPrivate(root);
    expect(existsSync(join(elsewhere, 'check-victim'))).toBe(true);
  });

  it('sweepPrivate removes leftovers of a previous daemon', async () => {
    const r = await fresh();
    if (!r.ok) throw new Error(r.error);
    mkdirSync(join(root, 'private', 'push-old'));
    sweepPrivate(root);
    expect(readdirSync(join(root, 'private'))).toEqual([]);
  });
});
