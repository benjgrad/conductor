import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileConfigPath, loadConfig, readFileConfig, writeFileConfig } from '../config.js';
import { configCommand } from './config.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// M2-T10: `conductor-daemon config roots|repo|show`, `<root>/config.json` (0600), CONDUCTOR_ROOTS,
// CONDUCTOR_TEST_REMOTE_ALIASES.

let tmp: string;
let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-config-')));
  root = join(tmp, 'daemon-root');
  out = [];
  err = [];
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (argv: string[], env: Record<string, string> = {}) =>
  configCommand(argv, {
    env: { CONDUCTOR_ROOT: root, ...env },
    facts: { home: tmp },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });

const mode = (path: string) => statSync(path).mode & 0o777;

describe('config.json', () => {
  // MW-T07: config 0600 modes, `:`-separated roots and POSIX paths
  it.skipIf(onWin32)('missing → defaults; round-trips at 0600', () => {
    expect(readFileConfig(root)).toEqual({ roots: [], repos: {} });
    const path = writeFileConfig(root, { roots: ['/a'], repos: { '/a/b': { mode: 'checkout' } } });
    expect(path).toBe(fileConfigPath(root));
    expect(mode(path)).toBe(0o600);
    expect(readFileConfig(root)).toEqual({
      roots: ['/a'],
      repos: { '/a/b': { mode: 'checkout' } },
    });
  });

  it('invalid JSON or shape → an error naming the file', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(fileConfigPath(root), '{nope');
    expect(() => readFileConfig(root)).toThrow(/config\.json is not valid JSON/);
    writeFileSync(fileConfigPath(root), JSON.stringify({ repos: { '/x': { mode: 'yolo' } } }));
    expect(() => readFileConfig(root)).toThrow(/config\.json is invalid/);
  });
});

describe('loadConfig inventory env', () => {
  const base = { CONDUCTOR_ROOT: '/tmp/r', CONDUCTOR_MACHINE_ID: 'm' };

  // MW-T07: config 0600 modes, `:`-separated roots and POSIX paths
  it.skipIf(onWin32)('CONDUCTOR_ROOTS (`:`-separated) overrides the file; unset → null', () => {
    expect(loadConfig(base).rootsOverride).toBeNull();
    expect(loadConfig({ ...base, CONDUCTOR_ROOTS: '/a:/b/../c' }).rootsOverride).toEqual([
      '/a',
      '/c',
    ]);
  });

  // MW-T07: config 0600 modes, `:`-separated roots and POSIX paths
  it.skipIf(onWin32)(
    'CONDUCTOR_TEST_REMOTE_ALIASES is ignored without CONDUCTOR_ALLOW_LOCAL_REPOS',
    () => {
      const aliases = '/tmp/fixture=github.com/benjgrad/fixture-app';
      expect(
        loadConfig({ ...base, CONDUCTOR_TEST_REMOTE_ALIASES: aliases }).testRemoteAliases,
      ).toEqual({});
      expect(
        loadConfig({
          ...base,
          CONDUCTOR_ALLOW_LOCAL_REPOS: '1',
          CONDUCTOR_TEST_REMOTE_ALIASES: aliases,
        }).testRemoteAliases,
      ).toEqual({ '/tmp/fixture': 'github.com/benjgrad/fixture-app' });
    },
  );

  it('a bad alias throws (with the flag)', () => {
    for (const bad of [
      '/tmp/x=https://github.com/o/r',
      'github.com/o/r',
      '/tmp/x=GitHub.com/o/r',
    ]) {
      expect(() =>
        loadConfig({
          ...base,
          CONDUCTOR_ALLOW_LOCAL_REPOS: '1',
          CONDUCTOR_TEST_REMOTE_ALIASES: bad,
        }),
      ).toThrow(/CONDUCTOR_TEST_REMOTE_ALIASES/);
    }
  });
});

describe('conductor-daemon config', () => {
  // MW-T07: config 0600 modes, `:`-separated roots and POSIX paths
  it.skipIf(onWin32)('roots: saves realpaths (deduped) at 0600', () => {
    const a = join(tmp, 'code');
    mkdirSync(a);
    expect(run(['roots', a, join(a, '.'), join(tmp, 'code/')])).toBe(0);
    expect(readFileConfig(root).roots).toEqual([a]);
    expect(mode(fileConfigPath(root))).toBe(0o600);
    expect(out.join('\n')).toContain('kill -HUP');
  });

  it('roots: a missing directory or none → 2, nothing written', () => {
    expect(run(['roots', join(tmp, 'nope')])).toBe(2);
    expect(err.join('\n')).toContain('does not exist');
    expect(run(['roots'])).toBe(2);
    expect(readFileConfig(root).roots).toEqual([]);
  });

  it('repo --mode checkout: stored by path; warns when not under a root', () => {
    const code = join(tmp, 'code');
    const app = join(code, 'app');
    mkdirSync(app, { recursive: true });
    execFileSync('git', ['init', '--quiet', app]);
    expect(run(['repo', app, '--mode', 'checkout'])).toBe(0);
    expect(readFileConfig(root).repos).toEqual({ [app]: { mode: 'checkout' } });
    expect(err.join('\n')).toContain('not under a configured root');
    err = [];
    expect(run(['roots', code])).toBe(0);
    expect(run(['repo', app, '--mode', 'reference'])).toBe(0);
    expect(readFileConfig(root).repos[app]).toEqual({ mode: 'reference' });
    expect(err).toEqual([]);
  });

  it('repo: a bad mode, a non-repo or extra args → 2', () => {
    const app = join(tmp, 'app');
    mkdirSync(app);
    expect(run(['repo', app, '--mode', 'checkout'])).toBe(2); // no .git
    execFileSync('git', ['init', '--quiet', app]);
    expect(run(['repo', app, '--mode', 'yolo'])).toBe(2);
    expect(run(['repo', app])).toBe(2);
    expect(run(['repo', app, app, '--mode', 'checkout'])).toBe(2);
    expect(run(['repo', app, '--mood', 'checkout'])).toBe(2);
    expect(readFileConfig(root).repos).toEqual({});
  });

  // MW-T07: config 0600 modes, `:`-separated roots and POSIX paths
  it.skipIf(onWin32)('show: the file, effective roots and repos; CONDUCTOR_ROOTS wins', () => {
    writeFileConfig(root, { roots: ['/from/file'], repos: {} });
    expect(run(['show'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({
      file: fileConfigPath(root),
      roots: ['/from/file'],
      roots_from: 'file',
      repos: {},
    });
    out = [];
    expect(run(['show'], { CONDUCTOR_ROOTS: '/from/env' })).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      roots: ['/from/env'],
      roots_from: 'CONDUCTOR_ROOTS',
    });
    expect(readFileSync(fileConfigPath(root), 'utf8')).toContain('/from/file');
  });

  it('no or an unknown subcommand → usage, 2', () => {
    expect(run([])).toBe(2);
    expect(run(['frobnicate'])).toBe(2);
    expect(err.join('\n')).toContain('usage: conductor-daemon config roots');
  });
});
