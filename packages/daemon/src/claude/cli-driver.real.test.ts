// Opt-in checks against the installed `claude` CLI ($CONDUCTOR_CLAUDE_BIN, else `claude`).
//   CONDUCTOR_REAL_CLAUDE=flags  zero cost: the CLI accepts the ADR-0005 argv (stdin closed before
//                                any user message, so no model call; init comes only after one)
//   CONDUCTOR_REAL_CLAUDE=1      spends ~$0.01 on haiku: ask_user → sendInput → complete_state
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs, createCliDriver } from './cli-driver.js';
import type { DriverEvent, DriverStartOptions } from './driver.js';
import { startOutcomeServer, type OutcomeServer } from './outcome-server.js';

const mode = process.env.CONDUCTOR_REAL_CLAUDE;
const bin = process.env.CONDUCTOR_CLAUDE_BIN ?? 'claude';

let server: OutcomeServer;
let dir: string;
beforeAll(async () => {
  server = await startOutcomeServer();
  dir = mkdtempSync(join(tmpdir(), 'cli-driver-real-'));
});
afterAll(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const base = (): DriverStartOptions => ({
  cwd: dir,
  prompt: '',
  tools: {
    builtin: ['Read', 'Glob', 'Grep'],
    allow: ['Read(./**)', 'Glob(./**)', 'Grep(./**)'],
    deny: ['Bash(git push:*)'],
  },
  claudeSessionId: randomUUID(),
  resume: false,
  env: {},
  model: 'haiku',
  maxTurns: 6,
  maxBudgetUsd: 0.2,
  appendSystemPrompt: 'You are driven by an orchestrator.',
});

describe.runIf(mode === 'flags' || mode === '1')('real claude CLI: flags', () => {
  it('accepts the exact ADR-0005 argv and exits 0 on stdin EOF', async () => {
    const reg = server.register({ onAskUser: () => {}, onCompleteState: () => {} });
    const child = spawn(bin, buildClaudeArgs(base(), reg.mcpConfig), { cwd: dir });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    reg.unregister();
    expect(stderr).toBe('');
    expect(code).toBe(0);
  }, 30_000);
});

describe.runIf(mode === '1')('real claude CLI: ask_user round trip (spends money)', () => {
  it('asks, takes the live answer, completes', async () => {
    const driver = createCliDriver({ claudeBin: bin, outcomeServer: server });
    const s = driver.start({
      ...base(),
      prompt:
        'Call the ask_user tool with the question "Which colour?". Then end your turn. When the answer arrives, call complete_state with result {"colour": <the answer>} and stop.',
    });
    const events: DriverEvent[] = [];
    let answered = false;
    const exited = new Promise<void>((resolve) =>
      s.on((ev) => {
        events.push(ev);
        if (ev.kind === 'turn_end') {
          const done = events.some((e) => e.kind === 'complete_state');
          const asked = events.some((e) => e.kind === 'ask_user');
          if (done || (!asked && answered)) s.end();
          else if (asked && !answered) {
            answered = true; // parked with a live process: answer into stdin
            s.sendInput('green');
          } else s.end();
        }
        if (ev.kind === 'exit') resolve();
      }),
    );
    await exited;
    const kinds = events.filter((e) => e.kind !== 'output').map((e) => e.kind);
    console.log('cliVersion', s.cliVersion, kinds);
    expect(s.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(events).toContainEqual({ kind: 'claude_session_id', id: s.claudeSessionId });
    expect(events.find((e) => e.kind === 'complete_state')).toMatchObject({
      result: { colour: 'green' },
    });
    expect(events.at(-1)).toEqual({ kind: 'exit', code: 0, signal: null });
  }, 180_000);
});
