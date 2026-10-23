// @vitest-environment jsdom
import type { WorkflowDefinition } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
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

async function setup() {
  const api = createMockApi();
  const saved: WorkflowDefinition[] = [];
  const save = api.saveWorkflow.bind(api);
  api.saveWorkflow = (def) => {
    saved.push(structuredClone(def));
    return save(def);
  };
  render(<App api={api} />);
  const diagram = await screen.findByRole('group', { name: 'm1_basic v2 state diagram' });
  return { api, saved, diagram };
}

const edge = (name: RegExp) => screen.getByRole('button', { name });
const editor = () => within(screen.getByRole('complementary', { name: 'Transition' }));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('Workflows view', () => {
  it('is reachable from the header nav and lists the workflows', async () => {
    window.location.hash = '';
    render(<App api={createMockApi()} />);
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }));
    const nav = within(await screen.findByRole('navigation', { name: 'Workflows' }));
    expect((await nav.findAllByRole('button')).map((b) => b.textContent)).toEqual([
      'm1_basicv2',
      'pr_flowv2',
    ]);
    await waitFor(() => expect(window.location.hash).toBe('#/workflows/m1_basic'));
    expect(screen.getByRole('link', { name: 'Workflows' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('draws the latest version, with older versions selectable', async () => {
    const { diagram } = await setup();
    expect(diagram.querySelectorAll('[data-badge]')).toHaveLength(1);
    expect(diagram.querySelector('[data-state="needs_input"]')?.getAttribute('class')).toContain(
      'wf-human',
    );
    const select = screen.getByRole('combobox', { name: 'Version' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'v2 (latest)',
      'v1',
    ]);
    type(select, '1');
    const v1 = await screen.findByRole('group', { name: 'm1_basic v1 state diagram' });
    expect(v1.querySelectorAll('[data-badge]')).toHaveLength(0);
  });

  it("uses the server's versions list when it sends one (gaps allowed)", async () => {
    const api = createMockApi();
    const get = api.getWorkflow.bind(api);
    api.getWorkflow = async (id, version) => {
      // `versions` is optional in the contract; spread through a variable so this compiles
      // whether or not the shared schema has the field yet.
      const withVersions = { ...(await get(id, version)), versions: [1, 4] };
      return withVersions;
    };
    render(<App api={api} />);
    await screen.findByRole('group', { name: 'm1_basic v2 state diagram' });
    const select = screen.getByRole('combobox', { name: 'Version' });
    await waitFor(() =>
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
        'v4 (latest)',
        'v1',
      ]),
    );
  });

  it('switches workflow through the URL', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /pr_flow/ }));
    await screen.findByRole('group', { name: 'pr_flow v2 state diagram' });
    expect(window.location.hash).toBe('#/workflows/pr_flow');
  });

  it('opens a transition with Enter, showing route and failure policy', async () => {
    await setup();
    const fail = edge(/^build → implement on fail/);
    expect(fail.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(fail, { key: 'Enter' });
    const panel = editor();
    expect(panel.getByRole('heading', { name: 'build → implement' })).toBeTruthy();
    expect(panel.getByText('⟲ implement ×3, else needs_input')).toBeTruthy();
    expect(fail.getAttribute('aria-pressed')).toBe('true');
  });

  it('adds requirements to a string transition and saves the object form as a new version', async () => {
    const { saved } = await setup();
    fireEvent.click(edge(/^build → test on exit_0/));
    fireEvent.click(editor().getByRole('button', { name: 'Add requirements' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByText(/Running tickets keep the version they started on/)).toBeTruthy();
    type(editor().getByLabelText('Requirement 1'), 'The build has no warnings');
    fireEvent.click(editor().getByRole('button', { name: 'Add requirement' }));
    type(editor().getByLabelText('Requirement 2'), 'Bundle size did not grow');
    fireEvent.click(editor().getByRole('button', { name: 'Move requirement 2 up' }));
    type(editor().getByLabelText('With instruction'), 'Fix the warnings.');
    type(editor().getByLabelText('Up to (times)'), '3');

    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByRole('group', { name: 'm1_basic v3 state diagram' });
    expect(screen.getByRole('status').textContent).toBe('Saved as v3.');
    expect(saved).toHaveLength(1);
    const build = saved[0]!.states.build;
    expect(build?.type === 'command' && build.on?.exit_0).toEqual({
      goto: 'test',
      requirements: {
        items: ['Bundle size did not grow', 'The build has no warnings'],
        on_unmet: {
          goto: 'implement',
          instruction: 'Fix the warnings.',
          retries: 3,
          else: 'needs_input',
        },
      },
    });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Version' }).value).toBe('3');
    // Two gated transitions now.
    expect(document.querySelectorAll('[data-badge]')).toHaveLength(2);
  });

  it('removing requirements turns the transition back into a string', async () => {
    const { saved } = await setup();
    fireEvent.click(edge(/^implement → build on done, gated by 2 requirements/));
    expect(editor().getByLabelText('Requirement 1')).toBeTruthy();
    fireEvent.click(editor().getByRole('button', { name: 'Remove requirements' }));
    expect(editor().getByRole('button', { name: 'Add requirements' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByRole('group', { name: 'm1_basic v3 state diagram' });
    const impl = saved[0]!.states.implement;
    expect(impl?.type === 'agent' && impl.on?.done).toBe('build');
  });

  it('discards the draft', async () => {
    await setup();
    fireEvent.click(edge(/^build → test on exit_0/));
    fireEvent.click(editor().getByRole('button', { name: 'Add requirements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(editor().getByRole('button', { name: 'Add requirements' })).toBeTruthy();
  });

  it('validates on the client and blocks Save', async () => {
    const { saved } = await setup();
    fireEvent.click(edge(/^build → test on exit_0/));
    fireEvent.click(editor().getByRole('button', { name: 'Add requirements' }));
    const save = screen.getByRole('button', { name: 'Save as new version' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(editor().getByText('requirement 1 is empty')).toBeTruthy();
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/requirement 1 is empty/)).toBeTruthy();

    type(editor().getByLabelText('Requirement 1'), 'Something');
    type(editor().getByLabelText('Up to (times)'), '11');
    expect(editor().getByText('retries must be a whole number from 0 to 10')).toBeTruthy();
    type(editor().getByLabelText('Up to (times)'), '2');
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(false);
    // The "then" select only offers human states.
    const then = editor().getByLabelText('Then');
    expect([...then.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['needs_input']);
    expect(saved).toHaveLength(0);
  });

  it('shows server invalid_workflow details on the edge they belong to', async () => {
    const { api } = await setup();
    api.saveWorkflow = () =>
      Promise.reject(
        new ApiRequestError(400, 'invalid_workflow', 'workflow definition is invalid', [
          {
            path: 'states.build.on.exit_0.requirements.on_unmet.goto',
            message: 'rule 4: unbounded loop',
          },
          { path: 'start', message: 'rule 1: something global' },
        ]),
      );
    fireEvent.click(edge(/^build → test on exit_0/));
    fireEvent.click(editor().getByRole('button', { name: 'Add requirements' }));
    type(editor().getByLabelText('Requirement 1'), 'Something');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByText(/workflow definition is invalid/);
    const problems = within(screen.getByRole('list', { name: 'Problems' }));
    expect(problems.getByText(/rule 4: unbounded loop/)).toBeTruthy();
    expect(problems.getByText(/rule 1: something global/)).toBeTruthy();
    expect(editor().getByText('rule 4: unbounded loop')).toBeTruthy();
    expect(edge(/^build → test on exit_0/).getAttribute('class')).toContain('error');
    // Still a draft.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('explains why gates are not offered out of an event state', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /pr_flow/ }));
    await screen.findByRole('group', { name: 'pr_flow v2 state diagram' });
    fireEvent.click(edge(/^await_approval → update_ticket on ui\.approve/));
    expect(
      editor().getByText(/only gate transitions out of agent and command states/),
    ).toBeTruthy();
    expect(editor().queryByRole('button', { name: 'Add requirements' })).toBeNull();
  });
});

describe('unsaved draft guard', () => {
  async function dirty() {
    const ctx = await setup();
    fireEvent.click(edge(/^build → test on exit_0/));
    fireEvent.click(editor().getByRole('button', { name: 'Add requirements' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    return ctx;
  }
  const confirm = () => within(screen.getByRole('alertdialog', { name: 'Unsaved changes' }));

  it('asks before another workflow; Keep editing keeps the draft', async () => {
    await dirty();
    await waitFor(() => expect(window.location.hash).toBe('#/workflows/m1_basic'));
    fireEvent.click(screen.getByRole('button', { name: /pr_flow/ }));
    expect(confirm().getByText('Discard unsaved changes to m1_basic?')).toBeTruthy();
    expect(window.location.hash).toBe('#/workflows/m1_basic');
    fireEvent.click(confirm().getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'm1_basic v2 state diagram' })).toBeTruthy();
    expect(editor().getByLabelText('Requirement 1')).toBeTruthy();
  });

  it('asks before the Board; Discard leaves and drops the draft', async () => {
    await dirty();
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    // The link changed the hash; the guard put it back.
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(window.location.hash).toBe('#/workflows/m1_basic');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(confirm().getByRole('button', { name: 'Discard' }));
    await screen.findByText('Add pagination to /orders');
    expect(window.location.hash).toBe('#/');
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }));
    await screen.findByRole('group', { name: 'm1_basic v2 state diagram' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it("a hash change to another workflow never shows A's draft under B", async () => {
    await dirty();
    window.location.hash = '#/workflows/pr_flow';
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(window.location.hash).toBe('#/workflows/m1_basic');
    expect(screen.getByRole('group', { name: 'm1_basic v2 state diagram' })).toBeTruthy();
    fireEvent.click(confirm().getByRole('button', { name: 'Discard' }));
    await screen.findByRole('group', { name: 'pr_flow v2 state diagram' });
    expect(window.location.hash).toBe('#/workflows/pr_flow');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Transition' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as new version' })).toBeNull();
    // pr_flow's build → test edge is still the plain string transition.
    expect(edge(/^build → test on exit_0$/)).toBeTruthy();
  });

  it('navigates freely when there is no draft', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /pr_flow/ }));
    await screen.findByRole('group', { name: 'pr_flow v2 state diagram' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('session Details diagram', () => {
  it('highlights the current state, read-only', async () => {
    const api = createMockApi();
    const detail = await api.getSession(SEED_IDS.running.session);
    render(<SessionWorkflowDiagram detail={detail} />);
    const svg = screen.getByRole('group', { name: /diagram, current state/ });
    const current = svg.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-state')).toBe(detail.card.workflow_state);
    expect(current[0]!.getAttribute('class')).toContain('current');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
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
