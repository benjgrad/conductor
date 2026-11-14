// @vitest-environment jsdom
// Ticket "Improved handoff": every request card opens with why the ticket stopped and what was
// done; a failure's technical text is collapsed under "Technical details".
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { HandoffBrief } from './HandoffBrief.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('HandoffBrief', () => {
  it('shows why and what was done', () => {
    render(<HandoffBrief brief={{ why: 'It ran out of budget.', summary: 'Wrote the parser.' }} />);
    const g = screen.getByRole('group', { name: 'Why it stopped' });
    expect(within(g).getByText('It ran out of budget.')).toBeTruthy();
    expect(within(g).getByText('Wrote the parser.')).toBeTruthy();
  });

  it('leaves the summary out when asked, or when there is none', () => {
    render(<HandoffBrief brief={{ why: 'Done.', summary: 'Hidden.' }} showSummary={false} />);
    expect(screen.queryByText('Hidden.')).toBeNull();
    expect(screen.queryByText('What was done:')).toBeNull();
  });

  it('clamps a long summary behind More', () => {
    render(<HandoffBrief brief={{ why: 'Done.', summary: 'word '.repeat(80) }} />);
    const more = screen.getByRole('button', { name: 'More' });
    expect(document.querySelector('.handoff-summary.clamped')).not.toBeNull();
    fireEvent.click(more);
    expect(document.querySelector('.handoff-summary.clamped')).toBeNull();
  });
});

describe('the request card leads with the brief', () => {
  it('a failed step: plain reason first, conductor’s text collapsed', async () => {
    render(<App api={createMockApi({ replyDelayMs: 0 })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add CSV export' }));
    const el = await screen.findByRole('complementary', { name: 'Session detail' });
    const pending = await within(el).findByRole('region', { name: 'Pending input' });
    const brief = within(pending).getByRole('group', { name: 'Why it stopped' });
    expect(brief.textContent).not.toMatch(/GraphQL|Retry, skip, or abort/);
    const details = pending.querySelector('details.request-details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(
      within(details as HTMLElement).getAllByText(/GraphQL: No commits/).length,
    ).toBeGreaterThan(0);
    // The brief comes before the technical details.
    expect(brief.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
