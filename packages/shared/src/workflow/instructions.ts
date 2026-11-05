import {
  instructionRef,
  type Transition,
  type TransitionObject,
  type WorkflowDefinition,
} from './schema.js';

/** `transitionObject` (transition-rules.ts imports this module, so not from there). */
const transitionObject = (t: Transition): TransitionObject =>
  typeof t === 'string' ? { goto: t } : t;

// ADR-0037 P5 (T8): named instructions. The workflow's `instructions` map holds texts that
// `on_unmet.instruction`, a watch's `on_broken.instruction` (as `$instructions.<slug>` refs) and
// human buttons' `presets` (as slugs) name. One walk over the definition serves rule 21, the
// designer's rename and delete, and the engine resolves a ref at the move against the session's
// pinned definition.

type Path = (string | number)[];
type Def = Pick<WorkflowDefinition, 'states'> & Partial<Pick<WorkflowDefinition, 'instructions'>>;

/**
 * An instruction field's text: a literal as is, a ref as the instruction it names. `undefined`
 * for no text, and for a ref that doesn't resolve (rule 21 refuses that on save), so a
 * `$instructions.…` string never reaches a prompt.
 */
export function resolveInstruction(def: Def, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const ref = instructionRef(text);
  if (ref === null) return text;
  return ref.slug === null ? undefined : def.instructions?.[ref.slug];
}

/** A transition out of a state, with its path in the definition. */
export interface TransitionAt {
  from: string;
  name: string;
  t: TransitionObject;
  base: Path;
}

/** Every transition object of the definition, with its path (`states.<s>.on.<name>`). */
export function transitionsAt(def: Pick<WorkflowDefinition, 'states'>): TransitionAt[] {
  const out: TransitionAt[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [name, raw] of Object.entries(state.on ?? {})) {
      out.push({ from, name, t: transitionObject(raw), base: ['states', from, 'on', name] });
    }
  }
  return out;
}

/** Every instruction field that may hold a `$instructions.<slug>` ref, as `[path, text]`. */
export function instructionFields(def: Pick<WorkflowDefinition, 'states'>): [Path, string][] {
  const fields: [Path, string][] = [];
  const add = (path: Path, text: string | undefined) => {
    if (text !== undefined) fields.push([path, text]);
  };
  for (const [name, state] of Object.entries(def.states)) {
    add(['states', name, 'entry', 'on_unmet', 'instruction'], state.entry?.on_unmet.instruction);
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      const ob = state.watch.on_broken;
      if ('goto' in ob) add(['states', name, 'watch', 'on_broken', 'instruction'], ob.instruction);
    }
  }
  for (const { t, base } of transitionsAt(def)) {
    add([...base, 'on_unmet', 'instruction'], t.on_unmet?.instruction);
    add([...base, 'requirements', 'on_unmet', 'instruction'], t.requirements?.on_unmet.instruction);
  }
  return fields;
}

/** Where a saved instruction is used: a ref in an instruction field, or a button's preset. */
export interface InstructionUse {
  /** The ref's field, or the preset's `presets.<i>` entry. */
  path: Path;
  slug: string;
  kind: 'ref' | 'preset';
}

/** Every use of a saved instruction (well-formed refs and presets), resolved or not. */
export function instructionUses(def: Pick<WorkflowDefinition, 'states'>): InstructionUse[] {
  const uses: InstructionUse[] = [];
  for (const [path, text] of instructionFields(def)) {
    const ref = instructionRef(text);
    if (ref?.slug != null) uses.push({ path, slug: ref.slug, kind: 'ref' });
  }
  for (const { t, base } of transitionsAt(def)) {
    (t.presets ?? []).forEach((slug, i) =>
      uses.push({ path: [...base, 'presets', i], slug, kind: 'preset' }),
    );
  }
  return uses;
}

/** A preset as a human button offers it: the slug, a label and the text it fills the box with. */
export interface ResolvedPreset {
  slug: string;
  label: string;
  text: string;
}

/** `resync_main` → "Resync main": the chip label (the map holds only the text). */
export function presetLabel(slug: string): string {
  const words = slug.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A transition's `presets`, resolved against `def.instructions` (a missing slug is skipped). */
export function resolvePresets(def: Def, t: Pick<TransitionObject, 'presets'>): ResolvedPreset[] {
  const out: ResolvedPreset[] = [];
  for (const slug of t.presets ?? []) {
    const text = def.instructions?.[slug];
    if (text !== undefined) out.push({ slug, label: presetLabel(slug), text });
  }
  return out;
}

/** Transition `name` out of `from`'s presets, resolved; empty when it has none. */
export function transitionPresets(def: Def, from: string, name: string): ResolvedPreset[] {
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return [];
  const raw = state.on?.[name];
  return raw === undefined ? [] : resolvePresets(def, transitionObject(raw));
}
