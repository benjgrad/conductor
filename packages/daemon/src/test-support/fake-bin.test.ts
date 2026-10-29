import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathWith, writeFakeBin } from './fake-bin.js';

const run = promisify(execFile);

// cmd.exe metacharacters, as escaped by cross-spawn (MIT): caret-escape each one.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote for the MSVCRT argv parser, then caret-escape twice: once for the `/c` line, once more
 *  because the `.cmd` shim's `%*` is re-parsed by cmd after expansion. */
function escapeCmdShimArg(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** Run a fake bin with `args` the way a caller must on each OS. */
async function runFake(bin: string, args: string[]): Promise<string> {
  if (process.platform !== 'win32') return (await run(bin, args)).stdout;
  const line = [bin.replace(CMD_META, '^$1'), ...args.map(escapeCmdShimArg)].join(' ');
  const { stdout } = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
  });
  return stdout;
}

describe('writeFakeBin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-bin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('echoes args with spaces and cmd metacharacters back exactly', async () => {
    const bin = writeFakeBin(
      dir,
      'echo-args',
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const args = [
      'plain',
      'with space',
      'a&b',
      'up^caret',
      '100%',
      '%PATH%',
      'say "hi"',
      'trailing\\',
      'back\\"slash',
      '',
      'mix & ^ % " end',
    ];
    expect(JSON.parse(await runFake(bin, args))).toEqual(args);
  });

  it('writes a #!/usr/bin/env node script, mode 755, on POSIX', () => {
    const bin = writeFakeBin(dir, 'tool', 'console.log(1);\n', 'linux');
    expect(bin).toBe(join(dir, 'tool'));
    expect(readFileSync(bin, 'utf8')).toBe('#!/usr/bin/env node\nconsole.log(1);\n');
    if (process.platform !== 'win32') expect(statSync(bin).mode & 0o777).toBe(0o755);
  });

  it('writes name.mjs plus a name.cmd shim on win32', () => {
    const bin = writeFakeBin(dir, 'tool', 'console.log(1);\n', 'win32');
    expect(bin).toBe(join(dir, 'tool.cmd'));
    expect(readFileSync(join(dir, 'tool.mjs'), 'utf8')).toBe('console.log(1);\n');
    expect(readFileSync(bin, 'utf8')).toBe('@node "%~dp0tool.mjs" %*\r\n');
  });
});

describe('pathWith', () => {
  it('joins dirs with the platform delimiter, dropping empties', () => {
    expect(pathWith('a', '', 'b')).toBe(`a${delimiter}b`);
  });
});
