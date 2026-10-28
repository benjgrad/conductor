import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityKeys, type InventoryRepo } from '@conductor/shared';
import {
  normalizeMcpName,
  scanCapabilities,
  type ScanCapabilitiesOptions,
} from './capabilities.js';
import { workflowShell } from '../platform/index.js';

const onWin32 = process.platform === 'win32';

// M2-T10 acceptance: capability probes against fake binaries on PATH, MCP / skill / agent names
// from fixture Claude Code config. Names and versions only: no account name, command or env.

let tmp: string;
let bin: string;
let claudeDir: string;

/**
 * A fake CLI on PATH running `body` in sh. POSIX: a `#!/bin/sh` script. win32: `name.sh` plus a
 * `name.cmd` shim that runs it in Git Bash (as `az.cmd` is a shim), so the probe goes through
 * spawnCli's PATHEXT lookup and cmd.exe escaping.
 */
function fake(name: string, body: string): void {
  if (onWin32) {
    writeFileSync(join(bin, `${name}.sh`), `${body}\n`);
    writeFileSync(join(bin, `${name}.cmd`), `@"${workflowShell().file}" "%~dp0${name}.sh" %*\r\n`);
    return;
  }
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/**
 * PATH = the fake bin dir + /bin and /usr/bin (sh, sleep); no real gh / az / jira / claude. win32:
 * the bin dir + System32, plus what cmd.exe needs (SystemRoot, PATHEXT).
 */
function opts(over: Partial<ScanCapabilitiesOptions> = {}): ScanCapabilitiesOptions {
  const env: NodeJS.ProcessEnv = onWin32
    ? {
        PATH: [bin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(delimiter),
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        HOME: tmp,
      }
    : { PATH: `${bin}:/bin:/usr/bin`, HOME: tmp };
  return {
    claudeConfigDir: claudeDir,
    claudeUserConfig: join(tmp, '.claude.json'),
    claudeBin: 'claude',
    repos: [],
    env,
    ...over,
  };
}

const GIT = onWin32
  ? execFileSync('where', ['git'], { encoding: 'utf8' })
      .split(/\r?\n/)[0]!
      .trim()
      .replaceAll('\\', '/')
  : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-caps-'));
  // TD-193: a space and parentheses, like `C:\\Program Files (x86)\\…\\wbin\\az.cmd`.
  bin = join(tmp, 'Program Files (x86)', 'wbin');
  claudeDir = join(tmp, 'claude-config');
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeDir);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('inventory capabilities: cli probes (M2-T10)', () => {
  it('gh / az authed → {authed: true}, and no account name anywhere in the output', async () => {
    fake(
      'gh',
      [
        'if [ "$1" = --version ]; then echo "gh version 2.50.0 (2024-05-29)"; exit 0; fi',
        'if [ "$1" = auth ]; then echo "github.com"; echo "  ✓ Logged in to github.com account octo-secret-user (keyring)" >&2; echo "token: gho_SECRET"; exit 0; fi',
        'exit 2',
      ].join('\n'),
    );
    fake(
      'az',
      [
        'if [ "$1" = --version ]; then echo "azure-cli                         2.60.0 *"; exit 0; fi',
        'if [ "$1" = account ]; then echo \'{"user": {"name": "az-secret@corp.example"}}\'; exit 0; fi',
        'exit 2',
      ].join('\n'),
    );
    fake('claude', 'echo "2.1.308 (Claude Code)"');
    const lines: string[] = [];
    const caps = await scanCapabilities(opts({ log: (m) => lines.push(m) }));
    expect(caps).toContainEqual({ kind: 'cli', name: 'gh', version: '2.50.0', authed: true });
    expect(caps).toContainEqual({ kind: 'cli', name: 'az', version: '2.60.0', authed: true });
    if (onWin32) {
      // U-110: a claude.cmd shim is not a usable claude on Windows.
      expect(caps.some((c) => c.kind === 'claude')).toBe(false);
      expect(lines.join('\n')).toMatch(/not a native \.exe/);
    } else {
      expect(caps).toContainEqual({ kind: 'claude', version: '2.1.308' });
    }
    const text = JSON.stringify(caps);
    for (const secret of ['octo-secret-user', 'gho_SECRET', 'az-secret', 'corp.example']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a failed auth probe → authed false; a missing CLI is omitted', async () => {
    fake('gh', 'if [ "$1" = --version ]; then echo "gh version 2.40.0"; exit 0; fi\nexit 1');
    const caps = await scanCapabilities(opts());
    expect(caps).toContainEqual({ kind: 'cli', name: 'gh', version: '2.40.0', authed: false });
    expect(caps.some((c) => c.kind === 'cli' && c.name === 'jira')).toBe(false);
    expect(caps.some((c) => c.kind === 'cli' && c.name === 'az')).toBe(false);
    expect(caps.some((c) => c.kind === 'claude')).toBe(false);
  });

  it('jira and git report their versions, never authed', async () => {
    fake('jira', 'echo \'(Version="1.5.1", GitCommit="abc", GoVersion="go1.22")\'');
    fake('git', `exec "${GIT}" "$@"`);
    const caps = await scanCapabilities(opts());
    expect(caps).toContainEqual({ kind: 'cli', name: 'jira', version: '1.5.1', authed: false });
    const g = caps.find((c) => c.kind === 'cli' && c.name === 'git');
    expect(g).toMatchObject({ kind: 'cli', name: 'git', authed: false });
    expect(g && 'version' in g ? g.version : null).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('a hanging probe is killed at 5 s', { timeout: 20_000 }, async () => {
    const pidFile = join(tmp, 'az.pid');
    // The sleeper's own pid: win32 reads its Windows pid from MSYS /proc (bash's $! is not one).
    const sh = (p: string) => p.replace(/\\/g, '/');
    fake(
      'az',
      onWin32
        ? `sleep 30 & cat /proc/$!/winpid >> "${sh(pidFile)}"; wait`
        : `echo $$ >> ${pidFile}\nexec sleep 30`,
    );
    const t0 = Date.now();
    const caps = await scanCapabilities(opts());
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(9_000);
    expect(caps).toContainEqual({ kind: 'cli', name: 'az', version: null, authed: false });
    // Both az probes (version + account show) were killed: no sleeper is left.
    const pids = readFileSync(pidFile, 'utf8').trim().split(/\r?\n/).map(Number);
    expect(pids.length).toBe(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('inventory capabilities: names from Claude Code config (M2-T10)', () => {
  it('MCP names from user scope and enabled plugins; no command, args, env or URL', async () => {
    writeFileSync(
      join(tmp, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com' },
        mcpServers: {
          slack: {
            command: 'npx-secret-cmd',
            args: ['--token', 'sekret-arg'],
            env: { SLACK_TOKEN: 'sekret-env' },
          },
          atlassian: { type: 'http', url: 'https://mcp.secret-host.example/v1' },
          'my server': { command: 'x' },
        },
      }),
    );
    const plugin = join(claudeDir, 'plugins', 'cache', 'mkt', 'ctx', '1.0.0');
    const other = join(claudeDir, 'plugins', 'cache', 'mkt', 'pathy', '1.0.0');
    const disabled = join(claudeDir, 'plugins', 'cache', 'mkt', 'off', '1.0.0');
    for (const d of [plugin, other, disabled])
      mkdirSync(join(d, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(plugin, '.mcp.json'),
      JSON.stringify({
        mcpServers: { context7: { command: 'npx', env: { KEY: 'sekret-plugin' } } },
      }),
    );
    writeFileSync(
      join(other, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'pathy', mcpServers: './servers.json' }),
    );
    writeFileSync(join(other, 'servers.json'), JSON.stringify({ mcpServers: { linear: {} } }));
    writeFileSync(join(disabled, '.mcp.json'), JSON.stringify({ mcpServers: { nope: {} } }));
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'ctx@mkt': true, 'pathy@mkt': true, 'off@mkt': false },
      }),
    );
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'ctx@mkt': [{ scope: 'user', installPath: plugin }],
          'pathy@mkt': [{ scope: 'user', installPath: other }],
          'off@mkt': [{ scope: 'user', installPath: disabled }],
        },
      }),
    );
    const caps = await scanCapabilities(opts());
    const mcp = caps.filter((c) => c.kind === 'mcp').map((c) => c.name);
    expect(mcp.sort()).toEqual(['atlassian', 'context7', 'linear', 'slack']);
    const text = JSON.stringify(caps);
    for (const secret of [
      'npx',
      'sekret',
      'secret-host',
      'https://',
      'SLACK_TOKEN',
      'someone@example.com',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('malformed config files contribute nothing (never throw)', async () => {
    writeFileSync(join(tmp, '.claude.json'), '{not json');
    writeFileSync(join(claudeDir, 'settings.json'), '[]');
    const caps = await scanCapabilities(opts());
    expect(caps.filter((c) => c.kind === 'mcp')).toEqual([]);
  });

  it('skills and agents: user scope, and repo scope only for repos with a remote', async () => {
    const mk = (dir: string) => {
      mkdirSync(join(dir, 'skills', 'review'), { recursive: true });
      mkdirSync(join(dir, 'skills', '.hidden'), { recursive: true });
      mkdirSync(join(dir, 'agents'), { recursive: true });
      writeFileSync(join(dir, 'agents', 'planner.md'), 'secret agent prompt');
      writeFileSync(join(dir, 'agents', 'notes.txt'), 'x');
    };
    mk(claudeDir);
    const withRemote = join(tmp, 'app');
    const noRemote = join(tmp, 'local');
    mk(join(withRemote, '.claude'));
    mkdirSync(join(noRemote, '.claude', 'skills', 'local-only'), { recursive: true });
    const repo = (path: string, remote: string | null): InventoryRepo => ({
      path,
      remote,
      default_branch: 'main',
      head_commit: 'a'.repeat(40),
      mode: 'reference',
    });
    const caps = await scanCapabilities(
      opts({ repos: [repo(withRemote, 'github.com/org/app'), repo(noRemote, null)] }),
    );
    const named = caps.filter((c) => c.kind === 'skill' || c.kind === 'agent');
    expect(named).toEqual(
      expect.arrayContaining([
        { kind: 'skill', name: 'review' },
        { kind: 'agent', name: 'planner' },
        { kind: 'skill', name: 'review', repo: 'github.com/org/app' },
        { kind: 'agent', name: 'planner', repo: 'github.com/org/app' },
      ]),
    );
    expect(named).toHaveLength(4);
    expect(JSON.stringify(caps)).not.toContain('secret agent prompt');
    expect(JSON.stringify(caps)).not.toContain('local-only');
  });

  /** An enabled plugin `<name>@mkt` whose `.mcp.json` declares `servers`. */
  function plugin(name: string, servers: string[]): void {
    const dir = join(claudeDir, 'plugins', 'cache', 'mkt', name, '1.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s, {}])) }),
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { [`${name}@mkt`]: true } }),
    );
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [`${name}@mkt`]: [{ installPath: dir }] } }),
    );
  }

  it('normalizeMcpName: plugin:<plugin>:<server> → <server> (M2-T10b)', () => {
    expect(normalizeMcpName('plugin:slack:slack')).toBe('slack');
    expect(normalizeMcpName('plugin:gh:github')).toBe('github');
    expect(normalizeMcpName('slack')).toBe('slack');
    expect(normalizeMcpName('plugin:x')).toBe('plugin:x');
    expect(normalizeMcpName('plugin:a:b:c')).toBe('b:c');
  });

  it('a plugin MCP name is reported as mcp:<server> (M2-T10b)', async () => {
    writeFileSync(
      join(tmp, '.claude.json'),
      JSON.stringify({ mcpServers: { 'plugin:slack:slack': {}, 'plugin:gh:github': {} } }),
    );
    plugin('ctx', ['plugin:ctx:context7']);
    const caps = await scanCapabilities(opts());
    const mcp = caps.filter((c) => c.kind === 'mcp').map((c) => c.name);
    expect(mcp.sort()).toEqual(['context7', 'github', 'slack']);
    const keys = caps.flatMap(capabilityKeys);
    expect(keys).toContain('mcp:slack');
    expect(keys.some((k) => k.startsWith('mcp:plugin'))).toBe(false);
  });

  it('an invalid name is logged once per scan and not reported; the rest is (M2-T10b)', async () => {
    fake('gh', 'if [ "$1" = --version ]; then echo "gh version 2.50.0"; exit 0; fi\nexit 0');
    writeFileSync(
      join(tmp, '.claude.json'),
      JSON.stringify({
        mcpServers: { slack: {}, 'a:b': {}, 'my server': {}, 'plugin:p:x@y': {} },
      }),
    );
    plugin('dup', ['a:b']);
    mkdirSync(join(claudeDir, 'skills', 'review'), { recursive: true });
    mkdirSync(join(claudeDir, 'skills', 'x@host'), { recursive: true });
    const lines: string[] = [];
    const caps = await scanCapabilities(opts({ log: (m) => lines.push(m) }));

    const ab = lines.filter((l) => l.includes('"a:b"'));
    expect(ab).toHaveLength(1);
    expect(ab[0]).toMatch(/^inventory: capability mcp "a:b" not reported: .+/);
    expect(lines).toContainEqual(
      expect.stringMatching(/^inventory: capability mcp "my server" not reported: /),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^inventory: capability skill "x@host" not reported: /),
    );
    // A normalised name is logged as configured.
    expect(lines).toContainEqual(
      expect.stringMatching(/^inventory: capability mcp "plugin:p:x@y" not reported: /),
    );
    expect(lines).toHaveLength(4);

    const text = JSON.stringify(caps);
    for (const bad of ['a:b', 'my server', 'x@host', 'x@y']) expect(text).not.toContain(bad);
    expect(caps).toContainEqual({ kind: 'mcp', name: 'slack' });
    expect(caps).toContainEqual({ kind: 'skill', name: 'review' });
    expect(caps).toContainEqual({ kind: 'cli', name: 'gh', version: '2.50.0', authed: true });

    // Once per scan, not once ever.
    await scanCapabilities(opts({ log: (m) => lines.push(m) }));
    expect(lines).toHaveLength(8);
  });
});
