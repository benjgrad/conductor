import type { SessionDetail } from '@conductor/shared';

// 06 §Plan approval / 05 §Context: where a session's plan is. A planning state stores it as its
// result (`context[state].plan`); the panel's Plan sheet (TicketStrip.tsx), the plan card and
// the Details timeline (star.ts) all read it from here.

type Context = SessionDetail['context'];

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The plan `from` wrote (`context[from].plan`) if it is text, else any state's text plan. */
export function planText(context: Context, from: string | null): string | null {
  const own = from === null ? undefined : context[from]?.plan;
  if (isText(own)) return own;
  for (const values of Object.values(context)) {
    if (isText(values.plan)) return values.plan;
  }
  return null;
}

/**
 * The session's plan for the Plan sheet: what the asking state (`return_to`) stored, as it is
 * (a JSON plan stays an object), else any state's text plan. undefined when there is none.
 */
export function latestPlan(detail: Pick<SessionDetail, 'context' | 'return_to'>): unknown {
  const own =
    detail.return_to === null
      ? undefined
      : (detail.context[detail.return_to] as Record<string, unknown> | undefined)?.plan;
  if (own !== undefined && own !== null && own !== '') return own;
  return planText(detail.context, null) ?? undefined;
}
