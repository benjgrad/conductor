import {
  MAX_ANSWERER_TIMEOUT,
  MIN_ANSWERER_TIMEOUT,
  NEVER_AUTO_ANSWERED,
  parseDuration,
  type WorkflowDefinition,
  type WorkflowFeature,
} from './schema.js';
import { transitionGoto, transitionObject } from './transition-rules.js';
import type { WorkflowValidationError } from './validate.js';

// ADR-0040 §Validation on save: rule 28 for the workflow's `answerer` block, and rule 14's
// "not available yet" refusal of the feature.

/** Rule 14: the `answerer` block while the feature is off. */
export function checkAnswererAvailability(
  def: WorkflowDefinition,
  features: readonly WorkflowFeature[],
): WorkflowValidationError[] {
  if (features.includes('answerer') || def.answerer === undefined) return [];
  return [{ rule: 14, path: ['answerer'], message: 'the answerer is not available yet' }];
}

/** How an agent state's transition `name` asks, if it does: a question, a hand-off or neither. */
type Asking = 'question' | 'handoff' | 'none';

function askingOf(def: WorkflowDefinition, name: string): Asking {
  let found: Asking = 'none';
  for (const state of Object.values(def.states)) {
    if (state.type !== 'agent') continue;
    const raw = state.on?.[name];
    if (raw === undefined) continue;
    const t = transitionObject(raw);
    if (t.handoff === true) return 'handoff';
    const target = def.states[transitionGoto(raw)];
    if (t.question === true || (name === 'ask_user' && target?.type === 'human')) {
      found = 'question';
    }
  }
  return found;
}

/**
 * Rule 28 (ADR-0040). Each `applies_to` name is listed once, is not one of
 * `NEVER_AUTO_ANSWERED`, and is a question some agent state asks (`ask_user` into a human state,
 * or a `question: true` transition), never a hand-off. `timeout` is 1m–30m. The answerer adds no
 * edges: its step ends at the asker or at the question's own human target, so rules 2–5 are
 * unchanged.
 */
export function checkAnswerer(def: WorkflowDefinition): WorkflowValidationError[] {
  const a = def.answerer;
  if (a === undefined) return [];
  const errors: WorkflowValidationError[] = [];
  const seen = new Set<string>();
  const never: readonly string[] = NEVER_AUTO_ANSWERED;
  a.applies_to.forEach((name, i) => {
    const path = ['answerer', 'applies_to', i];
    const err = (message: string) => errors.push({ rule: 28, path, message });
    if (seen.has(name)) return err(`"${name}" is listed twice`);
    seen.add(name);
    if (never.includes(name)) {
      return err(`"${name}" needs a human's decision and can't be answered by conductor`);
    }
    const asking = askingOf(def, name);
    if (asking === 'handoff')
      return err(`"${name}" hands work off for review; it isn't a question`);
    if (asking === 'none') return err(`no agent state asks "${name}"`);
  });
  if (a.timeout !== undefined) {
    const ms = parseDuration(a.timeout);
    if (ms < parseDuration(MIN_ANSWERER_TIMEOUT) || ms > parseDuration(MAX_ANSWERER_TIMEOUT)) {
      errors.push({
        rule: 28,
        path: ['answerer', 'timeout'],
        message: `the answerer's timeout must be between ${MIN_ANSWERER_TIMEOUT} and ${MAX_ANSWERER_TIMEOUT}`,
      });
    }
  }
  return errors;
}
