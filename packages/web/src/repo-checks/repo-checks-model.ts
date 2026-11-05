import {
  repoChecksKey,
  stateTitle,
  transitionGoto,
  transitionTitle,
  type ChecksGate,
  type EntryCheck,
  type RepoChecksDetail,
  type RepoChecksDto,
  type RepoSuggestion,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { ChecksValue } from '../workflow/ChecksFields.js';
import { checkListIssues, type CheckListIssue } from '../workflow/transitions.js';

// The Repo checks page's pure parts (UXR-76/77/79/81): the repo list's groups, gate titles and the
// "Compare with the workflow's checks" rows, which preview the unsaved draft.

/** How a gate's or override's `setup` reads (null = auto-detect, '' = none). */
export function setupText(setup: string | null): string {
  if (setup === null) return 'Auto-detect (npm ci / npm install)';
  if (setup === '') return 'None';
  return setup;
}

/**
 * The draft for a repo: its override, else the workflow's first gate (a starting point). When the
 * workflow's gates differ, a draft equal to the first counts as unchanged: setting it would still
 * change the others, but that's rare enough not to offer it untouched.
 */
export function initialDraft(detail: RepoChecksDetail): ChecksValue {
  const from = detail.override ?? detail.effective[0] ?? null;
  if (from === null) return { checks: [{ name: '', cmd: '' }], setup: undefined };
  return { checks: structuredClone(from.checks), setup: from.setup ?? undefined };
}

/** `checkListIssues` plus the override's own rule: at least one check (RepoChecksSchema). */
export function overrideIssues(draft: ChecksValue): CheckListIssue[] {
  const issues = checkListIssues(draft.checks, draft.setup);
  if (draft.checks.length === 0) {
    issues.push({ suffix: 'checks', message: 'add at least one check' });
  }
  return issues;
}

export interface RepoRow {
  repo: string;
  override: RepoChecksDto | null;
}

/**
 * The left pane: every repo the machines or tickets know (`listRepos`, best first) plus every repo
 * with an override, one row per repo (`repoChecksKey`; the override's spelling wins). Own checks
 * by name; the rest in `listRepos` order. `filter` matches anywhere in the name, any case.
 */
export function repoRows(
  suggestions: readonly RepoSuggestion[],
  overrides: readonly RepoChecksDto[],
  filter: string,
): { own: RepoRow[]; workflow: RepoRow[] } {
  const needle = filter.trim().toLowerCase();
  const hit = (repo: string) => needle === '' || repo.toLowerCase().includes(needle);
  const owned = new Set(overrides.map((o) => repoChecksKey(o.repo)));
  const own = [...overrides]
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .filter((o) => hit(o.repo))
    .map((o) => ({ repo: o.repo, override: o }));
  const seen = new Set(owned);
  const workflow: RepoRow[] = [];
  for (const s of suggestions) {
    const key = repoChecksKey(s.repo);
    if (seen.has(key)) continue;
    seen.add(key);
    if (hit(s.repo)) workflow.push({ repo: s.repo, override: null });
  }
  return { own, workflow };
}

/**
 * A gate as people read it: "Implementing → Needs input (PR ready for review)" for a transition's
 * `requires` (`state.transition`), "Entering Implementing" for a state's entry checks. The raw id
 * when the definition doesn't have it.
 */
export function gateTitle(def: Pick<WorkflowDefinition, 'states'> | null, at: string): string {
  if (def === null) return at;
  const dot = at.indexOf('.');
  if (dot < 0) return def.states[at] !== undefined ? `Entering ${stateTitle(def, at)}` : at;
  const from = at.slice(0, dot);
  const name = at.slice(dot + 1);
  const state = def.states[from];
  const raw = state !== undefined && 'on' in state ? state.on?.[name] : undefined;
  if (raw === undefined) return at;
  const to = transitionGoto(raw);
  const toTitle = def.states[to] !== undefined ? stateTitle(def, to) : to;
  return `${stateTitle(def, from)} → ${toTitle} (${transitionTitle(name, raw)})`;
}

/** Setup and checks, as they run. */
export interface Spec {
  /** null = auto-detect, '' = none. */
  setup: string | null;
  checks: readonly EntryCheck[];
}

export function sameSpec(a: Spec, b: Spec): boolean {
  if ((a.setup ?? null) !== (b.setup ?? null)) return false;
  if (a.checks.length !== b.checks.length) return false;
  return a.checks.every((c, i) => {
    const d = b.checks[i]!;
    return c.name === d.name && c.cmd === d.cmd && (c.timeout ?? '') === (d.timeout ?? '');
  });
}

export function draftAsSpec(draft: ChecksValue): Spec {
  return { setup: draft.setup ?? null, checks: draft.checks };
}

export function draftsDiffer(a: ChecksValue, b: ChecksValue): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export interface CompareRow {
  /** "All 3 gates", or the gates' titles. */
  label: string;
  gates: string[];
  workflow: Spec;
  /** What runs for this repo there; null = the workflow's checks. */
  repo: Spec | null;
  /** Differs from what is saved (the draft's change). */
  changed: boolean;
}

/**
 * "Compare with the workflow's checks": per gate, the workflow's own checks and what runs for this
 * repo once the draft is saved (the draft, while there is an override or the draft is dirty).
 * Gates with the same three values share a row; one covering every gate reads "All N gates".
 */
export function compareRows(input: {
  workflowGates: readonly ChecksGate[];
  savedOverride: Spec | null;
  draft: ChecksValue;
  dirty: boolean;
  title: (at: string) => string;
}): CompareRow[] {
  const { workflowGates, savedOverride, draft, dirty, title } = input;
  const drafted = savedOverride !== null || dirty ? draftAsSpec(draft) : null;
  const rows: CompareRow[] = [];
  for (const g of workflowGates) {
    const workflow: Spec = { setup: g.setup, checks: g.checks };
    const saved = savedOverride ?? workflow;
    const runs = drafted ?? workflow;
    const changed = !sameSpec(runs, saved);
    const repo = drafted;
    const same = rows.find(
      (r) =>
        r.changed === changed &&
        sameSpec(r.workflow, workflow) &&
        (r.repo === null ? repo === null : repo !== null && sameSpec(r.repo, repo)),
    );
    if (same !== undefined) same.gates.push(g.at);
    else rows.push({ label: '', gates: [g.at], workflow, repo, changed });
  }
  const n = workflowGates.length;
  for (const r of rows) {
    r.label =
      r.gates.length === n && n > 1 ? `All ${n} gates` : r.gates.map((at) => title(at)).join(', ');
  }
  return rows;
}

/** "Runs at all 3 check gates" (the header line). */
export function gateCountText(n: number): string {
  if (n === 0) return 'The workflow has no gate that runs checks';
  if (n === 1) return 'Runs at the one check gate';
  return `Runs at all ${n} check gates`;
}
