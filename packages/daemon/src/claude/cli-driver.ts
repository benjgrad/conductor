// The real ClaudeDriver (ADR-0005, accepted): one long-lived `claude -p` child per session in
// bidirectional stream-json mode, outcome tools on the daemon-hosted MCP server.
//
//   const outcomeServer = await startOutcomeServer();
//   const driver = createCliDriver({ outcomeServer });   // claudeBin ← CONDUCTOR_CLAUDE_BIN ← 'claude'
//   const s = driver.start(opts); s.on(ev => …); s.sendInput(answer); s.end(); s.kill();
//
// Events are emitted synchronously from stream / HTTP callbacks, never inside start(), so a
// listener attached right after start() sees everything. Nothing is emitted after `exit`.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ClaudeDriver, DriverEvent, DriverSession, DriverStartOptions } from './driver.js';
import { writeEditGuard } from './edit-guard.js';
import {
  OUTCOME_TOOL_NAMES,
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
}

/** A DriverSession plus what the CLI reported about itself (U-015). */
export interface CliDriverSession extends DriverSession {
  /** `claude_code_version` from the first system/init; undefined until then. */
  readonly cliVersion: string | undefined;
  readonly pid: number | undefined;
}

export interface CliDriver extends ClaudeDriver {
  start(opts: DriverStartOptions): CliDriverSession;
}

/**
 * Write the session's `--mcp-config` JSON (it holds the per-session URL token) to a 0600 file in a
 * fresh private 0700 directory, so the token never appears in argv / `ps` (M1-T14). The caller
 * removes the directory with `removeMcpConfigFile` when the process is gone.
 */
export function writeMcpConfigFile(mcpConfig: string, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, 'conductor-mcp-'));
  chmodSync(dir, 0o700);
  const path = join(dir, 'mcp.json');
  writeFileSync(path, mcpConfig, { mode: 0o600, flag: 'wx' });
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
 * them), and safe mode, which would drop the edit-guard hook, stays off.
 */
export const AGENT_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_SAFE_MODE: '0',
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

/**
 * ADR-0009: the permission mode of a requirements reviewer, whatever the user's own mode. In
 * dontAsk only pre-approved tools (Read/Glob/Grep, the `review` alias's exact git commands, the
 * conductor outcome tools) run; anything else is denied without a prompt.
 */
export const REVIEWER_PERMISSION_MODE = 'dontAsk';

/**
 * The exact argv of ADR-0005 §Spawn as amended by ADR-0006 (without the executable). `mcpConfig`
 * is what goes after `--mcp-config`: the driver passes the path from `writeMcpConfigFile` (the CLI
 * accepts a file path or a JSON string), never the JSON itself. `settings` is the edit-guard
 * settings file from `writeEditGuard`.
 *
 * ADR-0006: the user's settings load (`--setting-sources user`; never `project`: the repo is
 * untrusted and its settings could disable the guard hook), so the user's permission mode, rules,
 * hooks and skills apply. `permissionMode` is passed only to cap the user's mode (see
 * `agentPermissionMode`). The state's policy still limits the visible built-ins (`--tools`),
 * pre-approves its rules and adds its denies; anything that would prompt is denied
 * (`--permission-prompts none`). TD-081: what the user's settings allow is per machine and not
 * recorded.
 */
export function buildClaudeArgs(
  opts: DriverStartOptions,
  mcpConfig: string,
  settings: string,
  permissionMode?: string,
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
  // ADR-0009: a reviewer is forced into dontAsk (only its pre-approved read-only rules run); a
  // worker keeps the user's mode, capped by `agentPermissionMode`.
  const mode = opts.review === true ? REVIEWER_PERMISSION_MODE : permissionMode;
  if (mode !== undefined) args.push('--permission-mode', mode);
  args.push(
    '--permission-prompts',
    'none',
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
    extraStateEnv?: RegExp,
  ) {
    this.id = opts.claudeSessionId;
    this.reg = server.register({
      onAskUser: (question) => this.emit({ kind: 'ask_user', question }),
      onCompleteState: (result) => this.emit({ kind: 'complete_state', result }),
    });

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

    const mode = agentPermissionMode();
    const { env, dropped } = agentEnv(opts.env, extraStateEnv);
    const notes: string[] = [];
    if (opts.review === true) {
      notes.push(`requirements reviewer: running in ${REVIEWER_PERMISSION_MODE} mode`);
    } else if (mode !== undefined) {
      notes.push('user defaultMode is bypassPermissions; running this agent in auto mode');
    }
    if (dropped.length > 0) notes.push(`dropped state env keys not allowed: ${dropped.join(', ')}`);
    // After start() returns, so the caller's listener sees them (never emit inside start()).
    for (const note of notes) {
      queueMicrotask(() =>
        this.emit({ kind: 'output', stream: 'debug', text: `conductor: ${note}` }),
      );
    }
    this.child = spawn(bin, buildClaudeArgs(opts, this.mcpConfigPath, settings, mode), {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so kill() also reaches the tools Claude spawned (bash, test runners).
      detached: true,
    });

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

  private signal(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // the whole process group
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        // already gone
      }
    }
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
  return {
    start(startOpts) {
      return new Session(
        bin,
        startOpts,
        opts.outcomeServer,
        killGraceMs,
        endGraceMs,
        opts.extraStateEnv,
      );
    },
  };
}
