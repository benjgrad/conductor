import {
  AVAILABLE_WORKFLOW_FEATURES,
  type PlanBase,
  type TicketBase,
  type WorkflowDefinition,
  type WorkflowFeature,
} from './schema.js';
import { baseTokenUses } from './bases.js';
import type { WorkflowValidationError } from './validate.js';

// ADR-0039 §Validation on save: rules 26 and 27 for base refs, the warning for a `cmd` base
// without `pr_into`, rule 14's "not available yet" refusals of the feature, and the checks a
// ticket's or planning result's `base` gets against the definition it runs on.

type Path = (string | number)[];

/** The example `bases` rule 27's message suggests. */
const BASES_EXAMPLE = '{"default": {"ref": "$default_branch"}}';

/** Rule 14: `bases`, `base_default` and every `$base` / `$base_sha` use, while `bases` is off. */
export function checkBasesAvailability(
  def: WorkflowDefinition,
  features: readonly WorkflowFeature[],
): WorkflowValidationError[] {
  if (features.includes('bases')) return [];
  const errors: WorkflowValidationError[] = [];
  const r14 = (path: Path, message: string) => errors.push({ rule: 14, path, message });
  if (def.bases !== undefined) r14(['bases'], 'bases are not available yet');
  if (def.base_default !== undefined) r14(['base_default'], 'base_default is not available yet');
  for (const path of baseTokenUses(def)) r14(path, '$base is not available yet');
  return errors;
}

/**
 * Rules 26–27 (ADR-0039 §Validation on save).
 * - 26 names: `base_default` needs `bases`, and each of its values names a key of `bases`.
 * - 27 placement: `$base` / `$base_sha` (check and condition `cmd`s, instruction texts) needs the
 *   workflow's `bases`. A definition can't know a repo's default branch, so declaring `bases`
 *   (even only `{"default": {"ref": "$default_branch"}}`) is the opt-in.
 */
export function checkBases(def: WorkflowDefinition): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const has = (name: string) =>
    def.bases !== undefined && Object.prototype.hasOwnProperty.call(def.bases, name);
  if (def.base_default !== undefined) {
    if (def.bases === undefined) {
      errors.push({
        rule: 26,
        path: ['base_default'],
        message: 'base_default names bases, but the workflow has no "bases"',
      });
    } else {
      for (const [kind, name] of Object.entries(def.base_default)) {
        if (name !== undefined && !has(name)) {
          errors.push({
            rule: 26,
            path: ['base_default', kind],
            message: `base "${name}" is not in bases`,
          });
        }
      }
    }
  }
  if (def.bases === undefined) {
    for (const path of baseTokenUses(def)) {
      errors.push({
        rule: 27,
        path,
        message: `$base needs the workflow's bases (add bases, e.g. ${BASES_EXAMPLE})`,
      });
    }
  }
  return errors;
}

/**
 * Warnings (never block a save): a `cmd` base without `pr_into`, whose sha result B2 refuses
 * because it doesn't know where the PR goes.
 */
export function basesWarnings(def: WorkflowDefinition): WorkflowValidationError[] {
  const warnings: WorkflowValidationError[] = [];
  for (const [name, spec] of Object.entries(def.bases ?? {})) {
    if ('cmd' in spec && spec.pr_into === undefined) {
      warnings.push({
        rule: 26,
        path: ['bases', name, 'pr_into'],
        message: `base "${name}": a commit sha from this command will be refused at run time without pr_into`,
      });
    }
  }
  return warnings;
}

/** A problem with a ticket's or planning result's `base`, at `path` under it. */
export interface BaseProblem {
  path: Path;
  message: string;
}

function nameProblems(
  def: Pick<WorkflowDefinition, 'bases'> | null,
  name: string,
  path: Path,
): BaseProblem[] {
  if (def === null) return [{ path, message: 'the ticket has no workflow definition yet' }];
  if (def.bases === undefined) {
    return [{ path, message: `base "${name}": the workflow has no bases` }];
  }
  if (!Object.prototype.hasOwnProperty.call(def.bases, name)) {
    return [{ path, message: `base "${name}" is not in the workflow's bases` }];
  }
  return [];
}

/**
 * A ticket's `base` against the definition it will run on (rule 26 and rule 14's wording). Paths
 * are relative to the ticket (`['base']`). Pure; `features` is injectable for tests.
 */
export function ticketBaseProblems(
  def: Pick<WorkflowDefinition, 'bases'> | null,
  base: TicketBase,
  features: readonly WorkflowFeature[] = AVAILABLE_WORKFLOW_FEATURES,
): BaseProblem[] {
  if (!features.includes('bases')) {
    return [{ path: ['base'], message: 'a ticket base is not available yet' }];
  }
  return typeof base === 'string' ? nameProblems(def, base, ['base']) : [];
}

/** A planning result's `base`, as `ticketBaseProblems` (paths under `['base']`). */
export function planBaseProblems(
  def: Pick<WorkflowDefinition, 'bases'> | null,
  base: PlanBase,
  features: readonly WorkflowFeature[] = AVAILABLE_WORKFLOW_FEATURES,
): BaseProblem[] {
  if (!features.includes('bases')) {
    return [{ path: ['base'], message: 'a planning base is not available yet' }];
  }
  return base.name !== undefined ? nameProblems(def, base.name, ['base', 'name']) : [];
}
