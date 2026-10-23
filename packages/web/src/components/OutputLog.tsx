// The session's live output, laid out like the Claude Code UI: agent text as markdown, each tool
// call one collapsible row with its result nested under it, edits as diffs, command output as
// terminal blocks. Chunks arrive as the daemon's stream (`assistant`, `tool_use` = "Name {json}",
// `tool_result`, `stdout`/`stderr` from command states, `debug`); a result belongs to the oldest
// call still waiting for one (calls and results arrive in order, parallel calls included).
import type { OutputChunk } from '@conductor/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './markdown.js';

export interface ToolCall {
  name: string;
  input: Record<string, unknown> | null;
  raw: string;
}

export type Entry =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall; result: string | null }
  | { kind: 'stream'; key: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'debug'; key: string; text: string };

export function parseToolUse(text: string): ToolCall {
  const sp = text.indexOf(' ');
  const name = sp < 0 ? text : text.slice(0, sp);
  const raw = sp < 0 ? '' : text.slice(sp + 1);
  let input: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      input = v as Record<string, unknown>;
    }
  } catch {
    // truncated or not JSON: shown raw
  }
  return { name, input, raw };
}

export function buildEntries(chunks: readonly OutputChunk[]): Entry[] {
  const out: Entry[] = [];
  const waiting: Extract<Entry, { kind: 'tool' }>[] = [];
  for (const c of chunks) {
    const key = String(c.seq);
    const prev = out.at(-1);
    switch (c.stream) {
      case 'assistant':
        if (c.text.trim() !== '') out.push({ kind: 'text', key, text: c.text });
        break;
      case 'tool_use': {
        const entry = { kind: 'tool' as const, key, call: parseToolUse(c.text), result: null };
        out.push(entry);
        waiting.push(entry);
        break;
      }
      case 'tool_result': {
        const call = waiting.shift();
        if (call) call.result = c.text;
        else out.push({ kind: 'stream', key, stream: 'stdout', text: c.text });
        break;
      }
      case 'stdout':
      case 'stderr':
        if (prev?.kind === 'stream' && prev.stream === c.stream) prev.text += c.text;
        else out.push({ kind: 'stream', key, stream: c.stream, text: c.text });
        break;
      case 'debug':
        if (prev?.kind === 'debug') prev.text += `\n${c.text}`;
        else out.push({ kind: 'debug', key, text: c.text });
        break;
    }
  }
  return out;
}

/** Strip the session worktree from paths and commands (macOS reports it with or without /private). */
export function shortener(worktree: string | null): (s: string) => string {
  if (!worktree) return (s) => s;
  const base = worktree.replace(/\/+$/, '');
  // Longest first, so `/private/tmp/x` isn't cut at its `/tmp/x` suffix.
  const roots = [...new Set([base, base.replace(/^\/private(?=\/)/, ''), `/private${base}`])].sort(
    (a, b) => b.length - a.length,
  );
  return (s) => {
    let r = s;
    for (const root of roots) r = r.split(`${root}/`).join('').split(root).join('.');
    return r;
  };
}

const firstLine = (s: string, max = 120) => {
  const line = s.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function describeTool(
  call: ToolCall,
  short: (s: string) => string = (s) => s,
): { label: string; arg: string } {
  const i = call.input ?? {};
  const s = (k: string) => {
    const v = i[k];
    return typeof v === 'string' ? v : '';
  };
  switch (call.name) {
    case 'Bash':
      return { label: 'Bash', arg: firstLine(short(s('command'))) };
    case 'Read':
      return { label: 'Read', arg: short(s('file_path')) };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Update', arg: short(s('file_path')) };
    case 'NotebookEdit':
      return { label: 'Update', arg: short(s('notebook_path')) };
    case 'Write':
      return { label: 'Write', arg: short(s('file_path')) };
    case 'Grep':
      return {
        label: 'Search',
        arg: `pattern: "${s('pattern')}"${s('path') ? `, path: ${short(s('path'))}` : ''}`,
      };
    case 'Glob':
      return { label: 'Search', arg: `pattern: "${s('pattern')}"` };
    case 'WebFetch':
      return { label: 'Fetch', arg: s('url') };
    case 'WebSearch':
      return { label: 'Web search', arg: s('query') };
    case 'Task':
    case 'Agent':
      return { label: 'Agent', arg: s('description') };
    case 'Skill':
      return { label: 'Skill', arg: s('skill') };
    case 'TodoWrite':
      return { label: 'Update todos', arg: '' };
    case 'mcp__conductor__complete_state':
      return { label: 'Step complete', arg: '' };
    case 'mcp__conductor__ask_user':
      return { label: 'Asked a human', arg: firstLine(s('question')) };
    default: {
      const label = call.name.replace(/^mcp__/, '').replace(/__/g, ' · ');
      return { label, arg: firstLine(call.input ? JSON.stringify(call.input) : call.raw, 80) };
    }
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function resultSummary(
  call: ToolCall,
  result: string | null,
  short: (s: string) => string = (s) => s,
): string {
  if (result === null) return 'Running…';
  const text = short(result).replace(/\s+$/, '');
  if (text === '') return '(no output)';
  const lines = text.split('\n').length;
  if (call.name === 'Read') return `Read ${plural(lines, 'line')}`;
  // An edit's success message is boilerplate; say what changed instead (as Claude Code does).
  // Anything else (a hook refusal, "old_string not found") falls through and is shown.
  const hunks = editHunks(call);
  if (hunks && /successfully|has been updated/i.test(text)) {
    const diff = hunks.flatMap(diffLines);
    const added = diff.filter((l) => l.sign === '+').length;
    const removed = diff.filter((l) => l.sign === '-').length;
    if (call.name === 'Write') return `Wrote ${plural(added, 'line')}`;
    return [added > 0 && `Added ${plural(added, 'line')}`, removed > 0 && `removed ${removed}`]
      .filter(Boolean)
      .join(', ');
  }
  const head = firstLine(text.replace(/^\s+/, ''), 100);
  return lines > 1 ? `${head}  … +${lines - 1} lines` : head;
}

export interface Hunk {
  old: string;
  new: string;
}

/** The edit as old/new text pairs, or null when the call isn't an edit. */
export function editHunks(call: ToolCall): Hunk[] | null {
  const i = call.input;
  if (!i) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (call.name) {
    case 'Edit':
      return [{ old: str(i.old_string), new: str(i.new_string) }];
    case 'MultiEdit':
      return Array.isArray(i.edits)
        ? i.edits.map((e: unknown) => {
            const o = (e ?? {}) as Record<string, unknown>;
            return { old: str(o.old_string), new: str(o.new_string) };
          })
        : null;
    case 'Write':
      return [{ old: '', new: str(i.content) }];
    case 'NotebookEdit':
      return [{ old: '', new: str(i.new_source) }];
    default:
      return null;
  }
}

export interface DiffLine {
  sign: ' ' | '-' | '+';
  text: string;
}

/** A line diff of one hunk: shared leading/trailing lines (≤ 2 each) as context, the middle as -/+. */
export function diffLines(h: Hunk): DiffLine[] {
  const a = h.old === '' ? [] : h.old.split('\n');
  const b = h.new === '' ? [] : h.new.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const ctx = (lines: string[]) => lines.map((text) => ({ sign: ' ' as const, text }));
  return [
    ...ctx(a.slice(Math.max(0, pre - 2), pre)),
    ...a.slice(pre, a.length - suf).map((text) => ({ sign: '-' as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ sign: '+' as const, text })),
    ...ctx(a.slice(a.length - suf, Math.min(a.length, a.length - suf + 2))),
  ];
}

const DIFF_LIMIT = 20;

function Diff({ hunks }: { hunks: Hunk[] }) {
  const [all, setAll] = useState(false);
  const lines = hunks.flatMap((h, j) => [
    ...(j > 0 ? [{ sign: ' ' as const, text: '⋯' }] : []),
    ...diffLines(h),
  ]);
  const shown = all ? lines : lines.slice(0, DIFF_LIMIT);
  const added = lines.filter((l) => l.sign === '+').length;
  const removed = lines.filter((l) => l.sign === '-').length;
  return (
    <div className="diff">
      <div className="diff-stat">
        {added > 0 && <span className="diff-add-n">+{added}</span>}
        {removed > 0 && <span className="diff-del-n">−{removed}</span>}
      </div>
      <pre>
        {shown.map((l, j) => (
          <span key={j} className={l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : 'ctx'}>
            {`${l.sign} ${l.text}\n`}
          </span>
        ))}
      </pre>
      {lines.length > shown.length && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          Show {lines.length - shown.length} more lines
        </button>
      )}
    </div>
  );
}

function ToolRow({
  entry,
  short,
}: {
  entry: Extract<Entry, { kind: 'tool' }>;
  short: (s: string) => string;
}) {
  const { call, result } = entry;
  const { label, arg } = describeTool(call, short);
  const hunks = editHunks(call);
  const kind = hunks
    ? 'edit'
    : call.name.startsWith('mcp__conductor__')
      ? 'conductor'
      : call.name === 'Bash'
        ? 'bash'
        : 'tool';
  const state = result === null ? 'running' : 'done';
  return (
    <details className={`tool tool-${kind} tool-${state}`} open={hunks !== null}>
      <summary>
        <span className="tool-head">
          <span className="tool-label">{label}</span>
          {arg && <span className="tool-arg">({arg})</span>}
        </span>
        <span className="tool-sub">⎿ {resultSummary(call, result, short)}</span>
      </summary>
      <div className="tool-body">
        {hunks && <Diff hunks={hunks} />}
        {!hunks && call.name === 'Bash' && typeof call.input?.command === 'string' && (
          <pre className="tool-input">$ {short(call.input.command)}</pre>
        )}
        {!hunks && call.name !== 'Bash' && (
          <pre className="tool-input">
            {call.input ? short(JSON.stringify(call.input, null, 2)) : call.raw}
          </pre>
        )}
        {result !== null &&
          result.trim() !== '' &&
          (!hunks || !/successfully|has been updated/i.test(result)) && (
            <pre className="tool-result">{short(result.replace(/\s+$/, ''))}</pre>
          )}
      </div>
    </details>
  );
}

export function OutputLog({
  output,
  worktree,
}: {
  output: readonly OutputChunk[];
  worktree: string | null;
}) {
  const entries = useMemo(() => buildEntries(output), [output]);
  const short = useMemo(() => shortener(worktree), [worktree]);
  const [showDebug, setShowDebug] = useState(false);
  const debugCount = entries.filter((e) => e.kind === 'debug').length;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [output.length, showDebug]);

  return (
    <section aria-label="Output">
      <div className="output-head">
        <h3>Live output</h3>
        {debugCount > 0 && (
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
            />
            Debug lines
          </label>
        )}
      </div>
      <div
        ref={ref}
        className="output"
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {entries.length === 0 && <p className="muted">No output yet.</p>}
        {entries.map((e) => {
          switch (e.kind) {
            case 'text':
              return (
                <div key={e.key} className="msg">
                  <Markdown text={short(e.text)} />
                </div>
              );
            case 'tool':
              return <ToolRow key={e.key} entry={e} short={short} />;
            case 'stream':
              return (
                <pre key={e.key} className={`term out-${e.stream}`}>
                  {e.text}
                </pre>
              );
            case 'debug':
              return showDebug ? (
                <pre key={e.key} className="out-debug">
                  {e.text}
                </pre>
              ) : null;
          }
        })}
      </div>
    </section>
  );
}
