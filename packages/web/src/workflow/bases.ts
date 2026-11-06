import {
  BaseNameSchema,
  BaseSpecSchema,
  DEFAULT_BRANCH_REF,
  TICKET_KINDS,
  basesWarnings,
  checkBases,
  checkBasesAvailability,
  type BaseSpec,
  type TicketKind,
  type WorkflowDefinition,
  type WorkflowFeature,
} from '@conductor/shared';

// ADR-0039 (B3) in the editor: the workflow's `bases` and `base_default`, the pure edits the
// Bases section makes, and its problems (rules 26, 27 and 14 from the shared validator, plus each
// spec's shape). A rename follows into `base_default`; a delete is refused while the default or a
// queued ticket names the base. The server checks again on Save.

export type BaseMode = 'ref' | 'cmd';
export type BaseField = 'ref' | 'cmd' | 'timeout' | 'pr_into';

/** The bases, in definition order. */
export function basesOf(def: WorkflowDefinition): [string, BaseSpec][] {
  return Object.entries(def.bases ?? {});
}

/** `ref` or `cmd`: which kind of base a spec is. */
export function baseModeOf(spec: BaseSpec): BaseMode {
  return 'cmd' in spec ? 'cmd' : 'ref';
}

function withBases(def: WorkflowDefinition, entries: [string, BaseSpec][]): WorkflowDefinition {
  const next = { ...def };
  if (entries.length === 0) delete next.bases;
  else next.bases = Object.fromEntries(entries);
  return next;
}

/** Add a base named `base` (`base-2`, `base-3`… when taken) on the repo's default branch. */
export function addBase(def: WorkflowDefinition): { definition: WorkflowDefinition; name: string } {
  const taken = new Set(Object.keys(def.bases ?? {}));
  let name = 'base';
  for (let i = 2; taken.has(name); i++) name = `base-${i}`;
  return {
    definition: withBases(def, [...basesOf(def), [name, { ref: DEFAULT_BRANCH_REF }]]),
    name,
  };
}

/** Why `next` can't be the new name of base `old`; null when it can. */
export function baseNameProblem(def: WorkflowDefinition, old: string, next: string): string | null {
  if (next === old) return null;
  if (!BaseNameSchema.safeParse(next).success) {
    return 'use a lower-case name: a-z first, then a-z, 0-9, _ or -';
  }
  if (Object.prototype.hasOwnProperty.call(def.bases ?? {}, next)) {
    return `a base named "${next}" already exists`;
  }
  return null;
}

/** Rename base `old` to `next` (its place in the list kept); `base_default` follows. */
export function renameBase(def: WorkflowDefinition, old: string, next: string): WorkflowDefinition {
  if (old === next || baseNameProblem(def, old, next) !== null) return def;
  const out = withBases(
    def,
    basesOf(def).map(([n, s]): [string, BaseSpec] => [n === old ? next : n, s]),
  );
  if (def.base_default !== undefined) {
    out.base_default = Object.fromEntries(
      Object.entries(def.base_default).map(([k, v]) => [k, v === old ? next : v]),
    );
  }
  return out;
}

function mapBase(
  def: WorkflowDefinition,
  name: string,
  f: (spec: BaseSpec) => BaseSpec,
): WorkflowDefinition {
  return withBases(
    def,
    basesOf(def).map(([n, s]): [string, BaseSpec] => [n, n === name ? f(s) : s]),
  );
}

/** Switch base `name` between a ref and a command; `pr_into` is kept going to a command. */
export function setBaseMode(
  def: WorkflowDefinition,
  name: string,
  mode: BaseMode,
): WorkflowDefinition {
  return mapBase(def, name, (spec) => {
    if (baseModeOf(spec) === mode) return spec;
    if (mode === 'ref') return { ref: DEFAULT_BRANCH_REF };
    const pr = 'pr_into' in spec ? spec.pr_into : undefined;
    return { cmd: '', ...(pr !== undefined ? { pr_into: pr } : {}) };
  });
}

/**
 * Set one field of base `name`. An empty `timeout` or `pr_into` is removed; a field that doesn't
 * belong to the base's mode is ignored.
 */
export function setBaseField(
  def: WorkflowDefinition,
  name: string,
  field: BaseField,
  value: string,
): WorkflowDefinition {
  return mapBase(def, name, (spec) => {
    if ('ref' in spec) return field === 'ref' ? { ref: value } : spec;
    if (field === 'ref') return spec;
    const next: Record<string, string | undefined> = { ...spec };
    if (field !== 'cmd' && value.trim() === '') delete next[field];
    else next[field] = value;
    return next as unknown as BaseSpec;
  });
}

/** Set (or with null, clear) the base tickets of `kind` start from. */
export function setBaseDefault(
  def: WorkflowDefinition,
  kind: TicketKind,
  name: string | null,
): WorkflowDefinition {
  const entries = Object.entries(def.base_default ?? {}).filter(([k]) => k !== kind);
  if (name !== null) entries.push([kind, name]);
  const next = { ...def };
  // Kinds in their usual order, so a save doesn't reorder the JSON.
  const ordered = TICKET_KINDS.flatMap((k) => entries.filter(([e]) => e === k));
  if (ordered.length === 0) delete next.base_default;
  else next.base_default = Object.fromEntries(ordered);
  return next;
}

/**
 * Remove base `name`, refused while `base_default` names it or `queuedUses` tickets in Queued use
 * it (the reasons say which). The last base removes `bases` itself.
 */
export function removeBase(
  def: WorkflowDefinition,
  name: string,
  queuedUses = 0,
): { ok: true; definition: WorkflowDefinition } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const kinds = Object.entries(def.base_default ?? {})
    .filter(([, v]) => v === name)
    .map(([k]) => k);
  if (kinds.length > 0) reasons.push(`it is the default for ${kinds.join(' and ')} tickets`);
  if (queuedUses > 0) {
    reasons.push(`${queuedUses} queued ticket${queuedUses === 1 ? ' uses' : 's use'} it`);
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    definition: withBases(
      def,
      basesOf(def).filter(([n]) => n !== name),
    ),
  };
}

/** A problem in the Bases section; `warning` ones never block a save. */
export interface BaseIssue {
  path: string;
  message: string;
  warning?: true;
}

const dotted = (path: (string | number)[]) => path.join('.');

/**
 * The definition's base problems: each spec's shape (a command can't be empty, a ref must be a
 * branch), rules 26 and 27 (`checkBases`), rule 14 while `bases` isn't available, and the warnings
 * (`basesWarnings`, a command without `pr_into`). Paths are the server's, dot-joined.
 */
export function basesIssues(
  def: WorkflowDefinition,
  features: readonly WorkflowFeature[],
): BaseIssue[] {
  const issues: BaseIssue[] = [];
  for (const [name, spec] of basesOf(def)) {
    if (!BaseNameSchema.safeParse(name).success) {
      issues.push({ path: `bases.${name}`, message: `"${name}" is not a lower-case base name` });
    }
    const parsed = BaseSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const field = baseModeOf(spec);
      issues.push({
        path: `bases.${name}.${field}`,
        message:
          field === 'cmd'
            ? 'the command is empty, or its timeout is not a duration like 2m'
            : `expected a branch name or ${DEFAULT_BRANCH_REF}`,
      });
    }
  }
  for (const e of [...checkBases(def), ...checkBasesAvailability(def, features)]) {
    issues.push({ path: dotted(e.path), message: `rule ${e.rule}: ${e.message}` });
  }
  for (const w of basesWarnings(def)) {
    issues.push({ path: dotted(w.path), message: w.message, warning: true });
  }
  return issues;
}
