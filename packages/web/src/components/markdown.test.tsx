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
