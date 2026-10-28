// The session's live output, laid out like the Claude Code UI: agent text as markdown, each tool
// call one collapsible row with its result nested under it, edits as diffs, command output as
// terminal blocks. Chunks arrive as the daemon's stream (`assistant`, `tool_use` = "Name {json}",
// `tool_result`, `stdout`/`stderr` from command states, `debug`, and `user`: a message the human
// sent from the panel, ADR-0007); a result belongs to the oldest call still waiting for one (calls
// and results arrive in order, parallel calls included). Runs of tool calls between the agent's
// words collapse into one summary row (`buildThread`), each command run's output into one
// collapsed "Check output" row (UX-6, CheckOutput.tsx), and the session's moves, when given, show
// as phase dividers at their time.
import type { BoardChecking, MoveDto, OutputChunk, WorkflowDefinition } from '@conductor/shared';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { displayState } from '../workflow/review.js';
import {
  CheckRun,
  checkNames,
  countLines,
  runMarker,
  runName,
  runStatus,
  type RunSegment,
} from './CheckOutput.js';
import { Markdown } from './markdown.js';
import './OutputLog.css';

export interface ToolCall {
  name: string;
  input: Record<string, unknown> | null;
  raw: string;
}

/** `ts` is the time of the entry's first chunk. */
export type Entry =
  | { kind: 'text'; key: string; ts: string; text: string }
  | { kind: 'user'; key: string; ts: string; text: string }
  | { kind: 'tool'; key: string; ts: string; call: ToolCall; result: string | null }
  | { kind: 'stream'; key: string; ts: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'debug'; key: string; ts: string; text: string };

export type ToolEntry = Extract<Entry, { kind: 'tool' }>;

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
  const waiting: ToolEntry[] = [];
  // Keyed by position: the list only grows at the end, and transcript history (ADR-0008) has its
  // own seq numbering, so seq alone is not unique once history precedes the ring's chunks.
  for (const [i, c] of chunks.entries()) {
    const key = String(i);
    const ts = c.ts;
    const prev = out.at(-1);
    switch (c.stream) {
      case 'assistant':
        if (c.text.trim() !== '') out.push({ kind: 'text', key, ts, text: c.text });
        // TD-085: pairing is by order (chunks carry no tool_use_id). The model only speaks
        // again after a batch's results are in, so a lost result can't shift later batches.
        waiting.length = 0;
        break;
      case 'tool_use': {
        const entry: ToolEntry = {
          kind: 'tool',
          key,
          ts,
          call: parseToolUse(c.text),
          result: null,
        };
        out.push(entry);
        waiting.push(entry);
        break;
      }
      case 'tool_result': {
        const call = waiting.shift();
        if (call) call.result = c.text;
        else out.push({ kind: 'stream', key, ts, stream: 'stdout', text: c.text });
        break;
      }
      case 'stdout':
      case 'stderr':
        if (prev?.kind === 'stream' && prev.stream === c.stream) prev.text += c.text;
        else out.push({ kind: 'stream', key, ts, stream: c.stream, text: c.text });
        break;
      case 'debug':
        if (prev?.kind === 'debug') prev.text += `\n${c.text}`;
        else out.push({ kind: 'debug', key, ts, text: c.text });
        break;
      case 'user':
        // One chunk = one message. Tool pairing is untouched: the message lands mid-turn.
        if (c.text.trim() !== '') out.push({ kind: 'user', key, ts, text: c.text });
        break;
    }
  }
  return out;
}

/** Strip the session worktree from paths and commands (macOS reports it with or without /private). */
export function shortener(worktree: string | null): (s: string) => string {
  if (!worktree) return (s) => s;
  if (/^[A-Za-z]:[\\/]/.test(worktree)) {
    // A Windows daemon (MW-T02): tools report the worktree with `\` or `/`.
    const win = worktree.replace(/[\\/]+$/, '');
    const roots = [win.replace(/\//g, '\\'), win.replace(/\\/g, '/')];
    return (s) => {
      let r = s;
      for (const root of roots) {
        r = r.split(`${root}\\`).join('').split(`${root}/`).join('').split(root).join('.');
      }
      return r;
    };
  }
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

/**
 * Did the call fail? TD: tool_result chunks carry no is_error (the daemon passes only the text),
 * so failure is read from the text: Claude Code's non-zero Bash exit, tool errors, hook refusals.
 */
export function isFailedResult(result: string | null): boolean {
  if (result === null) return false;
  const text = result.trim();
  return (
    /^Exit code [1-9]\d*/.test(text) ||
    /^Error\b/i.test(text) ||
    text.startsWith('<tool_use_error>') ||
    /hook error/i.test(text.split('\n')[0] ?? '')
  );
}

/** ask_user, complete_state and other conductor calls: always shown on their own. */
const isConductorCall = (e: ToolEntry) => e.call.name.startsWith('mcp__conductor__');

export type ThreadItem =
  | { kind: 'entry'; entry: Entry }
  | { kind: 'group'; key: string; tools: ToolEntry[]; failed: ToolEntry[] }
  | { kind: 'phase'; key: string; move: MoveDto }
  | {
      kind: 'run';
      key: string;
      name: string;
      segments: RunSegment[];
      lines: number;
      /** Another run started right after this one (so this one passed, `runStatus`). */
      followed: boolean;
    };

type RunItem = Extract<ThreadItem, { kind: 'run' }>;

/**
 * The rows of the thread. With `moves`, a divider goes before the first entry at or after each
 * move's time. With `group`, each run of 2+ tool calls (conductor calls excepted) becomes one
 * group, each command run's stdout/stderr one `run` (UX-6), and debug entries are dropped
 * (they're hidden then anyway); without it, every entry is its own row, as before grouping
 * existed. `workflow` names the runs (its checks by command, else the command state).
 */
export function buildThread(
  entries: readonly Entry[],
  {
    moves,
    group,
    workflow,
  }: {
    moves?: readonly MoveDto[] | undefined;
    group: boolean;
    workflow?: WorkflowDefinition | undefined;
  },
): ThreadItem[] {
  const out: ThreadItem[] = [];
  let toolRun: ToolEntry[] = [];
  // The command run being collected (UX-6). TD: inferred from the daemon's debug markers.
  let cmdRun: RunItem | null = null;
  // Read through a function: TS would keep `cmdRun` narrowed to null (closures assign it).
  const current = (): RunItem | null => cmdRun;
  const names = group ? checkNames(workflow) : new Map<string, string>();
  const flushTools = () => {
    if (toolRun.length === 1) out.push({ kind: 'entry', entry: toolRun[0]! });
    else if (toolRun.length > 1) {
      out.push({
        kind: 'group',
        key: `g${toolRun[0]!.key}`,
        tools: toolRun,
        failed: toolRun.filter((t) => isFailedResult(t.result)),
      });
    }
    toolRun = [];
  };
  const closeRun = () => {
    if (cmdRun) cmdRun.lines = countLines(cmdRun.segments);
    cmdRun = null;
  };
  const flush = () => {
    flushTools();
    closeRun();
  };
  const openRun = (key: string, name: string) => {
    flushTools();
    cmdRun = { kind: 'run', key, name, segments: [], lines: 0, followed: false };
    out.push(cmdRun);
    return cmdRun;
  };
  let m = 0;
  const phasesUntil = (ts: number) => {
    while (moves && m < moves.length && Date.parse(moves[m]!.at) <= ts) {
      flush();
      out.push({ kind: 'phase', key: `p${m}`, move: moves[m]! });
      m++;
    }
  };
  for (const e of entries) {
    phasesUntil(Date.parse(e.ts));
    if (group && e.kind === 'debug') {
      const marker = runMarker(e.text);
      if (marker) {
        const prev = current();
        if (prev) prev.followed = true;
        closeRun();
        openRun(`r${e.key}`, runName(marker, names));
      }
      continue;
    }
    if (group && e.kind === 'stream') {
      const run =
        current() ?? openRun(`r${e.key}`, runName(null, names, workflow, moves?.[m - 1]?.to));
      run.segments.push({ stream: e.stream, text: e.text });
      continue;
    }
    if (group && e.kind === 'tool' && !isConductorCall(e)) {
      closeRun();
      toolRun.push(e);
      continue;
    }
    flush();
    out.push({ kind: 'entry', entry: e });
  }
  phasesUntil(Infinity);
  flush();
  return out;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const SUMMARIZED_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  ...EDIT_TOOLS,
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
]);

/** "Read 3 files · searched 1 pattern · ran 2 commands · edited 2 files +4 −1 · running…" */
export function summarizeGroup(tools: readonly ToolEntry[]): string {
  const count = (names: string[]) => tools.filter((t) => names.includes(t.call.name)).length;
  // Distinct paths; a call whose input didn't parse counts on its own.
  const files = (names: string[], keys: string[]) => {
    const seen = new Set<string>();
    let unknown = 0;
    for (const t of tools) {
      if (!names.includes(t.call.name)) continue;
      const path = keys.map((k) => t.call.input?.[k]).find((v) => typeof v === 'string');
      if (typeof path === 'string') seen.add(path);
      else unknown++;
    }
    return seen.size + unknown;
  };
  const parts: string[] = [];
  const reads = files(['Read'], ['file_path']);
  if (reads > 0) parts.push(`read ${plural(reads, 'file')}`);
  const searches = count(['Grep', 'Glob']);
  if (searches > 0) parts.push(`searched ${plural(searches, 'pattern')}`);
  const commands = count(['Bash']);
  if (commands > 0) parts.push(`ran ${plural(commands, 'command')}`);
  const edits = tools.filter((t) => EDIT_TOOLS.has(t.call.name));
  if (edits.length > 0) {
    let part = `edited ${plural(files([...EDIT_TOOLS], ['file_path', 'notebook_path']), 'file')}`;
    const hunks = edits.map((t) => editHunks(t.call));
    if (hunks.every((h) => h !== null)) {
      const diff = hunks.flat().flatMap(diffLines);
      const added = diff.filter((l) => l.sign === '+').length;
      const removed = diff.filter((l) => l.sign === '-').length;
      const stat = [added > 0 && `+${added}`, removed > 0 && `−${removed}`].filter(Boolean);
      if (stat.length > 0) part += ` ${stat.join(' ')}`;
    }
    parts.push(part);
  }
  const fetches = count(['WebFetch']);
  if (fetches > 0) parts.push(`fetched ${plural(fetches, 'page')}`);
  const webSearches = count(['WebSearch']);
  if (webSearches > 0) {
    parts.push(`searched the web ${webSearches === 1 ? 'once' : `${webSearches} times`}`);
  }
  const agents = count(['Task', 'Agent']);
  if (agents > 0) parts.push(`ran ${plural(agents, 'agent')}`);
  if (count(['TodoWrite']) > 0) parts.push('updated todos');
  const other = tools.filter((t) => !SUMMARIZED_TOOLS.has(t.call.name)).length;
  if (other > 0) parts.push(`used ${other} other tool${other === 1 ? '' : 's'}`);
  if (tools.some((t) => t.result === null)) parts.push('running…');
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A state's display name: its workflow title, else `snake_case` as words; a gate step's label as
 * `displayState` words it (UX-6: never the synthetic "→ … (move: …)" label).
 */
export function phaseStateName(state: string, workflow?: WorkflowDefinition): string {
  const title = workflow?.states[state]?.title;
  if (title) return title;
  if (!/^[a-z0-9_]+$/.test(state)) return displayState(state, workflow);
  const words = state.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Planning → Implementing · plan_ready — <reason, first line>" (first move: "Started · Planning"). */
export function phaseLabel(move: MoveDto, workflow?: WorkflowDefinition): string {
  const to = phaseStateName(move.to, workflow);
  let label =
    move.from === null ? `Started · ${to}` : `${phaseStateName(move.from, workflow)} → ${to}`;
  if (move.from !== null && move.transition) label += ` · ${move.transition}`;
  if (move.reason) label += ` — ${firstLine(move.reason)}`;
  return label;
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

function ToolRow({ entry, short }: { entry: ToolEntry; short: (s: string) => string }) {
  const { call, result } = entry;
  // A failed call is never hidden (shown open, also inside a collapsed group).
  const failed = isFailedResult(result);
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
    <details
      className={`tool tool-${kind} tool-${state}${failed ? ' tool-failed' : ''}`}
      open={hunks !== null || failed}
    >
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

/** A run of tool calls as one summary row; its failed calls stay visible while collapsed. */
function ToolGroup({
  tools,
  failed,
  open,
  onToggle,
  short,
}: {
  tools: ToolEntry[];
  failed: ToolEntry[];
  open: boolean;
  onToggle: () => void;
  short: (s: string) => string;
}) {
  const bodyId = useId();
  return (
    <div className="tool-group" role="group" aria-label="Tool calls">
      <button
        type="button"
        className="tool-group-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="chev" aria-hidden="true">
          ▸
        </span>
        <span className="tool-group-text">{summarizeGroup(tools)}</span>
        {failed.length > 0 && <span className="tool-group-error">⚠ {failed.length} failed</span>}
      </button>
      <div id={bodyId} className="tool-group-body">
        {(open ? tools : failed).map((t) => (
          <ToolRow key={t.key} entry={t} short={short} />
        ))}
      </div>
    </div>
  );
}

/** Where the session changed state; the full reason on expand. */
function PhaseDivider({
  move,
  workflow,
}: {
  move: MoveDto;
  workflow?: WorkflowDefinition | undefined;
}) {
  const [open, setOpen] = useState(false);
  const label = phaseLabel(move, workflow);
  return (
    <div className="phase" role="group" aria-label={`Phase: ${label}`}>
      {move.reason ? (
        <button
          type="button"
          className="phase-label"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {label}
        </button>
      ) : (
        <span className="phase-label">{label}</span>
      )}
      {open && move.reason && <p className="phase-reason">{move.reason}</p>}
    </div>
  );
}

/** Scrolled up by more than this many viewports → offer "Jump to latest". */
const JUMP_AFTER_SCREENS = 1;

export interface OutputLogProps {
  output: readonly OutputChunk[];
  worktree: string | null;
  /**
   * `panel` (default): a titled "Live output" section with its own max height. `chat`: no title,
   * fills its container (the Messages tab), with a "Jump to latest" pill when scrolled up.
   */
  variant?: 'panel' | 'chat';
  /** Rendered after the last entry, inside the scroller (e.g. an open question). */
  children?: ReactNode;
  /** Changes whenever `children` changes size, so stick-to-bottom follows it. */
  tailKey?: string;
  /** False while the log is hidden (inactive tab): re-pins to the bottom when shown again. */
  visible?: boolean;
  /** SessionDetail.moves (oldest first): a phase divider at each move's time. None without it. */
  moves?: readonly MoveDto[] | undefined;
  /** The session's workflow, for state titles in the dividers (else names are humanised). */
  workflow?: WorkflowDefinition | undefined;
  /** UX-6: `card.checking`, for the status of the live step's check runs. */
  checking?: BoardChecking | null | undefined;
  /** UX-6: the check an open "Step failed" question names (its run shows as failed). */
  failedItem?: string | null | undefined;
  /** UX-6: conductor is running a command for the session now (the last run is "running"). */
  active?: boolean | undefined;
}

export function OutputLog({
  output,
  worktree,
  variant = 'panel',
  children,
  tailKey = '',
  visible = true,
  moves,
  workflow,
  checking,
  failedItem,
  active,
}: OutputLogProps) {
  const entries = useMemo(() => buildEntries(output), [output]);
  const short = useMemo(() => shortener(worktree), [worktree]);
  const [showDebug, setShowDebug] = useState(false);
  // Debug lines show everything ungrouped, as before grouping existed.
  const thread = useMemo(
    () => buildThread(entries, { moves, group: !showDebug, workflow }),
    [entries, moves, showDebug, workflow],
  );
  // The latest run of each name: the one a live check item or a failed question speaks for.
  const latestRun = useMemo(() => {
    const latest = new Map<string, string>();
    for (const item of thread) if (item.kind === 'run') latest.set(item.name, item.key);
    return latest;
  }, [thread]);
  // Open groups by key (the first call's position), so they stay open as output streams in.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const debugCount = entries.filter((e) => e.kind === 'debug').length;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Entry count when the reader scrolled away: the pill counts what arrived since.
  const [away, setAway] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [output.length, showDebug, tailKey, visible, expanded]);

  const chat = variant === 'chat';
  const newCount = away === null ? 0 : Math.max(0, entries.length - away);

  function jumpToLatest() {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setAway(null);
    if (typeof el.scrollTo === 'function')
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function renderEntry(e: Entry) {
    switch (e.kind) {
      case 'text':
        return (
          <div key={e.key} className="msg">
            <Markdown text={short(e.text)} />
          </div>
        );
      case 'user':
        return (
          <div key={e.key} className="user-msg" role="group" aria-label="Your message">
            <span className="user-label">You</span>
            <p className="user-text">{e.text}</p>
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
  }

  const debugToggle = debugCount > 0 && (
    <label className="debug-toggle">
      <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
      Debug lines
    </label>
  );

  return (
    <section aria-label="Output" className={chat ? 'output-chat' : undefined}>
      {chat ? (
        debugToggle && <div className="output-head output-head-chat">{debugToggle}</div>
      ) : (
        <div className="output-head">
          <h3>Live output</h3>
          {debugToggle}
        </div>
      )}
      <div className="output-wrap">
        <div
          ref={ref}
          className="output"
          role="log"
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            stick.current = fromBottom < 40;
            if (!chat) return;
            const far = fromBottom > el.clientHeight * JUMP_AFTER_SCREENS;
            if (far && away === null) setAway(entries.length);
            else if (!far && away !== null) setAway(null);
          }}
        >
          {entries.length === 0 && <p className="muted">No output yet.</p>}
          {thread.map((item, i) => {
            switch (item.kind) {
              case 'entry':
                return renderEntry(item.entry);
              case 'group':
                return (
                  <ToolGroup
                    key={item.key}
                    tools={item.tools}
                    failed={item.failed}
                    open={expanded.has(item.key)}
                    onToggle={() => toggle(item.key)}
                    short={short}
                  />
                );
              case 'phase':
                return <PhaseDivider key={item.key} move={item.move} workflow={workflow} />;
              case 'run':
                return (
                  <CheckRun
                    key={item.key}
                    name={item.name}
                    status={runStatus(
                      item,
                      {
                        latest: latestRun.get(item.name) === item.key,
                        last: i === thread.length - 1,
                      },
                      { checking, failedItem, active },
                    )}
                    segments={item.segments}
                    lines={item.lines}
                    open={expanded.has(item.key)}
                    onToggle={() => toggle(item.key)}
                  />
                );
            }
          })}
          {children}
        </div>
        {chat && away !== null && (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            ↓ Jump to latest
            {newCount > 0 && <span className="jump-count"> · {newCount} new</span>}
          </button>
        )}
      </div>
    </section>
  );
}
