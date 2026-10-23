// @vitest-environment jsdom
import type { OutputChunk, OutputStream } from '@conductor/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './markdown.js';
import {
  buildEntries,
  describeTool,
  diffLines,
  OutputLog,
  parseToolUse,
  resultSummary,
  shortener,
} from './OutputLog.js';

afterEach(cleanup);

const WT = '/tmp/conductor-demo/root/wt/s1';
let seq = 0;
const chunk = (stream: OutputStream, text: string): OutputChunk => ({
  session_id: '00000000-0000-4000-8000-000000000001',
  seq: ++seq,
  stream,
  text,
  ts: '2026-10-23T12:00:00.000Z',
});
const use = (name: string, input: unknown) => chunk('tool_use', `${name} ${JSON.stringify(input)}`);

describe('buildEntries', () => {
  it('pairs each result with the oldest waiting call, including parallel calls', () => {
    const e = buildEntries([
      chunk('assistant', 'Looking.'),
      use('Read', { file_path: `${WT}/a.ts` }),
      use('Read', { file_path: `${WT}/b.ts` }),
      chunk('tool_result', 'A'),
      chunk('tool_result', 'B'),
    ]);
    expect(e.map((x) => x.kind)).toEqual(['text', 'tool', 'tool']);
    expect(e[1]?.kind === 'tool' && e[1].result).toBe('A');
    expect(e[2]?.kind === 'tool' && e[2].result).toBe('B');
  });

  it('merges consecutive command output per stream and consecutive debug lines', () => {
    const e = buildEntries([
      chunk('stdout', 'build '),
      chunk('stdout', 'ok\n'),
      chunk('stderr', 'warn\n'),
      chunk('debug', 'x'),
      chunk('debug', 'y'),
    ]);
    expect(e).toMatchObject([
      { kind: 'stream', stream: 'stdout', text: 'build ok\n' },
      { kind: 'stream', stream: 'stderr', text: 'warn\n' },
      { kind: 'debug', text: 'x\ny' },
    ]);
  });

  it('keeps a call whose input is not JSON (raw shown)', () => {
    expect(parseToolUse('Bash {"command":"ec')).toEqual({
      name: 'Bash',
      input: null,
      raw: '{"command":"ec',
    });
  });
});

describe('describeTool / resultSummary', () => {
  const short = shortener(WT);
  it('labels tools like Claude Code and strips the worktree (with or without /private)', () => {
    expect(
      describeTool(parseToolUse(`Edit {"file_path":"/private${WT}/src/x.ts"}`), short),
    ).toEqual({
      label: 'Update',
      arg: 'src/x.ts',
    });
    expect(
      describeTool(
        parseToolUse(`Bash ${JSON.stringify({ command: `cd ${WT} && npm test` })}`),
        short,
      ),
    ).toEqual({ label: 'Bash', arg: 'cd . && npm test' });
    expect(describeTool(parseToolUse('Grep {"pattern":"foo"}'), short)).toEqual({
      label: 'Search',
      arg: 'pattern: "foo"',
    });
    expect(
      describeTool(parseToolUse('mcp__conductor__complete_state {"result":{}}'), short).label,
    ).toBe('Step complete');
  });

  it('summarises edits by what changed, but shows a refusal as is', () => {
    const write = use('Write', { file_path: `${WT}/a.ts`, content: 'x\ny\nz' });
    const call = parseToolUse(write.text);
    expect(resultSummary(call, `File created successfully at: /private${WT}/a.ts`)).toBe(
      'Wrote 3 lines',
    );
    const edit = parseToolUse(
      `Edit ${JSON.stringify({ file_path: 'f', old_string: 'a\nb', new_string: 'a\nc\nd' })}`,
    );
    expect(resultSummary(edit, 'The file f has been updated successfully.')).toBe(
      'Added 2 lines, removed 1',
    );
    expect(
      resultSummary(call, `PreToolUse:Write hook error: refused /private${WT}/../x`, shortener(WT)),
    ).toBe('PreToolUse:Write hook error: refused ../x');
  });

  it('summarises results', () => {
    const read = parseToolUse('Read {}');
    expect(resultSummary(read, 'a\nb\nc')).toBe('Read 3 lines');
    expect(resultSummary(read, null)).toBe('Running…');
    expect(resultSummary(parseToolUse('Bash {}'), '  ')).toBe('(no output)');
    expect(resultSummary(parseToolUse('Bash {}'), 'first\nsecond\nthird')).toBe(
      'first  … +2 lines',
    );
  });
});

describe('diffLines', () => {
  it('shows changed lines as -/+ with up to two context lines each side', () => {
    expect(
      diffLines({ old: 'a\nb\nc\nOLD\nd\ne\nf', new: 'a\nb\nc\nNEW1\nNEW2\nd\ne\nf' }),
    ).toEqual([
      { sign: ' ', text: 'b' },
      { sign: ' ', text: 'c' },
      { sign: '-', text: 'OLD' },
      { sign: '+', text: 'NEW1' },
      { sign: '+', text: 'NEW2' },
      { sign: ' ', text: 'd' },
      { sign: ' ', text: 'e' },
    ]);
    expect(diffLines({ old: '', new: 'x\ny' })).toEqual([
      { sign: '+', text: 'x' },
      { sign: '+', text: 'y' },
    ]);
  });
});

describe('Markdown', () => {
  it('renders bold, inline code, fenced code, lists and http links only', () => {
    const { container } = render(
      <Markdown
        text={
          'Run **all** the `npm test` [docs](https://example.com) [x](javascript:alert(1))\n\n```ts\nconst a = 1;\n```\n\n- one\n- two'
        }
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('all');
    expect(container.querySelector('p code')?.textContent).toBe('npm test');
    expect(container.querySelector('pre.md-code')?.textContent).toBe('const a = 1;');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com');
  });

  it('never turns text into HTML', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> **<b>hi</b>**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('OutputLog', () => {
  it('shows edits as an open diff, other tools collapsed, and hides debug until asked', () => {
    const output = [
      chunk('assistant', 'Fixing **the** bug.'),
      use('Bash', { command: 'npm test' }),
      chunk('tool_result', 'TAP version 13\nok 1'),
      use('Edit', { file_path: `${WT}/src/x.ts`, old_string: 'a = 1', new_string: 'a = 2' }),
      chunk('tool_result', 'The file has been updated.'),
      chunk('debug', '{"type":"rate_limit_event"}'),
    ];
    const { container } = render(<OutputLog output={output} worktree={WT} />);
    expect(container.querySelector('.msg strong')?.textContent).toBe('the');
    const tools = container.querySelectorAll('details.tool');
    expect(tools).toHaveLength(2);
    expect((tools[0] as HTMLDetailsElement).open).toBe(false);
    expect(tools[0]?.textContent).toContain('Bash(npm test)');
    expect(tools[0]?.textContent).toContain('TAP version 13  … +1 lines');
    expect((tools[1] as HTMLDetailsElement).open).toBe(true);
    expect(tools[1]?.textContent).toContain('Update(src/x.ts)');
    expect(container.querySelector('.diff .del')?.textContent).toBe('- a = 1\n');
    expect(container.querySelector('.diff .add')?.textContent).toBe('+ a = 2\n');

    expect(container.querySelector('.out-debug')).toBeNull();
    fireEvent.click(screen.getByLabelText('Debug lines'));
    expect(container.querySelector('.out-debug')?.textContent).toBe('{"type":"rate_limit_event"}');
  });
});
