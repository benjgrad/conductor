import type { WorkflowDefinition, WorkflowDetail } from '@conductor/shared';

// While a requirements review runs (ADR-0009), a session's `workflow_state` is the synthetic
// label `"<from> → <to> (review)"` (shared engine/review.ts reviewStateLabel), which names no
// state. The UI shows it as "Reviewing: from → to" and highlights the gated edge.

const REVIEW_RE = /^(.+) → (.+) \(review\)$/;

export function parseReviewState(
  state: string | null | undefined,
): { from: string; to: string } | null {
  if (!state) return null;
  const m = REVIEW_RE.exec(state);
  return m ? { from: m[1]!, to: m[2]! } : null;
}

/** `workflow_state` for people: "Reviewing: implement → build" during a review, else as is. */
export function stateLabel(state: string): string {
  const r = parseReviewState(state);
  return r ? `Reviewing: ${r.from} → ${r.to}` : state;
}

// An entry or move step (ADR-0010/0011) is `"<from> → <to> (entry)"` / `"… (move: <name>)"`.
const STEP_RE = /^(.+) → (.+) \((?:entry|move: .+)\)$/;

/**
 * UX-6: a `workflow_state` for the session panel, never the synthetic gate-step label: a review
 * as `stateLabel`, an entry or move step as "Checks before <target title>" (UX-5's wording), a
 * state as its title, else as is.
 */
export function displayState(state: string, workflow?: Pick<WorkflowDefinition, 'states'>): string {
  const title = (s: string) => workflow?.states[s]?.title;
  if (parseReviewState(state)) return stateLabel(state);
  const m = STEP_RE.exec(state);
  if (m) {
    const to = m[2]!;
    const words = to.replace(/_/g, ' ');
    return `Checks before ${title(to) ?? words.charAt(0).toUpperCase() + words.slice(1)}`;
  }
  return title(state) ?? state;
}

/**
 * `WorkflowDetail.versions` (every saved version, ascending), when the server sends it. Read
 * defensively: older servers (and older shared contracts) don't have the field.
 */
export function detailVersions(detail: WorkflowDetail): number[] | null {
  const v = (detail as unknown as Record<string, unknown>).versions;
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((n): n is number => Number.isInteger(n) && (n as number) > 0)) return null;
  return [...v].sort((a, b) => a - b);
}
