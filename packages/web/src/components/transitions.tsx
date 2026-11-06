// ADR-0011 on the board: a pending move's "waiting for" checklist, the human transition buttons
// (Needs-input card and session panel), and the session's moves timeline.
import {
  engineMoveLabel,
  isEngineMove,
  transitionTitle,
  type BoardPending,
  type BoardPendingItem,
  type HumanTransitionOption,
  type MoveDto,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { displayState } from '../workflow/review.js';
import { humanize } from './format.js';
import { PresetChips } from './PresetChips.js';

type ItemStatus = BoardPendingItem['status'];

const ITEM_ICONS: Record<ItemStatus, string> = {
  met: '✓',
  failed: '✗',
  running: '◌',
  pending: '◻',
  todo: '◻',
  disabled: '–',
  unsupported: '?',
  skipped: '–',
};

const ITEM_STATUS_TEXT: Record<ItemStatus, string> = {
  met: 'met',
  failed: 'failed',
  running: 'checking',
  pending: 'not yet',
  todo: 'to do',
  disabled: 'disabled',
  unsupported: 'not supported yet',
  skipped: 'not checked (an earlier one is not met)',
};

const sameWords = (a: string, b: string) =>
  a.replace(/_/g, ' ').trim().toLowerCase() === b.replace(/_/g, ' ').trim().toLowerCase();

/** UXR-30 (FR-2): "4 of 6 checks done"; disabled items don't count. Null with none to count. */
export function pendingProgress(items: readonly BoardPendingItem[]): string | null {
  const counted = items.filter((i) => i.status !== 'disabled');
  if (counted.length === 0) return null;
  const met = counted.filter((i) => i.status === 'met').length;
  return `${met} of ${counted.length} checks done`;
}

/** UXR-30 (FR-2): "Moving to <column title> · <transition title>", the title said once. */
export function pendingHead(pending: Pick<BoardPending, 'to' | 'title'>, toTitle?: string): string {
  const to = toTitle ?? humanize(pending.to);
  return sameWords(pending.title, to) ? `Moving to ${to}` : `Moving to ${to} · ${pending.title}`;
}

/**
 * "Moving to Waiting external · Ready for testing — 4 of 6 checks done", then "✓ Tests pass ·
 * ✓ PR opened · ◻ approvals 0/1 · – pipeline": the card stays in its source column while a move's
 * requirements run. Disabled and unsupported items are greyed; the detail (evidence) is the hover
 * text. `toTitle`: the target column's title (default: `pending.to` humanized).
 */
export function PendingChecklist({
  pending,
  toTitle,
}: {
  pending: BoardPending;
  toTitle?: string;
}) {
  const head = pendingHead(pending, toTitle);
  const progress = pendingProgress(pending.items);
  return (
    <div className="pending-move" role="group" aria-label={head}>
      <span className="pending-move-head">
        <strong>{head}</strong>
        {progress && <span className="pending-progress muted"> · {progress}</span>}
      </span>
      <ul className="pending-items">
        {pending.items.map((item, i) => (
          <li
            key={`${i}-${item.label}`}
            className={`pending-item pending-item-${item.status}`}
            data-status={item.status}
            title={item.detail ?? ITEM_STATUS_TEXT[item.status]}
          >
            <span className="pending-icon" aria-hidden="true">
              {ITEM_ICONS[item.status]}
            </span>
            {item.label}
            <span className="visually-hidden"> ({ITEM_STATUS_TEXT[item.status]})</span>
          </li>
        ))}
      </ul>
      {pending.note && <p className="pending-note muted">{pending.note}</p>}
    </div>
  );
}

interface TransitionButtonsProps {
  api: ApiClient;
  sessionId: string;
  options: readonly HumanTransitionOption[];
  /** The session's workflow, to word the text prompt (event target: "who or what"). */
  workflow?: WorkflowDefinition;
  /** After a successful post (the board stream carries the card change either way). */
  onDone?: () => void;
}

/**
 * One button per `BoardCard.human_transitions` entry. A `needs_text` button opens a text box
 * first and won't post without text; the others post at once. Each posts exactly
 * `{name}` or `{name, text}` to /transition.
 */
export function TransitionButtons({
  api,
  sessionId,
  options,
  workflow,
  onDone,
}: TransitionButtonsProps) {
  const [open, setOpen] = useState<HumanTransitionOption | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const boxId = useId();

  async function post(option: HumanTransitionOption, body?: string) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.transition(
        sessionId,
        body === undefined ? { name: option.name } : { name: option.name, text: body },
      );
      setOpen(null);
      setText('');
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function choose(option: HumanTransitionOption) {
    setError(null);
    if (option.needs_text) {
      setOpen(option);
      setText('');
    } else {
      void post(option);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (open === null || body === '') return;
    void post(open, body);
  }

  if (options.length === 0) return null;
  const waits = open !== null && workflow?.states[open.goto]?.type === 'event';
  const prompt = waits ? 'Who or what is it waiting on?' : 'Your answer';
  return (
    <div className="transitions">
      <div className="transition-buttons" role="group" aria-label="Move to">
        {options.map((o) => (
          <button
            key={o.name}
            type="button"
            disabled={busy}
            aria-expanded={o.needs_text ? open?.name === o.name : undefined}
            title={o.needs_text ? `${o.title} (asks for text first)` : o.title}
            onClick={() => choose(o)}
          >
            {o.title}
            {o.needs_text && <span aria-hidden="true">…</span>}
          </button>
        ))}
      </div>
      {open && (
        <form className="transition-text" aria-label={open.title} onSubmit={submit}>
          <label htmlFor={boxId}>{prompt}</label>
          <PresetChips
            presets={open.presets}
            disabled={busy}
            onPick={(t) => {
              setText(t);
              document.getElementById(boxId)?.focus();
            }}
          />
          <textarea
            id={boxId}
            rows={2}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(null);
            }}
          />
          <span className="transition-text-actions">
            <button type="submit" disabled={busy || text.trim() === ''}>
              {open.title}
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => setOpen(null)}>
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

/** A state's display name: its title in the workflow, a gate step as words (UX-6), else as is. */
function stateName(workflow: WorkflowDefinition, state: string): string {
  return displayState(state, workflow);
}

/** The transition's title from the state it left, else the name humanised. */
// TD-183: a workflow's own transition named `fresh_conversation` would be mislabelled here.
export function moveTitle(workflow: WorkflowDefinition, move: MoveDto): string | null {
  // A route conductor took on its own (requirements not met, a failed step): in words, by its
  // ADR-0037 cause (an older row: its ENGINE_MOVE name).
  if (isEngineMove(move)) return engineMoveLabel(move);
  if (move.transition === null) return null;
  const from = move.from === null ? undefined : workflow.states[move.from];
  const t = from && 'on' in from ? from.on?.[move.transition] : undefined;
  return transitionTitle(move.transition, t);
}

export const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "<time> <from> → <to> · <title of transition> — <reason>", oldest first. */
export function MovesList({
  moves,
  workflow,
}: {
  moves: readonly MoveDto[];
  workflow: WorkflowDefinition;
}) {
  if (moves.length === 0) return <p className="muted">No moves yet.</p>;
  return (
    <ol className="moves">
      {moves.map((m, i) => {
        const title = moveTitle(workflow, m);
        return (
          <li key={`${m.at}-${i}`} className="move">
            <time dateTime={m.at} className="muted">
              {timeFormat.format(new Date(m.at))}
            </time>{' '}
            <span className="move-path">
              {m.from === null ? 'start' : stateName(workflow, m.from)} →{' '}
              {stateName(workflow, m.to)}
            </span>
            {title && <span className="move-title"> · {title}</span>}
            {m.reason && <span className="move-reason"> — {m.reason}</span>}
            {m.actor && <span className="move-actor muted"> ({m.actor})</span>}
          </li>
        );
      })}
    </ol>
  );
}
