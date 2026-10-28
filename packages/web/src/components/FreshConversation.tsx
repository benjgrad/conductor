// "Start fresh conversation…" (10-contracts §Fresh conversation, 06 §Start fresh conversation):
// the self-service escape hatch for an agent that can't resume its Claude conversation. Offered
// on the open request of a session parked in a human state whose `return_to` is an agent state.
import type { InputRequestDto, SessionDetail } from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { classifyRequest, lastMoveTransition } from './request-preview.js';

export const FRESH_CONVERSATION_LABEL = 'Start fresh conversation';

export const FRESH_CONVERSATION_HELP =
  "The agent starts over with its instructions and your message, without its earlier chat. Use this when it can't resume (e.g. it moved to another machine or keeps failing on start).";

/**
 * Whether to offer it, and how: `prominent` for a failure (retries exhausted, or a failed step),
 * the stuck cases; `secondary` for any other request while parked with an agent to return to;
 * `none` otherwise (apply would ignore it: 409).
 */
export function freshConversationOffer(
  detail: Pick<SessionDetail, 'card' | 'workflow' | 'return_to' | 'moves'>,
  request: Pick<InputRequestDto, 'kind' | 'question' | 'origin_transition' | 'step_failed'>,
): 'none' | 'secondary' | 'prominent' {
  const { card, workflow } = detail;
  const state = card.workflow_state ? workflow.states[card.workflow_state] : undefined;
  const back = detail.return_to ? workflow.states[detail.return_to] : undefined;
  if (card.status !== 'needs_input' || state?.type !== 'human' || back?.type !== 'agent') {
    return 'none';
  }
  const failed =
    request.kind === 'retries_exhausted' ||
    classifyRequest(request, lastMoveTransition(detail)) === 'step_failed';
  return failed ? 'prominent' : 'secondary';
}

interface FreshConversationProps {
  api: ApiClient;
  sessionId: string;
  prominent: boolean;
  onDone: () => void;
}

/** A button that opens a required text box; posts `{text}` to /fresh-conversation. */
export function FreshConversation({ api, sessionId, prominent, onDone }: FreshConversationProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (body === '' || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.freshConversation(sessionId, { text: body });
      setOpen(false);
      setText('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={`fresh-conversation${prominent ? ' fresh-conversation-prominent' : ''}`}>
      {!open && (
        <button
          type="button"
          className={
            prominent ? 'fresh-conversation-button prominent' : 'fresh-conversation-button'
          }
          title={FRESH_CONVERSATION_HELP}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          {FRESH_CONVERSATION_LABEL}…
        </button>
      )}
      {open && (
        <form
          className="transition-text"
          aria-label={FRESH_CONVERSATION_LABEL}
          onSubmit={(e) => void submit(e)}
        >
          <label htmlFor={`${ids}-text`}>Your message to the agent</label>
          <p id={`${ids}-help`} className="muted fresh-conversation-help">
            {FRESH_CONVERSATION_HELP}
          </p>
          <textarea
            id={`${ids}-text`}
            rows={3}
            required
            value={text}
            autoFocus
            aria-describedby={`${ids}-help`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <span className="transition-text-actions">
            <button type="submit" disabled={busy || text.trim() === ''}>
              {FRESH_CONVERSATION_LABEL}
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => setOpen(false)}>
              Back
            </button>
          </span>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
