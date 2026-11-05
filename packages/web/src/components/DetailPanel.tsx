// The session panel: a compact header (agent, title, status), then one row with two tabs and the
// ticket buttons (Brief, Plan, Edit), whose sheets open over the tab bodies (TicketStrip.tsx,
// 11-web-ui §Phone layout). Messages is a chat with the agent (the live log, the open question
// inline, a composer pinned at the bottom); Details tells the ticket's story in STAR order (UX-7, StarDetails.tsx), with who runs it and
// where, the workflow, spend and the context under Technical details.
import type { BoardCard, InputRequestDto, SessionDetail } from '@conductor/shared';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { useInitialPrompt, useSession } from '../board/hooks.js';
import { parseBrief } from '../brief/parse.js';
import { ticketBodyFromPrompt } from '../brief/prompt.js';
import { AgentAvatar, cardAgent } from './agent-identity.js';
import { Composer } from './Composer.js';
import {
  agentIdle,
  ConductorCheckBanner,
  failedItemOfQuestion,
  isConductorStep,
} from './ConductorChecks.js';
import { isOldVersion, SessionInsightSection } from './details-sections.js';
import { headStatus, KIND_LABELS, TERMINAL_STATUSES } from './format.js';
import { FreshConversation, freshConversationOffer } from './FreshConversation.js';
import { Markdown } from './markdown.js';
import { OutputLog } from './OutputLog.js';
import { PermissionRequests } from './PermissionRequests.js';
import { QuestionOptions } from './QuestionOptions.js';
import { PlanApprovalRequest } from './PlanApprovalRequest.js';
import { ProposedTickets, visibleProposals } from './ProposedTickets.js';
import {
  agentStatesOf,
  classifyRequest,
  lastMoveTransition,
  planOptions,
  type PlanOptions,
} from './request-preview.js';
import { ReviewRequest } from './ReviewRequest.js';
import { StarDetails } from './StarDetails.js';
import { TicketButtons, TicketSheet, type StripSheet } from './TicketStrip.js';
import { TransitionButtons } from './transitions.js';

interface DetailPanelProps {
  api: ApiClient;
  sessionId: string;
  /** The board card, for the agent identity before the detail loads (else `detail.card`). */
  card?: BoardCard;
  /** The card's updated_at on the board: a change refetches the detail. */
  version: string;
  onClose: () => void;
  /** 11-web-ui §Detail panel: the phone's full-screen panel, with Back to board instead of ×. */
  fullScreen?: boolean;
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
  card,
  version,
  onClose,
  fullScreen = false,
  onSelectSession,
}: DetailPanelProps) {
  const view = useSession(api, sessionId, version);
  const { detail, output, error, reload, history } = view;
  const [tab, setTab] = useState<PanelTab>('messages');
  // The ticket buttons' open sheet (Brief, Plan, Edit), per session.
  const [sheetOf, setSheetOf] = useState<{ id: string; sheet: StripSheet } | null>(null);
  const sheet = sheetOf?.id === sessionId ? sheetOf.sheet : null;
  const onSheet = useCallback(
    (next: StripSheet | null) => setSheetOf(next === null ? null : { id: sessionId, sheet: next }),
    [sessionId],
  );
  const openPlan = useCallback(() => onSheet('plan'), [onSheet]);
  // Picking a tab closes an open sheet: the sheet covers the tab bodies.
  const selectTab = useCallback((next: PanelTab) => {
    setTab(next);
    setSheetOf(null);
  }, []);
  // UX-13b: the ticket's stored teammate (kept across retries and resumes); the board card's
  // until the detail loads.
  const agent = detail ? cardAgent(detail.card, detail.agent_name) : card ? cardAgent(card) : null;
  const name = agent?.name ?? '';
  // In prose ("Message …"), an unassigned ticket's agent is just "the agent".
  const proseName = agent && agent.seed !== null ? agent.name : 'the agent';
  const ids = useId();
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  // UXR-40: one chip, in titles; UXR-32 FR-2: "Waiting for permission" while one is held.
  const head = detail ? headStatus(detail.card, detail.workflow) : null;
  const plan = detail ? planApprovalOptions(detail) : null;

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
    selectTab(id);
    tabRefs.current[id]?.focus();
  }

  return (
    <aside className={`detail${fullScreen ? ' full-screen' : ''}`} aria-label="Session detail">
      <header className="detail-head">
        {fullScreen && (
          <button type="button" className="back" onClick={onClose} aria-label="Back to board">
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
        {agent ? (
          <AgentAvatar
            seed={agent.seed}
            size={fullScreen ? 32 : 40}
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
              // UXR-40: one chip, in titles (never the status and the state side by side).
              head && (
                <span className={`chip status status-${head.key}`} title={head.label}>
                  {head.label}
                </span>
              )
            )}
          </div>
        </div>
        {!fullScreen && (
          <button type="button" className="close" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        )}
      </header>
      <div className="tabs detail-tabbar">
        <div role="tablist" aria-label="Session views" className="detail-tablist">
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
              onClick={() => selectTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
        {detail && (
          <TicketButtons
            key={sessionId}
            detail={detail}
            planActions={plan}
            brief={brief}
            sheet={sheet}
            onSheet={onSheet}
            sheetId={`${ids}-sheet`}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="error detail-error">
          {error}
        </p>
      )}
      <div className="detail-body">
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
                tailKey={detail.pending_input?.id ?? detail.card.permission?.request_id ?? ''}
              >
                {detail.pending_input &&
                  (classifyRequest(detail.pending_input, lastMoveTransition(detail)) ===
                  'review' ? (
                    <ReviewRequest
                      key={detail.pending_input.id}
                      api={api}
                      detail={detail}
                      agent={name}
                      request={detail.pending_input}
                    />
                  ) : plan ? (
                    <PlanApprovalRequest
                      key={detail.pending_input.id}
                      api={api}
                      detail={detail}
                      agent={name}
                      request={detail.pending_input}
                      plan={plan}
                      onDone={reload}
                      {...(fullScreen ? { onOpenPlan: openPlan } : {})}
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
                {detail.card.sub_status === 'needs_permission' &&
                  detail.card.permission &&
                  detail.card.session_id !== null && (
                    <PermissionRequests
                      api={api}
                      sessionId={detail.card.session_id}
                      permission={detail.card.permission}
                      agent={name}
                      onDone={reload}
                    />
                  )}
              </OutputLog>
              {/* 06 §Plan approval: the plan panel carries the buttons (other actions inside). */}
              {detail.card.session_id !== null && !plan && (
                <TransitionButtons
                  api={api}
                  sessionId={detail.card.session_id}
                  options={detail.card.human_transitions}
                  workflow={detail.workflow}
                  onDone={reload}
                />
              )}
              {/* 06 §Proposed tickets: only while the ticket waits in Needs input. */}
              <ProposedTickets
                api={api}
                ticketId={detail.card.ticket_id}
                ticketTitle={detail.card.title}
                proposals={visibleProposals(detail.card.column, detail.proposals)}
                workflow={detail.workflow}
                onDone={reload}
              />
              <Composer
                api={api}
                detail={detail}
                agentName={proseName}
                onDone={reload}
                {...(onSelectSession ? { onReopened: onSelectSession } : {})}
                onShowDetails={() => {
                  selectTab('details');
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
              <SessionInsightSection
                key={`insight-${sessionId}`}
                api={api}
                sessionId={sessionId}
                finished={detail.card.status !== null && TERMINAL_STATUSES.has(detail.card.status)}
              />
            </>
          )}
        </div>
        {detail && sheet !== null && (
          <TicketSheet
            key={sessionId}
            id={`${ids}-sheet`}
            api={api}
            detail={detail}
            planActions={plan}
            agentRunning={agentStateRunning(detail)}
            sheet={sheet}
            onSheet={onSheet}
            onReload={reload}
            brief={brief}
            body={body}
            unavailable={unavailable}
            promptText={prompt.text}
            promptReason={prompt.reason}
            promptLoading={prompt.loading}
            onWantPrompt={onWantPrompt}
          />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- Messages

/**
 * 06 §Plan approval: the answer and approve options when the open request is a plan to approve
 * and the card offers the `$return_to` answer; null otherwise (the generic request and buttons).
 */
function planApprovalOptions(detail: SessionDetail): PlanOptions | null {
  const request = detail.pending_input;
  if (!request || classifyRequest(request, lastMoveTransition(detail)) !== 'plan_approval') {
    return null;
  }
  if (detail.card.session_id === null) return null;
  return planOptions(
    detail.card.human_transitions,
    detail.return_to,
    agentStatesOf(detail.workflow),
  );
}

/** UX-6: the check an open "Step failed" question names, for its run's status. */
function stepFailedItem(detail: SessionDetail): string | null {
  const request = detail.pending_input;
  if (!request || classifyRequest(request) !== 'step_failed') return null;
  return failedItemOfQuestion(request.question)?.item ?? null;
}

/** The session is running an agent state (its live process won't see a ticket edit). */
function agentStateRunning(detail: SessionDetail): boolean {
  const { card, workflow } = detail;
  const state = card.workflow_state ? workflow.states[card.workflow_state] : undefined;
  return card.status === 'running' && state?.type === 'agent';
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

/** Questions UX: "Type a different answer" puts the cursor in this panel's composer. */
function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>('aside.detail .composer textarea')?.focus();
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
        <span className="action-needed">Action needed</span>
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
      {/* Questions UX: the agent's choices, clickable; typing an answer still works. */}
      {request.options && (
        <QuestionOptions
          options={request.options}
          disabled={busy}
          onAnswer={(text) =>
            api
              .answer(sessionId, { input_request_id: request.id, answer: text })
              .then(() => onDone())
          }
          onTypeInstead={focusComposer}
        />
      )}
      <p className="pending-hint muted">
        {request.options
          ? 'Choose an option, or reply in the box below.'
          : 'Reply in the box below to answer.'}
      </p>
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
