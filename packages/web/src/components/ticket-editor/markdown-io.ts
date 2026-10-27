// Markdown in and out of the BlockNote editor. BlockNote's export is GFM via remark; it writes
// `*` bullets and pads table cells to a common width. tidyMarkdown turns that back into the
// house style (`-` bullets, `| a | b |` rows) so the plain view and stored body stay readable.
const FENCE = /^\s*```/;

export function tidyMarkdown(md: string): string {
  let fenced = false;
  const out = md.split('\n').map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      return line
        .trim()
        .replace(/ {2,}\|/g, ' |')
        .replace(/\| -{3,} /g, '| --- ');
    }
    return line.replace(/^(\s*)\* /, '$1- ');
  });
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/** The editor's whole document as house-style markdown. */
export function editorMarkdown(editor: { blocksToMarkdownLossy(): string }): string {
  return tidyMarkdown(editor.blocksToMarkdownLossy());
}

/**
 * Whitespace- and marker-insensitive form for comparing two markdown texts: list markers,
 * emphasis markers, escapes, blank lines and table cell padding don't count.
 */
export function normaliseMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/\\([~*_[\]#|.\-!>+])/g, '$1')
        .replace(/^(\s*)[*+] /, '$1- ')
        .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1*$2*')
        .replace(/\s*\|\s*/g, '|')
        .replace(/^\|(?::?-+:?\|)+$/, '|---|')
        .trimEnd(),
    )
    .filter((line) => line.trim() !== '')
    .join('\n');
}
