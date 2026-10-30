import type { OutputChunk, SessionDetail, TranscriptResponse } from '@conductor/shared';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiRequestError, errorMessage, type ApiClient } from '../api/client.js';
import { initialPrompt } from '../brief/prompt.js';
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
  /**
   * UX-2: that fetch's initial prompt (null until it settles), and whether it is under way, so
   * useInitialPrompt doesn't fetch the transcript a second time.
   */
  historyPrompt: PromptResult | null;
  historyPending: boolean;
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

  // ADR-0008: the output ring is in memory, so after an orchestrator restart it is empty or holds
  // only what came since, and a long session can outgrow it. When the panel opens on a session
  // whose ring and live stream have nothing, or whose ring doesn't reach the start of the
  // conversation (`output_complete` false), load the history once from Claude's transcript on its
  // machine; only its part older than the ring's oldest conversation chunk is shown, before the
  // ring. TD-090: a chunk streamed between the transcript read and the stream's first chunk may
  // show twice.
  const [history, setHistory] = useState<{
    sessionId: string;
    chunks: OutputChunk[];
    notice: HistoryNotice;
    prompt: PromptResult;
  } | null>(null);
  const tried = useRef<string | null>(null);
  const machine = current?.card.machine_id ?? null;
  const emptyRing = current !== null && snapshot.length === 0 && liveChunks.length === 0;
  const needHistory = emptyRing || current?.output_complete === false;
  useEffect(() => {
    if (!needHistory || machine === null || tried.current === sessionId) return;
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
          prompt: promptOfTranscript(res),
        }),
      (err: unknown) =>
        setHistory({
          sessionId,
          chunks: [],
          notice: historyNotice(machine, err),
          prompt: { text: null, reason: promptUnavailable(machine, err) },
        }),
    );
  }, [api, sessionId, needHistory, machine]);

  const past = history?.sessionId === sessionId ? history : null;
  const recent = [...snapshot, ...liveChunks.filter((c) => c.seq > lastSeq)];
  const output = [...historyBefore(past?.chunks ?? [], recent), ...recent];
  return {
    detail: current,
    output,
    error: error ?? streamError,
    reload,
    history: past?.notice ?? null,
    historyPrompt: past?.prompt ?? null,
    historyPending: needHistory && machine !== null && past === null,
  };
}

/** Streams the transcript has too; command output (stdout, stderr) is only in the ring. */
const CONVERSATION_STREAMS: ReadonlySet<OutputChunk['stream']> = new Set([
  'assistant',
  'tool_use',
  'tool_result',
  'user',
]);

/**
 * The transcript chunks older than the ring's oldest conversation chunk (the ring has the rest),
 * or all of them when the ring has no conversation yet.
 */
export function historyBefore(transcript: OutputChunk[], ring: OutputChunk[]): OutputChunk[] {
  const first = ring.find((c) => CONVERSATION_STREAMS.has(c.stream));
  if (first === undefined) return transcript;
  const cutoff = Date.parse(first.ts);
  return transcript.filter((c) => Date.parse(c.ts) < cutoff);
}

/** UX-2: the agent's initial prompt (View prompt), or why it isn't available. */
export interface PromptResult {
  text: string | null;
  /** Why `text` is null. */
  reason: string | null;
}

export interface InitialPrompt extends PromptResult {
  loading: boolean;
}

function promptOfTranscript(res: TranscriptResponse): PromptResult {
  const text = initialPrompt(res.chunks);
  if (text !== null) return { text, reason: null };
  return {
    text: null,
    reason: res.truncated
      ? 'the transcript no longer reaches the first prompt'
      : 'no prompt in the transcript',
  };
}

function promptUnavailable(machine: string, err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'machine_offline') return `${machine} is offline`;
    if (err.code === 'no_transcript') return 'no transcript found';
  }
  return errorMessage(err);
}

/**
 * UX-2: the first prompt the agent received, from Claude's transcript (ADR-0008). Reuses the
 * history fetch of `useSession` when there was one (`view.historyPrompt`); otherwise fetches the
 * transcript once per session, and only while `enabled` (it can be large).
 */
export function useInitialPrompt(
  api: ApiClient,
  view: Pick<SessionView, 'detail' | 'historyPrompt' | 'historyPending'>,
  enabled: boolean,
): InitialPrompt {
  const { detail, historyPrompt, historyPending } = view;
  const sessionId = detail?.card.session_id ?? null;
  const machine = detail?.card.machine_id ?? null;
  const [fetched, setFetched] = useState<(PromptResult & { sessionId: string }) | null>(null);
  const tried = useRef<string | null>(null);
  const need =
    enabled && historyPrompt === null && !historyPending && sessionId !== null && machine !== null;
  useEffect(() => {
    if (!need || sessionId === null || machine === null || tried.current === sessionId) return;
    tried.current = sessionId;
    // TD: View prompt reads Claude's transcript (needs the machine online, and the 2 MB cap can
    // drop the start); an API field for the initial prompt would make it reliable.
    api.getTranscript(sessionId).then(
      (res) => setFetched({ sessionId, ...promptOfTranscript(res) }),
      (err: unknown) =>
        setFetched({ sessionId, text: null, reason: promptUnavailable(machine, err) }),
    );
  }, [api, need, sessionId, machine]);

  if (detail === null) return { text: null, reason: null, loading: true };
  if (historyPrompt) return { ...historyPrompt, loading: false };
  if (machine === null) {
    return { text: null, reason: "the session hasn't started on a machine yet", loading: false };
  }
  const mine = fetched?.sessionId === sessionId ? fetched : null;
  if (mine) return { text: mine.text, reason: mine.reason, loading: false };
  return { text: null, reason: null, loading: enabled || historyPending };
}
