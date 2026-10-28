import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPT_MAX_BYTES, TRANSCRIPT_RESULT_CHARS } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStreamLine } from './stream-parser.js';
import {
  claudeProjectSlug,
  findTranscript,
  hasTranscriptInCwd,
  readTranscriptTail,
  realCwd,
  transcriptChunks,
  transcriptPathFor,
} from './transcript.js';

const FIXTURE = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../test/fixtures/transcript.jsonl',
);
const ID = 'f024ace5-2382-4541-a297-6126caa8f4de';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-transcript-')));
  dirs.push(d);
  return d;
};

const line = (o: object) => JSON.stringify(o);

describe('transcriptChunks (ADR-0008)', () => {
  it('maps a real-shaped transcript to the live parser streams, skipping everything else', () => {
    const { chunks, truncated } = transcriptChunks(readFileSync(FIXTURE, 'utf8'));
    expect(truncated).toBe(false);
    expect(chunks.map((c) => [c.stream, c.text])).toEqual([
      ['user', '# Ticket: Add a greeting file\n\nCreate greeting.txt and commit it.'],
      ['tool_use', 'mcp__conductor__ask_user {"question":"Which language?"}'],
      ['tool_result', 'Your question was sent to a human. End your turn now.'],
      ['assistant', "I've asked which language to use."],
      ['user', 'French'],
      ['assistant', 'Writing it now.'],
      [
        'tool_use',
        'Bash {"command":"printf \'Bonjour\\\\n\' > greeting.txt && git commit -qam greeting","description":"Write and commit"}',
      ],
      ['tool_result', '43ff3e0 greeting\nBonjour'],
      ['tool_use', 'mcp__conductor__complete_state {"result":{"summary":"done"}}'],
      ['tool_result', 'Recorded. Stop now.'],
      ['assistant', 'Created greeting.txt and committed it.'],
    ]);
    // ts is the line's own timestamp; a line without one inherits the previous.
    expect(chunks[0]!.ts).toBe('2026-10-22T20:41:01.000Z');
    expect(chunks.at(-1)!.ts).toBe('2026-10-22T20:41:11.000Z');
  });

  it('renders assistant and tool lines exactly like the live stream parser', () => {
    const assistant = line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    const user = line({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }, 7] }] },
    });
    const live = [...parseStreamLine(assistant), ...parseStreamLine(user)].map((p) =>
      p.kind === 'event' && p.event.kind === 'output' ? [p.event.stream, p.event.text] : null,
    );
    const fromTranscript = transcriptChunks(`${assistant}\n${user}\n`).chunks.map((c) => [
      c.stream,
      c.text,
    ]);
    expect(fromTranscript).toEqual(live);
  });

  it('cuts each tool result at TRANSCRIPT_RESULT_CHARS with a marker', () => {
    const big = 'x'.repeat(TRANSCRIPT_RESULT_CHARS + 10);
    const { chunks } = transcriptChunks(
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: big }] } }),
    );
    expect(chunks[0]!.text.startsWith('x'.repeat(TRANSCRIPT_RESULT_CHARS))).toBe(true);
    expect(chunks[0]!.text).toContain('[truncated: 10 more characters]');
  });

  it('keeps the most recent chunks within TRANSCRIPT_MAX_BYTES', () => {
    const text = 'y'.repeat(10_000);
    const lines = Array.from({ length: 400 }, (_, i) =>
      line({ type: 'assistant', message: { content: [{ type: 'text', text: `${i} ${text}` }] } }),
    );
    const { chunks, truncated } = transcriptChunks(lines.join('\n'));
    expect(truncated).toBe(true);
    const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.at(-1)!.text.startsWith('399 ')).toBe(true); // the newest are kept
  });
});

describe('findTranscript', () => {
  it('uses the realpath slug of the cwd, even when the worktree is gone', () => {
    const root = tmp();
    const config = join(root, 'claude');
    const real = join(root, 'real');
    mkdirSync(join(real, 'wt'), { recursive: true });
    symlinkSync(real, join(root, 'link')); // like /tmp → /private/tmp
    const cwd = join(root, 'link', 'wt', 'gone-session'); // never created / removed
    expect(realCwd(cwd)).toBe(join(real, 'wt', 'gone-session'));
    const slug = claudeProjectSlug(join(real, 'wt', 'gone-session'));
    expect(slug).toMatch(/^-.*-real-wt-gone-session$/);
    const file = join(config, 'projects', slug, `${ID}.jsonl`);
    mkdirSync(join(config, 'projects', slug), { recursive: true });
    writeFileSync(file, '');
    expect(findTranscript(config, cwd, ID)).toBe(file);
  });

  it('falls back to the newest project dir holding the id (a resume from another cwd)', () => {
    const config = tmp();
    const older = join(config, 'projects', '-a', `${ID}.jsonl`);
    const newer = join(config, 'projects', '-b', `${ID}.jsonl`);
    for (const f of [older, newer]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, '');
    }
    utimesSync(older, new Date(1000), new Date(1000));
    expect(findTranscript(config, '/nowhere/else', ID)).toBe(newer);
    expect(findTranscript(config, '/nowhere/else', 'c0ffee00-0000-4000-8000-000000000000')).toBe(
      null,
    );
  });

  it('refuses an id that is not a uuid (never a path)', () => {
    const config = tmp();
    mkdirSync(join(config, 'projects', 'x'), { recursive: true });
    writeFileSync(join(config, 'projects', 'x', '..jsonl'), '');
    expect(findTranscript(config, '/w', '../../etc/passwd')).toBeNull();
    expect(findTranscript(config, '/w', '.')).toBeNull();
  });

  it('readTranscriptTail reads a small file whole', () => {
    const d = tmp();
    const f = join(d, 't.jsonl');
    writeFileSync(f, 'a\nb\n');
    expect(readTranscriptTail(f)).toEqual({ text: 'a\nb\n', cut: false });
  });
});

describe('hasTranscriptInCwd (the resume check)', () => {
  it("only the cwd's own project dir counts (claude --resume looks nowhere else)", () => {
    const root = tmp();
    const config = join(root, 'claude');
    const cwd = join(root, 'wt', 's1');
    mkdirSync(cwd, { recursive: true });
    const elsewhere = join(config, 'projects', '-other-cwd', `${ID}.jsonl`);
    mkdirSync(join(elsewhere, '..'), { recursive: true });
    writeFileSync(elsewhere, '');
    expect(findTranscript(config, cwd, ID)).toBe(elsewhere); // history/reopen still find it
    expect(hasTranscriptInCwd(config, cwd, ID)).toBe(false);

    const own = transcriptPathFor(config, cwd, ID)!;
    expect(own).toBe(join(config, 'projects', claudeProjectSlug(realCwd(cwd)), `${ID}.jsonl`));
    mkdirSync(join(own, '..'), { recursive: true });
    writeFileSync(own, '');
    expect(hasTranscriptInCwd(config, cwd, ID)).toBe(true);
  });

  it('refuses an id that is not a uuid', () => {
    expect(transcriptPathFor('/c', '/w', '../../etc/passwd')).toBeNull();
    expect(hasTranscriptInCwd('/c', '/w', 'claude-abc')).toBe(false);
  });
});
