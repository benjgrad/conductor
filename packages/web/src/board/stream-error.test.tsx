// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { StreamHandlers } from '../api/client.js';
import { StreamDisconnectedError } from '../api/http.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';

afterEach(cleanup);

it('shows a board stream drop and clears it once the stream reconnects', async () => {
  const api = createMockApi();
  let handlers: StreamHandlers<unknown> | undefined;
  const stream = api.streamBoard.bind(api);
  api.streamBoard = (from, h) => {
    handlers = h as StreamHandlers<unknown>;
    return stream(from, h);
  };
  render(<App api={api} />);
  await screen.findByText('Add pagination to /orders');
  act(() => handlers?.onError?.(new StreamDisconnectedError('board', 1000)));
  expect(screen.getByRole('alert').textContent).toMatch(/board stream disconnected/);
  act(() => handlers?.onOpen?.());
  expect(screen.queryByRole('alert')).toBeNull();
});
