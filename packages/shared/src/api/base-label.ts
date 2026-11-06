import { DEFAULT_BRANCH_REF, isCommitSha } from '../workflow/schema.js';
import type {
  SessionBase,
  TicketBase,
  TicketKind,
  WorkflowDefinition,
} from '../workflow/schema.js';

// ADR-0039 (B3): how the board, the ticket detail and MCP word a ticket's base. Pure.

/** `baseLabel`'s result: `explicit` is false when the ticket names no base of its own. */
export interface BaseLabel {
  /** The label after "Base: ", e.g. `sprint (ncng-26-sb-2 @ a1b2c3d)`. */
  text: string;
  /** The short form for a card chip: the base's name, or its ref (a sha shortened). */
  short: string;
  explicit: boolean;
}

const shortRef = (ref: string) => (isCommitSha(ref) ? ref.slice(0, 7) : ref);
const refText = (ref: string) => (ref === DEFAULT_BRANCH_REF ? 'default branch' : shortRef(ref));

/**
 * The label for a ticket's base. Once its session started (`baseRef`, B2 records it): the name and
 * where it resolved, e.g. `sprint (ncng-26-sb-2 @ a1b2c3d)`. Before: the ticket's own base
 * (`sprint (resolved at start)`, or an explicit ref), else the workflow's `base_default` for its
 * kind, else the repo's default branch. A PR target other than the branch adds `→ PR into <b>`.
 */
export function baseLabel(
  base: TicketBase | null,
  baseRef: SessionBase | null,
  def: Pick<WorkflowDefinition, 'bases' | 'base_default'> | null,
  kind: TicketKind | null,
): BaseLabel {
  const prInto = (pr: string | null | undefined, ref: string) =>
    pr != null && pr !== ref ? ` → PR into ${pr}` : '';
  if (baseRef !== null) {
    const at = baseRef.sha !== null ? `${baseRef.ref} @ ${baseRef.sha.slice(0, 7)}` : baseRef.ref;
    const pr = prInto(baseRef.pr_into, baseRef.ref);
    if (baseRef.name !== null) {
      return { text: `${baseRef.name} (${at})${pr}`, short: baseRef.name, explicit: true };
    }
    return { text: `${shortRef(at)}${pr}`, short: shortRef(baseRef.ref), explicit: true };
  }
  if (typeof base === 'string') {
    return { text: `${base} (resolved at start)`, short: base, explicit: true };
  }
  if (base !== null) {
    return {
      text: `${shortRef(base.ref)}${prInto(base.pr_into, base.ref)}`,
      short: shortRef(base.ref),
      explicit: true,
    };
  }
  const name = kind !== null ? def?.base_default?.[kind] : undefined;
  if (name !== undefined) {
    return {
      text: `${name} (default for ${kind}, resolved at start)`,
      short: name,
      explicit: false,
    };
  }
  return { text: refText(DEFAULT_BRANCH_REF), short: refText(DEFAULT_BRANCH_REF), explicit: false };
}
