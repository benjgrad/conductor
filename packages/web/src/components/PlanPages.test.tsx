// @vitest-environment jsdom
// ADR-0038: the pages under the plan (PlanPages.tsx): ours open inline in a sandboxed iframe
// (scripts only, never same-origin), anything else is a link; in Plan review and the Plan sheet.
import type { SessionDetail, TicketPage } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { PLAN_APPROVAL_LABEL, PlanApprovalRequest } from './PlanApprovalRequest.js';
import { PAGE_SANDBOX, PlanPages, isEmbeddable, pagesOf } from './PlanPages.js';
import { agentStatesOf, planOptions } from './request-preview.js';
import { TicketSheet } from './TicketStrip.js';

afterEach(cleanup);

const ORIGIN = window.location.origin;
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOSTED: TicketPage = {
  url: `${ORIGIN}/p/${ID}`,
  title: 'Mockup: filter bar',
  state: 'planning',
  expires_at: '2099-01-01T00:00:00.000Z',
  hosted: true,
  expired: false,
};
const EXTERNAL: TicketPage = {
  url: 'https://claude.ai/public/artifacts/abc',
  title: 'Diagram elsewhere',
  state: 'planning',
  expires_at: null,
  hosted: false,
  expired: false,
};

describe('isEmbeddable', () => {
  it('only our own unexpired /p/<uuid> pages', () => {
    expect(isEmbeddable(HOSTED, ORIGIN)).toBe(true);
    expect(isEmbeddable({ ...HOSTED, expired: true }, ORIGIN)).toBe(false);
    expect(isEmbeddable(EXTERNAL, ORIGIN)).toBe(false);
    expect(isEmbeddable({ ...HOSTED, url: `https://evil.example/p/${ID}` }, ORIGIN)).toBe(false);
  });

  it('pagesOf keeps the plan state’s pages', () => {
    const other = { ...EXTERNAL, state: 'implementing' };
    expect(pagesOf({ pages: [HOSTED, other] }, 'planning')).toEqual([HOSTED]);
    expect(pagesOf({}, 'planning')).toEqual([]);
  });
});

/** Every iframe's sandbox must be exactly `allow-scripts`. */
function expectSandboxed(frame: HTMLElement) {
  const sandbox = frame.getAttribute('sandbox');
  expect(sandbox).toBe(PAGE_SANDBOX);
  expect(sandbox).not.toContain('allow-same-origin');
}

describe('PlanPages', () => {
  it('links every page; ours opens inline in a sandboxed iframe', () => {
    render(<PlanPages pages={[HOSTED, EXTERNAL]} />);
    const region = within(screen.getByRole('region', { name: 'Pages' }));
    const ext = region.getByRole('link', { name: 'Diagram elsewhere' });
    expect(ext.getAttribute('href')).toBe(EXTERNAL.url);
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
    expect(region.getByRole('link', { name: HOSTED.title }).getAttribute('href')).toBe(HOSTED.url);
    // Only one "Show here": the external page is never framed.
    expect(region.getAllByRole('button', { name: 'Show here' })).toHaveLength(1);
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(region.getByRole('button', { name: 'Show here' }));
    const frame = region.getByTitle(HOSTED.title);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe(HOSTED.url);
    expectSandboxed(frame);
  });

  it('an expired page is not a link and never framed', () => {
    render(<PlanPages pages={[{ ...HOSTED, expired: true }]} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show here' })).toBeNull();
    expect(screen.getByText(/expired/)).toBeTruthy();
  });

  it('renders nothing without pages', () => {
    const { container } = render(<PlanPages pages={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

async function seedDetail(): Promise<{ api: ReturnType<typeof createMockApi>; detail: SessionDetail }> {
  const api = createMockApi({ replyDelayMs: 0 });
  const base = await api.getSession(SEED_IDS.transitions.session);
  const detail: SessionDetail = {
    ...base,
    context: { planning: { plan: '## Plan\n\nDo it.', summary: 's' } },
    pages: [HOSTED, EXTERNAL],
    pending_input: {
      ...base.pending_input!,
      question: 'Approve?',
      origin_transition: 'plan_needs_approval',
    },
  };
  return { api, detail };
}

describe('pages in Plan review and the Plan sheet', () => {
  it('plan_review lists the pages with the sandboxed iframe', async () => {
    const { api, detail } = await seedDetail();
    const plan = planOptions(
      detail.card.human_transitions,
      detail.return_to,
      agentStatesOf(detail.workflow),
    )!;
    render(
      <PlanApprovalRequest
        api={api as ApiClient}
        detail={detail}
        agent="Robin"
        request={detail.pending_input!}
        plan={plan}
        onDone={() => undefined}
      />,
    );
    const panel = within(screen.getByRole('region', { name: PLAN_APPROVAL_LABEL }));
    const pages = within(panel.getByRole('region', { name: 'Pages' }));
    expect(pages.getByRole('link', { name: EXTERNAL.title })).toBeTruthy();
    fireEvent.click(pages.getByRole('button', { name: 'Show here' }));
    expectSandboxed(pages.getByTitle(HOSTED.title));
  });

  it('the Plan sheet lists them too', async () => {
    const { api, detail } = await seedDetail();
    render(
      <TicketSheet
        id="t"
        api={api as ApiClient}
        detail={detail}
        planActions={null}
        agentRunning={false}
        sheet="plan"
        onSheet={() => undefined}
        onReload={() => undefined}
        brief={null}
        body={null}
        unavailable={null}
        promptText={null}
        promptReason={null}
        promptLoading={false}
        onWantPrompt={() => undefined}
      />,
    );
    const pages = within(screen.getByRole('region', { name: 'Pages' }));
    expect(pages.getByRole('link', { name: HOSTED.title })).toBeTruthy();
    fireEvent.click(pages.getByRole('button', { name: 'Show here' }));
    expectSandboxed(pages.getByTitle(HOSTED.title));
  });
});
