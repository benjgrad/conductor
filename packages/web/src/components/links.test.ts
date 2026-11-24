// The Links tab's collector (links.ts): pure, no DOM.
import { BOARD_CARD_FIXTURE, type OutputChunk } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { collectLinks, extractUrls, isEmpty, parsePr, urlKey, type CollectInput } from './links.js';
import { buildEntries } from './OutputLog.js';

const SID = '11111111-1111-4111-8111-111111111111';
let seq = 0;
const chunk = (
  stream: OutputChunk['stream'],
  text: string,
  ts = '2026-11-24T10:00:00Z',
): OutputChunk => ({
  session_id: SID,
  seq: seq++,
  stream,
  text,
  ts,
});
const tool = (name: string, input: unknown) =>
  chunk('tool_use', `${name} ${JSON.stringify(input)}`);

function collect(chunks: OutputChunk[], detail: Partial<CollectInput['detail']> = {}) {
  return collectLinks({
    entries: buildEntries(chunks),
    detail: {
      card: BOARD_CARD_FIXTURE,
      ticket_body: undefined,
      input_requests: [],
      pages: [],
      worktree_path: null,
      ...detail,
    },
  });
}

describe('extractUrls', () => {
  it('finds markdown links with their text, then bare URLs', () => {
    expect(extractUrls('See [the docs](https://a.test/docs) and https://b.test/x.')).toEqual([
      { url: 'https://a.test/docs', label: 'the docs' },
      { url: 'https://b.test/x', label: null },
    ]);
  });

  it('trims trailing punctuation and an unbalanced paren, keeps a balanced one', () => {
    expect(extractUrls('(see https://a.test/x),').map((f) => f.url)).toEqual(['https://a.test/x']);
    expect(extractUrls('https://en.wikipedia.org/wiki/A_(b)!').map((f) => f.url)).toEqual([
      'https://en.wikipedia.org/wiki/A_(b)',
    ]);
  });

  it('drops anything that is not http(s), and URLs with credentials', () => {
    expect(extractUrls('[x](javascript:alert(1)) file:///etc/passwd https://u:p@a.test/')).toEqual(
      [],
    );
  });

  it('urlKey ignores the fragment and a trailing slash', () => {
    expect(urlKey('https://a.test/x/#top')).toBe(urlKey('https://a.test/x'));
  });

  it('parsePr reads owner, repo and number from any PR sub-page', () => {
    expect(parsePr('https://github.com/o/r/pull/12/files#diff')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 12,
      url: 'https://github.com/o/r/pull/12',
    });
    expect(parsePr('https://github.com/o/r/issues/12')).toBeNull();
  });
});

describe('collectLinks', () => {
  it('attributes links: the ticket prompt is the ticket, later user messages are you', () => {
    const i = collect([
      chunk('user', '# Ticket\nSee https://ticket.test/spec'),
      chunk('assistant', 'Reading [the guide](https://agent.test/guide).'),
      chunk('user', 'Also look at https://you.test/thing'),
    ]);
    expect(i.ticket.map((l) => l.url)).toEqual(['https://ticket.test/spec']);
    expect(i.agent).toMatchObject([{ url: 'https://agent.test/guide', label: 'the guide' }]);
    expect(i.you.map((l) => l.url)).toEqual(['https://you.test/thing']);
  });

  it('prefers ticket_body over the prompt for the ticket', () => {
    const i = collect([chunk('user', 'prompt https://prompt.test/')], {
      ticket_body: 'body https://body.test/',
    });
    expect(i.ticket.map((l) => l.url)).toEqual(['https://body.test/']);
  });

  it('an ask_user question and a complete_state result are the agent; the answer is you', () => {
    const i = collect([
      chunk('user', 'ticket'),
      tool('mcp__conductor__ask_user', { question: 'Like https://q.test/a?' }),
      chunk('tool_result', 'asked'),
      chunk('user', 'Yes, and https://answer.test/b'),
      tool('mcp__conductor__complete_state', { result: { summary: 'Done, https://r.test/c' } }),
    ]);
    expect(i.agent.map((l) => l.url)).toEqual(['https://q.test/a', 'https://r.test/c']);
    expect(i.you.map((l) => l.url)).toEqual(['https://answer.test/b']);
  });

  it('dedupes a URL, counting mentions, under the highest-precedence source', () => {
    const i = collect([
      chunk('user', 'ticket'),
      chunk('user', 'https://x.test/a', '2026-11-24T10:00:00Z'),
      chunk('assistant', 'https://x.test/a/', '2026-11-24T11:00:00Z'),
    ]);
    expect(i.you).toEqual([]);
    expect(i.agent).toMatchObject([
      { url: 'https://x.test/a', count: 2, firstAt: '2026-11-24T10:00:00Z' },
    ]);
  });

  it("lists conductor's PR with its state, and other PRs as mentioned", () => {
    const pr = 'https://github.com/o/r/pull/7';
    const i = collect(
      [
        chunk('user', 'ticket'),
        chunk('assistant', `Opened ${pr} and see https://github.com/x/y/pull/3/files`),
        tool('Bash', { command: 'gh pr create' }),
        chunk('tool_result', 'https://github.com/o/r/pull/8\n'),
      ],
      { card: { ...BOARD_CARD_FIXTURE, pr_url: pr, pr: { url: pr, merged: true, closed: false } } },
    );
    expect(i.prs).toMatchObject([
      { owner: 'o', repo: 'r', number: 7, source: 'conductor', state: 'merged' },
      { owner: 'x', repo: 'y', number: 3, source: 'agent' },
      { owner: 'o', repo: 'r', number: 8, source: 'agent' },
    ]);
    // A PR is never also a plain link.
    expect(i.agent).toEqual([]);
  });

  it('a PR URL in text is never taken for conductor’s PR', () => {
    const i = collect([
      chunk('user', 'ticket'),
      chunk('assistant', 'https://github.com/evil/r/pull/1'),
    ]);
    expect(i.prs).toMatchObject([{ source: 'agent' }]);
    expect(i.prs[0]!.state).toBeUndefined();
  });

  it('tool inputs are what the agent read; searches are kept as queries', () => {
    const i = collect([
      chunk('user', 'ticket'),
      tool('WebFetch', { url: 'https://read.test/page', prompt: 'x' }),
      tool('mcp__tavily__tavily_extract', { urls: ['https://read.test/two'] }),
      tool('mcp__tavily__tavily_search', { query: 'vitest slots' }),
    ]);
    expect(i.read.map((l) => l.url)).toEqual(['https://read.test/page', 'https://read.test/two']);
    expect(i.searches).toMatchObject([{ query: 'vitest slots' }]);
  });

  it('files the agent edited or wrote, shortened by the worktree and deduped', () => {
    const i = collect(
      [
        chunk('user', 'ticket'),
        tool('Write', { file_path: '/wt/a/src/x.ts', content: 'https://not-read.test/' }),
        tool('Edit', { file_path: '/wt/a/src/x.ts', old_string: 'a', new_string: 'b' }),
        tool('Edit', { file_path: '/wt/a/y.md', old_string: 'a', new_string: 'b' }),
      ],
      { worktree_path: '/wt/a' },
    );
    expect(i.files).toMatchObject([
      { path: 'src/x.ts', ops: ['write', 'edit'] },
      { path: 'y.md', ops: ['edit'] },
    ]);
    expect(i.read).toEqual([]);
  });

  it('includes attached pages and answers to input requests', () => {
    const i = collect([], {
      pages: [
        {
          url: 'https://page.test/p',
          title: 'Report',
          state: 'implementing',
          expires_at: null,
          hosted: false,
          expired: true,
        },
      ],
      input_requests: [
        {
          id: SID,
          kind: 'agent_question',
          question: 'q',
          created_at: '2026-11-24T10:00:00Z',
          answer: 'https://ans.test/',
          answered_at: '2026-11-24T10:01:00Z',
          truncated: false,
        },
      ],
    });
    expect(i.agent).toMatchObject([{ url: 'https://page.test/p', label: 'Report', expired: true }]);
    expect(i.you.map((l) => l.url)).toEqual(['https://ans.test/']);
  });

  it('isEmpty with nothing found', () => {
    expect(isEmpty(collect([chunk('user', 'plain ticket')]))).toBe(true);
  });
});
