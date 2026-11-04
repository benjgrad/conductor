// MR-T15: scripts/package-daemon.sh packages one built daemon binary as the tarball served for its
// target. A fake binary (a sh script printing its version) stands in for the Rust one, so this
// needs no cargo; the script itself is what is under test, so it is run with bash.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findDaemonDist } from '../src/distribution.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkgDir, '../..');
const script = join(pkgDir, 'scripts', 'package-daemon.sh');
const LAUNCHER = join(repo, 'crates', 'conductor-daemon', 'assets', 'conductor-launch.sh');
const workspaceVersion = /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(
  readFileSync(join(repo, 'Cargo.toml'), 'utf8'),
)![1]!;
const VERSION = `${workspaceVersion}+abc1234`;
const runnable = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;

describe.skipIf(!runnable)('package-daemon.sh', () => {
  let work: string;
  let fakeBin: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'conductor-package-'));
    fakeBin = join(work, 'conductor-daemon');
    writeFileSync(fakeBin, `#!/bin/sh\necho '${VERSION}'\n`);
    chmodSync(fakeBin, 0o755);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const pack = (args: string[], sha = 'abc1234def') =>
    spawnSync('bash', [script, ...args], {
      env: { ...process.env, CONDUCTOR_BUILD_SHA: sha },
      encoding: 'utf8',
    });
  const unpack = (tgz: string) => {
    const x = mkdtempSync(join(work, 'x-'));
    expect(spawnSync('tar', ['-C', x, '-xzf', tgz]).status).toBe(0);
    return x;
  };
  /** Every file under `dir`, relative, sorted. */
  const tree = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? tree(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
      )
      .sort();

  it('packages a POSIX target: name, layout, .sha256, verified --version', () => {
    const out = join(work, 'out-posix');
    const r = pack(['--verify', 'x86_64-unknown-linux-gnu', fakeBin, out]);
    expect(r.status, r.stderr).toBe(0);
    const file = `conductor-daemon-${VERSION}-x86_64-unknown-linux-gnu.tgz`;
    expect(readdirSync(out).sort()).toEqual([file, `${file}.sha256`]);
    const hex = createHash('sha256')
      .update(readFileSync(join(out, file)))
      .digest('hex');
    expect(readFileSync(join(out, `${file}.sha256`), 'utf8')).toBe(`${hex}  ${file}\n`);
    expect(r.stdout).toContain(`version ${VERSION}`);

    const x = unpack(join(out, file));
    expect(tree(x)).toEqual(['VERSION', 'assets/conductor-launch.sh', 'bin/conductor-daemon']);
    expect(statSync(join(x, 'bin', 'conductor-daemon')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(x, 'assets', 'conductor-launch.sh'))).toEqual(readFileSync(LAUNCHER));
    expect(readFileSync(join(x, 'VERSION'), 'utf8')).toBe(`${VERSION}\n`);
    expect(findDaemonDist(out)?.builds['x86_64-unknown-linux-gnu']?.file).toBe(file);
  });

  it('packages the Windows target: the .exe and a CRLF .cmd that runs it', () => {
    const out = join(work, 'out-windows');
    const r = pack(['x86_64-pc-windows-msvc', fakeBin, out]);
    expect(r.status, r.stderr).toBe(0);
    const x = unpack(join(out, `conductor-daemon-${VERSION}-x86_64-pc-windows-msvc.tgz`));
    expect(tree(x)).toEqual([
      'VERSION',
      'assets/conductor-launch.sh',
      'bin/conductor-daemon.cmd',
      'bin/conductor-daemon.exe',
    ]);
    const cmd = readFileSync(join(x, 'bin', 'conductor-daemon.cmd'), 'utf8');
    expect(cmd.endsWith('\r\n')).toBe(true);
    expect(cmd.split('\r\n').every((line) => !line.includes('\n'))).toBe(true);
    expect(cmd).toContain('"%~dp0conductor-daemon.exe" %*');
    expect(cmd).not.toMatch(/node/i);
  });

  it('replaces an older build of the same target and keeps the other targets', () => {
    const out = join(work, 'out-shared');
    expect(pack(['aarch64-apple-darwin', fakeBin, out], 'aaaaaaa').status).toBe(0);
    expect(pack(['x86_64-unknown-linux-gnu', fakeBin, out], 'aaaaaaa').status).toBe(0);
    expect(pack(['x86_64-unknown-linux-gnu', fakeBin, out], 'bbbbbbb').status).toBe(0);
    const v = (sha: string) => `${workspaceVersion}+${sha}`;
    expect(
      readdirSync(out)
        .filter((f) => f.endsWith('.tgz'))
        .sort(),
    ).toEqual([
      `conductor-daemon-${v('aaaaaaa')}-aarch64-apple-darwin.tgz`,
      `conductor-daemon-${v('bbbbbbb')}-x86_64-unknown-linux-gnu.tgz`,
    ]);
  });

  it('refuses a bad target, a bad sha, a missing binary, and a --version mismatch', () => {
    const out = join(work, 'out-bad');
    for (const [args, sha, msg] of [
      [['Bad_Target', fakeBin, out], 'abc1234', /bad target/],
      [['x86_64-unknown-linux-gnu', fakeBin, out], 'ab$cd', /not alphanumeric/],
      [['x86_64-unknown-linux-gnu', join(work, 'missing'), out], 'abc1234', /no binary/],
      [['--verify', 'x86_64-unknown-linux-gnu', fakeBin, out], 'fff0000', /--version printed/],
      [['x86_64-unknown-linux-gnu', fakeBin], 'abc1234', /usage/],
    ] as const) {
      const r = pack([...args], sha);
      expect(r.status, String(msg)).not.toBe(0);
      expect(r.stderr).toMatch(msg);
    }
    // Nothing failed lands in <out-dir>: not even the build whose --version didn't match.
    mkdirSync(out, { recursive: true });
    expect(readdirSync(out)).toEqual([]);
  });
});
