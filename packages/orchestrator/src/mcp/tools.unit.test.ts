import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { RequestAuth } from '../auth/middleware.js';
import {
  clampWindow,
  ROW_LIMIT,
  WINDOW_DEFAULT_DAYS,
  WINDOW_MAX_DAYS,
} from '../advisor/queries.js';
import {
  buildMcpServer,
  FINDINGS_PAGE,
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
async function connectAdvisor(rows: (sql: string) => Record<string, unknown>[] = () => []) {
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
  const server = buildMcpServer({ db } as unknown as ToolDeps, who);
  const client = new Client({ name: 'unit', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, queries };
}

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (res.content as { type: string; text: string }[])[0]!.text;

describe('advisor tools (ADR-0033)', () => {
  it('lists get_process_metrics and list_findings last, after every earlier tool', async () => {
    const { client } = await connectAdvisor();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.slice(-2)).toEqual(['get_process_metrics', 'list_findings']);
    expect(names.slice(-3, -2)).toEqual(['adopt_default_workflow']);
    for (const t of (await client.listTools()).tools.slice(-2)) {
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
    expect(queries).toHaveLength(4);
    for (const q of queries) {
      expect(q.sql).toContain('s.account_id = $1');
      expect(q.args).toEqual(['acc-1', expect.any(Date), 'github.com/acme/app', null, ROW_LIMIT]);
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
    for (const must of ['get_process_metrics', 'list_findings', 'base_version', 'approval']) {
      expect(text).toContain(must);
    }
    expect(MCP_INSTRUCTIONS).toContain('workflow_advisor');
  });
});
