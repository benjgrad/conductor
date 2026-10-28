// The real ClaudeDriver (ADR-0005, accepted): one long-lived `claude -p` child per session in
// bidirectional stream-json mode, outcome tools on the daemon-hosted MCP server.
//
//   const outcomeServer = await startOutcomeServer();
//   const driver = createCliDriver({ outcomeServer });   // claudeBin ← CONDUCTOR_CLAUDE_BIN ← 'claude'
//   const s = driver.start(opts); s.on(ev => …); s.sendInput(answer); s.end(); s.kill();
//
// Events are emitted synchronously from stream / HTTP callbacks, never inside start(), so a
// listener attached right after start() sees everything. Nothing is emitted after `exit`.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  execFileCli,
  killTree,
  mkdirPrivate,
  nativeExeProblem,
  spawnCli,
  writePrivateFile,
} from '../platform/index.js';
import type { ClaudeDriver, DriverEvent, DriverSession, DriverStartOptions } from './driver.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS } from '@conductor/shared';
import { writeEditGuard } from './edit-guard.js';
import {
  OUTCOME_TOOL_NAMES,
  PERMISSION_TOOL,
  type OutcomeRegistration,
  type OutcomeServer,
} from './outcome-server.js';
import { parseStreamLine } from './stream-parser.js';

export const CLAUDE_BIN_ENV = 'CONDUCTOR_CLAUDE_BIN';
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_END_GRACE_MS = 10_000;
/** After the child exits, how long to wait for stdout/stderr to drain before emitting `exit`. */
const DRAIN_MS = 2_000;

export interface CliDriverOptions {
  /** Path or name of the `claude` executable. Default: $CONDUCTOR_CLAUDE_BIN, else `claude`. */
  claudeBin?: string;
  outcomeServer: OutcomeServer;
  /** Default grace for kill() when the caller passes none. */
  killGraceMs?: number;
  /** end() closes stdin; if the process is still alive after this, it is kill()ed. */
  endGraceMs?: number;
  /** Tests only: extra state-env keys to pass through (the fake's `FAKE_CLAUDE_*`). */
  extraStateEnv?: RegExp;
  /**
   * Tests only: args put before claude's own, e.g. `claudeBin: process.execPath` +
   * `[fake-claude.mjs]`, since win32 only runs a native .exe as claude (U-110).
   */
  claudePrefixArgs?: readonly string[];
  /**
   * ADR-0023: does this Claude CLI support auto mode and `--permission-prompts host` (see
   * `probePermissionPrompts`; `main` probes once at start)? Default true. False → the old flags
   * (the user's mode with the bypass cap, `--permission-prompts none`) and a debug line on every
   * session saying prompts are denied.
   */
  permissionPrompts?: boolean;
}

/** A DriverSession plus what the CLI reported about itself (U-015). */
export interface CliDriverSession extends DriverSession {
  /** `claude_code_version` from the first system/init; undefined until then. */
  readonly cliVersion: string | undefined;
  readonly pid: number | undefined;
  /** ADR-0023: always present on the CLI driver (see DriverSession). */
  resolvePermission: NonNullable<DriverSession['resolvePermission']>;
  denyPermission: NonNullable<DriverSession['denyPermission']>;
}

export interface CliDriver extends ClaudeDriver {
  start(opts: DriverStartOptions): CliDriverSession;
}

/**
 * Write the session's `--mcp-config` JSON (it holds the per-session URL token) to a private file
 * (0600 / owner-only DACL) in a fresh private directory, so the token never appears in argv / `ps`
 * (M1-T14). The caller removes the directory with `removeMcpConfigFile` when the process is gone.
 */
export function writeMcpConfigFile(mcpConfig: string, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, 'conductor-mcp-'));
  mkdirPrivate(dir);
  const path = join(dir, 'mcp.json');
  writePrivateFile(path, mcpConfig);
  return path;
}

export function removeMcpConfigFile(path: string): void {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    // best effort: a tmp dir left behind holds a token that is already unregistered
  }
}

/**
 * Env the agent always gets, over the daemon env and `opts.env` (ADR-0006): the user's claude.ai
 * connectors (Gmail, Slack, …) stay out of agent sessions (`--strict-mcp-config` doesn't cover
 * them), safe mode, which would drop the edit-guard hook, stays off, and (ADR-0023) the MCP tool
 * timeout outlasts a held permission prompt.
 */
export const AGENT_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_SAFE_MODE: '0',
  // ADR-0023: a held `permission` call lasts up to DEFAULT_PERMISSION_TIMEOUT_MS (30 min); the
  // CLI's MCP tool timeout must not cut it first. Conductor's server is the only MCP server.
  MCP_TOOL_TIMEOUT: String(DEFAULT_PERMISSION_TIMEOUT_MS + 5 * 60_000),
} as const;

/**
 * State-env keys the agent may receive: what the orchestrator and daemon set today (session and
 * ticket ids, ports, git identity). Anything else (HOME, NODE_OPTIONS, CLAUDE_CONFIG_DIR,
 * ANTHROPIC_API_KEY, …) could point `claude` at other settings than `agentPermissionMode` checked,
 * switch billing, or inject code, so it is dropped. A future per-state workflow env must extend
 * this list deliberately.
 */
export const STATE_ENV_ALLOWED =
  /^(CONDUCTOR_[A-Z0-9_]+|PORT|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;

/**
 * The child's env: the daemon env, then the allowed state-env keys, then AGENT_ENV. `dropped`
 * names the state-env keys that were refused.
 */
export function agentEnv(
  stateEnv: Record<string, string>,
  extraAllowed?: RegExp,
): {
  env: NodeJS.ProcessEnv;
  dropped: string[];
} {
  const allowed: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(stateEnv)) {
    if (STATE_ENV_ALLOWED.test(k) || extraAllowed?.test(k)) allowed[k] = v;
    else dropped.push(k);
  }
  return { env: { ...process.env, ...allowed, ...AGENT_ENV }, dropped };
}

/**
 * Only for a CLI without ADR-0023 support (`permissionPrompts: false`); otherwise every worker
 * runs in WORKER_PERMISSION_MODE (`auto`) and this is not read.
 *
 * The `--permission-mode` to pass, if any (ADR-0006). The user's own default applies, except
 * `bypassPermissions`, which is capped to `auto`: an unattended agent keeps auto mode's classifier
 * even when the user skips it interactively. Reads `defaultMode` from the user settings file
 * (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`); unreadable → no flag.
 */
export function agentPermissionMode(
  settingsFile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'),
): 'auto' | undefined {
  try {
    const s = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      permissions?: { defaultMode?: unknown };
    };
    return s.permissions?.defaultMode === 'bypassPermissions' ? 'auto' : undefined;
  } catch {
    return undefined;
  }
}

/** ADR-0023 §1: every working agent runs in auto mode, whatever the user's `defaultMode`. */
export const WORKER_PERMISSION_MODE = 'auto';

/**
 * How `buildClaudeArgs` sets permissions. `host` (ADR-0023): workers run in auto mode and what it
 * would still ask goes to `mcp__conductor__permission`. `none`: the pre-ADR-0023 flags, for a CLI
 * without auto mode or `--permission-prompts host` (`probePermissionPrompts`): `legacyMode` is
 * `agentPermissionMode()` (the bypass cap) and anything that would prompt is denied.
 */
export type PermissionArgs = { prompts: 'host' } | { prompts: 'none'; legacyMode?: string };

/** What `probePermissionPrompts` found. `reason` says what is missing when unsupported. */
export interface PermissionPromptSupport {
  supported: boolean;
  reason: string | null;
}

/**
 * ADR-0023: is `help` (the CLI's `--help` text) from a Claude Code that has `--permission-prompts`
 * and the `auto` permission mode? (`--permission-prompt-tool` is a hidden flag, so it can't be
 * checked; it predates both.)
 */
export function permissionPromptSupport(help: string): PermissionPromptSupport {
  const missing: string[] = [];
  if (!/--permission-prompts\b/.test(help)) missing.push('--permission-prompts');
  if (!/--permission-mode\b[\s\S]*?"auto"/.test(help)) missing.push('--permission-mode auto');
  return missing.length === 0
    ? { supported: true, reason: null }
    : { supported: false, reason: `claude --help lists no ${missing.join(' / ')}` };
}

/**
 * Run `<bin> --help` once and check it with `permissionPromptSupport` (unsupported on failure).
 * `prefixArgs`: tests only, as CliDriverOptions.claudePrefixArgs.
 */
export async function probePermissionPrompts(
  bin = process.env[CLAUDE_BIN_ENV] ?? 'claude',
  prefixArgs: readonly string[] = [],
): Promise<PermissionPromptSupport> {
  const args = [...prefixArgs, '--help'];
  return new Promise((resolve) => {
    execFileCli(bin, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err !== null && stdout === '') {
        resolve({ supported: false, reason: `claude --help failed: ${err.message.slice(0, 200)}` });
        return;
      }
      resolve(permissionPromptSupport(stdout));
    });
  });
}

/**
 * ADR-0009: the permission mode of a requirements reviewer, whatever the user's own mode. In
 * dontAsk only pre-approved tools (Read/Glob/Grep, the `review` alias's exact git commands, the
 * conductor outcome tools) run; anything else is denied without a prompt.
 */
export const REVIEWER_PERMISSION_MODE = 'dontAsk';

/**
 * The exact argv of ADR-0005 §Spawn as amended by ADR-0006 and ADR-0023 (without the executable).
 * `mcpConfig` is what goes after `--mcp-config`: the driver passes the path from
 * `writeMcpConfigFile` (the CLI accepts a file path or a JSON string), never the JSON itself.
 * `settings` is the edit-guard settings file from `writeEditGuard`.
 *
 * ADR-0006: the user's settings load (`--setting-sources user`; never `project`: the repo is
 * untrusted and its settings could disable the guard hook), so the user's rules, hooks and skills
 * apply. The state's policy still limits the visible built-ins (`--tools`), pre-approves its rules
 * and adds its denies (`--disallowedTools`, e.g. `Bash(git push:*)`): deny rules are evaluated
 * before any prompt, so they never reach a human (ADR-0023 §4). TD-081: what the user's settings
 * allow is per machine and not recorded.
 *
 * ADR-0023 (`permission` = `{prompts: 'host'}`, the default): a worker runs in
 * `--permission-mode auto` whatever the user's defaultMode, and what auto mode would still ask
 * goes to conductor (`--permission-prompts host --permission-prompt-tool
 * mcp__conductor__permission`), which holds the call until a human decides on the board. A
 * requirements reviewer (ADR-0009) runs in `dontAsk` with `--permission-prompts none`: only its
 * pre-approved read-only rules run and nothing ever asks a human. `{prompts: 'none'}` is the
 * fallback for a CLI without auto mode or `--permission-prompts host`: the pre-ADR-0023 flags
 * (`legacyMode` = the bypass cap from `agentPermissionMode`, prompts denied).
 */
export function buildClaudeArgs(
  opts: DriverStartOptions,
  mcpConfig: string,
  settings: string,
  permission: PermissionArgs = { prompts: 'host' },
): string[] {
  const t = opts.tools;
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(opts.resume ? ['--resume', opts.claudeSessionId] : ['--session-id', opts.claudeSessionId]),
  ];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  args.push('--setting-sources', 'user', '--settings', settings, '--strict-mcp-config');
  // ADR-0009: a reviewer is forced into dontAsk (only its pre-approved read-only rules run) and
  // never prompts. ADR-0023: a worker runs in auto mode and its prompts go to conductor; on an
  // old CLI it keeps the user's mode, capped by `agentPermissionMode`, and prompts are denied.
  const review = opts.review === true;
  const host = permission.prompts === 'host' && !review;
  const mode = review
    ? REVIEWER_PERMISSION_MODE
    : permission.prompts === 'host'
      ? WORKER_PERMISSION_MODE
      : permission.legacyMode;
  if (mode !== undefined) args.push('--permission-mode', mode);
  if (host) args.push('--permission-prompts', 'host', '--permission-prompt-tool', PERMISSION_TOOL);
  else args.push('--permission-prompts', 'none');
  args.push(
    '--mcp-config',
    mcpConfig,
    '--tools',
    t.builtin.join(','),
    '--allowedTools',
    [...t.allow, ...OUTCOME_TOOL_NAMES].join(','),
  );
  if (t.deny.length > 0) args.push('--disallowedTools', t.deny.join(','));
  if (opts.appendSystemPrompt !== undefined) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }
  return args;
}

/** One stream-json user message line. */
export function userMessageLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

class Session implements CliDriverSession {
  cliVersion: string | undefined;
  private id: string;
  private readonly listeners = new Set<(ev: DriverEvent) => void>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reg: OutcomeRegistration;
  private readonly mcpConfigPath: string;
  private announced = false;
  private exited = false; // `exit` emitted
  private childGone = false; // the OS process is gone (exit/error)
  private killRequested = false;
  private killTimer: NodeJS.Timeout | undefined;
  private endTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  private openStreams = 2; // stdout + stderr

  constructor(
    private readonly bin: string,
    opts: DriverStartOptions,
    server: OutcomeServer,
    private readonly killGraceMs: number,
    private readonly endGraceMs: number,
    extraStateEnv: RegExp | undefined,
    permissionPrompts: boolean,
    private readonly prefixArgs: readonly string[] = [],
  ) {
    this.id = opts.claudeSessionId;
    this.reg = server.register(
      {
        onAskUser: (question) => this.emit({ kind: 'ask_user', question }),
        // ADR-0011: the named transition and reason are forwarded as given.
        onCompleteState: (result, meta) => this.emit({ kind: 'complete_state', result, ...meta }),
        // ADR-0023: a held prompt. Nobody listening (exited) → deny now, never hold for nothing.
        onPermissionRequest: (prompt) => {
          if (this.exited || this.childGone) throw new Error('process gone');
          this.emit({ kind: 'permission_request', ...prompt });
        },
      },
      { transitions: opts.transitions },
    );

    let settings: string;
    try {
      this.mcpConfigPath = writeMcpConfigFile(this.reg.mcpConfig);
    } catch (err) {
      this.reg.unregister();
      throw err;
    }
    try {
      settings = writeEditGuard(dirname(this.mcpConfigPath), opts.cwd);
    } catch (err) {
      this.reg.unregister();
      removeMcpConfigFile(this.mcpConfigPath);
      throw err;
    }

    const legacyMode = permissionPrompts ? undefined : agentPermissionMode();
    const permission: PermissionArgs = permissionPrompts
      ? { prompts: 'host' }
      : { prompts: 'none', ...(legacyMode !== undefined ? { legacyMode } : {}) };
    const { env, dropped } = agentEnv(opts.env, extraStateEnv);
    const notes: string[] = [];
    if (opts.review === true) {
      notes.push(`requirements reviewer: running in ${REVIEWER_PERMISSION_MODE} mode`);
    } else if (permissionPrompts) {
      notes.push(
        `running in ${WORKER_PERMISSION_MODE} mode; permission prompts go to the conductor board`,
      );
    } else {
      // TD-187: ADR-0023 asks for a machine alert here; the alert frame has no kind for it yet.
      notes.push(
        'this Claude Code has no auto mode / --permission-prompts host: running with the old flags, so anything that would prompt is denied (update Claude Code)',
      );
      if (legacyMode !== undefined) {
        notes.push('user defaultMode is bypassPermissions; running this agent in auto mode');
      }
    }
    if (dropped.length > 0) notes.push(`dropped state env keys not allowed: ${dropped.join(', ')}`);
    // After start() returns, so the caller's listener sees them (never emit inside start()).
    for (const note of notes) {
      queueMicrotask(() =>
        this.emit({ kind: 'output', stream: 'debug', text: `conductor: ${note}` }),
      );
    }
    const args = [
      ...this.prefixArgs,
      ...buildClaudeArgs(opts, this.mcpConfigPath, settings, permission),
    ];
    this.child = spawnCli(bin, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group (POSIX), so kill() also reaches the tools Claude spawned (bash, test
      // runners); win32 kills the tree with taskkill /T (TD-189).
      detached: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.on('error', (err) => {
      this.emit({
        kind: 'output',
        stream: 'stderr',
        text: `conductor: claude process error: ${err.message}\n`,
      });
      // A spawn failure (ENOENT/EACCES) never produces 'exit'.
      if (this.child.pid === undefined) this.onChildGone(null, null, true);
    });
    this.child.on('exit', (code, signal) => this.onChildGone(code, signal, false));
    this.child.stdin.on('error', (err) => {
      this.emit({
        kind: 'output',
        stream: 'debug',
        text: `conductor: stdin error: ${err.message}`,
      });
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) =>
      this.emit({ kind: 'output', stream: 'stderr', text: d }),
    );
    this.child.stderr.on('close', () => this.streamClosed());

    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    rl.on('close', () => this.streamClosed());

    this.child.stdin.write(userMessageLine(opts.prompt));
  }

  get claudeSessionId(): string {
    return this.id;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  on(listener: (ev: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendInput(text: string): void {
    if (this.childGone || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error('claude driver: no live process to send input to');
    }
    this.reg.answered();
    this.child.stdin.write(userMessageLine(text));
  }

  resolvePermission(
    requestId: string,
    decision: Parameters<OutcomeRegistration['resolvePermission']>[1],
  ): 'resolved' | 'duplicate' | 'unknown' {
    return this.reg.resolvePermission(requestId, decision);
  }

  denyPermission(requestId: string, message: string): boolean {
    return this.reg.denyPermission(requestId, message);
  }

  sendMessage(text: string): void {
    if (this.childGone || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error('claude driver: no live process to send a message to');
    }
    // Not an answer (ADR-0007): the outcome server's pending question is left as it is.
    this.child.stdin.write(userMessageLine(text));
  }

  end(): void {
    if (this.childGone) return;
    this.child.stdin.end();
    if (this.endTimer === undefined) {
      this.endTimer = setTimeout(() => this.kill(), this.endGraceMs);
    }
  }

  kill(graceMs?: number): void {
    if (this.childGone || this.killRequested) return;
    this.killRequested = true;
    this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), graceMs ?? this.killGraceMs);
  }

  /** The whole tree: POSIX the process group (then the child), win32 taskkill /T (TD-189). */
  private signal(sig: NodeJS.Signals): void {
    if (this.child.pid === undefined) return;
    killTree(this.child, { signal: sig });
  }

  private onLine(line: string): void {
    for (const item of parseStreamLine(line)) {
      if (item.kind === 'event') {
        this.emit(item.event);
        continue;
      }
      if (item.cliVersion !== undefined && this.cliVersion === undefined) {
        this.cliVersion = item.cliVersion;
        this.emit({
          kind: 'output',
          stream: 'debug',
          text: `claude_code_version ${item.cliVersion}`,
        });
      }
      const sid = item.sessionId;
      if (sid === undefined) continue;
      // init repeats every turn: announce once, and again only if the id changes.
      if (!this.announced || sid !== this.id) {
        if (sid !== this.id) {
          this.emit({
            kind: 'output',
            stream: 'debug',
            text: `conductor: system/init session_id ${sid} differs from the requested ${this.id}`,
          });
        }
        this.id = sid;
        this.announced = true;
        this.emit({ kind: 'claude_session_id', id: sid });
      }
    }
  }

  private onChildGone(code: number | null, signal: string | null, spawnFailed: boolean): void {
    if (this.childGone) return;
    this.childGone = true;
    this.exitInfo = { code, signal };
    clearTimeout(this.killTimer);
    clearTimeout(this.endTimer);
    this.reg.unregister();
    removeMcpConfigFile(this.mcpConfigPath);
    // After a kill, reap any tool processes Claude left behind in its group.
    if (this.killRequested) this.signal('SIGKILL');
    if (spawnFailed) {
      this.finish();
      return;
    }
    // Let stdout/stderr drain so the last result line is emitted before `exit`, but don't wait
    // forever on a grandchild holding the pipes open.
    if (this.openStreams === 0) this.finish();
    else this.drainTimer = setTimeout(() => this.finish(), DRAIN_MS);
  }

  private streamClosed(): void {
    this.openStreams -= 1;
    if (this.openStreams <= 0 && this.childGone) this.finish();
  }

  private finish(): void {
    if (this.exited || this.exitInfo === undefined) return;
    clearTimeout(this.drainTimer);
    this.emit({ kind: 'exit', ...this.exitInfo });
    this.exited = true;
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private emit(ev: DriverEvent): void {
    if (this.exited) return;
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch {
        // a throwing listener must not break the stream or the other listeners
      }
    }
  }

  toString(): string {
    return `CliDriverSession(${this.bin}, ${this.id})`;
  }
}

export function createCliDriver(opts: CliDriverOptions): CliDriver {
  const bin = opts.claudeBin ?? process.env[CLAUDE_BIN_ENV] ?? 'claude';
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const endGraceMs = opts.endGraceMs ?? DEFAULT_END_GRACE_MS;
  const permissionPrompts = opts.permissionPrompts ?? true;
  return {
    start(startOpts) {
      // U-110: on win32 only the native claude.exe can take the multi-line system prompt. Checked
      // before the Session registers with the outcome server or writes its MCP config.
      const notNative = nativeExeProblem(bin, process.env, startOpts.cwd);
      if (notNative !== null) throw new Error(notNative);
      return new Session(
        bin,
        startOpts,
        opts.outcomeServer,
        killGraceMs,
        endGraceMs,
        opts.extraStateEnv,
        permissionPrompts,
        opts.claudePrefixArgs,
      );
    },
  };
}
