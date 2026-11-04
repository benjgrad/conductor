// 11-web-ui §Detail panel, ticket buttons: at every width the session panel's tab row holds
// Brief, Plan and Edit next to the Messages and Details tabs (TicketButtons). Each opens a sheet
// (TicketSheet) over the tab bodies, chat and composer included, so the chat keeps the panel and
// the brief and plan are always one click away. DetailPanel places both and owns the open sheet.
import type { SessionDetail } from '@conductor/shared';
import { Pencil, X } from 'lucide-react';
import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ApiClient } from '../api/client.js';
import { tally, type Brief } from '../brief/parse.js';
import { BriefContent, type BriefContentProps } from './BriefCard.js';
import { latestPlan } from './plan.js';
import { PLAN_APPROVAL_LABEL, PlanAnswerActions, PlanView } from './PlanApprovalRequest.js';
import type { PlanOptions } from './request-preview.js';
import { EditTicket } from './TicketPanel.js';
import './TicketStrip.css';

export type StripSheet = 'brief' | 'plan' | 'edit';

const SHEET_TITLES: Record<StripSheet, string> = {
  brief: 'Brief',
  plan: 'Plan',
  edit: 'Edit ticket',
};

/** The short tally on the Brief button: "3/5 ✓", or "⚠ 2" (requirements without verification). */
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

export interface TicketButtonsProps {
  detail: SessionDetail;
  /** While a plan approval is open, its answer and approve options (`planOptions`); else null. */
  planActions: PlanOptions | null;
  brief: Brief | null;
  /** The open sheet; DetailPanel owns it, so the chat's "Open plan" can open the Plan sheet. */
  sheet: StripSheet | null;
  onSheet: (sheet: StripSheet | null) => void;
  /** The id of TicketSheet's dialog (aria-controls). */
  sheetId: string;
}

/**
 * Brief, Plan (when the session has one) and Edit (when the ticket is editable), in the tab row.
 * Memoised: new output re-renders the panel, not these (NFR-4).
 */
export const TicketButtons = memo(function TicketButtons({
  detail,
  planActions,
  brief,
  sheet,
  onSheet,
  sheetId,
}: TicketButtonsProps) {
  const hasPlan = latestPlan(detail) !== undefined;
  const refs = useRef<Partial<Record<StripSheet, HTMLButtonElement | null>>>({});

  // Focus goes back to the button of the sheet that closed, unless the person moved it elsewhere
  // (a tab click closes the sheet too and keeps its focus).
  const wasOpen = useRef<StripSheet | null>(null);
  useEffect(() => {
    if (sheet === null && wasOpen.current !== null) {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        refs.current[wasOpen.current]?.focus();
      }
    }
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
      aria-controls={sheet === kind ? sheetId : undefined}
      {...(label ? { 'aria-label': label, title: label } : {})}
      onClick={() => onSheet(sheet === kind ? null : kind)}
    >
      {content}
    </button>
  );

  return (
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
          `ticket-strip-plan${planActions ? ' to-approve' : ''}`,
          planActions ? (
            // A phone shows just "Plan" (highlighted) so the row fits; the name stays the same.
            <>
              <span className="ticket-strip-label ticket-strip-long">{PLAN_APPROVAL_LABEL}</span>
              <span className="ticket-strip-label ticket-strip-short" aria-hidden="true">
                Plan
              </span>
            </>
          ) : (
            <span className="ticket-strip-label">Plan</span>
          ),
          planActions ? PLAN_APPROVAL_LABEL : undefined,
        )}
      {detail.ticket_editable &&
        button('edit', 'ticket-strip-edit', <Pencil size={16} aria-hidden="true" />, 'Edit ticket')}
    </div>
  );
});

export interface TicketSheetProps extends BriefContentProps {
  api: ApiClient;
  detail: SessionDetail;
  planActions: PlanOptions | null;
  /** The session's state runs an agent (EditTicket's note). */
  agentRunning: boolean;
  /** The open sheet. */
  sheet: StripSheet;
  onSheet: (sheet: StripSheet | null) => void;
  onReload: () => void;
  /** The dialog's id (TicketButtons' aria-controls). */
  id: string;
}

/** The open sheet: a dialog over the tab bodies, with a heading and Close; Escape closes it. */
export function TicketSheet({ id, ...props }: TicketSheetProps) {
  const { sheet, onSheet, detail } = props;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The editor focuses its own first field.
    if (sheet !== 'edit') close.current?.focus();
  }, [sheet]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onSheet(null);
    }
  }

  return (
    <div
      id={id}
      className={`ticket-sheet ticket-sheet-${sheet}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
    >
      <div className="ticket-sheet-head">
        <h3 id={`${id}-title`}>{SHEET_TITLES[sheet]}</h3>
        <button
          ref={close}
          type="button"
          className="ticket-sheet-close"
          aria-label={`Close ${SHEET_TITLES[sheet].toLowerCase()}`}
          onClick={() => onSheet(null)}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <SheetBody {...props} plan={latestPlan(detail)} />
    </div>
  );
}

function SheetBody({
  api,
  detail,
  planActions,
  agentRunning,
  sheet,
  onSheet,
  onReload,
  plan,
  ...brief
}: Omit<TicketSheetProps, 'id'> & { plan: unknown }) {
  const { body, unavailable, onWantPrompt } = brief;
  // An older server sends no ticket_body: the brief then comes from the prompt.
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
        {plan === undefined ? (
          <p className="muted">No plan recorded for this session.</p>
        ) : (
          <PlanView plan={plan} clamp={false} />
        )}
      </div>
      {planActions && sessionId !== null && (
        <div className="ticket-sheet-foot">
          <PlanAnswerActions
            api={api}
            sessionId={sessionId}
            plan={planActions}
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
