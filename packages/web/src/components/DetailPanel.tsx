// The session panel: a compact header (agent, title, status), then one row with two tabs and the
// ticket buttons (Brief, Plan, Edit), whose sheets open over the tab bodies (TicketStrip.tsx,
// 11-web-ui §Phone layout). Messages is a chat with the agent (the live log, the open question
// inline, a composer pinned at the bottom); Details tells the ticket's story in STAR order (UX-7, StarDetails.tsx), with who runs it and
// where, the workflow, spend and the context under Technical details.
import {
  isAgentRequest,
  setupFailureSummary,
  type BoardCard,
  type InputRequestDto,
  type OutputChunk,
  type SessionDetail,
} from '@conductor/shared';
import { ArrowLeft } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
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
  lastOutputOfQuestion,
} from './ConductorChecks.js';
import { isOldVersion, SessionInsightSection } from './details-sections.js';
import { headStatus, KIND_LABELS, TERMINAL_STATUSES } from './format.js';
import { FocusToggle } from './FocusToggle.js';
import { FreshConversation, freshConversationOffer } from './FreshConversation.js';
import { TicketCheckProposal } from './TicketCheckProposal.js';
import { Markdown } from './markdown.js';
import { CheckRuns, latestRunText, OutputLog, runCount } from './OutputLog.js';
import { PermissionRequests } from './PermissionRequests.js';
import { QuestionOptions } from './QuestionOptions.js';
import { PlanApprovalRequest } from './PlanApprovalRequest.js';
import { ProposedTickets, visibleProposals } from './ProposedTickets.js';
import {
  agentStatesOf,
  classifyRequest,
  lastMoveTransition,
  planOptions,
  requestTone,
  reviewApproveOption,
  type PlanOptions,
} from './request-preview.js';
import { RequestCard } from './RequestCard.js';
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
  /**
   * UXR-37: `wide` (desktop, beside the board or in focus mode) puts the request in its own
   * region at the end of the conversation (it scrolls with the chat), then the follow-ups and the
   * check output in their own disclosures. `default` (phone) keeps the check runs inline.
   */
  layout?: PanelLayout;
  /** UXR-37: focus mode is on (the board is a ticket list and the panel takes the rest). */
  focus?: boolean;
  /** UXR-37: with it, the header has the focus-mode toggle (desktop only). */
  onToggleFocus?: () => void;
}

export type PanelLayout = 'default' | 'wide';

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
  layout = 'default',
  focus = false,
  onToggleFocus,
}: DetailPanelProps) {
  const wide = layout === 'wide';
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

  // The open request: in the wide layout above the conversation, else at the end of the chat.
  const request = detail && (
    <>
      {detail.pending_input &&
        (classifyRequest(detail.pending_input, lastMoveTransition(detail)) === 'review' ? (
          <ReviewRequest
            key={detail.pending_input.id}
            api={api}
            detail={detail}
            agent={name}
            request={detail.pending_input}
            onDone={reload}
            onRequestChanges={focusComposer}
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
            output={output}
          />
        ))}
      {/* An agent's proposed repo checks wait on a human here, with their diff. */}
      {detail.pending_input && (
        <TicketCheckProposal api={api} ticketId={detail.card.ticket_id} onDone={reload} />
      )}
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
    </>
  );
  const hasRequest =
    !!detail &&
    (!!detail.pending_input ||
      (detail.card.sub_status === 'needs_permission' &&
        !!detail.card.permission &&
        detail.card.session_id !== null));
  const runOpts = detail ? { moves: detail.moves ?? [], workflow: detail.workflow } : null;
  const runs = wide && runOpts ? runCount(output, runOpts) : 0;

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
        {onToggleFocus && <FocusToggle focus={focus} onToggle={onToggleFocus} />}
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
                runs={wide ? 'separate' : 'inline'}
              >
                {/* The request ends the conversation and scrolls with it, so it never pins
                    part of the chat. On desktop it is its own region (UXR-37 FR-2). */}
                {wide && hasRequest ? (
                  <section className="request-slot" aria-label="Request">
                    {request}
                  </section>
                ) : (
                  request
                )}
              </OutputLog>
              {/* 06 §Plan approval: the plan panel carries the buttons (other actions inside). */}
              {detail.card.session_id !== null && !plan && (
                <TransitionButtons
                  api={api}
                  sessionId={detail.card.session_id}
                  options={genericTransitions(detail)}
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
              {wide && runs > 0 && (
                <CheckOutputDisclosure count={runs}>
                  <CheckRuns
                    output={output}
                    moves={detail.moves ?? []}
                    workflow={detail.workflow}
                    checking={detail.card.checking}
                    failedItem={stepFailedItem(detail)}
                    active={commandActive(detail)}
                  />
                </CheckOutputDisclosure>
              )}
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
 * UXR-37 (FR-2): the session's "Check output" rows in their own disclosure under the chat,
 * collapsed by default, styled like Proposed follow-up tickets.
 */
function CheckOutputDisclosure({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const bodyId = useId();
  return (
    <section
      className="proposals panel-disclosure check-output-disclosure"
      aria-labelledby={headingId}
    >
      <h3>
        <button
          type="button"
          className="proposals-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="proposals-chevron" aria-hidden="true">
            ▸
          </span>
          <span id={headingId}>Check output</span>
          <span className="proposals-count">{count}</span>
        </button>
      </h3>
      <div id={bodyId} className="proposals-body panel-disclosure-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

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

/** The buttons under the chat: on a review, without the Approve its card already carries. */
function genericTransitions(detail: SessionDetail): SessionDetail['card']['human_transitions'] {
  const options = detail.card.human_transitions;
  const request = detail.pending_input;
  if (!request || classifyRequest(request, lastMoveTransition(detail)) !== 'review') {
    return options;
  }
  const approve = reviewApproveOption(options, detail.workflow);
  return approve ? options.filter((o) => o.name !== approve.name) : options;
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
  /** The session output: a failure shows its check's output under the question (FR-4). */
  output: readonly OutputChunk[];
}

/** Questions UX: "Type a different answer" puts the cursor in this panel's composer. */
function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>('aside.detail .composer textarea')?.focus();
}

/** A failure's output longer than this is clamped behind "Show all". */
const LONG_OUTPUT_LINES = 12;

/**
 * UXR-39 (FR-4): the output a failure refers to: the failed check's last run in the log, else the
 * output the question quotes, else (an old version, whose question names no check) the last run.
 */
export function failureOutput(
  detail: Pick<SessionDetail, 'moves' | 'workflow'>,
  question: string,
  output: readonly OutputChunk[],
): string | null {
  const item = failedItemOfQuestion(question)?.item ?? null;
  const opts = { moves: detail.moves, workflow: detail.workflow };
  return (
    (item !== null ? latestRunText(output, item, opts) : null) ??
    lastOutputOfQuestion(question, item) ??
    (item === null ? latestRunText(output, null, opts) : null)
  );
}

/**
 * The open input request, inline at the end of the chat. The composer answers it; on old
 * versions, non-agent kinds also get the quick actions (06): retry, skip to…, abort.
 */
function PendingInput({ api, detail, agent, request, onDone, output }: PendingInputProps) {
  const sessionId = request.session_id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);

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

  const fromAgent = isAgentRequest(request.kind);
  const cls = classifyRequest(request);
  const stepFailed = cls === 'step_failed';
  const tone = requestTone(cls, request.kind);
  // UX-5 FR-4: the failed item and its first error line, above the full question.
  const failed = stepFailed ? failedItemOfQuestion(request.question) : null;
  const failureText = tone === 'failure' ? failureOutput(detail, request.question, output) : null;
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
    <RequestCard
      tone={tone}
      label={stepFailed ? 'Step failed' : KIND_LABELS[request.kind]}
      who={
        request.kind === 'handoff'
          ? `${agent} hands off for review`
          : request.kind === 'check_config'
            ? "Conductor's check config failed, not the branch"
            : fromAgent
              ? `${agent} asks`
              : 'Conductor needs a decision'
      }
      ariaLabel="Pending input"
    >
      {request.kind === 'check_config' && (
        <p className="step-failed-item">
          <strong>{setupFailureSummary(request.question)}</strong>
        </p>
      )}
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
      {failureText !== null && <FailureOutput text={failureText} />}
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
        <>
          <div className="quick-actions" role="group" aria-label="Quick actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void send('retry')}
            >
              {/* No goto: input.provided returns to return_to, else the workflow start (U-037). */}
              Retry {detail.return_to ?? detail.workflow.start}
            </button>
            <SkipMenu
              targets={skipTargets}
              disabled={busy}
              onChoose={(s) => void send(`skip to ${s}`, s)}
            />
            <button
              type="button"
              className="danger abort"
              disabled={busy}
              aria-expanded={confirmAbort}
              onClick={() => setConfirmAbort(true)}
            >
              Abort…
            </button>
          </div>
          {confirmAbort && (
            <div className="abort-confirm" role="group" aria-label="Confirm abort">
              <span>Abort this session? The agent stops and the card moves to Failed.</span>
              <button
                type="button"
                className="danger-solid"
                disabled={busy}
                onClick={() => void run(() => api.cancel(sessionId, { reason: 'aborted from UI' }))}
              >
                Abort session
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmAbort(false)}>
                Keep it
              </button>
            </div>
          )}
        </>
      )}
      {offer === 'secondary' && fresh}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </RequestCard>
  );
}

/** FR-4: the failure's output under its question, long output clamped behind "Show all". */
function FailureOutput({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.split('\n').length > LONG_OUTPUT_LINES;
  return (
    <div className="request-output-wrap" role="region" aria-label="Failure output">
      <pre className={`request-output${long && !all ? ' clamped' : ''}`}>
        <code>{text}</code>
      </pre>
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/**
 * FR-4: "Skip to…" as a menu that acts on the choice: one item per state; picking one skips
 * there. Escape or a click outside closes it; ↑/↓ move between the items.
 */
export function SkipMenu({
  targets,
  disabled,
  onChoose,
}: {
  targets: readonly string[];
  disabled?: boolean;
  onChoose: (state: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function onKey(e: KeyboardEvent<HTMLUListElement>) {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  }

  return (
    <span className="skip-menu" ref={root}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled === true || targets.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        Skip to… <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul id={menuId} role="menu" aria-label="Skip to state" onKeyDown={onKey}>
          {targets.map((s) => (
            <li key={s} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  onChoose(s);
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
