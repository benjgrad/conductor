// @vitest-environment jsdom
import type { SessionDetail, WorkflowDefinition, WorkflowDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { CONDUCTOR, SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { SessionWorkflowDiagram } from './SessionWorkflowDiagram.js';

beforeEach(() => {
  window.location.hash = '#/workflows';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/**
 * The app on the mock, whose conductor v3 is the shipped ADR-0011 conductor. Saves are recorded
 * and stored here as v4, v5… without the mock's validator (the request body is what these tests
 * check).
 */
async function setup(api = createMockApi()) {
  const saved: WorkflowDefinition[] = [];
  const get = api.getWorkflow.bind(api);
  api.saveWorkflow = (def) => {
    saved.push(structuredClone(def));
    return Promise.resolve({ id: def.id, version: 3 + saved.length });
  };
  api.getWorkflow = async (id, version) => {
    const n = version ?? 3 + saved.length;
    if (n > 3) {
      const def = saved[n - 4]!;
      return { id, version: n, definition: { ...def, version: n } } as WorkflowDetail;
    }
    return get(id, version);
  };
  render(<App api={api} />);
  const diagram = await screen.findByRole('group', { name: 'conductor v3 columns' });
  return { api, saved, diagram };
}

const lane = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^Column ${title}:`) });
const arrow = (from: string, to: string) =>
  screen.getByRole('button', { name: new RegExp(`^Arrow ${from} → ${to}:`) });
const editor = () => within(screen.getByRole('complementary', { name: 'Column' }));
const panel = () => within(screen.getByRole('complementary', { name: 'Transition' }));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const lanesOf = (el: Element) =>
  [...el.querySelectorAll('[data-lane]')].map((n) => n.getAttribute('data-lane'));
const saveButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Save as new version' });
const onOf = (def: WorkflowDefinition, s: string) => {
  const st = def.states[s]!;
  if (st.type === 'terminal') throw new Error('terminal');
  return st.on ?? {};
};

describe('Workflow view', () => {
  it('is the "Workflow" nav item and shows only conductor, no workflow list', async () => {
    window.location.hash = '';
    render(<App api={createMockApi()} />);
    fireEvent.click(screen.getByRole('link', { name: 'Workflow' }));
    await screen.findByRole('group', { name: 'conductor v3 columns' });
    expect(screen.queryByRole('navigation', { name: 'Workflows' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Workflow' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('draws lanes in column order with Queued first', async () => {
    const { diagram } = await setup();
    expect(lanesOf(diagram)).toEqual([
      '__queued__',
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    // Queued is implicit: not editable.
    expect(diagram.querySelector('[data-lane="__queued__"]')?.getAttribute('role')).toBeNull();
    expect(lane('Planning').getAttribute('tabindex')).toBe('0');
    // Arrows are buttons too; the claim arrow is not.
    expect(arrow('Planning', 'Implementing').getAttribute('tabindex')).toBe('0');
    expect(diagram.querySelector('[data-edge="start"]')?.getAttribute('role')).toBeNull();
  });

  it('keeps the version selector, and shows an old version’s requirements to enter', async () => {
    await setup();
    const select = screen.getByRole('combobox', { name: 'Version' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'v3 (latest)',
      'v2',
      'v1',
    ]);
    type(select, '2');
    const v2 = await screen.findByRole('group', { name: 'conductor v2 columns' });
    const we = within(v2.querySelector<HTMLElement>('[data-lane="waiting_external"]')!);
    expect(we.getByText('Requirements to enter')).toBeTruthy();
    expect(we.getByText('✓ Build passes')).toBeTruthy();
    expect(we.getByText('◎ 2 review items')).toBeTruthy();
    expect(we.getByText('↗ Opens PR')).toBeTruthy();
    const unmet = v2.querySelector('[data-edge="waiting_external/entry/unmet"]');
    expect(unmet?.getAttribute('class')).toContain('dashed');
  });

  it('shows an empty state when the server has no conductor workflow', async () => {
    const api = createMockApi();
    api.getWorkflow = () =>
      Promise.reject(new ApiRequestError(404, 'not_found', 'workflow conductor not found'));
    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: 'No workflow yet' })).toBeTruthy();
    expect(screen.getByText(/seeds/)).toBeTruthy();
  });

  it('opens a column with Enter and edits title and work', async () => {
    const { saved } = await setup();
    fireEvent.keyDown(lane('Implementing'), { key: 'Enter' });
    expect(editor().getByRole('heading', { name: 'Implementing' })).toBeTruthy();
    expect(lane('Implementing').getAttribute('aria-pressed')).toBe('true');
    // The column panel keeps title and work; requirements live on transitions now.
    expect(editor().queryByRole('button', { name: 'Add check' })).toBeNull();
    type(editor().getByLabelText('Title'), 'Building');
    type(editor().getByLabelText('Prompt template'), 'ticket_template');
    type(editor().getByLabelText('Model'), 'claude-sonnet-4-5');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByRole('group', { name: 'conductor v4 columns' });
    expect(screen.getByRole('status').textContent).toBe('Saved as v4.');
    expect(saved[0]!.states.implementing).toMatchObject({
      title: 'Building',
      prompt: 'ticket_template',
      model: 'claude-sonnet-4-5',
    });
  });

  it('discards the draft', async () => {
    await setup();
    fireEvent.click(lane('Planning'));
    type(editor().getByLabelText('Title'), 'Thinking');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Planning');
  });
});

describe('transition arrows (ADR-0011)', () => {
  it('click an arrow → the panel shows its transitions', async () => {
    await setup();
    fireEvent.click(arrow('Planning', 'Needs input'));
    expect(panel().getByRole('heading', { name: 'Planning → Needs input' })).toBeTruthy();
    expect(arrow('Planning', 'Needs input').getAttribute('aria-pressed')).toBe('true');
    const tabs = within(panel().getByRole('list', { name: 'Transitions on this arrow' }));
    expect(tabs.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'scope_changed',
      'plan_needs_approval',
      'needs_product_context',
      'impossible',
      'ask_user',
      'timeout',
    ]);
    expect(tabs.getByRole('button', { name: 'scope_changed' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('scope_changed');
    expect(
      panel().getByRole<HTMLInputElement>('checkbox', { name: /Asks a question/ }).checked,
    ).toBe(true);
    fireEvent.click(tabs.getByRole('button', { name: 'impossible' }));
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('impossible');
    expect(panel().getByLabelText<HTMLTextAreaElement>('When to take it').value).toBe(
      'The work cannot be done as asked.',
    );
    // The arrow's label and count badge.
    const label = screen
      .getByRole('group', { name: 'conductor v3 columns' })
      .querySelector('.wf-label-outcome .wf-gate');
    expect(label).toBeTruthy();
  });

  it('opens a single transition with Enter, and shows its requirements', async () => {
    await setup();
    fireEvent.keyDown(arrow('Implementing', 'Waiting external'), { key: 'Enter' });
    expect(panel().queryByRole('list', { name: 'Transitions on this arrow' })).toBeNull();
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('ready_for_testing');
    expect(panel().getByLabelText<HTMLInputElement>('Check 1 name').value).toBe('Build passes');
    expect(panel().getByLabelText<HTMLInputElement>('Check 2 command').value).toBe('npm test');
    expect(
      panel().getByRole<HTMLInputElement>('checkbox', {
        name: 'Open a pull request (by conductor)',
      }).checked,
    ).toBe(true);
    expect(panel().getByLabelText<HTMLSelectElement>('Condition 2 type').value).toBe(
      'pr_approvals',
    );
    expect(panel().getByLabelText<HTMLInputElement>('Condition 2 approvals').value).toBe('1');
    expect(panel().getByLabelText<HTMLInputElement>('Wait at most').value).toBe('3d');
    expect(panel().getByLabelText<HTMLSelectElement>('Back to').value).toBe('implementing');
    expect(panel().getByLabelText<HTMLInputElement>('Up to (times)').value).toBe('3');
    expect(panel().getByRole<HTMLInputElement>('checkbox', { name: 'Work' }).checked).toBe(true);
    expect(panel().getByRole<HTMLInputElement>('checkbox', { name: 'Personal' }).checked).toBe(
      false,
    );
  });

  it('edit `when` and kinds, then save → the POSTed definition has them', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    type(panel().getByLabelText('When to take it'), 'The plan is done and approved.');
    // No `kinds` = both; unticking Personal leaves work only.
    fireEvent.click(panel().getByRole('checkbox', { name: 'Personal' }));
    type(panel().getByLabelText('Taken by'), 'agent');
    type(panel().getByLabelText('Title'), 'Ready to build');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(onOf(saved[0]!, 'planning').plan_ready).toEqual({
      goto: 'implementing',
      title: 'Ready to build',
      when: 'The plan is done and approved.',
      kinds: ['work'],
      actor: 'agent',
    });
  });

  it('ticking both kinds again drops `kinds`; none is a problem', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Implementing', 'Waiting external'));
    fireEvent.click(panel().getByRole('checkbox', { name: 'Work' }));
    expect(panel().getByText('pick at least one kind of ticket')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(arrow('Implementing', 'Waiting external').getAttribute('class')).toContain('error');
    fireEvent.click(panel().getByRole('checkbox', { name: 'Work' }));
    fireEvent.click(panel().getByRole('checkbox', { name: 'Personal' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect('kinds' in (onOf(saved[0]!, 'implementing').ready_for_testing as object)).toBe(false);
  });

  it('add a condition with no timeout → the rule-13 error is shown on that arrow', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    fireEvent.click(panel().getByRole('button', { name: 'Add condition' }));
    // The first requirement brings a "when not met" (rule 13 needs one).
    expect(panel().getByLabelText<HTMLSelectElement>('Back to').value).toBe('planning');
    expect(panel().getByLabelText<HTMLSelectElement>('Then').value).toBe('needs_input');
    expect(panel().getByText('conditions need a timeout (how long to wait for them)')).toBeTruthy();
    expect(arrow('Planning', 'Implementing').getAttribute('class')).toContain('error');
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/Planning · plan_ready/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    type(panel().getByLabelText('Wait at most'), '1d');
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
    type(panel().getByLabelText('Condition 1 type'), 'pr_approvals');
    type(panel().getByLabelText('Condition 1 approvals'), '2');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(onOf(saved[0]!, 'planning').plan_ready).toMatchObject({
      requires: { conditions: [{ type: 'pr_approvals', min: 2 }], condition_timeout: '1d' },
      on_unmet: { goto: 'planning', retries: 3, else: 'needs_input' },
    });
  });

  it('maps a server error path (`states.<s>.on.<name>…`) to its arrow', async () => {
    const { api } = await setup();
    api.saveWorkflow = () =>
      Promise.reject(
        new ApiRequestError(400, 'invalid_workflow', 'workflow definition is invalid', [
          {
            path: 'states.implementing.on.ready_for_testing.requires.condition_timeout',
            message: 'rule 13: conditions need condition_timeout',
          },
          { path: 'start', message: 'rule 1: something global' },
        ]),
      );
    fireEvent.click(lane('Planning'));
    type(editor().getByLabelText('Title'), 'Thinking');
    fireEvent.click(saveButton());
    await screen.findByText(/workflow definition is invalid/);
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/rule 1: something global/)).toBeTruthy();
    expect(arrow('Implementing', 'Waiting external').getAttribute('class')).toContain('error');
    expect(lane('Implementing').getAttribute('class')).not.toContain('error');
    // "Show" opens the transition, with the message next to its field.
    const row = problems.getByText(/rule 13/).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Show' }));
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('ready_for_testing');
    expect(panel().getByText('rule 13: conditions need condition_timeout')).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('edits checks, setup, review items and actions on a transition', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Implementing', 'Done'));
    fireEvent.click(panel().getByRole('button', { name: 'Remove check 1' }));
    fireEvent.click(panel().getByRole('button', { name: 'Add check' }));
    type(panel().getByLabelText('Check 2 name'), 'Lint passes');
    type(panel().getByLabelText('Check 2 command'), 'npm run lint');
    type(panel().getByLabelText('Check 2 timeout'), '5m');
    fireEvent.click(panel().getByRole('button', { name: 'Move check 2 up' }));
    type(panel().getByLabelText(/Before the checks/), 'custom');
    type(panel().getByLabelText('Setup command'), 'pnpm i --frozen-lockfile');
    fireEvent.click(panel().getByRole('button', { name: 'Add review item' }));
    type(panel().getByLabelText('Review item 1'), 'The change matches the ticket');
    fireEvent.click(panel().getByRole('checkbox', { name: 'Open a pull request (by conductor)' }));
    type(panel().getByLabelText('With instruction'), 'Fix it.');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(onOf(saved[0]!, 'implementing').done).toMatchObject({
      goto: 'done',
      kinds: ['personal'],
      requires: {
        checks: [
          { name: 'Lint passes', cmd: 'npm run lint', timeout: '5m' },
          { name: 'Tests pass', cmd: 'npm test', timeout: '10m' },
        ],
        setup: 'pnpm i --frozen-lockfile',
        review: { items: ['The change matches the ticket'] },
      },
      on_unmet: { goto: 'implementing', instruction: 'Fix it.', retries: 3 },
    });
    expect(
      (onOf(saved[0]!, 'implementing').done as { requires: { actions?: unknown } }).requires
        .actions,
    ).toBeUndefined();
  });

  it('renames a transition (unique per column), keeping the panel on it', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    const name = () => panel().getByLabelText<HTMLInputElement>('Name');
    type(name(), 'impossible');
    expect(panel().getByText('this column already has a transition "impossible"')).toBeTruthy();
    type(name(), 'plan done');
    expect(panel().getByText(/without spaces/)).toBeTruthy();
    type(name(), 'plan_done');
    expect(name().value).toBe('plan_done');
    expect(panel().queryByRole('alert')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    const names = Object.keys(onOf(saved[0]!, 'planning'));
    expect(names[0]).toBe('plan_done');
    expect(names).not.toContain('plan_ready');
  });

  it('adds a transition from a column’s panel, retargets it and removes it', async () => {
    await setup();
    fireEvent.click(lane('Needs input'));
    const list = within(editor().getByRole('list', { name: 'Transitions' }));
    // `answer` goes back to the column that asked: no arrow, but listed and editable here.
    fireEvent.click(list.getByRole('button', { name: /answer/ }));
    expect(panel().getByLabelText<HTMLSelectElement>('Goes to').value).toBe('$return_to');
    fireEvent.click(lane('Planning'));
    fireEvent.click(editor().getByRole('button', { name: 'Add transition' }));
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('new_transition');
    expect(panel().getByRole('heading', { name: 'Planning → Implementing' })).toBeTruthy();
    type(panel().getByLabelText('Goes to'), 'done');
    expect(panel().getByRole('heading', { name: 'Planning → Done' })).toBeTruthy();
    expect(arrow('Planning', 'Done').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(panel().getByRole('button', { name: 'Remove transition' }));
    expect(editor().getByRole('heading', { name: 'Planning' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Arrow Planning → Done:/ })).toBeNull();
  });
});

describe('old versions (ADR-0010 entry)', () => {
  async function v1() {
    const ctx = await setup();
    type(screen.getByRole('combobox', { name: 'Version' }), '1');
    await screen.findByRole('group', { name: 'conductor v1 columns' });
    return ctx;
  }

  it('a v1 definition saves with entry folded onto implementing.on.done', async () => {
    const { saved } = await v1();
    fireEvent.click(lane('Waiting external'));
    expect(editor().getByText('Saved as transition requirements')).toBeTruthy();
    expect(editor().getByText(/Implementing: done/)).toBeTruthy();
    fireEvent.click(arrow('Implementing', 'Waiting external'));
    expect(panel().getByText(/saving moves them onto this transition/)).toBeTruthy();
    fireEvent.click(lane('Planning'));
    type(editor().getByLabelText('Title'), 'Thinking');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    const def = saved[0]!;
    expect('entry' in def.states.waiting_external!).toBe(false);
    expect(onOf(def, 'implementing').done).toEqual({
      goto: 'waiting_external',
      requires: {
        checks: [
          { name: 'Build passes', cmd: 'npm run build' },
          { name: 'Tests pass', cmd: 'npm test' },
        ],
        actions: ['open_pr'],
      },
      on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
    });
    // The fallbacks never take requirements.
    expect(onOf(def, 'implementing').ask_user).toBe('needs_input');
  });

  it('"Move them to the transitions now" folds in the draft', async () => {
    await v1();
    const v1Diagram = screen.getByRole('group', { name: 'conductor v1 columns' });
    fireEvent.click(lane('Waiting external'));
    fireEvent.click(editor().getByRole('button', { name: 'Move them to the transitions now' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(editor().queryByText('Saved as transition requirements')).toBeNull();
    const we = v1Diagram.querySelector('[data-lane="waiting_external"]')!;
    expect(we.textContent).not.toContain('Requirements to enter');
    expect(arrow('Implementing', 'Waiting external').getAttribute('class')).toContain('gated');
  });
});

describe('unsaved draft guard', () => {
  async function dirty() {
    const ctx = await setup();
    fireEvent.click(lane('Planning'));
    type(editor().getByLabelText('Title'), 'Thinking');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    return ctx;
  }
  const confirm = () => within(screen.getByRole('alertdialog', { name: 'Unsaved changes' }));

  it('asks before the Board; Keep editing keeps the draft', async () => {
    await dirty();
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(confirm().getByText('Discard unsaved changes to the workflow?')).toBeTruthy();
    expect(window.location.hash).toBe('#/workflows');
    fireEvent.click(confirm().getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('Discard leaves and drops the draft', async () => {
    await dirty();
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(confirm().getByRole('button', { name: 'Discard' }));
    await screen.findByText('Add pagination to /orders');
    expect(window.location.hash).toBe('#/');
    fireEvent.click(screen.getByRole('link', { name: 'Workflow' }));
    await screen.findByRole('group', { name: 'conductor v3 columns' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('an old workflow URL stays in the view, draft and all', async () => {
    await dirty();
    window.location.hash = '#/workflows/m1_basic';
    await waitFor(() => expect(window.location.hash).toBe('#/workflows/m1_basic'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'conductor v3 columns' })).toBeTruthy();
  });
});

describe('session Details diagram', () => {
  async function conductorSession(
    state: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<SessionDetail> {
    const detail = await createMockApi().getSession(SEED_IDS.running.session);
    return {
      ...detail,
      workflow: CONDUCTOR,
      workflow_version: 2,
      card: { ...detail.card, workflow_id: 'conductor', workflow_state: state, ...extra },
    };
  }

  it('highlights the current column, read-only', async () => {
    render(<SessionWorkflowDiagram detail={await conductorSession('implementing')} />);
    const svg = screen.getByRole('group', {
      name: 'conductor v2 columns, current column Implementing',
    });
    const current = svg.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-lane')).toBe('implementing');
    expect(current[0]!.getAttribute('class')).toContain('current');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows "checking requirements" on the move being checked', async () => {
    const detail = await conductorSession('implementing', {
      checking: { to: 'waiting_external', phase: 'checks' },
    });
    render(<SessionWorkflowDiagram detail={detail} />);
    const svg = screen.getByRole('group', {
      name: /current column Implementing, checking requirements to enter Waiting external$/,
    });
    const target = svg.querySelector('[data-lane="waiting_external"]')!;
    expect(target.getAttribute('class')).toContain('checking');
    expect(target.textContent).toContain('checking requirements to enter (checks)');
    const move = svg.querySelector('[data-edge="implementing/waiting_external"]')!;
    expect(move.getAttribute('class')).toContain('reviewing');
    expect(move.getAttribute('aria-current')).toBe('step');
  });

  it('draws an old workflow as the state diagram', async () => {
    const api = createMockApi();
    const detail = await api.getSession(SEED_IDS.running.session);
    render(<SessionWorkflowDiagram detail={detail} />);
    const svg = screen.getByRole('group', { name: /m1_basic v2 diagram, current state/ });
    expect(svg.querySelector(`[data-state="${detail.card.workflow_state}"]`)).toBeTruthy();
  });

  it('is in the Details tab of the session panel', async () => {
    window.location.hash = '';
    render(<App api={createMockApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add pagination to /orders' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    await waitFor(() =>
      expect(panel.getByRole('group', { name: /m1_basic v2 diagram, current state/ })).toBeTruthy(),
    );
  });
});
