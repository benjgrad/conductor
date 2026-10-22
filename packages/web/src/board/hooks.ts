import type { OutputChunk, SessionDetail } from '@conductor/shared';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { applyBoardEvent, boardFromResponse, EMPTY_BOARD, type BoardState } from './board.js';

type BoardAction =
  | { type: 'loaded'; state: BoardState }
  | { type: 'event'; event: Parameters<typeof applyBoardEvent>[1] };

function boardReducer(state: BoardState, action: BoardAction): BoardState {
  return action.type === 'loaded' ? action.state : applyBoardEvent(state, action.event);
}

/** GET /api/board, then the board stream from its last_event_id. */
export function useBoard(api: ApiClient): { board: BoardState; error: string | null } {
  const [board, dispatch] = useReducer(boardReducer, EMPTY_BOARD);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    api.getBoard().then(
      (res) => {
        if (cancelled) return;
        dispatch({ type: 'loaded', state: boardFromResponse(res) });
        stop = api.streamBoard(res.last_event_id, {
          onEvent: (event) => dispatch({ type: 'event', event }),
          onError: (err) => setError(errorMessage(err)),
        });
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [api]);

  return { board, error };
}

export interface SessionView {
  detail: SessionDetail | null;
  output: OutputChunk[];
  error: string | null;
  reload: () => void;
}

/**
 * GET /api/sessions/:id plus the live output stream while open. `version` refetches the detail
 * (the caller bumps it when the session's card changes on the board stream).
 */
export function useSession(api: ApiClient, sessionId: string, version: string): SessionView {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<{ sessionId: string; chunks: OutputChunk[] }>({
    sessionId,
    chunks: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    api.getSession(sessionId).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, version, nonce]);

  useEffect(
    () =>
      api.streamOutput(sessionId, {
        onEvent: (chunk) =>
          setLive((prev) =>
            prev.sessionId === sessionId
              ? { sessionId, chunks: [...prev.chunks, chunk] }
              : { sessionId, chunks: [chunk] },
          ),
        onError: (err) => setError(errorMessage(err)),
      }),
    [api, sessionId],
  );

  const current = detail?.card.session_id === sessionId ? detail : null;
  const snapshot = current?.recent_output ?? [];
  const lastSeq = snapshot.at(-1)?.seq ?? -1;
  // Live chunks overlap the snapshot after a refetch; seq is monotonic per session.
  const liveChunks = live.sessionId === sessionId ? live.chunks : [];
  const output = [...snapshot, ...liveChunks.filter((c) => c.seq > lastSeq)];
  return { detail: current, output, error, reload };
}
