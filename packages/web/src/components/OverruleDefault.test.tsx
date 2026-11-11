// @vitest-environment jsdom
// ADR-0041: Overrule… on a default answer in the timeline posts the correction; a 409 (the agent
// moved on) shows the server's message.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { OverruleDefault } from './OverruleDefault.js';

afterEach(cleanup);

const SESSION = 'c1000000-0000-4000-8000-000000000001';
const REQUEST = 'c3000000-0000-4000-8000-0000000000f1';

function setup(overruleDefault: ApiClient['overruleDefault']) {
  const onDone = vi.fn();
  const api = { overruleDefault } as unknown as ApiClient;
  render(
    <OverruleDefault api={api} sessionId={SESSION} inputRequestId={REQUEST} onDone={onDone} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Overrule…' }));
  fireEvent.change(screen.getByLabelText('What should the agent do instead?'), {
    target: { value: '  Use B  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Overrule' }));
  return { onDone };
}

describe('OverruleDefault', () => {
  it('posts the trimmed text for the request, then reloads', async () => {
    const post = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { onDone } = setup(post);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(SESSION, { input_request_id: REQUEST, text: 'Use B' });
    expect(screen.queryByLabelText('What should the agent do instead?')).toBeNull();
  });

  it('shows the 409 message when the agent has moved on', async () => {
    const post = vi.fn(() =>
      Promise.reject(new ApiRequestError(409, 'conflict', 'the agent has moved on')),
    );
    const { onDone } = setup(post);
    expect((await screen.findByRole('alert')).textContent).toContain('the agent has moved on');
    expect(onDone).not.toHaveBeenCalled();
  });
});
