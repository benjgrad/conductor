import type { BoardCard, HumanTransitionOption } from '@conductor/shared';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { ApiClient } from '../api/client.js';
import {
  boardColumns,
  EMPTY_BOARD,
  type BoardColumnView,
  type BoardState,
} from '../board/board.js';
import { DEFAULT_BOARD_WORKFLOW, readCollapsed, writeCollapsed } from './board-layout.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { ago, cardMeta, KIND_LABELS, TICKET_KIND_LABELS, usd } from './format.js';
import { usePlanAnswer } from './plan-answer.js';
import { PendingChecklist, TransitionButtons } from './transitions.js';
import {
  classifyRequest,
  PLAN_APPROVED_TEXT,
  planAnswerOption,
  previewText,
  type RequestClass,
} from './request-preview.js';
import {
  agentIdle,
  checkingSummary,
  isConductorStep,
  waitingForBuildSlot,
} from './ConductorChecks.js';
import { routingNeeds, routingRule } from '../machines/format.js';
import { useIsMobile } from './useMediaQuery.js';
import './Board.css';

interface BoardProps {
  board: BoardState;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** ADR-0011: with it, Needs-input cards get their human transition buttons. */
  api?: ApiClient;
  /** ADR-0010: the board's workflow; it keys the remembered layout (UX-9). */
  workflow?: string;
}

/** UX-9: a collapsed column's grid track, the width of its strip. */
const STRIP_TRACK = 'var(--column-strip-width)';
const COLUMN_TRACK = 'minmax(180px, 1fr)';

export function Board({
  board,
  selectedSessionId,
  onSelect,
  api,
  workflow = DEFAULT_BOARD_WORKFLOW,
}: BoardProps) {
  // NFR-2 (UX-9): stable columns and agent states, so toggling one column skips the others.
  const columns = useMemo(() => boardColumns(board), [board]);
  // 06 §Plan approval: a card has no `return_to`; its answer option goes into an agent column.
  const agentStates = useMemo(
    () => new Set(columns.filter((c) => c.kind === 'agent').map((c) => c.id)),
    [columns],
  );

  // UX-9: every stored id is kept; one that is not a column now is ignored when rendering.
  const [collapsed, setCollapsed] = useState(() => readCollapsed(workflow));
  const [layoutOf, setLayoutOf] = useState(workflow);
  if (layoutOf !== workflow) {
    setLayoutOf(workflow);
    setCollapsed(readCollapsed(workflow));
  }
  const isCollapsed = (id: string) => collapsed.has(id);
  const anyCollapsed = columns.some((c) => collapsed.has(c.id));

  // FR-4: each collapsed column's card count when it was collapsed (lowered when it drops), so a
  // human column can show that it rose. Not before the first board load: its count is no news.
  const [baseline, setBaseline] = useState<ReadonlyMap<string, number>>(new Map());
  const nextBaseline = board === EMPTY_BOARD ? baseline : baselines(columns, collapsed, baseline);
  if (nextBaseline !== baseline) setBaseline(nextBaseline);

  // Written only for the columns there are now, so the ids of removed columns don't pile up;
  // never on mount, when the columns may still be the defaults of before the first load.
  const columnIds = columns.map((c) => c.id).join(' ');
  const save = useCallback(
    (next: ReadonlySet<string>) => {
      const ids = new Set(columnIds.split(' '));
      writeCollapsed(workflow, new Set([...next].filter((id) => ids.has(id))));
    },
    [workflow, columnIds],
  );
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        save(next);
        return next;
      }),
    [save],
  );
  const expandAll = () => {
    setCollapsed(new Set());
    save(new Set());
  };

  // 11-web-ui §Board: on a phone one column shows at a time, picked in the switcher or by a swipe.
  // Collapsing (UX-9) is desktop only: the phone column is never collapsed.
  const mobile = useIsMobile();
  const [picked, setPicked] = useState<string | null>(null);
  const active =
    columns.find((c) => c.id === picked) ?? defaultColumn(columns) ?? columns[0] ?? null;
  const swipe = useSwipe((step) => {
    if (!active) return;
    const next = columns[columns.indexOf(active) + step];
    if (next) setPicked(next.id);
  });

  if (mobile) {
    return (
      <div className="board board-mobile" {...swipe}>
        {active && (
          <>
            <ColumnSwitcher columns={columns} active={active.id} onPick={setPicked} />
            <Column
              col={active}
              collapsed={false}
              attention={false}
              onToggle={toggle}
              selectedSessionId={selectedSessionId}
              onSelect={onSelect}
              agentStates={agentStates}
              {...(api ? { api } : {})}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="board-area">
      {anyCollapsed && (
        <div className="board-toolbar">
          <button type="button" className="board-expand-all" onClick={expandAll}>
            Expand all
          </button>
        </div>
      )}
      <div
        className="board"
        // styles.css owns `.board`; the tracks depend on which columns are collapsed.
        style={{
          gridTemplateColumns: columns
            .map((c) => (isCollapsed(c.id) ? STRIP_TRACK : COLUMN_TRACK))
            .join(' '),
        }}
      >
        {columns.map((col) => {
          const shut = isCollapsed(col.id);
          const since = nextBaseline.get(col.id);
          return (
            <Column
              key={col.id}
              col={col}
              collapsed={shut}
              attention={
                shut && col.kind === 'human' && since !== undefined && col.cards.length > since
              }
              onToggle={toggle}
              selectedSessionId={selectedSessionId}
              onSelect={onSelect}
              agentStates={agentStates}
              {...(api ? { api } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

/** The phone board opens on Needs input when it has cards, else the first column with any. */
export function defaultColumn(columns: readonly BoardColumnView[]): BoardColumnView | undefined {
  return (
    columns.find((c) => c.id === 'needs_input' && c.cards.length > 0) ??
    columns.find((c) => c.cards.length > 0)
  );
}

function ColumnSwitcher({
  columns,
  active,
  onPick,
}: {
  columns: readonly BoardColumnView[];
  active: string;
  onPick: (id: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    refs.current.get(active)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <div className="column-switcher" role="tablist" aria-label="Columns">
      {columns.map((col) => (
        <button
          key={col.id}
          ref={(el) => {
            if (el) refs.current.set(col.id, el);
            else refs.current.delete(col.id);
          }}
          type="button"
          role="tab"
          aria-selected={col.id === active}
          aria-controls={col.id === active ? `board-column-${col.id}` : undefined}
          className={`column-tab column-tab-${col.id}${col.id === active ? ' active' : ''}`}
          onClick={() => onPick(col.id)}
        >
          {col.title} <span className="count">{col.cards.length}</span>
        </button>
      ))}
    </div>
  );
}

const SWIPE_MIN_PX = 50;

/**
 * A horizontal swipe: more than 50 px sideways and 1.5× more sideways than down. `step` is +1 for
 * a swipe to the left (the next column), -1 to the right. Vertical scrolling is never blocked
 * (the board is `touch-action: pan-y`).
 */
function useSwipe(onSwipe: (step: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      // The switcher scrolls sideways on its own; a drag there isn't a column swipe.
      const inSwitcher = (e.target as Element).closest?.('.column-switcher');
      start.current = e.isPrimary === false || inSwitcher ? null : { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: PointerEvent) => {
      const from = start.current;
      start.current = null;
      if (!from) return;
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        onSwipe(dx < 0 ? 1 : -1);
      }
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

/** FR-4: the baselines for `collapsed`; the same map when nothing changed. */
function baselines(
  columns: readonly BoardColumnView[],
  collapsed: ReadonlySet<string>,
  prev: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const col of columns) {
    if (!collapsed.has(col.id)) continue;
    const was = prev.get(col.id);
    next.set(col.id, was === undefined ? col.cards.length : Math.min(was, col.cards.length));
  }
  if (next.size === prev.size && [...next].every(([id, n]) => prev.get(id) === n)) return prev;
  return next;
}

interface ColumnProps {
  col: BoardColumnView;
  collapsed: boolean;
  /** FR-4: a collapsed human column's count rose. */
  attention: boolean;
  onToggle: (id: string) => void;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  agentStates: ReadonlySet<string>;
  api?: ApiClient;
}

/**
 * UX-9: one column. Its heading is a disclosure button; collapsed, the same button is the strip
 * (rotated title and count), so focus stays on it when it toggles.
 */
const Column = memo(function Column({
  col,
  collapsed,
  attention,
  onToggle,
  selectedSessionId,
  onSelect,
  agentStates,
  api,
}: ColumnProps) {
  const bodyId = `board-column-${col.id}`;
  return (
    <section
      className={`column column-${col.id} column-kind-${col.kind}${collapsed ? ' collapsed' : ''}`}
      aria-label={col.title}
      data-column={col.id}
    >
      <h2>
        <button
          type="button"
          className="column-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${col.title}`}
          onClick={() => onToggle(col.id)}
        >
          <span className="column-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="column-title">{col.title}</span>{' '}
          <span className="count">{col.cards.length}</span>
          {attention && (
            <span className="column-attention" title="New since collapsed">
              <span className="visually-hidden"> (new)</span>
            </span>
          )}
        </button>
      </h2>
      <ul id={bodyId} hidden={collapsed}>
        {!collapsed &&
          col.cards.map((card) => (
            <li key={card.ticket_id}>
              <Card
                card={card}
                column={col}
                selected={card.session_id !== null && card.session_id === selectedSessionId}
                onSelect={onSelect}
                agentStates={agentStates}
                {...(api ? { api } : {})}
              />
            </li>
          ))}
      </ul>
    </section>
  );
});

interface CardProps {
  card: BoardCard;
  /** The card's column: the meta row leaves out what it already says. */
  column: Pick<BoardColumnView, 'id' | 'title' | 'kind'>;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  /** The board's agent-state columns, for the plan approval's answer option. */
  agentStates: ReadonlySet<string>;
  api?: ApiClient;
}

function Card({ card, column, selected, onSelect, agentStates, api }: CardProps) {
  const sessionId = card.session_id;
  const q = card.input_request;
  const cls = q ? classifyRequest(q) : null;
  const planOption =
    cls === 'plan_approval' ? planAnswerOption(card.human_transitions, agentStates) : null;
  // UX-5: in a gate step the agent has exited and conductor runs the step, so no "running" agent.
  const conductor = isConductorStep(card);
  const idle = agentIdle(card);
  const name = agentName(card.ticket_id);
  const meta = cardMeta(card, column);
  return (
    <article className={`card${selected ? ' selected' : ''}`} data-ticket={card.ticket_id}>
      <button
        type="button"
        className="card-open"
        disabled={sessionId === null}
        aria-pressed={selected}
        onClick={() => sessionId && onSelect(sessionId)}
      >
        <span className="card-title">{card.title}</span>
      </button>
      <div className="card-meta">
        {card.kind && (
          <span className={`tag tag-kind tag-${card.kind}`}>{TICKET_KIND_LABELS[card.kind]}</span>
        )}
        <span
          className="card-agent"
          title={idle ? `Agent ${name} is idle: conductor is checking` : `Agent ${name}`}
        >
          <AgentAvatar
            ticketId={card.ticket_id}
            size={20}
            {...(idle ? { className: 'avatar-idle' } : {})}
          />
          {name}
          {idle && <span className="visually-hidden"> (idle)</span>}
        </span>
        {card.external_ref && <span className="ref">{card.external_ref}</span>}
        {conductor ? (
          <span className="status status-conductor">{checkingSummary(card)}</span>
        ) : (
          <>
            {meta.stateLabel && <span className="card-state">{meta.stateLabel}</span>}
            {meta.statusLabel && (
              <span className={`status status-${card.status}`}>{meta.statusLabel}</span>
            )}
            {meta.srStatusLabel && <span className="visually-hidden">{meta.srStatusLabel}</span>}
          </>
        )}
        {card.priority !== 0 && <span className="prio">P{card.priority}</span>}
        {card.spend_usd > 0 && <span>{usd(card.spend_usd)}</span>}
        <span className="age">{ago(card.updated_at)}</span>
      </div>
      {card.sub_status === 'needs_permission' && card.permission && (
        <span className="badge badge-permission" title={card.permission.summary}>
          needs permission: {card.permission.tool}
          {card.permission.pending_count > 1 ? ` (+${card.permission.pending_count - 1})` : ''}
        </span>
      )}
      {card.badges.includes('waiting_for_build_slot') && !waitingForBuildSlot(card) && (
        <span className="badge badge-slot">waiting for build slot</span>
      )}
      {card.column === 'queued' && card.routing && (
        <RoutingBadge needs={routingNeeds(card.routing)} rule={routingRule(card.routing)} />
      )}
      {card.alerts && card.alerts.length > 0 && (
        <AlertBadge files={[...new Set(card.alerts.flatMap((a) => a.files))]} />
      )}
      {conductor ? null : card.pending ? (
        <PendingChecklist pending={card.pending} />
      ) : (
        card.checking && (
          <span className="badge badge-checking">
            checking requirements for {card.checking.title} ({card.checking.phase})
          </span>
        )
      )}
      {(['failed', 'lost', 'cancelled'] as const).map(
        (b) =>
          card.badges.includes(b) && (
            <span key={b} className={`badge badge-${b}`}>
              {b}
            </span>
          ),
      )}
      {card.pr_url && cls !== 'review' && (
        <a className="badge badge-pr" href={card.pr_url} target="_blank" rel="noreferrer">
          pull request
        </a>
      )}
      {q && cls && (
        <div className={`question request-${cls}`}>
          <span className={BADGE_CLASS[cls](q.kind)}>
            {requestLabel(cls, q.kind)} · {ago(q.created_at)}
          </span>
          {/* UX-4: a clamped preview; the full text is its accessible name and tooltip. */}
          <button
            type="button"
            className="card-preview"
            disabled={sessionId === null}
            aria-label={`${requestLabel(cls, q.kind)}: ${q.question}`}
            title={q.question}
            onClick={() => sessionId && onSelect(sessionId)}
          >
            <span className="card-preview-text" aria-hidden="true">
              {previewText(q.question, cls)}
            </span>
          </button>
          {cls === 'review' && card.pr_url && (
            <a className="card-pr-link" href={card.pr_url} target="_blank" rel="noreferrer">
              Review pull request ↗
            </a>
          )}
        </div>
      )}
      {api && sessionId !== null && planOption ? (
        <PlanApprovalActions
          api={api}
          sessionId={sessionId}
          option={planOption}
          onReview={() => onSelect(sessionId)}
        />
      ) : (
        api &&
        sessionId !== null &&
        card.human_transitions.length > 0 && (
          <TransitionButtons api={api} sessionId={sessionId} options={card.human_transitions} />
        )
      )}
    </article>
  );
}

/**
 * 06 §Plan approval on the card: Approve plan posts the answer option with the approval text;
 * Review plan opens the session panel (the plan, Request changes…, the other actions).
 */
function PlanApprovalActions({
  api,
  sessionId,
  option,
  onReview,
}: {
  api: ApiClient;
  sessionId: string;
  option: HumanTransitionOption;
  onReview: () => void;
}) {
  // The board stream carries the card change; no reload needed.
  const { busy, error, post } = usePlanAnswer(api, sessionId, option);

  return (
    <div className="transitions">
      <div className="transition-buttons" role="group" aria-label="Plan to approve">
        <button
          type="button"
          className="plan-approve"
          disabled={busy}
          onClick={() => void post(PLAN_APPROVED_TEXT)}
        >
          Approve plan
        </button>
        <button type="button" onClick={onReview}>
          Review plan
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** M2 (ADR-0013 §Routing): what no online machine has, e.g. "needs a machine with org/app and az". */
function RoutingBadge({ needs, rule }: { needs: string[]; rule: string | null }) {
  // ADR-0013 amendment 2026-10-30: a repo rule first, then what the allowed machines lack.
  if (needs.length === 0) {
    return <span className="badge badge-routing">{rule ?? 'no online machine can take it'}</span>;
  }
  return (
    <span className="badge badge-routing">
      {rule !== null && `${rule}; `}
      needs a machine with{' '}
      {needs.map((n, i) => (
        <span key={n}>
          {i > 0 && (i === needs.length - 1 ? ' and ' : ', ')}
          <code>{n}</code>
        </span>
      ))}
    </span>
  );
}

/** M2 (U-060): the session changed `.git` in a checkout-mode repo; the files it touched. */
function AlertBadge({ files }: { files: string[] }) {
  return (
    <div className="card-alert">
      <span className="badge badge-alert" title={files.join('\n')}>
        .git changed
      </span>
      {files.length > 0 && (
        <ul className="card-alert-files" aria-label=".git files changed">
          {files.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const BADGE_CLASS: Record<RequestClass, (kind: string) => string> = {
  review: () => 'badge badge-review',
  plan_approval: () => 'badge badge-plan-approval',
  step_failed: () => 'badge badge-step-failed',
  question: (kind) => `badge badge-question kind-${kind}`,
};

/** The card's request label, as text (NFR-3: never colour alone). */
export function requestLabel(cls: RequestClass, kind: keyof typeof KIND_LABELS): string {
  if (cls === 'review') return 'Ready for review';
  if (cls === 'plan_approval') return 'Plan to approve';
  if (cls === 'step_failed') return 'Step failed';
  return KIND_LABELS[kind];
}
