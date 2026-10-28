import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionBranch, type OrchestratorToDaemon } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClaudeDriver, type FakeClaudeScript } from './claude/fake-driver.js';
import { claudeProjectSlug } from './claude/transcript.js';
import { FakeCommandRunner } from './commands/fake-runner.js';
import { loadConfig } from './config.js';
import { removeTree } from './test-support/remove-tree.js';
import { Daemon } from './daemon.js';
import { FakeOrchestrator } from './test-support/fake-orchestrator.js';

// Tests that can't pass on native Windows yet skip there (ADR-0024); each `// MW-Tnn` names
// the task that unskips them.
const onWin32 = process.platform === 'win32';

// ADR-0008 on the daemon: `fetch_transcript` → `transcript` (located from the daemon's own
// store only), and a reopened session's start on a branch still checked out in the earlier
// session's worktree (that worktree is reused).

const TICKET = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';
const FIXTURE = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../test/fixtures/transcript.jsonl',
);

let tmp: string;
let repo: string;
let claudeDir: string;
let orch: FakeOrchestrator;
const daemons: Daemon[] = [];

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-daemon-reopen-')));
  repo = join(tmp, 'origin');
  claudeDir = join(tmp, 'claude-config');
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
  for (const d of daemons.splice(0)) d.stop();
  await orch.close();
  expect(orch.invalid).toEqual([]);
  await removeTree(tmp); // TD-111
});

function makeDaemon(driver: FakeClaudeDriver): Daemon {
  const config = loadConfig({
    CONDUCTOR_ORCHESTRATOR_URL: orch.url,
    CONDUCTOR_ROOT: join(tmp, 'root'),
    CONDUCTOR_MACHINE_ID: 'test-machine',
    CONDUCTOR_MAX_SESSIONS: '3',
    CONDUCTOR_PORT_POOL: '42100-42129',
    CONDUCTOR_MIN_FREE_MEM_MB: '0',
    CONDUCTOR_WORK_POLL_MS: '60000',
    CONDUCTOR_ALLOW_LOCAL_REPOS: '1',
    CLAUDE_CONFIG_DIR: claudeDir,
  });
  config.reconnect = { initialMs: 20, maxMs: 100, factor: 2 };
  config.endGraceMs = 200;
  const d = new Daemon({
    config,
    driver,
    createCommandRunner: () => new FakeCommandRunner(2, true),
    sysinfo: () => ({ cpuFree: 4, memFreeMb: 8000, diskFreeMb: 50_000 }),
    claudeCodeVersion: '2.1.308',
    log: () => {},
    scanInventory: () => Promise.resolve({ repos: [], capabilities: [] }),
  });
  daemons.push(d);
  d.start();
  return d;
}

function startSession(
  sessionId: string,
  over: Partial<Extract<OrchestratorToDaemon, { type: 'start_session' }>['payload']> = {},
): Extract<OrchestratorToDaemon, { type: 'start_session' }> {
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
      tools: ['read', 'edit'],
      resume_claude_session_id: null,
      env: {},
      ...over,
    },
  };
}

function fetchTranscript(sessionId: string): string {
  const requestId = randomUUID();
  orch.send({
    type: 'fetch_transcript',
    msg_id: randomUUID(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: { request_id: requestId, session_id: sessionId },
  });
  return requestId;
}

const reply = (requestId: string) =>
  orch.until(() => orch.ofType('transcript').find((m) => m.payload.request_id === requestId));

const complete: FakeClaudeScript = {
  turns: [[{ say: 'working' }, { completeState: { ok: true } }], [{ completeState: { ok: 2 } }]],
};

/** Start a session and wait for its process to finish; returns the started worktree + claude id. */
async function runToExit(driver: FakeClaudeDriver, start: ReturnType<typeof startSession>) {
  orch.send(start);
  await orch.until(() =>
    orch.eventData('exit').find((e) => e.command_id === start.payload.command_id),
  );
  const started = orch.eventData('started').find((s) => s.command_id === start.payload.command_id)!;
  const opts = driver.starts.at(-1)!;
  return { worktree: started.worktree_path, claudeSessionId: opts.claudeSessionId };
}

function writeTranscript(worktree: string, claudeSessionId: string): string {
  const dir = join(claudeDir, 'projects', claudeProjectSlug(realpathSync(worktree)));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${claudeSessionId}.jsonl`);
  copyFileSync(FIXTURE, file);
  return file;
}

describe('fetch_transcript (ADR-0008)', () => {
  it('answers with the session transcript located from the store', async () => {
    const driver = new FakeClaudeDriver(complete);
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const sid = randomUUID();
    const { worktree, claudeSessionId } = await runToExit(driver, startSession(sid));

    // Before Claude wrote anything: no_transcript.
    const r0 = await reply(fetchTranscript(sid));
    expect(r0.payload).toEqual({ request_id: r0.payload.request_id, error: 'no_transcript' });
    expect(r0.session_id).toBeNull();

    writeTranscript(worktree, claudeSessionId);
    const r1 = await reply(fetchTranscript(sid));
    if ('error' in r1.payload) throw new Error(r1.payload.error);
    expect(r1.payload.truncated).toBe(false);
    expect(r1.payload.chunks).toHaveLength(11);
    expect(r1.payload.chunks[0]).toMatchObject({ stream: 'user' });
    expect(r1.payload.chunks.at(-1)).toMatchObject({
      stream: 'assistant',
      text: 'Created greeting.txt and committed it.',
    });

    // The worktree may be gone (cleaned up): the transcript path doesn't need it.
    await removeTree(worktree);
    const r2 = await reply(fetchTranscript(sid));
    expect('chunks' in r2.payload && r2.payload.chunks.length).toBe(11);
  });

  it('unknown_session for a session this daemon never ran', async () => {
    makeDaemon(new FakeClaudeDriver(complete));
    await orch.until(() => orch.ofType('request_work')[0]);
    const r = await reply(fetchTranscript(randomUUID()));
    expect('error' in r.payload && r.payload.error).toBe('unknown_session');
  });
});

// MW-T09: worktree reuse and transcript paths on win32
describe.skipIf(onWin32)('reopen: a new session on the earlier session’s branch (ADR-0008)', () => {
  it('reuses the old worktree, resumes the Claude session, and both transcripts resolve', async () => {
    const driver = new FakeClaudeDriver(complete);
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const oldSid = randomUUID();
    const first = await runToExit(driver, startSession(oldSid));
    writeFileSync(join(first.worktree, 'uncommitted.txt'), 'keep me\n');
    // The fake driver writes no transcript; the resume check needs one on this machine.
    writeTranscript(first.worktree, first.claudeSessionId);

    const newSid = randomUUID();
    const start = startSession(newSid, {
      branch: sessionBranch(TICKET, oldSid), // carried by the reopen
      resume_claude_session_id: first.claudeSessionId,
      prompt: 'Make it blue',
    });
    const second = await runToExit(driver, start);
    expect(orch.ack(start.payload.command_id)[0]!.payload.accepted).toBe(true);
    expect(second.worktree).toBe(first.worktree);
    const opts = driver.starts.at(-1)!;
    expect(opts).toMatchObject({
      cwd: first.worktree,
      resume: true,
      claudeSessionId: first.claudeSessionId,
      prompt: 'Make it blue',
    });
    // Same files, uncommitted ones too, on the same branch.
    expect(
      execFileSync('git', ['branch', '--show-current'], { cwd: second.worktree }).toString().trim(),
    ).toBe(sessionBranch(TICKET, oldSid));
    expect(execFileSync('cat', ['uncommitted.txt'], { cwd: second.worktree }).toString()).toBe(
      'keep me\n',
    );

    for (const sid of [oldSid, newSid]) {
      const r = await reply(fetchTranscript(sid));
      expect('chunks' in r.payload && r.payload.chunks.length).toBe(11);
    }
  });

  it('refuses the start while the earlier session still has a live process in that worktree', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ askUser: 'Which port?' }]] });
    makeDaemon(driver);
    await orch.until(() => orch.ofType('request_work')[0]);
    const oldSid = randomUUID();
    orch.send(startSession(oldSid));
    await orch.until(() => orch.events('ask_user')[0]); // parked: alive and idle

    const start = startSession(randomUUID(), { branch: sessionBranch(TICKET, oldSid) });
    orch.send(start);
    const ack = await orch.until(() => orch.ack(start.payload.command_id)[0]);
    expect(ack.payload.accepted).toBe(false);
    expect(ack.payload.reason).toMatch(/^start_failed: worktree .* is in use by session/);
  });
});
