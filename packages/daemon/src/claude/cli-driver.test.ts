// Real driver + real outcome server against the process-boundary fake (test/fixtures/fake-claude.mjs).
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveToolPolicy } from '@conductor/shared';
import {
  agentEnv,
  agentPermissionMode,
  buildClaudeArgs,
  createCliDriver,
  permissionPromptSupport,
  probePermissionPrompts,
  userMessageLine,
  type CliDriverSession,
} from './cli-driver.js';
import type { DriverEvent, DriverStartOptions, ToolPolicy } from './driver.js';
import {
  ASK_USER_TOOL,
  COMPLETE_STATE_TOOL,
  PERMISSION_DENIED_ON_BOARD,
  PERMISSION_SESSION_ENDED,
  PERMISSION_TOOL,
  permissionTimeoutText,
  startOutcomeServer,
  type OutcomeServer,
} from './outcome-server.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url));
/** The fake reads its script from these state-env keys; production drops them (STATE_ENV_ALLOWED). */
const FAKE_ENV = /^FAKE_CLAUDE_/;

const TOOLS: ToolPolicy = {
  builtin: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  allow: ['Read(./**)', 'Edit(./**)', 'Bash(git commit -m:*)'],
  deny: ['Bash(git push:*)', 'WebFetch'],
};

let server: OutcomeServer;
let dir: string;
const live: CliDriverSession[] = [];

beforeAll(async () => {
  server = await startOutcomeServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-driver-test-'));
});
afterEach(() => {
  for (const s of live.splice(0)) s.kill(0);
  rmSync(dir, { recursive: true, force: true });
});

type Scenario = unknown[][] | { turns: unknown[][]; costPerTurnUsd?: number };

function opts(scenario: Scenario, over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    cwd: dir,
    prompt: 'do the thing',
    tools: TOOLS,
    claudeSessionId: randomUUID(),
    resume: false,
    env: {
      FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario),
      FAKE_CLAUDE_STATE_DIR: join(dir, 'state'),
      FAKE_CLAUDE_ARGV_LOG: join(dir, 'argv.ndjson'),
      FAKE_CLAUDE_VERSION: '9.9.9-fake',
      PORT: '41000',
    },
    ...over,
  };
}

function track(s: CliDriverSession) {
  live.push(s);
  const events: DriverEvent[] = [];
  s.on((ev) => events.push(ev));
  const waitFor = (pred: (ev: DriverEvent, i: number) => boolean, ms = 10_000) =>
    new Promise<DriverEvent>((resolve, reject) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(
        () => reject(new Error(`timeout; events so far: ${JSON.stringify(events)}`)),
        ms,
      );
      const off = s.on((ev) => {
        if (pred(ev, events.length)) {
          clearTimeout(t);
          off();
          resolve(ev);
        }
      });
    });
  const turnEnds = (n: number) =>
    waitFor(() => events.filter((e) => e.kind === 'turn_end').length >= n);
  const exit = () =>
    waitFor((e) => e.kind === 'exit') as Promise<Extract<DriverEvent, { kind: 'exit' }>>;
  const kinds = () => events.filter((e) => e.kind !== 'output').map((e) => e.kind);
  return { events, waitFor, turnEnds, exit, kinds };
}

const argvLog = () =>
  readFileSync(join(dir, 'argv.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: Record<string, string> });

describe('buildClaudeArgs', () => {
  it('emits exactly the ADR-0005/ADR-0006 flags for a new session', () => {
    const o = opts([], {
      claudeSessionId: 'sid-1',
      model: 'sonnet',
      maxTurns: 40,
      maxBudgetUsd: 2.5,
      appendSystemPrompt: 'use complete_state',
    });
    expect(buildClaudeArgs(o, '{"mcp":1}', '/tmp/s/settings.json')).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      'sid-1',
      '--model',
      'sonnet',
      '--max-turns',
      '40',
      '--max-budget-usd',
      '2.5',
      '--setting-sources',
      'user',
      '--settings',
      '/tmp/s/settings.json',
      '--strict-mcp-config',
      '--permission-mode',
      'auto',
      '--permission-prompts',
      'host',
      '--permission-prompt-tool',
      PERMISSION_TOOL,
      '--mcp-config',
      '{"mcp":1}',
      '--tools',
      'Read,Edit,Write,Glob,Grep,Bash',
      '--allowedTools',
      `Read(./**),Edit(./**),Bash(git commit -m:*),${COMPLETE_STATE_TOOL},${ASK_USER_TOOL}`,
      '--disallowedTools',
      'Bash(git push:*),WebFetch',
      '--append-system-prompt',
      'use complete_state',
    ]);
  });

  const flagOf = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const modeOf = (args: string[]) => flagOf(args, '--permission-mode');

  it('ADR-0009: a reviewer always runs in dontAsk and never prompts; ADR-0023: a worker runs in auto', () => {
    const reviewer = opts([], { review: true });
    for (const perm of [
      undefined,
      { prompts: 'host' as const },
      { prompts: 'none' as const, legacyMode: 'auto' },
    ]) {
      const args = buildClaudeArgs(reviewer, '{}', 's.json', perm);
      expect(modeOf(args), JSON.stringify(perm)).toBe('dontAsk');
      expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
      expect(flagOf(args, '--permission-prompts')).toBe('none');
      expect(args).not.toContain('--permission-prompt-tool');
      // The other ADR-0006 guards stay.
      expect(args).toEqual(
        expect.arrayContaining(['--setting-sources', 'user', '--settings', 's.json']),
      );
    }
    for (const worker of [opts([]), opts([], { review: false })]) {
      const args = buildClaudeArgs(worker, '{}', 's.json');
      expect(modeOf(args)).toBe('auto');
      expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
      expect(flagOf(args, '--permission-prompts')).toBe('host');
      expect(flagOf(args, '--permission-prompt-tool')).toBe('mcp__conductor__permission');
      // The prompt tool is Claude's, not the model's: never pre-approved.
      expect(flagOf(args, '--allowedTools')).not.toContain(PERMISSION_TOOL);
    }
  });

  it('ADR-0023 fallback (old CLI): the pre-ADR-0023 flags, the user mode or the bypass cap, prompts denied', () => {
    const worker = opts([]);
    const plain = buildClaudeArgs(worker, '{}', 's.json', { prompts: 'none' });
    expect(modeOf(plain)).toBeUndefined();
    expect(flagOf(plain, '--permission-prompts')).toBe('none');
    expect(plain).not.toContain('--permission-prompt-tool');
    const capped = buildClaudeArgs(worker, '{}', 's.json', { prompts: 'none', legacyMode: 'auto' });
    expect(modeOf(capped)).toBe('auto');
    expect(flagOf(capped, '--permission-prompts')).toBe('none');
  });

  it('ADR-0023 §4: git push stays a deny rule beside the prompt tool, so it never reaches a human', () => {
    // The real workflow aliases, as start_session sends them.
    const tools = resolveToolPolicy(['read', 'edit', 'bash', 'git']);
    const args = buildClaudeArgs(opts([], { tools }), '{}', 's.json');
    const deny = (flagOf(args, '--disallowedTools') ?? '').split(',');
    expect(deny).toContain('Bash(git push:*)');
    expect(flagOf(args, '--permission-prompt-tool')).toBe(PERMISSION_TOOL);
    expect(flagOf(args, '--allowedTools')).not.toMatch(/git push/);
  });

  it('ADR-0023: detects auto mode and --permission-prompts in claude --help', async () => {
    const real = [
      '  --permission-mode <mode>              Permission mode to use for the session',
      '                                        (choices: "acceptEdits", "auto",',
      '                                        "bypassPermissions", "manual",',
      '                                        "dontAsk", "plan")',
      '  --permission-prompts <target>         Who answers permission prompts with',
    ].join('\n');
    expect(permissionPromptSupport(real)).toEqual({ supported: true, reason: null });
    const noPrompts = real.split('\n').slice(0, 4).join('\n');
    expect(permissionPromptSupport(noPrompts)).toMatchObject({
      supported: false,
      reason: expect.stringContaining('--permission-prompts') as unknown,
    });
    const noAuto = real.replace('"auto",', '');
    expect(permissionPromptSupport(noAuto)).toMatchObject({
      supported: false,
      reason: expect.stringContaining('--permission-mode auto') as unknown,
    });
    expect(await probePermissionPrompts(FAKE)).toEqual({ supported: true, reason: null });
    expect((await probePermissionPrompts(join(dir, 'no-such-claude'))).supported).toBe(false);
  });

  it('uses --resume for resume, omits unset optionals and an empty deny list', () => {
    const o = opts([], {
      claudeSessionId: 'sid-2',
      resume: true,
      tools: { builtin: [], allow: [], deny: [] },
    });
    const args = buildClaudeArgs(o, '{}', 's.json');
    expect(
      args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ).toEqual(['--permission-mode', 'auto']); // ADR-0023: whatever the user's own mode
    expect(args.slice(6, 8)).toEqual(['--resume', 'sid-2']);
    expect(args).not.toContain('--session-id');
    for (const f of [
      '--model',
      '--max-turns',
      '--max-budget-usd',
      '--disallowedTools',
      '--append-system-prompt',
    ]) {
      expect(args).not.toContain(f);
    }
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 4)).toEqual([
      '--tools',
      '',
      '--allowedTools',
      `${COMPLETE_STATE_TOOL},${ASK_USER_TOOL}`,
    ]);
  });

  it('writes stream-json user messages', () => {
    expect(JSON.parse(userMessageLine('hi'))).toEqual({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
  });
});

describe('createCliDriver against fake-claude', () => {
  const driver = () =>
    createCliDriver({
      claudeBin: FAKE,
      outcomeServer: server,
      endGraceMs: 5_000,
      extraStateEnv: FAKE_ENV,
    });

  it('ADR-0011: an unknown transition is nudged once, then the named one is forwarded with its reason', async () => {
    const o = opts(
      [
        [
          { complete_state: { x: 1 }, transition: 'ship_it' },
          { complete_state: { x: 2 }, transition: 'plan_ready', reason: 'Plan done: $answer' },
        ],
      ],
      {
        prompt: 'go',
        transitions: [
          { name: 'plan_ready', when: 'The plan is complete.', question: false },
          { name: 'scope_changed', when: 'The scope changed.', question: true },
        ],
      },
    );
    const s = driver().start(o);
    const t = track(s);
    await t.turnEnds(1);
    expect(t.events.filter((e) => e.kind === 'complete_state')).toEqual([
      {
        kind: 'complete_state',
        result: { x: 2 },
        transition: 'plan_ready',
        reason: 'Plan done: go',
      },
    ]);
    expect(
      t.events.some(
        (e) =>
          e.kind === 'output' &&
          e.stream === 'tool_result' &&
          e.text.includes('"ship_it" is not a transition you can take here'),
      ),
    ).toBe(true);
  });

  it('ask_user → park → sendInput → complete_state → end() → exit 0', async () => {
    const o = opts([
      [{ say: 'Need a decision.' }, { ask_user: 'Which colour?' }],
      [{ complete_state: { colour: '$answer' } }],
    ]);
    const s = driver().start(o);
    const t = track(s);

    await t.turnEnds(1);
    expect(s.claudeSessionId).toBe(o.claudeSessionId);
    expect(s.cliVersion).toBe('9.9.9-fake'); // U-015: recorded from system/init
    expect(t.kinds()).toEqual(['claude_session_id', 'ask_user', 'spend', 'turn_end']);
    expect(t.events).toContainEqual({ kind: 'claude_session_id', id: o.claudeSessionId });
    expect(t.events).toContainEqual({ kind: 'ask_user', question: 'Which colour?' });
    expect(t.events).toContainEqual({
      kind: 'output',
      stream: 'assistant',
      text: 'Need a decision.',
    });
    expect(t.events).toContainEqual({
      kind: 'output',
      stream: 'debug',
      text: 'claude_code_version 9.9.9-fake',
    });
    expect(
      t.events.some(
        (e) => e.kind === 'output' && e.stream === 'tool_use' && e.text.startsWith(ASK_USER_TOOL),
      ),
    ).toBe(true);
    expect(
      t.events.some(
        (e) =>
          e.kind === 'output' && e.stream === 'tool_result' && e.text.includes('sent to a human'),
      ),
    ).toBe(true);

    // parked: alive and idle; the answer goes into the live process
    s.sendInput('green');
    await t.turnEnds(2);
    expect(t.kinds()).toEqual([
      'claude_session_id',
      'ask_user',
      'spend',
      'turn_end',
      'complete_state',
      'spend',
      'turn_end',
    ]);
    expect(t.events).toContainEqual({ kind: 'complete_state', result: { colour: 'green' } });
    const spends = t.events.filter((e) => e.kind === 'spend');
    expect(spends.map((e) => e.totalUsd)).toEqual([0.001, 0.002]); // cumulative
    expect(spends[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });

    s.end();
    expect(await t.exit()).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(server.size).toBe(0); // token dropped on exit
    expect(() => s.sendInput('late')).toThrow(/no live process/);

    // the spawn itself: exact flags, cwd, env merged over the daemon env
    const [first] = argvLog();
    const argAfter = (flag: string) => first?.argv[first.argv.indexOf(flag) + 1] ?? '';
    expect(first?.argv).toEqual(
      buildClaudeArgs(o, argAfter('--mcp-config'), argAfter('--settings')),
    );
    expect(first?.cwd).toBe(realpathSync(dir)); // macOS tmpdir is a symlink
    expect(first?.env.PORT).toBe('41000');
    expect(first?.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false'); // ADR-0006
  });

  it('ADR-0007: sendMessage is folded into the running turn (a slash command passes through)', async () => {
    const o = opts([
      [
        { say: 'working' },
        { await_message: true },
        { say: 'got $message' },
        { complete_state: { message: '$message' } },
      ],
    ]);
    const s = driver().start(o);
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'working');
    s.sendMessage('/context');
    await t.turnEnds(1);
    expect(t.events).toContainEqual({ kind: 'output', stream: 'assistant', text: 'got /context' });
    expect(t.events).toContainEqual({ kind: 'complete_state', result: { message: '/context' } });
    expect(t.events.filter((e) => e.kind === 'turn_end')).toHaveLength(1);
    s.end();
    await t.exit();
    expect(() => s.sendMessage('late')).toThrow(/no live process/);
  });

  it('ADR-0007: sendMessage is not an answer: a pending ask_user question stays pending', async () => {
    const o = opts([[{ ask_user: 'Which colour?' }], [{ complete_state: { colour: 'x' } }]]);
    const s = driver().start(o);
    const t = track(s);
    await t.turnEnds(1);
    s.sendMessage('what are you doing?');
    await t.turnEnds(2);
    // The outcome server refused the complete_state (question still pending), so none surfaced.
    expect(t.events.some((e) => e.kind === 'complete_state')).toBe(false);
    s.end();
    await t.exit();
  });

  it('ADR-0006: --settings is the edit-guard hook for the worktree, beside mcp.json, removed on exit', async () => {
    const o = opts([[{ say: 'up' }, { hang: true }]]);
    // a state env can't turn the claude.ai connectors back on
    const s = driver().start({ ...o, env: { ...o.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } });
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'up');

    const [spawned] = argvLog();
    expect(spawned?.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    const argv = spawned?.argv ?? [];
    const settingsPath = argv[argv.indexOf('--settings') + 1] ?? '';
    expect(dirname(settingsPath)).toBe(dirname(argv[argv.indexOf('--mcp-config') + 1] ?? ''));
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const [entry] = settings.hooks.PreToolUse;
    expect(entry?.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(entry?.hooks[0]?.command).toContain(`'${dir}'`);

    s.kill(1_000);
    await t.exit();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('ADR-0006: agentEnv passes only allowlisted state keys and pins connectors and safe mode off', () => {
    const state = {
      CONDUCTOR_SESSION_ID: 's1',
      CONDUCTOR_PORT_BASE: '41000',
      PORT: '41000',
      GIT_AUTHOR_NAME: 'conductor',
      GIT_COMMITTER_EMAIL: 'c@example.com',
      CLAUDE_CONFIG_DIR: '/tmp/other-claude',
      CLAUDE_CODE_SAFE_MODE: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
      ANTHROPIC_API_KEY: 'sk-test',
      HOME: '/tmp/fake-home',
      XDG_CONFIG_HOME: '/tmp/xdg',
      NODE_OPTIONS: '--require /tmp/evil.js',
      GIT_DIR: '/tmp/other.git',
      PATH: '/tmp/bin',
      FAKE_CLAUDE_SCENARIO: '[]',
    };
    const { env, dropped } = agentEnv(state);
    for (const k of [
      'CONDUCTOR_SESSION_ID',
      'CONDUCTOR_PORT_BASE',
      'PORT',
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      expect(env[k], k).toBe(state[k as keyof typeof state]);
    }
    // refused keys fall back to the daemon's own values (or stay unset)
    for (const k of [
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_API_KEY',
      'HOME',
      'XDG_CONFIG_HOME',
      'NODE_OPTIONS',
      'GIT_DIR',
      'PATH',
      'FAKE_CLAUDE_SCENARIO',
    ]) {
      expect(env[k], k).toBe(process.env[k]);
    }
    expect(env.CLAUDE_CODE_SAFE_MODE).toBe('0');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(dropped.sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_SAFE_MODE',
        'CLAUDE_CONFIG_DIR',
        'ENABLE_CLAUDEAI_MCP_SERVERS',
        'FAKE_CLAUDE_SCENARIO',
        'GIT_DIR',
        'HOME',
        'NODE_OPTIONS',
        'PATH',
        'XDG_CONFIG_HOME',
      ].sort(),
    );
    expect(agentEnv(state, /^FAKE_CLAUDE_/).env.FAKE_CLAUDE_SCENARIO).toBe('[]');
  });

  it('ADR-0006: logs the state env keys it dropped', async () => {
    const o = opts([[{ say: 'up' }, { hang: true }]]);
    const s = driver().start({ ...o, env: { ...o.env, NODE_OPTIONS: '--inspect' } });
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'up');
    expect(t.events).toContainEqual({
      kind: 'output',
      stream: 'debug',
      text: 'conductor: dropped state env keys not allowed: NODE_OPTIONS',
    });
    s.kill(1_000);
    await t.exit();
  });

  it('ADR-0006: caps the user defaultMode bypassPermissions to auto; leaves others alone', () => {
    const f = join(dir, 'settings.json');
    const write = (s: unknown) => writeFileSync(f, JSON.stringify(s));
    write({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(agentPermissionMode(f)).toBe('auto');
    for (const mode of ['auto', 'acceptEdits', 'default', undefined]) {
      write({ permissions: { defaultMode: mode } });
      expect(agentPermissionMode(f), String(mode)).toBeUndefined();
    }
    writeFileSync(f, '{not json');
    expect(agentPermissionMode(f)).toBeUndefined();
    expect(agentPermissionMode(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('M1-T14: the MCP URL token never appears in argv; it is in a 0600 file, removed on exit', async () => {
    const s = driver().start(opts([[{ say: 'up' }, { hang: true }]]));
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'up');

    const [spawned] = argvLog();
    const argv = spawned?.argv ?? [];
    const cfgPath = argv[argv.indexOf('--mcp-config') + 1] ?? '';
    const st = statSync(cfgPath);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(statSync(dirname(cfgPath)).mode & 0o777).toBe(0o700);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      mcpServers: { conductor: { url: string } };
    };
    const token = /\/mcp\/([a-f0-9]{32})$/.exec(cfg.mcpServers.conductor.url)?.[1] ?? '';
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    for (const arg of argv) {
      expect(arg).not.toContain(token);
      expect(arg).not.toContain('mcpServers');
    }

    s.kill(1_000);
    await t.exit();
    expect(existsSync(cfgPath)).toBe(false);
    expect(existsSync(dirname(cfgPath))).toBe(false);
  });

  it('resume continues the script and the cumulative spend (TD-001)', async () => {
    const scenario = {
      turns: [[{ ask_user: 'Name?' }], [{ complete_state: { name: '$answer' } }]],
      costPerTurnUsd: 0.25,
    };
    const first = opts(scenario);
    const a = driver().start(first);
    const ta = track(a);
    await ta.turnEnds(1);
    a.kill(1_000); // process gone while parked (e.g. daemon restart)
    expect((await ta.exit()).signal).toBe('SIGTERM');

    const b = driver().start({ ...first, resume: true, prompt: 'Ada' });
    const tb = track(b);
    await tb.turnEnds(1);
    expect(tb.events).toContainEqual({ kind: 'claude_session_id', id: first.claudeSessionId });
    expect(tb.events).toContainEqual({ kind: 'complete_state', result: { name: 'Ada' } });
    expect(tb.events.find((e) => e.kind === 'spend')).toMatchObject({ totalUsd: 0.5 });
    b.end();
    expect((await tb.exit()).code).toBe(0);
    expect(argvLog()[1]?.argv).toContain('--resume');
  });

  it('resume of an unknown session exits non-zero, like the real CLI', async () => {
    const s = driver().start(opts([], { resume: true }));
    const t = track(s);
    expect((await t.exit()).code).toBe(1);
    expect(
      t.events.some(
        (e) =>
          e.kind === 'output' && e.stream === 'stderr' && e.text.includes('No conversation found'),
      ),
    ).toBe(true);
  });

  it('kill(): SIGTERM first; SIGKILL after the grace period when SIGTERM is ignored (TD-003)', async () => {
    const s = driver().start(
      opts([[{ ignore_sigterm: true }, { say: 'stubborn' }, { hang: true }]]),
    );
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'stubborn');
    const t0 = Date.now();
    s.kill(300);
    const ev = await t.exit();
    expect(ev).toEqual({ kind: 'exit', code: null, signal: 'SIGKILL' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(server.size).toBe(0);
  });

  it('kill() of a cooperative process exits on SIGTERM and never escalates', async () => {
    const s = driver().start(opts([[{ say: 'busy' }, { hang: true }]]));
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'busy');
    s.kill(5_000);
    s.kill(5_000); // idempotent
    expect(await t.exit()).toEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });
  });

  it('end() escalates to kill when the process ignores stdin EOF', async () => {
    const d = createCliDriver({
      claudeBin: FAKE,
      outcomeServer: server,
      endGraceMs: 200,
      killGraceMs: 200,
      extraStateEnv: FAKE_ENV,
    });
    const s = d.start(opts([[{ ignore_sigterm: true }, { say: 'x' }, { hang: true }]]));
    const t = track(s);
    await t.waitFor((e) => e.kind === 'output' && e.text === 'x');
    s.end();
    expect((await t.exit()).signal).toBe('SIGKILL');
  });

  it('parses leniently: raw lines and stderr pass through, a crash still reports exit', async () => {
    const s = driver().start(
      opts([
        [
          { raw: 'garbage {' },
          { raw: '{"type":"rate_limit_event"}' },
          { stderr: 'warn\n' },
          { exit: 3 },
        ],
      ]),
    );
    const t = track(s);
    expect(await t.exit()).toEqual({ kind: 'exit', code: 3, signal: null });
    expect(t.events).toContainEqual({ kind: 'output', stream: 'debug', text: 'garbage {' });
    expect(t.events).toContainEqual({
      kind: 'output',
      stream: 'debug',
      text: '{"type":"rate_limit_event"}',
    });
    expect(
      t.events
        .filter((e) => e.kind === 'output' && e.stream === 'stderr')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toContain('warn');
    expect(t.kinds()).toEqual(['claude_session_id', 'exit']);
  });

  it('reports error turns and permission denials; refuses a guarded complete_state', async () => {
    const s = driver().start(
      opts([
        [
          { ask_user: 'Q?' },
          { complete_state: { early: true } },
          { denials: 2 },
          { error: 'error_max_turns' },
        ],
      ]),
    );
    const t = track(s);
    await t.turnEnds(1);
    expect(t.events.find((e) => e.kind === 'turn_end')).toEqual({
      kind: 'turn_end',
      isError: true,
      subtype: 'error_max_turns',
      permissionDenials: 2,
    });
    expect(t.kinds()).not.toContain('complete_state');
    s.end();
    await t.exit();
  });

  it('a missing binary yields stderr output and an exit event', async () => {
    const d = createCliDriver({
      claudeBin: join(dir, 'no-such-claude'),
      outcomeServer: server,
      extraStateEnv: FAKE_ENV,
    });
    const s = d.start(opts([]));
    const t = track(s);
    expect(await t.exit()).toEqual({ kind: 'exit', code: null, signal: null });
    expect(
      t.events.some(
        (e) => e.kind === 'output' && e.stream === 'stderr' && e.text.includes('ENOENT'),
      ),
    ).toBe(true);
    expect(server.size).toBe(0);
    expect(() => s.sendInput('x')).toThrow();
  });

  describe('ADR-0023 permission prompts', () => {
    const BASH = { tool_name: 'Bash', input: { command: 'pnpm i' }, tool_use_id: 'toolu_x' };
    const heldScenario = () => [[{ tool: 'permission', args: BASH }, { say: 'after' }]];
    const toolResult = (t: ReturnType<typeof track>) =>
      t.waitFor(
        (e) => e.kind === 'output' && e.stream === 'tool_result' && e.text.includes('behavior'),
      ) as Promise<Extract<DriverEvent, { kind: 'output' }>>;
    const prompt = (t: ReturnType<typeof track>) =>
      t.waitFor((e) => e.kind === 'permission_request') as Promise<
        Extract<DriverEvent, { kind: 'permission_request' }>
      >;

    it('a held call resolves on allow: Claude gets the input back', async () => {
      const s = driver().start(opts(heldScenario()));
      const t = track(s);
      const p = await prompt(t);
      expect(p).toMatchObject({ tool: 'Bash', input: { command: 'pnpm i' }, toolUseId: 'toolu_x' });
      // held: the turn does not go on until a decision
      await new Promise((r) => setTimeout(r, 100));
      expect(t.events.some((e) => e.kind === 'output' && e.text === 'after')).toBe(false);
      expect(s.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
        'resolved',
      );
      expect(JSON.parse((await toolResult(t)).text)).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'pnpm i' },
      });
      await t.turnEnds(1);
      expect(s.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
        'duplicate',
      );
      s.end();
      await t.exit();
    });

    it('a held call resolves on deny with the default text', async () => {
      const s = driver().start(opts(heldScenario()));
      const t = track(s);
      const p = await prompt(t);
      s.resolvePermission(p.requestId, { behavior: 'deny', scope: 'once' });
      expect(JSON.parse((await toolResult(t)).text)).toEqual({
        behavior: 'deny',
        message: PERMISSION_DENIED_ON_BOARD,
      });
      s.end();
      await t.exit();
    });

    it('a held call is denied at the timeout', async () => {
      const short = await startOutcomeServer({ permissionTimeoutMs: 200 });
      try {
        const s = createCliDriver({
          claudeBin: FAKE,
          outcomeServer: short,
          extraStateEnv: FAKE_ENV,
        }).start(opts(heldScenario()));
        const t = track(s);
        const p = await prompt(t);
        expect(JSON.parse((await toolResult(t)).text)).toEqual({
          behavior: 'deny',
          message: permissionTimeoutText(200),
        });
        expect(s.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
          'unknown',
        );
        s.end();
        await t.exit();
      } finally {
        await short.close();
      }
    });

    it('kill while held: the call is denied and the process exits', async () => {
      const s = driver().start(opts(heldScenario()));
      const t = track(s);
      const p = await prompt(t);
      s.kill(1_000);
      await t.exit();
      expect(s.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
        'unknown',
      );
      expect(s.denyPermission(p.requestId, PERMISSION_SESSION_ENDED)).toBe(false);
    });

    it('a worker announces auto mode; an old CLI falls back to the old flags with a warning', async () => {
      const s = driver().start(opts([[{ say: 'up' }]]));
      const t = track(s);
      await t.turnEnds(1);
      expect(t.events).toContainEqual({
        kind: 'output',
        stream: 'debug',
        text: 'conductor: running in auto mode; permission prompts go to the conductor board',
      });
      s.end();
      await t.exit();
      const old = createCliDriver({
        claudeBin: FAKE,
        outcomeServer: server,
        extraStateEnv: FAKE_ENV,
        permissionPrompts: false,
      }).start(opts([[{ say: 'up' }]]));
      const to = track(old);
      await to.turnEnds(1);
      expect(
        to.events.some(
          (e) => e.kind === 'output' && e.stream === 'debug' && e.text.includes('old flags'),
        ),
      ).toBe(true);
      old.end();
      await to.exit();
      const [, second] = argvLog();
      const argv = second?.argv ?? [];
      expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none');
      expect(argv).not.toContain('--permission-prompt-tool');
      const legacy = agentPermissionMode();
      expect(argv.includes('--permission-mode')).toBe(legacy !== undefined);
    });
  });

  it('defaults claudeBin to $CONDUCTOR_CLAUDE_BIN', async () => {
    const prev = process.env.CONDUCTOR_CLAUDE_BIN;
    process.env.CONDUCTOR_CLAUDE_BIN = FAKE;
    try {
      const s = createCliDriver({ outcomeServer: server, extraStateEnv: FAKE_ENV }).start(
        opts([[{ say: 'env bin' }]]),
      );
      const t = track(s);
      await t.turnEnds(1);
      s.end();
      expect((await t.exit()).code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.CONDUCTOR_CLAUDE_BIN;
      else process.env.CONDUCTOR_CLAUDE_BIN = prev;
    }
  });
});
