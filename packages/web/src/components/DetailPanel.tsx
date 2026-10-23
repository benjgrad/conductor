import type { InputRequestDto, SessionDetail } from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { useSession } from '../board/hooks.js';
import { duration, KIND_LABELS, STATUS_LABELS, TERMINAL_STATUSES, usd } from './format.js';
import { OutputLog } from './OutputLog.js';

interface DetailPanelProps {
  api: ApiClient;
  sessionId: string;
  /** The card's updated_at on the board: a change refetches the detail. */
  version: string;
  onClose: () => void;
}

export function DetailPanel({ api, sessionId, version, onClose }: DetailPanelProps) {
  const { detail, output, error, reload } = useSession(api, sessionId, version);
  return (
    <aside className="detail" aria-label="Session detail">
      <header>
        <h2>{detail?.card.title ?? 'Loading…'}</h2>
        <button type="button" className="close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {detail && (
        <>
          <StateSection detail={detail} />
          {detail.pending_input && (
            <PendingInput
              key={detail.pending_input.id}
              api={api}
              detail={detail}
              request={detail.pending_input}
              onDone={reload}
            />
          )}
          <Actions api={api} detail={detail} onDone={reload} />
          <BudgetSection detail={detail} />
          <ContextSection detail={detail} />
          <OutputLog output={output} worktree={detail.worktree_path} />
        </>
      )}
    </aside>
  );
}

function StateSection({ detail }: { detail: SessionDetail }) {
  const { card, workflow } = detail;
  return (
    <section aria-label="State">
      <h3>State</h3>
      <p className="state-line">
        {card.status && (
          <span className={`status status-${card.status}`}>{STATUS_LABELS[card.status]}</span>
        )}{' '}
        <strong>{card.workflow_state ?? '—'}</strong> in {workflow.id} v{detail.workflow_version}
        {card.machine_id && <> on {card.machine_id}</>}
        {card.badges.includes('waiting_for_build_slot') && (
          <span className="badge badge-slot">waiting for build slot</span>
        )}
      </p>
      {/* TD-033: a flat list of states; the 06 state diagram (graph layout) comes later. */}
      <ol className="states">
        {Object.entries(workflow.states).map(([name, state]) => (
          <li
            key={name}
            className={`state state-${state.type}${name === card.workflow_state ? ' current' : ''}`}
            aria-current={name === card.workflow_state ? 'step' : undefined}
          >
            {name}
          </li>
        ))}
      </ol>
      <dl className="kv">
        {detail.return_to && (
          <>
            <dt>Returns to</dt>
            <dd>{detail.return_to}</dd>
          </>
        )}
        {detail.branch && (
          <>
            <dt>Branch</dt>
            <dd>
              <code>{detail.branch}</code>
            </dd>
          </>
        )}
        <dt>Repo</dt>
        <dd>{card.repo}</dd>
      </dl>
    </section>
  );
}

interface PendingInputProps {
  api: ApiClient;
  detail: SessionDetail;
  request: InputRequestDto;
  onDone: () => void;
}

/** The pending input request: answer box, plus quick actions for non-agent kinds (06). */
function PendingInput({ api, detail, request, onDone }: PendingInputProps) {
  const sessionId = request.session_id;
  const [answer, setAnswer] = useState('');
  const [skipTo, setSkipTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skipTargets = Object.entries(detail.workflow.states)
    .filter(([, s]) => s.type !== 'human')
    .map(([name]) => name);

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const send = (text: string, goto?: string) =>
    run(() =>
      api.answer(sessionId, {
        input_request_id: request.id,
        answer: text,
        ...(goto ? { goto } : {}),
      }),
    );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = answer.trim();
    if (text) void send(text);
  }

  return (
    <section aria-label="Pending input" className="pending">
      <h3>
        <span className={`badge badge-question kind-${request.kind}`}>
          {KIND_LABELS[request.kind]}
        </span>
      </h3>
      <p className="question-text">{request.question}</p>
      <form onSubmit={onSubmit}>
        <label htmlFor={`answer-${request.id}`}>Answer</label>
        <textarea
          id={`answer-${request.id}`}
          value={answer}
          rows={3}
          onChange={(e) => setAnswer(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || answer.trim() === ''}>
          Send answer
        </button>
      </form>
      {request.kind !== 'agent_question' && (
        <div className="quick-actions" role="group" aria-label="Quick actions">
          <button type="button" disabled={busy} onClick={() => void send('retry')}>
            {/* No goto: input.provided returns to return_to, else the workflow start (U-037). */}
            Retry {detail.return_to ?? detail.workflow.start}
          </button>
          <span className="skip">
            <select
              aria-label="Skip to state"
              value={skipTo}
              onChange={(e) => setSkipTo(e.target.value)}
              disabled={busy}
            >
              <option value="">skip to…</option>
              {skipTargets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || skipTo === ''}
              onClick={() => void send(`skip to ${skipTo}`, skipTo)}
            >
              Skip
            </button>
          </span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void run(() => api.cancel(sessionId, { reason: 'aborted from UI' }))}
          >
            Abort
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Approve (event states waiting on ui.approve) and cancel. */
function Actions({
  api,
  detail,
  onDone,
}: {
  api: ApiClient;
  detail: SessionDetail;
  onDone: () => void;
}) {
  const { card } = detail;
  const sessionId = card.session_id;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sessionId === null || card.status === null || TERMINAL_STATUSES.has(card.status)) return null;

  const state = card.workflow_state ? detail.workflow.states[card.workflow_state] : undefined;
  const canApprove =
    card.status === 'waiting_external' &&
    state?.type === 'event' &&
    state.wait_for.includes('ui.approve');
  // A pending non-agent request already offers Abort.
  const canCancel = !(detail.pending_input && detail.pending_input.kind !== 'agent_question');

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canApprove && !canCancel) return null;
  return (
    <section aria-label="Actions" className="actions">
      {canApprove && (
        <div className="approve">
          <input
            aria-label="Approval comment"
            placeholder="comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.approve(sessionId, comment.trim() ? { comment: comment.trim() } : {}),
              )
            }
          >
            Approve
          </button>
        </div>
      )}
      {canCancel && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void run(() => api.cancel(sessionId, { reason: 'cancelled from UI' }))}
        >
          Cancel session
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <meter min={0} max={max} value={Math.min(value, max)} high={max * 0.8} aria-label={label} />
      <span className={pct >= 100 ? 'over' : undefined}>{text}</span>
    </div>
  );
}

function BudgetSection({ detail }: { detail: SessionDetail }) {
  const minutes = detail.wall_seconds / 60;
  return (
    <section aria-label="Budget" className="budget">
      <h3>Spend &amp; time</h3>
      <Meter
        label="Spend"
        value={detail.spend_usd}
        max={detail.budget.usd}
        text={`${usd(detail.spend_usd)} / ${usd(detail.budget.usd)}`}
      />
      <Meter
        label="Time"
        value={minutes}
        max={detail.budget.minutes}
        text={`${duration(detail.wall_seconds)} / ${detail.budget.minutes}m`}
      />
    </section>
  );
}

function ContextSection({ detail }: { detail: SessionDetail }) {
  const entries = Object.entries(detail.context).flatMap(([state, values]) =>
    Object.entries(values).map(([key, v]) => [`${state}.${key}`, v] as const),
  );
  return (
    <section aria-label="Context">
      <h3>Context</h3>
      {entries.length === 0 ? (
        <p className="muted">No context yet.</p>
      ) : (
        <dl className="kv">
          {entries.map(([k, v]) => (
            <ContextEntry key={k} name={k} value={v} />
          ))}
        </dl>
      )}
    </section>
  );
}

function ContextEntry({ name, value }: { name: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const isUrl = typeof value === 'string' && /^https?:\/\//.test(value);
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {isUrl ? (
          <a href={text} target="_blank" rel="noreferrer">
            {text}
          </a>
        ) : (
          <code>{text}</code>
        )}
      </dd>
    </>
  );
}
