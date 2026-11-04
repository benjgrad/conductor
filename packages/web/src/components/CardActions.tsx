// Questions UX on the board card: answer an agent's question with one click (its options), and
// allow or deny a held permission prompt, without opening the session panel. The board stream
// moves the card afterwards, so nothing reloads here.
import type { BoardCard, InputRequestDto, PermissionDecisionRequest } from '@conductor/shared';
import { useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import './QuestionOptions.css';

/** At most this many options show as buttons on a card; more opens the panel instead. */
export const CARD_OPTIONS_MAX = 4;

/** Whether the card answers this request with option buttons (else "Answer…" opens the panel). */
export function cardAnswersInline(request: InputRequestDto): boolean {
  const o = request.options;
  return o != null && !o.multi_select && o.items.length <= CARD_OPTIONS_MAX;
}

/** One post at a time, its error shown under the buttons. */
function useOnePost() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  async function run(fn: () => Promise<unknown>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/**
 * The agent's options on the card: one button per option (single select, at most
 * CARD_OPTIONS_MAX), else "Answer…" which opens the session panel (the full list).
 */
export function CardQuestionOptions({
  api,
  sessionId,
  request,
  onOpen,
}: {
  api: ApiClient;
  sessionId: string;
  request: InputRequestDto;
  onOpen: () => void;
}) {
  const { busy, error, run } = useOnePost();
  const options = request.options;
  if (!options) return null;
  return (
    <div className="card-options" role="group" aria-label="Answer options">
      {cardAnswersInline(request) ? (
        options.items.map((o) => (
          <button
            key={o.label}
            type="button"
            disabled={busy}
            title={o.description ?? o.label}
            onClick={() =>
              void run(() =>
                api.answer(sessionId, { input_request_id: request.id, answer: o.label }),
              )
            }
          >
            {o.label}
          </button>
        ))
      ) : (
        <button type="button" className="primary" onClick={onOpen}>
          Answer…
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** ADR-0023 on the card: Allow once / Deny the oldest held prompt; Review opens the panel. */
export function CardPermissionActions({
  api,
  permission,
  onReview,
}: {
  api: ApiClient;
  permission: NonNullable<BoardCard['permission']>;
  onReview: () => void;
}) {
  const { busy, error, run } = useOnePost();
  const decide = (req: PermissionDecisionRequest) =>
    void run(() => api.decidePermission(permission.request_id, req));
  return (
    <div className="card-options" role="group" aria-label={`Permission for ${permission.tool}`}>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => decide({ behavior: 'allow', scope: 'once' })}
      >
        Allow once
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => decide({ behavior: 'deny', scope: 'once' })}
      >
        Deny
      </button>
      <button type="button" className="link" onClick={onReview}>
        Review
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
