import type { BoardSseEvent, OutputChunk } from '@conductor/shared';
import { ApiRequestError, type ApiClient, type StreamHandlers } from '../api/client.js';

// M2-T05: "any 401 from the API or SSE sends the user to /signin" without touching the views.
// The app hands its views an ApiClient wrapped here:
//   - REST: a rejection with status 401 calls `onUnauthorized` (and still rejects).
//   - SSE: EventSource can't see a status (10-contracts §SSE and 401), so on a stream error the
//     wrapper re-probes GET /api/me; a 401 there calls `onUnauthorized`.
// The sign-in calls pass through untouched: their 401s mean wrong credentials (login), and the
// app handles `me` itself. changePassword is guarded: a wrong current password is a 400, so its
// 401 means the session is gone (TD-125).

/** The ApiClient calls whose 401 means "the session is gone". */
const GUARDED = [
  'getBoard',
  'getSession',
  'answer',
  'createTicket',
  'listRepos',
  'listWorkflows',
  'getWorkflow',
  'saveWorkflow',
  'approve',
  'cancel',
  'sendMessage',
  'listMachines',
  'getTranscript',
  'reopen',
  'transition',
  'listInvites',
  'createInvite',
  'revokeInvite',
  'listUsers',
  'createResetLink',
  'disableUser',
  'unlockUser',
  'changePassword',
  'getMachine',
  'renameMachine',
  'revokeMachine',
  'createEnrollmentToken',
] as const satisfies readonly (keyof ApiClient)[];

const PASSTHROUGH = [
  'me',
  'login',
  'logout',
  'signup',
  'previewInvite',
  'resetPassword',
] as const satisfies readonly (keyof ApiClient)[];

export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiRequestError && err.status === 401;

export function withAuthRedirect(api: ApiClient, onUnauthorized: () => void): ApiClient {
  let probing = false;
  const probe = () => {
    if (probing) return;
    probing = true;
    api.me().then(
      () => {
        probing = false;
      },
      (err: unknown) => {
        probing = false;
        if (isUnauthorized(err)) onUnauthorized();
      },
    );
  };

  const watchStream = <T>(handlers: StreamHandlers<T>): StreamHandlers<T> => ({
    ...handlers,
    onError: (err) => {
      handlers.onError?.(err);
      probe();
    },
  });

  // Methods are looked up on `api` per call, so a test (or dev hook) that replaces one later
  // still goes through the wrapper.
  const wrapped: ApiClient = {
    ...api,
    streamBoard: (lastEventId: number, handlers: StreamHandlers<BoardSseEvent>) =>
      api.streamBoard(lastEventId, watchStream(handlers)),
    streamOutput: (sessionId: string, handlers: StreamHandlers<OutputChunk>) =>
      api.streamOutput(sessionId, watchStream(handlers)),
  };
  for (const key of PASSTHROUGH) {
    (wrapped as unknown as Record<string, unknown>)[key] = (...args: unknown[]) =>
      (api[key] as (...a: unknown[]) => Promise<unknown>).apply(api, args);
  }
  for (const key of GUARDED) {
    (wrapped as unknown as Record<string, unknown>)[key] = (...args: unknown[]) =>
      (api[key] as (...a: unknown[]) => Promise<unknown>).apply(api, args).catch((err: unknown) => {
        if (isUnauthorized(err)) onUnauthorized();
        throw err;
      });
  }
  return wrapped;
}
