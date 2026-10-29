// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import {
  SESSION_MOVES_FIXTURE,
  type MoveDto,
  type OutputChunk,
  type OutputStream,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockChecking } from '../api/mock-data.js';
import { Markdown } from './markdown.js';
import {
  buildEntries,
  buildThread,
  describeTool,
  diffLines,
  isFailedResult,
  OutputLog,
  parseToolUse,
  resultSummary,
  shortener,
} from './OutputLog.js';

afterEach(cleanup);

const WT = '/tmp/conductor-demo/root/wt/s1';
let seq = 0;
const chunk = (
  stream: OutputStream,
  text: string,
  ts = '2026-10-23T12:00:00.000Z',
): OutputChunk => ({
  session_id: '00000000-0000-4000-8000-000000000001',
  seq: ++seq,
  stream,
  text,
  ts,
});
const toolUse = (name: string, input: unknown, ts?: string) =>
  chunk('tool_use', `${name} ${JSON.stringify(input)}`, ts);

describe('buildEntries', () => {
  it('pairs each result with the oldest waiting call, including parallel calls', () => {
    const e = buildEntries([
      chunk('assistant', 'Looking.'),
      toolUse('Read', { file_path: `${WT}/a.ts` }),
      toolUse('Read', { file_path: `${WT}/b.ts` }),
      chunk('tool_result', 'A'),
      chunk('tool_result', 'B'),
    ]);
    expect(e.map((x) => x.kind)).toEqual(['text', 'tool', 'tool']);
    expect(e[1]?.kind === 'tool' && e[1].result).toBe('A');
    expect(e[2]?.kind === 'tool' && e[2].result).toBe('B');
  });

  it('a lost result only affects its own batch (TD-085)', () => {
    const e = buildEntries([
      toolUse('Read', { file_path: 'a' }),
      toolUse('Read', { file_path: 'b' }),
      chunk('tool_result', 'A'), // b's result never arrived
      chunk('assistant', 'Next.'),
      toolUse('Bash', { command: 'ls' }),
      chunk('tool_result', 'LS'),
    ]);
    const tools = e.filter((x) => x.kind === 'tool');
    expect(tools.map((t) => t.result)).toEqual(['A', null, 'LS']);
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

  it('strips a Windows worktree written with either separator (MW-T02)', () => {
    const win = shortener('C:\\Users\\b\\.conductor\\wt\\s1\\');
    expect(win('C:\\Users\\b\\.conductor\\wt\\s1\\src\\x.ts')).toBe('src\\x.ts');
    expect(win('C:/Users/b/.conductor/wt/s1/src/x.ts')).toBe('src/x.ts');
    expect(win('cd C:\\Users\\b\\.conductor\\wt\\s1 && npm test')).toBe('cd . && npm test');
    expect(win('C:\\Users\\b\\other\\x.ts')).toBe('C:\\Users\\b\\other\\x.ts');
    expect(win('c:\\Users\\b\\.conductor\\wt\\s1\\x.ts')).toBe('x.ts');
    expect(win('C:\\users\\b\\.conductor\\wt\\s1\\x.ts')).toBe(
      'C:\\users\\b\\.conductor\\wt\\s1\\x.ts',
    );
  });

  it('summarises edits by what changed, but shows a refusal as is', () => {
    const write = toolUse('Write', { file_path: `${WT}/a.ts`, content: 'x\ny\nz' });
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
      toolUse('Bash', { command: 'npm test' }),
      chunk('tool_result', 'TAP version 13\nok 1'),
      toolUse('Edit', { file_path: `${WT}/src/x.ts`, old_string: 'a = 1', new_string: 'a = 2' }),
      chunk('tool_result', 'The file has been updated.'),
      chunk('debug', '{"type":"rate_limit_event"}'),
    ];
    const { container } = render(<OutputLog output={output} worktree={WT} />);
    expect(container.querySelector('.msg strong')?.textContent).toBe('the');
    // Two calls in a row are one group: expand it to see the calls.
    fireEvent.click(screen.getByRole('button', { name: /Ran 1 command · edited 1 file \+1 −1/ }));
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

describe('Markdown underscores (CommonMark intraword rule)', () => {
  it('keeps underscores inside words and file names plain', () => {
    for (const text of ['a_b_c.sql', 'snake_case_name', '1761600000000_accounts-and-auth.sql']) {
      const { container } = render(<Markdown text={text} />);
      expect(container.querySelector('em')).toBeNull();
      expect(container.textContent).toBe(text);
      cleanup();
    }
  });

  it('still italicises _text_ delimited by spaces or punctuation', () => {
    for (const text of ['an _emph_ word', '(_emph_)']) {
      const { container } = render(<Markdown text={text} />);
      expect(container.querySelector('em')?.textContent).toBe('emph');
      cleanup();
    }
  });
});

describe('isFailedResult', () => {
  it('reads failure from the result text', () => {
    expect(isFailedResult('Exit code 1\nboom')).toBe(true);
    expect(isFailedResult('Exit code 0')).toBe(false);
    expect(isFailedResult('<tool_use_error>File has not been read yet</tool_use_error>')).toBe(
      true,
    );
    expect(isFailedResult('PreToolUse:Write hook error: refused ../x')).toBe(true);
    expect(isFailedResult('Error: ENOENT')).toBe(true);
    expect(isFailedResult('all good\nError later')).toBe(false);
    expect(isFailedResult(null)).toBe(false);
  });
});

/** Read a, b, c, Grep, Bash × 2 with results. */
const sixCalls = () => [
  toolUse('Read', { file_path: `${WT}/a.ts` }),
  chunk('tool_result', 'a'),
  toolUse('Read', { file_path: `${WT}/b.ts` }),
  chunk('tool_result', 'b'),
  toolUse('Read', { file_path: `${WT}/c.ts` }),
  chunk('tool_result', 'c'),
  toolUse('Grep', { pattern: 'foo' }),
  chunk('tool_result', 'x.ts'),
  toolUse('Bash', { command: 'ls' }),
  chunk('tool_result', 'a.ts'),
  toolUse('Bash', { command: 'pwd' }),
  chunk('tool_result', '/'),
];

describe('buildThread', () => {
  const kinds = (output: OutputChunk[], moves?: MoveDto[]) =>
    buildThread(buildEntries(output), { moves, group: true }).map((i) =>
      i.kind === 'entry' ? i.entry.kind : i.kind,
    );

  it('keeps a single call as is, and a debug line does not split a run', () => {
    expect(kinds([chunk('assistant', 'a'), toolUse('Read', {}), chunk('assistant', 'b')])).toEqual([
      'text',
      'tool',
      'text',
    ]);
    expect(kinds([toolUse('Read', {}), chunk('debug', '{}'), toolUse('Read', {})])).toEqual([
      'group',
    ]);
  });

  it('splits a run at a phase divider', () => {
    const moves: MoveDto[] = [{ ...SESSION_MOVES_FIXTURE[1]!, at: '2026-10-23T12:05:00.000Z' }];
    expect(
      kinds(
        [
          toolUse('Read', {}, '2026-10-23T12:00:00.000Z'),
          toolUse('Read', {}, '2026-10-23T12:01:00.000Z'),
          toolUse('Read', {}, '2026-10-23T12:06:00.000Z'),
        ],
        moves,
      ),
    ).toEqual(['group', 'phase', 'tool']);
  });

  it('is linear on 20,000 entries', () => {
    const output = Array.from({ length: 20_000 }, (_, i) =>
      i % 5 === 0 ? chunk('assistant', 'x') : toolUse('Read', { file_path: String(i) }),
    );
    const entries = buildEntries(output);
    const t0 = performance.now();
    buildThread(entries, { moves: SESSION_MOVES_FIXTURE, group: true });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('OutputLog tool groups', () => {
  const summaries = (c: HTMLElement) => c.querySelectorAll('button.tool-group-summary');

  it('collapses the calls between two texts into one summary row (FR-1, NFR-3)', () => {
    const { container } = render(
      <OutputLog
        output={[chunk('assistant', 'Looking.'), ...sixCalls(), chunk('assistant', 'Found it.')]}
        worktree={WT}
      />,
    );
    expect(summaries(container)).toHaveLength(1);
    expect(container.querySelector('.tool-group-text')?.textContent).toBe(
      'Read 3 files · searched 1 pattern · ran 2 commands',
    );
    expect(container.querySelectorAll('details.tool')).toHaveLength(0);

    const button = screen.getByRole('button', { name: /Read 3 files/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button); // a native button: Enter and Space click it
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('details.tool')).toHaveLength(6);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('details.tool')).toHaveLength(0);
  });

  it('counts edits with their line totals, or without when the input did not parse (FR-2)', () => {
    const { container } = render(
      <OutputLog
        output={[
          toolUse('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y\nz' }),
          chunk('tool_result', 'The file a.ts has been updated successfully.'),
          toolUse('Edit', { file_path: 'b.ts', old_string: 'p\nq', new_string: 'p' }),
          chunk('tool_result', 'The file b.ts has been updated successfully.'),
          chunk('assistant', 'Now the other two.'),
          chunk('tool_use', 'Edit {"file_pa'),
          chunk('tool_result', 'ok'),
          toolUse('Write', { file_path: 'c.ts', content: 'c' }),
          chunk('tool_result', 'File created successfully at: c.ts'),
        ]}
        worktree={null}
      />,
    );
    const texts = [...container.querySelectorAll('.tool-group-text')].map((e) => e.textContent);
    expect(texts).toEqual(['Edited 2 files +2 −2', 'Edited 2 files']);
  });

  it('never hides a failed call: error marker, and the call is open while collapsed (FR-3)', () => {
    const { container } = render(
      <OutputLog
        output={[
          toolUse('Read', { file_path: 'a' }),
          chunk('tool_result', 'a'),
          toolUse('Bash', { command: 'npm test' }),
          chunk('tool_result', 'Exit code 1\nboom'),
          toolUse('Read', { file_path: 'b' }),
          chunk('tool_result', 'b'),
        ]}
        worktree={null}
      />,
    );
    expect(container.querySelector('.tool-group-error')?.textContent).toBe('⚠ 1 failed');
    const shown = container.querySelectorAll<HTMLDetailsElement>('details.tool');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.textContent).toContain('Bash(npm test)');
    expect(shown[0]?.open).toBe(true);
    expect(shown[0]?.classList.contains('tool-failed')).toBe(true);
  });

  it('never groups ask_user or the human’s messages; they split the runs (FR-4)', () => {
    const { container } = render(
      <OutputLog
        output={[
          toolUse('Read', { file_path: 'a' }),
          toolUse('Read', { file_path: 'b' }),
          toolUse('mcp__conductor__ask_user', { question: 'Which DB?' }),
          chunk('tool_result', 'a'),
          chunk('tool_result', 'b'),
          chunk('tool_result', 'Your question was sent to a human.'),
          toolUse('Read', { file_path: 'c' }),
          toolUse('Read', { file_path: 'd' }),
          chunk('user', 'use Postgres'),
          toolUse('Read', { file_path: 'e' }),
          toolUse('Read', { file_path: 'f' }),
        ]}
        worktree={null}
      />,
    );
    expect(summaries(container)).toHaveLength(3);
    const ask = container.querySelectorAll('details.tool.tool-conductor');
    expect(ask).toHaveLength(1);
    expect(ask[0]?.textContent).toContain('Asked a human(Which DB?)');
    expect(container.querySelector('.user-msg .user-text')?.textContent).toBe('use Postgres');
  });

  it('shows everything ungrouped with Debug lines on (FR-6)', () => {
    const { container } = render(
      <OutputLog
        output={[chunk('assistant', 'Looking.'), ...sixCalls(), chunk('debug', '{"type":"x"}')]}
        worktree={WT}
      />,
    );
    expect(summaries(container)).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Debug lines'));
    expect(summaries(container)).toHaveLength(0);
    expect(container.querySelectorAll('details.tool')).toHaveLength(6);
    expect(container.querySelector('.out-debug')?.textContent).toBe('{"type":"x"}');
  });

  it('renders 2,000 entries quickly, as ~400 summary rows (NFR-4)', () => {
    const output: OutputChunk[] = [];
    for (let i = 0; output.length < 2000; i++) {
      output.push(chunk('assistant', `Step **${i}**.`));
      for (let j = 0; j < 4; j++)
        output.push(toolUse('Read', { file_path: `${WT}/f${i}-${j}.ts` }));
    }
    const t0 = performance.now();
    const { container } = render(<OutputLog output={output} worktree={WT} variant="chat" />);
    const ms = performance.now() - t0;
    expect(summaries(container)).toHaveLength(400);
    expect(container.querySelectorAll('details.tool')).toHaveLength(0);
    // A ceiling, not a benchmark: 2 s flaked under a loaded run (UX-4 lead QA).
    expect(ms).toBeLessThan(10_000);
  });
});

describe('OutputLog phase dividers (FR-5)', () => {
  const output = () => [
    chunk('assistant', 'Planning now.', '2026-10-23T12:00:00.000Z'),
    chunk('assistant', 'The plan is ready.', '2026-10-23T12:05:00.000Z'),
    chunk('assistant', 'Implementing.', '2026-10-23T12:15:00.000Z'),
  ];
  const moves: MoveDto[] = [
    { ...SESSION_MOVES_FIXTURE[0]!, at: '2026-10-23T12:00:00.000Z' },
    {
      ...SESSION_MOVES_FIXTURE[1]!,
      at: '2026-10-23T12:10:00.000Z',
      reason: 'The plan names every file it changes.\nAnd its tests.',
    },
  ];

  it('puts a divider at each move’s time, with the transition and the reason', () => {
    const { container } = render(<OutputLog output={output()} worktree={null} moves={moves} />);
    const rows = [...container.querySelector('.output')!.children].map((el) =>
      el.classList.contains('phase') ? `| ${el.textContent}` : el.textContent,
    );
    expect(rows).toEqual([
      '| Started · Planning',
      'Planning now.',
      'The plan is ready.',
      '| Planning → Implementing · plan_ready — The plan names every file it changes.',
      'Implementing.',
    ]);
    const button = screen.getByRole('button', { name: /Planning → Implementing/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.phase-reason')?.textContent).toBe(
      'The plan names every file it changes.\nAnd its tests.',
    );
  });

  it('uses workflow state titles when given', () => {
    const workflow = { states: { planning: { title: 'Plan it' } } } as never;
    const { container } = render(
      <OutputLog output={output()} worktree={null} moves={moves} workflow={workflow} />,
    );
    expect(container.querySelector('.phase')?.textContent).toBe('Started · Plan it');
  });

  it('has no dividers without moves', () => {
    const { container } = render(<OutputLog output={output()} worktree={null} />);
    expect(container.querySelectorAll('.phase')).toHaveLength(0);
  });
});

describe('check output rows (UX-6)', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const marker = (cmd: string) =>
    chunk('debug', `conductor: \`${cmd}\` in a fresh checkout of ${SHA}`);
  const workflow = {
    states: {
      implementing: {
        type: 'agent',
        on: {
          ship: {
            to: 'needs_input',
            requires: {
              checks: [
                { name: 'Typecheck', cmd: 'pnpm typecheck' },
                { name: 'Lint', cmd: 'pnpm lint' },
              ],
            },
          },
        },
      },
    },
  } as never;
  const twoRuns = () => [
    chunk('assistant', 'Done; handing over.'),
    marker('pnpm typecheck'),
    chunk('stdout', '> tsc -b\n'),
    chunk('stderr', '\x1b[33m WARN\x1b[0m  Failed to create bin\n'),
    chunk('stdout', 'tsc done\n'),
    marker('pnpm lint'),
    chunk('stdout', '> eslint .\nlint-line-2'),
  ];
  const rows = () => screen.getAllByRole('button', { name: /^Check output/ });

  it('FR-1: one collapsed row per run, with name, status and live line count', () => {
    const output = twoRuns();
    const { container, rerender } = render(
      <OutputLog output={output} worktree={null} workflow={workflow} active />,
    );
    expect(rows().map((r) => r.textContent)).toEqual([
      'Check output · Typecheck (passed) · 3 lines▸',
      'Check output · Lint (running) · 2 lines▸',
    ]);
    for (const r of rows()) expect(r.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.check-run-output')).toBeNull();
    expect(screen.queryByText(/tsc done/)).toBeNull();
    expect(screen.queryByText(/eslint/)).toBeNull();
    expect(container.querySelectorAll('[role="log"]')).toHaveLength(1); // the thread's own

    rerender(
      <OutputLog
        output={[...output, chunk('stdout', ' more\nline 3\n')]}
        worktree={null}
        workflow={workflow}
        active
      />,
    );
    expect(rows()[1]!.textContent).toBe('Check output · Lint (running) · 3 lines▸');
    expect(rows()[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('FR-2: expanded at full height in the flow, ANSI stripped, Copy copies it all', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(
      <OutputLog output={twoRuns()} worktree={null} workflow={workflow} />,
    );
    fireEvent.click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    const log = container.querySelector('.check-run-output')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.textContent).toBe('> tsc -b\n WARN  Failed to create bin\ntsc done\n');
    expect(log.textContent).not.toContain('\x1b');
    expect(log.querySelector('.out-stderr')?.textContent).toBe(' WARN  Failed to create bin\n');
    // Still collapsed: the other run.
    expect(screen.queryByText(/eslint/)).toBeNull();

    // No inner scroll box between the log and the thread scroller.
    const thread = container.querySelector('.output')!;
    for (let el: Element | null = log; el && el !== thread; el = el.parentElement) {
      expect(el.classList.contains('term') || el.classList.contains('tool-result')).toBe(false);
      const style = (el as HTMLElement).style;
      expect(style.maxHeight).toBe('');
      expect(style.overflow).toBe('');
      expect(el.tagName).not.toBe('DETAILS');
    }
    // jsdom applies no stylesheets: read the rules themselves (vitest stubs CSS imports).
    const css = readFileSync(`${import.meta.dirname}/OutputLog.css`, 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.check-run[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/max-height/);
      expect(body).not.toMatch(/overflow\s*:\s*(auto|scroll)/);
    }
    expect(css).toMatch(/\.check-run-output \{[^}]*white-space: pre-wrap/);

    fireEvent.click(screen.getByRole('button', { name: 'Copy check output' }));
    expect(writeText).toHaveBeenCalledWith('> tsc -b\n WARN  Failed to create bin\ntsc done\n');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('FR-3: a failed run stays collapsed and shows its first error line', () => {
    const output = [
      marker('pnpm typecheck'),
      chunk('stdout', 'error-looking stdout\n'),
      chunk('stderr', ' WARN  noise\nsrc/a.ts(3,1): error TS2339: nope\nmore\n'),
    ];
    const checking = {
      ...mockChecking(0),
      items: [
        { label: 'Typecheck', kind: 'check' as const, status: 'failed' as const, detail: null },
      ],
    };
    const { container, unmount } = render(
      <OutputLog output={output} worktree={null} workflow={workflow} checking={checking} />,
    );
    const row = rows()[0]!;
    expect(row.textContent).toBe('✗Check output · Typecheck (failed) · 4 lines▸');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.check-run-error')?.textContent).toBe(
      'src/a.ts(3,1): error TS2339: nope',
    );
    expect(container.querySelector('.check-run-output')).toBeNull();
    unmount();

    // From the "Step failed" question instead (the card has left the step).
    render(
      <OutputLog
        output={[marker('pnpm lint'), chunk('stdout', 'a\nlast words\n')]}
        worktree={null}
        workflow={workflow}
        failedItem="Lint"
      />,
    );
    expect(rows()[0]!.textContent).toMatch(/Lint \(failed\)/);
    expect(screen.getByText('last words', { selector: '.check-run-error' })).toBeTruthy();
  });

  it('FR-4: with Debug lines on, everything renders ungrouped as before', () => {
    const { container } = render(
      <OutputLog output={twoRuns()} worktree={null} workflow={workflow} />,
    );
    fireEvent.click(screen.getByLabelText('Debug lines'));
    expect(container.querySelector('.check-run')).toBeNull();
    expect([...container.querySelectorAll('pre.term')].map((p) => p.className)).toEqual([
      'term out-stdout',
      'term out-stderr',
      'term out-stdout',
      'term out-stdout',
    ]);
    expect(container.querySelectorAll('.out-debug')).toHaveLength(2);
  });

  it('a run ends at any other entry or a phase divider; unmarked runs are "Command"', () => {
    const t = buildThread(
      buildEntries([
        chunk('stdout', 'a\n'),
        chunk('debug', '{"type":"x"}'),
        chunk('stderr', 'b\n'),
        toolUse('Read', {}),
        chunk('stdout', 'c\n'),
      ]),
      { group: true },
    );
    expect(t.map((i) => (i.kind === 'run' ? `${i.name}:${i.lines}` : i.kind))).toEqual([
      'Command:2',
      'entry',
      'Command:1',
    ]);
  });

  it('NFR-3: 20,000 lines stay collapsed and cheap', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `output line ${i}`).join('\n') + '\n';
    const output = [
      marker('pnpm typecheck'),
      ...Array.from({ length: 200 }, () => chunk('stdout', lines)),
    ];
    const t0 = performance.now();
    const { container } = render(<OutputLog output={output} worktree={null} workflow={workflow} />);
    const ms = performance.now() - t0;
    expect(rows()[0]!.textContent).toMatch(/· 20,000 lines/);
    expect(container.querySelector('.check-run-output')).toBeNull();
    expect(container.textContent).not.toContain('output line');
    expect(ms).toBeLessThan(1500);
    // Expanded: one text node per stdout/stderr stretch, not 20,000 elements.
    fireEvent.click(rows()[0]!);
    const log = container.querySelector('.check-run-output')!;
    expect(log.children).toHaveLength(1);
    expect(log.textContent).toContain('output line 99\n');
  });
});
