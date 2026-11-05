// @vitest-environment jsdom
// UXR-37 (FR-2): the wide panel puts the request and its evidence first, then the conversation,
// then the follow-ups and the check output in their own disclosures. The default layout (phone,
// below 900 px) keeps the request at the end of the chat.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { DetailPanel, type PanelLayout } from './DetailPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPanel(
  sessionId: string,
  props: { layout?: PanelLayout; focus?: boolean; onToggleFocus?: () => void } = {},
) {
  const api = createMockApi({ replyDelayMs: 0 });
  return render(
    <DetailPanel api={api} sessionId={sessionId} version="1" onClose={() => {}} {...props} />,
  );
}

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('wide layout (UXR-37 FR-2)', () => {
  it('puts the request above the conversation and the check output in a disclosure', async () => {
    // A failure question whose session ran a command: its output is a "Check output" run.
    renderPanel(SEED_IDS.askOlder.session, { layout: 'wide' });
    const request = await screen.findByRole('region', { name: 'Request' });
    const log = screen.getByRole('log');
    expect(within(request).getByRole('region', { name: 'Pending input' })).toBeTruthy();
    expect(log.contains(request)).toBe(false);
    expect(follows(request, log)).toBe(true);
    // The evidence (the failed run's output) is inline with the request.
    expect(within(request).getByRole('region', { name: 'Failure output' })).toBeTruthy();

    // No run row in the chat; the disclosure under it holds them, collapsed.
    expect(within(log).queryByText(/Check output/)).toBeNull();
    const toggle = screen.getByRole('button', { name: /^Check output/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1');
    expect(follows(log, toggle)).toBe(true);
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(body.hidden).toBe(false);
    expect(body.querySelector('.check-run')).toBeTruthy();
  });

  it('shows the follow-ups after the conversation, collapsed, with their count', async () => {
    renderPanel(SEED_IDS.review.session, { layout: 'wide' });
    const request = await screen.findByRole('region', { name: 'Request' });
    const toggle = await screen.findByRole('button', { name: /Proposed follow-up tickets/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2');
    expect(follows(request, screen.getByRole('log'))).toBe(true);
    expect(follows(screen.getByRole('log'), toggle)).toBe(true);
  });

  it('has the focus toggle only when given one, pressed while focus mode is on', async () => {
    const onToggleFocus = vi.fn();
    const { unmount } = renderPanel(SEED_IDS.askOlder.session, {
      layout: 'wide',
      focus: true,
      onToggleFocus,
    });
    const button = await screen.findByRole('button', { name: 'Focus mode' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('Exit focus mode');
    fireEvent.click(button);
    expect(onToggleFocus).toHaveBeenCalledOnce();
    unmount();

    renderPanel(SEED_IDS.askOlder.session, { layout: 'wide' });
    await screen.findByRole('region', { name: 'Request' });
    expect(screen.queryByRole('button', { name: 'Focus mode' })).toBeNull();
  });
});

describe('default layout (phone: unchanged)', () => {
  it('keeps the request and the check output rows inside the chat', async () => {
    renderPanel(SEED_IDS.askOlder.session);
    const pending = await screen.findByRole('region', { name: 'Pending input' });
    const log = screen.getByRole('log');
    expect(log.contains(pending)).toBe(true);
    expect(screen.queryByRole('region', { name: 'Request' })).toBeNull();
    expect(within(log).getByText(/Check output/)).toBeTruthy();
    expect(document.querySelector('.check-output-disclosure')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Focus mode' })).toBeNull();
  });
});
