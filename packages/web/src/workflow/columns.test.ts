import { validateWorkflow, type WorkflowDefinition } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR, CONDUCTOR_V1, M1_BASIC } from '../api/mock-data.js';
import {
  buildLaneGraph,
  currentLane,
  entryDraft,
  entryLines,
  entrySummary,
  laneIds,
  normalizeEntry,
  QUEUED_LANE,
  readChecking,
  setEntry,
  stateForPath,
  validateColumns,
  workSummary,
} from './columns.js';
import { layoutLanes } from './columns-layout.js';

const entryOf = (def: WorkflowDefinition, s: string) => def.states[s]!.entry!;

describe('lanes', () => {
  it('are Queued first, then the columns in order', () => {
    expect(laneIds(CONDUCTOR_V1)).toEqual([
      QUEUED_LANE,
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    expect(buildLaneGraph(CONDUCTOR_V1).lanes.map((l) => l.title)).toEqual([
      'Queued',
      'Planning',
      'Implementing',
      'Needs input',
      'Waiting external',
      'Done',
    ]);
  });

  it('keep states that `columns` leaves out, at the end', () => {
    const def = { ...CONDUCTOR_V1, columns: ['implementing', 'planning'] };
    expect(laneIds(def).slice(0, 3)).toEqual([QUEUED_LANE, 'implementing', 'planning']);
    expect(laneIds(def)).toHaveLength(6);
  });

  it('say what does the work', () => {
    const s = CONDUCTOR_V1.states;
    expect(workSummary(null)).toBe('Waiting for a machine');
    expect(workSummary(s.planning!)).toBe('Agent · plan_template · default model');
    expect(workSummary(s.needs_input!)).toBe('A person answers or approves');
    expect(workSummary(s.waiting_external!)).toBe('Waits for ui.approve');
  });

  it('draw merged outcome arrows and the dashed unmet loop', () => {
    const edges = buildLaneGraph(CONDUCTOR_V1).edges;
    const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
    expect(byId.start).toMatchObject({ from: QUEUED_LANE, to: 'planning', dashed: false });
    expect(byId['planning/needs_input']?.label).toBe('ask_user · timeout');
    expect(byId['implementing/waiting_external']?.label).toBe('done');
    expect(byId['waiting_external/entry/unmet']).toMatchObject({
      kind: 'unmet',
      to: 'implementing',
      dashed: true,
      label: 'not met ×3',
    });
  });

  it('lay out left to right without overlapping lanes', () => {
    const layout = layoutLanes(CONDUCTOR);
    const xs = layout.lanes.map((l) => l.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    layout.lanes.slice(1).forEach((l, i) => {
      const prev = layout.lanes[i]!;
      expect(l.x).toBeGreaterThan(prev.x + prev.w);
    });
    // The unmet loop runs below the lanes, the planning → needs_input skip above.
    const side = (id: string) => layout.edges.find((e) => e.edge.id === id)?.side;
    expect(side('waiting_external/entry/unmet')).toBe('below');
    expect(side('planning/needs_input')).toBe('above');
    expect(side('planning/implementing')).toBe('across');
  });
});

describe('requirements summary', () => {
  it('names checks, counts review items and lists actions', () => {
    expect(entrySummary(CONDUCTOR, entryOf(CONDUCTOR, 'waiting_external'))).toEqual({
      checks: ['Build passes', 'Tests pass'],
      reviewItems: 2,
      actions: ['Opens PR'],
      unmet: 'Not met: back to Implementing ×3, then Needs input',
    });
    expect(entryLines(CONDUCTOR_V1, entryOf(CONDUCTOR_V1, 'waiting_external'))).toEqual([
      '✓ Build passes',
      '✓ Tests pass',
      '↗ Opens PR',
      'Not met: back to Implementing ×3, then Needs input',
    ]);
  });
});

describe('editing entry', () => {
  it('a new entry goes back to the agent that moves in, then needs_input', () => {
    expect(entryDraft(CONDUCTOR_V1, 'implementing').on_unmet).toEqual({
      goto: 'planning',
      retries: 2,
      else: 'needs_input',
    });
  });

  it('drops empty lists, and the whole entry when nothing is left', () => {
    const d = entryDraft(CONDUCTOR_V1, 'waiting_external');
    expect(normalizeEntry({ ...d, checks: [] })).toEqual({
      actions: ['open_pr'],
      on_unmet: d.on_unmet,
    });
    expect(normalizeEntry({ ...d, reviewItems: ['x'], reviewModel: ' ' })?.review).toEqual({
      items: ['x'],
    });
    expect(normalizeEntry({ ...d, checks: [], openPr: false })).toBeNull();
    const cleared = setEntry(CONDUCTOR_V1, 'waiting_external', null);
    expect('entry' in cleared.states.waiting_external!).toBe(false);
    // The input is not modified.
    expect(CONDUCTOR_V1.states.waiting_external!.entry).toBeDefined();
  });
});

describe('validateColumns', () => {
  it('passes the shipped conductor workflow', () => {
    expect(validateColumns(CONDUCTOR_V1)).toEqual([]);
    expect(validateColumns(CONDUCTOR)).toEqual([]);
  });

  it('flags bad targets, retries, empty commands and an empty entry', () => {
    const e = entryOf(CONDUCTOR, 'waiting_external');
    let def = setEntry(CONDUCTOR, 'waiting_external', {
      ...e,
      checks: [{ name: 'Build', cmd: ' ' }],
      review: { items: [''] },
      on_unmet: { goto: 'nowhere', retries: 11, else: 'implementing', instruction: ' ' },
    });
    def = setEntry(def, 'implementing', { on_unmet: e.on_unmet });
    expect(validateColumns(def).map((i) => [i.state, i.path, i.message])).toEqual([
      [
        'implementing',
        'states.implementing.entry',
        'add at least one check, review item or action, or remove the requirements',
      ],
      ['waiting_external', 'states.waiting_external.entry.checks.0.cmd', 'check 1 needs a command'],
      [
        'waiting_external',
        'states.waiting_external.entry.review.items.0',
        'review item 1 is empty',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.goto',
        '"back to" column "nowhere" does not exist',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.else',
        '"then" column "Implementing" must be a human column',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.retries',
        'retries must be a whole number from 0 to 10',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.instruction',
        'the instruction is empty',
      ],
    ]);
  });

  it('includes old per-transition gate rules (ADR-0009)', () => {
    const bad = structuredClone(M1_BASIC);
    const impl = bad.states.implement;
    if (impl?.type !== 'agent' || typeof impl.on?.done !== 'object') throw new Error('fixture');
    impl.on.done.requirements!.on_unmet.else = 'build';
    expect(validateColumns(bad).map((i) => i.state)).toEqual(['implement']);
  });

  it('agrees with the shared schema on a valid definition', () => {
    expect(validateWorkflow(CONDUCTOR).ok).toBe(true);
  });
});

describe('paths and sessions', () => {
  it('maps server paths to columns', () => {
    expect(stateForPath(CONDUCTOR, 'states.waiting_external.entry.on_unmet.goto')).toBe(
      'waiting_external',
    );
    expect(stateForPath(CONDUCTOR, 'columns.1')).toBe('implementing');
    expect(stateForPath(CONDUCTOR, 'start')).toBeNull();
  });

  it('finds the current lane and reads `checking` defensively', () => {
    expect(currentLane(CONDUCTOR, null, 'queued')).toBe(QUEUED_LANE);
    expect(currentLane(CONDUCTOR, 'implementing', 'running')).toBe('implementing');
    expect(currentLane(CONDUCTOR, 'build', 'running')).toBeNull();
    expect(readChecking({ checking: { to: 'waiting_external', phase: 'checks' } })).toEqual({
      to: 'waiting_external',
      phase: 'checks',
    });
    expect(readChecking({ checking: { to: 'x' } })).toEqual({ to: 'x', phase: null });
    expect(readChecking({})).toBeNull();
    expect(readChecking({ checking: 'nope' })).toBeNull();
  });
});
