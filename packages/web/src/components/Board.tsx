import { isReorderable, moveInOrder, type BoardCard } from '@conductor/shared';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { ApiClient } from '../api/client.js';
import {
  boardColumns,
  EMPTY_BOARD,
  type BoardColumnView,
  type BoardState,
} from '../board/board.js';
import { waitingOnYou } from '../board/waiting.js';
import { routeHash } from '../nav.js';
import { DEFAULT_BOARD_WORKFLOW, readCollapsed, writeCollapsed } from './board-layout.js';
import { AgentAvatar, cardAgent } from './agent-identity.js';
import { ago, cardMeta, humanize, KIND_LABELS, TICKET_KIND_LABELS, usd } from './format.js';
import { usePlanAnswer } from './plan-answer.js';
import { CardAllowOnce, CardOptionButton } from './CardActions.js';
import { cardAction } from './card-action.js';
import { PendingChecklist, TransitionButtons } from './transitions.js';
import {
  classifyRequest,
  planApproveRequest,
  planOptions,
  previewText,
  requestTone,
  type PlanOptions,
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
  /** Opens a card with no session yet (Queued) by its ticket; without it such cards are inert. */
  onSelectTicket?: (ticketId: string) => void;
  /** The open sessionless card's ticket. */
  selectedTicketId?: string | null;
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
  onSelectTicket,
  selectedTicketId = null,
  api,
  workflow = DEFAULT_BOARD_WORKFLOW,
}: BoardProps) {
  // NFR-2 (UX-9): stable columns and agent states, so toggling one column skips the others.
  const columns = useMemo(() => boardColumns(board), [board]);
  // UXR-32: pending permissions wait on Ben too; the Needs-input header notes them.
  const permissionCards = useMemo(() => waitingOnYou(board.cards.values()).permissions, [board]);
  const waitingFor = (id: string) => (id === 'needs_input' ? permissionCards : NO_CARDS);
  // 06 §Plan approval: a card has no `return_to`; its answer option goes into an agent column.
  const agentStates = useMemo(
    () => new Set(columns.filter((c) => c.kind === 'agent').map((c) => c.id)),
    [columns],
  );
  // UXR-30 (FR-2): a pending move names its target column by title.
  const columnTitles = useMemo(
    () => new Map(columns.map((c) => [c.id, c.title] as const)),
    [columns],
  );
  // UXR-30 (FR-1): the workflow's name only disambiguates when the board mixes workflows.
  const showWorkflow = useMemo(
    () => new Set([...board.cards.values()].map((c) => c.workflow_id)).size > 1,
    [board.cards],
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
  const nextBaseline =
    board === EMPTY_BOARD
      ? baseline
      : baselines(columns, collapsed, baseline, permissionCards.length);
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
    columns.find((c) => c.id === picked) ??
    defaultColumn(columns, permissionCards.length) ??
    columns[0] ??
    null;
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
            <ColumnSwitcher
              columns={columns}
              active={active.id}
              onPick={setPicked}
              permissions={permissionCards.length}
            />
            <Column
              col={active}
              mobile
              collapsed={false}
              attention={false}
              permissionCards={waitingFor(active.id)}
              onToggle={toggle}
              selectedSessionId={selectedSessionId}
              selectedTicketId={selectedTicketId}
              onSelect={onSelect}
              {...(onSelectTicket ? { onSelectTicket } : {})}
              agentStates={agentStates}
              columnTitles={columnTitles}
              showWorkflow={showWorkflow}
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
                shut &&
                col.kind === 'human' &&
                since !== undefined &&
                columnCount(col, permissionCards.length) > since
              }
              permissionCards={waitingFor(col.id)}
              onToggle={toggle}
              selectedSessionId={selectedSessionId}
              selectedTicketId={selectedTicketId}
              onSelect={onSelect}
              {...(onSelectTicket ? { onSelectTicket } : {})}
              agentStates={agentStates}
              columnTitles={columnTitles}
              showWorkflow={showWorkflow}
              {...(api ? { api } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

const NO_CARDS: readonly BoardCard[] = [];

/** FR-4 / UXR-32: what a column's attention compares: Needs input also counts permission cards. */
function columnCount(col: BoardColumnView, permissions: number): number {
  return col.cards.length + (col.id === 'needs_input' ? permissions : 0);
}

/**
 * The phone board opens on Needs input when it has cards or a permission is waiting (UXR-32
 * FR-3), else the first column with any.
 */
export function defaultColumn(
  columns: readonly BoardColumnView[],
  permissions = 0,
): BoardColumnView | undefined {
  return (
    columns.find((c) => c.id === 'needs_input' && columnCount(c, permissions) > 0) ??
    columns.find((c) => c.cards.length > 0)
  );
}

/** UXR-32: "1 waiting for permission". */
export function waitingForPermissionText(n: number): string {
  return `${n} waiting for permission`;
}

function ColumnSwitcher({
  columns,
  active,
  onPick,
  permissions,
}: {
  columns: readonly BoardColumnView[];
  active: string;
  onPick: (id: string) => void;
  /** UXR-32: cards waiting for a permission, shown on the Needs-input tab. */
  permissions: number;
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
          {...(col.id === 'needs_input' && permissions > 0
            ? {
                'aria-label': `${col.title}: ${col.cards.length}, ${waitingForPermissionText(permissions)}`,
              }
            : {})}
        >
          {col.title} <span className="count">{col.cards.length}</span>
          {col.id === 'needs_input' && permissions > 0 && (
            <span className="count-waiting">+{permissions}</span>
          )}
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
      // The switcher scrolls sideways on its own, and a queue handle moves a card: neither is a
      // column swipe.
      const inSwitcher = (e.target as Element).closest?.('.column-switcher, .queue-handle');
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
  permissions: number,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const col of columns) {
    if (!collapsed.has(col.id)) continue;
    const was = prev.get(col.id);
    const n = columnCount(col, permissions);
    next.set(col.id, was === undefined ? n : Math.min(was, n));
  }
  if (next.size === prev.size && [...next].every(([id, n]) => prev.get(id) === n)) return prev;
  return next;
}

interface ColumnProps {
  col: BoardColumnView;
  /** The phone board: Queued cards get Move up / Move down buttons instead of a drag handle. */
  mobile?: boolean;
  collapsed: boolean;
  /** FR-4: a collapsed human column's count rose. */
  attention: boolean;
  /** UXR-32: on Needs input, the cards waiting for a permission (oldest first); else empty. */
  permissionCards: readonly BoardCard[];
  onToggle: (id: string) => void;
  selectedSessionId: string | null;
  selectedTicketId: string | null;
  onSelect: (sessionId: string) => void;
  onSelectTicket?: (ticketId: string) => void;
  agentStates: ReadonlySet<string>;
  columnTitles: ReadonlyMap<string, string>;
  showWorkflow: boolean;
  api?: ApiClient;
}

/**
 * UX-9: one column. Its heading is a disclosure button; collapsed, the same button is the strip
 * (rotated title and count), so focus stays on it when it toggles.
 */
const Column = memo(function Column({
  col,
  mobile = false,
  collapsed,
  attention,
  permissionCards,
  onToggle,
  selectedSessionId,
  selectedTicketId,
  onSelect,
  onSelectTicket,
  agentStates,
  columnTitles,
  showWorkflow,
  api,
}: ColumnProps) {
  const bodyId = `board-column-${col.id}`;
  const waiting = permissionCards.length;
  const oldest = permissionCards.find((c) => c.session_id !== null);
  // 06 §Queue order: Queued cards can be put in the order they are picked up in.
  const queue = useQueueOrder(col.kind === 'queued' ? api : undefined, col.cards);
  const cards = queue.cards;
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
          {collapsed && waiting > 0 && (
            <span className="count-waiting" title={waitingForPermissionText(waiting)}>
              +{waiting}
              <span className="visually-hidden"> waiting for permission</span>
            </span>
          )}
          {attention && (
            <span className="column-attention" title="New since collapsed">
              <span className="visually-hidden"> (new)</span>
            </span>
          )}
        </button>
      </h2>
      {!collapsed && waiting > 0 && oldest && (
        <button
          type="button"
          className="column-waiting"
          title="Open the oldest permission request"
          onClick={() => onSelect(oldest.session_id!)}
        >
          +{waitingForPermissionText(waiting)}
        </button>
      )}
      {!collapsed && queue.enabled && queue.ranked && (
        <button
          type="button"
          className="queue-reset"
          title="Forget the hand order: queued tickets are picked up by priority, then age"
          onClick={queue.reset}
        >
          Reset to priority order
        </button>
      )}
      {!collapsed && queue.error && (
        <p role="alert" className="error queue-error">
          {queue.error}
        </p>
      )}
      <ul
        id={bodyId}
        hidden={collapsed}
        className={
          queue.dropAt !== null && queue.dropAt === queue.movable.length ? 'drop-end' : undefined
        }
        {...queue.listProps}
      >
        {!collapsed &&
          cards.map((card) => (
            <li key={card.ticket_id} {...queue.itemProps(card)}>
              {queue.movable.includes(card.ticket_id) && (
                <QueueHandle
                  title={card.title}
                  mobile={mobile}
                  index={queue.movable.indexOf(card.ticket_id)}
                  count={queue.movable.length}
                  onMove={(to) => queue.move(card.ticket_id, to)}
                />
              )}
              <Card
                card={card}
                column={col}
                selected={
                  card.session_id !== null
                    ? card.session_id === selectedSessionId
                    : card.ticket_id === selectedTicketId
                }
                onSelect={onSelect}
                {...(onSelectTicket ? { onSelectTicket } : {})}
                agentStates={agentStates}
                columnTitles={columnTitles}
                showWorkflow={showWorkflow}
                {...(api ? { api } : {})}
              />
            </li>
          ))}
      </ul>
    </section>
  );
});

/** What a column needs to reorder its cards (06 §Queue order); inert without an `api`. */
interface QueueOrder {
  enabled: boolean;
  /** The column's cards, in the order just chosen until the board catches up. */
  cards: BoardCard[];
  /** The ids of the cards that may move (still waiting for a machine), in order. */
  movable: readonly string[];
  /** Some card has a hand-set place: the column offers Reset. */
  ranked: boolean;
  /** Where a dragged card would land, as an index into `movable`; null when not dragging. */
  dropAt: number | null;
  error: string | null;
  move: (id: string, to: number) => void;
  reset: () => void;
  listProps: {
    onDragOver?: (e: DragEvent<HTMLUListElement>) => void;
    onDragLeave?: (e: DragEvent<HTMLUListElement>) => void;
    onDrop?: (e: DragEvent<HTMLUListElement>) => void;
  };
  itemProps: (card: BoardCard) => Record<string, unknown>;
}

/** The MIME type a dragged queue card carries (its ticket id). */
const QUEUE_DRAG_TYPE = 'text/x-conductor-ticket';

/** `cards` with the movable ones put in `order` (the others keep their slots). */
export function withQueueOrder(cards: readonly BoardCard[], order: readonly string[]): BoardCard[] {
  const byId = new Map(cards.map((c) => [c.ticket_id, c]));
  const next = order.map((id) => byId.get(id)).filter((c) => c !== undefined);
  let i = 0;
  return cards.map((c) => (isReorderable(c) ? (next[i++] ?? c) : c));
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function useQueueOrder(api: ApiClient | undefined, columnCards: BoardCard[]): QueueOrder {
  const [pending, setPending] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const actual = columnCards.filter(isReorderable).map((c) => c.ticket_id);
  // The chosen order stands until the board shows it (its card.upserted events arrived) or the
  // set of waiting cards changes under it (a claim, a new ticket): then the board is right.
  if (
    pending !== null &&
    (sameOrder(pending, actual) ||
      pending.length !== actual.length ||
      !pending.every((id) => actual.includes(id)))
  ) {
    setPending(null);
  }
  const cards = pending === null ? columnCards : withQueueOrder(columnCards, pending);
  const movable = api ? cards.filter(isReorderable).map((c) => c.ticket_id) : [];
  const ranked = columnCards.some((c) => (c.queue_position ?? null) !== null);

  const send = (next: readonly string[]) => {
    if (!api) return;
    setPending(next);
    setError(null);
    api.reorderQueue(next).catch((err: unknown) => {
      setPending(null);
      setError(`Couldn’t reorder the queue: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const move = (id: string, to: number) => {
    const next = moveInOrder(movable, id, to);
    if (next !== movable) send(next);
  };
  const reset = () => {
    if (!api) return;
    setError(null);
    api.resetQueueOrder().catch((err: unknown) => {
      setError(`Couldn’t reset the queue: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  if (!api) {
    return {
      enabled: false,
      cards,
      movable,
      ranked,
      dropAt: null,
      error: null,
      move,
      reset,
      listProps: {},
      itemProps: () => ({}),
    };
  }
  return {
    enabled: true,
    cards,
    movable,
    ranked,
    dropAt,
    error,
    move,
    reset,
    listProps: {
      onDragOver: (e) => {
        if (dragging === null) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        // The first movable card whose middle is below the pointer; past the last: the end.
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('li[data-queue-index]')];
        const over = items.find((li) => {
          const r = li.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        setDropAt(over ? Number(over.dataset.queueIndex) : movable.length);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      },
      onDrop: (e) => {
        if (dragging === null) return;
        e.preventDefault();
        const from = movable.indexOf(dragging);
        const at = dropAt ?? movable.length;
        endDrag();
        // Dropped above itself or just below: nowhere new. Below it, the gap it leaves shifts by one.
        if (from >= 0) move(dragging, at > from ? at - 1 : at);
      },
    },
    itemProps: (card) => {
      const index = movable.indexOf(card.ticket_id);
      if (index < 0) return {};
      return {
        draggable: true,
        'data-queue-index': index,
        className: [
          'queue-movable',
          dragging === card.ticket_id ? 'dragging' : '',
          dropAt === index ? 'drop-before' : '',
        ]
          .filter(Boolean)
          .join(' '),
        onDragStart: (e: DragEvent<HTMLLIElement>) => {
          // A drag needs some data in Firefox; the id is enough.
          e.dataTransfer?.setData(QUEUE_DRAG_TYPE, card.ticket_id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          setDragging(card.ticket_id);
        },
        onDragEnd: endDrag,
      };
    },
  };
}

/**
 * A queue card's handle: drag the card by it on a desktop, or move it with the arrow keys; on a
 * phone (no drag and drop on touch), Move up / Move down buttons.
 */
function QueueHandle({
  title,
  mobile,
  index,
  count,
  onMove,
}: {
  title: string;
  mobile: boolean;
  index: number;
  count: number;
  onMove: (to: number) => void;
}) {
  if (mobile) {
    return (
      <div className="queue-handle queue-move" role="group" aria-label={`Queue place: ${title}`}>
        <button
          type="button"
          aria-label={`Move up: ${title}`}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move down: ${title}`}
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          ↓
        </button>
      </div>
    );
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    onMove(index + step);
  };
  return (
    <button
      type="button"
      className="queue-handle card-drag"
      aria-label={`Reorder: ${title}`}
      aria-keyshortcuts="ArrowUp ArrowDown"
      title="Drag to change when it is picked up, or use the arrow keys"
      onKeyDown={onKeyDown}
    >
      ⋮⋮
    </button>
  );
}

interface CardProps {
  card: BoardCard;
  /** The card's column: the meta row leaves out what it already says. */
  column: Pick<BoardColumnView, 'id' | 'title' | 'kind'>;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  /** A card with no session opens its ticket (TicketPanel). */
  onSelectTicket?: (ticketId: string) => void;
  /** The board's agent-state columns, for the plan approval's answer option. */
  agentStates: ReadonlySet<string>;
  /** Column id → title, for a pending move's target. */
  columnTitles: ReadonlyMap<string, string>;
  /** FR-1: name the card's workflow (the board mixes workflows). */
  showWorkflow: boolean;
  api?: ApiClient;
}

function Card({
  card,
  column,
  selected,
  onSelect,
  onSelectTicket,
  agentStates,
  columnTitles,
  showWorkflow,
  api,
}: CardProps) {
  const sessionId = card.session_id;
  const q = card.input_request;
  const cls = q ? classifyRequest(q) : null;
  // 06 §Plan approval: a card has no return_to, so its agent columns stand in for it (TD-184).
  const plan =
    cls === 'plan_approval' ? planOptions(card.human_transitions, agentStates, agentStates) : null;
  // UX-5: in a gate step the agent has exited and conductor runs the step, so no "running" agent.
  const conductor = isConductorStep(card);
  const idle = agentIdle(card);
  const agent = cardAgent(card);
  const name = agent.name;
  const meta = cardMeta(card, column, { showWorkflow });
  // UXR-33 (FR-4): at most one action; the panel has the rest.
  const action = cardAction(card, cls, plan);
  return (
    <article className={`card${selected ? ' selected' : ''}`} data-ticket={card.ticket_id}>
      <button
        type="button"
        className="card-open"
        disabled={sessionId === null && !onSelectTicket}
        aria-pressed={selected}
        onClick={() =>
          sessionId !== null ? onSelect(sessionId) : onSelectTicket?.(card.ticket_id)
        }
      >
        <span className="card-title">{card.title}</span>
      </button>
      <div className="card-meta">
        {card.kind && (
          <span className={`tag tag-kind tag-${card.kind}`}>{TICKET_KIND_LABELS[card.kind]}</span>
        )}
        <span
          className="card-agent"
          title={
            agent.seed === null
              ? 'Not assigned yet'
              : idle
                ? `Agent ${name} is idle: conductor is checking`
                : `Agent ${name}`
          }
        >
          <AgentAvatar
            seed={agent.seed}
            size={24}
            {...(idle ? { className: 'avatar-idle' } : {})}
          />
          {name}
          {idle && <span className="visually-hidden"> (idle)</span>}
        </span>
        {card.external_ref && <span className="ref">{card.external_ref}</span>}
        {card.schedule && (
          // UXR-83 FR-5: the chip opens its schedule.
          <a
            className="ref card-schedule"
            href={routeHash({ view: 'schedules', scheduleId: card.schedule.id })}
            title={`Recurring: ${card.schedule.name}. Open its schedule`}
          >
            ↻ {card.schedule.name}
          </a>
        )}
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
      {card.column === 'needs_input' && (card.proposals_pending ?? 0) > 0 && (
        <span
          className="badge badge-proposals"
          title="The agent proposed follow-up tickets: approve or dismiss them in the ticket"
        >
          {card.proposals_pending} proposed
        </span>
      )}
      {card.alerts && card.alerts.length > 0 && (
        <AlertBadge files={[...new Set(card.alerts.flatMap((a) => a.files))]} />
      )}
      {conductor ? null : card.pending ? (
        <PendingChecklist
          pending={card.pending}
          toTitle={columnTitles.get(card.pending.to) ?? humanize(card.pending.to)}
        />
      ) : (
        card.checking && (
          <span
            className="badge badge-checking"
            title={`checking requirements for ${card.checking.title} (${card.checking.phase})`}
          >
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
          {/* UXR-31: no age here; the meta row says it once. */}
          <span className={badgeClass(cls, q.kind)} title={requestLabel(cls, q.kind)}>
            {requestLabel(cls, q.kind)}
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
        </div>
      )}
      {action?.kind === 'review_pr' && (
        <a className="card-pr-link" href={action.url} target="_blank" rel="noreferrer">
          Review pull request ↗
        </a>
      )}
      {api && sessionId !== null && action && (
        <>
          {action.kind === 'approve_plan' && (
            <PlanApprovalActions api={api} sessionId={sessionId} plan={action.plan} />
          )}
          {action.kind === 'option' && q && (
            <CardOptionButton
              key={q.id}
              api={api}
              sessionId={sessionId}
              request={q}
              option={action.option}
            />
          )}
          {action.kind === 'answer' && (
            <div className="card-options">
              <button type="button" className="primary" onClick={() => onSelect(sessionId)}>
                Answer…
              </button>
            </div>
          )}
          {action.kind === 'allow' && (
            <CardAllowOnce
              key={action.permission.request_id}
              api={api}
              permission={action.permission}
            />
          )}
          {action.kind === 'transition' && (
            <TransitionButtons api={api} sessionId={sessionId} options={[action.option]} />
          )}
        </>
      )}
    </article>
  );
}

/**
 * 06 §Plan approval on the card: Approve plan posts the approve option (`approve_plan` in v5),
 * else the answer option with the approval text. UXR-33: the card's one action; the plan, Request
 * changes… and the other actions are in the session panel (the card's title or preview opens it).
 */
function PlanApprovalActions({
  api,
  sessionId,
  plan,
}: {
  api: ApiClient;
  sessionId: string;
  plan: PlanOptions;
}) {
  // The board stream carries the card change; no reload needed.
  const { busy, error, post } = usePlanAnswer(api, sessionId);

  return (
    <div className="transitions">
      <div className="transition-buttons" role="group" aria-label="Plan to approve">
        <button
          type="button"
          className="plan-approve"
          disabled={busy}
          onClick={() => void post(planApproveRequest(plan))}
        >
          Approve plan
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
    const text = rule ?? 'no online machine can take it';
    return (
      <span className="badge badge-routing" title={text}>
        {text}
      </span>
    );
  }
  // UXR-31: one line with an ellipsis, so the hover text has all of it.
  const full = `${rule !== null ? `${rule}; ` : ''}needs a machine with ${needs.join(', ')}`;
  return (
    <span className="badge badge-routing" title={full}>
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

/** UXR-35: the request badge's class; an old server's failed run is red like a failed step. */
function badgeClass(cls: RequestClass, kind: keyof typeof KIND_LABELS): string {
  return requestTone(cls, kind) === 'failure' && cls === 'question'
    ? BADGE_CLASS.step_failed(kind)
    : BADGE_CLASS[cls](kind);
}

/** The card's request label, as text (NFR-3: never colour alone). */
export function requestLabel(cls: RequestClass, kind: keyof typeof KIND_LABELS): string {
  if (cls === 'review') return 'Ready for review';
  if (cls === 'plan_approval') return 'Plan to approve';
  if (cls === 'step_failed') return 'Step failed';
  return KIND_LABELS[kind];
}
