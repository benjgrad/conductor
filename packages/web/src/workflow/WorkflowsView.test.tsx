// @vitest-environment jsdom
import type { SessionDetail, WorkflowDefinition } from '@conductor/shared';
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

async function setup(api = createMockApi()) {
  const saved: WorkflowDefinition[] = [];
  const save = api.saveWorkflow.bind(api);
  api.saveWorkflow = (def) => {
    saved.push(structuredClone(def));
    return save(def);
  };
  render(<App api={api} />);
  const diagram = await screen.findByRole('group', { name: 'conductor v2 columns' });
  return { api, saved, diagram };
}

const lane = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^Column ${title}:`) });
const editor = () => within(screen.getByRole('complementary', { name: 'Column' }));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const lanesOf = (el: Element) =>
  [...el.querySelectorAll('[data-lane]')].map((n) => n.getAttribute('data-lane'));

describe('Workflow view', () => {
  it('is the "Workflow" nav item and shows only conductor, no workflow list', async () => {
    window.location.hash = '';
    render(<App api={createMockApi()} />);
    fireEvent.click(screen.getByRole('link', { name: 'Workflow' }));
    await screen.findByRole('group', { name: 'conductor v2 columns' });
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
  });

  it('shows each column’s work and requirements summary', async () => {
    const { diagram } = await setup();
    const we = within(diagram.querySelector<HTMLElement>('[data-lane="waiting_external"]')!);
    expect(we.getByText('Waits for ui.approve')).toBeTruthy();
    expect(we.getByText('Requirements to enter')).toBeTruthy();
    expect(we.getByText('✓ Build passes')).toBeTruthy();
    expect(we.getByText('✓ Tests pass')).toBeTruthy();
    expect(we.getByText('◎ 2 review items')).toBeTruthy();
    expect(we.getByText('↗ Opens PR')).toBeTruthy();
    // The work line wraps inside the lane.
    expect(diagram.querySelector('[data-lane="planning"]')?.textContent).toContain(
      'Agent · plan_template ·',
    );
    // The dashed unmet loop back to Implementing.
    const unmet = diagram.querySelector('[data-edge="waiting_external/entry/unmet"]');
    expect(unmet?.getAttribute('class')).toContain('dashed');
  });

  it('keeps the version selector', async () => {
    await setup();
    const select = screen.getByRole('combobox', { name: 'Version' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'v2 (latest)',
      'v1',
    ]);
    type(select, '1');
    const v1 = await screen.findByRole('group', { name: 'conductor v1 columns' });
    expect(within(v1).queryByText('◎ 2 review items')).toBeNull();
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
    type(editor().getByLabelText('Title'), 'Building');
    type(editor().getByLabelText('Prompt template'), 'ticket_template');
    type(editor().getByLabelText('Model'), 'claude-sonnet-4-5');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByRole('group', { name: 'conductor v3 columns' });
    expect(saved[0]!.states.implementing).toMatchObject({
      title: 'Building',
      prompt: 'ticket_template',
      model: 'claude-sonnet-4-5',
    });
  });

  it('adds checks, review items and open_pr, and saves `entry`', async () => {
    const { saved } = await setup();
    // Done: Implementing can't get an entry, since Waiting external's unmet loop goes back to it.
    fireEvent.click(lane('Done'));
    expect(editor().getByText(/None\. A ticket enters Done/)).toBeTruthy();
    fireEvent.click(editor().getByRole('button', { name: 'Add check' }));
    type(editor().getByLabelText('Check 1 name'), 'Lint passes');
    type(editor().getByLabelText('Check 1 command'), 'npm run lint');
    fireEvent.click(editor().getByRole('button', { name: 'Add check' }));
    type(editor().getByLabelText('Check 2 name'), 'Types check');
    type(editor().getByLabelText('Check 2 command'), 'npm run typecheck');
    fireEvent.click(editor().getByRole('button', { name: 'Move check 2 up' }));
    fireEvent.click(editor().getByRole('button', { name: 'Add review item' }));
    type(editor().getByLabelText('Review item 1'), 'The plan is complete');
    fireEvent.click(editor().getByRole('checkbox', { name: 'Open a pull request (by conductor)' }));
    type(editor().getByLabelText('With instruction'), 'Finish the plan first.');
    type(editor().getByLabelText('Up to (times)'), '4');
    const backTo = editor().getByLabelText('Back to');
    // Never Done itself, nor Waiting external (it has its own entry), nor another terminal.
    expect([...backTo.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Planning',
      'Implementing',
      'Needs input',
    ]);
    expect((backTo as HTMLSelectElement).value).toBe('planning');
    type(backTo, 'implementing');
    expect(
      [...editor().getByLabelText('Then').querySelectorAll('option')].map((o) => o.textContent),
    ).toEqual(['Needs input']);

    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByRole('group', { name: 'conductor v3 columns' });
    expect(screen.getByRole('status').textContent).toBe('Saved as v3.');
    expect(saved[0]!.states.done?.entry).toEqual({
      checks: [
        { name: 'Types check', cmd: 'npm run typecheck' },
        { name: 'Lint passes', cmd: 'npm run lint' },
      ],
      review: { items: ['The plan is complete'] },
      actions: ['open_pr'],
      on_unmet: {
        goto: 'implementing',
        instruction: 'Finish the plan first.',
        retries: 4,
        else: 'needs_input',
      },
    });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Version' }).value).toBe('3');
  });

  it('sets up before the checks: auto, none or a custom command', async () => {
    const { saved, diagram } = await setup();
    const we = () => diagram.querySelector('[data-lane="waiting_external"]')!.textContent;
    expect(we()).toContain('⚙ auto setup');
    fireEvent.click(lane('Waiting external'));
    const mode = () => editor().getByLabelText<HTMLSelectElement>(/Before the checks/);
    expect(mode().value).toBe('auto');
    expect(editor().queryByLabelText('Setup command')).toBeNull();
    type(mode(), 'none');
    expect(we()).toContain('⚙ no setup');
    type(mode(), 'custom');
    expect(mode().value).toBe('custom');
    type(editor().getByLabelText('Setup command'), 'pnpm i --frozen-lockfile');
    expect(we()).toContain('⚙ setup: pnpm i');
    // Save sends `setup` (the mock may reject it until the shared field lands; the request is
    // what matters here).
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const entry = saved[0]!.states.waiting_external!.entry as unknown as Record<string, unknown>;
    expect(entry.setup).toBe('pnpm i --frozen-lockfile');
  });

  it('removing every check drops setup and hides the control', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Waiting external'));
    type(editor().getByLabelText(/Before the checks/), 'none');
    fireEvent.click(editor().getByRole('button', { name: 'Remove check 2' }));
    fireEvent.click(editor().getByRole('button', { name: 'Remove check 1' }));
    expect(editor().queryByLabelText(/Before the checks/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect('setup' in saved[0]!.states.waiting_external!.entry!).toBe(false);
  });

  it('removing every requirement removes `entry`', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Waiting external'));
    fireEvent.click(editor().getByRole('button', { name: 'Remove check 2' }));
    fireEvent.click(editor().getByRole('button', { name: 'Remove check 1' }));
    fireEvent.click(editor().getByRole('button', { name: 'Remove review item 2' }));
    fireEvent.click(editor().getByRole('button', { name: 'Remove review item 1' }));
    // open_pr still holds the entry.
    expect(editor().getByLabelText('Back to')).toBeTruthy();
    fireEvent.click(editor().getByRole('checkbox', { name: 'Open a pull request (by conductor)' }));
    expect(editor().queryByLabelText('Back to')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByRole('group', { name: 'conductor v3 columns' });
    expect('entry' in saved[0]!.states.waiting_external!).toBe(false);
  });

  it('"Remove requirements" clears the entry in one go', async () => {
    await setup();
    fireEvent.click(lane('Waiting external'));
    fireEvent.click(editor().getByRole('button', { name: 'Remove requirements' }));
    expect(editor().queryByLabelText('Check 1 name')).toBeNull();
    const we = screen
      .getByRole('group', { name: 'conductor v2 columns' })
      .querySelector('[data-lane="waiting_external"]')!;
    expect(we.textContent).not.toContain('Requirements to enter');
  });

  it('does not offer requirements on the start column, and flags old ones', async () => {
    const api = createMockApi();
    const get = api.getWorkflow.bind(api);
    api.getWorkflow = async (id, version) => {
      const d = await get(id, version);
      const planning = d.definition.states.planning!;
      const entry = d.definition.states.waiting_external!.entry!;
      return {
        ...d,
        definition: {
          ...d.definition,
          states: { ...d.definition.states, planning: { ...planning, entry } },
        },
      };
    };
    await setup(api);
    fireEvent.click(lane('Planning'));
    expect(editor().getByText(/a machine claiming the ticket moves it here/)).toBeTruthy();
    expect(editor().queryByRole('button', { name: 'Add check' })).toBeNull();
    expect(editor().queryByRole('checkbox')).toBeNull();
    expect(editor().getByText(/first column cannot have requirements/)).toBeTruthy();
    fireEvent.click(editor().getByRole('button', { name: 'Remove requirements' }));
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save as new version' }).disabled,
    ).toBe(false);
  });

  it('flags an entry on a column that an unmet loop goes back to', async () => {
    await setup();
    fireEvent.click(lane('Implementing'));
    fireEvent.click(editor().getByRole('checkbox', { name: 'Open a pull request (by conductor)' }));
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/has requirements to enter of its own/)).toBeTruthy();
    expect(lane('Waiting external').getAttribute('class')).toContain('error');
  });

  it('validates on the client and blocks Save', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Done'));
    fireEvent.click(editor().getByRole('button', { name: 'Add check' }));
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save as new version' });
    expect(save.disabled).toBe(true);
    expect(editor().getByText('check 1 needs a name')).toBeTruthy();
    expect(editor().getByText('check 1 needs a command')).toBeTruthy();
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getAllByText(/check 1 needs/)).toHaveLength(2);
    expect(lane('Done').getAttribute('class')).toContain('error');

    type(editor().getByLabelText('Check 1 name'), 'Build');
    type(editor().getByLabelText('Check 1 command'), 'npm run build');
    type(editor().getByLabelText('Up to (times)'), '11');
    expect(editor().getByText('retries must be a whole number from 0 to 10')).toBeTruthy();
    type(editor().getByLabelText('Up to (times)'), '2');
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
    expect(save.disabled).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('shows server details on the column they belong to', async () => {
    const { api } = await setup();
    api.saveWorkflow = () =>
      Promise.reject(
        new ApiRequestError(400, 'invalid_workflow', 'workflow definition is invalid', [
          {
            path: 'states.waiting_external.entry.on_unmet.goto',
            message: 'rule 4: unbounded loop',
          },
          { path: 'start', message: 'rule 1: something global' },
        ]),
      );
    fireEvent.click(lane('Waiting external'));
    type(editor().getByLabelText('Check 1 name'), 'Build OK');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByText(/workflow definition is invalid/);
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/rule 4: unbounded loop/)).toBeTruthy();
    expect(problems.getByText(/rule 1: something global/)).toBeTruthy();
    expect(editor().getByText('rule 4: unbounded loop')).toBeTruthy();
    expect(lane('Waiting external').getAttribute('class')).toContain('error');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
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
    await screen.findByRole('group', { name: 'conductor v2 columns' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('an old workflow URL stays in the view, draft and all', async () => {
    await dirty();
    window.location.hash = '#/workflows/m1_basic';
    await waitFor(() => expect(window.location.hash).toBe('#/workflows/m1_basic'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'conductor v2 columns' })).toBeTruthy();
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
