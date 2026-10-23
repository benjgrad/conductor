import { BOARD_COLUMNS, type BoardCard } from '@conductor/shared';
import { boardColumns, COLUMN_TITLES, type BoardState } from '../board/board.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { ago, KIND_LABELS, STATUS_LABELS, usd } from './format.js';

interface BoardProps {
  board: BoardState;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

export function Board({ board, selectedSessionId, onSelect }: BoardProps) {
  const columns = boardColumns(board);
  return (
    <div className="board">
      {BOARD_COLUMNS.map((col) => (
        <section
          key={col}
          className={`column column-${col}`}
          aria-label={COLUMN_TITLES[col]}
          data-column={col}
        >
          <h2>
            {COLUMN_TITLES[col]} <span className="count">{columns[col].length}</span>
          </h2>
          <ul>
            {columns[col].map((card) => (
              <li key={card.ticket_id}>
                <Card
                  card={card}
                  selected={card.session_id !== null && card.session_id === selectedSessionId}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface CardProps {
  card: BoardCard;
  selected: boolean;
  onSelect: (sessionId: string) => void;
}

function Card({ card, selected, onSelect }: CardProps) {
  const sessionId = card.session_id;
  const q = card.input_request;
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
        {sessionId && (
          <span className="card-agent" title={`Agent ${agentName(sessionId)}`}>
            <AgentAvatar sessionId={sessionId} size={20} />
            {agentName(sessionId)}
          </span>
        )}
        {card.external_ref && <span className="ref">{card.external_ref}</span>}
        <span>{card.workflow_state ?? card.workflow_id}</span>
        {card.status && (
          <span className={`status status-${card.status}`}>{STATUS_LABELS[card.status]}</span>
        )}
        {card.priority !== 0 && <span className="prio">P{card.priority}</span>}
        {card.spend_usd > 0 && <span>{usd(card.spend_usd)}</span>}
        <span className="age">{ago(card.updated_at)}</span>
      </div>
      {card.badges.includes('waiting_for_build_slot') && (
        <span className="badge badge-slot">waiting for build slot</span>
      )}
      {q && (
        <div className="question" title={q.question}>
          <span className={`badge badge-question kind-${q.kind}`}>
            {KIND_LABELS[q.kind]} · {ago(q.created_at)}
          </span>
          <p>{q.question}</p>
        </div>
      )}
    </article>
  );
}
