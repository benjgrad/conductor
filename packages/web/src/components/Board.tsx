import type { BoardCard } from '@conductor/shared';
import { boardColumns, type BoardState } from '../board/board.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { ago, KIND_LABELS, STATUS_LABELS, usd } from './format.js';
import { stateLabel } from '../workflow/review.js';

interface BoardProps {
  board: BoardState;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

export function Board({ board, selectedSessionId, onSelect }: BoardProps) {
  const columns = boardColumns(board);
  return (
    <div className="board">
      {columns.map((col) => (
        <section
          key={col.id}
          className={`column column-${col.id} column-kind-${col.kind}`}
          aria-label={col.title}
          data-column={col.id}
        >
          <h2>
            {col.title} <span className="count">{col.cards.length}</span>
          </h2>
          <ul>
            {col.cards.map((card) => (
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
        <span className="card-agent" title={`Agent ${agentName(card.ticket_id)}`}>
          <AgentAvatar ticketId={card.ticket_id} size={20} />
          {agentName(card.ticket_id)}
        </span>
        {card.external_ref && <span className="ref">{card.external_ref}</span>}
        <span>{card.workflow_state ? stateLabel(card.workflow_state) : card.workflow_id}</span>
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
      {card.checking && (
        <span className="badge badge-checking">
          checking requirements for {card.checking.title} ({card.checking.phase})
        </span>
      )}
      {(['failed', 'lost', 'cancelled'] as const).map(
        (b) =>
          card.badges.includes(b) && (
            <span key={b} className={`badge badge-${b}`}>
              {b}
            </span>
          ),
      )}
      {card.pr_url && (
        <a className="badge badge-pr" href={card.pr_url} target="_blank" rel="noreferrer">
          pull request
        </a>
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
