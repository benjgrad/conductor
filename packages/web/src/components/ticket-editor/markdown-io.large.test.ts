// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import { editorMarkdown, importMarkdown, normaliseMarkdown } from './markdown-io.js';

// Split out of markdown-io.test.ts so its timing assertion can be quarantined on its own
// (docs/tracking/FLAKY.md, WF-T11) while the rest of the round-trip tests stay in the gate.

function roundTrip(md: string): string {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, importMarkdown(editor, md));
  return editorMarkdown(editor);
}
const items = (md: string) =>
  normaliseMarkdown(md)
    .split('\n')
    .filter((l) => /^\s*(?:-|\d+\.) /.test(l));
const tableRows = (md: string) =>
  normaliseMarkdown(md)
    .split('\n')
    .filter((l) => l.startsWith('|'));

describe('markdown round-trip through BlockNote, large bodies (UX-3 NFR-4)', () => {
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
