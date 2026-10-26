import type {
  EntryRequirements,
  OnUnmet,
  TransitionObject,
  TransitionRequires,
  WorkflowDefinition,
} from './schema.js';
import { FALLBACK_TRANSITION_NAMES, transitionObject } from './transition-rules.js';

// ADR-0011: fold ADR-0010 `states.<s>.entry` and ADR-0009 transition `requirements` into
// transition `requires` + `on_unmet`. The editor (T06) calls it when it saves a new version; the
// engine keeps executing old versions as they are (it never folds). Pure; the input is untouched.

/**
 * An equivalent definition with no `entry` and no `requirements`:
 * - each `states.<s>.entry` is moved onto every non-fallback transition whose `goto` is `s`
 *   (FALLBACK_TRANSITION_NAMES never ran requirements under ADR-0011; under ADR-0010 they did, so
 *   a `timeout` / `ask_user` into a state with `entry` loses it, which is the ADR-0011 intent);
 * - each ADR-0009 `requirements` becomes `requires.review` + `on_unmet`.
 *
 * When one transition gets both, the review items are concatenated (the ADR-0009 gate's first,
 * as it ran first), the gate's reviewer model wins, and the transition's own `on_unmet` (the
 * gate's) wins over the entry's. A transition that already has `requires` keeps its fields;
 * folded fields only fill what is missing. Returns the input itself when there is nothing to fold.
 */
export function foldLegacyRequirements(def: WorkflowDefinition): WorkflowDefinition {
  const entries = new Map<string, EntryRequirements>();
  let gates = false;
  for (const [name, s] of Object.entries(def.states)) {
    if (s.entry !== undefined) entries.set(name, s.entry);
    if (s.type !== 'terminal') {
      for (const t of Object.values(s.on ?? {})) {
        if (typeof t === 'object' && t.requirements !== undefined) gates = true;
      }
    }
  }
  if (entries.size === 0 && !gates) return def;

  const out = structuredClone(def);
  for (const s of Object.values(out.states)) {
    delete s.entry;
    if (s.type === 'terminal' || s.on === undefined) continue;
    for (const [name, raw] of Object.entries(s.on)) {
      const t = transitionObject(raw);
      const entry = FALLBACK_TRANSITION_NAMES.includes(name) ? undefined : entries.get(t.goto);
      if (entry === undefined && t.requirements === undefined) continue;
      s.on[name] = foldOne(t, entry);
    }
  }
  return out;
}

function foldOne(t: TransitionObject, entry: EntryRequirements | undefined): TransitionObject {
  const { requirements: gate, ...rest } = t;
  const folded: TransitionRequires = {};
  if (entry?.checks !== undefined) folded.checks = entry.checks;
  if (entry?.setup !== undefined) folded.setup = entry.setup;
  const items = [...(gate?.items ?? []), ...(entry?.review?.items ?? [])];
  if (items.length > 0) {
    const model = gate?.model ?? entry?.review?.model;
    folded.review = model !== undefined ? { items, model } : { items };
  }
  if (entry?.actions !== undefined) folded.actions = [...entry.actions];
  const onUnmet: OnUnmet | undefined = rest.on_unmet ?? gate?.on_unmet ?? entry?.on_unmet;
  const out: TransitionObject = { ...rest, requires: { ...folded, ...rest.requires } };
  if (onUnmet !== undefined) out.on_unmet = onUnmet;
  return out;
}
