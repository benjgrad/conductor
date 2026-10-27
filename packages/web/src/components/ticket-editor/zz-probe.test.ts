// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { it } from 'vitest';
it('probe', () => {
  const e = BlockNoteEditor.create();
  const texts = [
    '*x* and _y_ and [n](u) and `c` and \\ back',
    '<machine> and a<b>c',
    '# not heading',
    '- not list',
    '1. not num',
    '> not quote',
    'a | b',
    '**`x`** bold code',
  ];
  e.replaceBlocks(
    e.document,
    texts.map((t) => ({ type: 'paragraph' as const, content: t })),
  );
  console.log('EXPORT:\n' + e.blocksToMarkdownLossy());
  const imp =
    'Continue on <machine> and <app>-ratelimit and \\<esc> and `<code>`\n\n| a | b |\n|---|---|\n| <placeholder> | x |\n\n```\n<keep>\n```\n';
  console.log('IMPORT:', JSON.stringify(e.tryParseMarkdownToBlocks(imp).map((b) => b.content)));
  console.log(
    'IMPORT-ESC:',
    JSON.stringify(
      e.tryParseMarkdownToBlocks('Continue on \\<machine\\> and &lt;x&gt;').map((b) => b.content),
    ),
  );
});
