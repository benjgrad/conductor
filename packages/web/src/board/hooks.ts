import type { OutputChunk, SessionDetail } from '@conductor/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
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
  // Stream trouble is transient: the client reconnects and onOpen clears it.
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    api.getBoard().then(
      (res) => {
        if (cancelled) return;
        dispatch({ type: 'loaded', state: boardFromResponse(res) });
        stop = api.streamBoard(res.last_event_id, {
          onEvent: (event) => dispatch({ type: 'event', event }),
          onError: (err) => setStreamError(errorMessage(err)),
          onOpen: () => setStreamError(null),
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

  return { board, error: error ?? streamError };
}

/** ADR-0008: where the Messages history came from when the live ring had nothing. */
export interface HistoryNotice {
  kind: 'loaded' | 'offline' | 'missing' | 'error';
  text: string;
}

export interface SessionView {
  detail: SessionDetail | null;
  /** Transcript history (if loaded), then the ring snapshot, then live chunks. */
  output: OutputChunk[];
  error: string | null;
  reload: () => void;
  /** Set once a transcript fetch was tried (the ring was empty when the panel opened). */
  history: HistoryNotice | null;
}

/** The quiet notice for a transcript fetch result (ADR-0008). */
export function historyNotice(machine: string, err: unknown): HistoryNotice {
  if (err instanceof ApiRequestError) {
    if (err.code === 'machine_offline') {
      return { kind: 'offline', text: `History unavailable: ${machine} is offline` };
    }
    if (err.code === 'no_transcript') return { kind: 'missing', text: 'No transcript found' };
  }
  return { kind: 'error', text: `History unavailable: ${errorMessage(err)}` };
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
  const [streamError, setStreamError] = useState<string | null>(null);
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
        onError: (err) => setStreamError(errorMessage(err)),
        onOpen: () => setStreamError(null),
      }),
    [api, sessionId],
  );

  const current = detail?.card.session_id === sessionId ? detail : null;
  const snapshot = current?.recent_output ?? [];
  const lastSeq = snapshot.at(-1)?.seq ?? -1;
  // Live chunks overlap the snapshot after a refetch; seq is monotonic per session.
  const liveChunks = live.sessionId === sessionId ? live.chunks : [];

  // ADR-0008: the output ring is in memory, so after an orchestrator restart it is empty. When
  // the panel opens on a session whose ring and live stream have nothing, load the history once
  // from Claude's transcript on its machine. Live chunks that arrive later are appended after it
  // TD: a chunk streamed between the transcript read and the stream's first chunk may show twice.
  const [history, setHistory] = useState<{
    sessionId: string;
    chunks: OutputChunk[];
    notice: HistoryNotice;
  } | null>(null);
  const tried = useRef<string | null>(null);
  const machine = current?.card.machine_id ?? null;
  const emptyRing = current !== null && snapshot.length === 0 && liveChunks.length === 0;
  useEffect(() => {
    if (!emptyRing || machine === null || tried.current === sessionId) return;
    tried.current = sessionId;
    // Not cancelled when live chunks start arriving: the history still goes before them. A
    // result for another session is ignored below (`past`).
    api.getTranscript(sessionId).then(
      (res) =>
        setHistory({
          sessionId,
          chunks: res.chunks,
          notice: {
            kind: 'loaded',
            text: `History loaded from Claude's transcript on ${res.machine_id}`,
          },
        }),
      (err: unknown) => setHistory({ sessionId, chunks: [], notice: historyNotice(machine, err) }),
    );
  }, [api, sessionId, emptyRing, machine]);

  const past = history?.sessionId === sessionId ? history : null;
  const output = [
    ...(past?.chunks ?? []),
    ...snapshot,
    ...liveChunks.filter((c) => c.seq > lastSeq),
  ];
  return {
    detail: current,
    output,
    error: error ?? streamError,
    reload,
    history: past?.notice ?? null,
  };
}
