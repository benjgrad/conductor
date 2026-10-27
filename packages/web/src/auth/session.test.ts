import type { BoardSseEvent } from '@conductor/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type StreamHandlers } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { withAuthRedirect } from './session.js';

const unauthorized = () => new ApiRequestError(401, 'unauthorized', 'Sign in to continue');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('withAuthRedirect', () => {
  it('reports a 401 from REST calls (board, admin) and still rejects', async () => {
    const api = createMockApi();
    const onUnauthorized = vi.fn();
    const guarded = withAuthRedirect(api, onUnauthorized);
    api.getBoard = () => Promise.reject(unauthorized());
    api.listUsers = () => Promise.reject(unauthorized());
    await expect(guarded.getBoard()).rejects.toBeInstanceOf(ApiRequestError);
    await expect(guarded.listUsers()).rejects.toBeInstanceOf(ApiRequestError);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('ignores other errors and the sign-in calls, whose 401 means wrong credentials', async () => {
    const api = createMockApi({ auth: 'password' });
    const onUnauthorized = vi.fn();
    const guarded = withAuthRedirect(api, onUnauthorized);
    api.approve = () => Promise.reject(new ApiRequestError(409, 'conflict', 'nope'));
    await expect(guarded.approve('x')).rejects.toMatchObject({ status: 409 });
    await expect(
      guarded.changePassword({ current: 'wrong', new: 'a different passphrase' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(guarded.login({ email: 'a@b.c', password: 'x' })).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls methods replaced after wrapping (test hooks)', async () => {
    const api = createMockApi();
    const guarded = withAuthRedirect(api, vi.fn());
    api.listMachines = () => Promise.resolve([]);
    expect(await guarded.listMachines()).toEqual([]);
  });

  it('re-probes /api/me on a stream error and reports only a 401 there', async () => {
    const api = createMockApi();
    let handlers: StreamHandlers<BoardSseEvent> | undefined;
    api.streamBoard = (_from, h) => {
      handlers = h;
      return () => {};
    };
    const onUnauthorized = vi.fn();
    const onError = vi.fn();
    withAuthRedirect(api, onUnauthorized).streamBoard(0, { onEvent: () => {}, onError });

    handlers?.onError?.(new Error('dropped'));
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();

    api.me = () => Promise.reject(unauthorized());
    handlers?.onError?.(new Error('dropped'));
    await tick();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
