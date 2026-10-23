import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  NO_OUTCOME_OUTPUT_CHARS,
  parseOrchestratorMessage,
  resolveToolPolicy,
  type JsonObject,
  type OrchestratorToDaemon,
  type OutputStream,
  type SessionEventPayload,
} from '@conductor/shared';
import type { ClaudeDriver, DriverEvent, DriverSession } from './claude/driver.js';
import { createCommandRunner as defaultCreateCommandRunner } from './commands/index.js';
import type { CommandRunner, CreateCommandRunner } from './commands/runner.js';
import { machineFacts, type DaemonConfig } from './config.js';
import { PortPool, portEnv } from './ports.js';
import { DaemonStore, type AckRecord, type PortRange } from './store.js';
import { liveResources, type SysInfo } from './sysinfo.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { inventoryDigest, Workspace } from './workspace.js';
import { ReconnectingWs } from './ws-client.js';

// Daemon core (M1-T05; 03 §Daemon ↔ orchestrator, 07, 10-contracts, ADR-0005).
//
// One outbound WS. On every (re)connect: `register` → wait for `registered` → replay buffered
// session_events after `registered.last_seq` → heartbeat, repo_inventory, request_work.
// Commands (`start_session`, `run_cmd`, `send_input`, `kill`) are deduped on command_id (persisted
// with the ack they got, so a re-sent command is re-acked, never re-run). The Claude driver
// (ADR-0005) and the command runner (T06) are injected.

export const DAEMON_VERSION = '0.0.0';

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
  log?: (msg: string) => void;
}

type Command = Extract<
  OrchestratorToDaemon,
  { type: 'start_session' | 'run_cmd' | 'send_input' | 'kill' }
>;
type StartSession = Extract<Command, { type: 'start_session' }>;
type RunCmd = Extract<Command, { type: 'run_cmd' }>;
type SendInput = Extract<Command, { type: 'send_input' }>;
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
  exited: boolean;
  endTimer: NodeJS.Timeout | null;
  unsubscribe: () => void;
}

interface Starting {
  commandId: string;
  fencingToken: number;
  /** A kill arrived while the worktree was being prepared: kill the process once it exists. */
  cancelled: boolean;
}

interface RunningCmd {
  fencingToken: number;
  abort: AbortController;
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
  private readonly log: (msg: string) => void;
  private readonly ws: ReconnectingWs;

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

  constructor(opts: DaemonOptions) {
    this.config = opts.config;
    this.driver = opts.driver;
    this.createRunner = opts.createCommandRunner ?? defaultCreateCommandRunner;
    this.sysinfo = opts.sysinfo ?? liveResources;
    this.claudeCodeVersion = opts.claudeCodeVersion ?? null;
    this.log = opts.log ?? ((m) => process.stderr.write(`[conductor-daemon] ${m}\n`));
    this.heartbeatMs = this.config.heartbeatIntervalMs;
    mkdirSync(this.config.rootDir, { recursive: true });
    this.store = DaemonStore.forRoot(this.config.rootDir);
    this.workspace = new Workspace(this.config.rootDir, this.store, {
      allowLocalRepos: this.config.allowLocalRepos,
      allowedRepoHosts: this.config.allowedRepoHosts,
      log: this.log,
    });
    this.ports = new PortPool(this.config.portPool);
    for (const [sid, s] of Object.entries(this.store.sessions)) {
      if (s.portRange) this.ports.adopt(sid, s.portRange);
      if (s.agent) {
        // The process died with the previous daemon (children don't outlive it): report the
        // exit, so the orchestrator resumes instead of waiting for the lease to expire.
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
      },
      this.log,
    );
  }

  start(): void {
    this.ws.start();
  }

  /** Stop the link and timers. `killSessions` (default true) also kills every live process. */
  stop(opts: { killSessions?: boolean } = {}): void {
    this.ws.stop();
    this.onClose();
    for (const t of this.assignments.values()) clearTimeout(t);
    this.assignments.clear();
    if (opts.killSessions ?? true) {
      for (const live of this.live.values()) {
        if (live.agent && !live.agent.exited) live.agent.session.kill(this.config.killGraceMs);
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
      enrollment_token: null,
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
      daemon_version: DAEMON_VERSION,
      claude_code_version: this.claudeCodeVersion,
    });
  }

  private onClose(): void {
    this.registered = false;
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
    await this.sendInventory(true);
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

  private async sendInventory(force: boolean): Promise<void> {
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
      repos_digest: this.lastInventoryDigest,
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
        case 'send_input':
          return this.sendInput(msg);
        case 'kill':
          return this.kill(msg);
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
    if (current) {
      // A newer start for the same session supersedes the running process (same worktree).
      this.log(`session ${sid}: start ${p.command_id} supersedes ${current.commandId}`);
      current.session.kill(this.config.killGraceMs);
    }
    const starting: Starting = { commandId: p.command_id, fencingToken: token, cancelled: false };
    live.starting = starting;

    let agent: AgentProc;
    let worktree: string;
    let range: PortRange;
    try {
      worktree = await this.workspace.ensureWorktree({
        repo: p.repo,
        sessionId: sid,
        branch: p.branch,
        baseRef: p.base_ref,
      });
      range = this.allocatePorts(sid);
      const tools = resolveToolPolicy(p.tools);
      const appendSystemPrompt = buildAppendSystemPrompt(this.workspace.readClaudeMd(worktree));
      const resume = p.resume_claude_session_id !== null;
      const claudeSessionId = p.resume_claude_session_id ?? randomUUID();
      // Persist the (pre-assigned) Claude session id before spawning (ADR-0005 §Spawn).
      this.store.putSession(sid, {
        ticketId: p.ticket_id,
        repo: p.repo,
        worktreePath: worktree,
        branch: p.branch,
        portRange: range,
        claudeSessionId,
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
        exited: false,
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
    live.agent = agent;
    const persisted = this.store.session(sid);
    if (persisted) {
      this.store.putSession(sid, {
        ...persisted,
        agent: { commandId: p.command_id, fencingToken: token },
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
    if (starting.cancelled) agent.session.kill(this.config.killGraceMs);
    void this.sendInventory(false).catch((e: unknown) => this.log(`inventory: ${String(e)}`));
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
          data: { result: ev.result as JsonObject },
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
          data: { command_id: a.commandId, code: ev.code, signal: ev.signal },
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
    runner
      .run({
        commandId: p.command_id,
        sessionId: sid,
        cmd: p.cmd,
        cwd,
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
      })
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
        this.emit(sid, token, { kind: 'cmd_exit', data: { command_id: p.command_id, ...data } });
      })
      .catch((e: unknown) => this.log(`run_cmd ${p.command_id}: ${String(e)}`));
  }

  /** 10-contracts §Orphaned processes, rule 5. */
  private kill(msg: Kill): void {
    const live = this.live.get(msg.session_id);
    const p = msg.payload;
    const a = live?.agent && !live.agent.exited ? live.agent : null;
    if (live && p.target_command_id !== null) {
      if (a && a.commandId === p.target_command_id) a.session.kill(this.config.killGraceMs);
      if (live.starting?.commandId === p.target_command_id) live.starting.cancelled = true;
    } else if (live) {
      if (a && a.fencingToken <= msg.fencing_token) a.session.kill(this.config.killGraceMs);
      if (live.starting && live.starting.fencingToken <= msg.fencing_token)
        live.starting.cancelled = true;
      for (const c of live.cmds.values()) {
        if (c.fencingToken <= msg.fencing_token) c.abort.abort();
      }
    }
    this.finish(msg, { accepted: true });
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

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
