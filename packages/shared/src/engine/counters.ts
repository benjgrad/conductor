import { ENTRY_COUNTER_PREFIX, REVIEW_COUNTER_PREFIX } from './review.js';
import { MOVE_COUNTER_PREFIX } from './types.js';
import { WATCH_COUNTER_PREFIX } from './watch.js';

/**
 * The `retry_counters` prefixes a human round resets (05 §Counting, "Rounds"): the `on_unmet`
 * loops of gates (move, transition review, entry) and the `on_broken` loops of watches. Outcome
 * loops (`<from>-><goto>`), QA rounds (ADR-0020), triage, defaults and `start_failed` keep their
 * own rules.
 */
export const HUMAN_ROUND_COUNTER_PREFIXES: readonly string[] = [
  MOVE_COUNTER_PREFIX,
  REVIEW_COUNTER_PREFIX,
  ENTRY_COUNTER_PREFIX,
  WATCH_COUNTER_PREFIX,
];

/** The keys of `counters` a human answer or transition clears. */
export function humanRoundCounterKeys(counters: Record<string, number>): string[] {
  return Object.keys(counters).filter((k) =>
    HUMAN_ROUND_COUNTER_PREFIXES.some((p) => k.startsWith(p)),
  );
}

/**
 * `counters` without the keys a human round clears; the same object when there are none. A loop
 * that passes through a human is bounded by that human, so each round gets the full `retries`.
 */
export function withoutHumanRoundCounters(
  counters: Record<string, number>,
): Record<string, number> {
  const keys = humanRoundCounterKeys(counters);
  if (keys.length === 0) return counters;
  const out = { ...counters };
  for (const k of keys) delete out[k];
  return out;
}
