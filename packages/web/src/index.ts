// @conductor/web: the kanban UI (M1-T09). The API seam is ./api/client.ts (mock now, HTTP in T09b).
export const PACKAGE_NAME = '@conductor/web';
export { App, type AppProps } from './App.js';
export { ApiRequestError, errorMessage } from './api/client.js';
export type { ApiClient, CancelSessionRequest, StreamHandlers, Unsubscribe } from './api/client.js';
export { createMockApi, type MockApi, type MockApiOptions } from './api/mock.js';
export {
  applyBoardEvent,
  boardColumns,
  boardFromResponse,
  type BoardState,
} from './board/board.js';
