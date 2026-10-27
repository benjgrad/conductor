// UX-6: conductor's command output (a check's or a command state's stdout/stderr) as one
// collapsed row per run in the thread: "Check output · <name> (<status>) · <n> lines ▸". Expanded,
// the output flows at full height (no inner scroll box), ANSI stripped, with a Copy button.
//
// TD: chunks carry no command id, name or status, so a run is inferred: the daemon's debug marker
// before each fresh-checkout check (daemon.ts runCmd: "conductor: `<cmd>` in a fresh checkout of
// <sha>", and "conductor: setup `<cmd>` …") starts one, and any other entry or a phase divider
// ends it. Its name comes from the workflow's checks by command; its status from the live
// `card.checking`, the step-failed question, or the run order (checks stop at the first failure).
import type { BoardChecking, WorkflowDefinition } from '@conductor/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface RunSegment {
  stream: 'stdout' | 'stderr';
  text: string;
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'finished';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal colour and cursor codes out, CRLF as LF. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r\n/g, '\n');
}

/** Lines in the output: one per `\n`, plus an unterminated last line. */
export function countLines(segments: readonly RunSegment[]): number {
  let n = 0;
  let tail = false;
  for (const { text } of segments) {
    if (text === '') continue;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    tail = !text.endsWith('\n');
  }
  return n + (tail ? 1 : 0);
}

const RUN_MARKER = /^conductor: (setup )?`([^`]+)` in a fresh checkout of /;

export interface RunMarker {
  cmd: string;
  setup: boolean;
}

/** The run a debug entry announces (its last marker line), else null. */
export function runMarker(debugText: string): RunMarker | null {
  let found: RunMarker | null = null;
  for (const line of debugText.split('\n')) {
    const m = RUN_MARKER.exec(line);
    if (m) found = { cmd: m[2]!, setup: m[1] !== undefined };
  }
  return found;
}

/** cmd → check name, from every state's entry checks and every transition's `requires.checks`. */
export function checkNames(
  workflow: Pick<WorkflowDefinition, 'states'> | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  const add = (checks: readonly { name: string; cmd: string }[] | undefined) => {
    for (const c of checks ?? []) if (!names.has(c.cmd)) names.set(c.cmd, c.name);
  };
  for (const state of Object.values(workflow?.states ?? {})) {
    add(state.entry?.checks);
    if (!('on' in state)) continue;
    for (const t of Object.values(state.on ?? {})) {
      if (typeof t !== 'string') add(t.requires?.checks);
    }
  }
  return names;
}

const firstLine = (s: string, max: number) => {
  const line = s.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The run's name: the check's (by command), "Setup: <cmd>", the command itself; without a marker
 * the command state it ran in (`state`: the latest move's target), else "Command".
 */
export function runName(
  marker: RunMarker | null,
  names: ReadonlyMap<string, string>,
  workflow?: Pick<WorkflowDefinition, 'states'>,
  state?: string | null,
): string {
  if (marker) {
    if (marker.setup) return `Setup: ${firstLine(marker.cmd, 80)}`;
    return names.get(marker.cmd) ?? firstLine(marker.cmd, 80);
  }
  const s = state ? workflow?.states[state] : undefined;
  if (s?.type === 'command') return s.title ?? state!;
  return 'Command';
}

const ERROR_LINE = /error|failed|ERR!/i;
const MAX_ERROR_LINE = 200;

/** FR-3: the first stderr line that reads as an error, else the last non-empty line; capped. */
export function firstRunError(segments: readonly RunSegment[]): string | null {
  let last: string | null = null;
  for (const seg of segments) {
    for (const raw of stripAnsi(seg.text).split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      if (seg.stream === 'stderr' && ERROR_LINE.test(line)) return cap(line);
      last = line;
    }
  }
  return last === null ? null : cap(last);
}

const cap = (line: string) =>
  line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE - 1)}…` : line;

export interface RunStatusContext {
  /** `card.checking`: the live step's items and their statuses. */
  checking?: BoardChecking | null | undefined;
  /** The check named by an open "Step failed" question. */
  failedItem?: string | null | undefined;
  /** Conductor is running a command for the session right now. */
  active?: boolean | undefined;
}

/**
 * TD: inferred, not reported (chunks carry no exit code). In order: the live step's item for the
 * latest run of that name; the step-failed question's item; a run another one followed (checks
 * stop at the first failure, apply.ts `checkExit`); the last row while conductor runs; else
 * "finished".
 */
export function runStatus(
  run: { name: string; followed: boolean },
  where: { latest: boolean; last: boolean },
  ctx: RunStatusContext,
): RunStatus {
  if (where.latest) {
    const item = ctx.checking?.items?.find((i) => i.kind === 'check' && i.label === run.name);
    if (item) {
      // `todo`/`pending` with output: an earlier attempt's run; the rules below decide.
      if (item.status === 'passed' || item.status === 'failed' || item.status === 'running') {
        return item.status;
      }
    }
    if (ctx.failedItem && ctx.failedItem === run.name) return 'failed';
  }
  if (run.followed) return 'passed';
  if (where.last && ctx.active) return 'running';
  return 'finished';
}

const COPIED_MS = 1500;

/** One run's row. Collapsed, nothing of the output is in the DOM (NFR-3). */
export function CheckRun({
  name,
  status,
  segments,
  lines,
  open,
  onToggle,
}: {
  name: string;
  status: RunStatus;
  segments: readonly RunSegment[];
  lines: number;
  open: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const failed = status === 'failed';
  const error = useMemo(() => (failed ? firstRunError(segments) : null), [failed, segments]);
  return (
    <div className={`check-run check-run-${status}`} role="group" aria-label="Check output">
      <button
        type="button"
        className="check-run-summary"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        {failed && (
          <span className="check-run-fail" aria-hidden="true">
            ✗
          </span>
        )}
        <span className="check-run-text">
          Check output · {name} ({status}) · {lines.toLocaleString('en-US')}{' '}
          {lines === 1 ? 'line' : 'lines'}
        </span>
        <span className="chev" aria-hidden="true">
          ▸
        </span>
      </button>
      {error && <p className="check-run-error">{error}</p>}
      {open && <CheckRunBody id={bodyId} segments={segments} />}
    </div>
  );
}

/**
 * The expanded output, at full height in the thread. One text node per stdout/stderr segment
 * (not per line), so even 20,000 lines lay out as a handful of nodes.
 */
function CheckRunBody({ id, segments }: { id: string; segments: readonly RunSegment[] }) {
  const parts = useMemo(
    () => segments.map((s) => ({ stream: s.stream, text: stripAnsi(s.text) })),
    [segments],
  );
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function onCopy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(parts.map((p) => p.text).join(''));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
    timer.current = setTimeout(() => setCopy('idle'), COPIED_MS);
  }

  return (
    <div id={id} className="check-run-body">
      <button
        type="button"
        className="link check-run-copy"
        aria-label="Copy check output"
        onClick={() => void onCopy()}
      >
        {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <pre className="check-run-output" role="log">
        {parts.map((p, i) => (
          <span key={i} className={`out-${p.stream}`}>
            {p.text}
          </span>
        ))}
      </pre>
    </div>
  );
}
