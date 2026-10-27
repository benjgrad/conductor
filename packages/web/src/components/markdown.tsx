// A small markdown renderer for agent text in the live output: fenced code, headings, lists,
// blockquotes, paragraphs, and inline code / bold / italic / links. It builds React elements
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
// match inside and leave a stray `*` on each side.
const INLINE =
  /(?<esc>\\[!-/:-@[-`{-~])|(?<code>`[^`\n]+`)|(?<both>\*\*\*(?:\\.|[^*\n\\])+?\*\*\*)|(?<strong>\*\*(?:\\.|[^*\n\\])+?\*\*)|(?<link>\[(?:\\.|[^\]\n\\]){1,200}\]\(https?:\/\/[^)\s]+\))|(?<em>\*(?:\\.|[^*\s\\])(?:\\.|[^*\n\\])*?\*)|(?<uboth>(?<![\p{L}\p{N}_])___(?:\\.|[^_\s\\])(?:\\.|[^_\n\\])*?(?<!\s)___(?![\p{L}\p{N}_]))|(?<uem>(?<![\p{L}\p{N}_])_(?:\\.|[^_\s\\])(?:\\.|[^_\n\\])*?(?<!\s)_(?![\p{L}\p{N}_]))/gu;
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
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

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
    const listRe = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listRe) {
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i]!)) items.push(listRe.exec(lines[i++]!)![1]!);
      blocks.push({ kind: 'list', ordered: listRe === NUMBERED, items });
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
      !lines[i]!.startsWith('>')
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

export function Markdown({ text }: { text: string }) {
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
            return (
              <p key={key} className={`md-h md-h${Math.min(b.level, 3)}`}>
                {renderInline(b.text, key)}
              </p>
            );
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
            ));
            return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case 'quote':
            return <blockquote key={key}>{withBreaks(b.text, key)}</blockquote>;
          case 'para':
            return <p key={key}>{withBreaks(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
