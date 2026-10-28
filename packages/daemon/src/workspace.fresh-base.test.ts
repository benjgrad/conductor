// M2-T13a (TD-026 / U-030): a new session's worktree is based on the freshly fetched
// origin/<default_branch>, never on the shared clone's stale HEAD.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonStore } from './store.js';
import { isSafeBranchName, Workspace } from './workspace.js';

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

describe('Workspace fresh base (M2-T13a)', () => {
  let dir: string;
  let origin: string;
  let author: string;
  let ws: Workspace;

  /** Commit `file` in the author checkout and push it to origin; returns the commit sha. */
  function push(file: string): string {
    writeFileSync(join(author, file), `${file}\n`);
    run(author, 'add', file);
    run(author, 'commit', '-q', '-m', file);
    run(author, 'push', '-q', 'origin', 'HEAD:trunk');
    return run(author, 'rev-parse', 'HEAD');
  }

  const start = (sessionId: string, branch = `conductor/t/${sessionId}`) =>
    ws.ensureWorktree({ repo: origin, sessionId, branch, baseRef: 'HEAD' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fresh-base-'));
    origin = join(dir, 'origin.git');
    author = join(dir, 'author');
    // A non-"main" default branch, so the test proves origin/HEAD is followed.
    run(dir, 'init', '-q', '--bare', '--initial-branch=trunk', origin);
    run(dir, 'clone', '-q', origin, author);
    run(author, 'checkout', '-q', '-b', 'trunk');
    push('first.txt');
    const root = join(dir, 'root');
    ws = new Workspace(root, DaemonStore.forRoot(root), { allowLocalRepos: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bases each new session on the fetched default branch; a resume is not rebased', async () => {
    // Clone on first use, then push X: the clone is now stale.
    const clone = await ws.ensureClone(origin);
    const staleHead = run(clone, 'rev-parse', 'HEAD');
    const x = push('x.txt');

    const wt1 = await start('s1');
    expect(run(wt1, 'rev-parse', 'HEAD')).toBe(x);
    // The shared clone's own checkout is untouched (agents never edit it).
    expect(run(clone, 'rev-parse', 'HEAD')).toBe(staleHead);
    // No upstream tracking to origin/trunk: a bare `git push` can't target the default branch.
    expect(() => run(wt1, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();

    const y = push('y.txt');
    const wt2 = await start('s2');
    expect(run(wt2, 'rev-parse', 'HEAD')).toBe(y);

    // Resume of s1 (same session id): the same worktree, still at X, not rebased onto Y.
    push('z.txt');
    expect(await start('s1')).toBe(wt1);
    expect(run(wt1, 'rev-parse', 'HEAD')).toBe(x);

    // An existing branch without a worktree (re-sent start after a lost worktree) is reused as is.
    run(clone, 'worktree', 'remove', '--force', wt2);
    expect(await start('s2')).toBe(wt2);
    expect(run(wt2, 'rev-parse', 'HEAD')).toBe(y);
  });

  it('uses an explicit default branch when one is given', async () => {
    await ws.ensureClone(origin);
    run(author, 'checkout', '-q', '-b', 'release');
    writeFileSync(join(author, 'r.txt'), 'r\n');
    run(author, 'add', 'r.txt');
    run(author, 'commit', '-q', '-m', 'r');
    run(author, 'push', '-q', 'origin', 'release');
    const r = run(author, 'rev-parse', 'HEAD');
    const wt = await ws.ensureWorktree({
      repo: origin,
      sessionId: 's1',
      branch: 'conductor/t/s1',
      baseRef: 'HEAD',
      defaultBranch: 'release',
    });
    expect(run(wt, 'rev-parse', 'HEAD')).toBe(r);
    await expect(
      ws.ensureWorktree({
        repo: origin,
        sessionId: 's2',
        branch: 'conductor/t/s2',
        baseRef: 'HEAD',
        defaultBranch: '-oops',
      }),
    ).rejects.toThrow(/invalid git ref/);
    await expect(
      ws.ensureWorktree({
        repo: origin,
        sessionId: 's3',
        branch: 'conductor/t/s3',
        baseRef: 'HEAD',
        defaultBranch: 'a..b',
      }),
    ).rejects.toThrow(/invalid default branch for .*origin\.git/);
  });

  it('isSafeBranchName accepts usual names and refuses refspec tricks', () => {
    for (const ok of ['main', 'trunk', 'release/1.2', 'feature_x-y']) {
      expect(isSafeBranchName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '-x',
      '/x',
      'x/',
      'a..b',
      'a//b',
      'a/.b',
      'x.lock',
      'a.lock/b',
      'x.',
      'a:b',
      'a b',
      'a*',
      '+x',
      'a~1',
      'a^',
      'a@{1}',
      '.x',
    ]) {
      expect(isSafeBranchName(bad), bad).toBe(false);
    }
  });

  it('sets origin/HEAD once when the clone lacks it', async () => {
    const clone = await ws.ensureClone(origin);
    run(clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    const x = push('x.txt');
    const wt = await start('s1');
    expect(run(wt, 'rev-parse', 'HEAD')).toBe(x);
    expect(run(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
      'refs/remotes/origin/trunk',
    );
  });

  it('fails the start with an error naming the repo when origin is unreachable', async () => {
    await ws.ensureClone(origin);
    rmSync(origin, { recursive: true, force: true });
    const err = await start('s1').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(origin);
    expect(err!.message).toMatch(/fetch origin trunk failed/);
    // Nothing was created from the stale clone.
    expect(existsSync(ws.worktreePath('s1'))).toBe(false);
  });

  describe('concurrent starts', () => {
    let savedPath: string | undefined;
    let fetchLog: string;

    beforeEach(() => {
      // A `git` wrapper first on PATH: records fetch start/end and holds each fetch for 300 ms,
      // so overlapping fetches would show up as two starts in a row.
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      fetchLog = join(dir, 'fetch.log');
      writeFileSync(fetchLog, '');
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(bin, 'git'),
        [
          '#!/bin/sh',
          'case " $* " in',
          `  *" fetch "*) echo start >> '${fetchLog}'; sleep 0.3; '${realGit}' "$@"; rc=$?; echo end >> '${fetchLog}'; exit $rc ;;`,
          'esac',
          `exec '${realGit}' "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'git'), 0o755);
      savedPath = process.env['PATH'];
      process.env['PATH'] = `${bin}${delimiter}${savedPath ?? ''}`;
    });
    afterEach(() => {
      process.env['PATH'] = savedPath;
    });

    it('runs one fetch at a time per repo and both sessions get the fresh base', async () => {
      await ws.ensureClone(origin);
      const x = push('x.txt');
      const [a, b, c] = await Promise.all([start('s1'), start('s2'), start('s3')]);
      for (const wt of [a, b, c]) expect(run(wt, 'rev-parse', 'HEAD')).toBe(x);
      const events = readFileSync(fetchLog, 'utf8').trim().split('\n');
      expect(events).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    });
  });
});
