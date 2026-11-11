import type { CapabilityRequirement } from '../machines/capabilities.js';
import { instructionRef, type WorkflowDefinition } from './schema.js';
import { instructionFields, transitionsAt } from './instructions.js';

// ADR-0039 (B1): base refs. The schemas are in schema.ts (BaseSpecSchema, TicketBaseSchema,
// PlanBaseSchema, SessionBaseSchema); this module holds the pure helpers the validator (rules 26,
// 27 and 14) and, from B2, the engine use: where `$base` / `$base_sha` may appear, the
// substitution itself, and the routing capability a `cmd` base adds.

type Path = (string | number)[];

/** `$base` or `$base_sha`, not followed by an identifier character (`$basement` is not one). */
const BASE_TOKEN_RE = /\$base(?:_sha)?(?![A-Za-z0-9_])/;
const BASE_TOKEN_RE_G = /\$base(_sha)?(?![A-Za-z0-9_])/g;

/** True when `text` uses `$base` or `$base_sha`. `${base}` (a shell variable) is not a use. */
export function usesBaseToken(text: string): boolean {
  return BASE_TOKEN_RE.test(text);
}

/** The values `$base` and `$base_sha` expand to (ADR-0039 §Substitution). */
export interface BaseValues {
  /** The resolved base branch, or `pr_into` when the base is a commit. */
  base: string;
  /** The resolved commit. */
  base_sha: string;
}

/** Expand `$base` / `$base_sha` in `text`. Pure; B2 calls it at the substitution sites. */
export function substituteBase(text: string, values: BaseValues): string {
  return text.replace(BASE_TOKEN_RE_G, (_m, sha: string | undefined) =>
    sha === undefined ? values.base : values.base_sha,
  );
}

/**
 * Every field `$base` / `$base_sha` is substituted in (ADR-0039 FR-4), as `[path, text]`: check
 * `cmd`s (a transition's `requires.checks`, a state's `entry.checks`), ADR-0042 `cmd` leg `cmd`s
 * (`requires.parallel`), `cmd` condition `cmd`s
 * (`requires.conditions` and `watch.conditions`), the `instructions` map's texts, and literal
 * instruction fields (`on_unmet.instruction`, `on_broken.instruction`; a `$instructions.<slug>`
 * ref is covered by the map entry it names).
 */
export function baseSubstitutionFields(
  def: Pick<WorkflowDefinition, 'states'> & Partial<Pick<WorkflowDefinition, 'instructions'>>,
): [Path, string][] {
  const fields: [Path, string][] = [];
  for (const [name, state] of Object.entries(def.states)) {
    (state.entry?.checks ?? []).forEach((c, i) =>
      fields.push([['states', name, 'entry', 'checks', i, 'cmd'], c.cmd]),
    );
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      state.watch.conditions.forEach((c, i) => {
        if (c.type === 'cmd')
          fields.push([['states', name, 'watch', 'conditions', i, 'cmd'], c.cmd]);
      });
    }
  }
  for (const { t, base } of transitionsAt(def)) {
    (t.requires?.checks ?? []).forEach((c, i) =>
      fields.push([[...base, 'requires', 'checks', i, 'cmd'], c.cmd]),
    );
    (t.requires?.conditions ?? []).forEach((c, i) => {
      if (c.type === 'cmd') fields.push([[...base, 'requires', 'conditions', i, 'cmd'], c.cmd]);
    });
    (t.requires?.parallel ?? []).forEach((lane, l) =>
      lane.forEach((leg, i) => {
        if (leg.type === 'cmd')
          fields.push([[...base, 'requires', 'parallel', l, i, 'cmd'], leg.cmd]);
      }),
    );
  }
  for (const [slug, text] of Object.entries(def.instructions ?? {})) {
    fields.push([['instructions', slug], text]);
  }
  for (const [path, text] of instructionFields(def)) {
    if (instructionRef(text) === null) fields.push([path, text]);
  }
  return fields;
}

/** The fields of `baseSubstitutionFields` that use `$base` / `$base_sha`. */
export function baseTokenUses(def: Parameters<typeof baseSubstitutionFields>[0]): Path[] {
  return baseSubstitutionFields(def)
    .filter(([, text]) => usesBaseToken(text))
    .map(([path]) => path);
}

/** `az` as a command word: at the start, or after whitespace or a shell operator. */
const AZ_RE = /(^|[\s;&|(`])az\s/;

/**
 * ADR-0039 FR-5: the routing capability a `cmd` base needs on the claiming machine:
 * `cli:az:authed` when the command runs `az`, otherwise none.
 */
export function cmdBaseCapability(cmd: string): CapabilityRequirement | null {
  return AZ_RE.test(cmd) ? 'cli:az:authed' : null;
}
