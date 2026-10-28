// @vitest-environment jsdom
// "Start fresh conversation…" in the session panel's pending request (06 §Start fresh
// conversation; POST /api/sessions/:id/fresh-conversation).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { FRESH_CONVERSATION_HELP } from './FreshConversation.js';

afterEach(cleanup);

async function open(title: string, prepare?: (api: ApiClient) => void) {
  const api = createMockApi({ replyDelayMs: 0 });
  // Before render: the app wraps the client's methods once (withAuthRedirect).
  prepare?.(api);
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const panel = within(el);
  await panel.findByRole('log');
  return { api, panel, el };
}

const BUTTON = /^Start fresh conversation…$/;

describe('Start fresh conversation…', () => {
  it('is a secondary action on a question while parked with an agent to return to', async () => {
    const { el } = await open('Add audit log table');
    const pending = within(el.querySelector('.pending') as HTMLElement);
    const button = pending.getByRole('button', { name: BUTTON });
    expect(button.className).not.toContain('prominent');
    // After the reply hint, not first.
    const hint = pending.getByText('Reply in the box below to answer.');
    expect(hint.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is first and highlighted on a failure (step failed / retries exhausted)', async () => {
    const { el } = await open('Add CSV export');
    const pending = within(el.querySelector('.pending') as HTMLElement);
    const button = pending.getByRole('button', { name: BUTTON });
    expect(button.className).toContain('prominent');
    const hint = pending.getByText('Reply in the box below to answer.');
    expect(button.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not offered when return_to is not an agent state', async () => {
    const { el } = await open('Fix flaky checkout test');
    const pending = within(el.querySelector('.pending') as HTMLElement);
    expect(pending.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('opens a required text box with the help text, pre-filled with nothing, and posts it', async () => {
    let spy!: MockInstance<ApiClient['freshConversation']>;
    const { el } = await open('Add audit log table', (api) => {
      spy = vi.spyOn(api, 'freshConversation');
    });
    const pending = within(el.querySelector('.pending') as HTMLElement);
    fireEvent.click(pending.getByRole('button', { name: BUTTON }));

    const form = pending.getByRole('form', { name: 'Start fresh conversation' });
    const box = within(form).getByLabelText<HTMLTextAreaElement>('Your message to the agent');
    expect(box.value).toBe('');
    expect(box.required).toBe(true);
    expect(within(form).getByText(FRESH_CONVERSATION_HELP)).toBeTruthy();
    const submit = within(form).getByRole('button', { name: 'Start fresh conversation' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: '  Start over; use the users table.  ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [sessionId, req] = spy.mock.calls[0]!;
    expect(typeof sessionId).toBe('string');
    expect(req).toEqual({ text: 'Start over; use the users table.' });
    // The session went back to the agent: no pending request any more.
    await waitFor(() => expect(el.querySelector('.pending')).toBeNull());
  });

  it('Back closes the box without posting; an error is shown', async () => {
    const { el } = await open('Add audit log table', (api) => {
      vi.spyOn(api, 'freshConversation').mockRejectedValueOnce(new Error('session moved on'));
    });
    const pending = within(el.querySelector('.pending') as HTMLElement);
    fireEvent.click(pending.getByRole('button', { name: BUTTON }));
    fireEvent.click(pending.getByRole('button', { name: 'Back' }));
    expect(pending.queryByRole('form', { name: 'Start fresh conversation' })).toBeNull();

    fireEvent.click(pending.getByRole('button', { name: BUTTON }));
    fireEvent.change(pending.getByLabelText('Your message to the agent'), {
      target: { value: 'again' },
    });
    fireEvent.click(pending.getByRole('button', { name: 'Start fresh conversation' }));
    expect((await pending.findByRole('alert')).textContent).toContain('session moved on');
  });
});
