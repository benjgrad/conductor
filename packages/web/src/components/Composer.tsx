// The Messages composer: answers an open input request, else messages the running agent
// (ADR-0007), else is disabled with the reason. A `/` at the start opens the slash menu.
import type { SessionDetail } from '@conductor/shared';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { TERMINAL_STATUSES } from './format.js';
import {
  availableCommands,
  CONDUCTOR_COMMANDS,
  CLAUDE_COMMANDS,
  filterCommands,
  isConductorCommand,
  parseSlash,
  slashQuery,
  type SlashCommand,
} from './slash-commands.js';

export type ComposerMode =
  { mode: 'answer' } | { mode: 'message' } | { mode: 'off'; reason: string };

/** What the composer can do for this session right now. */
export function composerMode(detail: SessionDetail): ComposerMode {
  const { card } = detail;
  if (detail.pending_input) return { mode: 'answer' };
  const status = card.status;
  if (status === null || status === 'queued' || status === 'assigned') {
    return { mode: 'off', reason: 'Queued — the agent hasn’t started' };
  }
  if (TERMINAL_STATUSES.has(status)) return { mode: 'off', reason: 'Session finished' };
  if (status === 'waiting_external') {
    return { mode: 'off', reason: 'Waiting on an external event — no agent running' };
  }
  if (status === 'running') {
    const state = card.workflow_state ? detail.workflow.states[card.workflow_state] : undefined;
    if (state?.type === 'agent') return { mode: 'message' };
    return {
      mode: 'off',
      reason: `No agent in this step: ${card.workflow_state ?? 'it'} runs a ${state?.type ?? 'step'}`,
    };
  }
  return { mode: 'off', reason: 'Waiting for input' };
}

/** Textarea grows to about this many lines, then scrolls. */
const MAX_LINES = 6;

interface ComposerProps {
  api: ApiClient;
  detail: SessionDetail;
  agentName: string;
  onDone: () => void;
  onShowDetails: () => void;
}

export function Composer({ api, detail, agentName, onDone, onShowDetails }: ComposerProps) {
  const sessionId = detail.card.session_id;
  const request = detail.pending_input;
  const m = composerMode(detail);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [help, setHelp] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const ids = useId();
  const listId = `${ids}-slash`;
  const inputId = `${ids}-input`;

  const status = detail.card.status;
  const commands = availableCommands({
    canMessage: m.mode === 'message',
    canCancel: sessionId !== null && status !== null && !TERMINAL_STATUSES.has(status),
    canRetry: request !== null && request.kind !== 'agent_question',
  });
  const query = slashQuery(text);
  const items = query === null || dismissed ? [] : filterCommands(commands, query);
  const menuOpen = items.length > 0 && m.mode !== 'off';
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || el.scrollHeight === 0) return; // jsdom: no layout
    el.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 16)}px`;
  }, [text]);

  function change(next: string) {
    setText(next);
    setDismissed(false);
    setActive(0);
  }

  async function call(fn: () => Promise<unknown>, clear = true) {
    // A ref, not `busy`: two Enters before a re-render must still send once.
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (clear) setText('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function deliver(body: string) {
    if (sessionId === null) return;
    if (request) {
      void call(() => api.answer(sessionId, { input_request_id: request.id, answer: body }));
    } else if (m.mode === 'message') {
      void call(() => api.sendMessage(sessionId, { text: body }));
    }
  }

  function runCommand(cmd: SlashCommand, rest = '') {
    setError(null);
    setDismissed(true);
    if (cmd.kind === 'claude') {
      deliver(rest ? `/${cmd.name} ${rest}` : `/${cmd.name}`);
      return;
    }
    switch (cmd.name) {
      case 'cancel':
        setText('');
        setHelp(false);
        setConfirmCancel(true);
        return;
      case 'retry':
        if (sessionId !== null && request) {
          // No goto: input.provided returns to return_to, else the workflow start (U-037).
          void call(() => api.answer(sessionId, { input_request_id: request.id, answer: 'retry' }));
        }
        return;
      case 'details':
        setText('');
        onShowDetails();
        return;
      case 'help':
        setText('');
        setConfirmCancel(false);
        setHelp(true);
        return;
    }
  }

  function submit() {
    if (busy || m.mode === 'off') return;
    if (menuOpen) {
      runCommand(items[activeIndex]!);
      return;
    }
    const body = text.trim();
    if (body === '') return;
    const slash = parseSlash(body);
    if (slash && isConductorCommand(slash.name)) {
      const cmd = commands.find((c) => c.name === slash.name);
      if (cmd) runCommand(cmd, slash.rest);
      else setError(`/${slash.name} isn’t available right now`);
      return;
    }
    deliver(body);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = items[activeIndex]!;
        // Claude Code commands may take arguments: complete the name. Ours just run.
        if (cmd.kind === 'claude') change(`/${cmd.name} `);
        else runCommand(cmd);
        return;
      }
    }
    if (e.key === 'Escape' && (help || confirmCancel)) {
      setHelp(false);
      setConfirmCancel(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const answering = m.mode === 'answer';
  const label = answering ? 'Answer' : 'Message';
  const placeholder =
    m.mode === 'off'
      ? m.reason
      : answering
        ? 'Answer the question… (Enter to send, Shift+Enter for a new line)'
        : `Message ${agentName}… (/ for commands)`;

  return (
    <div className="composer">
      {confirmCancel && sessionId !== null && (
        <div className="composer-note confirm" role="group" aria-label="Confirm cancel">
          <span>Cancel this session? The agent stops and the card moves to Failed.</span>
          <span className="confirm-buttons">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void call(async () => {
                  await api.cancel(sessionId, { reason: 'cancelled from UI' });
                  setConfirmCancel(false);
                })
              }
            >
              Cancel session
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmCancel(false)}>
              Keep running
            </button>
          </span>
        </div>
      )}
      {help && (
        <div className="composer-note help" role="region" aria-label="Commands">
          <div className="help-head">
            <strong>Commands</strong>
            <button
              type="button"
              className="link"
              aria-label="Close commands"
              onClick={() => setHelp(false)}
            >
              ×
            </button>
          </div>
          <ul>
            {[...CONDUCTOR_COMMANDS, ...CLAUDE_COMMANDS].map((c) => (
              <li key={c.name}>
                <code>/{c.name}</code> {c.description}
                {c.kind === 'claude' && <span className="slash-tag">sent to Claude</span>}
              </li>
            ))}
          </ul>
          <p className="muted">Any other /command is sent to Claude as typed.</p>
        </div>
      )}
      {menuOpen && (
        <ul className="slash-menu" role="listbox" id={listId} aria-label="Slash commands">
          {items.map((c, i) => (
            <li
              key={c.name}
              id={`${listId}-${c.name}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runCommand(c)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
              {c.kind === 'claude' && <span className="slash-tag">sent to Claude</span>}
            </li>
          ))}
        </ul>
      )}
      <div className={`composer-box${m.mode === 'off' ? ' off' : ''}`}>
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        <textarea
          ref={box}
          id={inputId}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={m.mode === 'off'}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={menuOpen ? `${listId}-${items[activeIndex]!.name}` : undefined}
        />
        <button
          type="button"
          className="send"
          aria-label={answering ? 'Send answer' : 'Send'}
          title={answering ? 'Send answer' : 'Send'}
          disabled={busy || m.mode === 'off' || text.trim() === ''}
          onClick={submit}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {m.mode === 'off' && <p className="composer-reason muted">{m.reason}</p>}
      {error && (
        <p role="alert" className="error composer-error">
          {error}
        </p>
      )}
    </div>
  );
}
