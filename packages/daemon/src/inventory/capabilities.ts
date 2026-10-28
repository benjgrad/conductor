import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  capabilityKey,
  CapabilitySchema,
  type Capability,
  type InventoryRepo,
} from '@conductor/shared';
import { cleanEnv } from '../actions/open-pr.js';
import { execFileCli, killTree, nativeExeProblem } from '../platform/index.js';
import { cliVersionFrom } from './version.js';

// The capability half of the inventory (M2-T10; ADR-0013 §Inventory, ADR-0016). Names and
// versions only: a CLI's `authed` is the exit code of a read-only probe (its output is dropped,
// so no account name is ever reported); MCP servers are reported by name, never their command,
// args, env or URL; skills and agents by file name, never their contents.

/** Each CLI probe is killed after this long (ADR-0013: a hung `az` must not stall the scan). */
export const PROBE_TIMEOUT_MS = 5_000;
/** Names read per skills / agents directory, at most. */
const MAX_NAMES = 500;

export interface ScanCapabilitiesOptions {
  /** Claude Code's config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`): skills, agents, plugins. */
  claudeConfigDir: string;
  /** Claude Code's user config, holding user-scope `mcpServers` (`~/.claude.json`). */
  claudeUserConfig: string;
  /** The `claude` binary (CONDUCTOR_CLAUDE_BIN, else `claude`). */
  claudeBin: string;
  /** The scanned repos: each one with a remote contributes its `.claude/skills|agents`. */
  repos: readonly InventoryRepo[];
  /** Probe environment (default process.env); PATH decides which CLIs are found. */
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
  /** Where a capability that isn't reported is logged (once per scan). */
  log?: (msg: string) => void;
}

interface Probe {
  /** Exit code; null when killed (timeout) or not spawned. */
  code: number | null;
  stdout: string;
  /** The binary isn't on PATH. */
  missing: boolean;
}

/**
 * Run one CLI with no shell (win32: PATHEXT, so `az.cmd` is found), stdin closed, killed
 * (SIGKILL) at the timeout. Never throws.
 */
export function probe(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Probe> {
  return new Promise((done) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = execFileCli(
      cmd,
      args,
      { env: { ...cleanEnv(env), NO_COLOR: '1' }, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        clearTimeout(timer);
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        done({
          code: timedOut ? null : e === null ? 0 : typeof e.code === 'number' ? e.code : null,
          stdout: String(stdout),
          missing: e?.code === 'ENOENT',
        });
      },
    );
    // Our own timer, not execFile's: its timeout kills only the direct child, and on win32 a
    // `.cmd` shim's cmd.exe → its real program would live on (killTree: taskkill /T).
    if (child) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, { signal: 'SIGKILL' });
      }, timeoutMs);
    }
    child?.stdin?.end();
  });
}

/** `[name, version args, auth probe args | null]`: the CLIs ADR-0016's connectors need. */
const CLIS: readonly [string, readonly string[], readonly string[] | null][] = [
  ['gh', ['--version'], ['auth', 'status']],
  ['az', ['--version'], ['account', 'show', '--output', 'none']],
  // TD-151: jira-cli has no agreed read-only auth probe yet (`jira me` prints the user), so
  // `authed` is always false for jira (payoff M5).
  ['jira', ['version'], null],
  ['git', ['--version'], null],
];

async function scanClis(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Capability[]> {
  const results = await Promise.all(
    CLIS.map(async ([name, versionArgs, authArgs]): Promise<Capability | null> => {
      const [ver, auth] = await Promise.all([
        probe(name, versionArgs, env, timeoutMs),
        authArgs ? probe(name, authArgs, env, timeoutMs) : Promise.resolve(null),
      ]);
      if (ver.missing) return null;
      return {
        kind: 'cli',
        name,
        version: ver.code === 0 ? cliVersionFrom(ver.stdout) : null,
        authed: auth !== null && auth.code === 0,
      };
    }),
  );
  return results.filter((c): c is Capability => c !== null);
}

async function scanClaude(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<Capability[]> {
  // U-110: a claude.cmd shim can't run conductor's sessions, so it is not a claude capability.
  const notNative = nativeExeProblem(bin, env);
  if (notNative !== null) {
    log(notNative);
    return [];
  }
  const r = await probe(bin, ['--version'], env, timeoutMs);
  const version = r.code === 0 ? cliVersionFrom(r.stdout) : null;
  return version === null ? [] : [{ kind: 'claude', version }];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys of `obj[field]` when it's an object: names, never values. */
function keysOf(obj: unknown, field: string): string[] {
  return isObject(obj) && isObject(obj[field]) ? Object.keys(obj[field]) : [];
}

/** A plugin's MCP server names: its `.mcp.json`, and `plugin.json` `mcpServers` (object or path). */
function pluginMcpNames(installPath: string): string[] {
  const names = keysOf(readJson(join(installPath, '.mcp.json')), 'mcpServers');
  const manifest = readJson(join(installPath, '.claude-plugin', 'plugin.json'));
  if (isObject(manifest)) {
    const m = manifest.mcpServers;
    if (isObject(m)) names.push(...Object.keys(m));
    if (typeof m === 'string') {
      // A path relative to the plugin, never outside it.
      const file = resolve(installPath, m);
      const rel = relative(installPath, file);
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        names.push(...keysOf(readJson(file), 'mcpServers'));
      }
    }
  }
  return names;
}

/**
 * MCP server names: user scope (`mcpServers` in Claude Code's user config) and every enabled
 * plugin (`settings.json` `enabledPlugins`, located through `plugins/installed_plugins.json`).
 * Best effort: a missing or malformed file contributes nothing.
 */
export function mcpNames(claudeConfigDir: string, claudeUserConfig: string): string[] {
  const names = keysOf(readJson(claudeUserConfig), 'mcpServers');
  const settings = readJson(join(claudeConfigDir, 'settings.json'));
  const enabled =
    isObject(settings) && isObject(settings.enabledPlugins)
      ? Object.entries(settings.enabledPlugins)
          .filter(([, on]) => on === true)
          .map(([k]) => k)
      : [];
  if (enabled.length === 0) return names;
  const installed = readJson(join(claudeConfigDir, 'plugins', 'installed_plugins.json'));
  // v2: `{version: 2, plugins: {"name@mkt": [{installPath}]}}`; v1: `{plugins: {"name@mkt": {installPath}}}`.
  const plugins = isObject(installed) && isObject(installed.plugins) ? installed.plugins : {};
  for (const id of enabled) {
    const entry = plugins[id];
    for (const inst of Array.isArray(entry) ? entry : [entry]) {
      if (isObject(inst) && typeof inst.installPath === 'string' && isAbsolute(inst.installPath)) {
        names.push(...pluginMcpNames(inst.installPath));
      }
    }
  }
  return names;
}

/** `<dir>/skills/<name>` (a directory, or a symlink to one) and `<dir>/agents/<name>.md` names. */
export function skillAndAgentNames(dir: string): { skills: string[]; agents: string[] } {
  const list = (sub: string) => {
    try {
      return readdirSync(join(dir, sub), { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, MAX_NAMES);
    } catch {
      return [];
    }
  };
  return {
    skills: list('skills')
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name),
    agents: list('agents')
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md'))
      .map((e) => e.name.slice(0, -'.md'.length))
      .filter((n) => n !== ''),
  };
}

/** Claude Code names a plugin's MCP server `plugin:<plugin>:<server>`; the capability is `<server>`. */
export function normalizeMcpName(name: string): string {
  const m = /^plugin:[^:]+:(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** A name for the log: quoted and escaped (JSON), and cut at 200 chars. */
function logName(name: unknown): string {
  const s = typeof name === 'string' ? name : String(name);
  return JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…` : s);
}

/** Every capability of this machine, schema-checked, de-duplicated and sorted. */
export async function scanCapabilities(opts: ScanCapabilitiesOptions): Promise<Capability[]> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const [clis, claude] = await Promise.all([
    scanClis(env, timeoutMs),
    scanClaude(opts.claudeBin, env, timeoutMs, opts.log ?? (() => undefined)),
  ]);
  const raw: unknown[] = [...clis, ...claude];
  // The name as configured, for the log, when it was normalised.
  const configured = new Map<unknown, string>();
  for (const name of mcpNames(opts.claudeConfigDir, opts.claudeUserConfig)) {
    const c = { kind: 'mcp', name: normalizeMcpName(name) };
    if (c.name !== name) configured.set(c, name);
    raw.push(c);
  }
  const user = skillAndAgentNames(opts.claudeConfigDir);
  raw.push(...user.skills.map((name) => ({ kind: 'skill', name })));
  raw.push(...user.agents.map((name) => ({ kind: 'agent', name })));
  for (const r of opts.repos) {
    // A repo without a routable remote reports no repo-scoped skills or agents.
    if (r.remote === null) continue;
    const own = skillAndAgentNames(join(r.path, '.claude'));
    raw.push(...own.skills.map((name) => ({ kind: 'skill', name, repo: r.remote })));
    raw.push(...own.agents.map((name) => ({ kind: 'agent', name, repo: r.remote })));
  }
  const byKey = new Map<string, Capability>();
  const logged = new Set<string>();
  for (const c of raw) {
    const parsed = CapabilitySchema.safeParse(c);
    if (!parsed.success) {
      // Not reported, logged once per scan; the rest of the inventory still goes out.
      const r = c as { kind?: unknown; name?: unknown };
      const tag = `${String(r.kind)} ${logName(configured.get(c) ?? r.name)}`;
      if (!logged.has(tag)) {
        logged.add(tag);
        opts.log?.(
          `inventory: capability ${tag} not reported: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
      continue;
    }
    const key = capabilityKey(parsed.data);
    // `cli:gh` and `cli:gh:authed` are one CLI: key on the name.
    const k = parsed.data.kind === 'cli' ? `cli:${parsed.data.name}` : key;
    if (!byKey.has(k)) byKey.set(k, parsed.data);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
}
