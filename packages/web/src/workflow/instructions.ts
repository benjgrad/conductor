import {
  INSTRUCTION_REF_PREFIX,
  InstructionSlugSchema,
  instructionUses,
  transitionTitle,
  type InstructionUse,
  type TransitionObject,
  type WorkflowDefinition,
} from '@conductor/shared';
import { getTransitionObject, setTransition } from './transitions.js';

// ADR-0037 P5 (T8) in the editor: the workflow's saved instructions (`instructions`), the pure
// edits the Instructions list makes, and the picker's ref. A rename rewrites every ref and preset;
// a delete is refused while anything uses the instruction. The server checks rule 21 again.

/** The ref an instruction field holds to use saved instruction `slug`. */
export const refOf = (slug: string) => `${INSTRUCTION_REF_PREFIX}${slug}`;

/** The saved instructions, in definition order. */
export function instructionsOf(def: WorkflowDefinition): [string, string][] {
  return Object.entries(def.instructions ?? {});
}

function withInstructions(
  def: WorkflowDefinition,
  entries: [string, string][],
): WorkflowDefinition {
  const next = { ...def };
  if (entries.length === 0) delete next.instructions;
  else next.instructions = Object.fromEntries(entries);
  return next;
}

/** Add an empty instruction named `instruction` (`_2`, `_3`… when taken); returns its slug. */
export function addInstruction(def: WorkflowDefinition): {
  definition: WorkflowDefinition;
  slug: string;
} {
  const taken = new Set(Object.keys(def.instructions ?? {}));
  let slug = 'instruction';
  for (let n = 2; taken.has(slug); n++) slug = `instruction_${n}`;
  return { definition: withInstructions(def, [...instructionsOf(def), [slug, '']]), slug };
}

export function setInstructionText(
  def: WorkflowDefinition,
  slug: string,
  text: string,
): WorkflowDefinition {
  return withInstructions(
    def,
    instructionsOf(def).map(([k, v]) => [k, k === slug ? text : v]),
  );
}

/** Why `next` can't be the new slug of instruction `current` (null = it can). */
export function instructionSlugProblem(
  def: WorkflowDefinition,
  current: string,
  next: string,
): string | null {
  if (next === current) return null;
  if (!InstructionSlugSchema.safeParse(next).success) {
    return 'use lower_snake_case: a letter, then letters, digits or _ (at most 40)';
  }
  if (Object.prototype.hasOwnProperty.call(def.instructions ?? {}, next)) {
    return `there is already an instruction "${next}"`;
  }
  return null;
}

/** Set the value at `path` in a (cloned) definition. */
function setAt(root: unknown, path: (string | number)[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
}

/** Rename an instruction, keeping its place, and rewrite every ref and preset that names it. */
export function renameInstruction(
  def: WorkflowDefinition,
  current: string,
  next: string,
): WorkflowDefinition {
  if (current === next) return def;
  const problem = instructionSlugProblem(def, current, next);
  if (problem !== null) throw new Error(problem);
  const out = structuredClone(def);
  for (const use of instructionUses(def)) {
    if (use.slug === current) setAt(out, use.path, use.kind === 'ref' ? refOf(next) : next);
  }
  return withInstructions(
    out,
    instructionsOf(def).map(([k, v]) => [k === current ? next : k, v]),
  );
}

/** What uses instruction `slug`. */
export function usesOf(def: WorkflowDefinition, slug: string): InstructionUse[] {
  return instructionUses(def).filter((u) => u.slug === slug);
}

/** A use in words, for the delete refusal: "Implementing → PR ready (instruction)". */
export function describeUse(def: WorkflowDefinition, use: InstructionUse): string {
  const [, state, kind, name] = use.path as [string, string, string, string | undefined];
  const column = def.states[state]?.title ?? state;
  if (kind === 'on' && name !== undefined) {
    const t = getTransitionObject(def, state, name);
    const title = transitionTitle(name, t ?? undefined);
    return `${column} → ${title} (${use.kind === 'ref' ? 'instruction' : 'saved reply'})`;
  }
  return `${column} (${kind === 'watch' ? 'watch' : 'entry'} instruction)`;
}

/** Remove an instruction; refused (with its uses) while anything uses it. */
export function removeInstruction(
  def: WorkflowDefinition,
  slug: string,
): { ok: true; definition: WorkflowDefinition } | { ok: false; uses: InstructionUse[] } {
  const uses = usesOf(def, slug);
  if (uses.length > 0) return { ok: false, uses };
  return {
    ok: true,
    definition: withInstructions(
      def,
      instructionsOf(def).filter(([k]) => k !== slug),
    ),
  };
}

/** Set a human button's `presets` (unset when none). */
export function setPresets(
  def: WorkflowDefinition,
  from: string,
  name: string,
  slugs: readonly string[],
): WorkflowDefinition {
  const t = getTransitionObject(def, from, name);
  if (t === null) throw new Error(`state "${from}" has no transition "${name}"`);
  const next: TransitionObject = { ...t };
  if (slugs.length === 0) delete next.presets;
  else next.presets = [...slugs];
  return setTransition(def, from, name, next);
}

/** The Instructions list's problems, at `instructions.<slug>` (rule 21's refs are per field). */
export function instructionIssues(def: WorkflowDefinition): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const [slug, text] of instructionsOf(def)) {
    if (!InstructionSlugSchema.safeParse(slug).success) {
      issues.push({ path: `instructions.${slug}`, message: `"${slug}" is not lower_snake_case` });
    }
    if (text.trim() === '') {
      issues.push({ path: `instructions.${slug}`, message: `instruction "${slug}" is empty` });
    } else if (text.length > 4_000) {
      issues.push({ path: `instructions.${slug}`, message: 'at most 4000 characters' });
    }
  }
  return issues;
}
