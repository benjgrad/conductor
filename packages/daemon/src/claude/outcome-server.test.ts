import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASK_USER_AFTER_COMPLETE,
  ASK_USER_PENDING_QUESTION,
  ASK_USER_RETURN,
  COMPLETE_STATE_DUPLICATE,
  COMPLETE_STATE_PENDING_QUESTION,
  COMPLETE_STATE_RETURN,
  OUTCOME_SERVER_NAME,
  PERMISSION_DENIED_ON_BOARD,
  PERMISSION_NO_HANDLER,
  PERMISSION_SESSION_ENDED,
  PERMISSION_SHUTDOWN,
  PERMISSION_UNSUPPORTED_SERVER,
  parsePermissionRule,
  permissionTimeoutText,
  permissionTooLargeText,
  startOutcomeServer,
  unknownTransitionText,
  type OutcomeRegisterOptions,
  type OutcomeServer,
  type PermissionPrompt,
} from './outcome-server.js';
import { PERMISSION_INPUT_MAX_BYTES, PERMISSION_SUGGESTIONS_MAX } from '@conductor/shared';

type Call =
  | { kind: 'ask'; question: string }
  | { kind: 'done'; result: Record<string, unknown>; transition?: string; reason?: string };

let server: OutcomeServer;

beforeEach(async () => {
  server = await startOutcomeServer();
});
afterEach(async () => {
  await server.close();
});

function register(opts?: OutcomeRegisterOptions) {
  const calls: Call[] = [];
  const reg = server.register(
    {
      onAskUser: (question) => calls.push({ kind: 'ask', question }),
      onCompleteState: (result, meta) => calls.push({ kind: 'done', result, ...meta }),
    },
    opts,
  );
  return { reg, calls };
}

// A minimal MCP client over plain JSON-RPC POSTs. The SDK client pulls in eventsource-parser,
// whose "source" export condition points vitest at .ts under node_modules, which it can't load.
// (The real SDK client is exercised by fake-claude.mjs in cli-driver.test.ts.)
interface RpcResult {
  result?: {
    tools?: { name: string; description?: string }[];
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}
interface Client {
  listTools(): Promise<{ tools: { name: string; description?: string }[] }>;
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: { text: string }[]; isError: boolean }>;
}

let rpcId = 0;
async function connect(url: string): Promise<Client> {
  const rpc = async (method: string, params?: Record<string, unknown>): Promise<RpcResult> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as RpcResult;
  };
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  expect(init.error).toBeUndefined();
  return {
    async listTools() {
      const r = await rpc('tools/list');
      return { tools: r.result?.tools ?? [] };
    },
    async callTool(req) {
      const r = await rpc('tools/call', req);
      if (r.error) return { content: [{ text: r.error.message }], isError: true };
      return { content: r.result?.content ?? [], isError: r.result?.isError === true };
    },
  };
}

async function callText(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError).toBe(false);
  return r.content.map((x) => x.text).join('');
}

function rawRequest(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method, headers: init.headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

describe('outcome server', () => {
  it('binds 127.0.0.1 and issues a 128-bit path token per session', () => {
    const a = register().reg;
    const b = register().reg;
    expect(server.host).toBe('127.0.0.1');
    expect(a.token).toMatch(/^[a-f0-9]{32}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.url).toBe(`http://127.0.0.1:${server.port}/mcp/${a.token}`);
    expect(JSON.parse(a.mcpConfig)).toEqual({
      mcpServers: { [OUTCOME_SERVER_NAME]: { type: 'http', url: a.url } },
    });
  });

  it('lists exactly complete_state, ask_user and (ADR-0023) permission', async () => {
    const c = await connect(register().reg.url);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_user', 'complete_state', 'permission']);
  });

  it('ask_user returns at once with the ADR text; complete_state after the answer records', async () => {
    const { reg, calls } = register();
    const c = await connect(reg.url);
    expect(await callText(c, 'ask_user', { question: 'Which?' })).toBe(ASK_USER_RETURN);
    expect(reg.questionPending).toBe(true);
    expect(calls).toEqual([{ kind: 'ask', question: 'Which?' }]);

    // guard: complete_state while a question is pending is refused and not emitted
    expect(await callText(c, 'complete_state', { result: { x: 1 } })).toBe(
      COMPLETE_STATE_PENDING_QUESTION,
    );
    // guard: a second question while one is pending
    expect(await callText(c, 'ask_user', { question: 'Again?' })).toBe(ASK_USER_PENDING_QUESTION);
    expect(calls).toHaveLength(1);

    reg.answered();
    expect(await callText(c, 'complete_state', { result: { x: 1 } })).toBe(COMPLETE_STATE_RETURN);
    expect(calls).toEqual([
      { kind: 'ask', question: 'Which?' },
      { kind: 'done', result: { x: 1 } },
    ]);

    // guards: duplicate complete_state, ask after complete
    expect(await callText(c, 'complete_state', { result: { x: 2 } })).toBe(
      COMPLETE_STATE_DUPLICATE,
    );
    expect(await callText(c, 'ask_user', { question: 'Late?' })).toBe(ASK_USER_AFTER_COMPLETE);
    expect(calls).toHaveLength(2);
  });

  it('attributes calls to the session that owns the token', async () => {
    const a = register();
    const b = register();
    const cb = await connect(b.reg.url);
    await callText(cb, 'complete_state', { result: { who: 'b' } });
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([{ kind: 'done', result: { who: 'b' } }]);
  });

  it('rejects invalid arguments without emitting', async () => {
    const { reg, calls } = register();
    const c = await connect(reg.url);
    const r = await c.callTool({ name: 'ask_user', arguments: { question: '' } });
    expect(r.isError).toBe(true);
    const r2 = await c.callTool({ name: 'complete_state', arguments: { result: 'nope' } });
    expect(r2.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('404s unknown and unregistered tokens, 405s non-POST, 403s foreign Host headers', async () => {
    const { reg } = register();
    const base = `http://127.0.0.1:${server.port}`;
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    expect(await rawRequest(`${base}/mcp/${'0'.repeat(32)}`, init)).toBe(404);
    expect(await rawRequest(`${base}/mcp/not-a-token`, init)).toBe(404);
    expect(await rawRequest(`${base}/`, init)).toBe(404);
    expect(await rawRequest(reg.url, { method: 'GET' })).toBe(405);
    expect(
      await rawRequest(reg.url, {
        ...init,
        headers: { ...init.headers, host: `evil.example:${server.port}` },
      }),
    ).toBe(403);

    expect(server.size).toBe(1);
    reg.unregister();
    reg.unregister(); // idempotent
    expect(server.size).toBe(0);
    expect(await rawRequest(reg.url, init)).toBe(404);
  });

  describe('ADR-0011 transitions', () => {
    const TRANSITIONS = [
      { name: 'plan_ready', when: 'The plan is complete.', question: false },
      { name: 'scope_changed', when: 'The scope changed.', question: true },
    ];

    it('emits a valid name with its reason', async () => {
      const { reg, calls } = register({ transitions: TRANSITIONS });
      const c = await connect(reg.url);
      expect(
        await callText(c, 'complete_state', {
          transition: 'scope_changed',
          reason: 'Is the new dependency OK?',
          result: {},
        }),
      ).toBe(COMPLETE_STATE_RETURN);
      expect(calls).toEqual([
        {
          kind: 'done',
          result: {},
          transition: 'scope_changed',
          reason: 'Is the new dependency OK?',
        },
      ]);
    });

    it('refuses an unknown name once with the allowed list, then emits the next one as is', async () => {
      const { reg, calls } = register({ transitions: TRANSITIONS });
      const c = await connect(reg.url);
      const nudge = await callText(c, 'complete_state', { transition: 'shipit', result: {} });
      expect(nudge).toBe(unknownTransitionText('shipit', TRANSITIONS));
      expect(nudge).toContain('- plan_ready: The plan is complete.');
      expect(nudge).toContain('- scope_changed: The scope changed.');
      expect(calls).toEqual([]);
      expect(reg.completed).toBe(false);
      // The second unknown name goes through; the engine routes it to a human.
      expect(
        await callText(c, 'complete_state', { transition: 'yolo', reason: 'r', result: {} }),
      ).toBe(COMPLETE_STATE_RETURN);
      expect(calls).toEqual([{ kind: 'done', result: {}, transition: 'yolo', reason: 'r' }]);
    });

    it('a missing transition means done: nudged when done is not allowed', async () => {
      const { reg, calls } = register({ transitions: TRANSITIONS });
      const c = await connect(reg.url);
      expect(await callText(c, 'complete_state', { result: {} })).toContain('named no transition');
      expect(await callText(c, 'complete_state', { transition: 'plan_ready', result: {} })).toBe(
        COMPLETE_STATE_RETURN,
      );
      expect(calls).toEqual([{ kind: 'done', result: {}, transition: 'plan_ready' }]);
    });

    it('no list (old workflows, reviewers): any name passes', async () => {
      for (const opts of [undefined, { transitions: [] }]) {
        const { reg, calls } = register(opts);
        const c = await connect(reg.url);
        expect(
          await callText(c, 'complete_state', { transition: 'anything', result: { a: 1 } }),
        ).toBe(COMPLETE_STATE_RETURN);
        expect(calls).toEqual([{ kind: 'done', result: { a: 1 }, transition: 'anything' }]);
      }
    });

    it('the tool description lists the transitions', async () => {
      const c = await connect(register({ transitions: TRANSITIONS }).reg.url);
      const { tools } = await c.listTools();
      const d = tools.find((t) => t.name === 'complete_state')?.description ?? '';
      expect(d).toContain('- plan_ready: The plan is complete.');
      expect(d).toContain('- scope_changed: The scope changed. (a question');
      const plain = await connect(register().reg.url);
      const d2 = (await plain.listTools()).tools.find((t) => t.name === 'complete_state');
      expect(d2?.description).not.toContain('Allowed transitions');
    });

    it('caps transition and reason at the tool call', async () => {
      const { reg, calls } = register({ transitions: TRANSITIONS });
      const c = await connect(reg.url);
      const r = await c.callTool({
        name: 'complete_state',
        arguments: { transition: 'x'.repeat(101), result: {} },
      });
      expect(r.isError).toBe(true);
      expect(calls).toEqual([]);
    });
  });
});

describe('ADR-0023 permission tool', () => {
  let srv: OutcomeServer | undefined;
  afterEach(async () => {
    const s = srv;
    srv = undefined;
    await s?.close();
  });

  async function setup(opts: { timeoutMs?: number; noHandler?: boolean } = {}) {
    const server = await startOutcomeServer(
      opts.timeoutMs !== undefined ? { permissionTimeoutMs: opts.timeoutMs } : {},
    );
    srv = server;
    const prompts: PermissionPrompt[] = [];
    const reg = server.register({
      onAskUser: () => {},
      onCompleteState: () => {},
      ...(opts.noHandler ? {} : { onPermissionRequest: (p: PermissionPrompt) => prompts.push(p) }),
    });
    const c = await connect(reg.url);
    /** Start a held call; resolves with the parsed reply when it returns. */
    const ask = (args: Record<string, unknown>) =>
      callText(c, 'permission', args).then((t) => JSON.parse(t) as Record<string, unknown>);
    const nextPrompt = async (n = 1) => {
      for (let i = 0; i < 200 && prompts.length < n; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(prompts.length).toBeGreaterThanOrEqual(n);
      return prompts[n - 1]!;
    };
    return { server, reg, prompts, ask, nextPrompt };
  }

  const BASH = {
    tool_name: 'Bash',
    input: { command: 'pnpm exec tsc -b' },
    tool_use_id: 'toolu_1',
  };

  it('holds the call until allow once: Claude gets the input back', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const t0 = Date.now();
    const reply = ask(BASH);
    const p = await nextPrompt();
    expect(p).toMatchObject({ tool: 'Bash', input: BASH.input, toolUseId: 'toolu_1' });
    expect(p.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // expires_at = now + the default 30 min
    const exp = Date.parse(p.expiresAt) - t0;
    expect(exp).toBeGreaterThan(29 * 60_000);
    expect(exp).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    expect(reg.pendingPermissions).toBe(1);
    expect(reg.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
      'resolved',
    );
    expect(await reply).toEqual({ behavior: 'allow', updatedInput: BASH.input });
    expect(reg.pendingPermissions).toBe(0);
    // A second decision for the same request: accepted and ignored. Unknown ids: refused.
    expect(reg.resolvePermission(p.requestId, { behavior: 'deny', scope: 'once' })).toBe(
      'duplicate',
    );
    expect(
      reg.resolvePermission('00000000-0000-4000-8000-000000000000', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe('unknown');
  });

  it('allow always with a rule adds a session rule so this process does not ask again', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const reply = ask(BASH);
    const p = await nextPrompt();
    reg.resolvePermission(p.requestId, {
      behavior: 'allow',
      scope: 'always',
      rule: 'Bash(pnpm exec tsc -b)',
    });
    expect(await reply).toEqual({
      behavior: 'allow',
      updatedInput: BASH.input,
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm exec tsc -b' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
  });

  it('deny: the human note, or the default text', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const r1 = ask(BASH);
    const p1 = await nextPrompt(1);
    reg.resolvePermission(p1.requestId, {
      behavior: 'deny',
      scope: 'once',
      message: '  use pnpm typecheck  ',
    });
    expect(await r1).toEqual({
      behavior: 'deny',
      message: 'Permission denied by a human on the board: use pnpm typecheck',
    });
    const r2 = ask(BASH);
    const p2 = await nextPrompt(2);
    reg.resolvePermission(p2.requestId, { behavior: 'deny', scope: 'once' });
    expect(await r2).toEqual({ behavior: 'deny', message: PERMISSION_DENIED_ON_BOARD });
  });

  it('denies itself at the timeout; a later decision is unknown', async () => {
    const { reg, ask, nextPrompt } = await setup({ timeoutMs: 150 });
    const reply = ask(BASH);
    const p = await nextPrompt();
    expect(await reply).toEqual({ behavior: 'deny', message: permissionTimeoutText(150) });
    expect(permissionTimeoutText(30 * 60_000)).toContain('no human answered within 30 min');
    expect(reg.resolvePermission(p.requestId, { behavior: 'allow', scope: 'once' })).toBe(
      'unknown',
    );
  });

  it('U-101: input over 64 KiB is denied at once and never sent', async () => {
    const { prompts, ask } = await setup();
    const input = { content: 'x'.repeat(PERMISSION_INPUT_MAX_BYTES) };
    const bytes = Buffer.byteLength(JSON.stringify(input));
    expect(await ask({ tool_name: 'Write', input })).toEqual({
      behavior: 'deny',
      message: permissionTooLargeText(bytes),
    });
    expect(permissionTooLargeText(bytes)).toContain(`input too large to review (${bytes} bytes)`);
    expect(prompts).toEqual([]);
  });

  it('passes suggestions within bounds, drops them over the bounds', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const one = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' }];
    const r1 = ask({ ...BASH, permission_suggestions: one });
    const p1 = await nextPrompt(1);
    expect(p1.suggestions).toEqual(one);
    reg.resolvePermission(p1.requestId, { behavior: 'allow', scope: 'once' });
    await r1;
    const many = Array.from({ length: PERMISSION_SUGGESTIONS_MAX + 1 }, () => one[0]);
    const r2 = ask({ ...BASH, permission_suggestions: many });
    const p2 = await nextPrompt(2);
    expect(p2.suggestions).toBeUndefined();
    const big = [{ type: 'x', pad: 'y'.repeat(17 * 1024) }];
    const r3 = ask({ ...BASH, permission_suggestions: big });
    const p3 = await nextPrompt(3);
    expect(p3.suggestions).toBeUndefined();
    reg.resolvePermission(p2.requestId, { behavior: 'allow', scope: 'once' });
    reg.resolvePermission(p3.requestId, { behavior: 'allow', scope: 'once' });
    await Promise.all([r2, r3]);
  });

  it('denyPermission (an old server) denies the held call at once', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const reply = ask(BASH);
    const p = await nextPrompt();
    expect(reg.denyPermission(p.requestId, PERMISSION_UNSUPPORTED_SERVER)).toBe(true);
    expect(await reply).toEqual({ behavior: 'deny', message: PERMISSION_UNSUPPORTED_SERVER });
    expect(reg.denyPermission(p.requestId, 'again')).toBe(false);
  });

  it('unregister (process gone) denies every held call; later prompts too', async () => {
    const { reg, ask, nextPrompt } = await setup();
    const a = ask(BASH);
    const b = ask({ ...BASH, tool_use_id: 'toolu_2' });
    await nextPrompt(2);
    // The registration is gone, but the in-flight HTTP responses still carry the deny.
    reg.unregister();
    expect(await a).toEqual({ behavior: 'deny', message: PERMISSION_SESSION_ENDED });
    expect(await b).toEqual({ behavior: 'deny', message: PERMISSION_SESSION_ENDED });
  });

  it('close (daemon shutdown) denies every held call', async () => {
    const { server, ask, nextPrompt } = await setup();
    const a = ask(BASH);
    await nextPrompt();
    srv = undefined;
    const closed = server.close();
    expect(await a).toEqual({ behavior: 'deny', message: PERMISSION_SHUTDOWN });
    await closed;
  });

  it('no handler: denied at once', async () => {
    const { ask } = await setup({ noHandler: true });
    expect(await ask(BASH)).toEqual({ behavior: 'deny', message: PERMISSION_NO_HANDLER });
  });

  it('parses exact rules into toolName / ruleContent', () => {
    expect(parsePermissionRule('Bash(git status)')).toEqual({
      toolName: 'Bash',
      ruleContent: 'git status',
    });
    expect(parsePermissionRule('Bash(echo (a))')).toEqual({
      toolName: 'Bash',
      ruleContent: 'echo (a)',
    });
    expect(parsePermissionRule('WebFetch')).toEqual({ toolName: 'WebFetch' });
  });
});
