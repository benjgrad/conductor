import type { BoardCard, HumanTransitionOption } from '@conductor/shared';
import type { ApiClient } from '../api/client.js';
import { boardColumns, type BoardState } from '../board/board.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { ago, KIND_LABELS, STATUS_LABELS, TICKET_KIND_LABELS, usd } from './format.js';
import { usePlanAnswer } from './plan-answer.js';
import { PendingChecklist, TransitionButtons } from './transitions.js';
import { stateLabel } from '../workflow/review.js';
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
import { routingNeeds } from '../machines/format.js';
import './Board.css';

interface BoardProps {
  board: BoardState;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** ADR-0011: with it, Needs-input cards get their human transition buttons. */
  api?: ApiClient;
}

export function Board({ board, selectedSessionId, onSelect, api }: BoardProps) {
  const columns = boardColumns(board);
  // 06 §Plan approval: a card has no `return_to`; its answer option goes into an agent column.
  const agentStates = new Set(columns.filter((c) => c.kind === 'agent').map((c) => c.id));
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
                  agentStates={agentStates}
                  {...(api ? { api } : {})}
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
  /** The board's agent-state columns, for the plan approval's answer option. */
  agentStates: ReadonlySet<string>;
  api?: ApiClient;
}

function Card({ card, selected, onSelect, agentStates, api }: CardProps) {
  const sessionId = card.session_id;
  const q = card.input_request;
  const cls = q ? classifyRequest(q) : null;
  const planOption =
    cls === 'plan_approval' ? planAnswerOption(card.human_transitions, agentStates) : null;
  // UX-5: in a gate step the agent has exited and conductor runs the step, so no "running" agent.
  const conductor = isConductorStep(card);
  const idle = agentIdle(card);
  const name = agentName(card.ticket_id);
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
            <span>{card.workflow_state ? stateLabel(card.workflow_state) : card.workflow_id}</span>
            {card.status && (
              <span className={`status status-${card.status}`}>{STATUS_LABELS[card.status]}</span>
            )}
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
        <RoutingBadge needs={routingNeeds(card.routing)} />
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
function RoutingBadge({ needs }: { needs: string[] }) {
  if (needs.length === 0) {
    return <span className="badge badge-routing">no online machine can take it</span>;
  }
  return (
    <span className="badge badge-routing">
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
