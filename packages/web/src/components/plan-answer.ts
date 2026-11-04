// 06 §Plan approval: the one post behind Approve plan and Request changes… (the session panel's
// PlanApprovalRequest and the board card's actions): a transition request (`planApproveRequest`,
// `planChangesRequest`), once at a time, with its busy state and error.
import type { TransitionSessionRequest } from '@conductor/shared';
import { useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';

export interface PlanAnswer {
  busy: boolean;
  error: string | null;
  /** Posts `req`; true when it went through (false: in flight or failed). */
  post: (req: TransitionSessionRequest) => Promise<boolean>;
  clearError: () => void;
}

export function usePlanAnswer(api: ApiClient, sessionId: string, onDone?: () => void): PlanAnswer {
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function post(req: TransitionSessionRequest): Promise<boolean> {
    if (inflight.current) return false;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.transition(sessionId, req);
      onDone?.();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return { busy, error, post, clearError: () => setError(null) };
}
