// UX-7: the Details tab in STAR order. Situation (why the ticket exists), Task (what was asked),
// Action (what happened, oldest first), Result (how it stands and what's next), then the
// technical details, collapsed. Which sections are open is remembered per session.
import type { SessionDetail } from '@conductor/shared';
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api/client.js';
import type { Brief } from '../brief/parse.js';
import { Requirements } from './BriefCard.js';
import { ContextView } from './ContextView.js';
import { Actions, AgentCard, BudgetSection, WorkflowSection } from './details-sections.js';
import { TICKET_KIND_LABELS } from './format.js';
import { Markdown } from './markdown.js';
import {
  firstLine,
  result,
  summaryLine,
  situation,
  timeline,
  type Result,
  type TimelineEntry,
} from './star.js';
import { MovesList, timeFormat } from './transitions.js';
import './StarDetails.css';

interface StarDetailsProps {
  api: ApiClient;
  detail: SessionDetail;
  sessionId: string;
  /** The agent's name (agent-identity). */
  name: string;
  /** The parsed ticket body; null while it isn't available. */
  brief: Brief | null;
  body: string | null;
  onReload: () => void;
}

// ---------------------------------------------------------------- open state (FR-6)

type Toggleable = 'situation' | 'task' | 'action' | 'technical';
type OpenState = Record<Toggleable, boolean>;

const DEFAULT_OPEN: OpenState = { situation: true, task: true, action: true, technical: false };
const storageKey = (sessionId: string) => `conductor.star.open.${sessionId}`;

function readOpen(sessionId: string): OpenState {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (raw === null) return DEFAULT_OPEN;
    const saved = JSON.parse(raw) as Partial<Record<Toggleable, unknown>>;
    const out = { ...DEFAULT_OPEN };
    for (const k of Object.keys(DEFAULT_OPEN) as Toggleable[]) {
      if (typeof saved[k] === 'boolean') out[k] = saved[k];
    }
    return out;
  } catch {
    return DEFAULT_OPEN;
  }
}

function writeOpen(sessionId: string, open: OpenState) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(open));
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

/** Per-session open sections; StarDetails is keyed by session, so this reads once per session. */
function useStarOpen(sessionId: string) {
  const [open, setOpen] = useState(() => readOpen(sessionId));
  const toggle = useCallback(
    (k: Toggleable) =>
      setOpen((prev) => {
        const next = { ...prev, [k]: !prev[k] };
        writeOpen(sessionId, next);
        return next;
      }),
    [sessionId],
  );
  return [open, toggle] as const;
}

// ---------------------------------------------------------------- building blocks

/**
 * One STAR section: a real h3 (NFR-3) with a one-line summary that stays visible when collapsed.
 * Without `onToggle` it is always open (Result).
 */
function StarSection({
  title,
  summary,
  open = true,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-label={title} className="star-section">
      <h3 className="star-head">
        {onToggle ? (
          <button
            type="button"
            className="star-toggle"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={onToggle}
          >
            <span className="star-chevron" aria-hidden="true">
              ▸
            </span>
            <span className="star-title">{title}</span>
            {summary && <span className="star-summary">{summary}</span>}
          </button>
        ) : (
          <span className="star-static">
            <span className="star-title">{title}</span>
            {summary && <span className="star-summary">{summary}</span>}
          </span>
        )}
      </h3>
      <div id={`${id}-body`} className="star-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** Markdown cut to its first `lines` lines, with "more ▸" for the rest. */
function Clamped({ text, lines, label }: { text: string; lines: number; label: string }) {
  const [all, setAll] = useState(false);
  const rows = text.split('\n');
  const long = rows.length > lines;
  return (
    <div className="star-clamped">
      <Markdown text={long && !all ? rows.slice(0, lines).join('\n') : text} />
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          aria-label={all ? `Show less of the ${label}` : `Show more of the ${label}`}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'less ▾' : 'more ▸'}
        </button>
      )}
    </div>
  );
}

/** A disclosure button and its content (Out of scope, Full plan, a long reason). */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="link star-disclosure"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {label} {open ? '▾' : '▸'}
      </button>
      {open && <div id={id}>{children}</div>}
    </>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

// ---------------------------------------------------------------- sections

function SituationBody({ s }: { s: ReturnType<typeof situation> }) {
  return (
    <>
      {s.text ? (
        <Clamped text={s.text} lines={6} label="situation" />
      ) : (
        <p className="muted">The ticket has no description.</p>
      )}
      <dl className="kv star-facts">
        <dt>Ticket</dt>
        <dd>{s.title}</dd>
        <dt>Kind</dt>
        <dd>{s.kind ? TICKET_KIND_LABELS[s.kind] : <span className="muted">not set</span>}</dd>
        <dt>Repo</dt>
        <dd>{s.repo}</dd>
        <dt>Created</dt>
        {/* TD: no author until accounts are on tickets; the date only. */}
        <dd>
          <time dateTime={s.createdAt}>{dateFormat.format(new Date(s.createdAt))}</time>
        </dd>
      </dl>
    </>
  );
}

function TaskBody({ brief, body }: { brief: Brief | null; body: string | null }) {
  if (brief === null || body === null) return <p className="muted">Loading the brief…</p>;
  const structured = brief.functional.length + brief.nonFunctional.length > 0;
  if (!structured) {
    // A legacy ticket: as written, cut after ~8 lines.
    return body.trim() ? (
      <Clamped text={body.trim()} lines={8} label="ticket" />
    ) : (
      <p className="muted">The ticket has no description.</p>
    );
  }
  return (
    <div className="brief-body star-task">
      {brief.goal && (
        <div className="brief-section brief-goal">
          <h4>Goal</h4>
          <Markdown text={brief.goal} />
        </div>
      )}
      <Requirements title="Functional" reqs={brief.functional} brief={brief} />
      <Requirements title="Non-functional" reqs={brief.nonFunctional} brief={brief} />
      {brief.outOfScope && (
        <div className="brief-section">
          <Disclosure label="Out of scope">
            <Markdown text={brief.outOfScope} />
          </Disclosure>
        </div>
      )}
    </div>
  );
}

/** How many of the latest entries Action shows before "Show N earlier" (FR-6). */
const RECENT = 3;

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const reason = entry.reason ?? '';
  const head = firstLine(reason);
  const more = reason.trim() !== head;
  const answer = entry.kind === 'answer';
  return (
    <li className={`star-entry star-entry-${entry.kind}`}>
      <time dateTime={entry.at} className="muted">
        {timeFormat.format(new Date(entry.at))}
      </time>{' '}
      <span className="star-entry-label">{entry.label}</span>
      {head && (
        <span className="star-entry-reason">
          {answer ? ': ' : ' — '}
          {head}
        </span>
      )}
      {entry.truncated && <span className="muted"> (truncated)</span>}
      {entry.detail && entry.kind === 'review' && (
        <span className="muted">
          {' '}
          on <code>{entry.detail}</code>
        </span>
      )}
      {more && (
        <Disclosure label={answer ? 'Full answer' : 'More'}>
          <div className="star-entry-more">
            <Markdown text={reason} />
          </div>
        </Disclosure>
      )}
      {entry.kind === 'plan' && entry.detail && (
        <div className="star-plan">
          <Markdown text={entry.detail.trim().split('\n').slice(0, 3).join('\n')} />
          {entry.detail.trim().split('\n').length > 3 && (
            <Disclosure label="Full plan">
              <div className="star-entry-more">
                <Markdown text={entry.detail} />
              </div>
            </Disclosure>
          )}
        </div>
      )}
    </li>
  );
}

function ActionBody({ entries }: { entries: TimelineEntry[] }) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return <p className="muted">Nothing has happened yet.</p>;
  const hidden = all ? 0 : Math.max(0, entries.length - RECENT);
  return (
    <>
      {entries.length > RECENT && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show only the latest' : `Show ${hidden} earlier`}
        </button>
      )}
      <ol className="star-timeline" aria-label="Timeline">
        {entries.slice(hidden).map((e, i) => (
          <TimelineItem key={`${e.at}-${hidden + i}`} entry={e} />
        ))}
      </ol>
      <p className="muted star-hint">The full log is in Messages.</p>
    </>
  );
}

const STATUS_CLASS: Record<Result['status'], string> = {
  'In progress': 'running',
  'Waiting for you': 'needs_input',
  'Ready for review': 'needs_input',
  Done: 'done',
  Failed: 'failed',
};

function ResultBody({
  r,
  api,
  detail,
  onReload,
}: {
  r: Result;
  api: ApiClient;
  detail: SessionDetail;
  onReload: () => void;
}) {
  return (
    <div className="star-result">
      <p>
        <span className={`chip status status-${STATUS_CLASS[r.status]}`}>{r.status}</span>
        {r.prUrl && (
          <>
            {' '}
            <a href={r.prUrl} target="_blank" rel="noreferrer">
              Open pull request ↗
            </a>
          </>
        )}
      </p>
      {r.checks && (
        <p>
          Checks: {r.checks.passed} passed, {r.checks.failed} failed
          <span className="muted"> of {r.checks.total}</span>
        </p>
      )}
      {r.failure?.error && (
        <p className="step-failed-item">
          {r.failure.item && <strong>{r.failure.item}</strong>}
          {r.failure.item ? ': ' : ''}
          {r.failure.error}
        </p>
      )}
      {r.acceptance && <p className="star-acceptance">{r.acceptance}</p>}
      <p className="star-next">
        <strong>Next:</strong> {r.next}
      </p>
      <Actions api={api} detail={detail} onDone={onReload} />
    </div>
  );
}

// ---------------------------------------------------------------- StarDetails

export function StarDetails({
  api,
  detail,
  sessionId,
  name,
  brief,
  body,
  onReload,
}: StarDetailsProps) {
  const [open, toggle] = useStarOpen(sessionId);
  // NFR-4: all derived from the latest detail; nothing here is keyed by it, so an SSE-driven
  // refetch re-renders in place and keeps the open sections.
  const s = useMemo(() => situation(detail, brief, body), [detail, brief, body]);
  const entries = useMemo(() => timeline(detail, name), [detail, name]);
  const r = useMemo(() => result(detail, name), [detail, name]);
  const last = entries.at(-1);

  return (
    <>
      <StarSection
        title="Situation"
        summary={summaryLine(s.text) || s.title}
        open={open.situation}
        onToggle={() => toggle('situation')}
      >
        <SituationBody s={s} />
      </StarSection>
      <StarSection
        title="Task"
        summary={summaryLine(brief?.goal) || s.title}
        open={open.task}
        onToggle={() => toggle('task')}
      >
        <TaskBody brief={brief} body={body} />
      </StarSection>
      <StarSection
        title="Action"
        summary={
          last
            ? `${entries.length} step${entries.length === 1 ? '' : 's'} · last: ${last.label}`
            : 'nothing yet'
        }
        open={open.action}
        onToggle={() => toggle('action')}
      >
        <ActionBody entries={entries} />
      </StarSection>
      <StarSection title="Result" summary={r.status}>
        <ResultBody r={r} api={api} detail={detail} onReload={onReload} />
      </StarSection>
      <StarSection
        title="Technical details"
        summary="agent, machine, session, workflow, spend, raw context"
        open={open.technical}
        onToggle={() => toggle('technical')}
      >
        <AgentCard api={api} detail={detail} sessionId={sessionId} name={name} />
        <WorkflowSection detail={detail} />
        <section aria-label="Moves">
          <h4>All moves</h4>
          <MovesList moves={detail.moves ?? []} workflow={detail.workflow} />
        </section>
        <BudgetSection detail={detail} />
        <section aria-label="Context">
          <h4>Context</h4>
          <ContextView context={detail.context} />
        </section>
      </StarSection>
    </>
  );
}
