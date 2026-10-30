// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBrief } from '../brief/parse.js';
import { BriefCard } from './BriefCard.js';
import { Markdown, renderInline, unescapeMarkdown } from './markdown.js';
import { editorMarkdown } from './ticket-editor/markdown-io.js';

afterEach(cleanup);

function html(text: string): string {
  const { container } = render(<p>{renderInline(text)}</p>);
  const out = container.firstElementChild!.innerHTML;
  cleanup();
  return out;
}

describe('markdown renderer: backslash escapes (UX-3 QA)', () => {
  it.each([
    ['Continue on \\<machine>', 'Continue on &lt;machine&gt;'],
    ['\\*x\\*', '*x*'],
    ['\\[a\\]', '[a]'],
    ['a\\_b', 'a_b'],
    ['\\`not code\\`', '`not code`'],
    ['C:\\\\tmp', 'C:\\tmp'],
    ['a \\ b and \\q stay', 'a \\ b and \\q stay'],
  ])('%s renders as plain text', (src, out) => {
    expect(html(src)).toBe(out);
  });

  it('real emphasis, code and links still render', () => {
    expect(html('*it* and _it_ and **bold** and `c\\*` and [a link](https://x.dev)')).toBe(
      '<em>it</em> and <em>it</em> and <strong>bold</strong> and <code>c\\*</code> and ' +
        '<a href="https://x.dev" target="_blank" rel="noreferrer noopener">a link</a>',
    );
  });

  it('emphasis steps over escapes inside it', () => {
    expect(html('*a \\* b*')).toBe('<em>a * b</em>');
    expect(html('**x\\*\\*y**')).toBe('<strong>x**y</strong>');
    expect(html('[a \\] b](https://x.dev)')).toBe(
      '<a href="https://x.dev" target="_blank" rel="noreferrer noopener">a ] b</a>',
    );
  });

  it('escaped line-start syntax stays a paragraph', () => {
    const { container } = render(<Markdown text={'\\# not a heading\n\n\\- not a list'} />);
    expect(container.querySelector('.md-h, ul')).toBeNull();
    expect(container.textContent).toBe('# not a heading- not a list');
  });

  it('unescapeMarkdown removes only punctuation escapes', () => {
    expect(unescapeMarkdown('\\<x\\> \\a \\\\')).toBe('<x> \\a \\');
  });

  it('a body exported by the UX-3 editor shows on the BriefCard without backslashes', () => {
    const typed = [
      'Continue on <machine> after *x* and [a] with a_b and <app>-ratelimit.',
      '# not a heading',
    ];
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: 'heading', props: { level: 2 }, content: 'Goal' },
      ...typed.map((t) => ({ type: 'paragraph' as const, content: t })),
    ]);
    const body = editorMarkdown(editor);
    expect(body).toContain('\\<machine>'); // escaped in storage...
    render(
      <BriefCard
        sessionId="b2000000-0000-4000-8000-0000000000ab"
        brief={parseBrief(body)}
        body={body}
        unavailable={null}
        promptText={null}
        promptReason={null}
        promptLoading={false}
        onWantPrompt={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Full ticket/ }));
    const ticket = screen.getByLabelText('Full ticket');
    // ...and shown exactly as typed.
    for (const t of typed) expect(ticket.textContent).toContain(t);
    expect(ticket.textContent).not.toContain('\\');
    expect(ticket.querySelector('em, a')).toBeNull();
  });
});

describe('markdown renderer: hard breaks and bold-italic (UX-3b)', () => {
  function para(text: string): HTMLElement {
    const { container } = render(<Markdown text={text} />);
    return container.querySelector('p, blockquote')!;
  }

  it('a backslash at line end is a hard break: a br, no backslash', () => {
    const p = para('a\\\nb');
    expect(p.innerHTML).toBe('a<br>b');
    expect(p.textContent).not.toContain('\\');
  });

  it('an editor Shift+Enter break renders without a backslash', () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'line a\nline b' }]);
    const body = editorMarkdown(editor);
    expect(body).toContain('line a\\\nline b');
    const p = para(body);
    expect(p.textContent).toBe('line aline b');
    expect(p.querySelectorAll('br')).toHaveLength(1);
  });

  it('an escaped backslash at line end stays one literal backslash', () => {
    const end = para('a\\\\');
    expect(end.textContent).toBe('a\\');
    expect(end.querySelector('br')).toBeNull();
    cleanup();
    // The br here is the renderer's plain newline, not a hard break.
    expect(para('a\\\\\nb').textContent).toBe('a\\b');
  });

  it('a lone backslash ending the block is literal', () => {
    expect(para('a\\').textContent).toBe('a\\');
  });

  it('hard breaks in a quote drop the backslash too', () => {
    const q = para('> a\\\n> b');
    expect(q.tagName).toBe('BLOCKQUOTE');
    expect(q.innerHTML).toBe('a<br>b');
  });

  it.each([
    ['***x***', '<em><strong>x</strong></em>'],
    ['___x___', '<em><strong>x</strong></em>'],
    ['a ***b*** c', 'a <em><strong>b</strong></em> c'],
    ['***a \\* b***', '<em><strong>a * b</strong></em>'],
    ['snake___case', 'snake___case'],
  ])('%s renders bold+italic without stray markers', (src, out) => {
    expect(html(src)).toBe(out);
  });
});

describe('markdown renderer: tables, rules and strikethrough', () => {
  function md(text: string): HTMLElement {
    return render(<Markdown text={text} />).container.querySelector<HTMLElement>('.md')!;
  }
  const cells = (row: Element) => [...row.children].map((c) => c.textContent);

  it('a GFM table renders a header and body rows inside its own scroll box', () => {
    const el = md('| Step | File |\n|---|---|\n| 1 | **a.ts** |\n| 2 | `b|c` |');
    const table = el.querySelector('.md-table-wrap > table.md-table')!;
    expect(table).toBeTruthy();
    expect(cells(table.querySelector('thead tr')!)).toEqual(['Step', 'File']);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('strong')!.textContent).toBe('a.ts');
    expect(rows[1]!.querySelector('code')!.textContent).toBe('b|c');
    expect(el.querySelector('p')).toBeNull();
  });

  it('an escaped pipe is a literal pipe, in text and in code', () => {
    const el = md('a | b\n--|--\nx \\| y | `p\\|q`');
    expect(cells(el.querySelector('tbody tr')!)).toEqual(['x | y', 'p|q']);
  });

  it('alignment colons set text-align', () => {
    const el = md('|l|c|r|n|\n|:--|:-:|--:|---|\n|1|2|3|4|');
    const align = [...el.querySelectorAll<HTMLElement>('tbody td')].map((c) => c.style.textAlign);
    expect(align).toEqual(['left', 'center', 'right', '']);
  });

  it('ragged rows are padded or cut to the header width', () => {
    const el = md('|a|b|\n|-|-|\n|1|\n|1|2|3|');
    const rows = [...el.querySelectorAll('tbody tr')].map(cells);
    expect(rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('a pipe line without a delimiter row stays a paragraph', () => {
    const el = md('a | b\nc | d');
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('p')!.textContent).toBe('a | bc | d');
  });

  it('a delimiter row of the wrong width is not a table', () => {
    expect(md('|a|b|\n|-|').querySelector('table')).toBeNull();
  });

  it('a table right after a paragraph line still starts a table, and ends at a blank line', () => {
    const el = md('Files:\n|a|b|\n|-|-|\n|1|2|\n\nafter');
    expect(el.querySelector('p')!.textContent).toBe('Files:');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(el.lastElementChild!.textContent).toBe('after');
  });

  it.each(['---', '***', '- - -', '___'])('%s is a rule, not a list or emphasis', (rule) => {
    const el = md(`above\n\n${rule}\n\nbelow`);
    expect(el.querySelector('hr')).toBeTruthy();
    expect(el.querySelector('ul, em, strong')).toBeNull();
  });

  it('a rule ends a paragraph, and `- item` is still a list', () => {
    const el = md('text\n---\n- item');
    expect([...el.children].map((c) => c.tagName)).toEqual(['P', 'HR', 'UL']);
  });

  it('~~x~~ is strikethrough, and an escaped one is not', () => {
    expect(html('a ~~gone~~ b')).toBe('a <del>gone</del> b');
    expect(html('\\~~x~~')).toBe('~~x~~');
  });

  it('an ordered list keeps its start number after a nested bullet split', () => {
    const el = md('1. one\n   - sub\n2. two');
    const lists = el.querySelectorAll('ol');
    expect(lists[0]!.getAttribute('start')).toBeNull();
    expect(lists[1]!.getAttribute('start')).toBe('2');
  });

  it('long pipe-heavy input parses in one pass (no quadratic scan)', () => {
    const el = md(`${'a|'.repeat(5000)}\n${'-|'.repeat(5000)}\n${'|'.repeat(20000)}`);
    expect(el.querySelectorAll('thead th')).toHaveLength(5000);
    cleanup();
    expect(md('|'.repeat(20000)).querySelector('table')).toBeNull();
    cleanup();
    expect(md(`- ${' '.repeat(20000)}x`).querySelector('hr')).toBeNull();
  });
});
