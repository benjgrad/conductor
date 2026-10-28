// 06 §Plan approval: an open `plan_needs_approval` request in the session panel. The agent's
// question, the plan it stored (`context[return_to].plan`, 05 §Context), and two answers:
// Approve plan, or Request changes… with feedback. Both post the `$return_to` transition (the
// answer option, `planAnswerOption`). The workflow's other human transitions stay one click away
// under "Other actions"; "Start fresh conversation…" is the secondary escape hatch.
import type { HumanTransitionOption, InputRequestDto, SessionDetail } from '@conductor/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { FreshConversation, freshConversationOffer } from './FreshConversation.js';
import { Markdown } from './markdown.js';
import { PLAN_APPROVED_TEXT, planChangesText } from './request-preview.js';
import { TransitionButtons } from './transitions.js';
import './PlanApprovalRequest.css';

export const PLAN_APPROVAL_LABEL = 'Plan to approve';
export const PLAN_MISSING_TEXT =
  "The plan wasn't recorded for this request — see the agent's messages above.";

/** A plan longer than this is clamped behind "Show full plan". */
const LONG_PLAN_CHARS = 1500;
const LONG_PLAN_LINES = 25;

interface PlanApprovalRequestProps {
  api: ApiClient;
  detail: SessionDetail;
  agent: string;
  request: InputRequestDto;
  /** The `$return_to` answer option (`planAnswerOption`); what both answers post. */
  option: HumanTransitionOption;
  onDone: () => void;
}

/** The plan the asking state stored, if it is there. */
export function planOf(detail: Pick<SessionDetail, 'context' | 'return_to'>): unknown {
  if (detail.return_to === null) return undefined;
  const values = detail.context[detail.return_to] as Record<string, unknown> | undefined;
  return values?.plan;
}

export function PlanApprovalRequest({
  api,
  detail,
  agent,
  request,
  option,
  onDone,
}: PlanApprovalRequestProps) {
  const sessionId = request.session_id;
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  async function post(text: string) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.transition(sessionId, { name: option.name, text });
      setChanging(false);
      setFeedback('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function submitChanges(e: FormEvent) {
    e.preventDefault();
    if (feedback.trim() === '') return;
    void post(planChangesText(feedback));
  }

  const others = detail.card.human_transitions.filter((o) => o.name !== option.name);
  const offer = freshConversationOffer(detail, request);
  return (
    <section aria-label={PLAN_APPROVAL_LABEL} className="pending plan-approval">
      <div className="pending-head">
        <span className="badge badge-plan-approval">{PLAN_APPROVAL_LABEL}</span>
        <span className="muted">{agent} asks</span>
      </div>
      <div className="question-text">
        <Markdown text={request.question} />
      </div>
      <PlanView plan={planOf(detail)} />
      {!changing && (
        <div className="plan-approval-actions" role="group" aria-label="Answer the plan">
          <button
            type="button"
            className="primary plan-approve"
            disabled={busy}
            onClick={() => void post(PLAN_APPROVED_TEXT)}
          >
            Approve plan
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setChanging(true);
            }}
          >
            Request changes…
          </button>
        </div>
      )}
      {changing && (
        <form className="transition-text" aria-label="Request changes" onSubmit={submitChanges}>
          <label htmlFor={`${ids}-changes`}>What should change in the plan?</label>
          <textarea
            id={`${ids}-changes`}
            rows={3}
            required
            value={feedback}
            autoFocus
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setChanging(false);
            }}
          />
          <span className="transition-text-actions">
            <button type="submit" disabled={busy || feedback.trim() === ''}>
              Request changes
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setChanging(false)}
            >
              Back
            </button>
          </span>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {others.length > 0 && (
        <details className="plan-other-actions">
          <summary>Other actions</summary>
          <TransitionButtons
            api={api}
            sessionId={sessionId}
            options={others}
            workflow={detail.workflow}
            onDone={onDone}
          />
        </details>
      )}
      {offer !== 'none' && (
        <FreshConversation
          api={api}
          sessionId={sessionId}
          prominent={offer === 'prominent'}
          onDone={onDone}
        />
      )}
    </section>
  );
}

function PlanView({ plan }: { plan: unknown }) {
  const [all, setAll] = useState(false);
  if (plan === undefined || plan === null || plan === '') {
    return <p className="plan-missing muted">{PLAN_MISSING_TEXT}</p>;
  }
  const text = typeof plan === 'string' ? plan : null;
  const long =
    text !== null && (text.length > LONG_PLAN_CHARS || text.split('\n').length > LONG_PLAN_LINES);
  return (
    <div className="plan-body" aria-label="The plan" role="region">
      <div className={`plan-text${long && !all ? ' clamped' : ''}`}>
        {text !== null ? (
          <Markdown text={text} />
        ) : (
          <pre className="plan-json">{JSON.stringify(plan, null, 2)}</pre>
        )}
      </div>
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show full plan'}
        </button>
      )}
    </div>
  );
}
