// A small markdown renderer for agent text in the live output: fenced code, headings, lists,
// blockquotes, GFM tables, horizontal rules, paragraphs, and inline code / bold / italic /
// strikethrough / links. It builds React elements
// (never HTML strings), so model output can't inject markup. Links are http(s) only.
import { Fragment, type ReactNode } from 'react';

// Link text is capped at 200 chars: unbounded, a long line of `[`s made the scan quadratic (QA).
// `_` emphasis follows CommonMark's flanking rule for underscores: no letter, digit or `_` right
// before the opening `_` or right after the closing one, so `snake_case` and `1_init.sql` stay
// plain. `*` may be intraword (CommonMark allows it).
// A backslash before ASCII punctuation is a CommonMark escape: the bare character, never markup.
// It is the FIRST branch, and the other branches step over escapes (`\\.`) in their content, so
// the stored `\*x\*` (UX-3's editor escapes typed text) is "*x*", not an `*x\*` italic.
// `***x***` / `___x___` (the editor's bold+italic) come before `**` and `_`, else `**` would
// match inside and leave a stray `*` on each side. `~~x~~` is GFM strikethrough.
const INLINE =
  /(?<esc>\\[!-/:-@[-`{-~])|(?<code>`[^`\n]+`)|(?<both>\*\*\*(?:\\.|[^*\n\\])+?\*\*\*)|(?<strong>\*\*(?:\\.|[^*\n\\])+?\*\*)|(?<del>~~(?:\\.|[^~\n\\])+?~~)|(?<link>\[(?:\\.|[^\]\n\\]){1,200}\]\(https?:\/\/[^)\s]+\))|(?<em>\*(?:\\.|[^*\s\\])(?:\\.|[^*\n\\])*?\*)|(?<uboth>(?<![\p{L}\p{N}_])___(?:\\.|[^_\s\\])(?:\\.|[^_\n\\])*?(?<!\s)___(?![\p{L}\p{N}_]))|(?<uem>(?<![\p{L}\p{N}_])_(?:\\.|[^_\s\\])(?:\\.|[^_\n\\])*?(?<!\s)_(?![\p{L}\p{N}_]))/gu;
const ESCAPED = /\\([!-/:-@[-`{-~])/gu;

/** Removes CommonMark backslash escapes (for text rendered without inline parsing). */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPED, '$1');
}

export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    const g = m.groups!;
    if (g.esc) {
      out.push(tok.slice(1));
    } else if (g.code) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (g.both || g.uboth) {
      out.push(
        <em key={key}>
          <strong>{renderInline(tok.slice(3, -3), key)}</strong>
        </em>,
      );
    } else if (g.strong) {
      out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (g.del) {
      out.push(<del key={key}>{renderInline(tok.slice(2, -2), key)}</del>);
    } else if (g.link) {
      const close = tok.indexOf('](');
      out.push(
        <a key={key} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer noopener">
          {unescapeMarkdown(tok.slice(1, close))}
        </a>,
      );
    } else {
      out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    }
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

type Align = 'left' | 'center' | 'right' | null;

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
// Checked before BULLET: `- - -` and `***` are rules, not a list or emphasis.
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const DELIM_CELL = /^:?-+:?$/;

/**
 * A GFM table row's cells: one outer `|` on each side is dropped, then it splits on every `|`
 * that isn't escaped (`\|`) or inside a backtick span. One linear pass. A backtick with no
 * partner later in the row doesn't open a span, so it can't swallow the rest of the row.
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const lastTick = s.lastIndexOf('`');
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') {
      // Inside code the escape is dropped (GFM); outside, renderInline unescapes it.
      cell += inCode ? '|' : '\\|';
      i++;
    } else if (c === '`' && (inCode || i < lastTick)) {
      inCode = !inCode;
      cell += c;
    } else if (c === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The delimiter row's alignments if `line` is one for a `width`-cell header, else null. */
function delimiterRow(line: string, width: number): Align[] | null {
  if (!line.includes('|') || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (cells.length !== width || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) =>
    c.startsWith(':') && c.endsWith(':')
      ? 'center'
      : c.endsWith(':')
        ? 'right'
        : c.startsWith(':')
          ? 'left'
          : null,
  );
}

/** A table starts at `lines[i]`: a row with a `|`, then a matching delimiter row. */
function tableAt(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  const line = lines[i]!;
  const next = lines[i + 1];
  if (!line.includes('|') || next === undefined) return null;
  const head = splitRow(line);
  const align = delimiterRow(next, head.length);
  return align ? { head, align } : null;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of text while streaming)
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      const width = table.head.length;
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i++]!).slice(0, width);
        while (cells.length < width) cells.push('');
        rows.push(cells);
      }
      blocks.push({ kind: 'table', ...table, rows });
      continue;
    }
    const listRe = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listRe) {
      const ordered = listRe === NUMBERED;
      const start = ordered ? Number(NUMBERED.exec(line)![1]) : 1;
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i]!) && !RULE.test(lines[i]!))
        items.push(listRe.exec(lines[i++]!)!.at(-1)!);
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>'))
        body.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !FENCE.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !NUMBERED.test(lines[i]!) &&
      !RULE.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !tableAt(lines, i)
    ) {
      body.push(lines[i++]!);
    }
    blocks.push({ kind: 'para', text: body.join('\n') });
  }
  return blocks;
}

// Every newline renders as a line break. A CommonMark hard break (`\` at line end, which the
// editor writes for Shift+Enter) drops its backslash; an even run is escaped `\`s, kept as text.
// On the last line a lone `\` is literal (CommonMark: no hard break at the end of a block).
function dropHardBreak(line: string): string {
  const run = /\\+$/.exec(line)?.[0].length ?? 0;
  return run % 2 === 1 ? line.slice(0, -1) : line;
}

function withBreaks(text: string, key: string): ReactNode[] {
  const lines = text.split('\n');
  return lines.map((l, j) => (
    <Fragment key={`${key}-${j}`}>
      {j > 0 && <br />}
      {renderInline(j < lines.length - 1 ? dropHardBreak(l) : l, `${key}-${j}`)}
    </Fragment>
  ));
}

/**
 * `semantic`: headings render as `<h1>`–`<h6>` (a page, e.g. UX-8's help guide). The default
 * styles them as paragraphs, since agent text sits inside a page that has its own outline.
 */
export function Markdown({
  text,
  headings = 'styled',
}: {
  text: string;
  headings?: 'styled' | 'semantic';
}) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, k) => {
        const key = `b${k}`;
        switch (b.kind) {
          case 'code':
            return (
              <pre key={key} className="md-code" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case 'heading':
            if (headings === 'semantic') {
              const Tag = `h${b.level}` as 'h1';
              return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
            }
            return (
              <p key={key} className={`md-h md-h${Math.min(b.level, 3)}`}>
                {renderInline(b.text, key)}
              </p>
            );
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
            ));
            return b.ordered ? (
              <ol key={key} {...(b.start !== 1 ? { start: b.start } : {})}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case 'table': {
            const style = (j: number) => {
              const a = b.align[j];
              return a ? { textAlign: a } : undefined;
            };
            return (
              <div key={key} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={style(j)}>
                          {renderInline(c, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, n) => (
                      <tr key={n}>
                        {r.map((c, j) => (
                          <td key={j} style={style(j)}>
                            {renderInline(c, `${key}-${n}-${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case 'hr':
            return <hr key={key} />;
          case 'quote':
            return <blockquote key={key}>{withBreaks(b.text, key)}</blockquote>;
          case 'para':
            return <p key={key}>{withBreaks(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
