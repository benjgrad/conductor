// UXR-37 (11-web-ui §Desktop detail layout): focus mode's ticket list, in place of the board while
// a ticket is open. One group per board column, each a disclosure remembered per workflow; Done and
// the other terminal columns start collapsed. The open ticket's group always shows, so the ticket
// being read is never hidden.
import type { BoardCard } from '@conductor/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { boardColumns, type BoardColumnView, type BoardState } from '../board/board.js';
import { waitingOnYou } from '../board/waiting.js';
import { cardAgent } from './agent-identity.js';
import { badgeClass, requestLabel } from './Board.js';
import { DEFAULT_BOARD_WORKFLOW, readListCollapsed, writeListCollapsed } from './board-layout.js';
import { ago } from './format.js';
import { classifyRequest } from './request-preview.js';
import './TicketList.css';

export interface TicketListProps {
  board: BoardState;
  selectedSessionId: string | null;
  selectedTicketId: string | null;
  onSelect: (sessionId: string) => void;
  onSelectTicket?: (ticketId: string) => void;
  /** "← Board": close the panel and show the board again. */
  onShowBoard: () => void;
  /** ADR-0010: keys the remembered collapsed groups. */
  workflow?: string;
}

/** Terminal columns (Done) start collapsed and aren't counted as open tickets. */
const isTerminal = (col: Pick<BoardColumnView, 'kind'>) => col.kind === 'terminal';

/** The collapsed groups before the user has chosen any: the terminal columns. */
export function defaultListCollapsed(columns: readonly BoardColumnView[]): Set<string> {
  return new Set(columns.filter(isTerminal).map((c) => c.id));
}

export function TicketList({
  board,
  selectedSessionId,
  selectedTicketId,
  onSelect,
  onSelectTicket,
  onShowBoard,
  workflow = DEFAULT_BOARD_WORKFLOW,
}: TicketListProps) {
  const columns = useMemo(() => boardColumns(board), [board]);
  const permissions = useMemo(() => waitingOnYou(board.cards.values()).permissions.length, [board]);
  // null: nothing stored yet, so the defaults apply (they follow the columns as they load).
  const [stored, setStored] = useState<ReadonlySet<string> | null>(() =>
    readListCollapsed(workflow),
  );
  const collapsed = stored ?? defaultListCollapsed(columns);
  const isSelected = (card: BoardCard) =>
    card.session_id !== null
      ? card.session_id === selectedSessionId
      : card.ticket_id === selectedTicketId;
  const openCount = columns.filter((c) => !isTerminal(c)).reduce((n, c) => n + c.cards.length, 0);

  const toggle = (id: string, shut: boolean) => {
    const next = new Set(collapsed);
    if (shut) next.delete(id);
    else next.add(id);
    setStored(next);
    writeListCollapsed(workflow, next);
  };

  // The open ticket's row in view when the list appears (and when another ticket opens).
  const body = useRef<HTMLDivElement>(null);
  const selectedKey = selectedSessionId ?? selectedTicketId;
  useEffect(() => {
    const row = body.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  return (
    <nav className="ticket-list" aria-label="Tickets">
      <div className="ticket-list-head">
        <button type="button" className="ticket-list-board" onClick={onShowBoard}>
          ← Board
        </button>
        <span className="muted ticket-list-count">{openCount} open</span>
      </div>
      <div className="ticket-list-body" ref={body}>
        {columns
          .filter((col) => col.cards.length > 0)
          .map((col) => {
            const holdsSelected = col.cards.some(isSelected);
            // The open ticket's group always shows; that override isn't stored.
            const shut = collapsed.has(col.id) && !holdsSelected;
            return (
              <TicketGroup
                key={col.id}
                col={col}
                shut={shut}
                permissions={col.id === 'needs_input' ? permissions : 0}
                onToggle={() => toggle(col.id, shut)}
                isSelected={isSelected}
                onOpen={(card) =>
                  card.session_id !== null
                    ? onSelect(card.session_id)
                    : onSelectTicket?.(card.ticket_id)
                }
              />
            );
          })}
      </div>
    </nav>
  );
}

function TicketGroup({
  col,
  shut,
  permissions,
  onToggle,
  isSelected,
  onOpen,
}: {
  col: BoardColumnView;
  shut: boolean;
  permissions: number;
  onToggle: () => void;
  isSelected: (card: BoardCard) => boolean;
  onOpen: (card: BoardCard) => void;
}) {
  const bodyId = useId();
  return (
    <section className={`ticket-group ticket-group-${col.id}`}>
      <h3>
        <button
          type="button"
          className="ticket-group-toggle"
          aria-expanded={!shut}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="ticket-group-chevron" aria-hidden="true">
            {shut ? '▸' : '▾'}
          </span>
          <span className="ticket-group-title">{col.title}</span>{' '}
          <span className="count">{col.cards.length}</span>
          {permissions > 0 && <span className="count-waiting">+{permissions}</span>}
        </button>
      </h3>
      <ul id={bodyId} hidden={shut}>
        {!shut &&
          col.cards.map((card) => (
            <li key={card.ticket_id}>
              <TicketRow card={card} selected={isSelected(card)} onOpen={() => onOpen(card)} />
            </li>
          ))}
      </ul>
    </section>
  );
}

function TicketRow({
  card,
  selected,
  onOpen,
}: {
  card: BoardCard;
  selected: boolean;
  onOpen: () => void;
}) {
  const q = card.input_request;
  const cls = q ? classifyRequest(q) : null;
  const label = q && cls ? requestLabel(cls, q.kind) : null;
  return (
    <button
      type="button"
      className={`ticket-row${selected ? ' selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      title={card.title}
      onClick={onOpen}
    >
      <span className="ticket-row-title">{card.title}</span>
      <span className="ticket-row-meta">
        {q && cls && label && <span className={badgeClass(cls, q.kind)}>{label}</span>}
        <span className="ticket-row-agent">{cardAgent(card).name}</span>
        <span className="ticket-row-age">{ago(card.updated_at)}</span>
      </span>
    </button>
  );
}
