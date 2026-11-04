// Questions UX (06 §Agent question options): the choices an agent attached to its `ask_user`
// question, as a numbered list of buttons like Claude Code's own question prompt. Single select:
// one click answers with the label. Multi-select: checkboxes and "Submit (n)", the labels joined
// with ", ". Digits 1–n pick an option while focus is in the list; ↑/↓ move between options.
// "Type a different answer" hands off to the composer. The answer posts through `onAnswer`.
import { questionOptionsAnswer, type QuestionOptions as Options } from '@conductor/shared';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../api/client.js';
import './QuestionOptions.css';

interface QuestionOptionsProps {
  options: Options;
  /** Posts the answer text; a rejection shows as an error under the list. */
  onAnswer: (answer: string) => Promise<unknown>;
  /** "Type a different answer": focus the composer. Absent: the row is not shown. */
  onTypeInstead?: () => void;
  /** Disabled from outside (another action of the request is running). */
  disabled?: boolean;
}

export function QuestionOptions({
  options,
  onAnswer,
  onTypeInstead,
  disabled,
}: QuestionOptionsProps) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not `busy`: two clicks before a re-render must still post once.
  const inflight = useRef(false);
  const list = useRef<HTMLOListElement>(null);
  const ids = useId();
  const multi = options.multi_select;
  const off = busy || disabled === true;

  async function post(labels: readonly string[]) {
    if (inflight.current || labels.length === 0) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(questionOptionsAnswer(labels));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function toggle(label: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function pick(index: number) {
    const item = options.items[index];
    if (item === undefined || off) return;
    if (multi) toggle(item.label);
    else void post([item.label]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLOListElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < options.items.length) {
        e.preventDefault();
        pick(i);
        list.current?.querySelectorAll<HTMLElement>('[data-option]')[i]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const els = [...(list.current?.querySelectorAll<HTMLElement>('[data-option]') ?? [])];
      const at = els.findIndex((el) => el === document.activeElement);
      if (at === -1) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      els[(at + step + els.length) % els.length]?.focus();
    }
  }

  // Ordered selection for the answer: the agent's order, not the click order.
  const selected = options.items.map((o) => o.label).filter((l) => chosen.has(l));

  return (
    <div className="question-options">
      <ol
        ref={list}
        className="question-options-list"
        aria-label={multi ? 'Choose one or more options' : 'Choose an option'}
        onKeyDown={onKeyDown}
      >
        {options.items.map((o, i) => {
          const descId = o.description !== undefined ? `${ids}-d${i}` : undefined;
          const body = (
            <>
              <span className="question-option-key" aria-hidden="true">
                {i + 1}.
              </span>
              <span className="question-option-text">
                <span className="question-option-label">{o.label}</span>
                {o.description !== undefined && (
                  <span id={descId} className="question-option-description">
                    {o.description}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={o.label}>
              {multi ? (
                <label className={`question-option${chosen.has(o.label) ? ' chosen' : ''}`}>
                  <input
                    type="checkbox"
                    data-option
                    checked={chosen.has(o.label)}
                    disabled={off}
                    aria-describedby={descId}
                    onChange={() => toggle(o.label)}
                  />
                  {body}
                </label>
              ) : (
                <button
                  type="button"
                  className="question-option"
                  data-option
                  disabled={off}
                  aria-describedby={descId}
                  onClick={() => void post([o.label])}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <div className="question-options-foot">
        {multi && (
          <button
            type="button"
            className="primary"
            disabled={off || selected.length === 0}
            onClick={() => void post(selected)}
          >
            Submit ({selected.length})
          </button>
        )}
        {onTypeInstead && (
          <button type="button" className="link" onClick={onTypeInstead}>
            Type a different answer
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
