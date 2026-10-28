// The session panel: a compact header (agent, title, status), then two tabs. Messages is a chat
// with the agent (the live log, the open question inline, a composer pinned at the bottom);
// Details tells the ticket's story in STAR order (UX-7, StarDetails.tsx), with who runs it and
// where, the workflow, spend and the context under Technical details.
import type { HumanTransitionOption, InputRequestDto, SessionDetail } from '@conductor/shared';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { useInitialPrompt, useSession } from '../board/hooks.js';
import { parseBrief } from '../brief/parse.js';
import { ticketBodyFromPrompt } from '../brief/prompt.js';
import { AgentAvatar, agentName } from './agent-identity.js';
import { BriefCard } from './BriefCard.js';
import { Composer } from './Composer.js';
import {
  agentIdle,
  ConductorCheckBanner,
  failedItemOfQuestion,
  isConductorStep,
} from './ConductorChecks.js';
import { isOldVersion } from './details-sections.js';
import { KIND_LABELS, STATUS_LABELS } from './format.js';
import { FreshConversation, freshConversationOffer } from './FreshConversation.js';
import { Markdown } from './markdown.js';
import { OutputLog } from './OutputLog.js';
import { PlanApprovalRequest } from './PlanApprovalRequest.js';
import { classifyRequest, lastMoveTransition, planAnswerOption } from './request-preview.js';
import { ReviewRequest } from './ReviewRequest.js';
import { StarDetails } from './StarDetails.js';
import { TransitionButtons } from './transitions.js';
import { displayState } from '../workflow/review.js';

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

export { isOldVersion };

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
  const planOption = detail ? planApprovalOption(detail) : null;

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
          <AgentAvatar
            ticketId={agentKey}
            size={36}
            {...(detail && agentIdle(detail.card) ? { className: 'avatar-idle' } : {})}
          />
        ) : (
          <span className="avatar avatar-placeholder" aria-hidden="true" />
        )}
        <div className="head-text">
          <h2>{detail?.card.title ?? 'Loading…'}</h2>
          <div className="head-sub">
            <span className="agent-name">{name}</span>
            {detail && isConductorStep(detail.card) ? (
              // UX-5: conductor runs the step; the agent has exited, so it isn't "running".
              <span className="chip status status-conductor">Conductor is checking</span>
            ) : (
              status && (
                <span className={`chip status status-${status}`}>{STATUS_LABELS[status]}</span>
              )
            )}
            {/* UX-6: in a conductor step the chip says it all; never the synthetic label. */}
            {detail?.card.workflow_state && !isConductorStep(detail.card) && (
              <span className="muted head-state">
                {displayState(detail.card.workflow_state, detail.workflow)}
              </span>
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
            {isConductorStep(detail.card) && (
              <ConductorCheckBanner card={detail.card} agent={name} />
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
              workflow={detail.workflow}
              checking={detail.card.checking}
              failedItem={stepFailedItem(detail)}
              active={commandActive(detail)}
              worktree={detail.worktree_path}
              variant="chat"
              visible={tab === 'messages'}
              tailKey={detail.pending_input?.id ?? ''}
            >
              {detail.pending_input &&
                (classifyRequest(detail.pending_input, lastMoveTransition(detail)) === 'review' ? (
                  <ReviewRequest
                    key={detail.pending_input.id}
                    detail={detail}
                    agent={name}
                    request={detail.pending_input}
                  />
                ) : planOption ? (
                  <PlanApprovalRequest
                    key={detail.pending_input.id}
                    api={api}
                    detail={detail}
                    agent={name}
                    request={detail.pending_input}
                    option={planOption}
                    onDone={reload}
                  />
                ) : (
                  <PendingInput
                    key={detail.pending_input.id}
                    api={api}
                    detail={detail}
                    agent={name}
                    request={detail.pending_input}
                    onDone={reload}
                  />
                ))}
            </OutputLog>
            {/* 06 §Plan approval: the plan panel carries the buttons (other actions inside). */}
            {detail.card.session_id !== null && !planOption && (
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
            <StarDetails
              key={sessionId}
              api={api}
              detail={detail}
              sessionId={sessionId}
              name={name}
              brief={brief}
              body={body}
              onReload={reload}
            />
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- Messages

/**
 * 06 §Plan approval: the answer option when the open request is a plan to approve and the card
 * offers the `$return_to` answer; null otherwise (the generic request and buttons).
 */
function planApprovalOption(detail: SessionDetail): HumanTransitionOption | null {
  const request = detail.pending_input;
  if (!request || classifyRequest(request, lastMoveTransition(detail)) !== 'plan_approval') {
    return null;
  }
  if (detail.card.session_id === null) return null;
  return planAnswerOption(detail.card.human_transitions, detail.return_to);
}

/** UX-6: the check an open "Step failed" question names, for its run's status. */
function stepFailedItem(detail: SessionDetail): string | null {
  const request = detail.pending_input;
  if (!request || classifyRequest(request) !== 'step_failed') return null;
  return failedItemOfQuestion(request.question)?.item ?? null;
}

/** UX-6: conductor is running a command for the session (a gate step, or a command state). */
function commandActive(detail: SessionDetail): boolean {
  const { card, workflow } = detail;
  if (isConductorStep(card)) return true;
  const state = card.workflow_state ? workflow.states[card.workflow_state] : undefined;
  return card.status === 'running' && state?.type === 'command';
}

interface PendingInputProps {
  api: ApiClient;
  detail: SessionDetail;
  agent: string;
  request: InputRequestDto;
  onDone: () => void;
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
  const stepFailed = classifyRequest(request) === 'step_failed';
  // UX-5 FR-4: the failed item and its first error line, above the full question.
  const failed = stepFailed ? failedItemOfQuestion(request.question) : null;
  // The escape hatch for an agent that can't resume: first (highlighted) on a failure, the stuck
  // case; otherwise a secondary action at the end.
  const offer = freshConversationOffer(detail, request);
  const fresh =
    offer === 'none' ? null : (
      <FreshConversation
        api={api}
        sessionId={sessionId}
        prominent={offer === 'prominent'}
        onDone={onDone}
      />
    );
  return (
    <section aria-label="Pending input" className="pending">
      <div className="pending-head">
        {stepFailed ? (
          <span className="badge badge-step-failed">Step failed</span>
        ) : (
          <span className={`badge badge-question kind-${request.kind}`}>
            {KIND_LABELS[request.kind]}
          </span>
        )}
        <span className="muted">{fromAgent ? `${agent} asks` : 'Conductor needs a decision'}</span>
      </div>
      {failed?.error && (
        <p className="step-failed-item">
          {failed.item && <strong>{failed.item}</strong>}
          {failed.item ? ': ' : ''}
          {failed.error}
        </p>
      )}
      <div className="question-text">
        <Markdown text={request.question} />
      </div>
      {offer === 'prominent' && fresh}
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
      {offer === 'secondary' && fresh}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
