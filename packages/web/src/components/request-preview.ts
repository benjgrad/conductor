import type { InputRequestDto, SessionDetail } from '@conductor/shared';

// UX-4: what an open input request is (a review request, a failed step, or a real question) and
// the short preview the board card shows. Pure, so the card and the panel agree.

export type RequestClass = 'review' | 'step_failed' | 'question';

/** Max characters of a card preview: the CSS clamps it to 3 lines; this bounds the DOM. */
export const PREVIEW_MAX = 280;

const isReviewTransition = (name: string | null | undefined) =>
  typeof name === 'string' && name.endsWith('ready_for_review');

/** Older servers send no `step_failed`: the engine's failed-step questions start like this. */
const STEP_FAILED_TEXT =
  /^(Conductor could not|Requirements to .* were not met|The requirements review)/;

/**
 * `fallbackTransition`: the session's last move into its current state (`lastMoveTransition`),
 * used when the server sends no `origin_transition`.
 */
export function classifyRequest(
  req: Pick<InputRequestDto, 'kind' | 'question' | 'origin_transition' | 'step_failed'>,
  fallbackTransition?: string | null,
): RequestClass {
  const origin = req.origin_transition !== undefined ? req.origin_transition : fallbackTransition;
  if (isReviewTransition(origin)) return 'review';
  if (req.step_failed !== undefined) return req.step_failed ? 'step_failed' : 'question';
  if (
    (req.kind === 'retries_exhausted' || req.kind === 'timeout') &&
    STEP_FAILED_TEXT.test(req.question)
  ) {
    return 'step_failed';
  }
  return 'question';
}

/** The transition of the session's last move into its current state, if any. */
export function lastMoveTransition(detail: Pick<SessionDetail, 'moves' | 'card'>): string | null {
  const moves = detail.moves ?? [];
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]!;
    if (m.to === detail.card.workflow_state) return m.transition;
  }
  return null;
}

const HEADER_LINE = /^\s*[*_]*(TASK|BRANCH|STATUS)[*_]*\s*:/i;
const FENCE = /^\s*(```|~~~)/;

/** A line without its markdown markers (heading, quote, bullet, checkbox, bold, code ticks). */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/^\[( |x|X|-)\]\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The meaningful lines: after a leading TASK/BRANCH/STATUS header block, fences and blanks out. */
function meaningfulLines(text: string, limit: number): string[] {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === '' || HEADER_LINE.test(lines[i]!))) i++;
  const out: string[] = [];
  for (; i < lines.length && out.length < limit; i++) {
    if (FENCE.test(lines[i]!)) continue;
    const p = plain(lines[i]!);
    if (p !== '') out.push(p);
  }
  return out;
}

function cap(s: string): string {
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : s;
}

/** The card's short preview of a request's text (FR-1, FR-3). */
export function previewText(text: string, cls: RequestClass): string {
  if (cls === 'review') return cap(meaningfulLines(text, 3).join(' · '));
  const first = meaningfulLines(text, 1)[0] ?? '';
  if (cls === 'step_failed') return cap(first);
  const sentence = /^.+?[.?!](?=\s|$)/.exec(first);
  return cap(sentence ? sentence[0] : first);
}

export interface ReportSummary {
  status?: string;
  accepted?: number;
  total?: number;
  gates?: 'ok' | 'failed';
}

const CHECKBOX = /^\s*[-*]\s*\[( |x|X|-)\]/;
const SECTION = /^\s*[*_]*[A-Z][A-Z ]+[*_]*\s*:/;

/** STATUS, ACCEPTANCE `[x]`/`[ ]` counts and GATES of an implementer report; null if none. */
export function summarizeReport(text: string): ReportSummary | null {
  const lines = text.split('\n');
  const out: ReportSummary = {};
  const status = lines.find((l) => /^\s*[*_]*STATUS[*_]*\s*:/i.test(l));
  if (status) {
    const v = plain(status.slice(status.indexOf(':') + 1));
    if (v !== '') out.status = v;
  }
  const start = lines.findIndex((l) => /^\s*[*_]*ACCEPTANCE[*_]*\s*:/i.test(l));
  let boxes: string[];
  if (start >= 0) {
    boxes = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (CHECKBOX.test(l)) boxes.push(l);
      else if (SECTION.test(l)) break;
    }
  } else {
    boxes = lines.filter((l) => CHECKBOX.test(l));
  }
  if (boxes.length > 0) {
    out.total = boxes.length;
    out.accepted = boxes.filter((l) => /\[(x|X)\]/.test(l)).length;
  }
  const gates = lines.find((l) => /^\s*[*_]*GATES[*_]*\s*:/i.test(l));
  if (gates?.includes('❌')) out.gates = 'failed';
  else if (gates?.includes('✅')) out.gates = 'ok';
  return Object.keys(out).length > 0 ? out : null;
}

/** e.g. "complete · Acceptance 8/10, gates ✓". */
export function formatSummary(s: ReportSummary): string {
  const parts: string[] = [];
  if (s.status) parts.push(s.status);
  const counts: string[] = [];
  if (s.total !== undefined) {
    counts.push(`Acceptance ${s.accepted}/${s.total}${s.accepted === s.total ? ' ✓' : ''}`);
  }
  if (s.gates) counts.push(`gates ${s.gates === 'ok' ? '✓' : '✗'}`);
  if (counts.length > 0) parts.push(counts.join(', '));
  return parts.join(' · ');
}
