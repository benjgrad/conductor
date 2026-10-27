import { describe, expect, it } from 'vitest';
import { displayState } from '../workflow/review.js';
import { mockChecking } from '../api/mock-data.js';
import {
  checkNames,
  countLines,
  firstRunError,
  runMarker,
  runName,
  runStatus,
  stripAnsi,
} from './CheckOutput.js';

const workflow = {
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      on: {
        ship: { to: 'done', requires: { checks: [{ name: 'Typecheck', cmd: 'pnpm typecheck' }] } },
        plain: 'done',
      },
    },
    building: { type: 'command', title: 'Build', cmd: 'make' },
    review: { type: 'human', entry: { checks: [{ name: 'Lint', cmd: 'pnpm lint' }] } },
    done: { type: 'terminal' },
  },
} as never;

describe('check output helpers (UX-6)', () => {
  it('strips ANSI colour, cursor and OSC codes, and CRLF', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m TS2339\r\n\x1b]0;title\x07ok\x1b[2K\n')).toBe(
      'error TS2339\nok\n',
    );
  });

  it('counts lines, an unterminated tail included, across segments', () => {
    expect(countLines([])).toBe(0);
    expect(countLines([{ stream: 'stdout', text: 'a\nb\n' }])).toBe(2);
    expect(countLines([{ stream: 'stdout', text: 'a\nb' }])).toBe(2);
    expect(
      countLines([
        { stream: 'stdout', text: 'par' },
        { stream: 'stderr', text: 'tial\nnext\n' },
        { stream: 'stdout', text: '' },
      ]),
    ).toBe(2);
  });

  it('reads the daemon markers verbatim (daemon.ts runCmd), the last one of a debug entry', () => {
    const sha = 'a1b2c3';
    expect(runMarker(`conductor: \`pnpm lint\` in a fresh checkout of ${sha}`)).toEqual({
      cmd: 'pnpm lint',
      setup: false,
    });
    expect(runMarker(`conductor: setup \`npm ci\` in a fresh checkout of ${sha}`)).toEqual({
      cmd: 'npm ci',
      setup: true,
    });
    expect(
      runMarker(
        `x\nconductor: setup \`npm ci\` in a fresh checkout of ${sha}\nconductor: \`b\` in a fresh checkout of ${sha}`,
      ),
    ).toEqual({ cmd: 'b', setup: false });
    expect(runMarker('conductor: run_action open_pr for needs_input')).toBeNull();
  });

  it('names runs by the workflow checks, then setup, the command, the command state', () => {
    const names = checkNames(workflow);
    expect([...names]).toEqual([
      ['pnpm typecheck', 'Typecheck'],
      ['pnpm lint', 'Lint'],
    ]);
    expect(runName({ cmd: 'pnpm typecheck', setup: false }, names)).toBe('Typecheck');
    expect(runName({ cmd: 'npm ci', setup: true }, names)).toBe('Setup: npm ci');
    expect(runName({ cmd: 'make all\nmore', setup: false }, names)).toBe('make all');
    expect(runName(null, names, workflow, 'building')).toBe('Build');
    expect(runName(null, names, workflow, 'implementing')).toBe('Command');
    expect(runName(null, names)).toBe('Command');
  });

  it('FR-3: the first stderr error line, else the last non-empty line', () => {
    expect(
      firstRunError([
        { stream: 'stdout', text: 'error in stdout is not it\n' },
        {
          stream: 'stderr',
          text: ' WARN  deprecated\n\x1b[31msrc/a.ts(1,1): error TS2339\x1b[0m\n',
        },
        { stream: 'stderr', text: 'ERR! later\n' },
      ]),
    ).toBe('src/a.ts(1,1): error TS2339');
    expect(firstRunError([{ stream: 'stdout', text: 'one\nlast one\n\n' }])).toBe('last one');
    expect(firstRunError([{ stream: 'stderr', text: `failed ${'x'.repeat(300)}` }])!.length).toBe(
      200,
    );
    expect(firstRunError([])).toBeNull();
  });

  it('status: live item, failed question, followed, running last, else finished', () => {
    const run = (name: string, followed = false) => ({ name, followed });
    const latest = { latest: true, last: false };
    const checking = mockChecking(2); // Typecheck, Lint passed; Unit tests running
    expect(runStatus(run('Lint'), latest, { checking })).toBe('passed');
    expect(runStatus(run('Unit tests'), latest, { checking })).toBe('running');
    // An older run of the same name is not the item's.
    expect(runStatus(run('Unit tests'), { latest: false, last: false }, { checking })).toBe(
      'finished',
    );
    // A `todo` item with output: an earlier attempt's run.
    expect(runStatus(run('Build passes', true), latest, { checking })).toBe('passed');
    expect(runStatus(run('Build passes'), latest, { failedItem: 'Build passes' })).toBe('failed');
    expect(runStatus(run('Setup: npm ci', true), latest, {})).toBe('passed');
    expect(runStatus(run('Command'), { latest: true, last: true }, { active: true })).toBe(
      'running',
    );
    expect(runStatus(run('Command'), { latest: true, last: true }, {})).toBe('finished');
  });
});

describe('displayState (UX-6 FR-5)', () => {
  const wf = { states: { needs_input: { title: 'Needs input' } } } as never;
  it('never shows a gate step’s synthetic label', () => {
    expect(
      displayState('implementing → needs_input (move: personal_pr_ready_for_review)', wf),
    ).toBe('Checks before Needs input');
    expect(displayState('implementing → waiting_external (entry)')).toBe(
      'Checks before Waiting external',
    );
    expect(displayState('implement → build (review)')).toBe('Reviewing: implement → build');
    expect(displayState('needs_input', wf)).toBe('Needs input');
    expect(displayState('planning', wf)).toBe('planning');
  });
});
