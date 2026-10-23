// The ADR-0006 edit-guard hook, run as Claude Code runs it: the settings' command through a
// shell, PreToolUse JSON on stdin, exit 2 = blocked.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDIT_GUARD_MATCHER, writeEditGuard } from './edit-guard.js';

let dir: string;
let wt: string;
let command: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "edit guard's-"))); // space + quote in the path
  wt = join(dir, 'wt');
  mkdirSync(wt);
  const guardDir = join(dir, 'guard');
  mkdirSync(guardDir);
  const settings = JSON.parse(readFileSync(writeEditGuard(guardDir, wt), 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  expect(settings.hooks.PreToolUse[0]?.matcher).toBe(EDIT_GUARD_MATCHER);
  command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(toolInput: Record<string, unknown>, cwd = wt) {
  const r = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_input: toolInput }),
    encoding: 'utf8',
  });
  return { code: r.status, stderr: r.stderr };
}

describe('edit guard', () => {
  it('allows edits inside the worktree, absolute or relative, including new files', () => {
    expect(run({ file_path: join(wt, 'src', 'new.ts') }).code).toBe(0);
    expect(run({ file_path: 'README.md' }).code).toBe(0);
    expect(run({ notebook_path: join(wt, 'n.ipynb') }).code).toBe(0);
  });

  it('blocks paths outside the worktree with exit 2 and a reason', () => {
    for (const p of [join(dir, 'outside.txt'), '../escape.txt', '/etc/hosts', `${wt}-sibling/x`]) {
      const r = run({ file_path: p });
      expect(r.code, p).toBe(2);
      expect(r.stderr).toMatch(/limited to the session worktree/);
    }
  });

  it('blocks a symlink inside the worktree that points out of it', () => {
    mkdirSync(join(dir, 'secret'));
    symlinkSync(join(dir, 'secret'), join(wt, 'link'));
    expect(run({ file_path: join(wt, 'link', 'id_rsa') }).code).toBe(2);
  });

  it('fails closed on bad input', () => {
    expect(run({}).code).toBe(2);
    const r = spawnSync('/bin/sh', ['-c', command], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  it('the command runs under the daemon node binary', () => {
    expect(command.startsWith(`'${process.execPath}'`)).toBe(true);
  });
});
