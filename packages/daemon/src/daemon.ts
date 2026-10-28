import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { arch, homedir, hostname, platform } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  DAEMON_AUTH_HEADER,
  daemonAuthHeaderValue,
  EvaluateConditionsArgsSchema,
  NO_CONVERSATION_REASON,
  NO_OUTCOME_OUTPUT_CHARS,
  PROTOCOL_VERSION,
  parseOrchestratorMessage,
  resolveToolPolicy,
  STDERR_TAIL_CHARS,
  STDERR_TAIL_LINES,
  type JsonObject,
  type OrchestratorToDaemon,
  type OutputStream,
  type SessionEventPayload,
  type TranscriptPayload,
} from '@conductor/shared';
import type { ClaudeDriver, DriverEvent, DriverSession } from './claude/driver.js';
import {
  findTranscript,
  hasTranscriptInCwd,
  readTranscriptTail,
  transcriptChunks,
} from './claude/transcript.js';
import { createCommandRunner as defaultCreateCommandRunner } from './commands/index.js';
import type { CommandRunner, CreateCommandRunner } from './commands/runner.js';
import { daemonVersion, machineFacts, type DaemonConfig } from './config.js';
import { checkOurs, readProcInfo, type ProcInfo } from './orphan.js';
import { PortPool, portEnv } from './ports.js';
import { DaemonStore, type AckRecord, type PersistedSession, type PortRange } from './store.js';
import { liveResources, type SysInfo } from './sysinfo.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { inventoryDigest, Workspace } from './workspace.js';
import { InventoryReporter, scanInventory, type InventoryScan } from './inventory/report.js';
import {
  detectSetup,
  freshCheckout,
  managedCommand,
  missingManager,
  removeCheckout,
  sweepPrivate,
} from './actions/checkout.js';
import { evaluateConditions } from './actions/conditions.js';
import { checkClean, openPr, resolveHead } from './actions/open-pr.js';
import { ReconnectingWs } from './ws-client.js';

// Daemon core (M1-T05; 03 §Daemon ↔ orchestrator, 07, 10-contracts, ADR-0005).
//
// One outbound WS. On every (re)connect: `register` → wait for `registered` → replay buffered
// session_events after `registered.last_seq` → heartbeat, inventory (M2-T10), repo_inventory,
// request_work.
// Commands (`start_session`, `run_cmd`, `send_input`, `send_message`, `kill`) are deduped on command_id (persisted
// with the ack they got, so a re-sent command is re-acked, never re-run). The Claude driver
// (ADR-0005) and the command runner (T06) are injected.

/** The package version (without CONDUCTOR_BUILD_SHA); `register` sends `config.daemonVersion`. */
export const DAEMON_VERSION = daemonVersion({});

/**
 * U-028 (ADR-0005 addendum): the one user message sent when a turn ends with neither
 * complete_state nor ask_user. A second outcome-less turn in a row emits `no_outcome`.
 */
export const NO_OUTCOME_NUDGE =
  'You must finish by calling complete_state with your result, or ask_user if you need a human';

/** Give up waiting for a reply to request_work after this long. */
export const REQUEST_WORK_TIMEOUT_MS = 30_000;

export interface DaemonOptions {
  config: DaemonConfig;
  driver: ClaudeDriver;
  /** T06's factory; called once (lazily, on the first run_cmd) with max_concurrent_builds. */
  createCommandRunner?: CreateCommandRunner;
  sysinfo?: SysInfo;
  /** Reported in `register` (U-015). */
  claudeCodeVersion?: string | null;
  /** Test only: how open_pr runs gh (default `gh` from PATH). */
  ghCommand?: { cmd: string; args: readonly string[] };
  log?: (msg: string) => void;
  /** Test seam: the inventory scan (default: inventory/report.ts `scanInventory`). */
  scanInventory?: () => Promise<InventoryScan>;
  /**
   * BUG-1b: the Claude executable the driver runs; the startup orphan sweep only kills a process
   * whose argv is this binary. Default $CONDUCTOR_CLAUDE_BIN, else `claude` (as the CLI driver).
   */
  claudeBin?: string;
  /** Test seam: a pid's start time and command line (default: orphan.ts `readProcInfo`). */
  procInfo?: (pid: number) => ProcInfo | null;
  /**
   * The link can't recover (close 4001 revoked, 4003 unauthorized, 4005 protocol too old, or HTTP
   * 401 at the upgrade); reconnecting has stopped. `main` stops and exits non-zero.
   */
  onFatal?: (code: number, reason: string) => void;
  /**
   * Is the Claude conversation `claudeSessionId` (to be resumed in `cwd`) on this machine? Default:
   * its transcript is in the cwd's own project dir (`hasTranscriptInCwd`: `claude --resume` looks
   * nowhere else). A start that resumes one
   * that isn't is refused `no_conversation` before spawning (10-contracts §Refusals).
   */
  hasConversation?: (cwd: string, claudeSessionId: string) => boolean;
}

type Command = Extract<
  OrchestratorToDaemon,
  {
    type:
      | 'start_session'
      | 'run_cmd'
      | 'run_action'
      | 'send_input'
      | 'send_message'
      | 'kill'
      | 'permission_decision';
  }
>;
type StartSession = Extract<Command, { type: 'start_session' }>;
type RunCmd = Extract<Command, { type: 'run_cmd' }>;
type RunAction = Extract<Command, { type: 'run_action' }>;
type SendInput = Extract<Command, { type: 'send_input' }>;
type SendMessage = Extract<Command, { type: 'send_message' }>;
type Kill = Extract<Command, { type: 'kill' }>;

interface AgentProc {
  /** command_id of the start_session that spawned it (`started` / `exit` correlation). */
  commandId: string;
  fencingToken: number;
  claudeSessionId: string;
  session: DriverSession;
  completed: boolean;
  /** Parked for a human: after ask_user, or after no_outcome. Cleared by send_input. */
  askPending: boolean;
  /** U-028: the nudge was sent for the current outcome-less streak. Cleared by send_input. */
  nudged: boolean;
  /** Tail of the assistant text (NO_OUTCOME_OUTPUT_CHARS), attached to `no_outcome`. */
  lastOutput: string;
  /** Last STDERR_TAIL_LINES lines of stderr (STDERR_TAIL_CHARS), sent on `exit`. */
  stderrTail: string;
  exited: boolean;
  /** BUG-1: a kill was sent (stopAgent): later kills of the same process are no-ops. */
  killRequested: boolean;
  endTimer: NodeJS.Timeout | null;
  unsubscribe: () => void;
}

interface Starting {
  commandId: string;
  fencingToken: number;
  /** A kill arrived while the worktree was being prepared: kill the process once it exists. */
  cancelled: boolean;
  /** BUG-1: a newer start_session for the session arrived while this one was preparing. */
  superseded: boolean;
}

interface RunningCmd {
  fencingToken: number;
  abort: AbortController;
}

/** ADR-0010: an entry step's fresh checkout (the commit, its dir, the fencing token it runs under). */
interface Checkout {
  sha: string;
  dir: string;
  token: number;
}

interface LiveSession {
  agent: AgentProc | null;
  starting: Starting | null;
  cmds: Map<string, RunningCmd>;
}

export class Daemon {
  readonly config: DaemonConfig;
  readonly store: DaemonStore;
  readonly workspace: Workspace;
  readonly ports: PortPool;
  private readonly driver: ClaudeDriver;
  private readonly createRunner: CreateCommandRunner;
  private runner: CommandRunner | null = null;
  private readonly sysinfo: SysInfo;
  private readonly claudeCodeVersion: string | null;
  private readonly ghCommand: { cmd: string; args: readonly string[] } | null;
  private readonly log: (msg: string) => void;
  private readonly onFatal: (code: number, reason: string) => void;
  private readonly claudeBin: string;
  private readonly procInfo: (pid: number) => ProcInfo | null;
  private readonly hasConversation: (cwd: string, claudeSessionId: string) => boolean;
  private readonly ws: ReconnectingWs;
  /** M2-T10: the `inventory` message (rescans every 10 minutes and on SIGHUP, see main). */
  readonly inventory: InventoryReporter;

  private registered = false;
  private heartbeatMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private workTimer: NodeJS.Timeout | null = null;
  private awaitingWork: NodeJS.Timeout | null = null;
  private lastInventoryDigest = '';
  private readonly live = new Map<string, LiveSession>();
  /** session_id → timer that releases the slot a `work_assignment` holds (config.assignmentHoldMs). */
  private readonly assignments = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  /** ADR-0010: the fresh checkout an entry step's checks share (session id → its commit and dir). */
  private readonly checkouts = new Map<string, Checkout>();

  /**
   * Remove a session's fresh checkout. With `only`, remove just that one: the map entry is
   * cleared only if it is still that checkout (an old visit can't drop a newer one).
   */
  private dropCheckout(sid: string, only?: Checkout): void {
    const held = this.checkouts.get(sid);
    const target = only ?? held;
    if (target === undefined) return;
    removeCheckout(target.dir);
    if (held === target) this.checkouts.delete(sid);
  }

  constructor(opts: DaemonOptions) {
    this.config = opts.config;
    this.driver = opts.driver;
    this.createRunner = opts.createCommandRunner ?? defaultCreateCommandRunner;
    this.sysinfo = opts.sysinfo ?? liveResources;
    this.claudeCodeVersion = opts.claudeCodeVersion ?? null;
    this.ghCommand = opts.ghCommand ?? null;
    this.log = opts.log ?? ((m) => process.stderr.write(`[conductor-daemon] ${m}\n`));
    this.onFatal = opts.onFatal ?? ((code) => this.log(`link failed (${code}); stopped`));
    this.claudeBin = opts.claudeBin ?? process.env.CONDUCTOR_CLAUDE_BIN ?? 'claude';
    this.procInfo = opts.procInfo ?? readProcInfo;
    this.hasConversation =
      opts.hasConversation ?? ((cwd, id) => hasTranscriptInCwd(this.claudeConfigDir, cwd, id));
    this.heartbeatMs = this.config.heartbeatIntervalMs;
    mkdirSync(this.config.rootDir, { recursive: true });
    this.store = DaemonStore.forRoot(this.config.rootDir);
    // Fresh checkouts / push repos a previous daemon left behind (ADR-0010).
    sweepPrivate(this.config.rootDir);
    this.workspace = new Workspace(this.config.rootDir, this.store, {
      allowLocalRepos: this.config.allowLocalRepos,
      allowedRepoHosts: this.config.allowedRepoHosts,
      log: this.log,
    });
    this.ports = new PortPool(this.config.portPool);
    const scan = opts.scanInventory ?? (() => scanInventory(this.config, process.env, this.log));
    this.inventory = new InventoryReporter({
      scan,
      send: (payload) => this.sendMachine('inventory', payload),
      intervalMs: this.config.inventoryIntervalMs ?? 10 * 60_000,
      log: this.log,
    });
    for (const [sid, s] of Object.entries(this.store.sessions)) {
      if (s.portRange) this.ports.adopt(sid, s.portRange);
      if (s.agent) {
        // BUG-1: the previous daemon stopped with this process running. Claude runs in its own
        // process group (detached), so it may still be alive: kill it, then report the exit, so
        // the orchestrator resumes instead of waiting for the lease to expire.
        this.killOrphan(sid, s.agent);
        this.emit(sid, s.agent.fencingToken, {
          kind: 'exit',
          data: { command_id: s.agent.commandId, code: null, signal: 'daemon_restart' },
        });
        this.store.putSession(sid, { ...s, agent: null });
      }
    }
    this.ws = new ReconnectingWs(
      this.config.orchestratorUrl,
      this.config.reconnect,
      {
        onOpen: () => this.onOpen(),
        onMessage: (t) => this.onMessage(t),
        onClose: () => this.onClose(),
        onFatal: (code, reason) => this.onFatal(code, reason),
      },
      {
        log: this.log,
        // M2-T04: the machine credential on every upgrade; local mode sends no header.
        ...(this.config.credential !== null
          ? { headers: { [DAEMON_AUTH_HEADER]: daemonAuthHeaderValue(this.config.credential) } }
          : {}),
      },
    );
  }

  start(): void {
    this.inventory.start();
    this.ws.start();
  }

  /** SIGHUP (main): rescan the inventory and send it if it changed. */
  rescanInventory(): Promise<void> {
    return this.inventory.rescan();
  }

  /** Stop the link and timers. `killSessions` (default true) also kills every live process. */
  stop(opts: { killSessions?: boolean } = {}): void {
    this.ws.stop();
    this.onClose();
    this.inventory.stop();
    for (const t of this.assignments.values()) clearTimeout(t);
    this.assignments.clear();
    if (opts.killSessions ?? true) {
      for (const [sid, live] of this.live) {
        if (live.agent && !live.agent.exited) this.stopAgent(sid, live.agent, 'daemon stopping');
        for (const c of live.cmds.values()) c.abort.abort();
      }
    }
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  // ============================================================ link

  private onOpen(): void {
    const facts = machineFacts();
    const res = this.sysinfo(this.config.rootDir);
    this.sendMachine('register', {
      machine_id: this.config.machineId,
      // Local mode keeps M1's `enrollment_token: null`; an enrolled daemon authenticates on the
      // upgrade instead (10-contracts §Machines protocol v2).
      ...(this.config.credential === null ? { enrollment_token: null } : {}),
      protocol_version: PROTOCOL_VERSION,
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      tags: this.config.tags,
      cpu_total: facts.cpuTotal,
      mem_total_mb: facts.memTotalMb,
      disk_free_mb: res.diskFreeMb,
      budget_cpu: this.config.budgetCpu,
      budget_mem_mb: this.config.budgetMemMb,
      max_sessions: this.config.maxSessions,
      max_concurrent_builds: this.config.maxConcurrentBuilds,
      daemon_version: this.config.daemonVersion,
      claude_code_version: this.claudeCodeVersion,
    });
  }

  private onClose(): void {
    this.registered = false;
    this.inventory.onDisconnected();
    for (const t of [this.heartbeatTimer, this.workTimer, this.awaitingWork]) {
      if (t) clearTimeout(t);
    }
    this.heartbeatTimer = null;
    this.workTimer = null;
    this.awaitingWork = null;
  }

  private onMessage(text: string): void {
    let msg: OrchestratorToDaemon;
    try {
      msg = parseOrchestratorMessage(text);
    } catch (e) {
      this.log(`ignoring invalid orchestrator message: ${(e as Error).message.slice(0, 200)}`);
      return;
    }
    switch (msg.type) {
      case 'registered':
        void this.onRegistered(msg.payload.last_seq, msg.payload.heartbeat_interval_ms).catch(
          (e: unknown) => this.log(`after registered: ${String(e)}`),
        );
        return;
      case 'work_assignment':
        this.holdAssignment(msg.payload.session_id);
        this.workReplied(0);
        return;
      case 'no_work':
        this.workReplied(this.config.workPollMs);
        return;
      case 'retry_after':
        this.workReplied(msg.payload.ms);
        return;
      case 'protocol_error':
        this.log(`protocol_error ${msg.payload.code}: ${msg.payload.message}`);
        return;
      case 'fetch_transcript':
        this.sendMachine(
          'transcript',
          this.transcript(msg.payload.request_id, msg.payload.session_id),
        );
        return;
      default:
        this.onCommand(msg);
    }
  }

  private async onRegistered(lastSeq: number | null, heartbeatMs: number): Promise<void> {
    this.registered = true;
    this.ws.resetBackoff();
    this.heartbeatMs = heartbeatMs;
    for (const ev of this.store.onRegistered(lastSeq)) {
      this.ws.send(JSON.stringify({ ...ev.msg, seq: ev.seq }));
    }
    this.sendHeartbeat();
    await this.inventory.onRegistered();
    await this.sendRepoInventory(true);
    this.maybeRequestWork();
  }

  private sendHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.registered) return;
    const res = this.sysinfo(this.config.rootDir);
    const seen = new Set<string>();
    const sessions: { session_id: string; fencing_token: number }[] = [];
    const add = (sid: string, token: number) => {
      const k = `${sid}:${token}`;
      if (seen.has(k)) return;
      seen.add(k);
      sessions.push({ session_id: sid, fencing_token: token });
    };
    for (const [sid, live] of this.live) {
      if (live.agent && !live.agent.exited) add(sid, live.agent.fencingToken);
      if (live.starting) add(sid, live.starting.fencingToken);
      for (const c of live.cmds.values()) add(sid, c.fencingToken);
    }
    this.sendMachine('heartbeat', {
      cpu_free: res.cpuFree,
      mem_free_mb: res.memFreeMb,
      disk_free_mb: res.diskFreeMb,
      sessions,
    });
    this.heartbeatTimer = setTimeout(() => this.sendHeartbeat(), this.heartbeatMs);
  }

  // TD-110: the legacy repo_inventory (the shared clones), sent alongside `inventory` until T16
  // switches the gateway; removed in M2-T21.
  private async sendRepoInventory(force: boolean): Promise<void> {
    const repos = await this.workspace.inventory();
    const digest = inventoryDigest(repos);
    if (!force && digest === this.lastInventoryDigest) return;
    this.lastInventoryDigest = digest;
    this.sendMachine('repo_inventory', { repos });
  }

  // ============================================================ pull scheduling

  /** Hold a slot for an assigned session until its start_session arrives (or the hold expires). */
  private holdAssignment(sid: string): void {
    const prev = this.assignments.get(sid);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      if (this.assignments.get(sid) !== timer) return;
      this.assignments.delete(sid);
      // The start_session never came: the slot is free again.
      this.maybeRequestWork();
    }, this.config.assignmentHoldMs);
    this.assignments.set(sid, timer);
  }

  /** Drop an assignment's hold. Returns whether one existed. */
  private releaseAssignment(sid: string): boolean {
    const timer = this.assignments.get(sid);
    if (!timer) return false;
    clearTimeout(timer);
    this.assignments.delete(sid);
    return true;
  }

  /**
   * A start_session was refused: release its hold and re-arm the pull loop. With no live process
   * left, nothing else would ever send request_work again (the loop stalls until a reconnect).
   * `delayMs` > 0 (memory_pressure) waits before asking, so claim/refuse doesn't spin.
   */
  private startRefused(sid: string, delayMs: number): void {
    this.releaseAssignment(sid);
    if (delayMs <= 0 || this.awaitingWork || this.workTimer) {
      this.maybeRequestWork();
      return;
    }
    this.workTimer = setTimeout(() => {
      this.workTimer = null;
      this.maybeRequestWork();
    }, delayMs);
  }

  /** Sessions holding a slot: live or starting processes, plus fresh work assignments. */
  private slotsInUse(): number {
    const used = new Set<string>(this.assignments.keys());
    for (const [sid, live] of this.live) {
      if ((live.agent && !live.agent.exited) || live.starting) used.add(sid);
    }
    return used.size;
  }

  // TD-027: request_work is sent even under memory pressure (07 only defines the start_session
  // veto); each claim is then refused and requeued, at most once per workPollMs.
  private maybeRequestWork(): void {
    if (!this.registered || this.awaitingWork || this.workTimer) return;
    const free = this.config.maxSessions - this.slotsInUse();
    if (free <= 0) return;
    const res = this.sysinfo(this.config.rootDir);
    this.sendMachine('request_work', {
      free_slots: free,
      // 10-contracts §Inventory: the hash of the last `inventory` sent.
      repos_digest: this.inventory.hash,
      cpu_free: res.cpuFree,
      mem_free_mb: res.memFreeMb,
    });
    this.awaitingWork = setTimeout(() => {
      this.awaitingWork = null;
      this.maybeRequestWork();
    }, REQUEST_WORK_TIMEOUT_MS);
  }

  private workReplied(delayMs: number): void {
    if (this.awaitingWork) clearTimeout(this.awaitingWork);
    this.awaitingWork = null;
    if (delayMs <= 0) {
      this.maybeRequestWork();
      return;
    }
    if (this.workTimer) clearTimeout(this.workTimer);
    this.workTimer = setTimeout(() => {
      this.workTimer = null;
      this.maybeRequestWork();
    }, delayMs);
  }

  // ============================================================ commands

  private onCommand(msg: Command): void {
    const cid = msg.payload.command_id;
    if (cid !== null) {
      const prev = this.store.ackFor(cid);
      if (prev) {
        this.sendAck(msg, prev);
        return;
      }
      // Still being executed (e.g. a start_session preparing its worktree): its ack will follow.
      if (this.inFlight.has(cid)) return;
      this.inFlight.add(cid);
    }
    const run = async () => {
      switch (msg.type) {
        case 'start_session':
          return this.startSession(msg);
        case 'run_cmd':
          return this.runCmd(msg);
        case 'run_action':
          return this.runAction(msg);
        case 'send_input':
          return this.sendInput(msg);
        case 'send_message':
          return this.sendMessage(msg);
        case 'kill':
          return this.kill(msg);
        // TD-180: no test; M2-T29b replaces this case.
        case 'permission_decision':
          // ADR-0023: M2-T29b resolves the held `permission` call. Until then this daemon never
          // sends a permission_request, so it holds none (10-contracts §Permission prompts).
          return this.finish(msg, { accepted: false, reason: 'unknown_permission_request' });
      }
    };
    run()
      .catch((e: unknown) => {
        this.log(`${msg.type} failed: ${String(e)}`);
        if (cid !== null && !this.store.ackFor(cid)) {
          this.finish(msg, { accepted: false, reason: `error: ${errText(e)}` });
          if (msg.type === 'start_session') this.startRefused(msg.session_id, 0);
        }
      })
      .finally(() => {
        if (cid !== null) this.inFlight.delete(cid);
      });
  }

  /** Persist the command's ack (dedupe) and send it. */
  private finish(msg: Command, ack: AckRecord): void {
    const cid = msg.payload.command_id;
    if (cid === null) return;
    this.store.recordAck(cid, ack);
    this.sendAck(msg, ack);
  }

  private sendAck(msg: Command, ack: AckRecord): void {
    const cid = msg.payload.command_id;
    if (cid === null) return;
    this.sendRaw({
      type: 'command_ack',
      msg_id: randomUUID(),
      seq: null,
      session_id: msg.session_id,
      fencing_token: msg.fencing_token,
      payload: {
        command_id: cid,
        accepted: ack.accepted,
        ...(ack.reason ? { reason: ack.reason } : {}),
      },
    });
  }

  private liveSession(sid: string): LiveSession {
    let l = this.live.get(sid);
    if (!l) {
      l = { agent: null, starting: null, cmds: new Map() };
      this.live.set(sid, l);
    }
    return l;
  }

  private underMemoryPressure(): boolean {
    return this.sysinfo(this.config.rootDir).memFreeMb < this.config.minFreeMemMb;
  }

  private async startSession(msg: StartSession): Promise<void> {
    const sid = msg.session_id;
    const token = msg.fencing_token;
    const p = msg.payload;
    const live = this.liveSession(sid);
    const current = live.agent && !live.agent.exited ? live.agent : null;
    if (
      (current && current.fencingToken > token) ||
      (live.starting && live.starting.fencingToken > token)
    ) {
      this.finish(msg, { accepted: false, reason: 'stale_fencing_token' });
      return this.startRefused(sid, 0);
    }
    const holdsSlot = current !== null || live.starting !== null || this.assignments.has(sid);
    if (!holdsSlot && this.slotsInUse() >= this.config.maxSessions) {
      this.finish(msg, { accepted: false, reason: 'max_sessions' });
      return this.startRefused(sid, 0);
    }
    if (this.underMemoryPressure()) {
      this.log(
        `session ${sid}: refusing start (memory_pressure: ${this.sysinfo(this.config.rootDir).memFreeMb} MB available < CONDUCTOR_MIN_FREE_MEM_MB=${this.config.minFreeMemMb})`,
      );
      this.finish(msg, { accepted: false, reason: 'memory_pressure' });
      return this.startRefused(sid, this.config.workPollMs);
    }
    this.releaseAssignment(sid);
    // A new agent start means any entry step's checks are over (a reviewer starts only after the
    // last check, a worker after the step ended): drop a checkout an older visit left behind.
    const staleCheckout = this.checkouts.get(sid);
    if (staleCheckout && staleCheckout.token <= token) this.dropCheckout(sid, staleCheckout);
    if (current) {
      // A newer start for the same session supersedes the running process (same worktree).
      this.log(`session ${sid}: start ${p.command_id} supersedes ${current.commandId}`);
      this.stopAgent(sid, current, `superseded by start ${p.command_id}`);
    }
    if (live.starting) {
      // BUG-1: an older start is still preparing its worktree. It must not spawn (it would
      // orphan one of the two processes): it sees `superseded` before spawning and is refused.
      this.log(`session ${sid}: start ${p.command_id} supersedes ${live.starting.commandId}`);
      live.starting.superseded = true;
    }
    const starting: Starting = {
      commandId: p.command_id,
      fencingToken: token,
      cancelled: false,
      superseded: false,
    };
    live.starting = starting;

    let agent: AgentProc;
    let worktree: string;
    let range: PortRange;
    try {
      // TD-181: working_copy has no default_branch yet, so the base is the clone's origin/HEAD.
      worktree = await this.workspace.ensureWorktree({
        repo: p.repo,
        sessionId: sid,
        branch: p.branch,
        baseRef: p.base_ref,
      });
      // ADR-0008: a reopened session reuses the earlier session's worktree (its branch is checked
      // out there). Never while a process of another session still runs in it.
      if (worktree !== this.workspace.worktreePath(sid)) {
        const busy = Object.entries(this.store.sessions).find(
          ([id, x]) => id !== sid && sameWorktree(x.worktreePath, worktree) && this.isBusy(id),
        );
        if (busy) throw new Error(`worktree ${worktree} is in use by session ${busy[0]}`);
        this.log(`session ${sid}: reusing worktree ${worktree} (branch ${p.branch})`);
      }
      // BUG-1: superseded or killed while the worktree was prepared: never spawn.
      if (starting.superseded || starting.cancelled) {
        if (live.starting === starting) live.starting = null;
        this.finish(msg, {
          accepted: false,
          reason: starting.superseded ? 'superseded' : 'killed',
        });
        this.releaseAssignment(sid);
        return;
      }
      // A resume whose conversation isn't here (it ran on another machine): `claude --resume`
      // would exit 1. Refuse; apply forgets the id and the re-claim starts a fresh one.
      const resumeId = p.resume_claude_session_id;
      if (resumeId !== null && !this.hasConversation(worktree, resumeId)) {
        this.log(
          `session ${sid}: refusing start ${p.command_id} (${NO_CONVERSATION_REASON}: Claude conversation ${resumeId} is not on this machine)`,
        );
        if (live.starting === starting) live.starting = null;
        this.finish(msg, { accepted: false, reason: NO_CONVERSATION_REASON });
        return this.startRefused(sid, 0);
      }
      range = this.allocatePorts(sid);
      const tools = resolveToolPolicy(p.tools);
      const appendSystemPrompt = buildAppendSystemPrompt(this.workspace.readClaudeMd(worktree));
      const resume = p.resume_claude_session_id !== null;
      const claudeSessionId = p.resume_claude_session_id ?? randomUUID();
      // Persist the (pre-assigned) Claude session id before spawning (ADR-0005 §Spawn). ADR-0009:
      // a requirements reviewer's conversation is not the session's: the stored id (the
      // transcript the history and reopen read, ADR-0008) stays the worker's.
      const prior = this.store.session(sid);
      this.store.putSession(sid, {
        ticketId: p.ticket_id,
        repo: p.repo,
        worktreePath: worktree,
        branch: p.branch,
        portRange: range,
        claudeSessionId: p.review === true ? (prior?.claudeSessionId ?? null) : claudeSessionId,
        lastUsedAt: Date.now(),
      });
      // TD-022: maxBudgetUsd is not passed in M1. Whether --max-budget-usd compares against the
      // cumulative total across --resume is untested (U-018), so p.max_budget_usd is ignored.
      const session = this.driver.start({
        cwd: worktree,
        prompt: p.prompt,
        tools,
        claudeSessionId,
        resume,
        env: { ...p.env, ...portEnv(range), ...this.gitEnv() },
        appendSystemPrompt,
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.max_turns !== undefined ? { maxTurns: p.max_turns } : {}),
        // ADR-0009: a reviewer runs in dontAsk (the driver forces the mode).
        ...(p.review === true ? { review: true } : {}),
        // ADR-0011: the names complete_state accepts (one corrective nudge for another).
        ...(p.transitions !== undefined ? { transitions: p.transitions } : {}),
      });
      agent = {
        commandId: p.command_id,
        fencingToken: token,
        claudeSessionId,
        session,
        completed: false,
        askPending: false,
        nudged: false,
        lastOutput: '',
        stderrTail: '',
        exited: false,
        killRequested: false,
        endTimer: null,
        unsubscribe: () => {},
      };
      agent.unsubscribe = session.on((ev) => this.onDriverEvent(sid, agent, ev));
    } catch (e) {
      if (live.starting === starting) live.starting = null;
      this.finish(msg, { accepted: false, reason: `start_failed: ${errText(e)}` });
      return this.startRefused(sid, 0);
    }
    if (live.starting === starting) live.starting = null;
    const prev = live.agent;
    if (prev && prev !== agent && !prev.exited && prev.fencingToken <= token) {
      // Defensive (BUG-1): never drop a live process from `live` without killing it.
      this.stopAgent(sid, prev, `superseded by start ${p.command_id}`);
    }
    live.agent = agent;
    const persisted = this.store.session(sid);
    if (persisted) {
      // BUG-1b: the startup sweep needs the pid, the Claude session id and the start time to
      // recognise this process; without a readable start time it is never a sweep target.
      const pid = agent.session.pid;
      const info = pid !== undefined ? this.procInfo(pid) : null;
      if (pid !== undefined && info === null) {
        this.log(
          `session ${sid}: cannot read start time of process ${pid}; not tracked for the orphan sweep`,
        );
      }
      this.store.putSession(sid, {
        ...persisted,
        agent: {
          commandId: p.command_id,
          fencingToken: token,
          ...(pid !== undefined && info !== null
            ? { pid, claudeSessionId: agent.claudeSessionId, startedAt: info.startedAt }
            : {}),
        },
      });
    }
    this.finish(msg, { accepted: true });
    this.emit(sid, token, {
      kind: 'started',
      data: {
        command_id: p.command_id,
        worktree_path: worktree,
        branch: p.branch,
        port_range: range,
      },
    });
    if (starting.cancelled) this.stopAgent(sid, agent, 'killed while starting');
    // TD-110: legacy repo_inventory refresh, removed in M2-T21.
    void this.sendRepoInventory(false).catch((e: unknown) => this.log(`inventory: ${String(e)}`));
  }

  private onDriverEvent(sid: string, a: AgentProc, ev: DriverEvent): void {
    switch (ev.kind) {
      case 'claude_session_id':
        this.emit(sid, a.fencingToken, { kind: 'claude_session_id', data: { id: ev.id } });
        return;
      case 'output':
        if (ev.stream === 'assistant') {
          const joined = a.lastOutput ? `${a.lastOutput}\n${ev.text}` : ev.text;
          a.lastOutput = joined.slice(-NO_OUTCOME_OUTPUT_CHARS);
        } else if (ev.stream === 'stderr') {
          a.stderrTail = appendTail(a.stderrTail, ev.text);
        }
        this.sendOutput(sid, a.fencingToken, ev.stream, ev.text);
        return;
      case 'ask_user':
        a.askPending = true;
        this.emit(sid, a.fencingToken, { kind: 'ask_user', data: { question: ev.question } });
        return;
      case 'complete_state':
        a.completed = true;
        this.emit(sid, a.fencingToken, {
          kind: 'complete_state',
          data: {
            result: ev.result as JsonObject,
            ...(ev.transition !== undefined ? { transition: ev.transition } : {}),
            ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          },
        });
        return;
      case 'spend':
        this.emit(sid, a.fencingToken, {
          kind: 'spend',
          data: {
            claude_session_id: a.claudeSessionId,
            total_usd: ev.totalUsd,
            usage: {
              input_tokens: ev.usage.inputTokens,
              output_tokens: ev.usage.outputTokens,
              cache_read_tokens: ev.usage.cacheReadTokens,
              cache_creation_tokens: ev.usage.cacheCreationTokens,
            },
          },
        });
        return;
      case 'turn_end':
        // ADR-0005: turn_end stays in the daemon. After complete_state → end() (kill after a
        // grace period); after ask_user → parked, the process stays alive and idle.
        if (a.completed) {
          if (!a.endTimer) {
            a.session.end();
            a.endTimer = setTimeout(() => {
              if (!a.exited) a.session.kill(this.config.killGraceMs);
            }, this.config.endGraceMs);
          }
        } else if (!a.askPending) {
          this.noOutcome(sid, a, ev.subtype);
        }
        return;
      case 'exit': {
        a.exited = true;
        if (a.endTimer) clearTimeout(a.endTimer);
        a.endTimer = null;
        a.unsubscribe();
        this.emit(sid, a.fencingToken, {
          kind: 'exit',
          data: {
            command_id: a.commandId,
            code: ev.code,
            signal: ev.signal,
            ...(a.stderrTail.trim() !== '' ? { stderr_tail: a.stderrTail } : {}),
          },
        });
        const live = this.live.get(sid);
        if (live?.agent === a) live.agent = null;
        const s = this.store.session(sid);
        if (s) {
          const owned = s.agent?.commandId === a.commandId;
          this.store.putSession(sid, {
            ...s,
            lastUsedAt: Date.now(),
            ...(owned ? { agent: null } : {}),
          });
        }
        this.maybeRequestWork();
        return;
      }
    }
  }

  /**
   * U-028 (ADR-0005 addendum): a turn ended with neither complete_state nor ask_user. The first
   * time, nudge with one user message; if the next turn also ends without an outcome, park the
   * session (process alive and idle, like after ask_user) and emit `no_outcome`, which the
   * engine turns into an agent_question. A human answer (send_input) re-arms the nudge.
   */
  private noOutcome(sid: string, a: AgentProc, subtype: string): void {
    if (!a.nudged) {
      a.nudged = true;
      this.sendOutput(
        sid,
        a.fencingToken,
        'debug',
        `conductor: turn ended (${subtype}) without complete_state or ask_user; nudging`,
      );
      try {
        a.session.sendInput(NO_OUTCOME_NUDGE);
      } catch (e) {
        // The process is gone; its `exit` event follows and the engine handles that.
        this.log(`session ${sid}: nudge not sent: ${errText(e)}`);
      }
      return;
    }
    a.askPending = true;
    this.sendOutput(
      sid,
      a.fencingToken,
      'debug',
      `conductor: turn ended (${subtype}) without an outcome after the nudge; asking a human`,
    );
    this.emit(sid, a.fencingToken, { kind: 'no_outcome', data: { last_output: a.lastOutput } });
  }

  private sendInput(msg: SendInput): void {
    const a = this.live.get(msg.session_id)?.agent;
    if (!a || a.exited || a.completed) {
      return this.finish(msg, { accepted: false, reason: 'no_live_process' });
    }
    try {
      a.session.sendInput(msg.payload.text);
    } catch {
      return this.finish(msg, { accepted: false, reason: 'no_live_process' });
    }
    a.askPending = false;
    a.nudged = false;
    this.finish(msg, { accepted: true });
  }

  /**
   * ADR-0007: a human's message to the running agent, written to stdin as a user message (Claude
   * folds it into the current turn; a `/...` text runs as a slash command). Only the process the
   * message was meant for (`target_command_id`, at or below the envelope fencing token), and only
   * while it is working: a completed process is ending, and a parked one (ask_user / no_outcome)
   * is answered through send_input, so writing to it would start a turn nobody asked for.
   * Unlike send_input it leaves `askPending` and `nudged` alone: a message folded into a turn is
   * not an answer, and the turn still has to end with an outcome (U-028).
   */
  private sendMessage(msg: SendMessage): void {
    const p = msg.payload;
    const a = this.live.get(msg.session_id)?.agent;
    if (
      !a ||
      a.exited ||
      a.completed ||
      a.commandId !== p.target_command_id ||
      a.fencingToken > msg.fencing_token
    ) {
      return this.finish(msg, { accepted: false, reason: 'no_live_process' });
    }
    if (a.askPending) return this.finish(msg, { accepted: false, reason: 'agent_parked' });
    try {
      a.session.sendMessage(p.text);
    } catch {
      return this.finish(msg, { accepted: false, reason: 'no_live_process' });
    }
    this.finish(msg, { accepted: true });
  }

  private runCmd(msg: RunCmd): void {
    const sid = msg.session_id;
    const token = msg.fencing_token;
    const p = msg.payload;
    const s = this.store.session(sid);
    if (!s || !existsSync(s.worktreePath)) {
      return this.finish(msg, { accepted: false, reason: 'unknown_session' });
    }
    const cwd = resolve(s.worktreePath, p.cwd ?? '.');
    const rel = relative(s.worktreePath, cwd);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return this.finish(msg, { accepted: false, reason: 'invalid_cwd' });
    }
    if (this.underMemoryPressure()) {
      return this.finish(msg, { accepted: false, reason: 'memory_pressure' });
    }
    let runner: CommandRunner;
    let range: PortRange;
    try {
      runner = this.commandRunner();
      range = this.allocatePorts(sid);
    } catch (e) {
      return this.finish(msg, { accepted: false, reason: `error: ${errText(e)}` });
    }
    const live = this.liveSession(sid);
    const abort = new AbortController();
    live.cmds.set(p.command_id, { fencingToken: token, abort });
    this.finish(msg, { accepted: true });
    this.touch(sid);
    const started = Date.now();
    // ADR-0010: the commit this command runs on (an entry check's `head_sha`). An entry check
    // (`require_clean`) needs a clean worktree (an early, friendly pre-check: dirty is reported,
    // not run), and (`checkout`, Ben 2026-10-26) runs in a fresh, conductor-owned checkout of that
    // one commit, never in the agent's worktree.
    let headSha: string | null = null;
    let dirty: string[] | null = null;
    let setupFailed = false;
    const exec = (command: string, at: string) =>
      runner.run({
        commandId: p.command_id,
        sessionId: sid,
        cmd: command,
        cwd: at,
        timeoutMs: p.timeout_ms,
        env: {
          CONDUCTOR_SESSION_ID: sid,
          CONDUCTOR_TICKET_ID: s.ticketId,
          ...portEnv(range),
          ...this.gitEnv(),
        },
        signal: abort.signal,
        onOutput: (c) => this.sendOutput(sid, token, c.stream, c.text),
        onWaitingForSlot: (waiting) =>
          this.emit(sid, token, { kind: 'build_slot', data: { waiting } }),
      });
    const notRun = (text: string) => {
      this.sendOutput(sid, token, 'stderr', `conductor: ${text}\n`);
      return { exitCode: null, signal: null, timedOut: false, durationMs: 0, outputTail: text };
    };
    const work = async () => {
      if (p.require_clean) {
        const c = await checkClean(s.worktreePath);
        headSha = c.head;
        dirty = c.dirty;
        if (c.dirty !== null) {
          return notRun(`uncommitted changes, not running \`${p.cmd}\`:\n${c.dirty.join('\n')}`);
        }
      } else {
        headSha = await resolveHead(s.worktreePath);
      }
      const co = p.checkout;
      if (co === undefined) return exec(p.cmd, cwd);
      const want = co.sha ?? headSha;
      if (want === null) return notRun('could not resolve the commit to check');
      if (headSha !== null && headSha !== want) {
        return notRun(
          `the branch moved: the checks are for ${want}, the worktree is at ${headSha}`,
        );
      }
      headSha = want;
      let ok = false;
      // The checkout this run uses: its `finally` only ever removes this one, never a newer
      // visit's checkout for the same session.
      let mine: Checkout | undefined;
      try {
        let held = this.checkouts.get(sid);
        if (held && held.sha !== want) {
          this.dropCheckout(sid);
          held = undefined;
        }
        if (!held) {
          const fresh = await freshCheckout({
            root: this.config.rootDir,
            worktree: s.worktreePath,
            branch: s.branch,
            sha: want,
            signal: abort.signal,
          });
          if (!fresh.ok) {
            if (fresh.head !== null) headSha = fresh.head;
            return notRun(fresh.error);
          }
          held = { sha: want, dir: fresh.dir, token };
          this.checkouts.set(sid, held);
          mine = held;
          // TD-177: the missing-manager guards here are unit-tested only, not at daemon level.
          const setup = detectSetup(held.dir, co.setup);
          if (setup !== null) {
            const missing = missingManager(setup);
            if (missing !== null) {
              setupFailed = true;
              return notRun(missing);
            }
            this.sendOutput(
              sid,
              token,
              'debug',
              `conductor: setup \`${setup}\` in a fresh checkout of ${want}`,
            );
            const sr = await exec(setup, held.dir);
            if (sr.exitCode !== 0 || sr.timedOut) {
              setupFailed = true;
              return sr;
            }
          }
        }
        mine = held;
        const at = resolve(held.dir, p.cwd ?? '.');
        const inside = relative(held.dir, at);
        if (inside.startsWith('..') || isAbsolute(inside)) return notRun('invalid cwd');
        // M2-T30: `npm run build` runs as `pnpm run build` in a pnpm repo (its lockfile decides).
        const cmd = managedCommand(held.dir, p.cmd);
        const missing = missingManager(cmd);
        if (missing !== null) return notRun(missing);
        this.sendOutput(
          sid,
          token,
          'debug',
          `conductor: \`${cmd}\` in a fresh checkout of ${want}`,
        );
        const r = await exec(cmd, at);
        ok = r.exitCode === 0 && !r.timedOut;
        return r;
      } finally {
        // Any failure, or the last check: this run's checkout goes (and nothing newer).
        if ((!ok || co.last) && mine !== undefined) this.dropCheckout(sid, mine);
      }
    };
    work()
      .then(
        (r) => ({
          exit_code: r.exitCode,
          signal: r.signal,
          timed_out: r.timedOut,
          duration_ms: Math.max(0, Math.round(r.durationMs)),
          output_tail: r.outputTail,
        }),
        (e: unknown) => ({
          exit_code: null,
          signal: null,
          timed_out: false,
          duration_ms: Math.max(0, Date.now() - started),
          output_tail: `conductor: command could not be spawned: ${errText(e)}`,
        }),
      )
      .then((data) => {
        live.cmds.delete(p.command_id);
        this.emit(sid, token, {
          kind: 'cmd_exit',
          data: {
            command_id: p.command_id,
            ...data,
            head_sha: headSha,
            ...(dirty !== null ? { dirty } : {}),
            ...(setupFailed ? { setup_failed: true } : {}),
          },
        });
      })
      .catch((e: unknown) => this.log(`run_cmd ${p.command_id}: ${String(e)}`));
  }

  /**
   * ADR-0010: an entry action, performed by this daemon (never by an agent) in the session's
   * worktree with the machine's own git / gh credentials. Acked at once; the outcome follows as
   * `session_event action_result`. A kill aborts it like a command.
   */
  private runAction(msg: RunAction): void {
    if (msg.payload.action === 'evaluate_conditions') return this.evaluateConditions(msg);
    const sid = msg.session_id;
    const token = msg.fencing_token;
    const p = msg.payload;
    const s = this.store.session(sid);
    if (!s || !existsSync(s.worktreePath)) {
      return this.finish(msg, { accepted: false, reason: 'unknown_session' });
    }
    const live = this.liveSession(sid);
    const abort = new AbortController();
    live.cmds.set(p.command_id, { fencingToken: token, abort });
    this.finish(msg, { accepted: true });
    this.touch(sid);
    const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    this.sendOutput(sid, token, 'debug', `conductor: ${p.action} for ${p.target_state}`);
    openPr({
      worktree: s.worktreePath,
      // The daemon's own records (not the message): the branch it created the worktree on and
      // the repo it cloned. The push goes to that repo's URL, never the clone's config `origin`.
      branch: s.branch,
      repo: s.repo,
      policy: {
        allowLocalRepos: this.config.allowLocalRepos,
        allowedRepoHosts: this.config.allowedRepoHosts,
      },
      title: str(p.args.title, s.branch),
      body: str(p.args.body, 'Opened by conductor.'),
      root: this.config.rootDir,
      expectedSha: p.expected_sha,
      ...(this.ghCommand ? { gh: this.ghCommand } : {}),
      signal: abort.signal,
    })
      .catch((e: unknown) => ({ ok: false as const, error: errText(e) }))
      .then((r) => {
        live.cmds.delete(p.command_id);
        this.sendOutput(
          sid,
          token,
          'debug',
          r.ok
            ? `conductor: pull request ${r.url}${r.reused ? ' (existing)' : ''}`
            : `conductor: ${p.action} failed: ${r.error}`,
        );
        this.emit(sid, token, {
          kind: 'action_result',
          data: {
            command_id: p.command_id,
            action: p.action,
            result: r.ok ? { pr_url: r.url } : null,
            error: r.ok ? null : r.error,
          },
        });
      })
      .catch((e: unknown) => this.log(`run_action ${p.command_id}: ${String(e)}`));
  }

  /**
   * ADR-0011 `evaluate_conditions`: read-only, needs no worktree, so it is accepted for a session
   * this daemon doesn't hold (ADR-0016: any online machine of the account may evaluate). gh runs
   * in the daemon root with the open_pr hardening. A kill aborts it like a command.
   */
  private evaluateConditions(msg: RunAction): void {
    const sid = msg.session_id;
    const token = msg.fencing_token;
    const p = msg.payload;
    const args = EvaluateConditionsArgsSchema.safeParse(p.args);
    const hadLive = this.live.has(sid);
    const live = this.liveSession(sid);
    const abort = new AbortController();
    live.cmds.set(p.command_id, { fencingToken: token, abort });
    this.finish(msg, { accepted: true });
    this.touch(sid);
    const report = (result: JsonObject | null, error: string | null) => {
      live.cmds.delete(p.command_id);
      // Don't keep an empty entry for a session that only came here to be evaluated.
      if (!hadLive && live.agent === null && live.starting === null && live.cmds.size === 0) {
        if (this.live.get(sid) === live) this.live.delete(sid);
      }
      this.emit(sid, token, {
        kind: 'action_result',
        data: { command_id: p.command_id, action: p.action, result, error },
      });
    };
    if (!args.success) {
      report(null, `evaluate_conditions: invalid args: ${args.error.issues[0]?.message ?? ''}`);
      return;
    }
    this.sendOutput(sid, token, 'debug', `conductor: evaluating conditions for ${p.target_state}`);
    evaluateConditions({
      conditions: args.data.conditions,
      prUrl: args.data.pr_url,
      headSha: args.data.head_sha,
      root: this.config.rootDir,
      ...(this.ghCommand ? { gh: this.ghCommand } : {}),
      signal: abort.signal,
    })
      .then(
        (r) => report(r as unknown as JsonObject, null),
        (e: unknown) => report(null, `evaluate_conditions failed: ${errText(e)}`),
      )
      .catch((e: unknown) => this.log(`run_action ${p.command_id}: ${String(e)}`));
  }

  /** 10-contracts §Orphaned processes, rule 5. */
  private kill(msg: Kill): void {
    const live = this.live.get(msg.session_id);
    const p = msg.payload;
    const a = live?.agent && !live.agent.exited ? live.agent : null;
    if (live && p.target_command_id !== null) {
      if (a && a.commandId === p.target_command_id) this.stopAgent(msg.session_id, a, p.reason);
      if (live.starting?.commandId === p.target_command_id) live.starting.cancelled = true;
    } else if (live) {
      if (a && a.fencingToken <= msg.fencing_token) this.stopAgent(msg.session_id, a, p.reason);
      if (live.starting && live.starting.fencingToken <= msg.fencing_token)
        live.starting.cancelled = true;
      for (const c of live.cmds.values()) {
        if (c.fencingToken <= msg.fencing_token) c.abort.abort();
      }
    }
    // A session kill (cancel, step timeout, budget…) ends any entry step: its checkout goes too
    // (otherwise a non-last check's checkout, node_modules and all, would stay until restart).
    const held = this.checkouts.get(msg.session_id);
    if (p.target_command_id === null && held && held.token <= msg.fencing_token) {
      this.dropCheckout(msg.session_id, held);
    }
    this.finish(msg, { accepted: true });
  }

  /**
   * BUG-1: the one way an agent process is killed (kill command, supersede, daemon stop). Signals
   * the process group once and logs once, however often the same kill arrives (the heartbeat
   * backstop repeats `stale_fencing_token` until the process is gone).
   */
  private stopAgent(sid: string, a: AgentProc, reason: string): void {
    if (a.exited || a.killRequested) return;
    a.killRequested = true;
    this.log(`session ${sid}: kill (${reason}) stops process ${a.commandId}`);
    a.session.kill(this.config.killGraceMs);
  }

  /**
   * BUG-1/BUG-1b: kill a Claude process a previous daemon left running, only if it is provably
   * ours: the pid is alive, its start time equals the recorded `startedAt`, its argv is the
   * configured Claude binary with `--session-id`/`--resume <id>` as adjacent tokens, and the stored
   * id is a UUID (orphan.ts `checkOurs`). Anything else is logged and left alone. SIGTERM to the
   * process group; the check is repeated before the SIGKILL after the grace period. Only the group
   * is ever signalled (never a bare pid): if it is gone (ESRCH), so is the process.
   */
  private killOrphan(sid: string, agent: NonNullable<PersistedSession['agent']>): void {
    const { pid } = agent;
    if (pid === undefined) return;
    if (agent.startedAt === undefined) {
      // FR-4: written by BUG-1's build; the caller clears the entry.
      this.log(
        `orphan sweep: pid ${pid} of session ${sid} has no recorded start time (old entry); left alone`,
      );
      return;
    }
    const notOurs = (reason: string, extra = '') =>
      this.log(`orphan sweep: pid ${pid} alive but not ours (${reason}); left alone${extra}`);
    const liveness = (): boolean | null => {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return null; // gone
        return false; // EPERM: another user's process, never ours
      }
      return true;
    };
    const signalGroup = (sig: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false; // ESRCH: the group is gone
      }
    };
    const alive = liveness();
    if (alive === null) return;
    if (!alive) return notOurs('not signalable');
    const c = checkOurs(this.procInfo(pid), agent, this.claudeBin);
    if (!c.ok) return notOurs(c.reason);
    if (!signalGroup('SIGTERM')) return;
    this.log(`startup: killed orphaned claude process ${pid} of session ${sid}`);
    setTimeout(() => {
      if (liveness() !== true) return;
      const again = checkOurs(this.procInfo(pid), agent, this.claudeBin);
      if (!again.ok) return notOurs(again.reason, ' (no SIGKILL)');
      signalGroup('SIGKILL');
    }, this.config.killGraceMs).unref();
  }

  // ============================================================ transcripts (ADR-0008)

  /** Claude Code's config dir (where its transcripts are), as the agents see it. */
  get claudeConfigDir(): string {
    return (
      this.config.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    );
  }

  /**
   * The reply to `fetch_transcript`. The file is located only from this daemon's store (the
   * session's worktree and Claude session id), never from the request, so a request can't name
   * a path. Read-only: no ack, no dedupe, nothing persisted.
   */
  transcript(requestId: string, sessionId: string): TranscriptPayload {
    const s = this.store.session(sessionId);
    if (!s) return { request_id: requestId, error: 'unknown_session' };
    if (s.claudeSessionId === null) return { request_id: requestId, error: 'no_transcript' };
    const path = findTranscript(this.claudeConfigDir, s.worktreePath, s.claudeSessionId);
    if (path === null) return { request_id: requestId, error: 'no_transcript' };
    try {
      // TD-089: a synchronous read (at most TRANSCRIPT_READ_BYTES) on the daemon's event loop.
      const { text, cut } = readTranscriptTail(path);
      const { chunks, truncated } = transcriptChunks(text);
      return { request_id: requestId, chunks, truncated: truncated || cut };
    } catch (e) {
      this.log(`transcript for session ${sessionId}: ${errText(e)}`);
      return { request_id: requestId, error: 'read_failed' };
    }
  }

  // ============================================================ helpers

  private commandRunner(): CommandRunner {
    this.runner ??= this.createRunner({ maxConcurrent: this.config.maxConcurrentBuilds });
    return this.runner;
  }

  /** The session's port range; on exhaustion, reclaim the least recently used idle session's. */
  private allocatePorts(sid: string): PortRange {
    const existing = this.ports.rangeOf(sid);
    if (existing) return existing;
    if (this.ports.allocated >= this.ports.capacity) {
      // TD-024: the daemon never learns that a session is terminal, so ranges are only freed by
      // reclaiming the least recently used session that has no live process or command.
      const idle = Object.entries(this.store.sessions)
        .filter(([id, s]) => id !== sid && s.portRange !== null && !this.isBusy(id))
        .sort((x, y) => x[1].lastUsedAt - y[1].lastUsedAt)[0];
      if (idle) {
        this.ports.release(idle[0]);
        this.store.putSession(idle[0], { ...idle[1], portRange: null });
      }
    }
    return this.ports.allocate(sid);
  }

  private isBusy(sid: string): boolean {
    const l = this.live.get(sid);
    return !!l && ((l.agent !== null && !l.agent.exited) || l.starting !== null || l.cmds.size > 0);
  }

  private touch(sid: string): void {
    const s = this.store.session(sid);
    if (s) this.store.putSession(sid, { ...s, lastUsedAt: Date.now() });
  }

  private gitEnv(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: this.config.gitName,
      GIT_AUTHOR_EMAIL: this.config.gitEmail,
      GIT_COMMITTER_NAME: this.config.gitName,
      GIT_COMMITTER_EMAIL: this.config.gitEmail,
    };
  }

  /** A durable session_event: buffered on disk, sequenced when registered, replayed on reconnect. */
  private emit(sid: string, token: number, payload: SessionEventPayload): void {
    const ev = this.store.pushEvent(
      {
        type: 'session_event',
        msg_id: randomUUID(),
        session_id: sid,
        fencing_token: token,
        payload,
      },
      this.registered,
    );
    if (this.registered && ev.seq !== null)
      this.ws.send(JSON.stringify({ ...ev.msg, seq: ev.seq }));
  }

  /** Terminal output: not persisted, not replayed; dropped while disconnected. */
  private sendOutput(sid: string, token: number, stream: OutputStream, text: string): void {
    if (!this.registered) return;
    this.sendRaw({
      type: 'output',
      msg_id: randomUUID(),
      seq: null,
      session_id: sid,
      fencing_token: token,
      payload: { stream, text, ts: new Date().toISOString() },
    });
  }

  private sendMachine(type: string, payload: unknown): void {
    this.sendRaw({
      type,
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload,
    });
  }

  private sendRaw(envelope: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(envelope));
  }
}

function sameWorktree(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/**
 * The last STDERR_TAIL_LINES lines (at most STDERR_TAIL_CHARS) of `prev` + `chunk`. Chunks are
 * raw stderr reads, so a line may span two of them; the tail keeps the text as it arrived.
 */
export function appendTail(prev: string, chunk: string): string {
  const lines = (prev + chunk).split('\n');
  // A trailing newline leaves an empty last element: it doesn't count as a line.
  const keep = lines.at(-1) === '' ? STDERR_TAIL_LINES + 1 : STDERR_TAIL_LINES;
  return lines.slice(-keep).join('\n').slice(-STDERR_TAIL_CHARS);
}
