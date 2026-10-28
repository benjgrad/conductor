import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionBranch, type OrchestratorToDaemon } from '@conductor/shared';
import { createCliDriver } from './claude/cli-driver.js';
import { startOutcomeServer, type OutcomeServer } from './claude/outcome-server.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';
import { readProcInfo } from './orphan.js';
import { FakeOrchestrator } from './test-support/fake-orchestrator.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// BUG-1 FR-2: a kill for a parked agent process (ADR-0007: alive, idle, blocked reading stdin
// for an answer) ends it and is acked. The real CLI driver against the process-boundary fake
// (test/fixtures/fake-claude.mjs), so a real process group is signalled.

const FAKE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));
const TICKET = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';

let server: OutcomeServer;
let tmp: string;
let repo: string;
let orch: FakeOrchestrator;
let daemon: Daemon | null = null;

beforeAll(async () => {
  server = await startOutcomeServer();
});
afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-daemon-kill-'));
  repo = join(tmp, 'origin');
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '--quiet', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '--quiet', '-m', 'init');
  orch = await FakeOrchestrator.start();
});

afterEach(async () => {
  daemon?.stop();
  daemon = null;
  await orch.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function makeDaemon(opts: { claudeBin?: string; log?: (m: string) => void } = {}): Daemon {
  const config = loadConfig({
    CONDUCTOR_ORCHESTRATOR_URL: orch.url,
    CONDUCTOR_ROOT: join(tmp, 'root'),
    CONDUCTOR_MACHINE_ID: 'test-machine',
    CONDUCTOR_MAX_SESSIONS: '2',
    CONDUCTOR_PORT_POOL: '42100-42129',
    CONDUCTOR_MIN_FREE_MEM_MB: '0',
    CONDUCTOR_WORK_POLL_MS: '60000',
    CONDUCTOR_ALLOW_LOCAL_REPOS: '1',
  });
  config.reconnect = { initialMs: 20, maxMs: 100, factor: 2 };
  config.killGraceMs = 2_000;
  const d = new Daemon({
    config,
    driver: createCliDriver({
      claudeBin: FAKE,
      outcomeServer: server,
      killGraceMs: 2_000,
      extraStateEnv: /^FAKE_CLAUDE_/,
    }),
    sysinfo: () => ({ cpuFree: 4, memFreeMb: 8000, diskFreeMb: 50_000 }),
    claudeCodeVersion: 'fake',
    log: opts.log ?? (() => {}),
    ...(opts.claudeBin !== undefined ? { claudeBin: opts.claudeBin } : {}),
  });
  d.start();
  daemon = d;
  return d;
}

function parkedStart(sessionId: string): Extract<OrchestratorToDaemon, { type: 'start_session' }> {
  return {
    type: 'start_session',
    msg_id: randomUUID(),
    seq: null,
    session_id: sessionId,
    fencing_token: 1,
    payload: {
      command_id: randomUUID(),
      ticket_id: TICKET,
      repo,
      base_ref: 'HEAD',
      branch: sessionBranch(TICKET, sessionId),
      workflow_state: 'implement',
      prompt: 'Implement the ticket',
      tools: ['read'],
      resume_claude_session_id: null,
      max_budget_usd: 5,
      env: {
        FAKE_CLAUDE_SCENARIO: JSON.stringify([[{ ask_user: 'Which colour?' }]]),
        FAKE_CLAUDE_STATE_DIR: join(tmp, 'fake-state'),
      },
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// MW-T06: kills a real POSIX process group
describe.skipIf(onWin32)('BUG-1 FR-2: kill of a parked process (real process group)', () => {
  it.each([
    ['aimed at its start_session', (cid: string) => cid],
    ['null target at its fencing token', () => null],
  ])('a kill %s ends it within 5 s and is acked', async (_name, target) => {
    const d = makeDaemon();
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const start = parkedStart(sid);
    orch.send(start);
    // Parked: ask_user reported, the process idle waiting for an answer on stdin.
    await orch.until(() => orch.events('ask_user')[0]);
    const pid = d.store.session(sid)!.agent!.pid!;
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    const killId = randomUUID();
    const sentAt = Date.now();
    orch.send({
      type: 'kill',
      msg_id: randomUUID(),
      seq: null,
      session_id: sid,
      fencing_token: 1,
      payload: {
        command_id: killId,
        target_command_id: target(start.payload.command_id),
        reason: 'session done',
      },
    });
    const exit = await orch.until(() => orch.events('exit')[0], 5_000);
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(exit.payload.data).toMatchObject({ command_id: start.payload.command_id });
    expect(orch.ack(killId)[0]!.payload.accepted).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(d.store.session(sid)!.agent).toBeNull();
  });
});

// MW-T06: kills a real POSIX process group
describe.skipIf(onWin32)(
  'BUG-1b: the startup sweep against a real (fake-claude) process group',
  () => {
    it('FR-1: the start time is persisted at spawn; a restarted daemon kills its orphan', async () => {
      const d1 = makeDaemon();
      await orch.until(() => orch.ofType('request_work')[0]);
      const sid = randomUUID();
      orch.send(parkedStart(sid));
      await orch.until(() => orch.events('ask_user')[0]);
      const agent = d1.store.session(sid)!.agent!;
      const pid = agent.pid!;
      try {
        expect(agent.startedAt).toBe(readProcInfo(pid)!.startedAt);
        expect(Math.abs(agent.startedAt! - Date.now())).toBeLessThan(10_000);
        // The daemon dies with the process still running (a detached `node fake-claude.mjs
        // --session-id <id> …`, the shebang-launcher form of argv).
        d1.stop({ killSessions: false });
        daemon = null;
        const logs: string[] = [];
        makeDaemon({ claudeBin: FAKE, log: (m) => logs.push(m) });
        await orch.until(() => !alive(pid) || undefined, 5_000);
        expect(logs).toContain(`startup: killed orphaned claude process ${pid} of session ${sid}`);
        await orch.until(() => orch.eventData('exit').find((e) => e.signal === 'daemon_restart'));
      } finally {
        try {
          process.kill(-pid, 'SIGKILL'); // the fake's own group, started by this test
        } catch {
          // gone
        }
      }
    });
  },
);
