// The requirements template a new ticket starts from (UX-3): fixed sections, one grey placeholder
// line each. Bodies stay plain markdown; untouched placeholders are stripped before submit.

export const TICKET_SECTIONS = [
  'Goal',
  'Context',
  'Functional requirements',
  'Non-functional requirements',
  'Out of scope',
  'Verification',
] as const;

export const TICKET_TEMPLATE = `## Goal
One or two sentences: what changes, and for whom.

## Context
- Background, links and decisions so far …

## Functional requirements
- FR-1 …

## Non-functional requirements
- NFR-1 …

## Out of scope
- …

## Verification
| Req | How it's verified |
|---|---|
| FR-1 | … |
`;

/** Placeholder text as the editor shows it: no list marker, table cells joined by "|". */
export const PLACEHOLDER_TEXTS = [
  'One or two sentences: what changes, and for whom.',
  'Background, links and decisions so far …',
  'FR-1 …',
  'NFR-1 …',
  '…',
] as const;

const PLACEHOLDER_TABLE_ROWS = ['|FR-1|…|'];

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

function compactRow(line: string): string {
  return line.trim().replace(/\s*\|\s*/g, '|');
}

/** True for a template placeholder line the user left as it was (any list marker / padding). */
export function isPlaceholderLine(line: string): boolean {
  if (TABLE_ROW.test(line)) return PLACEHOLDER_TABLE_ROWS.includes(compactRow(line));
  const text = line.replace(LIST_MARKER, '').trim();
  return (PLACEHOLDER_TEXTS as readonly string[]).includes(text);
}

/**
 * Drops untouched placeholder lines (outside code fences), and a table left with only its
 * header. An untouched template becomes '', like the old empty Description.
 */
export function stripPlaceholders(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && isPlaceholderLine(line)) continue;
    kept.push(line);
  }
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    const next = kept[i + 1];
    const after = kept[i + 2];
    const headerOnly =
      TABLE_ROW.test(line) &&
      next !== undefined &&
      TABLE_SEPARATOR.test(next) &&
      (after === undefined || !TABLE_ROW.test(after));
    if (headerOnly && (i === 0 || !TABLE_ROW.test(kept[i - 1]!))) {
      i++;
      continue;
    }
    out.push(line);
  }
  const hasContent = out.some((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l));
  return hasContent
    ? out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() + '\n'
    : '';
}
