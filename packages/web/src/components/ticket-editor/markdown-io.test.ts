// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import ticket from './fixtures/ux-3-ticket.md?raw';
import { editorMarkdown, normaliseMarkdown, tidyMarkdown } from './markdown-io.js';
import { TICKET_TEMPLATE } from './template.js';

// Markdown -> BlockNote blocks -> markdown, the same calls RichTicketEditor makes (headless).
function roundTrip(md: string): string {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(md));
  return editorMarkdown(editor);
}

const headings = (md: string) => md.split('\n').filter((l) => /^#{1,6} /.test(l));
const items = (md: string) =>
  normaliseMarkdown(md)
    .split('\n')
    .filter((l) => /^\s*(?:-|\d+\.) /.test(l));
const tableRows = (md: string) =>
  normaliseMarkdown(md)
    .split('\n')
    .filter((l) => l.startsWith('|'));

const EVERYTHING = `## Formatting

Some **bold**, *italic*, \`inline code\` and [a link](https://example.com/a?b=c).

1. First step
2. Second step

- A bullet
  - A nested bullet

\`\`\`ts
const answer: number = 42;
// * not a bullet
\`\`\`

| Col A | Col B |
|---|---|
| \`x\` | **y** |
`;

describe('markdown round-trip through BlockNote (UX-3 FR-1, FR-3, NFR-7)', () => {
  it.each([
    ['the template', TICKET_TEMPLATE],
    ["this ticket's body", ticket],
    ['every supported construct', EVERYTHING],
  ])('%s survives with headings, list items and table intact', (_, md) => {
    const out = roundTrip(md);
    expect(headings(out)).toEqual(headings(md));
    expect(items(out)).toEqual(items(md));
    expect(tableRows(out)).toEqual(tableRows(md));
    expect(normaliseMarkdown(out)).toBe(normaliseMarkdown(md));
  });

  it('keeps code blocks, links and inline marks verbatim', () => {
    const out = roundTrip(EVERYTHING);
    expect(out).toContain('```ts\nconst answer: number = 42;\n// * not a bullet\n```');
    expect(out).toContain('[a link](https://example.com/a?b=c)');
    expect(out).toContain('**bold**');
    expect(out).toContain('`inline code`');
    expect(out).toContain('1. First step');
  });

  it('writes house style: - bullets and compact table rows', () => {
    const out = roundTrip(TICKET_TEMPLATE);
    expect(out).toContain('\n- FR-1 …\n');
    expect(out).toContain("| Req | How it's verified |\n| --- | --- |\n| FR-1 | … |");
  });

  it('tidyMarkdown leaves code fences alone', () => {
    expect(tidyMarkdown('```\n* a\n|  b  |\n```\n* c')).toBe('```\n* a\n|  b  |\n```\n- c\n');
  });

  // NFR-4 (as applied to this form): a 2,000-requirement body still round-trips. Measured
  // headless in jsdom: 2,000 bullets ~0.7 s; a 2,000-row table exports in ~3 s, hence 200 rows
  // here and the debounced export in RichTicketEditor.
  it('round-trips a 2,000-requirement body', { timeout: 30_000 }, () => {
    const frs = Array.from({ length: 2000 }, (_, i) => `- FR-${i + 1} Requirement number ${i + 1}`);
    const rows = Array.from({ length: 200 }, (_, i) => `| FR-${i + 1} | test ${i + 1} |`);
    const md = `## Functional requirements\n${frs.join('\n')}\n\n## Verification\n| Req | How |\n|---|---|\n${rows.join('\n')}\n`;
    const start = performance.now();
    const out = roundTrip(md);
    const ms = performance.now() - start;
    expect(items(out)).toHaveLength(2000);
    expect(tableRows(out)).toHaveLength(202);
    expect(ms).toBeLessThan(15_000);
  });
});
