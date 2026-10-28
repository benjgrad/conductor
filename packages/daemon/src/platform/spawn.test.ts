import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWindowsCommandLine } from './procinfo.js';
import {
  buildCmdLine,
  escapeCmdArg,
  execFileCliSync,
  prepareCli,
  resolveWindowsBin,
  spawnCli,
  type CliSpawnOptions,
} from './spawn.js';

const isWin = process.platform === 'win32';

// Args that break naive quoting: cmd metacharacters, quotes, backslashes before quotes and at the
// end, percent signs that look like variables, delayed-expansion bangs, unicode, the empty string.
const NASTY = [
  'plain',
  'a b',
  'x&y',
  'c^d',
  '%PATH%',
  '%',
  'q"uote',
  'q"&calc',
  'trail\\',
  'back\\"slash',
  'two\\\\"q',
  '!bang!',
  '<in>|out',
  '(paren)',
  '',
  ' ',
  'semi;colon,comma',
  '`tick`',
  '*?[]',
  'C:\\Program Files\\x y\\',
  'é ü 日本',
];

// ---------------------------------------------------------------- pure (run everywhere)

describe('resolveWindowsBin', () => {
  const files = new Set([
    'C:\\npm\\claude.cmd',
    'C:\\npm\\claude.ps1',
    'C:\\bin\\claude.exe',
    'C:\\bin\\claude.cmd',
    'C:\\Git\\cmd\\git.exe',
    'D:\\w\\tools\\run.bat',
    'C:\\Program Files\\Az\\az.cmd',
  ]);
  const isFile = (p: string): boolean => files.has(p);
  const env = { Path: 'rel\\dir;C:\\npm;"C:\\Program Files\\Az";;C:\\bin;C:\\Git\\cmd' };

  it('searches absolute PATH entries in order with PATHEXT order', () => {
    expect(resolveWindowsBin('claude', { env, isFile })).toBe('C:\\npm\\claude.cmd');
    expect(resolveWindowsBin('git', { env, isFile })).toBe('C:\\Git\\cmd\\git.exe');
    expect(resolveWindowsBin('az', { env, isFile })).toBe('C:\\Program Files\\Az\\az.cmd');
  });

  it('honours PATHEXT order and an explicit extension', () => {
    // PATH order wins over PATHEXT order; within one dir, PATHEXT order decides.
    expect(resolveWindowsBin('claude', { env: { PATH: 'C:\\bin' }, isFile })).toBe(
      'C:\\bin\\claude.exe',
    );
    const cmdFirst = { PATH: 'C:\\bin', PATHEXT: '.CMD;.EXE' };
    expect(resolveWindowsBin('claude', { env: cmdFirst, isFile })).toBe('C:\\bin\\claude.cmd');
    expect(resolveWindowsBin('claude.exe', { env, isFile })).toBe('C:\\bin\\claude.exe');
    // .ps1 isn't in PATHEXT, so it isn't runnable and gets extensions appended (none match).
    expect(resolveWindowsBin('claude.ps1', { env, isFile })).toBeNull();
  });

  it('never looks in the cwd for a bare name, and skips relative PATH entries', () => {
    const planted = new Set(['D:\\w\\git.exe', 'D:\\w\\rel\\dir\\gh.exe', 'rel\\dir\\gh.exe']);
    const f = (p: string): boolean => planted.has(p);
    expect(resolveWindowsBin('git', { env, cwd: 'D:\\w', isFile: f })).toBeNull();
    expect(resolveWindowsBin('gh', { env, cwd: 'D:\\w', isFile: f })).toBeNull();
  });

  it('resolves a name with a directory part against cwd only', () => {
    expect(resolveWindowsBin('tools\\run', { env, cwd: 'D:\\w', isFile })).toBe(
      'D:\\w\\tools\\run.bat',
    );
    expect(resolveWindowsBin('C:\\npm\\claude', { env: {}, isFile })).toBe('C:\\npm\\claude.cmd');
    expect(resolveWindowsBin('C:\\nope\\claude', { env, isFile })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(resolveWindowsBin('nope', { env, isFile })).toBeNull();
    expect(resolveWindowsBin('claude', { env: {}, isFile })).toBeNull();
  });
});

describe('escapeCmdArg', () => {
  it('quotes for MSVCRT and caret-escapes metacharacters twice', () => {
    expect(escapeCmdArg('ab')).toBe('^^^"ab^^^"');
    expect(escapeCmdArg('a b')).toBe('^^^"a^^^ b^^^"');
    expect(escapeCmdArg('a"b')).toBe('^^^"a\\^^^"b^^^"');
    expect(escapeCmdArg('x&y')).toBe('^^^"x^^^&y^^^"');
    expect(escapeCmdArg('d\\')).toBe('^^^"d\\\\^^^"');
    expect(escapeCmdArg('')).toBe('^^^"^^^"');
  });

  it('refuses CR, LF and NUL (cmd.exe ends the command at a newline)', () => {
    for (const a of ['a\nb', 'a\rb', 'a\0b']) {
      expect(() => escapeCmdArg(a)).toThrow(/CR, LF or NUL/);
    }
  });
});

/**
 * A model of what cmd.exe does to a line in its special-character phase: outside quotes `^x` is
 * `x` and `&|<>` would split the command (we flag it); inside quotes everything is literal and
 * `"` toggles. Enough to check the escaping survives two passes (cmd /c, then the batch `%*`).
 */
function cmdPass(line: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? '';
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '^') {
      out += line[++i] ?? '';
      continue;
    }
    if (!quoted && '&|<>'.includes(c)) throw new Error(`unescaped ${c} in ${line}`);
    out += c;
  }
  return out;
}

describe('buildCmdLine round trip (cmd model + CommandLineToArgvW)', () => {
  it('delivers every nasty arg intact through cmd /c and a %* batch shim', () => {
    const file = 'C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd';
    const payload = buildCmdLine(file, NASTY);
    // cmd /d /s /c "<payload>": /s strips the outer quotes, then pass 1.
    const pass1 = cmdPass(payload);
    expect(pass1.startsWith(`${file} `)).toBe(true);
    // The shim runs `node "<script>" %*`: %* is the text after the program, parsed again.
    const pass2 = cmdPass(pass1.slice(file.length + 1));
    expect(parseWindowsCommandLine(`node.exe script.mjs ${pass2}`).slice(2)).toEqual(NASTY);
  });

  it('caret-escapes spaces and parens in the program path', () => {
    expect(buildCmdLine('C:/Program Files (x86)/a.cmd', [])).toBe(
      'C:\\Program^ Files^ ^(x86^)\\a.cmd',
    );
  });
});

describe('prepareCli', () => {
  const isFile = (p: string): boolean =>
    p === 'C:\\bin\\gh.exe' || p === 'C:\\npm\\claude.cmd' || p === 'C:\\npm\\az.bat';
  const env = { PATH: 'C:\\bin;C:\\npm', SystemRoot: 'C:\\WINDOWS' };
  const win = { platform: 'win32' as const, isFile };

  it('POSIX: spawn as given, keeps detached, drops shell', () => {
    const opts = { detached: true, cwd: '/w', shell: true } as CliSpawnOptions;
    expect(prepareCli('claude', ['-p', 'a b'], opts, { platform: 'linux' })).toEqual({
      file: 'claude',
      args: ['-p', 'a b'],
      options: { detached: true, cwd: '/w' },
    });
  });

  it('win32: an .exe is spawned directly by absolute path, hidden, never detached', () => {
    const p = prepareCli('gh', ['pr', 'view'], { env, detached: true }, win);
    expect(p).toEqual({
      file: 'C:\\bin\\gh.exe',
      args: ['pr', 'view'],
      options: { env, windowsHide: true },
    });
  });

  it('win32: a .cmd/.bat runs via System32 cmd.exe /d /s /c with verbatim arguments', () => {
    const p = prepareCli('claude', ['--resume', 'x&y'], { env, cwd: 'D:\\w' }, win);
    expect(p?.file).toBe('C:\\WINDOWS\\System32\\cmd.exe');
    expect(p?.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(p?.args[3]).toBe(`"${buildCmdLine('C:\\npm\\claude.cmd', ['--resume', 'x&y'])}"`);
    expect(p?.options).toEqual({
      env,
      cwd: 'D:\\w',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    expect(prepareCli('az', [], { env }, win)?.args[3]).toBe('"C:\\npm\\az.bat"');
  });

  it('win32: an unresolvable bin is null (the caller reports ENOENT)', () => {
    expect(prepareCli('nope', [], { env }, win)).toBeNull();
  });

  it('win32: a multi-line argument for a .cmd throws instead of being truncated', () => {
    expect(() => prepareCli('claude', ['a\nb'], { env }, win)).toThrow(/CR, LF or NUL/);
    // An .exe gets it intact (Node quotes it; no cmd.exe involved).
    expect(prepareCli('gh', ['a\nb'], { env }, win)?.args).toEqual(['a\nb']);
  });
});

// ---------------------------------------------------------------- real processes

/** Run a child to completion; resolve its stdout or reject with its 'error'. */
function run(bin: string, args: string[], opts: CliSpawnOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`)),
    );
  });
}

const ECHO_ARGS = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';

/**
 * A local copy of MW-T01's `writeFakeBin` (not merged yet): POSIX gets an executable
 * `#!/usr/bin/env node` file, win32 `name.mjs` + a `name.cmd` shim that forwards `%*`.
 */
function writeFakeBin(dir: string, name: string, js: string): void {
  if (isWin) {
    writeFileSync(join(dir, `${name}.mjs`), js);
    writeFileSync(join(dir, `${name}.cmd`), `@node "%~dp0${name}.mjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, name), `#!/usr/bin/env node\n${js}`, { mode: 0o755 });
  }
}

/** process.env with PATH replaced (whatever its case) by `dirs` + node's dir. */
function envWithPath(...dirs: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v;
  env.PATH = [...dirs, dirname(process.execPath)].join(delimiter);
  return env;
}

describe('spawnCli (real processes)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-spawn-'));
    writeFakeBin(dir, 'echo-args', ECHO_ARGS);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a bare name resolves through PATH (PATHEXT on win32) and gets metachar args intact', async () => {
    const out = await run('echo-args', NASTY, { env: envWithPath(dir) });
    expect(JSON.parse(out)).toEqual(NASTY);
  });

  it('execFileCliSync does the same synchronously', () => {
    const out = execFileCliSync('echo-args', ['x&y', 'q"uote', '%PATH%'], {
      env: envWithPath(dir),
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual(['x&y', 'q"uote', '%PATH%']);
  });

  it('runs an absolute .exe/binary directly', async () => {
    const echo = 'process.stdout.write(JSON.stringify(process.argv.slice(1)));'; // -e: no script
    const out = await run(process.execPath, ['-e', echo, 'a b', 'x"y']);
    expect(JSON.parse(out)).toEqual(['a b', 'x"y']);
  });

  it('a missing bin fails with an ENOENT error event and no pid', async () => {
    const child = spawnCli('conductor-no-such-bin', ['a'], { env: envWithPath(dir) });
    expect(child.pid).toBeUndefined();
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve));
    expect(err.code).toBe('ENOENT');
    expect(() => execFileCliSync('conductor-no-such-bin', [], { env: envWithPath(dir) })).toThrow(
      expect.objectContaining({ code: 'ENOENT' }) as Error,
    );
  });

  it.runIf(isWin)('win32: a program planted in the cwd is not run for a bare name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'conductor-cwd-'));
    try {
      copyFileSync(process.execPath, join(cwd, 'conductor-planted.exe'));
      const child = spawnCli('conductor-planted', ['-e', '0'], { cwd, env: envWithPath(dir) });
      const err = await new Promise<NodeJS.ErrnoException>((resolve) =>
        child.once('error', resolve),
      );
      expect(err.code).toBe('ENOENT');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
