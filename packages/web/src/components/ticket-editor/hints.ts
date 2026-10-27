// Light, non-blocking requirement hints for the ticket body (UX-3 FR-4). A small local heuristic
// over the template's sections, not UX-2's requirements parser. One pass over the lines.
import { isPlaceholderLine, TICKET_SECTIONS } from './template.js';

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;
// A list item (or table row) whose text starts with the id, optionally bold: "- FR-1 …", "**FR-1**".
const ITEM_ID = /^\s*(?:[-*+]|\d+[.)])\s+\**((?:N?FR)-\d+)\b/;
const ANY_ID = /\b(N?FR-\d+)\b/g;
const MAX_LISTED = 5;

function sections(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  let fenced = false;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced ? null : HEADING.exec(line);
    if (h) {
      current = [];
      out.set(h[1]!.replace(/[*_`]/g, '').trim().toLowerCase(), current);
    } else if (current && !isPlaceholderLine(line)) {
      current.push(line);
    }
  }
  return out;
}

function definedIds(lines: string[] | undefined, prefix: 'FR' | 'NFR'): string[] {
  const ids: string[] = [];
  for (const line of lines ?? []) {
    const id = ITEM_ID.exec(line)?.[1];
    if (id?.startsWith(`${prefix}-`)) ids.push(id);
  }
  return ids;
}

export function requirementHints(md: string): string[] {
  const secs = sections(md);
  const hints: string[] = [];
  for (const name of TICKET_SECTIONS) {
    if (!secs.has(name.toLowerCase())) hints.push(`Missing section: ${name}`);
  }
  const frs = definedIds(secs.get('functional requirements'), 'FR');
  const nfrs = definedIds(secs.get('non-functional requirements'), 'NFR');
  if (frs.length === 0) hints.push('No functional requirements yet');

  const verification = secs.get('verification');
  if (verification) {
    const verified = new Set<string>();
    for (const line of verification) for (const m of line.matchAll(ANY_ID)) verified.add(m[1]!);
    const unverified = [...frs, ...nfrs].filter((id) => !verified.has(id));
    for (const id of unverified.slice(0, MAX_LISTED)) hints.push(`${id} has no verification`);
    if (unverified.length > MAX_LISTED) {
      hints.push(`${unverified.length - MAX_LISTED} more requirements have no verification`);
    }
  }
  return hints;
}
