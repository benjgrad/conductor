import type { SessionDetail } from './rest.js';

// 06 §Plan approval / 05 §Context: where a session's plan is. A planning state stores it as its
// result (`context[state].plan`). The web panel's Plan sheet, plan card and Details timeline, and
// MCP's get_ticket_artifacts (ADR-0031) all read it from here.

type Context = SessionDetail['context'];

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The first state (in context order) whose `plan` is non-blank text, with that text. */
function firstTextPlan(context: Context): { plan: string; from_state: string } | null {
  for (const [state, values] of Object.entries(context)) {
    if (isText(values.plan)) return { plan: values.plan, from_state: state };
  }
  return null;
}

/** The plan `from` wrote (`context[from].plan`) if it is text, else any state's text plan. */
export function planText(context: Context, from: string | null): string | null {
  const own = from === null ? undefined : context[from]?.plan;
  if (isText(own)) return own;
  return firstTextPlan(context)?.plan ?? null;
}

/**
 * The session's latest plan and the state that wrote it: what the asking state (`return_to`)
 * stored, as it is (a JSON plan stays an object), else any state's text plan. null when none.
 */
export function latestPlanEntry(
  detail: Pick<SessionDetail, 'context' | 'return_to'>,
): { plan: unknown; from_state: string } | null {
  if (detail.return_to !== null) {
    const own = (detail.context[detail.return_to] as Record<string, unknown> | undefined)?.plan;
    if (own !== undefined && own !== null && own !== '') {
      return { plan: own, from_state: detail.return_to };
    }
  }
  return firstTextPlan(detail.context);
}

/** `latestPlanEntry`'s plan alone; undefined when there is none (the web Plan sheet). */
export function latestPlan(detail: Pick<SessionDetail, 'context' | 'return_to'>): unknown {
  return latestPlanEntry(detail)?.plan;
}
