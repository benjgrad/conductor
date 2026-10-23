import { describe, expect, it } from 'vitest';
import { M1_BASIC, M1_BASIC_V1, PR_FLOW_FULL } from '../api/mock-data.js';
import {
  buildGraph,
  defaultGate,
  gateAllowed,
  getTransition,
  setGate,
  transitionForPath,
  validateGates,
} from './model.js';

const gate = {
  items: ['Has tests'],
  on_unmet: { goto: 'implement', retries: 2, else: 'needs_input' },
};

describe('setGate', () => {
  it('turns a string transition into {goto, requirements} and back', () => {
    const gated = setGate(M1_BASIC_V1, 'build', 'exit_0', gate);
    expect(getTransition(gated, 'build', 'exit_0')).toEqual({ goto: 'test', requirements: gate });
    // The input is not modified.
    expect(getTransition(M1_BASIC_V1, 'build', 'exit_0')).toBe('test');
    expect(getTransition(setGate(gated, 'build', 'exit_0', null), 'build', 'exit_0')).toBe('test');
  });

  it('keeps the object form when other fields remain', () => {
    const gated = setGate(M1_BASIC_V1, 'build', 'fail', gate);
    expect(getTransition(gated, 'build', 'fail')).toEqual({
      goto: 'implement',
      attach: 'output',
      retries: 3,
      else: 'needs_input',
      requirements: gate,
    });
    expect(getTransition(setGate(gated, 'build', 'fail', null), 'build', 'fail')).toEqual(
      getTransition(M1_BASIC_V1, 'build', 'fail'),
    );
  });

  it('defaults a new gate to the source agent and needs_input', () => {
    expect(defaultGate(M1_BASIC_V1, 'implement').on_unmet).toEqual({
      goto: 'implement',
      retries: 2,
      else: 'needs_input',
    });
    // A command state goes back to the start.
    expect(defaultGate(M1_BASIC_V1, 'build').on_unmet.goto).toBe('implement');
  });
});

describe('gates', () => {
  it('are only allowed out of agent and command states', () => {
    expect(gateAllowed(PR_FLOW_FULL, 'implement')).toBe(true);
    expect(gateAllowed(PR_FLOW_FULL, 'build')).toBe(true);
    expect(gateAllowed(PR_FLOW_FULL, 'await_approval')).toBe(false);
    expect(gateAllowed(PR_FLOW_FULL, 'update_ticket')).toBe(false);
    expect(gateAllowed(PR_FLOW_FULL, 'needs_input')).toBe(false);
  });

  it('validate like ADR-0009', () => {
    expect(validateGates(M1_BASIC)).toEqual([]);
    const bad = setGate(
      setGate(M1_BASIC_V1, 'build', 'exit_0', {
        items: ['ok', '  '],
        on_unmet: { goto: 'nowhere', retries: 11, else: 'build', instruction: ' ' },
      }),
      'test',
      'exit_0',
      { items: [], on_unmet: { goto: 'implement', retries: 2, else: 'missing' } },
    );
    expect(validateGates(bad).map((i) => [i.path, i.message])).toEqual([
      ['states.build.on.exit_0.requirements.items.1', 'requirement 2 is empty'],
      [
        'states.build.on.exit_0.requirements.on_unmet.goto',
        '"go back to" state "nowhere" does not exist',
      ],
      [
        'states.build.on.exit_0.requirements.on_unmet.else',
        '"then" state "build" must be a human state',
      ],
      [
        'states.build.on.exit_0.requirements.on_unmet.retries',
        'retries must be a whole number from 0 to 10',
      ],
      ['states.build.on.exit_0.requirements.on_unmet.instruction', 'the instruction is empty'],
      ['states.test.on.exit_0.requirements.items', 'add at least one requirement'],
      ['states.test.on.exit_0.requirements.on_unmet.else', '"then" state "missing" does not exist'],
    ]);
  });

  it('flag a gate on an event state', () => {
    const def = setGate(PR_FLOW_FULL, 'await_approval', 'ui.approve', gate);
    expect(validateGates(def)).toEqual([
      expect.objectContaining({
        from: 'await_approval',
        outcome: 'ui.approve',
        message: expect.stringContaining('agent and command') as unknown,
      }),
    ]);
  });
});

describe('transitionForPath', () => {
  it('maps server error paths to a transition, outcomes with dots included', () => {
    expect(transitionForPath(M1_BASIC, 'states.build.on.fail.goto')).toEqual({
      from: 'build',
      outcome: 'fail',
    });
    expect(transitionForPath(PR_FLOW_FULL, 'states.await_approval.on.ui.approve')).toEqual({
      from: 'await_approval',
      outcome: 'ui.approve',
    });
    expect(
      transitionForPath(M1_BASIC, 'states.implement.on.done.requirements.on_unmet.else'),
    ).toEqual({ from: 'implement', outcome: 'done' });
    expect(transitionForPath(M1_BASIC, 'start')).toBeNull();
    expect(transitionForPath(M1_BASIC, 'states.build.timeout')).toBeNull();
  });
});

describe('buildGraph', () => {
  it('describes states with UML stereotypes and details', () => {
    const { nodes } = buildGraph(PR_FLOW_FULL);
    const by = (id: string) => nodes.find((n) => n.id === id);
    expect(by('build')).toMatchObject({ stereotype: '«command»', detail: 'npm run build' });
    expect(by('open_pr')).toMatchObject({ stereotype: '«agent»', detail: 'skill: commit-push-pr' });
    expect(by('needs_input')).toMatchObject({ stereotype: '«human»', type: 'human' });
    expect(by('done')).toMatchObject({ kind: 'terminal' });
  });

  it('does not repeat an unmet else that already has an edge', () => {
    const { edges } = buildGraph(M1_BASIC);
    // implement → needs_input exists (ask_user), so no separate unmet-else edge.
    expect(edges.some((e) => e.kind === 'unmet-else')).toBe(false);
    const viaBuild = buildGraph(setGate(M1_BASIC_V1, 'build', 'exit_0', gate));
    expect(viaBuild.edges.filter((e) => e.kind === 'unmet-else')).toEqual([]);
  });
});
