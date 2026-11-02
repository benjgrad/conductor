// 11-web-ui §Phone layout (Detail panel): on a phone the Messages tab has no Brief card and no
// "Edit ticket" row above the chat. One 44 px strip holds Brief, Plan and Edit instead, and each
// opens a sheet over the tab (the chat and the composer), so the chat keeps the screen and the
// plan is always one tap away. Desktop keeps BriefCard and EditTicket (DetailPanel.tsx).
import type { HumanTransitionOption, SessionDetail } from '@conductor/shared';
import { Pencil, X } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ApiClient } from '../api/client.js';
import { tally, type Brief } from '../brief/parse.js';
import { BriefContent, type BriefContentProps } from './BriefCard.js';
import { latestPlan } from './plan.js';
import { PLAN_APPROVAL_LABEL, PlanAnswerActions, PlanView } from './PlanApprovalRequest.js';
import { EditTicket } from './TicketPanel.js';
import './TicketStrip.css';

export type StripSheet = 'brief' | 'plan' | 'edit';

const SHEET_TITLES: Record<StripSheet, string> = {
  brief: 'Brief',
  plan: 'Plan',
  edit: 'Edit ticket',
};

export interface TicketStripProps extends BriefContentProps {
  api: ApiClient;
  detail: SessionDetail;
  /** The `$return_to` answer while a plan approval is open (`planApprovalOption`), else null. */
  planOption: HumanTransitionOption | null;
  /** The session's state runs an agent (EditTicket's note). */
  agentRunning: boolean;
  /** The open sheet; DetailPanel owns it, so the chat's "Open plan" can open the Plan sheet. */
  sheet: StripSheet | null;
  onSheet: (sheet: StripSheet | null) => void;
  onReload: () => void;
}

/** The strip's short tally: "3/5 ✓", or "⚠ 2" (requirements without verification). */
function ShortTally({ brief }: { brief: Brief }) {
  const t = tally(brief);
  if (t.total === 0) return null;
  return t.missing.length === 0 ? (
    <span className="ticket-strip-tally" aria-label={`${t.verified} of ${t.total} verified`}>
      {t.verified}/{t.total} ✓
    </span>
  ) : (
    <span
      className="ticket-strip-tally brief-tally-warn"
      aria-label={`${t.missing.length} without verification`}
      title={t.missing.join(', ')}
    >
      ⚠ {t.missing.length}
    </span>
  );
}

export function TicketStrip(props: TicketStripProps) {
  const { detail, planOption, sheet, onSheet, brief } = props;
  const plan = latestPlan(detail);
  const hasPlan = plan !== undefined;
  const refs = useRef<Partial<Record<StripSheet, HTMLButtonElement | null>>>({});
  const ids = useId();

  // Focus goes back to the strip button of the sheet that closed.
  const wasOpen = useRef<StripSheet | null>(null);
  useEffect(() => {
    if (sheet === null && wasOpen.current !== null) refs.current[wasOpen.current]?.focus();
    wasOpen.current = sheet;
  }, [sheet]);

  const button = (kind: StripSheet, className: string, content: ReactNode, label?: string) => (
    <button
      ref={(el) => {
        refs.current[kind] = el;
      }}
      type="button"
      className={`ticket-strip-button ${className}`}
      aria-haspopup="dialog"
      aria-expanded={sheet === kind}
      aria-controls={sheet === kind ? `${ids}-sheet` : undefined}
      {...(label ? { 'aria-label': label } : {})}
      onClick={() => onSheet(sheet === kind ? null : kind)}
    >
      {content}
    </button>
  );

  return (
    <>
      <div className="ticket-strip" role="group" aria-label="Ticket">
        {button(
          'brief',
          'ticket-strip-brief',
          <>
            <span className="ticket-strip-label">Brief</span>
            {brief && <ShortTally brief={brief} />}
          </>,
        )}
        {hasPlan &&
          button(
            'plan',
            `ticket-strip-plan${planOption ? ' to-approve' : ''}`,
            <span className="ticket-strip-label">{planOption ? PLAN_APPROVAL_LABEL : 'Plan'}</span>,
          )}
        {detail.ticket_editable &&
          button(
            'edit',
            'ticket-strip-edit',
            <Pencil size={18} aria-hidden="true" />,
            'Edit ticket',
          )}
      </div>
      {sheet !== null && (
        <Sheet id={`${ids}-sheet`} kind={sheet} onClose={() => onSheet(null)}>
          <SheetBody {...props} sheet={sheet} plan={plan} />
        </Sheet>
      )}
    </>
  );
}

function Sheet({
  id,
  kind,
  onClose,
  children,
}: {
  id: string;
  kind: StripSheet;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The editor focuses its own first field.
    if (kind !== 'edit') close.current?.focus();
  }, [kind]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <div
      id={id}
      className={`ticket-sheet ticket-sheet-${kind}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
    >
      <div className="ticket-sheet-head">
        <h3 id={`${id}-title`}>{SHEET_TITLES[kind]}</h3>
        <button
          ref={close}
          type="button"
          className="ticket-sheet-close"
          aria-label={`Close ${SHEET_TITLES[kind].toLowerCase()}`}
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  );
}

function SheetBody({
  api,
  detail,
  planOption,
  agentRunning,
  sheet,
  onSheet,
  onReload,
  plan,
  ...brief
}: TicketStripProps & { sheet: StripSheet; plan: unknown }) {
  const { body, unavailable, onWantPrompt } = brief;
  // An older server sends no ticket_body: the brief then comes from the prompt (as BriefCard).
  const waiting = sheet === 'brief' && body === null && unavailable === null;
  useEffect(() => {
    if (waiting) onWantPrompt();
  }, [waiting, onWantPrompt]);

  if (sheet === 'brief') {
    return (
      <div className="ticket-sheet-body brief-sheet">
        <BriefContent {...brief} />
      </div>
    );
  }
  if (sheet === 'edit') {
    return (
      <div className="ticket-sheet-body">
        <EditTicket
          api={api}
          ticketId={detail.card.ticket_id}
          agentRunning={agentRunning}
          onSaved={onReload}
          startOpen
          onClose={() => onSheet(null)}
        />
      </div>
    );
  }
  const sessionId = detail.card.session_id;
  return (
    <>
      <div className="ticket-sheet-body plan-sheet">
        <PlanView plan={plan} clamp={false} />
      </div>
      {planOption && sessionId !== null && (
        <div className="ticket-sheet-foot">
          <PlanAnswerActions
            api={api}
            sessionId={sessionId}
            option={planOption}
            onDone={() => {
              onSheet(null);
              onReload();
            }}
          />
        </div>
      )}
    </>
  );
}
