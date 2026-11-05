// Questions UX on the board card: answer an agent's question with one click (its recommended
// option), or allow a held permission prompt, without opening the session panel (UXR-33: one
// action per card; the panel has the rest). The board stream
// moves the card afterwards, so nothing reloads here.
import type {
  BoardCard,
  InputRequestDto,
  PermissionDecisionRequest,
  QuestionOption,
} from '@conductor/shared';
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

/** UXR-33: the agent's first (recommended) option as the card's one button. */
export function CardOptionButton({
  api,
  sessionId,
  request,
  option,
}: {
  api: ApiClient;
  sessionId: string;
  request: InputRequestDto;
  option: QuestionOption;
}) {
  const { busy, error, run } = useOnePost();
  return (
    <div className="card-options" role="group" aria-label="Answer options">
      <button
        type="button"
        className="primary"
        disabled={busy}
        title={option.description ?? option.label}
        onClick={() =>
          void run(() =>
            api.answer(sessionId, { input_request_id: request.id, answer: option.label }),
          )
        }
      >
        {option.label}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * ADR-0023 on the card, UXR-33: Allow once for the oldest held prompt. Deny, Allow always and the
 * deny note are in the session panel (the card's title opens it).
 */
export function CardAllowOnce({
  api,
  permission,
}: {
  api: ApiClient;
  permission: NonNullable<BoardCard['permission']>;
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
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
