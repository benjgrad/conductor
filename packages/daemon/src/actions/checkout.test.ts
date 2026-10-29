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
import {
  detectPackageManager,
  detectSetup,
  freshCheckout,
  managedCommand,
  missingManager,
  removeCheckout,
  sweepPrivate,
} from './checkout.js';
import { assertOwnerOnly, mkdirPrivate } from '../platform/index.js';
import { writeFakeBin } from '../test-support/fake-bin.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

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
  mkdirPrivate(tmp);
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
  mkdirPrivate(root); // as the daemon does at start; <root>/private needs a private parent
});

afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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
    if (onWin32) assertOwnerOnly(r.dir, { kind: 'dir' });
    else expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(r.dir, 'health.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'committed\n',
    );
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
    expect(readFileSync(join(r.dir, 'health.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'committed\n',
    );
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

// M2-T30: the install and the npm-style checks follow the committed lockfile.
describe('package manager from the lockfile', () => {
  const repoWith = (...files: string[]) => {
    const d = mkdtempSync(join(tmp, 'repo-'));
    for (const f of files) writeFileSync(join(d, f), f === 'package.json' ? '{}' : '');
    return d;
  };

  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn', 'yarn install --immutable'],
    ['package-lock.json', 'npm', 'npm ci'],
  ] as const)('%s → %s, setup `%s`', (lockfile, manager, install) => {
    const d = repoWith('package.json', lockfile);
    expect(detectPackageManager(d)).toEqual({ manager, lockfile, install });
    expect(detectSetup(d, null)).toBe(install);
    // Configured setup still wins; '' = none.
    expect(detectSetup(d, 'make deps')).toBe('make deps');
    expect(detectSetup(d, '')).toBeNull();
  });

  it('no lockfile: package.json → npm install; neither → no setup', () => {
    expect(detectPackageManager(repoWith('package.json'))).toEqual({
      manager: 'npm',
      lockfile: null,
      install: 'npm install',
    });
    expect(detectSetup(repoWith('package.json'), null)).toBe('npm install');
    expect(detectPackageManager(repoWith('Makefile'))).toBeNull();
    expect(detectSetup(repoWith('Makefile'), null)).toBeNull();
  });

  it('pnpm wins over the other lockfiles, yarn over package-lock.json', () => {
    const all = repoWith('package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml');
    expect(detectPackageManager(all)?.manager).toBe('pnpm');
    const two = repoWith('package.json', 'package-lock.json', 'yarn.lock');
    expect(detectPackageManager(two)?.manager).toBe('yarn');
  });

  it('runs npm-style checks with the repo’s manager; npm and non-Node repos unchanged', () => {
    const pnpm = repoWith('package.json', 'pnpm-lock.yaml');
    expect(managedCommand(pnpm, 'npm run build')).toBe('pnpm run build');
    expect(managedCommand(pnpm, 'npm test')).toBe('pnpm test');
    expect(managedCommand(pnpm, 'npm run-script lint')).toBe('pnpm run lint');
    expect(managedCommand(pnpm, 'npm run build && npm test -- --run')).toBe(
      'pnpm run build && pnpm test -- --run',
    );
    expect(managedCommand(pnpm, 'npm ci; npm run x')).toBe('npm ci; pnpm run x');
    // Only segment starts: an argument that mentions npm is left alone.
    expect(managedCommand(pnpm, 'echo npm run build')).toBe('echo npm run build');
    expect(managedCommand(pnpm, 'npm testing')).toBe('npm testing');
    const yarn = repoWith('package.json', 'yarn.lock');
    expect(managedCommand(yarn, 'npm run build')).toBe('yarn run build');
    expect(managedCommand(yarn, 'npm test')).toBe('yarn test');
    expect(managedCommand(repoWith('package.json', 'package-lock.json'), 'npm test')).toBe(
      'npm test',
    );
    expect(managedCommand(repoWith('package.json'), 'npm run build')).toBe('npm run build');
    expect(managedCommand(repoWith('Makefile'), 'npm run build')).toBe('npm run build');
  });

  it('names a package manager missing from PATH; present ones and other commands pass', () => {
    const bin = mkdtempSync(join(tmp, 'bin-'));
    writeFakeBin(bin, 'npm', ''); // win32: npm.cmd, found through PATHEXT
    writeFileSync(join(bin, 'yarn'), 'not executable\n', { mode: 0o644 });
    expect(missingManager('npm test', bin)).toBeNull();
    expect(missingManager('make test', bin)).toBeNull();
    const msg = missingManager('pnpm install --frozen-lockfile', bin);
    expect(msg).toContain('`pnpm` is not on this machine');
    expect(msg).toContain('install pnpm');
    expect(missingManager('yarn run build && pnpm test', bin)).toContain('`yarn` and `pnpm` are');
    expect(missingManager('npm test', '')).toContain('`npm`');
  });
});
