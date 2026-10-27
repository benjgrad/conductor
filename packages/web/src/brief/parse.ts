// UX-2: a ticket body as a brief. Tickets use markdown sections (Ben, 2026-10-27): `## Goal`,
// `## Context`, `## Functional requirements` (bullets `FR-n …`), `## Non-functional requirements`
// (`NFR-n …`), `## Out of scope`, `## Verification` (a table or bullets mapping each FR/NFR to its
// proof); other sections may follow. Pure, with no imports (NFR-5): it can move to
// @conductor/shared for agents and the MCP server.

export interface Requirement {
  id: string;
  text: string;
}

export interface VerificationRow {
  /** A requirement id, e.g. `FR-1` (ranges and lists in the source are expanded). */
  req: string;
  how: string;
}

export interface BriefSection {
  heading: string;
  markdown: string;
}

export interface Brief {
  goal: string;
  context: string;
  functional: Requirement[];
  nonFunctional: Requirement[];
  outOfScope: string;
  verification: VerificationRow[];
  /** Unrecognised sections, in order (the whole body for a legacy ticket). */
  other: BriefSection[];
  warnings: string[];
}

type Known = 'goal' | 'context' | 'functional' | 'nonFunctional' | 'outOfScope' | 'verification';

const KNOWN: Record<string, Known> = {
  goal: 'goal',
  context: 'context',
  'functional requirements': 'functional',
  'non-functional requirements': 'nonFunctional',
  'nonfunctional requirements': 'nonFunctional',
  'non functional requirements': 'nonFunctional',
  'out of scope': 'outOfScope',
  verification: 'verification',
};

const TITLES: Record<Known, string> = {
  goal: 'Goal',
  context: 'Context',
  functional: 'Functional requirements',
  nonFunctional: 'Non-functional requirements',
  outOfScope: 'Out of scope',
  verification: 'Verification',
};

const HEADING = /^##\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^ ?(?:[-*+]|\d+[.)])\s+(.*)$/;
// `FR-1 …`, `**FR-1** …`, `FR-1: …`; the closing `**` only when the id opened with it.
const REQ_ID = /^(\*\*)?\s*(N?FR-\d+)\s*\1\s*[:.—–-]?\s*/i;
const SEPARATOR = /^\|?\s*:?-{2,}/;
/** `FR-1: how`, `FR-1, NFR-2 — how`, `FR-1..3: how` (a bullet in a list-style Verification). */
const BULLET_ROW =
  /^\**\s*(N?FR-\d+(?:\s*(?:,|;|&|\/|\.\.|\u2013|and|to)\s*(?:N?FR-)?\d+)*)\s*\**\s*[:\u2014\u2013-]\s*(.*)$/i;

function headingKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[:\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `##` sections (fenced code is never a heading); text before the first is heading ''. */
function sections(src: string): BriefSection[] {
  const out: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }];
  let fenced = false;
  for (const line of src.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced ? null : HEADING.exec(line);
    if (h) out.push({ heading: h[1]!, lines: [] });
    else out.at(-1)!.lines.push(line);
  }
  return out
    .map((s) => ({ heading: s.heading, markdown: s.lines.join('\n').trim() }))
    .filter((s) => s.heading !== '' || s.markdown !== '');
}

/** Top-level list items, continuation lines joined with a space; a blank line ends an item. */
function items(markdown: string): string[] {
  const out: string[][] = [];
  let open = false;
  for (const line of markdown.split('\n')) {
    const m = ITEM.exec(line);
    if (m) {
      out.push([m[1]!.trim()]);
      open = true;
    } else if (line.trim() === '') {
      open = false;
    } else if (open) {
      out.at(-1)!.push(line.trim());
    }
  }
  return out.map((parts) => parts.join(' '));
}

function requirements(
  markdown: string,
  prefix: 'FR' | 'NFR',
  label: string,
  warnings: string[],
): Requirement[] {
  return items(markdown).map((item, i) => {
    const m = REQ_ID.exec(item);
    const id = m?.[2]?.toUpperCase();
    if (!m || !id || id.split('-')[0] !== prefix) {
      warnings.push(`${label} ${i + 1} has no ${prefix}-n id`);
      return { id: `${prefix}-?${i + 1}`, text: item };
    }
    return { id, text: item.slice(m[0].length).trim() };
  });
}

/** `FR-1`, `FR-1, NFR-2`, `FR-1 and FR-2`, `FR-1..3`, `FR-1..FR-3`, `FR-1–3` → ids. */
export function expandIds(ref: string): string[] {
  const out: string[] = [];
  for (const part of ref.split(/\s*(?:,|;|\/|\band\b|&)\s*/i)) {
    const p = part.trim().replace(/\*/g, '');
    if (p === '') continue;
    const range = /^(N?FR)-(\d+)\s*(?:\.\.|–|—|-|to)\s*(?:(N?FR)-)?(\d+)$/i.exec(p);
    if (range && (!range[3] || range[3].toUpperCase() === range[1]!.toUpperCase())) {
      const prefix = range[1]!.toUpperCase();
      const from = Number(range[2]);
      const to = Number(range[4]);
      if (to >= from && to - from < 100) {
        for (let n = from; n <= to; n++) out.push(`${prefix}-${n}`);
        continue;
      }
    }
    out.push(p.toUpperCase());
  }
  return out;
}

function splitCells(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  // A leading and a trailing pipe leave empty edge cells.
  if (row.trim().startsWith('|')) cells.shift();
  if (row.trim().endsWith('|') && !row.trim().endsWith('\\|')) cells.pop();
  return cells;
}

function verificationRows(markdown: string): VerificationRow[] {
  const lines = markdown.split('\n');
  const rows: { ref: string; how: string }[] = [];
  if (lines.some((l) => l.trim().startsWith('|'))) {
    let header = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      if (header) {
        header = false;
        continue;
      }
      if (SEPARATOR.test(t)) continue;
      const [ref = '', ...rest] = splitCells(t);
      if (ref === '') continue;
      rows.push({ ref, how: rest.filter((c) => c !== '').join(' | ') });
    }
  } else {
    for (const item of items(markdown)) {
      const m = BULLET_ROW.exec(item);
      if (m) rows.push({ ref: m[1]!.trim(), how: m[2]!.trim() });
    }
  }
  return rows.flatMap(({ ref, how }) => expandIds(ref).map((req) => ({ req, how })));
}

export function parseBrief(markdown: string): Brief {
  const src = markdown.replace(/\r\n?/g, '\n');
  const brief: Brief = {
    goal: '',
    context: '',
    functional: [],
    nonFunctional: [],
    outOfScope: '',
    verification: [],
    other: [],
    warnings: [],
  };
  if (src.trim() === '') {
    brief.warnings.push('The ticket has no description');
    return brief;
  }
  const all = sections(src);
  const seen = new Set<Known>();
  for (const s of all) {
    const known = s.heading === '' ? undefined : KNOWN[headingKey(s.heading)];
    if (!known) {
      brief.other.push(s);
      continue;
    }
    if (seen.has(known)) {
      brief.warnings.push(`A second ${TITLES[known]} section is shown as written`);
      brief.other.push(s);
      continue;
    }
    seen.add(known);
    switch (known) {
      case 'goal':
      case 'context':
      case 'outOfScope':
        brief[known] = s.markdown;
        break;
      case 'functional':
        brief.functional = requirements(s.markdown, 'FR', 'Functional requirement', brief.warnings);
        break;
      case 'nonFunctional':
        brief.nonFunctional = requirements(
          s.markdown,
          'NFR',
          'Non-functional requirement',
          brief.warnings,
        );
        break;
      case 'verification':
        brief.verification = verificationRows(s.markdown);
        break;
    }
  }
  if (seen.size === 0) {
    brief.warnings = ['No recognised sections: showing the ticket as written'];
    return brief;
  }
  for (const k of Object.keys(TITLES) as Known[]) {
    if (!seen.has(k)) brief.warnings.push(`No ${TITLES[k]} section`);
  }
  const ids = new Set<string>();
  for (const r of [...brief.functional, ...brief.nonFunctional]) {
    if (ids.has(r.id)) brief.warnings.push(`${r.id} appears twice`);
    ids.add(r.id);
  }
  const unmatched = new Set(brief.verification.map((v) => v.req).filter((req) => !ids.has(req)));
  for (const req of unmatched)
    brief.warnings.push(`Verification row ${req} matches no requirement`);
  return brief;
}

/** Every verification "how" for one requirement id. */
export function verificationFor(brief: Brief, id: string): string[] {
  return brief.verification.filter((v) => v.req === id).map((v) => v.how);
}

export interface Tally {
  fr: number;
  nfr: number;
  total: number;
  /** Requirements with at least one verification row. */
  verified: number;
  /** Ids without one, in order. */
  missing: string[];
}

export function tally(brief: Brief): Tally {
  const reqs = [...brief.functional, ...brief.nonFunctional];
  const covered = new Set(brief.verification.map((v) => v.req));
  const missing = reqs.filter((r) => !covered.has(r.id)).map((r) => r.id);
  return {
    fr: brief.functional.length,
    nfr: brief.nonFunctional.length,
    total: reqs.length,
    verified: reqs.length - missing.length,
    missing,
  };
}
