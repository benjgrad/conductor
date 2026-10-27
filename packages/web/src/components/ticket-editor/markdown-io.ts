// Markdown in and out of the BlockNote editor (UX-3). BlockNote 0.56 has its own markdown parser
// and exporter, and both need help to keep "what you see is what's stored":
// - Import: it reads any tag-shaped `<word>` outside code as inline HTML and drops it, and it
//   has no `\<` escape. protectAngles swaps every such `<` for a private-use sentinel before
//   parsing; restoreAngles puts `<` back in the parsed blocks. It also keeps the space after a
//   soft or hard line break ("a\n b"), which the editor shows as an indent; dropBreakIndent
//   removes it (CommonMark ignores a continuation line's leading whitespace).
// - Export: it writes text runs verbatim, so typed `*x*` or `[n](u)` would come back as markup.
//   escapeBlocks backslash-escapes markdown-significant characters in plain text runs first.
// - Style: it writes `*` bullets and pads table cells; tidyMarkdown restores the house style.
// Known loss (TD-122): bold/italic around inline code is dropped (BlockNote's code mark
// excludes other marks).

const FENCE = /^\s*(`{3,}|~{3,})/;
const LT = '';

// ─── import ─────────────────────────────────────────────────────────────────

const AUTOLINK = /^<(?:https?:\/\/|mailto:)[^\s<>]*>/;

function protectLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      const run = /^`+/.exec(line.slice(i))![0];
      const close = line.indexOf(run, i + run.length);
      if (close !== -1) {
        out += line.slice(i, close + run.length).replaceAll('<', LT);
        i = close + run.length;
        continue;
      }
      out += run;
      i += run.length;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      // `\<` is a literal `<` (CommonMark); other escapes are BlockNote's to handle.
      out += line[i + 1] === '<' ? LT : line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '<') {
      const auto = AUTOLINK.exec(line.slice(i));
      if (auto) {
        out += auto[0];
        i += auto[0].length;
        continue;
      }
      out += LT;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Markdown with every literal `<` (outside autolinks) replaced by the sentinel. */
export function protectAngles(md: string): string {
  let fence: string | null = null;
  return md
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
        return line.replaceAll('<', LT);
      }
      if (f) {
        fence = f;
        return line;
      }
      return protectLine(line);
    })
    .join('\n');
}

/** Deep copy of parsed blocks with the sentinel turned back into `<`. */
export function restoreAngles<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll(LT, '<') as T;
  if (Array.isArray(value)) return value.map(restoreAngles) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreAngles(v)])) as T;
  }
  return value;
}

// ─── export ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const ALNUM = /[\p{L}\p{N}]/u;

/** Escapes one plain text run. `atStart`: the run opens its block, so line-start syntax counts. */
export function escapeText(text: string, atStart: boolean): string {
  let s = text.replace(/[\\`*[\]<]|~~|_/g, (m, i: number) => {
    if (m === '~~') return '\\~\\~';
    // snake_case stays readable: intraword `_` never means emphasis.
    if (m === '_' && ALNUM.test(text[i - 1] ?? '') && ALNUM.test(text[i + 1] ?? '')) return m;
    return `\\${m}`;
  });
  if (atStart) {
    s = s
      .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*)([-+])(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*)(\d+)([.)])(?=\s|$)/, '$1$2\\$3')
      .replace(/^(\s*)>/, '$1\\>');
  }
  return s;
}

type TextFn = (text: string, atStart: boolean) => string;

function mapInline(content: unknown[], atStart: boolean, fn: TextFn): unknown[] {
  return content.map((item, idx) => {
    if (!isObj(item)) return item;
    const first = atStart && idx === 0;
    if (item.type === 'text' && typeof item.text === 'string') {
      const code = isObj(item.styles) && item.styles.code === true;
      return code ? item : { ...item, text: fn(item.text, first) };
    }
    if (item.type === 'link' && Array.isArray(item.content)) {
      return { ...item, content: mapInline(item.content, first, fn) };
    }
    return item;
  });
}

function mapCell(cell: unknown, fn: TextFn): unknown {
  if (Array.isArray(cell)) return mapInline(cell, false, fn);
  if (isObj(cell) && Array.isArray(cell.content)) {
    return { ...cell, content: mapInline(cell.content, false, fn) };
  }
  return cell;
}

function mapBlock(block: unknown, fn: TextFn): unknown {
  if (!isObj(block)) return block;
  const out: Json = { ...block };
  const content = block.content;
  if (block.type !== 'codeBlock' && Array.isArray(content)) {
    out.content = mapInline(content, true, fn);
  } else if (isObj(content) && content.type === 'tableContent' && Array.isArray(content.rows)) {
    out.content = {
      ...content,
      rows: content.rows.map((row: unknown) =>
        isObj(row) && Array.isArray(row.cells)
          ? { ...row, cells: row.cells.map((c: unknown) => mapCell(c, fn)) }
          : row,
      ),
    };
  }
  if (Array.isArray(block.children)) out.children = block.children.map((b) => mapBlock(b, fn));
  return out;
}

/** Copies of the blocks with `fn` applied to every plain text run (never code). */
function mapTextRuns<B>(blocks: B[], fn: TextFn): B[] {
  return blocks.map((b) => mapBlock(b, fn)) as B[];
}

/** Copies of the blocks whose plain text runs are escaped for BlockNote's verbatim exporter. */
export function escapeBlocks<B>(blocks: B[]): B[] {
  return mapTextRuns(blocks, escapeText);
}

/** Copies of the blocks without the indent BlockNote's parser leaves after a line break. */
export function dropBreakIndent<B>(blocks: B[]): B[] {
  return mapTextRuns(blocks, (text) => text.replace(/\n[ \t]+/g, '\n'));
}

// ─── house style ────────────────────────────────────────────────────────────

export function tidyMarkdown(md: string): string {
  let fence: string | null = null;
  const out: string[] = [];
  let blank = 0;
  for (const line of md.split('\n')) {
    const f = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f;
      blank = 0;
      out.push(line);
      continue;
    }
    // Runs of blank lines collapse to one, but only outside code fences.
    if (line.trim() === '') {
      if (blank++ === 0) out.push(line);
      continue;
    }
    blank = 0;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      out.push(
        line
          .trim()
          .replace(/ {2,}\|/g, ' |')
          .replace(/\| -{3,} /g, '| --- '),
      );
      continue;
    }
    out.push(line.replace(/^(\s*)\* /, '$1- '));
  }
  return out.join('\n').trimEnd() + '\n';
}

// ─── editor glue ────────────────────────────────────────────────────────────

/** The subset of BlockNoteEditor used here (keeps this module free of BlockNote imports). */
export interface MarkdownEditor<B> {
  document: B[];
  tryParseMarkdownToBlocks(markdown: string): B[];
  blocksToMarkdownLossy(blocks: B[]): string;
}

/** Markdown → blocks, keeping literal `<…>` text. */
export function importMarkdown<B>(editor: MarkdownEditor<B>, md: string): B[] {
  return dropBreakIndent(restoreAngles(editor.tryParseMarkdownToBlocks(protectAngles(md))));
}

/** The editor's whole document as escaped, house-style markdown. */
export function editorMarkdown<B>(editor: MarkdownEditor<B>): string {
  return tidyMarkdown(editor.blocksToMarkdownLossy(escapeBlocks(editor.document)));
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
        .replace(/\\([~*_[\]#|.\-!>+<`\\])/g, '$1')
        .replace(/^(\s*)[*+] /, '$1- ')
        .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1*$2*')
        .replace(/\s*\|\s*/g, '|')
        .replace(/^\|(?::?-+:?\|)+$/, '|---|')
        .trimEnd(),
    )
    .filter((line) => line.trim() !== '')
    .join('\n');
}
