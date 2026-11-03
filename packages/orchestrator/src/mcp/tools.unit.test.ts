import { describe, expect, it } from 'vitest';
import { MCP_INSTRUCTIONS, guard, pageOf, transcriptPage } from './tools.js';

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
