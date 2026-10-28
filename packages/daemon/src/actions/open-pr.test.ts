import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkClean, openPr, pushTarget, resolveHead, type OpenPrInput } from './open-pr.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// ADR-0010 open_pr against a local bare repo as the ticket's repo and a fake `gh` first on PATH:
// no network, no GitHub. The fake records argv + cwd and keeps "the PR" in a state file. Includes
// the security review's hardening cases: planted hooks and repo-config redirects don't work.

// The fake gh is a /bin/sh script run as `/bin/sh <script> <args>` (OpenPrInput.gh): spawning
// node per call stalls for seconds under load on this macOS. Each call appends one line: the cwd
// and every argument base64-encoded (bodies have newlines), space-separated.
const FAKE_GH = `
if [ "$1" = --version ]; then echo "gh version \${FAKE_GH_VERSION:-2.103.3} (2025-01-01)"; exit 0; fi
dir="$FAKE_GH_DIR"
line=$(printf '%s' "$PWD" | base64)
for a in "$@"; do line="$line $(printf '%s' "$a" | base64)"; done
echo "$line" >> "$dir/gh-calls"
state="$dir/pr-url"
if [ "$1" = repo ] && [ "$2" = view ]; then echo main; exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  if [ -f "$state" ]; then cat "$state"; echo; exit 0; fi
  echo 'no pull requests found for branch' >&2; exit 1
fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  if [ -n "$FAKE_GH_FAIL" ]; then echo 'HTTP 401: Bad credentials' >&2; exit 1; fi
  url="\${FAKE_GH_URL:-https://github.com/benjgrad/fixture-app/pull/7}"
  printf '%s' "$url" > "$state"
  echo 'Creating pull request...'; echo "$url"; exit 0
fi
exit 2
`;

const BRANCH = 'conductor/ticket/abcd1234';
let tmp: string;
let fakeGh: string;
let worktree: string;
let clone: string;
let origin: string;
let attacker: string;
let ghCwd: string;
/** The worktree HEAD the entry checks "ran on". */
let checked: string;

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

  fakeGh = join(tmp, 'fake-gh.sh');
  writeFileSync(fakeGh, FAKE_GH);
  ghCwd = join(tmp, 'daemon-root');
  mkdirSync(ghCwd);
  checked = git(worktree, 'rev-parse', 'HEAD').trim();
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
    expectedSha: checked,
    gh: { cmd: '/bin/sh', args: [fakeGh] },
    env: { ...process.env, FAKE_GH_DIR: tmp },
    ...over,
  };
}

const unb64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');
const ghCalls = () =>
  existsSync(join(tmp, 'gh-calls'))
    ? readFileSync(join(tmp, 'gh-calls'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          const [cwd = '', ...argv] = l.split(' ').map(unb64);
          return { cwd, argv };
        })
    : [];

// MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
describe.skipIf(onWin32)('open_pr (ADR-0010)', () => {
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
    // The real lookup: `gh` from PATH (no `gh` override).
    const { gh: _gh, ...noGh } = input({ env: { ...process.env, PATH: onlyGit } });
    void _gh;
    const r = await openPr(noGh);
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
  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'an agent-planted pre-push hook in the shared clone does not run',
    async () => {
      const marker = join(tmp, 'hook-ran');
      const hook = join(clone, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
      chmodSync(hook, 0o755);
      const r = await openPr(input());
      expect(r.ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(hasBranch(origin)).toBe(true);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'a rewritten remote.origin.url does not redirect the push (explicit trusted URL)',
    async () => {
      git(clone, 'config', 'remote.origin.url', attacker);
      const r = await openPr(input());
      expect(r.ok).toBe(true);
      expect(hasBranch(origin)).toBe(true);
      expect(hasBranch(attacker)).toBe(false);
    },
  );

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

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    "the push never reads the shared clone's config: planted redirects and hooks are ignored",
    async () => {
      const marker = plant();
      const r = await openPr(input());
      expect(r.ok).toBe(true);
      expect(hasBranch(origin)).toBe(true);
      expect(hasBranch(attacker)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    "a config change racing between the fetch and the push can't matter",
    async () => {
      let marker = '';
      const r = await openPr(input({ afterFetch: () => (marker = plant()) }));
      expect(r.ok).toBe(true);
      expect(marker).not.toBe('');
      expect(hasBranch(origin)).toBe(true);
      expect(hasBranch(attacker)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    "the push repo is a fresh 0700 dir under <root>/private with git's minimal config, deleted after",
    async () => {
      let seen = '';
      let mode = 0;
      let keys: string[] = [];
      const r = await openPr(
        input({
          afterFetch: (priv) => {
            seen = priv;
            mode = statSync(priv).mode & 0o777;
            keys = git(priv, 'config', '--local', '--list')
              .trim()
              .split('\n')
              .map((l) => l.split('=')[0]!);
          },
        }),
      );
      expect(r.ok).toBe(true);
      expect(seen.startsWith(join(ghCwd, 'private', 'push-'))).toBe(true);
      expect(mode).toBe(0o700);
      for (const k of keys) expect(k).toMatch(/^core\./);
      expect(existsSync(seen)).toBe(false);
      expect(readdirSync(join(ghCwd, 'private'))).toEqual([]);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'a symlinked <root>/private is refused (nothing followed, nothing pushed)',
    async () => {
      const elsewhere = join(tmp, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(ghCwd, 'private'));
      const r = await openPr(input());
      expect(!r.ok && r.error).toContain('private push repo');
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(hasBranch(origin)).toBe(false);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)('pushes exactly the checked commit', async () => {
    const r = await openPr(input());
    expect(r.ok).toBe(true);
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(checked);
  });

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'a commit made after the checks makes the action refuse; nothing is pushed',
    async () => {
      writeFileSync(join(worktree, 'sneaky.txt'), 'unchecked\n');
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
        'after the checks',
      );
      const r = await openPr(input());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('the branch moved after the checks');
      expect(hasBranch(origin)).toBe(false);
      expect(ghCalls()).toEqual([]);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)('a gh URL that is not a GitHub PR URL is not reported', async () => {
    const r = await openPr(
      input({ env: { ...input().env, FAKE_GH_URL: 'https://evil.example/x' } }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('unexpected PR URL');
  });

  it('resolveHead reports the worktree HEAD', async () => {
    expect(await resolveHead(worktree)).toBe(checked);
    expect(await resolveHead(tmp)).toBeNull();
  });
});

describe('checkClean (ADR-0010: only committed changes are checked)', () => {
  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)('a clean tree reports its HEAD', async () => {
    expect(await checkClean(worktree)).toEqual({ head: checked, dirty: null });
  });

  it('modified, staged and untracked files are dirty (the status lines); no HEAD', async () => {
    writeFileSync(join(worktree, 'health.txt'), 'changed\n');
    mkdirSync(join(worktree, 'new'));
    writeFileSync(join(worktree, 'new', 'x.txt'), 'x');
    const r = await checkClean(worktree);
    expect(r.head).toBeNull();
    expect(r.dirty).toEqual(expect.arrayContaining([' M health.txt', '?? new/x.txt']));
  });

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(".gitignore'd files (build outputs) do not count", async () => {
    writeFileSync(join(worktree, '.gitignore'), 'dist/\nnode_modules/\n');
    git(worktree, 'add', '.gitignore');
    git(
      worktree,
      '-c',
      'user.email=t@localhost',
      '-c',
      'user.name=t',
      'commit',
      '--quiet',
      '-m',
      'ignore',
    );
    mkdirSync(join(worktree, 'dist'));
    writeFileSync(join(worktree, 'dist', 'out.js'), 'x');
    mkdirSync(join(worktree, 'node_modules', 'a'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'a', 'i.js'), 'x');
    const r = await checkClean(worktree);
    expect(r.dirty).toBeNull();
    expect(r.head).toBe(git(worktree, 'rev-parse', 'HEAD').trim());
  });

  // Final QA (2026-10-26): agent-writable state that hides changes from a plain `git status`.
  it('assume-unchanged hides nothing: dirty', async () => {
    git(worktree, 'update-index', '--assume-unchanged', 'health.txt');
    writeFileSync(join(worktree, 'health.txt'), 'changed\n');
    const r = await checkClean(worktree);
    expect(r.head).toBeNull();
    expect(r.dirty).toEqual(expect.arrayContaining(['hidden (h): health.txt']));
  });

  it('skip-worktree hides nothing: dirty', async () => {
    git(worktree, 'update-index', '--skip-worktree', 'health.txt');
    writeFileSync(join(worktree, 'health.txt'), 'changed\n');
    const r = await checkClean(worktree);
    expect(r.head).toBeNull();
    expect(r.dirty).toEqual(expect.arrayContaining(['hidden (S): health.txt']));
  });

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'an untracked file listed in .git/info/exclude (shared clone) is dirty',
    async () => {
      mkdirSync(join(clone, '.git', 'info'), { recursive: true });
      writeFileSync(join(clone, '.git', 'info', 'exclude'), 'sneaky.txt\n');
      writeFileSync(join(worktree, 'sneaky.txt'), 'x');
      const r = await checkClean(worktree);
      expect(r.head).toBeNull();
      expect(r.dirty).toEqual(['?? sneaky.txt']);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'QA 1a: an uncommitted .gitignore that ignores itself (and a file) is dirty',
    async () => {
      writeFileSync(join(worktree, '.gitignore'), '.gitignore\nsneaky.txt\n');
      writeFileSync(join(worktree, 'sneaky.txt'), 'x');
      const r = await checkClean(worktree);
      expect(r.head).toBeNull();
      expect(r.dirty).toEqual(['?? .gitignore (ignores itself)']);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)('QA 1a: a nested self-ignoring .gitignore is dirty too', async () => {
    mkdirSync(join(worktree, 'deep'));
    writeFileSync(join(worktree, 'deep', '.gitignore'), '*\n');
    writeFileSync(join(worktree, 'deep', 'x.txt'), 'x');
    const r = await checkClean(worktree);
    expect(r.dirty).toEqual(['?? deep/.gitignore (ignores itself)']);
  });

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'QA 1b: submodule changes hidden by submodule.<name>.ignore=all are dirty',
    async () => {
      const sub = join(tmp, 'subrepo');
      mkdirSync(sub);
      git(sub, 'init', '--quiet', '-b', 'main');
      writeFileSync(join(sub, 'a.txt'), '1\n');
      git(sub, 'add', '.');
      git(sub, '-c', 'user.email=t@localhost', '-c', 'user.name=t', 'commit', '--quiet', '-m', 's');
      git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub, 'sub');
      git(
        worktree,
        '-c',
        'user.email=t@localhost',
        '-c',
        'user.name=t',
        'commit',
        '--quiet',
        '-m',
        'sub',
      );
      expect((await checkClean(worktree)).dirty).toBeNull();
      // A change inside the submodule, hidden by agent-writable config.
      writeFileSync(join(worktree, 'sub', 'a.txt'), '2\n');
      git(clone, 'config', 'submodule.sub.ignore', 'all');
      git(clone, 'config', 'diff.ignoreSubmodules', 'all');
      expect(git(worktree, 'status', '--porcelain').trim()).toBe(''); // hidden from a plain status
      const r = await checkClean(worktree);
      expect(r.head).toBeNull();
      expect(r.dirty).toEqual([' M sub']);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'an untracked file matched by a repo-config core.excludesFile is dirty',
    async () => {
      writeFileSync(join(tmp, 'evil-excludes'), 'sneaky.txt\n');
      git(clone, 'config', 'core.excludesFile', join(tmp, 'evil-excludes'));
      writeFileSync(join(worktree, 'sneaky.txt'), 'x');
      const r = await checkClean(worktree);
      expect(r.head).toBeNull();
      expect(r.dirty).toEqual(['?? sneaky.txt']);
    },
  );

  // MW-T07: git env (autocrlf), fake gh and 0700 push repo are POSIX
  it.skipIf(onWin32)(
    'a planted core.fsmonitor / hooks in the shared clone do not run',
    async () => {
      const marker = join(tmp, 'pwned');
      git(clone, 'config', 'core.fsmonitor', `touch ${marker}`);
      git(clone, 'config', 'core.hooksPath', tmp);
      writeFileSync(join(worktree, 'health.txt'), 'changed\n');
      const r = await checkClean(worktree);
      expect(r.dirty).toEqual([' M health.txt']);
      expect(existsSync(marker)).toBe(false);
    },
  );

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
