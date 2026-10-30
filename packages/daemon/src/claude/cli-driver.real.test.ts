// Opt-in checks against the installed `claude` CLI ($CONDUCTOR_CLAUDE_BIN, else `claude`).
//   E2E_REAL_CLAUDE=flags        zero cost: the CLI accepts the ADR-0005 argv (stdin closed before
//                                any user message, so no model call; init comes only after one)
//   E2E_REAL_CLAUDE=1            spends ~$0.01 on haiku: ask_user → sendInput → complete_state
//   E2E_REAL_CLAUDE=permission   spends ~$0.02 on haiku (ADR-0023, ADR-0027): the production worker
//                                argv in auto mode; `git push` reaches the prompt tool through its
//                                ask rule, is allowed through the held call, and pushes
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentEnv,
  buildClaudeArgs,
  createCliDriver,
  splitPromptableDenies,
  userMessageLine,
} from './cli-driver.js';
import type { DriverEvent, DriverStartOptions } from './driver.js';
import { writeEditGuard } from './edit-guard.js';
import {
  PERMISSION_TOOL,
  startOutcomeServer,
  type OutcomeServer,
  type PermissionPrompt,
} from './outcome-server.js';

const mode = process.env.E2E_REAL_CLAUDE;
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
    const settings = writeEditGuard(mkdtempSync(join(dir, 'guard-')), dir);
    const child = spawn(bin, buildClaudeArgs(base(), reg.mcpConfig, settings), { cwd: dir });
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

describe.runIf(mode === 'permission')(
  'real claude CLI: permission prompt round trip (spends money)',
  () => {
    // ADR-0027 spike (2026-10-30, CLI 2.1.314): in auto mode a plain `git push` with no rule runs
    // unprompted; an ask rule (or a PreToolUse hook answering `ask`) sends it to the prompt tool.
    it('auto mode: git push reaches the prompt tool through its ask rule, is allowed, and pushes', async () => {
      const work = mkdtempSync(join(dir, 'work-'));
      const remote = mkdtempSync(join(dir, 'remote-'));
      const git = (args: string[], cwd: string) =>
        new Promise<number | null>((r) => spawn('git', args, { cwd }).on('exit', (c) => r(c)));
      await git(['init', '-q', '--bare', '.'], remote);
      await git(['init', '-q', '-b', 'main', '.'], work);
      await git(
        [
          '-c',
          'user.email=p@p',
          '-c',
          'user.name=p',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        work,
      );
      await git(['remote', 'add', 'origin', remote], work);
      const prompts: PermissionPrompt[] = [];
      const reg = server.register({
        onAskUser: () => {},
        onCompleteState: () => {},
        onPermissionRequest: (p) => {
          prompts.push(p);
          // A human clicks Allow once a moment later.
          setTimeout(
            () => reg.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' }),
            300,
          );
        },
      });
      const o: DriverStartOptions = {
        ...base(),
        cwd: work,
        tools: { builtin: ['Bash'], allow: [], deny: ['Bash(git push:*)'] },
      };
      // What CliDriver.start writes for a host worker.
      const { ask } = splitPromptableDenies(o.tools.deny, true);
      const settings = writeEditGuard(mkdtempSync(join(dir, 'guard-')), work, undefined, ask);
      const args = buildClaudeArgs(o, reg.mcpConfig, settings);
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
      const child = spawn(bin, args, { cwd: work, env: agentEnv({}).env });
      const lines: Record<string, unknown>[] = [];
      let buf = '';
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const done = new Promise<void>((resolve) => {
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              const j = JSON.parse(line) as Record<string, unknown>;
              lines.push(j);
              if (j.type === 'result') child.stdin.end();
            } catch {
              // not JSON
            }
          }
        });
        child.on('exit', () => resolve());
      });
      child.stdin.write(
        userMessageLine(
          'Use the Bash tool to run exactly `git push -u origin HEAD` once. Then reply DONE and stop. Do not call any other tool and do not retry.',
        ),
      );
      await done;
      reg.unregister();
      const init = lines.find((l) => l.type === 'system' && l.subtype === 'init') as
        { tools?: string[]; claude_code_version?: string; permissionMode?: string } | undefined;
      const result = lines.find((l) => l.type === 'result') as
        { permission_denials?: unknown[]; total_cost_usd?: number } | undefined;
      console.log(
        JSON.stringify(
          {
            version: init?.claude_code_version,
            permissionMode: init?.permissionMode,
            permissionToolVisibleToModel: init?.tools?.includes(PERMISSION_TOOL),
            prompts: prompts.map((p) => ({ tool: p.tool, input: p.input })),
            denials: result?.permission_denials,
            cost: result?.total_cost_usd,
            stderr: stderr.slice(0, 500),
          },
          null,
          2,
        ),
      );
      expect(init?.permissionMode).toBe('auto');
      expect(
        prompts.some((p) => p.tool === 'Bash' && JSON.stringify(p.input).includes('git push')),
      ).toBe(true);
      // Allowed once, the push ran: the remote has the branch.
      expect(await git(['rev-parse', '--verify', '-q', 'refs/heads/main'], remote)).toBe(0);
    }, 180_000);
  },
);
