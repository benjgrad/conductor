import { latestPlanEntry } from '../api/plan.js';
import { plannedFilesOf } from '../api/planned-files.js';
import type { Concurrency } from '../workflow/schema.js';
import { globToRegExp } from '../workflow/screenshots.js';
import type { GateHold, GateStep } from './types.js';

// ADR-0037 P4 (T7): `requires.concurrency`, the pure parts. A move step whose transition has it
// starts `held`: the EngineService wrapper finds the sessions in flight on the same key
// (`holdersOf`, over candidates it reads in its transaction) and feeds them as
// `concurrency.checked`; apply decides with `heldVerdict`. "No evidence, no hold": with
// `overlap: planned_files`, a session without planned `files` never holds and is never held.

/** A glob character: the segment is not literal from here on. */
const WILDCARD = /[*?{[]/;

/** The literal leading segments of a glob (up to the first segment with a wildcard). */
function literalSegments(glob: string): string[] {
  const out: string[] = [];
  for (const seg of glob.split('/')) {
    if (WILDCARD.test(seg)) break;
    out.push(seg);
  }
  return out;
}

/**
 * Could two planned path globs name a common file? Equal, or one matches the other read as a
 * path (`packages/web/**` vs `packages/web/src/App.tsx`). Two wildcard globs are compared by
 * their literal leading segments: one is a prefix of the other. TD-220: that over-approximates
 * (it may hold when no file is shared), only when both sides claimed a broad area.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (globToRegExp(a).test(b) || globToRegExp(b).test(a)) return true;
  if (!WILDCARD.test(a) || !WILDCARD.test(b)) return false;
  const pa = literalSegments(a);
  const pb = literalSegments(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

/** Do two planned file lists intersect? Either side null or empty: no claim, false. */
export function filesOverlap(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

/**
 * A session's planned `files`: from the state that wrote its plan (`latestPlanEntry`); null
 * when there is no plan or it gave no (valid) `files`.
 */
export function sessionPlannedFiles(
  context: Record<string, Record<string, unknown>>,
  returnTo: string | null,
): string[] | null {
  const entry = latestPlanEntry({ context: context as never, return_to: returnTo });
  if (entry === null) return null;
  return plannedFilesOf(context[entry.from_state]);
}

/** Another live session on the same repo, as the wrapper read it. */
export interface HolderCandidate {
  session_id: string;
  ticket_id: string;
  /** The ticket's kind (`$repo+$kind`), null when it has none. */
  kind: string | null;
  workflow_state: string | null;
  /** Its gate step, or null. */
  step: GateStep | null;
  files: string[] | null;
}

/** The held session itself. */
export interface HoldSelf {
  session_id: string;
  kind: string | null;
  files: string[] | null;
  /** `step.started_at` (its place in the queue). */
  started_at: string | null;
}

/** Is `c` (held too) ahead of `self` in the queue? Oldest `started_at` first, then session id. */
function aheadOf(c: GateStep, cId: string, self: HoldSelf): boolean {
  const a = c.started_at === null ? -Infinity : Date.parse(c.started_at);
  const b = self.started_at === null ? -Infinity : Date.parse(self.started_at);
  if (a !== b) return a < b;
  return cId < self.session_id;
}

/** When `c` started being in flight, for ordering the list (oldest first). */
function sinceOf(c: HolderCandidate): number {
  const at = c.step?.started_at;
  return at == null ? -Infinity : Date.parse(at);
}

/**
 * The sessions a held move waits behind, oldest first. In flight on the same key means:
 * (a) in a `scope` state (not in a gate step); (b) in a move step past `held` on its way into a
 * scope state (released, being checked); (c) held too, on its way into a scope state, and ahead
 * in the queue (so release is oldest first, and two held tickets never wait on each other).
 * With `overlap: planned_files`, only when both planned file lists intersect.
 */
export function holdersOf(
  self: HoldSelf,
  conc: Concurrency,
  candidates: readonly HolderCandidate[],
): HolderCandidate[] {
  const scope = new Set(conc.scope);
  const out = candidates.filter((c) => {
    if (c.session_id === self.session_id) return false;
    if (conc.key === '$repo+$kind' && (c.kind ?? null) !== (self.kind ?? null)) return false;
    const inFlight =
      c.step === null
        ? c.workflow_state !== null && scope.has(c.workflow_state)
        : scope.has(c.step.to) &&
          (c.step.phase !== 'held' || aheadOf(c.step, c.session_id, self));
    if (!inFlight) return false;
    return conc.overlap !== 'planned_files' || filesOverlap(self.files, c.files);
  });
  return out.sort((x, y) => sinceOf(x) - sinceOf(y) || x.session_id.localeCompare(y.session_id));
}

export type HeldVerdict = 'release' | 'hold' | 'timeout';

/** Release below `max_in_flight`; at or above it, hold until the hold's deadline, then time out. */
export function heldVerdict(
  conc: Pick<Concurrency, 'max_in_flight'>,
  holders: readonly unknown[],
  now: Date,
  hold: Pick<GateHold, 'deadline'>,
): HeldVerdict {
  if (holders.length < conc.max_in_flight) return 'release';
  return now.getTime() >= Date.parse(hold.deadline) ? 'timeout' : 'hold';
}

/** A ticket's short id on the card ("Queued behind #abcd1234"). */
export function shortTicketId(id: string): string {
  return id.slice(0, 8);
}
