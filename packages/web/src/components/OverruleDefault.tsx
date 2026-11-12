// ADR-0041: no human answered a question in time, so conductor gave the agent's recommended
// answer. From the timeline, a human can overrule it: the text reaches the agent as a correction
// (a live message, or after its pending answer). Offered while `detail.overrulable` names the
// request; the server answers 409 once the agent has moved on.
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';

export const OVERRULE_LABEL = 'Overrule';

interface OverruleDefaultProps {
  api: ApiClient;
  sessionId: string;
  inputRequestId: string;
  onDone: () => void;
}

/** A button that opens a required text box; posts `{input_request_id, text}` to /overrule. */
export function OverruleDefault({ api, sessionId, inputRequestId, onDone }: OverruleDefaultProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const ids = useId();

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const body = text.trim();
    if (body === '' || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.overruleDefault(sessionId, { input_request_id: inputRequestId, text: body });
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
    <div className="overrule-default">
      {!open && (
        <button
          type="button"
          className="link"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          {OVERRULE_LABEL}…
        </button>
      )}
      {open && (
        <form
          className="transition-text"
          aria-label={OVERRULE_LABEL}
          onSubmit={(e) => void submit(e)}
        >
          <label htmlFor={`${ids}-text`}>What should the agent do instead?</label>
          <textarea
            id={`${ids}-text`}
            rows={3}
            required
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <span className="transition-text-actions">
            <button type="submit" disabled={busy || text.trim() === ''}>
              {OVERRULE_LABEL}
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
