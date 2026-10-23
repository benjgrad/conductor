// The ADR-0006 edit-guard hook, run as Claude Code runs it: the settings' command through a
// shell, PreToolUse JSON on stdin, exit 2 = blocked (any other non-zero would let the edit through).
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDIT_GUARD_MATCHER, writeEditGuard } from './edit-guard.js';

interface GuardSettings {
  disableAllHooks: boolean;
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
}

let dir: string;
let wt: string;
let guardDir: string;
let settings: GuardSettings;
let command: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "edit guard's $x-"))); // space, quote, $ in path
  wt = join(dir, 'wt');
  mkdirSync(wt);
  guardDir = join(dir, 'guard');
  mkdirSync(guardDir);
  settings = JSON.parse(readFileSync(writeEditGuard(guardDir, wt), 'utf8')) as GuardSettings;
  command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runRaw(input: string) {
  const r = spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}
const run = (toolInput: Record<string, unknown>, cwd: unknown = wt) =>
  runRaw(JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_input: toolInput }));

describe('edit guard settings', () => {
  it('matches the file tools and pins disableAllHooks off (QA: a settings file could disable it)', () => {
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe(EDIT_GUARD_MATCHER);
    expect(command.startsWith(`'${process.execPath}'`)).toBe(true);
    expect(command.endsWith(' || exit 2')).toBe(true);
  });

  it('writes the script and settings 0600', () => {
    expect(statSync(join(guardDir, 'edit-guard.mjs')).mode & 0o777).toBe(0o600);
    expect(statSync(join(guardDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });
});

describe('edit guard', () => {
  it('allows absolute paths inside the worktree, including new files in new directories', () => {
    expect(run({ file_path: join(wt, 'src', 'deep', 'new.ts') }).code).toBe(0);
    expect(run({ file_path: `${wt}/a/../b.txt` }).code).toBe(0);
    expect(run({ notebook_path: join(wt, 'n.ipynb') }).code).toBe(0);
  });

  it('blocks paths outside the worktree with exit 2 and a reason', () => {
    for (const p of [join(dir, 'outside.txt'), join(wt, '..', 'x'), '/etc/hosts', `${wt}-sib/x`]) {
      const r = run({ file_path: p });
      expect(r.code, p).toBe(2);
      expect(r.stderr).toMatch(/limited to the session worktree/);
    }
  });

  it('expands ~ like Claude Code and blocks home paths; refuses relative paths', () => {
    expect(run({ file_path: '~/.zshrc' }).code).toBe(2);
    expect(run({ file_path: '~' }).code).toBe(2);
    expect(homedir()).not.toBe(wt);
    const rel = run({ file_path: 'README.md' });
    expect(rel.code).toBe(2);
    expect(rel.stderr).toMatch(/must be absolute/);
  });

  it('follows symlinks: to an existing dir, to a missing target, and `..` after a link', () => {
    mkdirSync(join(dir, 'secret'));
    symlinkSync(join(dir, 'secret'), join(wt, 'link'));
    expect(run({ file_path: join(wt, 'link', 'id_rsa') }).code).toBe(2);

    symlinkSync(join(dir, 'not-yet', 'f.txt'), join(wt, 'dangling')); // Write would create it
    expect(run({ file_path: join(wt, 'dangling') }).code).toBe(2);

    mkdirSync(join(dir, 'secret', 'sub'));
    symlinkSync(join(dir, 'secret', 'sub'), join(wt, 'lnk'));
    expect(run({ file_path: `${wt}/lnk/../evil` }).code).toBe(2); // the kernel: secret/evil

    symlinkSync('inner', join(wt, 'rel-link')); // a relative link that stays inside
    expect(run({ file_path: join(wt, 'rel-link', 'f') }).code).toBe(0);
  });

  it('checks every path field, not just the first', () => {
    expect(run({ file_path: join(wt, 'ok'), notebook_path: join(dir, 'out.ipynb') }).code).toBe(2);
  });

  it('fails closed: bad input, odd types, a guard crash, a missing script', () => {
    expect(run({}).code).toBe(2);
    expect(run({ file_path: 42 }).code).toBe(2);
    expect(runRaw('not json').code).toBe(2);
    expect(runRaw('null').code).toBe(2);
    rmSync(join(guardDir, 'edit-guard.mjs'));
    expect(run({ file_path: join(wt, 'ok') }).code).toBe(2);
  });
});
