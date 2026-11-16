// @vitest-environment jsdom
// 06 §Attachments: an agent's open request shows the files that session's agent attached (its
// before/after GIFs), not only a review request: the human sees them without a PR.
import type { AttachmentDto, TicketDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { App } from '../App.js';

afterEach(cleanup);

function file(
  id: string,
  source: AttachmentDto['source'],
  sessionId: string | null,
): AttachmentDto {
  return {
    id,
    name: `${id}.gif`,
    mime: 'image/gif',
    size_bytes: 1,
    source,
    caption: null,
    session_id: sessionId,
    workflow_state: 'implementing',
    created_at: '2026-11-16T17:00:00.000Z',
    url: `/api/attachments/${id}/content`,
  };
}

/** The mock, with `files` added to every ticket's attachments. */
function apiWith(files: (ticket: TicketDetail) => AttachmentDto[]) {
  const api = createMockApi({ replyDelayMs: 0 });
  const getTicket = api.getTicket.bind(api);
  api.getTicket = async (id) => {
    const t = await getTicket(id);
    return { ...t, attachments: [...(t.attachments ?? []), ...files(t)] };
  };
  return api;
}

async function open(api: ReturnType<typeof createMockApi>, title: string) {
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const panel = within(el);
  await panel.findByRole('log');
  return panel;
}

describe("an agent's request shows its captures (06 §Attachments)", () => {
  it("a question shows this session's agent files, not another session's or the human's", async () => {
    const api = apiWith(() => [
      file('after', 'agent', SEED_IDS.askNewer.session),
      file('older-run', 'agent', 'b2000000-0000-4000-8000-0000000000ff'),
      file('mockup', 'human', null),
    ]);
    const panel = await open(api, 'Add audit log table');
    const request = panel.getByLabelText('Pending input');
    const captures = await within(request).findByRole('group', { name: 'Attached by the agent' });
    expect(within(captures).getByText('The agent attached:')).toBeTruthy();
    const tiles = within(captures)
      .getAllByRole('button', { name: /^Open / })
      .map((b) => b.getAttribute('aria-label'));
    expect(tiles).toEqual(['Open after.gif']);
  });

  it("conductor's own request (a failed step) shows none", async () => {
    const api = apiWith(() => [file('after', 'agent', SEED_IDS.stepFailed.session)]);
    const panel = await open(api, 'Add CSV export');
    const request = panel.getByLabelText('Pending input');
    expect(within(request).queryByRole('group', { name: 'Attached by the agent' })).toBeNull();
  });

  it('a review request still shows them', async () => {
    const api = apiWith(() => [file('after', 'agent', SEED_IDS.review.session)]);
    const panel = await open(api, 'Board cards: review requests vs questions');
    const request = panel.getByLabelText('Ready for review');
    expect(
      await within(request).findByRole('group', { name: 'Attached by the agent' }),
    ).toBeTruthy();
  });
});
