import {
  ChildProcess,
  execFile,
  execFileSync,
  spawn,
  type ExecFileException,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type SpawnOptions,
} from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

// ADR-0024 §1 (spawn.ts): run a CLI (`claude`, `gh`, `git`, `az`) without a shell on every OS.
//
// POSIX: `spawn(bin, args, opts)` exactly as the call sites do today (they pass `detached: true`
// to get a process group, which kill-tree.ts relies on).
//
// win32:
// - `bin` is resolved through PATH and PATHEXT here, never by libuv: for a bare name libuv
//   searches the child's cwd before PATH, and the cwd is usually an agent-writable worktree (a
//   planted `git.exe` would run). PATH entries that are relative are skipped for the same reason.
// - An `.exe`/`.com` is spawned directly by its absolute path.
// - Anything else (`az.cmd`, test fakes; U-108: never npm's `claude.cmd`) runs as
//   `cmd.exe /d /v:off /s /c "<line>"` with `windowsVerbatimArguments`, because Node refuses to
//   spawn a batch file without a shell since CVE-2024-27980. AutoRun and delayed expansion are
//   off, and the batch file's own bare-name lookups skip the cwd
//   (NoDefaultCurrentDirectoryInExePath). The line is escaped like cross-spawn does (plus `:`,
//   see CMD_META), but the metacharacters are always escaped twice: every batch file we run
//   forwards `%*` to a real program, and `%*` is parsed a second time by cmd (cross-spawn
//   double-escapes only `node_modules\.bin` shims, so it would mangle `"` + `&` for a shim
//   elsewhere, such as `%APPDATA%\npm\*.cmd`).
// - cmd.exe can't carry CR/LF/NUL inside an argument (a newline ends the command), so such an
//   argument is refused with an error rather than truncated or reinterpreted.
// - Always `windowsHide: true`; `detached` is dropped (on Windows it means "own console", not a
//   process group); `shell` is never honoured.

/** spawn options minus `shell`, which is never allowed (MW shared rules). */
export type CliSpawnOptions = Omit<SpawnOptions, 'shell'>;
export type CliExecSyncOptions = Omit<ExecFileSyncOptions, 'shell'>;
export type CliExecOptions = Omit<ExecFileOptions, 'shell' | 'encoding'>;

/** What to hand to `child_process`: the resolved program, its argv and the adjusted options. */
export interface PreparedCli<O> {
  file: string;
  args: string[];
  options: O;
}

/** Injected OS facts, so the win32 logic is testable on Linux. */
export interface PrepareDeps {
  platform?: NodeJS.Platform;
  /** Is `p` an existing regular file? Default: `fs.statSync`. */
  isFile?: (p: string) => boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DIRECT_EXEC = /\.(?:exe|com)$/i;
// cross-spawn's set (cmd.exe metacharacters plus space, which separates tokens, and `"`) plus
// `:`. Percent expansion runs before caret removal, and a variable name ends at `:`, so an
// unescaped `%PATH:a=b%` or `%SECRET:~0%` would expand (substitution syntax) and paste env values
// into argv. With `:` caret-escaped the name always ends in `^` (`PATH^^^`), which no variable
// is called, and cmd leaves an undefined `%…%` span as typed.
const CMD_META = /([()\][%!^"`<>&|;, *?:])/g;
const CMD_UNSAFE = /[\r\n\0]/;

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Case-insensitive env lookup (Windows env names are; `{...process.env}` keeps `Path`). */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && v !== undefined) return v;
  }
  return undefined;
}

/** `%SystemRoot%\System32\<exe>`: system tools are never looked up through PATH or the cwd. */
export function system32(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows';
  return win32.join(root, 'System32', exe);
}

/**
 * Resolve a Windows command name to an absolute file, like cmd.exe would but without the cwd:
 * - a name with a directory part (`.\x`, `C:\x\y`) resolves against `cwd` only;
 * - a bare name is searched in the absolute PATH entries, in order;
 * - a name whose extension is in PATHEXT is tried as-is, otherwise each PATHEXT extension is
 *   appended in order.
 * Returns null when nothing matches.
 */
export function resolveWindowsBin(
  bin: string,
  opts: { env: NodeJS.ProcessEnv; cwd?: string | undefined; isFile?: (p: string) => boolean },
): string | null {
  const isFile = opts.isFile ?? defaultIsFile;
  const exts = (envGet(opts.env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase()) // the file system ignores case; lower reads better
    .filter((e) => e.startsWith('.'));
  const ext = win32.extname(bin).toLowerCase();
  const candidates = (base: string): string[] =>
    ext !== '' && exts.includes(ext) ? [base] : exts.map((e) => base + e);

  if (/[\\/]/.test(bin) || win32.isAbsolute(bin)) {
    const base = opts.cwd !== undefined ? win32.resolve(opts.cwd, bin) : win32.resolve(bin);
    return candidates(base).find(isFile) ?? null;
  }
  for (const raw of (envGet(opts.env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !win32.isAbsolute(dir)) continue;
    const hit = candidates(win32.join(dir, bin)).find(isFile);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** cross-spawn's `escapeCommand`: caret-escape the program path (it is not quoted). */
export function escapeCmdCommand(file: string): string {
  return file.replace(CMD_META, '^$1');
}

/**
 * Quote one argument for the program's own (MSVCRT / CommandLineToArgvW) parser, then
 * caret-escape every cmd metacharacter, including the quotes, twice (see the header): once for
 * `cmd /c` and once for the batch file's `%*`.
 */
export function escapeCmdArg(arg: string): string {
  if (CMD_UNSAFE.test(arg)) {
    throw Object.assign(new Error('spawnCli: an argument for a .cmd/.bat contains CR, LF or NUL'), {
      code: 'ERR_CMD_UNSAFE_ARG',
    });
  }
  // Backslashes before a quote are doubled and the quote escaped; trailing backslashes are
  // doubled (the closing quote follows them).
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** The `/c` payload for running `file args…` through cmd.exe. Pure. */
export function buildCmdLine(file: string, args: readonly string[]): string {
  return [escapeCmdCommand(win32.normalize(file)), ...args.map(escapeCmdArg)].join(' ');
}

/** An ENOENT shaped like the one `spawn` reports for a missing program. */
export function enoent(bin: string, args: readonly string[]): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${bin} ENOENT`), {
    errno: -4058, // UV_ENOENT on Windows
    code: 'ENOENT',
    syscall: `spawn ${bin}`,
    path: bin,
    spawnargs: [...args],
  });
}

/**
 * Work out what to spawn. Returns null on win32 when `bin` doesn't resolve (the caller reports
 * ENOENT). Throws for an argument cmd.exe can't carry.
 */
export function prepareCli<O extends CliSpawnOptions | CliExecSyncOptions | CliExecOptions>(
  bin: string,
  args: readonly string[],
  opts: O,
  deps: PrepareDeps = {},
): PreparedCli<O> | null {
  const platform = deps.platform ?? process.platform;
  const options = { ...opts } as O & { shell?: unknown };
  delete options.shell;
  if (platform !== 'win32') return { file: bin, args: [...args], options };

  delete (options as SpawnOptions).detached;
  options.windowsHide = true;
  const env = opts.env ?? process.env;
  const cwd =
    typeof opts.cwd === 'string' || opts.cwd === undefined ? opts.cwd : fileURLToPath(opts.cwd);
  const resolveOpts = { env, cwd, ...(deps.isFile ? { isFile: deps.isFile } : {}) };
  const file = resolveWindowsBin(bin, resolveOpts);
  if (file === null) return null;
  if (DIRECT_EXEC.test(file)) return { file, args: [...args], options };
  // execFileSync passes it through to spawnSync, which honours it; only its typing lacks it.
  (options as SpawnOptions).windowsVerbatimArguments = true;
  // The batch file runs bare names (`node`, `python`), and cmd looks in the cwd before PATH
  // unless this is set: same hijack as above, one level down.
  options.env = { ...env, NoDefaultCurrentDirectoryInExePath: '1' };
  return {
    file: system32('cmd.exe', env),
    // /d: no AutoRun; /v:off: no `!VAR!` delayed expansion whatever the registry says.
    args: ['/d', '/v:off', '/s', '/c', `"${buildCmdLine(file, args)}"`],
    options,
  };
}

/** A never-spawned child that fails with ENOENT on the next tick, as `spawn` does. */
function missingChild(bin: string, args: readonly string[]): ChildProcess {
  const child = new ChildProcess();
  const streams = child as unknown as Record<'stdin' | 'stdout' | 'stderr', PassThrough>;
  streams.stdin = new PassThrough();
  streams.stdout = new PassThrough();
  streams.stderr = new PassThrough();
  process.nextTick(() => {
    child.emit('error', enoent(bin, args));
    streams.stdout.end();
    streams.stderr.end();
    child.emit('close', -4058, null);
  });
  return child;
}

/**
 * `child_process.spawn` for a CLI, safe on every OS (see the header). A program that can't be
 * found fails the same way on every OS: an `'error'` event with `code: 'ENOENT'` and no pid.
 */
export function spawnCli(
  bin: string,
  args: readonly string[],
  opts: CliSpawnOptions = {},
): ChildProcess {
  const p = prepareCli(bin, args, opts);
  if (p === null) return missingChild(bin, args);
  return spawn(p.file, p.args, p.options);
}

/** `child_process.execFileSync` for a CLI, with spawnCli's resolution and escaping. */
export function execFileCliSync(
  bin: string,
  args: readonly string[],
  opts: CliExecSyncOptions & { encoding: BufferEncoding },
): string;
export function execFileCliSync(
  bin: string,
  args: readonly string[],
  opts?: CliExecSyncOptions,
): string | Buffer;
export function execFileCliSync(
  bin: string,
  args: readonly string[],
  opts: CliExecSyncOptions = {},
): string | Buffer {
  const p = prepareCli(bin, args, opts);
  if (p === null) throw enoent(bin, args);
  return execFileSync(p.file, p.args, p.options);
}

/**
 * `child_process.execFile` (utf8) for a CLI, with spawnCli's resolution and escaping. A program
 * that can't be found calls back (asynchronously) with an ENOENT error and empty output, as
 * execFile does. Returns the child, or null when nothing was spawned.
 */
export function execFileCli(
  bin: string,
  args: readonly string[],
  opts: CliExecOptions,
  callback: (err: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess | null {
  let p: PreparedCli<CliExecOptions> | null;
  try {
    p = prepareCli(bin, args, opts);
  } catch (e) {
    process.nextTick(() => callback(e as ExecFileException, '', ''));
    return null;
  }
  if (p === null) {
    process.nextTick(() => callback(enoent(bin, args) as ExecFileException, '', ''));
    return null;
  }
  return execFile(p.file, p.args, { ...p.options, encoding: 'utf8' }, callback);
}

/**
 * Whether `bin` (a bare name) would be found on `pathValue`: POSIX, a regular file with an exec
 * bit in some PATH dir; win32, what spawnCli would resolve (absolute PATH dirs × PATHEXT).
 */
export function isOnPath(
  bin: string,
  pathValue: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform === 'win32') {
    const lookup = { PATHEXT: envGet(env, 'PATHEXT'), PATH: pathValue };
    return resolveWindowsBin(bin, { env: lookup }) !== null;
  }
  for (const d of pathValue.split(delimiter)) {
    if (d === '') continue;
    const f = join(d, bin);
    try {
      if (!statSync(f).isFile()) continue;
      accessSync(f, constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}
