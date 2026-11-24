// @vitest-environment jsdom
// The session panel's Links tab (LinksTab.tsx), on a mock session detail.
import type { OutputChunk, SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { LinksTab } from './LinksTab.js';

afterEach(cleanup);

const PR = 'https://github.com/benjgrad/fixture-app/pull/7';
let seq = 0;
const chunk = (stream: OutputChunk['stream'], text: string): OutputChunk => ({
  session_id: '11111111-1111-4111-8111-111111111111',
  seq: seq++,
  stream,
  text,
  ts: '2026-11-24T10:00:00Z',
});

async function detail(over: Partial<SessionDetail> = {}): Promise<SessionDetail> {
  const d = await createMockApi({ replyDelayMs: 0 }).getSession(SEED_IDS.running.session);
  return { ...d, ticket_body: '', pages: [], input_requests: [], ...over };
}

describe('LinksTab', () => {
  it('groups PRs and links, with safe external anchors', async () => {
    const d = await detail();
    render(
      <LinksTab
        detail={{
          ...d,
          card: { ...d.card, pr_url: PR, pr: { url: PR, merged: true, closed: false } },
        }}
        output={[
          chunk('user', 'the ticket'),
          chunk(
            'assistant',
            'See [the spec](https://spec.test/) and https://github.com/a/b/pull/2',
          ),
          chunk('user', 'https://mine.test/x'),
        ]}
        history={null}
      />,
    );
    const prs = within(screen.getByRole('region', { name: 'Pull requests' }));
    const mine = prs.getByRole('link', { name: 'benjgrad/fixture-app#7' });
    expect(mine.getAttribute('href')).toBe(PR);
    expect(mine.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mine.getAttribute('target')).toBe('_blank');
    expect(prs.getByText("Conductor's PR")).toBeTruthy();
    expect(prs.getByText('Merged')).toBeTruthy();
    expect(prs.getByRole('link', { name: 'a/b#2' })).toBeTruthy();
    expect(prs.getByText('Mentioned by the agent')).toBeTruthy();
    const agent = within(screen.getByRole('region', { name: 'From the agent' }));
    expect(agent.getByRole('link', { name: 'the spec' }).getAttribute('href')).toBe(
      'https://spec.test/',
    );
    const you = within(screen.getByRole('region', { name: 'From you' }));
    expect(you.getByRole('link', { name: 'https://mine.test/x' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'In the ticket' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Where it runs' })).toBeTruthy();
  });

  it('shows the empty state, and files changed behind a toggle', async () => {
    const d = await detail({ worktree_path: '/wt/x' });
    render(
      <LinksTab
        detail={d}
        output={[
          chunk('user', 'the ticket'),
          chunk(
            'tool_use',
            'Edit {"file_path":"/wt/x/src/a.ts","old_string":"a","new_string":"b"}',
          ),
        ]}
        history={null}
      />,
    );
    expect(screen.queryByText('No links in this session yet.')).toBeNull();
    const files = within(screen.getByRole('region', { name: 'Files changed' }));
    const toggle = files.getByRole('button', { name: /Files changed/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(files.getByText('src/a.ts').closest('[hidden]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(files.getByText('src/a.ts').closest('[hidden]')).toBeNull();
  });

  it('says so when nothing was found', async () => {
    render(<LinksTab detail={await detail()} output={[chunk('user', 'plain')]} history={null} />);
    expect(screen.getByText('No links in this session yet.')).toBeTruthy();
  });
});
