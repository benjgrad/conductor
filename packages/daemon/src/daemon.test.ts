import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOSE_REVOKED,
  NO_CONVERSATION_REASON,
  NO_OUTCOME_OUTPUT_CHARS,
  PROTOCOL_VERSION,
  resolveToolPolicy,
  sessionBranch,
  STDERR_TAIL_CHARS,
  type OrchestratorToDaemon,
} from '@conductor/shared';
import { FakeClaudeDriver, type FakeClaudeScript } from './claude/fake-driver.js';
import { transcriptPathFor } from './claude/transcript.js';
import { FakeCommandRunner } from './commands/fake-runner.js';
import { daemonVersion, loadConfig, type DaemonConfig } from './config.js';
import { writeCredential } from './credential.js';
import { appendTail, Daemon, NO_OUTCOME_NUDGE } from './daemon.js';
import { readProcInfo, type ProcInfo } from './orphan.js';
import { mkdirPrivate, workflowShell } from './platform/index.js';
import { DaemonStore } from './store.js';
import type { LiveResources } from './sysinfo.js';
import { CONDUCTOR_INSTRUCTIONS } from './system-prompt.js';
import { FakeOrchestrator } from './test-support/fake-orchestrator.js';
import { removeTree } from './test-support/remove-tree.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// M1-T05 acceptance: the daemon core against a fake orchestrator WS, with FakeClaudeDriver,
// FakeCommandRunner and real git in temp dirs.

const TICKET = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';

let tmp: string;
let repo: string;
let orch: FakeOrchestrator;
const daemons: Daemon[] = [];
let resources: LiveResources;

function gitInit(dir: string): void {
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '--quiet', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Fixture repo\nAlways run npm test.\n');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '--quiet', '-m', 'init');
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-daemon-'));
  mkdirPrivate(tmp); // win32: the daemon makes its root private, which needs a private parent
  repo = join(tmp, 'origin');
  execFileSync('mkdir', ['-p', repo]);
  gitInit(repo);
  orch = await FakeOrchestrator.start();
  resources = { cpuFree: 4, memFreeMb: 8000, diskFreeMb: 50_000 };
});

afterEach(async () => {
  for (const d of daemons.splice(0)) d.stop();
  await orch.close();
  expect(orch.invalid).toEqual([]);
  // A background `git` (repo inventory) may still be writing when the test ends (TD-111).
  await removeTree(tmp);
});

function makeDaemon(
  driver: FakeClaudeDriver,
  opts: {
    runner?: FakeCommandRunner;
    env?: Record<string, string>;
    root?: string;
    config?: Partial<DaemonConfig>;
    ghCommand?: { cmd: string; args: readonly string[] };
    onFatal?: (code: number, reason: string) => void;
    log?: (msg: string) => void;
    claudeBin?: string;
    procInfo?: (pid: number) => ProcInfo | null;
    hasConversation?: (cwd: string, claudeSessionId: string) => boolean;
  } = {},
): Daemon {
  const config = loadConfig({
    CONDUCTOR_ORCHESTRATOR_URL: orch.url,
    CONDUCTOR_ROOT: opts.root ?? join(tmp, 'root'),
    CONDUCTOR_MACHINE_ID: 'test-machine',
    CONDUCTOR_MAX_SESSIONS: '2',
    CONDUCTOR_PORT_POOL: '42000-42029',
    CONDUCTOR_MIN_FREE_MEM_MB: '1000',
    CONDUCTOR_WORK_POLL_MS: '60000',
    CONDUCTOR_ALLOW_LOCAL_REPOS: '1', // the fixture origin is a local path (M1-T14)
    CLAUDE_CONFIG_DIR: claudeDir(), // transcripts (the resume check) never come from ~/.claude
    ...opts.env,
  });
  config.reconnect = { initialMs: 20, maxMs: 100, factor: 2 };
  config.endGraceMs = 200;
  Object.assign(config, opts.config);
  const runner = opts.runner ?? new FakeCommandRunner(2, true);
  const d = new Daemon({
    config,
    driver,
    createCommandRunner: () => runner,
    sysinfo: () => resources,
    claudeCodeVersion: '2.1.308',
    log: opts.log ?? (() => {}),
    // M2-T10: hermetic: no real gh / az / ~/.claude probes.
    scanInventory: () => Promise.resolve({ repos: [], capabilities: [] }),
    ...(opts.ghCommand ? { ghCommand: opts.ghCommand } : {}),
    ...(opts.onFatal ? { onFatal: opts.onFatal } : {}),
    ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
    ...(opts.procInfo ? { procInfo: opts.procInfo } : {}),
    ...(opts.hasConversation ? { hasConversation: opts.hasConversation } : {}),
  });
  daemons.push(d);
  d.start();
  return d;
}

function claudeDir(): string {
  return join(tmp, 'claude-config');
}

/**
 * A Claude transcript for `claudeSessionId`: in the project dir of session `sid`'s worktree (where
 * `claude --resume` looks), or under an unrelated project dir with `elsewhere`.
 */
function writeTranscriptFor(
  d: Daemon,
  sid: string,
  claudeSessionId: string,
  elsewhere = false,
): void {
  const wt = d.workspace.worktreePath(sid);
  mkdirSync(dirname(wt), { recursive: true }); // so realCwd resolves the parent like the real one
  const file = elsewhere
    ? join(claudeDir(), 'projects', '-elsewhere', `${claudeSessionId}.jsonl`)
    : transcriptPathFor(claudeDir(), wt, claudeSessionId)!;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"type":"user"}\n');
}

function startSession(
  sessionId: string,
  over: Partial<Extract<OrchestratorToDaemon, { type: 'start_session' }>['payload']> = {},
  token = 1,
): Extract<OrchestratorToDaemon, { type: 'start_session' }> {
  return {
    type: 'start_session',
    msg_id: randomUUID(),
    seq: null,
    session_id: sessionId,
    fencing_token: token,
    payload: {
      command_id: randomUUID(),
      ticket_id: TICKET,
      repo,
      base_ref: 'HEAD',
      branch: sessionBranch(TICKET, sessionId),
      workflow_state: 'implement',
      prompt: 'Implement the ticket',
      tools: ['read', 'edit', 'bash', 'git'],
      resume_claude_session_id: null,
      max_budget_usd: 5,
      env: { CONDUCTOR_SESSION_ID: sessionId, CONDUCTOR_TICKET_ID: TICKET },
      ...over,
    },
  };
}

function cmd<T extends 'send_input' | 'send_message' | 'run_cmd' | 'run_action' | 'kill'>(
  type: T,
  sessionId: string,
  payload: Extract<OrchestratorToDaemon, { type: T }>['payload'],
  token = 1,
): OrchestratorToDaemon {
  return {
    type,
    msg_id: randomUUID(),
    seq: null,
    session_id: sessionId,
    fencing_token: token,
    payload,
  } as OrchestratorToDaemon;
}

/** ADR-0010 open_pr's fake gh: `repo view` → main, `pr view` → none, `pr create` → a PR URL. */
const FAKE_GH_SH = {
  cmd: workflowShell().file, // /bin/sh; Git Bash on win32
  args: [
    '-c',
    [
      'if [ "$1" = --version ]; then echo "gh version 2.103.3 (2025-01-01)"; exit 0; fi',
      'if [ "$1" = repo ]; then echo main; exit 0; fi',
      'if [ "$2" = view ]; then exit 1; fi',
      'echo https://github.com/benjgrad/fixture-app/pull/9',
    ].join('\n'),
    'gh',
  ],
};

/** A run_cmd envelope at token 3. */
const cmdMsg = (
  sessionId: string,
  payload: Extract<OrchestratorToDaemon, { type: 'run_cmd' }>['payload'],
): OrchestratorToDaemon => cmd('run_cmd', sessionId, payload, 3);

const complete = (result: Record<string, unknown>): FakeClaudeScript => ({
  turns: [[{ say: 'working' }, { completeState: result }]],
});

describe('daemon core: link', () => {
  it('registers, then sends heartbeat, inventory, repo_inventory and request_work', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const types = orch.received.map((m) => m.type);
    expect(types.slice(0, 5)).toEqual([
      'register',
      'heartbeat',
      'inventory',
      'repo_inventory',
      'request_work',
    ]);
    const reg = orch.ofType('register')[0]!.payload;
    expect(reg).toMatchObject({
      machine_id: 'test-machine',
      enrollment_token: null,
      max_sessions: 2,
      max_concurrent_builds: 2,
      claude_code_version: '2.1.308',
      protocol_version: PROTOCOL_VERSION,
      daemon_version: daemonVersion({}),
    });
    expect(PROTOCOL_VERSION).toBe(2);
    expect(orch.authHeaders).toEqual([undefined]); // local mode: no credential header
    expect(orch.ofType('heartbeat')[0]!.payload).toMatchObject({ mem_free_mb: 8000, sessions: [] });
    expect(orch.ofType('request_work')[0]!.payload).toMatchObject({
      free_slots: 2,
      mem_free_mb: 8000,
    });
  });

  it('register.daemon_version carries CONDUCTOR_BUILD_SHA', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})), { env: { CONDUCTOR_BUILD_SHA: 'abc1234' } });
    const reg = await orch.until(() => orch.ofType('register')[0]);
    expect(reg.payload.daemon_version).toBe(`${daemonVersion({})}+abc1234`);
  });

  it('enrolled: the enrolled machine id, the bearer header, no enrollment_token', async () => {
    const root = join(tmp, 'root');
    writeCredential(
      root,
      { url: 'http://127.0.0.1', machine_id: 'm-enrolled', credential: 'secret-cred' },
      { force: false },
    );
    makeDaemon(new FakeClaudeDriver(complete({})), { root });
    const reg = await orch.until(() => orch.ofType('register')[0]);
    expect(reg.payload.machine_id).toBe('m-enrolled');
    expect(reg.payload).not.toHaveProperty('enrollment_token');
    expect(reg.payload.protocol_version).toBe(PROTOCOL_VERSION);
    expect(orch.authHeaders).toEqual(['Bearer secret-cred']);
  });

  it('close 4001 (revoked) stops the link and calls onFatal; no re-register', async () => {
    const fatal: number[] = [];
    const d = makeDaemon(new FakeClaudeDriver(complete({})), { onFatal: (c) => fatal.push(c) });
    await orch.until(() => d.isRegistered);
    orch.closeWith(CLOSE_REVOKED);
    await orch.until(() => fatal.length === 1);
    await new Promise((r) => setTimeout(r, 300)); // reconnect backoff is 20-100 ms here
    expect(fatal).toEqual([CLOSE_REVOKED]);
    expect(d.isRegistered).toBe(false);
    expect(orch.ofType('register')).toHaveLength(1);
    expect(orch.connections).toBe(1);
  });

  it('reconnects with backoff after the socket drops and registers again', async () => {
    const d = makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => d.isRegistered);
    orch.drop();
    await orch.until(() => orch.ofType('register').length === 2 && orch.connections === 2);
    await orch.until(() => d.isRegistered);
  });

  it('asks for work again after retry_after', async () => {
    let n = 0;
    orch.workReply = () =>
      n++ === 0
        ? {
            type: 'retry_after',
            msg_id: randomUUID(),
            seq: null,
            session_id: null,
            fencing_token: null,
            payload: { ms: 30 },
          }
        : null;
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work').length >= 2);
  });
});

describe('daemon core: start_session', () => {
  it('creates the worktree on the session branch, spawns the driver, and forwards events', async () => {
    const driver = new FakeClaudeDriver(complete({ summary: 'done' }));
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);

    await orch.until(() => orch.events('exit')[0]);
    expect(orch.ack(start.payload.command_id).map((a) => a.payload)).toEqual([
      { command_id: start.payload.command_id, accepted: true },
    ]);
    const kinds = orch.events().map((e) => e.payload.kind);
    expect(kinds).toEqual(['started', 'claude_session_id', 'complete_state', 'spend', 'exit']);
    // seq strictly increasing from 0; envelope carries the start's token.
    expect(orch.events().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(orch.events().every((e) => e.fencing_token === 1 && e.session_id === sid)).toBe(true);

    const started = orch.eventData('started')[0]!;
    expect(started.command_id).toBe(start.payload.command_id);
    expect(started.branch).toBe(sessionBranch(TICKET, sid));
    expect(started.port_range).toEqual({ base: 42000, count: 10 });
    const wt = started.worktree_path;
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: wt }).toString().trim()).toBe(
      sessionBranch(TICKET, sid),
    );

    const opts = driver.starts[0]!;
    expect(opts.cwd).toBe(wt);
    expect(opts.resume).toBe(false);
    expect(opts.tools).toEqual(resolveToolPolicy(['read', 'edit', 'bash', 'git']));
    expect(opts.appendSystemPrompt).toContain(CONDUCTOR_INSTRUCTIONS);
    expect(opts.appendSystemPrompt).toContain('Always run npm test.');
    expect(opts.maxBudgetUsd).toBeUndefined();
    expect(opts.env).toMatchObject({
      CONDUCTOR_SESSION_ID: sid,
      CONDUCTOR_PORT_BASE: '42000',
      PORT: '42000',
      CONDUCTOR_PORT_COUNT: '10',
    });

    expect(orch.eventData('claude_session_id')[0]).toEqual({ id: opts.claudeSessionId });
    expect(orch.eventData('complete_state')[0]).toEqual({ result: { summary: 'done' } });
    expect(orch.eventData('spend')[0]).toMatchObject({
      claude_session_id: opts.claudeSessionId,
      total_usd: 0.01,
    });
    expect(orch.eventData('exit')[0]).toEqual({
      command_id: start.payload.command_id,
      code: 0,
      signal: null,
    });
    // after complete_state + turn_end the daemon ended the session gracefully.
    expect(driver.last!.ended).toBe(true);
    expect(orch.ofType('output').map((o) => o.payload.text)).toContain('working');
    // the shared clone shows up in the inventory
    await orch.until(() =>
      orch.ofType('repo_inventory').some((m) => m.payload.repos.some((r) => r.repo === repo)),
    );
  });

  it('persists the pre-assigned Claude session id before spawning', async () => {
    const root = join(tmp, 'root');
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q?' }]] });
    makeDaemon(driver, { root });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('ask_user')[0]);
    const persisted = new DaemonStore(join(root, 'state', 'daemon.json')).session(sid);
    expect(persisted?.claudeSessionId).toBe(driver.starts[0]!.claudeSessionId);
  });

  it("ADR-0009: a reviewer start is fresh, read-only, and never replaces the worker's stored id", async () => {
    const root = join(tmp, 'root');
    const driver = new FakeClaudeDriver(complete({}));
    makeDaemon(driver, { root });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('exit')[0]);
    const worker = driver.starts[0]!.claudeSessionId;
    orch.send(
      startSession(sid, {
        workflow_state: 'implement → build (review)',
        prompt: '# Requirements review',
        tools: ['review'],
        review: true,
      }),
    );
    await orch.until(() => orch.events('exit')[1]);
    const reviewer = driver.starts[1]!;
    expect(reviewer.resume).toBe(false);
    expect(reviewer.review).toBe(true); // → --permission-mode dontAsk in the driver
    expect(driver.starts[0]!.review).toBeUndefined(); // the worker keeps the user's mode
    expect(reviewer.claudeSessionId).not.toBe(worker);
    expect(reviewer.tools.builtin).not.toContain('Edit');
    expect(reviewer.tools.builtin).not.toContain('Write');
    expect(reviewer.tools.allow).toContain('Bash(git diff)');
    // The session's transcript (history, reopen) stays the worker's conversation.
    const persisted = new DaemonStore(join(root, 'state', 'daemon.json')).session(sid);
    expect(persisted?.claudeSessionId).toBe(worker);
    // Spend is reported under the reviewer's own id, so it adds to the session budget.
    expect(orch.eventData('spend').map((d) => d.claude_session_id)).toContain(
      reviewer.claudeSessionId,
    );
  });

  it('resumes with --resume semantics when resume_claude_session_id is set', async () => {
    const driver = new FakeClaudeDriver(complete({}));
    const d = makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const claudeId = randomUUID();
    const sid = randomUUID();
    writeTranscriptFor(d, sid, claudeId);
    const start = startSession(sid, {
      resume_claude_session_id: claudeId,
      prompt: 'the answer',
    });
    orch.send(start);
    await orch.until(() => orch.events('exit')[0]);
    expect(orch.ack(start.payload.command_id)[0]!.payload.accepted).toBe(true);
    expect(driver.starts[0]).toMatchObject({
      claudeSessionId: claudeId,
      resume: true,
      prompt: 'the answer',
    });
  });

  it('refuses no_conversation (never spawns) when the resumed conversation is not on this machine', async () => {
    const lines: string[] = [];
    const driver = new FakeClaudeDriver(complete({}));
    const d = makeDaemon(driver, { log: (m) => lines.push(m) });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const claudeId = randomUUID(); // ran on another machine: no transcript here
    // A transcript under another project dir doesn't count: `claude --resume` only looks in the
    // worktree's own (findTranscript would have found this one).
    writeTranscriptFor(d, sid, claudeId, true);
    for (const review of [false, true]) {
      const start = startSession(sid, {
        resume_claude_session_id: claudeId,
        prompt: 'the answer',
        ...(review ? { review: true, tools: ['review'] } : {}),
      });
      orch.send(start);
      const ack = await orch.until(() => orch.ack(start.payload.command_id)[0]);
      expect(ack.payload).toEqual({
        command_id: start.payload.command_id,
        accepted: false,
        reason: NO_CONVERSATION_REASON,
      });
    }
    expect(driver.starts).toHaveLength(0);
    expect(orch.events()).toHaveLength(0);
    expect(lines.filter((l) => l.includes(NO_CONVERSATION_REASON))).toHaveLength(2);
    // The slot is free again: a fresh start for the session runs.
    const fresh = startSession(sid);
    orch.send(fresh);
    await orch.until(() => orch.events('exit')[0]);
    expect(orch.ack(fresh.payload.command_id)[0]!.payload.accepted).toBe(true);
    expect(driver.starts[0]!.resume).toBe(false);
  });

  it('the hasConversation seam decides the resume check', async () => {
    const driver = new FakeClaudeDriver(complete({}));
    const asked: string[] = [];
    makeDaemon(driver, {
      hasConversation: (_cwd, id) => {
        asked.push(id);
        return true;
      },
    });
    await orch.until(() => orch.ofType('request_work')[0]);
    const start = startSession(randomUUID(), { resume_claude_session_id: 'claude-abc' });
    orch.send(start);
    await orch.until(() => orch.events('exit')[0]);
    expect(asked).toEqual(['claude-abc']);
    expect(driver.starts[0]).toMatchObject({ claudeSessionId: 'claude-abc', resume: true });
  });

  it('sends the last stderr lines on exit (stderr_tail)', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [
          { emit: { kind: 'output', stream: 'stderr', text: 'line 1\nNo conversation ' } },
          { emit: { kind: 'output', stream: 'stderr', text: 'found with session ID: x\n' } },
          { crash: { code: 1 } },
        ],
      ],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const start = startSession(randomUUID());
    orch.send(start);
    const exit = await orch.until(() => orch.eventData('exit')[0]);
    expect(exit).toEqual({
      command_id: start.payload.command_id,
      code: 1,
      signal: null,
      stderr_tail: 'line 1\nNo conversation found with session ID: x\n',
    });
  });

  it('parks after ask_user (process alive) and feeds send_input into the live process', async () => {
    const driver = new FakeClaudeDriver({
      turns: [[{ askUser: 'Which DB?' }], (answer) => [{ completeState: { db: answer } }]],
    });
    orch.heartbeatIntervalMs = 30;
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('ask_user')[0]);
    // Parked: the process is still alive after its turn ended.
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.last!.exited).toBe(false);
    expect(orch.events('exit')).toHaveLength(0);
    const hb = await orch.until(() =>
      orch.ofType('heartbeat').find((h) => h.payload.sessions.length > 0),
    );
    expect(hb.payload.sessions).toEqual([{ session_id: sid, fencing_token: 1 }]);

    const input = cmd('send_input', sid, {
      command_id: randomUUID(),
      input_request_id: randomUUID(),
      text: 'postgres',
    });
    orch.send(input);
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.last!.inputs).toEqual(['postgres']);
    expect(orch.eventData('complete_state')[0]).toEqual({ result: { db: 'postgres' } });
    expect(
      orch.ack((input.payload as { command_id: string }).command_id)[0]!.payload.accepted,
    ).toBe(true);
  });

  it('U-028: an outcome-less turn gets ONE nudge; the agent then completes', async () => {
    const driver = new FakeClaudeDriver({
      turns: [[{ say: 'I made the change.' }], [{ completeState: { ok: true } }]],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(startSession(randomUUID()));
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE]);
    expect(NO_OUTCOME_NUDGE).toBe(
      'You must finish by calling complete_state with your result, or ask_user if you need a human',
    );
    expect(orch.eventData('complete_state')).toEqual([{ result: { ok: true } }]);
    expect(orch.events('no_outcome')).toEqual([]);
  });

  it('U-028: a second outcome-less turn emits no_outcome (parked); an answer re-arms the nudge', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [{ say: 'first' }],
        [{ say: 'still no outcome' }],
        // after the human answer: outcome-less again → a new nudge, then complete
        (answer) => [{ say: `got ${answer}` }],
        [{ completeState: { done: true } }],
      ],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('no_outcome')[0]);
    expect(orch.eventData('no_outcome')).toEqual([{ last_output: 'first\nstill no outcome' }]);
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE]);
    // Parked like after ask_user: the process stays alive, no further nudge.
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.last!.exited).toBe(false);
    expect(driver.last!.inputs).toHaveLength(1);

    orch.send(
      cmd('send_input', sid, {
        command_id: randomUUID(),
        input_request_id: randomUUID(),
        text: 'go on',
      }),
    );
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE, 'go on', NO_OUTCOME_NUDGE]);
    expect(orch.eventData('complete_state')).toEqual([{ result: { done: true } }]);
    expect(orch.events('no_outcome')).toHaveLength(1);
  });

  it('U-028: no_outcome carries only the tail of the assistant output', async () => {
    const long = 'x'.repeat(NO_OUTCOME_OUTPUT_CHARS);
    const driver = new FakeClaudeDriver({ turns: [[{ say: 'head' }], [{ say: long }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(startSession(randomUUID()));
    const ev = await orch.until(() => orch.eventData('no_outcome')[0]);
    expect(ev.last_output).toBe(long);
  });

  it('refuses send_input with no_live_process when the process is gone', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('exit')[0]);
    const input = cmd('send_input', sid, {
      command_id: randomUUID(),
      input_request_id: randomUUID(),
      text: 'x',
    });
    const cid = (input.payload as { command_id: string }).command_id;
    orch.send(input);
    const ack = await orch.until(() => orch.ack(cid)[0]);
    expect(ack.payload).toEqual({ command_id: cid, accepted: false, reason: 'no_live_process' });
    expect(ack.session_id).toBe(sid);
  });

  it('refuses start_session with max_sessions and memory_pressure', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'hold' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const a = startSession(randomUUID());
    const b = startSession(randomUUID());
    orch.send(a);
    orch.send(b);
    await orch.until(() => orch.events('ask_user').length === 2);
    const c = startSession(randomUUID());
    orch.send(c);
    expect((await orch.until(() => orch.ack(c.payload.command_id)[0])).payload.reason).toBe(
      'max_sessions',
    );

    // free one slot, then fail on memory
    orch.send(
      cmd('kill', a.session_id, {
        command_id: randomUUID(),
        target_command_id: null,
        reason: 'cancel',
      }),
    );
    await orch.until(() => orch.events('exit')[0]);
    resources = { ...resources, memFreeMb: 100 };
    const d = startSession(randomUUID());
    orch.send(d);
    expect((await orch.until(() => orch.ack(d.payload.command_id)[0])).payload.reason).toBe(
      'memory_pressure',
    );
  });

  it('re-arms request_work after a memory_pressure refusal of an assigned session (max_sessions=1)', async () => {
    const WORK_POLL_MS = 300;
    const sid = randomUUID();
    let n = 0;
    orch.workReply = () =>
      n++ === 0
        ? {
            type: 'work_assignment',
            msg_id: randomUUID(),
            seq: null,
            session_id: sid,
            fencing_token: 1,
            payload: { ticket_id: TICKET, session_id: sid },
          }
        : null;
    makeDaemon(new FakeClaudeDriver(complete({})), {
      env: { CONDUCTOR_MAX_SESSIONS: '1', CONDUCTOR_WORK_POLL_MS: String(WORK_POLL_MS) },
    });
    await orch.until(() => orch.ofType('request_work')[0]);
    resources = { ...resources, memFreeMb: 100 };
    const s = startSession(sid);
    orch.send(s);
    const ack = await orch.until(() => orch.ack(s.payload.command_id)[0]);
    const refusedAt = Date.now();
    expect(ack.payload.reason).toBe('memory_pressure');
    // The assignment held the only slot: no request_work was sent while it was held.
    expect(orch.ofType('request_work')).toHaveLength(1);
    await orch.until(() => orch.ofType('request_work').length === 2);
    const waited = Date.now() - refusedAt;
    // Waits ~workPollMs (no claim/refuse spin), but does not stall.
    expect(waited).toBeGreaterThanOrEqual(WORK_POLL_MS - 50);
    expect(waited).toBeLessThan(WORK_POLL_MS + 2000);
    expect(orch.ofType('request_work')[1]!.payload).toMatchObject({ free_slots: 1 });
  });

  it('re-arms request_work right after a max_sessions refusal and when a hold expires', async () => {
    const assigned = randomUUID();
    let n = 0;
    orch.workReply = () =>
      n++ === 0
        ? {
            type: 'work_assignment',
            msg_id: randomUUID(),
            seq: null,
            session_id: assigned,
            fencing_token: 1,
            payload: { ticket_id: TICKET, session_id: assigned },
          }
        : null;
    makeDaemon(new FakeClaudeDriver(complete({})), {
      env: { CONDUCTOR_MAX_SESSIONS: '1' },
      config: { assignmentHoldMs: 300 },
    });
    await orch.until(() => orch.ofType('request_work')[0]);
    // A start for another session finds the only slot held: refused, and the loop stays armed.
    const other = startSession(randomUUID());
    orch.send(other);
    expect((await orch.until(() => orch.ack(other.payload.command_id)[0])).payload.reason).toBe(
      'max_sessions',
    );
    expect(orch.ofType('request_work')).toHaveLength(1);
    // The assigned session's start_session never arrives: the hold expires and frees the slot.
    await orch.until(() => orch.ofType('request_work').length === 2);
  });

  it('reports start_failed when the repo cannot be cloned', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const s = startSession(randomUUID(), { repo: join(tmp, 'missing') });
    orch.send(s);
    const ack = await orch.until(() => orch.ack(s.payload.command_id)[0]);
    expect(ack.payload.accepted).toBe(false);
    expect(ack.payload.reason).toMatch(/^start_failed: /);
  });
});

describe('daemon core: send_message (ADR-0007)', () => {
  const message = (sid: string, target: string, text: string, token = 1) =>
    cmd('send_message', sid, { command_id: randomUUID(), target_command_id: target, text }, token);
  const cidOf = (m: OrchestratorToDaemon) => (m.payload as { command_id: string }).command_id;

  it('writes into the working process (not as an answer) and leaves the U-028 nudge state alone', async () => {
    // Turn 1 has no outcome → nudge. Turn 2 (the nudge) is working when the message arrives; it is
    // folded in, and the turn still ends without an outcome → no_outcome: the message neither
    // re-armed the nudge nor counted as an answer.
    const driver = new FakeClaudeDriver({
      turns: [[{ say: 'first' }], [{ say: 'working' }, { awaitMessage: true }, { say: 'ok' }]],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);
    await orch.until(() => (driver.last?.inputs.length === 1 ? true : undefined));
    const m = message(sid, start.payload.command_id, '/context');
    orch.send(m);
    const ack = await orch.until(() => orch.ack(cidOf(m))[0]);
    expect(ack.payload).toEqual({ command_id: cidOf(m), accepted: true });
    expect(driver.last!.messages).toEqual(['/context']);
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE]); // no answer, no second nudge
    await orch.until(() => orch.events('no_outcome')[0]);
    expect(driver.last!.exited).toBe(false);

    // A re-sent command is re-acked, never written twice (command_id dedupe).
    orch.send(m);
    await orch.until(() => (orch.ack(cidOf(m)).length === 2 ? true : undefined));
    expect(driver.last!.messages).toEqual(['/context']);
  });

  it('refuses: parked (agent_parked), another process, a newer process token, or none (no_live_process)', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'Which DB?' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid, {}, 5);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    const target = start.payload.command_id;

    const refused = async (m: OrchestratorToDaemon) => {
      orch.send(m);
      return (await orch.until(() => orch.ack(cidOf(m))[0])).payload;
    };
    expect(await refused(message(sid, target, 'hi', 5))).toMatchObject({
      accepted: false,
      reason: 'agent_parked',
    });
    expect(await refused(message(sid, randomUUID(), 'hi', 5))).toMatchObject({
      accepted: false,
      reason: 'no_live_process',
    });
    expect(await refused(message(sid, target, 'hi', 4))).toMatchObject({
      accepted: false,
      reason: 'no_live_process',
    });
    expect(await refused(message(randomUUID(), target, 'hi', 5))).toMatchObject({
      accepted: false,
      reason: 'no_live_process',
    });
    expect(driver.last!.messages).toEqual([]);
    expect(driver.last!.inputs).toEqual([]);
  });

  it('refuses with no_live_process once the process completed', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);
    await orch.until(() => orch.events('exit')[0]);
    const m = message(sid, start.payload.command_id, 'too late');
    orch.send(m);
    const ack = await orch.until(() => orch.ack(cidOf(m))[0]);
    expect(ack.payload).toEqual({
      command_id: cidOf(m),
      accepted: false,
      reason: 'no_live_process',
    });
  });
});

describe('daemon core: command_id dedupe and seq', () => {
  it('re-acks a re-sent command without re-running it, also after a daemon restart', async () => {
    const root = join(tmp, 'root');
    const driver = new FakeClaudeDriver(complete({}));
    const d1 = makeDaemon(driver, { root });
    await orch.until(() => orch.ofType('request_work')[0]);
    const start = startSession(randomUUID());
    orch.send(start);
    await orch.until(() => orch.events('exit')[0]);
    orch.send(start);
    await orch.until(() => orch.ack(start.payload.command_id).length === 2);
    expect(driver.starts).toHaveLength(1);

    d1.stop();
    const driver2 = new FakeClaudeDriver(complete({}));
    makeDaemon(driver2, { root });
    await orch.until(() => orch.ofType('register').length === 2);
    await orch.until(() => orch.ofType('request_work').length >= 2);
    orch.send(start);
    await orch.until(() => orch.ack(start.payload.command_id).length === 3);
    expect(orch.ack(start.payload.command_id).every((a) => a.payload.accepted)).toBe(true);
    expect(driver2.starts).toHaveLength(0);
  });

  it('next seq = max(local + 1, registered.last_seq + 1)', async () => {
    const root = join(tmp, 'root');
    const d1 = makeDaemon(new FakeClaudeDriver(complete({})), { root });
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(startSession(randomUUID()));
    await orch.until(() => orch.events('exit')[0]);
    expect(orch.events().at(-1)!.seq).toBe(4);
    d1.stop();

    // The orchestrator is ahead (e.g. local state was restored from an old backup).
    orch.lastSeq = 100;
    makeDaemon(new FakeClaudeDriver(complete({})), { root });
    await orch.until(
      () => orch.ofType('register').length === 2 && orch.ofType('request_work').length >= 2,
    );
    orch.send(startSession(randomUUID()));
    await orch.until(() => orch.events('exit').length === 2);
    expect(
      orch
        .events()
        .slice(5)
        .map((e) => e.seq),
    ).toEqual([101, 102, 103, 104, 105]);
    expect(new DaemonStore(join(root, 'state', 'daemon.json')).lastSeq).toBe(105);
  });

  it('buffers session_events while disconnected and replays those after registered.last_seq', async () => {
    const driver = new FakeClaudeDriver({
      turns: [[{ askUser: 'q?' }], [{ completeState: { ok: true } }]],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid));
    // spend follows ask_user; wait for both so the count doesn't race it.
    await orch.until(() => orch.events('ask_user')[0] && orch.events('spend')[0]);
    const before = orch.events().length; // started, claude_session_id, ask_user, spend
    expect(before).toBe(4);

    // Pretend the orchestrator only processed up to seq 1, and hold the reconnect until after
    // the agent has produced more events while disconnected.
    orch.lastSeq = 1;
    orch.drop();
    driver.last!.sendInput('go'); // simulates progress while offline: complete_state, spend, exit
    await orch.until(() => orch.ofType('register').length === 2);
    await orch.until(() => orch.events('exit')[0]);
    const replayed = orch.events().slice(before);
    // seq 2,3 (ask_user, spend) replayed, then the offline events get 4.. in order.
    expect(replayed.map((e) => [e.seq, e.payload.kind])).toEqual([
      [2, 'ask_user'],
      [3, 'spend'],
      [4, 'complete_state'],
      [5, 'spend'],
      [6, 'exit'],
    ]);
  });
});

describe('daemon core: run_cmd and kill', () => {
  it('runs a command through the injected CommandRunner and reports build_slot + cmd_exit', async () => {
    const runner = new FakeCommandRunner(1).script('npm test', { exitCode: 1, output: 'FAIL\n' });
    const driver = new FakeClaudeDriver(complete({}));
    makeDaemon(driver, { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);

    const r1 = cmd(
      'run_cmd',
      sid,
      {
        command_id: randomUUID(),
        workflow_state: 'test',
        cmd: 'npm test',
        cwd: null,
        timeout_ms: 1000,
      },
      3,
    );
    const r2 = cmd(
      'run_cmd',
      sid,
      {
        command_id: randomUUID(),
        workflow_state: 'test',
        cmd: 'npm test',
        cwd: 'sub',
        timeout_ms: null,
      },
      3,
    );
    orch.send(r1);
    orch.send(r2);
    await orch.until(() => orch.eventData('build_slot')[0]);
    expect(orch.eventData('build_slot')[0]).toEqual({ waiting: true });
    runner.release('npm test');
    await orch.until(() => orch.eventData('build_slot').length === 2);
    runner.release('npm test');
    await orch.until(() => orch.eventData('cmd_exit').length === 2);

    // The two commands race for the build slot, so match by command_id / cwd, not by order.
    const id1 = (r1.payload as { command_id: string }).command_id;
    expect(orch.eventData('cmd_exit').find((d) => d.command_id === id1)).toEqual({
      command_id: id1,
      exit_code: 1,
      signal: null,
      timed_out: false,
      duration_ms: 0,
      output_tail: 'FAIL\n',
      // ADR-0010: the worktree HEAD the command ran on.
      head_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    });
    const wt = orch.eventData('started')[0]!.worktree_path;
    const call1 = runner.calls.find((c) => c.cwd === wt);
    expect(call1).toMatchObject({ cwd: wt, sessionId: sid, timeoutMs: 1000 });
    expect(call1!.env).toMatchObject({ PORT: '42000', CONDUCTOR_TICKET_ID: TICKET });
    expect(runner.calls.map((c) => c.cwd)).toContain(join(wt, 'sub'));
    expect(
      orch
        .ofType('output')
        .some((o) => o.payload.stream === 'stdout' && o.payload.text === 'FAIL\n'),
    ).toBe(true);
  });

  it('ADR-0010 (Ben 2026-10-26): entry checks run in a fresh checkout of the commit, setup once, then it is removed', async () => {
    const runner = new FakeCommandRunner(1, true).script('npm run build', { exitCode: 0 });
    makeDaemon(new FakeClaudeDriver(complete({})), { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);
    const wt = orch.eventData('started')[0]!.worktree_path;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
    const check = (command: string, sha: string | null, last: boolean) =>
      orch.send(
        cmdMsg(sid, {
          command_id: randomUUID(),
          workflow_state: 'implementing → waiting_external (entry)',
          cmd: command,
          cwd: null,
          timeout_ms: 1000,
          require_clean: true,
          checkout: { sha, setup: 'make deps', last },
        }),
      );
    check('npm run build', null, false);
    await orch.until(() => orch.eventData('cmd_exit')[0], 10_000);
    check('npm test', head, true);
    await orch.until(() => orch.eventData('cmd_exit')[1], 10_000);
    expect(orch.eventData('cmd_exit').map((e) => [e.exit_code, e.head_sha])).toEqual([
      [0, head],
      [0, head],
    ]);
    // Setup once, then both checks, all in the same fresh checkout under <root>/private.
    expect(runner.calls.map((c) => c.cmd)).toEqual(['make deps', 'npm run build', 'npm test']);
    const dirs = new Set(runner.calls.map((c) => c.cwd));
    expect(dirs.size).toBe(1);
    const dir = [...dirs][0]!;
    expect(dir.startsWith(join(tmp, 'root', 'private', 'check-'))).toBe(true);
    expect(dir).not.toBe(wt);
    // The last check removed it.
    expect(existsSync(dir)).toBe(false);
  });

  it('ADR-0010: a session kill between checks removes the kept checkout', async () => {
    const runner = new FakeCommandRunner(1, true);
    makeDaemon(new FakeClaudeDriver(complete({})), { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);
    orch.send(
      cmdMsg(sid, {
        command_id: randomUUID(),
        workflow_state: 'x',
        cmd: 'npm run build',
        cwd: null,
        timeout_ms: 1000,
        require_clean: true,
        checkout: { sha: null, setup: '', last: false },
      }),
    );
    await orch.until(() => orch.eventData('cmd_exit')[0], 10_000);
    const dir = runner.calls[0]!.cwd;
    expect(existsSync(dir)).toBe(true); // kept for the next check
    // The step ends (cancel / timeout / budget): the engine's session kill.
    const kill = cmd(
      'kill',
      sid,
      { command_id: randomUUID(), target_command_id: null, reason: 'x' },
      3,
    );
    orch.send(kill);
    await orch.until(() => orch.ack((kill.payload as { command_id: string }).command_id)[0]);
    expect(existsSync(dir)).toBe(false);
  });

  it('ADR-0010: an older run cleanup never removes a newer checkout of the same session', async () => {
    const runner = new FakeCommandRunner(2).script('npm run build', { exitCode: 1 });
    makeDaemon(new FakeClaudeDriver(complete({})), { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);
    const wt = orch.eventData('started')[0]!.worktree_path;
    const send = (command: string, sha: string | null) =>
      orch.send(
        cmdMsg(sid, {
          command_id: randomUUID(),
          workflow_state: 'x',
          cmd: command,
          cwd: null,
          timeout_ms: 5000,
          require_clean: true,
          checkout: { sha, setup: '', last: false },
        }),
      );
    // Visit 1's check runs (and will fail) in checkout A.
    send('npm run build', null);
    await orch.until(() => runner.calls[0]);
    const a = runner.calls[0]!.cwd;
    // A newer visit: a new commit, its check in checkout B (A is replaced).
    writeFileSync(join(wt, 'next.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'next'], {
      cwd: wt,
    });
    const head2 = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: wt,
      encoding: 'utf8',
    }).trim();
    send('npm test', head2);
    await orch.until(() => runner.calls[1]);
    const b = runner.calls[1]!.cwd;
    expect(b).not.toBe(a);
    expect(existsSync(a)).toBe(false);
    // Visit 1's check now fails: its cleanup must not touch checkout B.
    runner.release('npm run build');
    await orch.until(() => orch.eventData('cmd_exit')[0], 10_000);
    expect(existsSync(b)).toBe(true);
    runner.release('npm test');
    await orch.until(() => orch.eventData('cmd_exit')[1], 10_000);
    expect(existsSync(b)).toBe(true); // passed, not last: kept
  });

  it('ADR-0010: a failed setup is reported (setup_failed), the check does not run, the checkout goes', async () => {
    const runner = new FakeCommandRunner(1, true).script('make deps', {
      exitCode: 2,
      output: 'deps: no such target\n',
    });
    makeDaemon(new FakeClaudeDriver(complete({})), { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);
    orch.send(
      cmdMsg(sid, {
        command_id: randomUUID(),
        workflow_state: 'x',
        cmd: 'npm run build',
        cwd: null,
        timeout_ms: 1000,
        require_clean: true,
        checkout: { sha: null, setup: 'make deps', last: false },
      }),
    );
    const exit = await orch.until(() => orch.eventData('cmd_exit')[0], 10_000);
    expect(exit).toMatchObject({
      exit_code: 2,
      setup_failed: true,
      output_tail: 'deps: no such target\n',
    });
    expect(runner.calls.map((c) => c.cmd)).toEqual(['make deps']);
    expect(existsSync(runner.calls[0]!.cwd)).toBe(false);
  });

  it('ADR-0010: a require_clean check on a dirty worktree is not run; cmd_exit reports dirty', async () => {
    const runner = new FakeCommandRunner(1, true);
    makeDaemon(new FakeClaudeDriver(complete({})), { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, {}, 3));
    await orch.until(() => orch.events('exit')[0]);
    const wt = orch.eventData('started')[0]!.worktree_path;
    writeFileSync(join(wt, 'uncommitted.txt'), 'x');
    const check = cmd(
      'run_cmd',
      sid,
      {
        command_id: randomUUID(),
        workflow_state: 'implementing → waiting_external (entry)',
        cmd: 'npm run build',
        cwd: null,
        timeout_ms: 1000,
        require_clean: true,
      },
      3,
    );
    orch.send(check);
    const exit = await orch.until(() => orch.eventData('cmd_exit')[0], 10_000);
    expect(exit).toMatchObject({
      exit_code: null,
      head_sha: null,
      dirty: ['?? uncommitted.txt'],
    });
    expect(exit.output_tail).toContain('?? uncommitted.txt');
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses run_cmd for an unknown session and a cwd outside the worktree', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const unknown = cmd('run_cmd', randomUUID(), {
      command_id: randomUUID(),
      workflow_state: 's',
      cmd: 'x',
      cwd: null,
      timeout_ms: null,
    });
    orch.send(unknown);
    const id = (unknown.payload as { command_id: string }).command_id;
    expect((await orch.until(() => orch.ack(id)[0])).payload.reason).toBe('unknown_session');

    const sid = randomUUID();
    orch.send(startSession(sid));
    await orch.until(() => orch.events('exit')[0]);
    const escape = cmd('run_cmd', sid, {
      command_id: randomUUID(),
      workflow_state: 's',
      cmd: 'x',
      cwd: '../..',
      timeout_ms: null,
    });
    orch.send(escape);
    const eid = (escape.payload as { command_id: string }).command_id;
    expect((await orch.until(() => orch.ack(eid)[0])).payload.reason).toBe('invalid_cwd');
  });

  it('kill rule: target_command_id kills only that process; null kills at or below the envelope token', async () => {
    const runner = new FakeCommandRunner(2);
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    makeDaemon(driver, { runner });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid, {}, 5);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);

    // A kill aimed at another start_session is a no-op.
    orch.send(
      cmd(
        'kill',
        sid,
        { command_id: null, target_command_id: randomUUID(), reason: 'superseded_start' },
        5,
      ),
    );
    // A kill under an older token can't hit the newer claim's process.
    orch.send(
      cmd(
        'kill',
        sid,
        { command_id: null, target_command_id: null, reason: 'stale_fencing_token' },
        4,
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.last!.killed).toBe(false);

    // A running command at token 5 is aborted by a null-target kill at token 5.
    orch.send(
      cmd(
        'run_cmd',
        sid,
        {
          command_id: randomUUID(),
          workflow_state: 'b',
          cmd: 'sleep',
          cwd: null,
          timeout_ms: null,
        },
        5,
      ),
    );
    await orch.until(() => runner.runningCount === 1 || undefined);
    const k = cmd(
      'kill',
      sid,
      { command_id: randomUUID(), target_command_id: null, reason: 'cancel' },
      5,
    );
    orch.send(k);
    await orch.until(() => orch.events('exit')[0]);
    await orch.until(() => orch.eventData('cmd_exit')[0]);
    expect(driver.last!.killed).toBe(true);
    expect(orch.eventData('cmd_exit')[0]).toMatchObject({ exit_code: null, signal: 'SIGTERM' });
    expect(orch.ack((k.payload as { command_id: string }).command_id)[0]!.payload.accepted).toBe(
      true,
    );
  });

  it('kill with target_command_id kills the process that start spawned', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    orch.send(
      cmd('kill', sid, {
        command_id: null,
        target_command_id: start.payload.command_id,
        reason: 'ack_timeout',
      }),
    );
    await orch.until(() => orch.events('exit')[0]);
    expect(orch.eventData('exit')[0]).toEqual({
      command_id: start.payload.command_id,
      code: null,
      signal: 'SIGTERM',
    });
  });
});

describe('daemon core: BUG-1 no process outlives its session', () => {
  it('FR-3: a start superseding a parked process kills it before the new one runs', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const a = startSession(sid, {}, 1);
    orch.send(a);
    await orch.until(() => orch.events('ask_user')[0]);
    const b = startSession(sid, {}, 2);
    orch.send(b);
    await orch.until(() => orch.ack(b.payload.command_id)[0]);
    expect(orch.ack(b.payload.command_id)[0]!.payload.accepted).toBe(true);
    const [procA, procB] = driver.sessions;
    expect(procA!.killed).toBe(true);
    expect(procB!.killed).toBe(false);
    await orch.until(() =>
      orch.eventData('exit').find((e) => e.command_id === a.payload.command_id),
    );
  });

  it('FR-3: two starts racing through worktree preparation leave exactly one process', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const a = startSession(sid, {}, 1);
    const b = startSession(sid, {}, 2);
    orch.send(a); // still preparing its worktree when b arrives
    orch.send(b);
    await orch.until(() => orch.ack(a.payload.command_id)[0]);
    await orch.until(() => orch.ack(b.payload.command_id)[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(orch.ack(b.payload.command_id)[0]!.payload.accepted).toBe(true);
    const alive = driver.sessions.filter((x) => !x.killed && !x.exited);
    expect(alive.length).toBe(1);
    expect(alive[0]!.opts.prompt).toBe(b.payload.prompt);
    // a either never spawned (refused `superseded`) or was killed: never left running.
    const ackA = orch.ack(a.payload.command_id)[0]!.payload;
    if (!ackA.accepted) expect(ackA.reason).toBe('superseded');
  });

  it('FR-4: repeated heartbeat-backstop kills stop a parked process once, logged once', async () => {
    const logs: string[] = [];
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    makeDaemon(driver, { log: (m) => logs.push(m) });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid, {}, 3);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    // The session went terminal (token bumped); each heartbeat listing the old token gets this.
    const backstop = () =>
      cmd(
        'kill',
        sid,
        { command_id: null, target_command_id: null, reason: 'stale_fencing_token' },
        3,
      );
    orch.send(backstop());
    orch.send(backstop());
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.last!.killed).toBe(true);
    expect(driver.last!.killCalls).toBe(1);
    expect(logs.filter((l) => l.includes('kill (stale_fencing_token)'))).toEqual([
      `session ${sid}: kill (stale_fencing_token) stops process ${start.payload.command_id}`,
    ]);
  });

  it('FR-4: the pid and start time of a started process are persisted for the startup sweep', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    const orig = driver.start.bind(driver);
    driver.start = (o) => {
      const s = orig(o);
      s.pid = 4242;
      return s;
    };
    const d = makeDaemon(driver, {
      procInfo: (pid) => (pid === 4242 ? { startedAt: 1_700_000_000_000, command: '' } : null),
    });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    expect(d.store.session(sid)!.agent).toEqual({
      commandId: start.payload.command_id,
      fencingToken: 1,
      pid: 4242,
      claudeSessionId: driver.last!.claudeSessionId,
      startedAt: 1_700_000_000_000,
    });
  });

  it('BUG-1b FR-1: a process whose start time cannot be read is not tracked for the sweep', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] });
    const orig = driver.start.bind(driver);
    driver.start = (o) => {
      const s = orig(o);
      s.pid = 4242;
      return s;
    };
    const logs: string[] = [];
    const d = makeDaemon(driver, { procInfo: () => null, log: (m) => logs.push(m) });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    expect(d.store.session(sid)!.agent).toEqual({
      commandId: start.payload.command_id,
      fencingToken: 1,
    });
    expect(logs).toContain(
      `session ${sid}: cannot read start time of process 4242; not tracked for the orphan sweep`,
    );
  });
});

// BUG-1b: harmless stand-ins (`sh -c 'sleep 300 & …; wait'`, each the leader of its own process
// group) with a crafted argv0/argv at the stored pid. Only pids this block spawned are signalled.
// MW-T06: orphan sweep reads ps and kills process groups
describe.skipIf(onWin32)(
  'daemon core: BUG-1b orphan sweep only kills provably-ours processes',
  () => {
    const BIN = '/opt/conductor-test/claude';
    const GRACE = 200;
    const spawned: { leader: number; child: number }[] = [];

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    /** A detached `sh` whose ps command line is `<argv0> -c <script> x <extra…>`, plus its sleep child. */
    async function standIn(argv0: string, extra: string[], ignoreTerm = false) {
      const script = `${ignoreTerm ? "trap '' TERM; " : ''}sleep 300 & echo $!; wait`;
      const sh = spawn('/bin/sh', ['-c', script, 'x', ...extra], {
        argv0,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      sh.unref();
      const child = await new Promise<number>((resolve, reject) => {
        sh.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
        sh.once('error', reject);
      });
      sh.stdout.destroy();
      const p = { leader: sh.pid!, child };
      spawned.push(p);
      const info = readProcInfo(p.leader);
      expect(info).not.toBeNull();
      return { ...p, startedAt: info!.startedAt };
    }

    afterEach(async () => {
      for (const { leader } of spawned) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // gone
        }
      }
      // NFR-2: nothing this block started is left running.
      const pids = spawned.flatMap((p) => [p.leader, p.child]);
      spawned.length = 0;
      await orch.until(() => (pids.every((pid) => !alive(pid)) ? true : undefined), 5_000);
    });

    const root = () => join(tmp, 'root');
    function seed(agents: NonNullable<Parameters<DaemonStore['putSession']>[1]['agent']>[]) {
      const store = DaemonStore.forRoot(root());
      return agents.map((agent) => {
        const sid = randomUUID();
        store.putSession(sid, {
          ticketId: TICKET,
          repo,
          worktreePath: join(tmp, 'wt'),
          branch: 'b',
          portRange: null,
          claudeSessionId: agent.claudeSessionId ?? null,
          lastUsedAt: 0,
          agent,
        });
        return sid;
      });
    }
    const agentOf = (pid: number, claudeSessionId: string | undefined, startedAt?: number) => ({
      commandId: randomUUID(),
      fencingToken: 4,
      pid,
      ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
    const exits = (n: number) =>
      orch.until(() => {
        const e = orch.eventData('exit');
        return e.length === n ? e : undefined;
      });
    const settle = () => new Promise((r) => setTimeout(r, GRACE + 300));

    it('FR-2 (c): our argv, start time and UUID: killed with its whole group', async () => {
      const id = randomUUID();
      const s = await standIn(BIN, ['--session-id', id]);
      const [sid] = seed([agentOf(s.leader, id, s.startedAt)]);
      const logs: string[] = [];
      const d = makeDaemon(new FakeClaudeDriver(complete({})), {
        root: root(),
        claudeBin: BIN,
        log: (m) => logs.push(m),
        config: { killGraceMs: GRACE },
      });
      await orch.until(() => (!alive(s.leader) && !alive(s.child)) || undefined, 5_000);
      expect(logs).toContain(
        `startup: killed orphaned claude process ${s.leader} of session ${sid}`,
      );
      expect((await exits(1)).map((e) => e.signal)).toEqual(['daemon_restart']);
      expect(d.store.session(sid!)!.agent).toBeNull();
    });

    it('FR-2 (a)(b)(d)(e): anything not provably ours is untouched and logged', async () => {
      const id = randomUUID();
      // (a) the user's own `claude --resume <same uuid>` at the stored pid, started at another time.
      const a = await standIn(BIN, ['--resume', id]);
      // (b) an argv that only mentions the id.
      const b = await standIn('grep', ['-r', id, '.']);
      // (d) an empty and a non-UUID stored id, with argv carrying the same.
      const d1 = await standIn(BIN, ['--session-id', '']);
      const d2 = await standIn(BIN, ['--session-id', 'not-a-uuid']);
      // (e) another binary with matching tokens.
      const e = await standIn('/usr/bin/notclaude', ['--session-id', id]);
      seed([
        agentOf(a.leader, id, a.startedAt - 60_000),
        agentOf(b.leader, id, b.startedAt),
        agentOf(d1.leader, '', d1.startedAt),
        agentOf(d2.leader, 'not-a-uuid', d2.startedAt),
        agentOf(e.leader, id, e.startedAt),
      ]);
      const logs: string[] = [];
      makeDaemon(new FakeClaudeDriver(complete({})), {
        root: root(),
        claudeBin: BIN,
        log: (m) => logs.push(m),
        config: { killGraceMs: GRACE },
      });
      expect((await exits(5)).map((x) => x.signal)).toEqual(Array(5).fill('daemon_restart'));
      await settle();
      for (const p of [a, b, d1, d2, e]) {
        expect(alive(p.leader)).toBe(true);
        expect(alive(p.child)).toBe(true);
      }
      const notOurs = (pid: number, reason: string) =>
        `orphan sweep: pid ${pid} alive but not ours (${reason}); left alone`;
      expect(logs).toEqual(
        expect.arrayContaining([
          notOurs(a.leader, 'start time differs (pid reused)'),
          notOurs(b.leader, 'not the claude binary'),
          notOurs(d1.leader, 'invalid stored claude session id'),
          notOurs(d2.leader, 'invalid stored claude session id'),
          notOurs(e.leader, 'not the claude binary'),
        ]),
      );
      expect(logs.filter((l) => l.startsWith('startup: killed'))).toEqual([]);
    });

    it('FR-4: an old entry without startedAt is untouched, logged and cleared', async () => {
      const id = randomUUID();
      const s = await standIn(BIN, ['--session-id', id]);
      const [sid] = seed([agentOf(s.leader, id)]);
      const logs: string[] = [];
      const d = makeDaemon(new FakeClaudeDriver(complete({})), {
        root: root(),
        claudeBin: BIN,
        log: (m) => logs.push(m),
        config: { killGraceMs: GRACE },
      });
      expect((await exits(1)).map((x) => x.signal)).toEqual(['daemon_restart']);
      await settle();
      expect(alive(s.leader)).toBe(true);
      expect(logs).toContain(
        `orphan sweep: pid ${s.leader} of session ${sid} has no recorded start time (old entry); left alone`,
      );
      expect(d.store.session(sid!)!.agent).toBeNull();
    });

    it('FR-3: a process replaced between SIGTERM and SIGKILL gets no SIGKILL', async () => {
      const id = randomUUID();
      // Ignores SIGTERM, so only a SIGKILL would end it.
      const s = await standIn(BIN, ['--session-id', id], true);
      const [sid] = seed([agentOf(s.leader, id, s.startedAt)]);
      let calls = 0;
      // The re-check sees another start time: the pid now belongs to another process.
      const procInfo = (pid: number) => {
        const info = readProcInfo(pid);
        return info && calls++ > 0 ? { ...info, startedAt: info.startedAt + 1000 } : info;
      };
      const logs: string[] = [];
      makeDaemon(new FakeClaudeDriver(complete({})), {
        root: root(),
        claudeBin: BIN,
        procInfo,
        log: (m) => logs.push(m),
        config: { killGraceMs: GRACE },
      });
      await exits(1);
      expect(logs).toContain(
        `startup: killed orphaned claude process ${s.leader} of session ${sid}`,
      );
      await orch.until(() => (calls >= 2 ? true : undefined), 5_000);
      await settle();
      expect(alive(s.leader)).toBe(true);
      expect(logs).toContain(
        `orphan sweep: pid ${s.leader} alive but not ours (start time differs (pid reused)); left alone (no SIGKILL)`,
      );
    });

    it('FR-3 control: a process still ours after the grace period is SIGKILLed', async () => {
      const id = randomUUID();
      const s = await standIn(BIN, ['--session-id', id], true);
      seed([agentOf(s.leader, id, s.startedAt)]);
      makeDaemon(new FakeClaudeDriver(complete({})), {
        root: root(),
        claudeBin: BIN,
        config: { killGraceMs: GRACE },
      });
      await exits(1);
      // It ignores SIGTERM: only the SIGKILL after the grace period ends it (and its group).
      await orch.until(() => (!alive(s.leader) && !alive(s.child)) || undefined, 5_000);
    });
  },
);

describe('daemon core: misc', () => {
  it('reports exit (daemon_restart) for a process that died with the previous daemon', async () => {
    const root = join(tmp, 'root');
    const d1 = makeDaemon(new FakeClaudeDriver({ turns: [[{ askUser: 'q' }]] }), { root });
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = startSession(sid, {}, 7);
    orch.send(start);
    await orch.until(() => orch.events('ask_user')[0]);
    d1.stop({ killSessions: false }); // simulate a crash: no exit event from the driver
    makeDaemon(new FakeClaudeDriver(complete({})), { root });
    const exit = await orch.until(() => orch.events('exit')[0]);
    expect(exit.payload.data).toEqual({
      command_id: start.payload.command_id,
      code: null,
      signal: 'daemon_restart',
    });
    expect(exit.fencing_token).toBe(7);
    expect(exit.session_id).toBe(sid);
  });

  it('omits the CLAUDE.md section when the worktree has none', async () => {
    rmSync(join(repo, 'CLAUDE.md'));
    execFileSync('git', ['commit', '--quiet', '-am', 'rm'], { cwd: repo });
    const driver = new FakeClaudeDriver(complete({}));
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(startSession(randomUUID()));
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.starts[0]!.appendSystemPrompt).toBe(CONDUCTOR_INSTRUCTIONS);
    expect(existsSync(join(tmp, 'root', 'state', 'daemon.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(tmp, 'root', 'state', 'daemon.json'), 'utf8')),
    ).toHaveProperty('lastSeq', 4);
  });
});

describe('daemon core: run_action (ADR-0010 open_pr)', () => {
  it('acks, pushes the session branch to origin, opens the PR with gh, reports action_result', async () => {
    {
      // A fake gh (no network): `/bin/sh -c <script> gh <args>`. (Spawning a node script per
      // gh call stalls for seconds under load on this macOS; /bin/sh doesn't.)
      makeDaemon(new FakeClaudeDriver(complete({})), { ghCommand: FAKE_GH_SH });
      await orch.until(() => orch.ofType('request_work')[0]);
      const sid = randomUUID();
      orch.send(startSession(sid, {}, 4));
      await orch.until(() => orch.events('exit')[0]);
      const action = cmd(
        'run_action',
        sid,
        {
          command_id: randomUUID(),
          workflow_state: 'implementing → waiting_external (entry)',
          target_state: 'waiting_external',
          action: 'open_pr',
          idempotency_key: `${sid}:waiting_external:1`,
          args: { title: 'Add /health', body: 'Opened by conductor.' },
          branch: 'ignored/the-daemon-uses-its-own-record',
          // The worktree was branched from the fixture's HEAD and has no new commits.
          expected_sha: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repo,
            encoding: 'utf8',
          }).trim(),
        },
        4,
      );
      orch.send(action);
      const id = (action.payload as { command_id: string }).command_id;
      expect((await orch.until(() => orch.ack(id)[0])).payload.accepted).toBe(true);
      // Several git / gh subprocesses: allow for a loaded test machine.
      const res = await orch.until(() => orch.eventData('action_result')[0], 15_000);
      expect(res).toEqual({
        command_id: id,
        action: 'open_pr',
        result: { pr_url: 'https://github.com/benjgrad/fixture-app/pull/9' },
        error: null,
      });
      // The session branch (the daemon's own record) is now on the origin repo.
      const branch = sessionBranch(TICKET, sid);
      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
          cwd: repo,
          stdio: 'pipe',
        }),
      ).not.toThrow();
    }
  }, 30_000);

  it('refuses run_action for an unknown session', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const action = cmd('run_action', randomUUID(), {
      command_id: randomUUID(),
      workflow_state: 'x',
      target_state: 'y',
      action: 'open_pr',
      idempotency_key: 'k',
      args: {},
      branch: 'b',
      expected_sha: null,
    });
    orch.send(action);
    const id = (action.payload as { command_id: string }).command_id;
    expect((await orch.until(() => orch.ack(id)[0])).payload.reason).toBe('unknown_session');
  });
});

describe('daemon core: ADR-0011 transitions', () => {
  const TRANSITIONS = [
    { name: 'plan_ready', when: 'The plan is complete.', question: false },
    { name: 'scope_changed', when: null, question: true },
  ];

  it('passes start_session.transitions to the driver and forwards transition + reason', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [
          { completeState: {}, transition: 'nope' }, // refused once (the outcome-server nudge)
          { completeState: { plan: 'p' }, transition: 'plan_ready', reason: 'All files named.' },
        ],
      ],
    });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    orch.send(startSession(sid, { transitions: TRANSITIONS }));
    const done = await orch.until(() => orch.eventData('complete_state')[0]);
    expect(driver.starts[0]!.transitions).toEqual(TRANSITIONS);
    expect(done).toEqual({
      result: { plan: 'p' },
      transition: 'plan_ready',
      reason: 'All files named.',
    });
    expect(orch.eventData('complete_state')).toHaveLength(1);
  });

  it('an old start_session (no transitions) forwards complete_state without the fields', async () => {
    const driver = new FakeClaudeDriver(complete({ ok: true }));
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(startSession(randomUUID()));
    expect(await orch.until(() => orch.eventData('complete_state')[0])).toEqual({
      result: { ok: true },
    });
    expect(driver.starts[0]!.transitions).toBeUndefined();
  });
});

describe('daemon core: run_action evaluate_conditions (ADR-0011)', () => {
  /** A fake gh whose `pr view` reports green checks and one approval. */
  const FAKE_GH_VIEW = {
    cmd: '/bin/sh',
    args: [
      '-c',
      [
        'if [ "$1 $2" != "pr view" ]; then exit 9; fi',
        'echo \'{"state":"OPEN","mergedAt":null,"reviewDecision":"APPROVED","headRefOid":"' +
          'a'.repeat(40) +
          '",' +
          '"statusCheckRollup":[{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],' +
          '"reviews":[{"author":{"login":"amy"},"authorAssociation":"MEMBER","state":"APPROVED","commit":{"oid":"' +
          'a'.repeat(40) +
          '"}}]}\'',
      ].join('\n'),
      'gh',
    ],
  };

  const evaluate = (sid: string, args: Record<string, unknown>) =>
    cmd(
      'run_action',
      sid,
      {
        command_id: randomUUID(),
        workflow_state: 'implementing → waiting_external (ready_for_testing)',
        target_state: 'waiting_external',
        action: 'evaluate_conditions',
        idempotency_key: `${sid}:conditions:1`,
        args: args as never,
        branch: 'ignored',
        expected_sha: null,
      },
      4,
    );

  it('acks accepted and reports one action_result with a result per condition', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})), { ghCommand: FAKE_GH_VIEW });
    await orch.until(() => orch.ofType('request_work')[0]);
    // Read-only and worktree-free: no session on this daemon is needed (ADR-0016).
    const sid = randomUUID();
    const action = evaluate(sid, {
      conditions: [
        { type: 'pr_checks_green' },
        { type: 'pr_approvals', min: 2 },
        { type: 'jira_fields_set', fields: ['status'], enabled: false },
      ],
      pr_url: 'https://github.com/benjgrad/fixture-app/pull/9',
      branch: 'b',
    });
    orch.send(action);
    const id = (action.payload as { command_id: string }).command_id;
    expect((await orch.until(() => orch.ack(id)[0])).payload.accepted).toBe(true);
    const res = await orch.until(() => orch.eventData('action_result')[0], 15_000);
    expect(res).toEqual({
      command_id: id,
      action: 'evaluate_conditions',
      result: {
        results: [
          { type: 'pr_checks_green', status: 'met', value: '1/1 passed', detail: null },
          { type: 'pr_approvals', status: 'pending', value: '1/2', detail: 'approved by amy' },
          {
            type: 'jira_fields_set',
            status: 'unsupported',
            value: null,
            detail: "jira_fields_set can't be evaluated on this machine yet",
          },
        ],
      },
      error: null,
    });
    expect(orch.eventData('action_result')).toHaveLength(1);
  });

  it('invalid args → accepted, then an action_result error', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})), { ghCommand: FAKE_GH_VIEW });
    await orch.until(() => orch.ofType('request_work')[0]);
    const action = evaluate(randomUUID(), { conditions: [], pr_url: null, branch: 'b' });
    orch.send(action);
    const id = (action.payload as { command_id: string }).command_id;
    expect((await orch.until(() => orch.ack(id)[0])).payload.accepted).toBe(true);
    const res = await orch.until(() => orch.eventData('action_result')[0]);
    expect(res.result).toBeNull();
    expect(res.error).toContain('evaluate_conditions: invalid args');
  });
});

describe('appendTail (exit stderr_tail)', () => {
  it('keeps the last STDERR_TAIL_LINES lines across chunk boundaries', () => {
    let tail = '';
    for (let i = 0; i < 30; i++) tail = appendTail(tail, `l${i}\n`);
    expect(tail.split('\n').filter((l) => l !== '')).toEqual(
      Array.from({ length: 20 }, (_, i) => `l${i + 10}`),
    );
    expect(appendTail('par', 'tial')).toBe('partial');
  });

  it('caps the characters', () => {
    expect(appendTail('', 'y'.repeat(10_000))).toHaveLength(STDERR_TAIL_CHARS);
  });
});
