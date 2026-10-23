import type { WorkflowDetail } from '@conductor/shared';

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
