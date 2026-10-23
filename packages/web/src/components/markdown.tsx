// A small markdown renderer for agent text in the live output: fenced code, headings, lists,
// blockquotes, paragraphs, and inline code / bold / italic / links. It builds React elements
// (never HTML strings), so model output can't inject markup. Links are http(s) only.
import { Fragment, type ReactNode } from 'react';

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\*[^*\s][^*\n]*?\*)|(_[^_\s][^_\n]*?_)/g;

export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (m[1]) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (m[3]) {
      const close = tok.indexOf('](');
      out.push(
        <a key={key} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer noopener">
          {tok.slice(1, close)}
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

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split('\n').map((l, j) => (
    <Fragment key={`${key}-${j}`}>
      {j > 0 && <br />}
      {renderInline(l, `${key}-${j}`)}
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
