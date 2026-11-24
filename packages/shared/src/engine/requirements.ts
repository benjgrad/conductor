import { z } from 'zod';
import type { JsonObject } from '../domain.js';

// ADR-0045: the ticket's requirements checklist, `session.context.__requirements`. A planning
// agent (a `plan_template` state) writes the list in its result (`requirements`); conductor's
// requirements reviewer checks every item at each review step and records met / unmet; a human
// can edit the list (`human.requirements`). Any other agent may only propose a change, through a
// question, and a human applies it. Pure: apply.ts and the board read and write it through these.

/** `session.context` key of the checklist (reserved: never a state name, never an agent result). */
export const REQUIREMENTS_CONTEXT_KEY = '__requirements';

/** The `complete_state` result key a planning agent sets the list with. */
export const REQUIREMENTS_RESULT_KEY = 'requirements';

/** The `complete_state` result key any other agent proposes a changed list with. */
export const PROPOSED_REQUIREMENTS_RESULT_KEY = 'proposed_requirements';

/** The longest list (prompt length and the reviewer's verdict). */
export const REQUIREMENTS_MAX = 30;

/** The longest single requirement. */
export const REQUIREMENT_TEXT_MAX = 500;

export const RequirementStatusSchema = z.enum(['pending', 'met', 'unmet']);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const RequirementItemSchema = z.object({
  text: z.string().min(1).max(REQUIREMENT_TEXT_MAX),
  /** `pending`: not reviewed since it was added. `met` / `unmet`: the latest verdict on it. */
  status: RequirementStatusSchema,
  /** The reviewer's reason for the latest verdict; null while pending. */
  reason: z.string().nullable(),
  /** The review step that judged it (its `workflow_state` label); null while pending. */
  checked_in: z.string().nullable(),
});
export type RequirementItem = z.infer<typeof RequirementItemSchema>;

export const RequirementsProposalSchema = z.object({
  items: z.array(z.string().min(1).max(REQUIREMENT_TEXT_MAX)).min(1).max(REQUIREMENTS_MAX),
  /** The agent state that proposed it. */
  from_state: z.string(),
  /** The list's `revision` the proposal was made against. */
  revision_of: z.number().int().nonnegative(),
});
export type RequirementsProposal = z.infer<typeof RequirementsProposalSchema>;

export const RequirementsSchema = z.object({
  items: z.array(RequirementItemSchema).max(REQUIREMENTS_MAX),
  /** Who wrote the current list: a planning agent or a human. */
  set_by: z.enum(['agent', 'human']),
  /** The planning state that wrote it, or the human's actor id. */
  set_in: z.string(),
  /** 1 for the first list, +1 per change; 0 while there is no list yet (only a proposal). */
  revision: z.number().int().nonnegative(),
  /** An agent's proposed change waiting for a human; null when there is none. */
  proposed: RequirementsProposalSchema.nullable(),
  /**
   * The last change an agent tried to make without asking (on a transition that isn't a
   * question), which conductor ignored. Cleared by the next change. Defaults to null.
   */
  ignored: RequirementsProposalSchema.nullable().default(null),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** Case and whitespace insensitive, as the reviewer's verdict is matched (review.ts). */
export function normRequirement(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The checklist in a session's `context`, or null (none, or it doesn't parse). Never throws. */
export function requirementsOfContext(context: Record<string, unknown>): Requirements | null {
  const parsed = RequirementsSchema.safeParse(context[REQUIREMENTS_CONTEXT_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * A list from an agent's result or a human's edit: strings, trimmed, inner whitespace collapsed,
 * blanks dropped, duplicates (normalised) dropped in order. null unless it is an array of strings
 * with 1..REQUIREMENTS_MAX entries of at most REQUIREMENT_TEXT_MAX characters left.
 */
export function parseRequirementList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const text = entry.trim().replace(/\s+/g, ' ');
    if (text === '') continue;
    if (text.length > REQUIREMENT_TEXT_MAX) return null;
    const key = normRequirement(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length === 0 || out.length > REQUIREMENTS_MAX) return null;
  return out;
}

/** The same requirements in the same order (normalised). */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => normRequirement(t) === normRequirement(b[i]!));
}

/** The texts of a checklist (or [] without one). */
export function requirementTexts(r: Requirements | null): string[] {
  return r === null ? [] : r.items.map((i) => i.text);
}

/**
 * A new list. An item whose text is unchanged (normalised) keeps its status and reason; a new one
 * is pending. The revision goes up and any proposal is cleared (it has been decided).
 */
export function setRequirements(
  prev: Requirements | null,
  texts: readonly string[],
  by: { set_by: Requirements['set_by']; set_in: string },
): Requirements {
  const old = new Map((prev?.items ?? []).map((i) => [normRequirement(i.text), i]));
  return {
    items: texts.map((text) => {
      const kept = old.get(normRequirement(text));
      return kept !== undefined
        ? { ...kept, text }
        : { text, status: 'pending', reason: null, checked_in: null };
    }),
    set_by: by.set_by,
    set_in: by.set_in,
    revision: (prev?.revision ?? 0) + 1,
    proposed: null,
    ignored: null,
  };
}

/** Record a reviewer's verdict on the items it judged (matched by normalised text). */
export function recordVerdict(
  prev: Requirements,
  verdict: readonly { item: string; met: boolean; reason: string }[],
  label: string,
): Requirements {
  const byText = new Map(verdict.map((v) => [normRequirement(v.item), v]));
  return {
    ...prev,
    items: prev.items.map((i) => {
      const v = byText.get(normRequirement(i.text));
      return v === undefined
        ? i
        : { ...i, status: v.met ? 'met' : 'unmet', reason: v.reason || null, checked_in: label };
    }),
  };
}

/** `context` with the checklist replaced. */
export function withRequirements(
  context: Record<string, JsonObject>,
  r: Requirements,
): Record<string, JsonObject> {
  return { ...context, [REQUIREMENTS_CONTEXT_KEY]: r };
}

/** How many items are met, of how many. */
export function requirementsProgress(r: Requirements): { met: number; total: number } {
  return { met: r.items.filter((i) => i.status === 'met').length, total: r.items.length };
}

/** The added and removed texts of a proposal against the current list (normalised). */
export function proposalDiff(
  current: readonly string[],
  proposed: readonly string[],
): { added: string[]; removed: string[] } {
  const cur = new Set(current.map(normRequirement));
  const next = new Set(proposed.map(normRequirement));
  return {
    added: proposed.filter((t) => !cur.has(normRequirement(t))),
    removed: current.filter((t) => !next.has(normRequirement(t))),
  };
}

/** The heading of the prompt section that lists the checklist. */
export const REQUIREMENTS_HEADING = '## Requirements';

/** The rule every non-planning agent gets with the list. */
export const REQUIREMENTS_FIXED_INSTRUCTION =
  "Conductor's reviewer checks each of these before the ticket moves on. You cannot change this list. If one is wrong, missing or impossible, take the `ask_user` transition with `complete_state` and put the full corrected list in `result.proposed_requirements`: a human decides. A changed list on any other transition is ignored.";

const MARK: Record<RequirementStatus, string> = {
  pending: '[ ] not checked yet',
  met: '[x] met',
  unmet: '[!] not met',
};

/** The checklist with each item's status, for an agent's prompt. */
export function renderRequirementsSection(r: Requirements): string {
  const lines = [REQUIREMENTS_HEADING, ''];
  r.items.forEach((i, n) => {
    const why = i.status !== 'pending' && i.reason ? ` (${i.reason})` : '';
    lines.push(`${n + 1}. ${MARK[i.status]}: ${i.text}${why}`);
  });
  lines.push('', REQUIREMENTS_FIXED_INSTRUCTION);
  return lines.join('\n');
}

/**
 * The list a non-planning agent's result tries to set (`proposed_requirements`, else
 * `requirements`), or null when it names none that parses.
 */
export function proposedOfResult(result: JsonObject): string[] | null {
  return (
    parseRequirementList(result[PROPOSED_REQUIREMENTS_RESULT_KEY]) ??
    parseRequirementList(result[REQUIREMENTS_RESULT_KEY])
  );
}
