import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveToolPolicy, sessionBranch, type OrchestratorToDaemon } from '@conductor/shared';
import { FakeClaudeDriver, type FakeClaudeScript } from './claude/fake-driver.js';
import { FakeCommandRunner } from './commands/fake-runner.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { Daemon } from './daemon.js';
import { DaemonStore } from './store.js';
import type { LiveResources } from './sysinfo.js';
import { CONDUCTOR_INSTRUCTIONS } from './system-prompt.js';
import { FakeOrchestrator } from './test-support/fake-orchestrator.js';

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
  // A background `git` (repo inventory) may still be writing when the test ends.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeDaemon(
  driver: FakeClaudeDriver,
  opts: {
    runner?: FakeCommandRunner;
    env?: Record<string, string>;
    root?: string;
    config?: Partial<DaemonConfig>;
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
    log: () => {},
  });
  daemons.push(d);
  d.start();
  return d;
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

function cmd<T extends 'send_input' | 'run_cmd' | 'kill'>(
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

const complete = (result: Record<string, unknown>): FakeClaudeScript => ({
  turns: [[{ say: 'working' }, { completeState: result }]],
});

describe('daemon core: link', () => {
  it('registers, then sends heartbeat, repo_inventory and request_work', async () => {
    makeDaemon(new FakeClaudeDriver(complete({})));
    await orch.until(() => orch.ofType('request_work')[0]);
    const types = orch.received.map((m) => m.type);
    expect(types.slice(0, 4)).toEqual(['register', 'heartbeat', 'repo_inventory', 'request_work']);
    const reg = orch.ofType('register')[0]!.payload;
    expect(reg).toMatchObject({
      machine_id: 'test-machine',
      enrollment_token: null,
      max_sessions: 2,
      max_concurrent_builds: 2,
      claude_code_version: '2.1.308',
    });
    expect(orch.ofType('heartbeat')[0]!.payload).toMatchObject({ mem_free_mb: 8000, sessions: [] });
    expect(orch.ofType('request_work')[0]!.payload).toMatchObject({
      free_slots: 2,
      mem_free_mb: 8000,
    });
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

  it('resumes with --resume semantics when resume_claude_session_id is set', async () => {
    const driver = new FakeClaudeDriver(complete({}));
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    orch.send(
      startSession(randomUUID(), { resume_claude_session_id: 'claude-abc', prompt: 'the answer' }),
    );
    await orch.until(() => orch.events('exit')[0]);
    expect(driver.starts[0]).toMatchObject({
      claudeSessionId: 'claude-abc',
      resume: true,
      prompt: 'the answer',
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
    await orch.until(() => orch.events('ask_user')[0]);
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

    const id1 = (r1.payload as { command_id: string }).command_id;
    expect(orch.eventData('cmd_exit')[0]).toEqual({
      command_id: id1,
      exit_code: 1,
      signal: null,
      timed_out: false,
      duration_ms: 0,
      output_tail: 'FAIL\n',
    });
    const wt = orch.eventData('started')[0]!.worktree_path;
    expect(runner.calls[0]).toMatchObject({ cwd: wt, sessionId: sid, timeoutMs: 1000 });
    expect(runner.calls[0]!.env).toMatchObject({ PORT: '42000', CONDUCTOR_TICKET_ID: TICKET });
    expect(runner.calls[1]!.cwd).toBe(join(wt, 'sub'));
    expect(
      orch
        .ofType('output')
        .some((o) => o.payload.stream === 'stdout' && o.payload.text === 'FAIL\n'),
    ).toBe(true);
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
