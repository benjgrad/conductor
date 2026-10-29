// M2-T14: scripts/build-daemon-tarball.sh builds a self-contained daemon. Its tarball's
// bin/conductor-daemon runs from an empty directory with only Node on PATH (no workspace links).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findDaemonBuild } from '../src/distribution.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(pkgDir, 'scripts', 'build-daemon-tarball.sh');
const daemonVersion = (
  JSON.parse(readFileSync(join(pkgDir, '../daemon/package.json'), 'utf8')) as { version: string }
).version;
const hasPnpm = spawnSync('pnpm', ['--version']).status === 0;

/** Every symlink under `dir`, recursively. */
function symlinks(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) out.push(p);
    else if (e.isDirectory()) out.push(...symlinks(p));
  }
  return out;
}

describe.skipIf(!hasPnpm)('build-daemon-tarball.sh', () => {
  const work = mkdtempSync(join(tmpdir(), 'conductor-tarball-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('builds a tarball that runs with only Node on PATH', { timeout: 300_000 }, () => {
    const out = join(work, 'downloads');
    const build = spawnSync('bash', [script, out], {
      env: { ...process.env, CONDUCTOR_BUILD_SHA: 'abc1234def' },
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);

    const version = `${daemonVersion}+abc1234`;
    const file = `conductor-daemon-${version}.tgz`;
    expect(readdirSync(out).sort()).toEqual([file, `${file}.sha256`]);
    const hex = createHash('sha256')
      .update(readFileSync(join(out, file)))
      .digest('hex');
    expect(readFileSync(join(out, `${file}.sha256`), 'utf8')).toBe(`${hex}  ${file}\n`);
    expect(findDaemonBuild(out)?.version).toBe(version);

    const x = join(work, 'x');
    mkdirSync(x);
    expect(spawnSync('tar', ['-C', x, '-xzf', join(out, file)]).status).toBe(0);
    // MW-T11: none at all, since Windows tar.exe can't create them without Developer Mode.
    expect(symlinks(x)).toEqual([]);
    // The Windows entry: CRLF batch file with the build sha, running dist/main.js.
    const cmd = readFileSync(join(x, 'bin', 'conductor-daemon.cmd'), 'utf8');
    expect(cmd.split('\r\n').every((line) => !line.includes('\n'))).toBe(true);
    expect(cmd).toContain('set "CONDUCTOR_BUILD_SHA=abc1234"');
    expect(cmd).toContain('node "%~dp0..\\dist\\main.js" %*');

    const pathbin = join(work, 'pathbin');
    const cwd = join(work, 'empty');
    mkdirSync(pathbin);
    mkdirSync(cwd);
    symlinkSync(process.execPath, join(pathbin, 'node'));
    const help = spawnSync(join(x, 'bin', 'conductor-daemon'), ['--help'], {
      cwd,
      env: { HOME: work, PATH: `${pathbin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('usage: conductor-daemon');
  });
});
