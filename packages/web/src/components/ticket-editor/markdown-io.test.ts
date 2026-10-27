// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import ticket from './fixtures/ux-3-ticket.md?raw';
import {
  editorMarkdown,
  escapeText,
  importMarkdown,
  normaliseMarkdown,
  tidyMarkdown,
} from './markdown-io.js';
import { TICKET_TEMPLATE } from './template.js';

// Markdown -> BlockNote blocks -> markdown, the same calls RichTicketEditor makes (headless).
function roundTrip(md: string): string {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, importMarkdown(editor, md));
  return editorMarkdown(editor);
}

// The plain text BlockNote holds for each block after an import (what the user sees).
function visibleText(md: string): string[] {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, importMarkdown(editor, md));
  const text = (content: unknown): string =>
    Array.isArray(content)
      ? content.map((c: { text?: string; content?: unknown }) => c.text ?? text(c.content)).join('')
      : '';
  return editor.document.map((b) =>
    b.type === 'table'
      ? (b.content as { rows: { cells: { content: unknown }[] }[] }).rows
          .map((r) => r.cells.map((c) => text(c.content)).join(' | '))
          .join(' / ')
      : text(b.content),
  );
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

  it('tidyMarkdown leaves code fences alone, blank lines included', () => {
    expect(tidyMarkdown('```\n* a\n|  b  |\n```\n* c')).toBe('```\n* a\n|  b  |\n```\n- c\n');
    expect(tidyMarkdown('a\n\n\n\nb\n```\nx\n\n\n\ny\n```\n')).toBe(
      'a\n\nb\n```\nx\n\n\n\ny\n```\n',
    );
    expect(roundTrip('```ts\nx\n\n\ny\n```\n')).toBe('```ts\nx\n\n\ny\n```\n');
  });

  // QA (PR #10): BlockNote's parser reads `<word>` as inline HTML and dropped it.
  it.each([
    ['Continue on <machine> when it frees up.', 'Continue on <machine> when it frees up.'],
    ['Set <app>-ratelimit to 10.', 'Set <app>-ratelimit to 10.'],
    ['| Key | Value |\n|---|---|\n| <placeholder> | x |', 'Key | Value / <placeholder> | x'],
    ['Escaped \\<b> and a<b and `<code>` stay', 'Escaped <b> and a<b and <code> stay'],
    [
      'Autolinks still work: <https://example.com/x>',
      'Autolinks still work: https://example.com/x',
    ],
  ])('keeps literal <…> text on import: %s', (md, seen) => {
    expect(visibleText(md)).toEqual([seen]);
    // ...and it survives export and a second import unchanged.
    expect(visibleText(roundTrip(md))).toEqual([seen]);
  });

  it('keeps <…> inside code fences verbatim', () => {
    expect(roundTrip('```html\n<div class="x">\\<b></div>\n```\n')).toBe(
      '```html\n<div class="x">\\<b></div>\n```\n',
    );
  });

  // QA (PR #10): literal markdown typed as text must stay text, not become markup on reload.
  it('escapes markdown-significant characters typed as plain text', () => {
    const typed = [
      '*x* and _y_ and [n](u) and `c` and \\ and ~~s~~ and <x> and snake_case',
      '# not a heading',
      '- not a list',
      '+ not a list',
      '1. not numbered',
      '> not a quote',
    ];
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(
      editor.document,
      typed.map((t) => ({ type: 'paragraph' as const, content: t })),
    );
    const md = editorMarkdown(editor);
    expect(md).toContain('snake_case');
    const again = BlockNoteEditor.create();
    again.replaceBlocks(again.document, importMarkdown(again, md));
    expect(again.document.map((b) => b.type)).toEqual(typed.map(() => 'paragraph'));
    expect(
      again.document.map((b) =>
        (b.content as { type: string; text: string; styles: object }[]).map((c) => [
          c.type,
          c.text,
          c.styles,
        ]),
      ),
    ).toEqual(typed.map((t) => [['text', t, {}]]));
  });

  it('escapeText only escapes line-start syntax at the start of a block', () => {
    expect(escapeText('1. a - b # c > d', true)).toBe('1\\. a - b # c > d');
    expect(escapeText('1. a', false)).toBe('1. a');
  });

  // TD-122: BlockNote's code mark excludes other marks, so bold/italic around inline code is
  // lost. This is the real preamble line of the UX-3 ticket; the loss is known and accepted.
  it('KNOWN LOSS (TD-122): bold around inline code keeps the code but drops the bold', () => {
    const line =
      'When the work is done and the gates are green, take the transition **`personal_pr_ready_for_review`** with your full implementer report as the reason.';
    const out = roundTrip(line);
    expect(out).toContain('`personal_pr_ready_for_review`');
    expect(out).not.toContain('**`personal_pr_ready_for_review`**');
    expect(out).toBe(
      line.replace('**`personal_pr_ready_for_review`**', '`personal_pr_ready_for_review`') + '\n',
    );
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
