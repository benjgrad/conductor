// @vitest-environment jsdom
// UX-6: conductor's check output collapsed in the thread, and no synthetic gate-step label
// ("implementing → needs_input (move: …)") anywhere in the session panel (FR-5).
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';

afterEach(cleanup);

async function open(title: string) {
  const api = createMockApi({ replyDelayMs: 0 });
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const panel = within(el);
  await panel.findByRole('log');
  return { api, panel, el };
}

describe('session panel in a conductor step (UX-6)', () => {
  it('FR-5: header says "Conductor is checking", the composer says why, no "(move:" text', async () => {
    const { panel, el } = await open('Conductor checks demo');
    const head = el.querySelector('.detail-head') as HTMLElement;
    expect(within(head).getByText('Conductor is checking')).toBeTruthy();
    expect(head.querySelector('.head-state')).toBeNull();

    expect(panel.getByLabelText<HTMLTextAreaElement>('Message').disabled).toBe(true);
    expect(
      panel.getByText(
        'Conductor is running checks; the agent resumes (or the PR opens) when they finish.',
      ),
    ).toBeTruthy();

    // The whole panel, the (hidden) Details tab included: moves, workflow line, diagram label.
    expect(el.textContent).not.toContain('(move:');
    expect(el.innerHTML).not.toContain('(move:');
    expect(panel.getByRole('button', { name: /Implementing → Checks before/ })).toBeTruthy();
  });

  it('FR-1: the step’s output is collapsed rows: setup passed, the build running', async () => {
    const { panel, el } = await open('Conductor checks demo');
    const rows = panel.getAllByRole('button', { name: /^Check output/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      'Check output · Setup: npm ci (passed) · 4 lines▸',
      'Check output · Build passes (running) · 4 lines▸',
    ]);
    expect(rows.every((r) => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(panel.queryByText(/Progress: resolved 453/)).toBeNull();

    fireEvent.click(rows[0]!);
    expect(el.querySelector('.check-run-output')?.textContent).toContain('Progress: resolved 453');
  });

  it('a conditions step (waiting on the PR) shows no "(move:" text either', async () => {
    const { el } = await open('Ship the /health endpoint');
    expect(el.textContent).not.toContain('(move:');
    expect(el.innerHTML).not.toContain('(move:');
  });
});
