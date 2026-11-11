import type { WorkflowDefinition } from './schema.js';
import { transitionObject } from './transition-rules.js';
import type { WorkflowValidationError } from './validate.js';

// ADR-0040 §Validation on save: rule 28, the shape of a transition's `requires.parallel` lanes.
// Rule 14's "not available yet" refusal of the feature is in `validate-primitives.ts`.

type Path = (string | number)[];

/**
 * Rule 28 (ADR-0040), per transition with `requires.parallel`:
 * - a `checks` leg needs `requires.checks`, a `review` leg needs `requires.review`; each appears
 *   at most once across the lanes;
 * - a declared `requires.checks` / `requires.review` is run by a leg (no silent sequential phase);
 * - `cmd` leg names are unique and differ from the check names; a `cmd` isn't blank.
 * (At least two lanes of at least one leg each is the schema's: something always runs in parallel.)
 */
export function checkParallel(def: WorkflowDefinition): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const r28 = (path: Path, message: string) => errors.push({ rule: 28, path, message });
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [name, raw] of Object.entries(state.on ?? {})) {
      const req = transitionObject(raw).requires;
      const lanes = req?.parallel;
      if (req === undefined || lanes === undefined) continue;
      const at: Path = ['states', from, 'on', name, 'requires', 'parallel'];
      const checkNames = new Set((req.checks ?? []).map((c) => c.name));
      const cmdNames = new Set<string>();
      let checksLeg = false;
      let reviewLeg = false;
      lanes.forEach((lane, l) =>
        lane.forEach((leg, i) => {
          const path = [...at, l, i];
          switch (leg.type) {
            case 'checks':
              if (checkNames.size === 0) r28(path, 'a checks leg needs requires.checks');
              if (checksLeg) r28(path, 'the checks leg is listed twice');
              checksLeg = true;
              break;
            case 'review':
              if (req.review === undefined) r28(path, 'a review leg needs requires.review');
              if (reviewLeg) r28(path, 'the review leg is listed twice');
              reviewLeg = true;
              break;
            case 'cmd':
              if (leg.cmd.trim() === '')
                r28([...path, 'cmd'], `leg "${leg.name}" has an empty command`);
              if (cmdNames.has(leg.name))
                r28([...path, 'name'], `leg "${leg.name}" is listed twice`);
              else if (checkNames.has(leg.name)) {
                r28([...path, 'name'], `leg "${leg.name}" has the name of a check`);
              }
              cmdNames.add(leg.name);
              break;
          }
        }),
      );
      if (checkNames.size > 0 && !checksLeg) {
        r28(at, 'requires.checks is declared but no leg runs it (add a {"type": "checks"} leg)');
      }
      if (req.review !== undefined && !reviewLeg) {
        r28(at, 'requires.review is declared but no leg runs it (add a {"type": "review"} leg)');
      }
    }
  }
  return errors;
}
