// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBrief } from '../brief/parse.js';
import { UX2_TICKET_BODY } from '../brief/ux2-ticket.js';
import { BriefContent, type BriefContentProps } from './BriefCard.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function props(over: Partial<BriefContentProps> = {}): BriefContentProps {
  return {
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

const tallyLine = () => document.querySelector('.brief-tally-line')!;

describe('BriefContent (UX-2, the Brief sheet)', () => {
  it('goal, FR/NFR checklists, each verification inline', () => {
    render(<BriefContent {...props()} />);
    expect(screen.queryByRole('button', { name: /^Brief/ })).toBeNull();
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

  it('FR-3: tally with the count without verification in the warning colour', () => {
    render(<BriefContent {...props()} />);
    expect(tallyLine().textContent).toContain('FR 5 · NFR 5 ·');
    const warn = within(tallyLine() as HTMLElement).getByText('4 without verification');
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
    render(<BriefContent {...props({ body, brief: parseBrief(body) })} />);
    expect(tallyLine().textContent).toContain('FR 1 · NFR 1 · 2/2 with a verification');
    expect(tallyLine().querySelector('.brief-tally-warn')).toBeNull();
    expect(screen.getByText(/No Context section/).className).toContain('muted');
  });

  it('a legacy body shows as written, with the warning', () => {
    const body = 'Rename the field to `full_name` everywhere.';
    render(<BriefContent {...props({ body, brief: parseBrief(body) })} />);
    expect(screen.getByText(/Rename the field to/)).toBeTruthy();
    expect(screen.getByText('No recognised sections: showing the ticket as written')).toBeTruthy();
    expect(document.querySelector('.brief-tally')).toBeNull();
  });

  it('Full ticket toggles the raw rendered markdown', () => {
    render(<BriefContent {...props()} />);
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
    const { rerender } = render(<BriefContent {...props({ onWantPrompt: want })} />);
    expect(want).not.toHaveBeenCalled(); // the body is there: no fetch until asked
    fireEvent.click(screen.getByRole('button', { name: /View prompt/ }));
    expect(want).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading the prompt…')).toBeTruthy();
    rerender(
      <BriefContent {...props({ onWantPrompt: want, promptText: '# Ticket: X\n\nbody' })} />,
    );
    expect(screen.getByLabelText('Initial prompt').textContent).toBe('# Ticket: X\n\nbody');
    rerender(
      <BriefContent {...props({ onWantPrompt: want, promptReason: 'mbp-ben is offline' })} />,
    );
    expect(screen.getByText('prompt unavailable: mbp-ben is offline')).toBeTruthy();
  });

  it('no body: loading, then says why it is unavailable', () => {
    const none = { brief: null, body: null };
    const { rerender } = render(<BriefContent {...props(none)} />);
    expect(screen.getByText('Loading the brief…')).toBeTruthy();
    rerender(<BriefContent {...props({ ...none, unavailable: 'no transcript found' })} />);
    expect(screen.getByText('brief unavailable: no transcript found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Full ticket/ })).toBeNull();
    expect(screen.getByRole('button', { name: /View prompt/ })).toBeTruthy();
  });
});
