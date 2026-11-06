// ADR-0039 (B3, FR-4): an instruction or check that uses `$base` / `$base_sha`, rendered with the
// workflow's current default base, so the designer shows what it will say. The real branch of a
// command base is only known when a ticket starts (B2), so the preview uses the base's name.
import {
  TICKET_KINDS,
  substituteBase,
  usesBaseToken,
  type TicketKind,
  type WorkflowDefinition,
} from '@conductor/shared';
import { createContext, useContext } from 'react';

/** The base a preview substitutes: the work default, else the personal one, else the first. */
export interface PreviewBase {
  name: string;
  /** The kind it is the default for; null = the first base, no kind's default. */
  kind: TicketKind | null;
}

/** The preview base of `def`; null when it has no bases (no preview). */
export function previewBaseOf(
  def: Pick<WorkflowDefinition, 'bases' | 'base_default'> | null,
): PreviewBase | null {
  if (def === null) return null;
  for (const kind of TICKET_KINDS) {
    const name = def.base_default?.[kind];
    if (name !== undefined) return { name, kind };
  }
  const first = Object.keys(def.bases ?? {})[0];
  return first !== undefined ? { name: first, kind: null } : null;
}

/** `text` with `$base` as the base's name and `$base_sha` as a stand-in for its commit. */
export function previewText(text: string, base: PreviewBase): string {
  return substituteBase(text, { base: base.name, base_sha: `<${base.name} commit>` });
}

/** The editor's preview base (WorkflowsView provides it from the shown definition). */
export const BasePreviewContext = createContext<PreviewBase | null>(null);

/** "With the work default (sprint): …" under a text that uses `$base`; nothing otherwise. */
export function BasePreview({ text }: { text: string | undefined }) {
  const base = useContext(BasePreviewContext);
  if (base === null || text === undefined || !usesBaseToken(text)) return null;
  const which = base.kind !== null ? `the ${base.kind} default` : 'the base';
  return (
    <p className="muted wf-base-preview">
      With {which} ({base.name}): <code>{previewText(text, base)}</code>
    </p>
  );
}

/** `BasePreview` as a table row spanning `colSpan` cells (a check list); nothing otherwise. */
export function BasePreviewRow({ text, colSpan }: { text: string; colSpan: number }) {
  const base = useContext(BasePreviewContext);
  if (base === null || !usesBaseToken(text)) return null;
  return (
    <tr className="wf-checks-preview">
      <td colSpan={colSpan}>
        <BasePreview text={text} />
      </td>
    </tr>
  );
}
