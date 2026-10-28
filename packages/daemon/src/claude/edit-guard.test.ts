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
import { assertOwnerOnly, mkdirPrivate, workflowShell } from '../platform/index.js';
import { EDIT_GUARD_MATCHER, writeEditGuard } from './edit-guard.js';

const onWin32 = process.platform === 'win32';
const CMD = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');

interface GuardSettings {
  disableAllHooks: boolean;
  env: Record<string, string>;
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
}

let dir: string;
let wt: string;
let guardDir: string;
let settings: GuardSettings;
let command: string;

beforeEach(() => {
  // A space and a quote in the path (and `$` on POSIX; win32 refuses `$`, see platform/hook.ts).
  dir = realpathSync(mkdtempSync(join(tmpdir(), onWin32 ? "edit guard's x-" : "edit guard's $x-")));
  mkdirPrivate(dir);
  wt = join(dir, 'wt');
  mkdirSync(wt);
  guardDir = join(dir, 'guard');
  mkdirPrivate(guardDir);
  settings = JSON.parse(readFileSync(writeEditGuard(guardDir, wt), 'utf8')) as GuardSettings;
  command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the hook command through every shell Claude Code might use for it: sh on POSIX; on win32
 * both cmd.exe and Git Bash (U-104), which must agree.
 */
function runRaw(input: string, cmd = command) {
  const shells: [string, string[], boolean][] = onWin32
    ? [
        [CMD, ['/d', '/s', '/c', `"${cmd}"`], true],
        [workflowShell().file, ['-c', cmd], false],
      ]
    : [['/bin/sh', ['-c', cmd], false]];
  const rs = shells.map(([file, args, verbatim]) =>
    spawnSync(file, args, { input, encoding: 'utf8', windowsVerbatimArguments: verbatim }),
  );
  expect(new Set(rs.map((r) => r.status)).size, 'every shell gives the same exit code').toBe(1);
  return { code: rs[0]!.status, stderr: rs[0]!.stderr };
}
const run = (toolInput: Record<string, unknown>, cwd: unknown = wt) =>
  runRaw(JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_input: toolInput }));

describe('edit guard settings', () => {
  it('matches the file tools and pins the hook kill switches off (disableAllHooks, safe mode)', () => {
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.env).toEqual({ CLAUDE_CODE_SAFE_MODE: '0' });
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe(EDIT_GUARD_MATCHER);
    expect(
      command.startsWith(
        onWin32 ? `"${process.execPath.replace(/\\/g, '/')}"` : `'${process.execPath}'`,
      ),
    ).toBe(true);
    expect(command.endsWith(' || exit 2')).toBe(true);
  });

  it('writes the script and settings 0600 (win32: owner-only DACL)', () => {
    for (const f of ['edit-guard.mjs', 'settings.json']) {
      if (onWin32) assertOwnerOnly(join(guardDir, f), { kind: 'file' });
      else expect(statSync(join(guardDir, f)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(onWin32)('a path cmd.exe or Git Bash would reinterpret is refused at setup', () => {
    for (const bad of ['C:\\a%PATH%b', 'C:\\a!b', 'C:\\a^b', 'C:\\a$b', 'C:\\a"b']) {
      const g = join(dir, `g-${bad.length}-${bad.charCodeAt(4)}`);
      mkdirPrivate(g);
      expect(() => writeEditGuard(g, bad)).toThrow(/cannot build the edit-guard hook/);
    }
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
    // POSIX: the kernel follows lnk first (secret/evil). win32 normalises `..` textually first, so
    // it really is wt/evil there.
    expect(run({ file_path: `${wt}/lnk/../evil` }).code).toBe(onWin32 ? 0 : 2);

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

  it('fails closed when node itself is missing (only exit 2 blocks)', () => {
    const g = join(dir, 'guard-no-node');
    mkdirPrivate(g);
    const noNode = onWin32 ? 'C:\\nope\\node.exe' : '/nope/node';
    const s2 = JSON.parse(readFileSync(writeEditGuard(g, wt, noNode), 'utf8')) as GuardSettings;
    const cmd = s2.hooks.PreToolUse[0]!.hooks[0]!.command;
    const input = JSON.stringify({ tool_input: { file_path: join(wt, 'ok') } });
    expect(runRaw(input, cmd).code).toBe(2);
  });
});

/** The 8.3 short form of an existing path (the long one when 8.3 names are off). */
function shortPath(p: string): string {
  const r = spawnSync(CMD, ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  return r.stdout.trim();
}

// ADR-0024 §6 / MW-T08: every out-of-worktree form is blocked (fail-closed), every inside one is
// allowed, under cmd.exe and Git Bash alike.
describe.runIf(onWin32)('edit guard path forms (win32)', () => {
  it('allows and blocks the right path forms', () => {
    mkdirSync(join(dir, 'secret'));
    mkdirSync(join(dir, 'long outside name'));
    mkdirSync(join(wt, 'deep', 'deeper'), { recursive: true });
    symlinkSync(join(dir, 'secret'), join(wt, 'j'), 'junction'); // junction out
    symlinkSync(join(wt, 'deep'), join(wt, 'k'), 'junction'); // junction in
    symlinkSync(join(wt, 'deep', 'deeper'), join(wt, 'a'), 'junction');
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const otherDrive = /^[cC]/.test(wt) ? 'D:\\x.txt' : 'C:\\x.txt';
    const rows: [string, 0 | 2][] = [
      [join(wt, 'a.txt'), 0],
      [`${fwd(wt)}/b.txt`, 0],
      [`${wt.toUpperCase()}\\c.txt`, 0],
      [`${wt.toLowerCase()}\\d.txt`, 0],
      [`${wt}\\x\\..\\e.txt`, 0],
      [`${wt}\\.\\f.txt`, 0],
      [`${wt}\\new\\dir\\g.txt`, 0],
      [`${fwd(wt)}/sub\\h.txt`, 0],
      [join(wt, 'k', 'y.txt'), 0], // a junction that stays inside
      [`${wt}.\\i.txt`, 0], // Windows strips the trailing dot: wt\i.txt
      [join(dir, 'outside.txt'), 2],
      [`${wt}\\..\\x`, 2],
      [`${wt}-sib\\x`, 2],
      [`${wt}\\..\\wt-evil\\x`, 2],
      ['C:\\Windows\\System32\\drivers\\etc\\hosts', 2],
      [otherDrive, 2],
      ['\\\\server\\share\\x', 2],
      ['//server/share/x', 2],
      [`\\\\?\\${join(wt, 'x')}`, 2], // even when it names a file inside
      [`\\\\.\\${join(wt, 'x')}`, 2],
      ['\\\\?\\UNC\\server\\share\\x', 2],
      [`\\??\\${join(wt, 'x')}`, 2],
      ['C:x.txt', 2], // drive-relative
      ['\\Windows\\x', 2], // root-relative
      [`${wt}\\file.txt:stream`, 2],
      [`${wt}:stream`, 2],
      [join(wt, 'j', 'x'), 2], // a junction out
      [`${wt}\\a\\..\\..\\x`, 2], // textual `..` first: dir\x, whatever `a` points at
      [join(shortPath(join(dir, 'long outside name')), 'x'), 2],
      ['~\\x', 2],
      ['x.txt', 2],
    ];
    const wrong = rows
      .map(([p, want]) => [p, want, run({ file_path: p }).code] as const)
      .filter(([, want, got]) => got !== want);
    expect(wrong).toEqual([]);
  });
});
