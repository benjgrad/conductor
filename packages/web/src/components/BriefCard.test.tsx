// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBrief } from '../brief/parse.js';
import { UX2_TICKET_BODY } from '../brief/ux2-ticket.js';
import { BriefCard, type BriefCardProps } from './BriefCard.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const SID = 'b2000000-0000-4000-8000-0000000000aa';

function props(over: Partial<BriefCardProps> = {}): BriefCardProps {
  return {
    sessionId: SID,
    brief: parseBrief(UX2_TICKET_BODY),
    body: UX2_TICKET_BODY,
    unavailable: null,
    promptText: null,
    promptReason: null,
    promptLoading: false,
    onWantPrompt: () => undefined,
    ...over,
  };
}

const head = () => screen.getByRole('button', { name: /^Brief/ });

describe('BriefCard (UX-2)', () => {
  it('is open by default: goal, FR/NFR checklists, each verification inline', () => {
    render(<BriefCard {...props()} />);
    expect(head().tagName).toBe('BUTTON');
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/^Anyone opening a session sees/)).toBeTruthy();
    const fr = screen.getByRole('list', { name: 'Functional' });
    const items = within(fr).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(within(items[0]!).getByText('FR-1')).toBeTruthy();
    expect(within(items[0]!).getByText(/parse\.test\.ts: this ticket's own body/)).toBeTruthy();
    expect(within(items[0]!).getByRole('checkbox').matches(':disabled')).toBe(true);
    const nfr = screen.getByRole('list', { name: 'Non-functional' });
    const n1 = within(nfr).getAllByRole('listitem')[0]!;
    expect(within(n1).getByText('no verification').className).toContain('brief-tally-warn');
    expect(screen.getByText(/Per-requirement verification STATUS/)).toBeTruthy();
  });

  it('collapses on click, remembers it per session, and stays closed after a remount', () => {
    const { unmount } = render(<BriefCard {...props()} />);
    fireEvent.click(head());
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(`conductor.brief.open.${SID}`)).toBe('closed');
    unmount();
    render(<BriefCard {...props()} />);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    cleanup();
    // Another session is still open by default.
    render(<BriefCard {...props({ sessionId: 'other' })} />);
    expect(head().getAttribute('aria-expanded')).toBe('true');
  });

  it('a throwing localStorage still renders open and toggles', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<BriefCard {...props()} />);
    expect(head().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head());
    expect(head().getAttribute('aria-expanded')).toBe('false');
  });

  it('the header is keyboard-operable (a native button) and controls the body', () => {
    render(<BriefCard {...props()} />);
    const h = head();
    h.focus();
    expect(document.activeElement).toBe(h);
    const body = document.getElementById(h.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(false);
    fireEvent.click(h); // Enter / Space on a <button> fire click
    expect(body.hidden).toBe(true);
  });

  it('FR-3: tally with the count without verification in the warning colour', () => {
    render(<BriefCard {...props()} />);
    expect(head().textContent).toContain('FR 5 · NFR 5 ·');
    const warn = within(head()).getByText('4 without verification');
    expect(warn.className).toBe('brief-tally-warn');
  });

  it('FR-3: a fully verified brief says n/n', () => {
    const body = [
      '## Goal',
      'g',
      '## Functional requirements',
      '- FR-1 a',
      '## Non-functional requirements',
      '- NFR-1 b',
      '## Verification',
      '- FR-1: t1',
      '- NFR-1: t2',
    ].join('\n');
    render(<BriefCard {...props({ body, brief: parseBrief(body) })} />);
    expect(head().textContent).toContain('FR 1 · NFR 1 · 2/2 with a verification');
    expect(head().querySelector('.brief-tally-warn')).toBeNull();
    expect(screen.getByText(/No Context section/).className).toContain('muted');
  });

  it('a legacy body shows as written, with the warning', () => {
    const body = 'Rename the field to `full_name` everywhere.';
    render(<BriefCard {...props({ body, brief: parseBrief(body) })} />);
    expect(screen.getByText(/Rename the field to/)).toBeTruthy();
    expect(screen.getByText('No recognised sections: showing the ticket as written')).toBeTruthy();
    expect(head().querySelector('.brief-tally')).toBeNull();
  });

  it('Full ticket toggles the raw rendered markdown', () => {
    render(<BriefCard {...props()} />);
    const btn = screen.getByRole('button', { name: /Full ticket/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const full = screen.getByLabelText('Full ticket');
    expect(within(full).getByText('Gates')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByLabelText('Full ticket')).toBeNull();
  });

  it('FR-4: View prompt asks for the prompt and shows it, or why not', () => {
    const want = vi.fn();
    const { rerender } = render(<BriefCard {...props({ onWantPrompt: want })} />);
    expect(want).not.toHaveBeenCalled(); // the body is there: no fetch until asked
    fireEvent.click(screen.getByRole('button', { name: /View prompt/ }));
    expect(want).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading the prompt…')).toBeTruthy();
    rerender(<BriefCard {...props({ onWantPrompt: want, promptText: '# Ticket: X\n\nbody' })} />);
    expect(screen.getByLabelText('Initial prompt').textContent).toBe('# Ticket: X\n\nbody');
    rerender(<BriefCard {...props({ onWantPrompt: want, promptReason: 'mbp-ben is offline' })} />);
    expect(screen.getByText('prompt unavailable: mbp-ben is offline')).toBeTruthy();
  });

  it('no body: asks for the prompt fallback, then says why it is unavailable', () => {
    const want = vi.fn();
    const none = { brief: null, body: null, onWantPrompt: want };
    const { rerender } = render(<BriefCard {...props(none)} />);
    expect(want).toHaveBeenCalled();
    expect(screen.getByText('Loading the brief…')).toBeTruthy();
    rerender(<BriefCard {...props({ ...none, unavailable: 'no transcript found' })} />);
    expect(screen.getByText('brief unavailable: no transcript found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Full ticket/ })).toBeNull();
    expect(screen.getByRole('button', { name: /View prompt/ })).toBeTruthy();
  });
});
