import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { RequestAuth } from '../auth/middleware.js';
import { lastTicketKind } from '../api/tickets.js';
import {
  clampWindow,
  ROW_LIMIT,
  WINDOW_DEFAULT_DAYS,
  WINDOW_MAX_DAYS,
} from '../advisor/queries.js';
import {
  buildMcpServer,
  FINDINGS_PAGE,
  frictionReport,
  REPORT_FRICTIONS_MAX,
  REPORT_IDS_MAX,
  MCP_INSTRUCTIONS,
  WORKFLOW_ADVISOR_PROMPT,
  guard,
  pageOf,
  transcriptPage,
  type ToolDeps,
} from './tools.js';

describe('guard', () => {
  it('turns a throw into conductor’s JSON tool error', async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const res = await guard('get_ticket', () => Promise.reject(new Error('boom')))();
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ error: { code: 'internal' } });
    } finally {
      console.error = quiet;
    }
  });
});

describe('pageOf', () => {
  it('pages by characters and ends with next_cursor null', () => {
    expect(pageOf('abcdef', 0, 4)).toEqual({
      text: 'abcd',
      cursor: 0,
      next_cursor: 4,
      total_chars: 6,
    });
    expect(pageOf('abcdef', 4, 4)).toMatchObject({ text: 'ef', next_cursor: null });
    expect(pageOf('abc', 99, 4)).toMatchObject({ text: '', cursor: 3, next_cursor: null });
  });
});

describe('transcriptPage', () => {
  const at = '2026-11-03T10:00:00.000Z';
  it('returns the newest messages first, oldest first within a page', () => {
    const chunks = Array.from({ length: 4 }, (_, i) => ({
      stream: i % 2 ? 'assistant' : 'user',
      text: String(i).repeat(2500),
      ts: at,
    }));
    const first = transcriptPage(chunks, 0);
    expect(first.messages.map((m) => m.text[0])).toEqual(['2', '3']);
    expect(first.next_cursor).toBe(2);
    const second = transcriptPage(chunks, 2);
    expect(second.messages.map((m) => m.text[0])).toEqual(['0', '1']);
    expect(second.next_cursor).toBeNull();
  });
});

describe('MCP_INSTRUCTIONS', () => {
  it('fits ADR-0014’s 600 characters and names the core tools', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    for (const t of ['get_ticket', 'message_agent', 'get_ticket_artifacts', 'wait_for_updates']) {
      expect(MCP_INSTRUCTIONS).toContain(t);
    }
  });
});

describe('clampWindow (ADR-0033)', () => {
  it('defaults, rounds and clamps to 1..180 days', () => {
    expect(clampWindow(undefined)).toBe(WINDOW_DEFAULT_DAYS);
    expect(clampWindow(Number.NaN)).toBe(WINDOW_DEFAULT_DAYS);
    expect(clampWindow(0)).toBe(1);
    expect(clampWindow(-5)).toBe(1);
    expect(clampWindow(7.4)).toBe(7);
    expect(clampWindow(10_000)).toBe(WINDOW_MAX_DAYS);
  });
});

/**
 * The advisor tools over a real MCP client and server joined in memory (no HTTP, no Postgres):
 * the database is a stub that records each query and answers with canned rows.
 */
async function connectAdvisor(
  rows: (sql: string) => Record<string, unknown>[] = () => [],
  extraDeps: Record<string, unknown> = {},
) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = {
    query: (sql: string, args: unknown[] = []) => {
      queries.push({ sql, args });
      return Promise.resolve({ rows: rows(sql) });
    },
  };
  const who = {
    user: { id: 'u1', email: 'ben@example.com', is_admin: false },
    account: { id: 'acc-1', name: 'Ben' },
    scope: { account_id: 'acc-1' },
    mode: 'password',
    sessionIdHash: null,
  } as unknown as RequestAuth;
  const server = buildMcpServer({ db, ...extraDeps } as unknown as ToolDeps, who);
  const client = new Client({ name: 'unit', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, queries };
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (res.content as { type: string; text: string }[])[0]!.text;

describe('advisor tools (ADR-0033)', () => {
  it('lists the advisor tools last, after every earlier tool', async () => {
    const { client } = await connectAdvisor();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.slice(-7)).toEqual([
      'get_process_metrics',
      'list_findings',
      'get_process_report',
      'get_insight',
      'propose_change',
      'list_change_proposals',
      'apply_change',
    ]);
    expect(names.slice(-9, -7)).toEqual(['adopt_default_workflow', 'simulate_workflow']);
    for (const t of (await client.listTools()).tools.slice(-7, -3)) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description!.length).toBeLessThanOrEqual(700);
    }
  });

  it('scopes every query to the token’s account and clamps the window', async () => {
    const { client, queries } = await connectAdvisor();
    const now = Date.now();
    const res = await client.callTool({
      name: 'get_process_metrics',
      arguments: { window_days: 9999, repo: 'github.com/acme/app' },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res)) as { window_days: number; since: string; groups: [] };
    expect(body.window_days).toBe(WINDOW_MAX_DAYS);
    expect(body.groups).toEqual([]);
    const sinceDays = (now - Date.parse(body.since)) / 86_400_000;
    expect(Math.round(sinceDays)).toBe(WINDOW_MAX_DAYS);
    // The five row queries (ADR-0037 P4 adds the holds), then the account's repo check overrides
    // (to name the check runs), then the machines' names (R13).
    expect(queries).toHaveLength(7);
    const machines = queries.filter((q) => q.sql.includes('FROM machine '));
    expect(machines).toHaveLength(1);
    expect(machines[0]!.sql).toContain('account_id = $1');
    expect(machines[0]!.args).toEqual(['acc-1']);
    const named = queries.filter((q) => q.sql.includes('FROM repo_checks'));
    expect(named).toHaveLength(1);
    expect(named[0]!.sql).toContain('account_id = $1');
    expect(named[0]!.args).toEqual(['acc-1']);
    for (const q of queries.filter(
      (x) => !x.sql.includes('FROM repo_checks') && !x.sql.includes('FROM machine '),
    )) {
      expect(q.sql).toContain('s.account_id = $1');
      expect(q.args).toEqual([
        'acc-1',
        expect.any(Date),
        'github.com/acme/app',
        null,
        ROW_LIMIT,
        null,
        null,
      ]);
    }
  });

  it('pages findings by cursor and stays under the 8 KB cap', async () => {
    // Twenty failing checks: twenty findings, three pages.
    const at = new Date('2026-11-01T00:00:00Z');
    const checks = Array.from({ length: 20 }, (_, i) =>
      Array.from({ length: 3 }, (_, k) => ({
        session_id: `s${i}-${k}`,
        ticket_id: `t${i}-${k}`,
        repo: 'github.com/acme/app',
        machine_id: 'm1',
        state: 'implementing',
        cmd: `npm run check-${i} ${'x'.repeat(200)}`,
        exit_code: 1,
        timed_out: false,
        setup_failed: false,
        started_at: at,
        ts: at,
      })),
    ).flat();
    const { client } = await connectAdvisor((sql) =>
      sql.includes('command.exited') ? checks : [],
    );
    const first = await client.callTool({ name: 'list_findings', arguments: {} });
    const text = textOf(first);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    const page = JSON.parse(text) as {
      findings: { id: string }[];
      next_cursor: number;
      total: number;
    };
    expect(page.total).toBe(20);
    expect(page.findings).toHaveLength(FINDINGS_PAGE);
    expect(page.next_cursor).toBe(FINDINGS_PAGE);
    const last = JSON.parse(
      textOf(await client.callTool({ name: 'list_findings', arguments: { cursor: 16 } })),
    ) as { findings: unknown[]; next_cursor: number | null };
    expect(last.findings).toHaveLength(4);
    expect(last.next_cursor).toBeNull();
  });

  it('serves the workflow_advisor prompt with the change-management rules', async () => {
    const { client } = await connectAdvisor();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['workflow_advisor']);
    const got = await client.getPrompt({ name: 'workflow_advisor' });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toBe(WORKFLOW_ADVISOR_PROMPT);
    for (const must of [
      'get_process_metrics',
      'list_findings',
      'get_process_report',
      'get_insight',
      'propose_change',
      'apply_change',
      'list_change_proposals',
      'base_version',
      'approval',
    ]) {
      expect(text).toContain(must);
    }
    expect(MCP_INSTRUCTIONS).toContain('workflow_advisor');
  });
});

describe('change-proposal tools (ADR-0033 P3)', () => {
  it('only apply_change is destructive, and it needs confirm: true', async () => {
    const { client, queries } = await connectAdvisor();
    const tools = (await client.listTools()).tools.slice(-3);
    expect(
      tools.map((t) => [t.name, t.annotations?.readOnlyHint, t.annotations?.destructiveHint]),
    ).toEqual([
      ['propose_change', false, false],
      ['list_change_proposals', true, undefined],
      ['apply_change', false, true],
    ]);
    for (const t of tools) expect(t.description!.length).toBeLessThanOrEqual(200);
    const id = '00000000-0000-4000-8000-000000000001';
    const res = await client.callTool({ name: 'apply_change', arguments: { id } });
    expect(res.isError).toBe(true);
    const no = await client.callTool({ name: 'apply_change', arguments: { id, confirm: false } });
    expect(no.isError).toBe(true);
    expect(queries).toEqual([]);
  });

  it('propose_change validates before touching the database', async () => {
    const { client, queries } = await connectAdvisor();
    const res = await client.callTool({
      name: 'propose_change',
      arguments: {
        title: 't',
        change: { kind: 'machine_settings', permission_mode: 'bypassPermissions' },
        rationale: 'r',
        evidence: [{ text: 'e' }],
        expected_effect: { metric: 'questions', direction: 'down', text: 'x' },
        rollback: 'r',
      },
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(textOf(res)) as {
      error: { code: string; details: { path: string }[] };
    };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.details.some((d) => d.path.startsWith('change'))).toBe(true);
    expect(queries).toEqual([]);
  });

  it('list_change_proposals pages the account’s proposals', async () => {
    const { client, queries } = await connectAdvisor((sql) =>
      sql.includes('count(*)') ? [{ n: 0 }] : [],
    );
    const res = await client.callTool({
      name: 'list_change_proposals',
      arguments: { status: 'proposed' },
    });
    expect(JSON.parse(textOf(res))).toEqual({ proposals: [], next_cursor: null, total: 0 });
    for (const q of queries) expect(q.args.slice(0, 2)).toEqual(['acc-1', 'proposed']);
    const missing = await client.callTool({
      name: 'list_change_proposals',
      arguments: { id: 'nope' },
    });
    expect(JSON.parse(textOf(missing))).toMatchObject({ error: { code: 'not_found' } });
  });
});

// ADR-0033 P2: the analysts' insights over MCP.

const insightOf = (i: number, frictions: { category: string; state: string | null }[]) => ({
  session_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  ticket_id: `t${i}`,
  insight: {
    schema_version: 1,
    summary: `Session ${i} ${'x'.repeat(300)}`,
    outcome: 'completed',
    frictions: frictions.map((f) => ({
      ...f,
      evidence: 'e'.repeat(120),
      severity: 2,
      suggestion: 's'.repeat(120),
    })),
    wasted_minutes: 5,
  },
});

describe('frictionReport', () => {
  it('groups by category and state, most sessions first, with capped ids', () => {
    const insights = [
      ...Array.from({ length: 5 }, (_, i) =>
        insightOf(i, [{ category: 'flaky_check', state: 'qa' }]),
      ),
      insightOf(9, [{ category: 'environment', state: null }]),
    ] as Parameters<typeof frictionReport>[0];
    const r = frictionReport(insights);
    expect(r.analysed).toBe(6);
    expect(r.outcomes).toEqual({ completed: 6 });
    expect(r.wasted_minutes_reported).toBe(30);
    expect(r.frictions.map((f) => [f.category, f.state, f.sessions])).toEqual([
      ['flaky_check', 'qa', 5],
      ['environment', null, 1],
    ]);
    expect(r.frictions[0]!.session_ids).toHaveLength(REPORT_IDS_MAX);
    expect(r.frictions[0]!.top_suggestion.length).toBeLessThanOrEqual(200);
  });
});

describe('analyst tools (ADR-0033 P2)', () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    insightOf(
      i,
      Array.from({ length: 8 }, (_, k) => ({ category: 'other', state: `state_${(i + k) % 40}` })),
    ),
  );
  const rows = (enabled: boolean) => (sql: string) => {
    if (sql.includes('SELECT i.session_id, i.ticket_id, i.insight')) return many;
    if (sql.includes('count(*) AS finished')) return [{ finished: '400', analysed: '300' }];
    if (sql.includes('ANY (features)')) return enabled ? [{}] : [];
    return [];
  };

  it('get_process_report stays under 8 KB, scoped, and says when insights are off', async () => {
    const { client, queries } = await connectAdvisor(rows(false));
    const res = await client.callTool({
      name: 'get_process_report',
      arguments: { window_days: 0 },
    });
    const text = textOf(res);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    const body = JSON.parse(text) as {
      window_days: number;
      insights_enabled: boolean;
      note?: string;
      finished_sessions: number;
      analysed_sessions: number;
      frictions: unknown[];
      more_frictions: number;
    };
    expect(body.window_days).toBe(1);
    expect(body.insights_enabled).toBe(false);
    expect(body.note).toContain('Rust daemon');
    expect(body).toMatchObject({ finished_sessions: 400, analysed_sessions: 300 });
    expect(body.frictions).toHaveLength(REPORT_FRICTIONS_MAX);
    expect(body.more_frictions).toBe(30);
    for (const q of queries) expect(q.args[0]).toBe('acc-1');
  });

  it('get_process_report has no note once a machine runs analyst jobs', async () => {
    const { client } = await connectAdvisor(rows(true));
    const body = JSON.parse(
      textOf(await client.callTool({ name: 'get_process_report', arguments: {} })),
    ) as { insights_enabled: boolean; note?: string };
    expect(body.insights_enabled).toBe(true);
    expect(body.note).toBeUndefined();
  });

  it('list_findings merges recurring frictions from the insights', async () => {
    const { client } = await connectAdvisor(rows(true));
    const page = JSON.parse(
      textOf(await client.callTool({ name: 'list_findings', arguments: {} })),
    ) as { findings: { id: string; category: string }[]; total: number };
    expect(page.total).toBe(40);
    expect(page.findings.every((f) => f.category === 'recurring_friction')).toBe(true);
    expect(page.findings[0]!.id).toMatch(/^recurring_friction:other:state_\d+$/);
  });

  it('get_insight returns one account-scoped insight, labelled model-written', async () => {
    const one = insightOf(1, [{ category: 'rework', state: 'implementing' }]);
    const { client, queries } = await connectAdvisor((sql) =>
      sql.includes('WHERE i.session_id = $1')
        ? [{ ...one, created_at: new Date('2026-11-01T00:00:00Z'), model: 'haiku' }]
        : [],
    );
    const res = await client.callTool({
      name: 'get_insight',
      arguments: { session_id: one.session_id },
    });
    const body = JSON.parse(textOf(res)) as { model_written: boolean; outcome: string };
    expect(body).toMatchObject({ model_written: true, outcome: 'completed', model: 'haiku' });
    expect(queries[0]!.args).toEqual([one.session_id, 'acc-1', 1]);
    const missing = await connectAdvisor();
    const nf = await missing.client.callTool({
      name: 'get_insight',
      arguments: { session_id: one.session_id },
    });
    expect(nf.isError).toBe(true);
  });
});

describe('create_ticket kind default (WF-T03)', () => {
  const stub = (kind: string | null) => {
    const queries: { sql: string; args: unknown[] }[] = [];
    const q = {
      query: (sql: string, args: unknown[] = []) => {
        queries.push({ sql, args });
        return Promise.resolve({ rows: kind === null ? [] : [{ kind }] });
      },
    };
    return { q, queries };
  };

  it('lastTicketKind takes the account’s most recent ticket on the repo', async () => {
    for (const kind of ['personal', 'work', null]) {
      const { q, queries } = stub(kind);
      expect(await lastTicketKind(q as never, 'acc-1', 'github.com/me/app')).toBe(kind);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('account_id = $1 AND repo = $2');
      expect(queries[0]!.sql).toContain('ORDER BY created_at DESC');
      expect(queries[0]!.args).toEqual(['acc-1', 'github.com/me/app']);
    }
  });

  it('makes kind optional and asks for it when the repo has no earlier ticket', async () => {
    const { client } = await connectAdvisor(() => [], { auth: { mode: 'local' } });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_ticket')!;
    expect(tool.inputSchema.required ?? []).not.toContain('kind');
    const res = await client.callTool({
      name: 'create_ticket',
      arguments: { title: 't', repo: 'acme/app', body: 'b', workflow_id: 'm1_basic' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res))).toMatchObject({
      error: { code: 'bad_request', message: expect.stringContaining('kind') as string },
    });
  });

  it('takes an optional S/M/L size (ADR-0037 §4, C2)', async () => {
    const { client } = await connectAdvisor(() => [], { auth: { mode: 'local' } });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_ticket')!;
    expect(tool.inputSchema.required ?? []).not.toContain('size');
    const size = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).size!;
    expect(size.enum).toEqual(['S', 'M', 'L']);
    const res = await client.callTool({
      name: 'create_ticket',
      arguments: { title: 't', repo: 'acme/app', body: 'b', size: 'XL' },
    });
    expect(res.isError).toBe(true);
  });

  it('takes an optional base (ADR-0039), refusing a bad shape before the create', async () => {
    const { client } = await connectAdvisor(() => [], { auth: { mode: 'local' } });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_ticket')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('base');
    expect(tool.inputSchema.required ?? []).not.toContain('base');
    const res = await client.callTool({
      name: 'create_ticket',
      arguments: { title: 't', repo: 'acme/app', body: 'b', base: { ref: 'a'.repeat(40) } },
    });
    expect(res.isError).toBe(true);
  });
});
