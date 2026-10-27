// The session panel: a compact header (agent, title, status), then two tabs. Messages is a chat
// with the agent (the live log, the open question inline, a composer pinned at the bottom);
// Details is who runs it and where, the workflow, spend, actions and the context.
import type { InputRequestDto, MachineDto, SessionDetail } from '@conductor/shared';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { useInitialPrompt, useSession } from '../board/hooks.js';
import { parseBrief } from '../brief/parse.js';
import { ticketBodyFromPrompt } from '../brief/prompt.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { BriefCard } from './BriefCard.js';
import { Composer } from './Composer.js';
import { ContextView } from './ContextView.js';
import { duration, KIND_LABELS, STATUS_LABELS, TERMINAL_STATUSES, usd } from './format.js';
import { Markdown } from './markdown.js';
import { OutputLog } from './OutputLog.js';
import { MovesList, PendingChecklist, TransitionButtons } from './transitions.js';
import { SessionWorkflowDiagram } from '../workflow/SessionWorkflowDiagram.js';
import { stateLabel } from '../workflow/review.js';

interface DetailPanelProps {
  api: ApiClient;
  sessionId: string;
  /** The card's ticket, for the agent identity before the detail loads (else card.ticket_id). */
  ticketId?: string;
  /** The card's updated_at on the board: a change refetches the detail. */
  version: string;
  onClose: () => void;
  /** ADR-0008: show another session (the new one after a reopen). */
  onSelectSession?: (sessionId: string) => void;
}

export type PanelTab = 'messages' | 'details';
const TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'details', label: 'Details' },
];

export function DetailPanel({
  api,
  sessionId,
  ticketId,
  version,
  onClose,
  onSelectSession,
}: DetailPanelProps) {
  const view = useSession(api, sessionId, version);
  const { detail, output, error, reload, history } = view;
  const [tab, setTab] = useState<PanelTab>('messages');
  // Identity is per ticket (Ben): the same agent across a ticket's retries and resumes.
  const agentKey = detail?.card.ticket_id ?? ticketId ?? null;
  const name = agentKey ? agentName(agentKey) : '';
  const ids = useId();
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  const status = detail?.card.status ?? null;

  // UX-2: the Brief. The body is `ticket_body`; an older server doesn't send it, so it falls back
  // to the ticket section of the initial prompt (Claude's transcript), fetched only when asked.
  const [wantPrompt, setWantPrompt] = useState<string | null>(null);
  const onWantPrompt = useCallback(() => setWantPrompt(sessionId), [sessionId]);
  const prompt = useInitialPrompt(api, view, wantPrompt === sessionId);
  const fromPrompt =
    detail && prompt.text !== null
      ? ticketBodyFromPrompt(prompt.text, detail.card.title, detail.card.repo)
      : null;
  const body = detail?.ticket_body ?? fromPrompt;
  const brief = useMemo(() => (body === null ? null : parseBrief(body)), [body]);
  const unavailable =
    body !== null
      ? null
      : prompt.text !== null
        ? 'the prompt has no ticket section'
        : prompt.loading
          ? null
          : prompt.reason;

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  }

  return (
    <aside className="detail" aria-label="Session detail">
      <header className="detail-head">
        {agentKey ? (
          <AgentAvatar ticketId={agentKey} size={36} />
        ) : (
          <span className="avatar avatar-placeholder" aria-hidden="true" />
        )}
        <div className="head-text">
          <h2>{detail?.card.title ?? 'Loading…'}</h2>
          <div className="head-sub">
            <span className="agent-name">{name}</span>
            {status && (
              <span className={`chip status status-${status}`}>{STATUS_LABELS[status]}</span>
            )}
            {detail?.card.workflow_state && (
              <span className="muted head-state">{stateLabel(detail.card.workflow_state)}</span>
            )}
          </div>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </header>
      <div className="tabs" role="tablist" aria-label="Session views">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${ids}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${ids}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'active' : undefined}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error detail-error">
          {error}
        </p>
      )}
      <div
        role="tabpanel"
        id={`${ids}-panel-messages`}
        aria-labelledby={`${ids}-tab-messages`}
        className="tab-body messages-tab"
        hidden={tab !== 'messages'}
      >
        {detail && (
          <>
            {history && (
              <p role="status" className={`history-notice muted history-${history.kind}`}>
                {history.text}
              </p>
            )}
            <BriefCard
              key={sessionId}
              sessionId={sessionId}
              brief={brief}
              body={body}
              unavailable={unavailable}
              promptText={prompt.text}
              promptReason={prompt.reason}
              promptLoading={prompt.loading}
              onWantPrompt={onWantPrompt}
            />
            <OutputLog
              output={output}
              moves={detail.moves ?? []}
              worktree={detail.worktree_path}
              variant="chat"
              visible={tab === 'messages'}
              tailKey={detail.pending_input?.id ?? ''}
            >
              {detail.pending_input && (
                <PendingInput
                  key={detail.pending_input.id}
                  api={api}
                  detail={detail}
                  agent={name}
                  request={detail.pending_input}
                  onDone={reload}
                />
              )}
            </OutputLog>
            {detail.card.session_id !== null && (
              <TransitionButtons
                api={api}
                sessionId={detail.card.session_id}
                options={detail.card.human_transitions}
                workflow={detail.workflow}
                onDone={reload}
              />
            )}
            <Composer
              api={api}
              detail={detail}
              agentName={name}
              onDone={reload}
              {...(onSelectSession ? { onReopened: onSelectSession } : {})}
              onShowDetails={() => {
                setTab('details');
                tabRefs.current.details?.focus();
              }}
            />
          </>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel-details`}
        aria-labelledby={`${ids}-tab-details`}
        className="tab-body details-tab"
        hidden={tab !== 'details'}
      >
        {detail && (
          <>
            <AgentCard api={api} detail={detail} sessionId={sessionId} name={name} />
            <WorkflowSection detail={detail} />
            <section aria-label="Moves">
              <h3>Moves</h3>
              <MovesList moves={detail.moves ?? []} workflow={detail.workflow} />
            </section>
            <BudgetSection detail={detail} />
            <Actions api={api} detail={detail} onDone={reload} />
            <section aria-label="Context">
              <h3>Context</h3>
              <ContextView context={detail.context} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- Messages

interface PendingInputProps {
  api: ApiClient;
  detail: SessionDetail;
  agent: string;
  request: InputRequestDto;
  onDone: () => void;
}

/**
 * ADR-0011: an old workflow version offers no human transitions (`human_transitions` is empty),
 * so it keeps the M1 quick actions and /retry; a newer one has a button per transition instead.
 */
export function isOldVersion(detail: SessionDetail): boolean {
  return detail.card.human_transitions.length === 0;
}

/**
 * The open input request, inline at the end of the chat. The composer answers it; on old
 * versions, non-agent kinds also get the quick actions (06): retry, skip to…, abort.
 */
function PendingInput({ api, detail, agent, request, onDone }: PendingInputProps) {
  const sessionId = request.session_id;
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

  const fromAgent = request.kind === 'agent_question';
  return (
    <section aria-label="Pending input" className="pending">
      <div className="pending-head">
        <span className={`badge badge-question kind-${request.kind}`}>
          {KIND_LABELS[request.kind]}
        </span>
        <span className="muted">{fromAgent ? `${agent} asks` : 'Conductor needs a decision'}</span>
      </div>
      <div className="question-text">
        <Markdown text={request.question} />
      </div>
      <p className="pending-hint muted">Reply in the box below to answer.</p>
      {!fromAgent && isOldVersion(detail) && (
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

// ---------------------------------------------------------------- Details

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function AgentCard({
  api,
  detail,
  sessionId,
  name,
}: {
  api: ApiClient;
  detail: SessionDetail;
  sessionId: string;
  name: string;
}) {
  const { card } = detail;
  const machineId = card.machine_id;
  const [machine, setMachine] = useState<MachineDto | null>(null);
  useEffect(() => {
    if (machineId === null) return;
    let cancelled = false;
    api.listMachines().then(
      (list) => {
        if (!cancelled) setMachine(list.find((m) => m.id === machineId) ?? null);
      },
      // Best effort: without the machine list the id alone is shown.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, machineId]);
  const shown = machine?.id === machineId ? machine : null;

  return (
    <section aria-label="Agent" className="agent-card">
      <div className="agent-who">
        <AgentAvatar ticketId={card.ticket_id} size={64} title={`${name}'s avatar`} />
        <div>
          <div className="agent-card-name">{name}</div>
          <div className="muted">Claude Code agent</div>
        </div>
      </div>
      <dl className="kv">
        <dt>Machine</dt>
        <dd>
          {machineId === null ? (
            <span className="muted">not on a machine right now</span>
          ) : (
            <span className="machine">
              {shown && (
                <span
                  className={`dot dot-${shown.status}`}
                  role="img"
                  aria-label={shown.status}
                  title={shown.status}
                />
              )}
              <strong>{shown?.hostname ?? machineId}</strong>
              {shown && shown.hostname !== machineId && (
                <span className="muted"> ({machineId})</span>
              )}
              {shown && <span className="muted"> · {shown.status}</span>}
            </span>
          )}
        </dd>
        <dt>Session</dt>
        <dd className="copyable">
          <code>{sessionId}</code>
          <CopyButton text={sessionId} label="session id" />
        </dd>
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
        {detail.worktree_path && (
          <>
            <dt>Worktree</dt>
            <dd className="copyable">
              <code>{detail.worktree_path}</code>
              <CopyButton text={detail.worktree_path} label="worktree path" />
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function WorkflowSection({ detail }: { detail: SessionDetail }) {
  const { card, workflow } = detail;
  return (
    <section aria-label="Workflow">
      <h3>Workflow</h3>
      <p className="state-line">
        <strong>{card.workflow_state ? stateLabel(card.workflow_state) : '—'}</strong>{' '}
        <span className="muted">
          in {workflow.id} v{detail.workflow_version}
        </span>
        {card.badges.includes('waiting_for_build_slot') && (
          <span className="badge badge-slot">waiting for build slot</span>
        )}
      </p>
      {/* A compact list of states; the state diagram (SessionWorkflowDiagram, ADR-0009) follows. */}
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
      {card.pending && <PendingChecklist pending={card.pending} />}
      <SessionWorkflowDiagram detail={detail} />
      {detail.return_to && (
        <p className="muted returns-to">
          Returns to <strong>{detail.return_to}</strong> after the answer.
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
  // A pending non-agent request on an old version already offers Abort (the quick actions).
  const canCancel = !(
    detail.pending_input &&
    detail.pending_input.kind !== 'agent_question' &&
    isOldVersion(detail)
  );

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
      <h3>Actions</h3>
      <div className="actions-row">
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
      </div>
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
