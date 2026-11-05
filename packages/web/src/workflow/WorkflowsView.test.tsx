// @vitest-environment jsdom
import {
  CONDUCTOR_V2_DEF,
  type SessionDetail,
  type WorkflowDefinition,
  type WorkflowDetail,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { CONDUCTOR, SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { SessionWorkflowDiagram } from './SessionWorkflowDiagram.js';
import { WorkflowsView } from './WorkflowsView.js';

beforeEach(() => {
  window.location.hash = '#/workflows';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/**
 * The view on the mock, whose conductor v3 is the shipped ADR-0011 conductor. Saves are recorded
 * and stored here as v4, v5… without the mock's validator (the request body is what these tests
 * check). `app: true` mounts the whole <App> (nav links, the draft guard); otherwise just the view,
 * which is ~10× cheaper per test (M2-T33).
 */
// The diagram appears once the mock API resolves; on a loaded machine running the full suite that
// can take longer than findBy's 1 s default.
const DIAGRAM_WAIT = { timeout: 10_000 };

async function setup(api = createMockApi(), { app = false } = {}) {
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
  render(app ? <App api={api} /> : <WorkflowsView api={api} />);
  const diagram = await screen.findByRole('group', { name: 'conductor v3 columns' }, DIAGRAM_WAIT);
  return { api, saved, diagram };
}

const lane = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^Column ${title}:`) });
const arrow = (from: string, to: string) =>
  screen.getByRole('button', { name: new RegExp(`^Arrow ${from} → ${to}:`) });
const editor = () => within(screen.getByRole('complementary', { name: 'Column' }));
const panel = () => within(screen.getByRole('complementary', { name: 'Transition' }));
const arrowPanel = () => within(screen.getByRole('complementary', { name: 'Arrow' }));
/** The open panel's breadcrumb (UXR-66), as its crumbs' text. */
const crumbs = () =>
  within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent)
    .filter((t) => t !== '›');
/** A transition row in a list, by its title (and optionally its meta line). */
const rowsOf = (list: HTMLElement) =>
  within(list)
    .getAllByRole('button')
    .map((b) => b.textContent);
/** A transition editor section's header button (UXR-63), by the start of its name. */
const sectionHead = (start: string) =>
  panel().getByRole('button', {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const lanesOf = (el: Element) =>
  [...el.querySelectorAll('[data-lane]')].map((n) => n.getAttribute('data-lane'));
const saveButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^Save as new version/ });
const reviewDialog = () =>
  screen.findByRole('dialog', { name: 'Review changes before saving' }, DIAGRAM_WAIT);
/** UXR-70: Save opens the review; confirm it (with an optional note). */
async function save(note?: string) {
  fireEvent.click(saveButton());
  const dialog = within(await reviewDialog());
  if (note !== undefined) type(dialog.getByRole('textbox', { name: 'Note (optional)' }), note);
  const confirm = await dialog.findByRole<HTMLButtonElement>('button', { name: /^Save as v\d+$/ });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
}
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
    await screen.findByRole('group', { name: 'conductor v3 columns' }, DIAGRAM_WAIT);
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
    // UXR-58: a focusable lane carries a focus ring apart from its box; Queued has none.
    expect(lane('Planning').querySelector('rect.wf-lane-box')).toBeTruthy();
    expect(lane('Planning').querySelector('rect.wf-focus-ring')).toBeTruthy();
    expect(diagram.querySelector('[data-lane="__queued__"] rect.wf-focus-ring')).toBeNull();
    // Arrows are buttons too; the claim arrow is not.
    expect(arrow('Planning', 'Implementing').getAttribute('tabindex')).toBe('0');
    expect(diagram.querySelector('[data-edge="start"]')?.getAttribute('role')).toBeNull();
  });

  it('keeps the version selector, and shows an old version’s requirements to enter', async () => {
    await setup();
    const select = screen.getByRole('combobox', { name: 'Version' });
    // UXR-70: each version with when, who and its note.
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'v3 · 3 Oct 2026 · ben@example.com via MCP · Transition rules: checks and conditions… (latest)',
      'v2 · 2 Oct 2026 · ben@example.com · Board columns: one column per state',
      'v1 · 1 Oct 2026',
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
    await save();
    await screen.findByRole('group', { name: 'conductor v4 columns' });
    expect(screen.getByRole('status').textContent).toBe('Saved as v4.');
    expect(saved[0]!.states.implementing).toMatchObject({
      title: 'Building',
      prompt: 'ticket_template',
      model: 'claude-sonnet-4-5',
    });
  });

  it('sets who may edit tickets per column, Queued included', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Implementing'));
    const box = editor().getByRole<HTMLInputElement>('checkbox', {
      name: 'People can edit the ticket in this column',
    });
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const queued = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'People can edit tickets in the Queued column',
    });
    expect(queued.checked).toBe(true);
    fireEvent.click(queued);
    await save();
    await screen.findByRole('group', { name: 'conductor v4 columns' });
    expect(saved[0]!.states.implementing).toMatchObject({ ticket_editable: true });
    expect(saved[0]!.queued_ticket_editable).toBe(false);
  });

  it('lays each lone checkbox out inline with its label, not as a check row (UXR-43)', async () => {
    await setup();
    fireEvent.click(lane('Implementing'));
    const boxes = [
      editor().getByRole('checkbox', { name: 'People can edit the ticket in this column' }),
      editor().getByRole('checkbox', { name: 'Agents may propose follow-up tickets' }),
      screen.getByRole('checkbox', { name: 'People can edit tickets in the Queued column' }),
    ];
    for (const box of boxes) {
      const label = box.closest('label')!;
      expect(label.classList.contains('wf-toggle')).toBe(true);
      expect(label.classList.contains('wf-check')).toBe(false);
    }
  });

  it('tunes follow-up proposals for an agent column (ADR-0034)', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Implementing'));
    const box = editor().getByRole<HTMLInputElement>('checkbox', {
      name: 'Agents may propose follow-up tickets',
    });
    // Implementing uses the built-in template, whose hint makes proposals on by default.
    expect(box.checked).toBe(true);
    type(editor().getByLabelText('At most'), '2');
    type(editor().getByLabelText('Guidance'), 'Only test debt');
    await save();
    await screen.findByRole('group', { name: 'conductor v4 columns' });
    expect(saved[0]!.states.implementing).toMatchObject({
      follow_ups: { enabled: true, max: 2, guidance: 'Only test debt' },
    });
  });

  it('turns follow-up proposals off for an agent column (ADR-0034)', async () => {
    const { saved } = await setup();
    fireEvent.click(lane('Implementing'));
    fireEvent.click(
      editor().getByRole('checkbox', { name: 'Agents may propose follow-up tickets' }),
    );
    expect(editor().queryByLabelText('At most')).toBeNull();
    await save();
    await screen.findByRole('group', { name: 'conductor v4 columns' });
    expect(saved[0]!.states.implementing).toMatchObject({ follow_ups: { enabled: false } });
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
  it('click an arrow → its transition list → a transition → back (UXR-64, UXR-66)', async () => {
    await setup();
    fireEvent.click(arrow('Planning', 'Needs input'));
    expect(arrow('Planning', 'Needs input').getAttribute('aria-pressed')).toBe('true');
    // The list, not the first transition.
    expect(screen.queryByRole('complementary', { name: 'Transition' })).toBeNull();
    expect(arrowPanel().getByRole('heading', { name: 'Planning → Needs input' })).toBeTruthy();
    expect(crumbs()).toEqual(['Planning', 'Planning → Needs input']);
    const list = arrowPanel().getByRole('list', { name: 'Transitions on this arrow' });
    expect(rowsOf(list)).toEqual([
      'Scope changedThe agent · All tickets · No rules',
      'Plan needs approvalThe agent · All tickets · No rules',
      'Needs product contextThe agent · All tickets · No rules',
      'ImpossibleThe agent · All tickets · No rules',
      'Ask userThe agent · All tickets · No rules',
      'TimeoutThe system · All tickets · No rules',
    ]);
    // The raw names stay off the rows.
    expect(within(list).queryByText(/scope_changed/)).toBeNull();

    fireEvent.click(within(list).getByRole('button', { name: /^Impossible/ }));
    expect(panel().getByRole('heading', { name: 'Impossible' })).toBeTruthy();
    expect(crumbs()).toEqual(['Planning', 'Planning → Needs input', 'Impossible']);
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('impossible');
    expect(panel().getByLabelText<HTMLTextAreaElement>('When to take it').value).toBe(
      'The work cannot be done as asked.',
    );
    expect(arrow('Planning', 'Needs input').getAttribute('aria-pressed')).toBe('true');

    // Back → the list; the arrow crumb too; the column crumb → the column.
    fireEvent.click(panel().getByRole('button', { name: 'Back to Planning → Needs input' }));
    expect(arrowPanel().getByRole('list', { name: 'Transitions on this arrow' })).toBeTruthy();
    fireEvent.click(arrowPanel().getByRole('button', { name: /^Scope changed/ }));
    expect(
      panel().getByRole<HTMLInputElement>('checkbox', { name: /Asks a question/ }).checked,
    ).toBe(true);
    fireEvent.click(panel().getByRole('button', { name: 'Planning → Needs input' }));
    expect(arrowPanel().getByRole('heading', { name: 'Planning → Needs input' })).toBeTruthy();
    fireEvent.click(arrowPanel().getByRole('button', { name: 'Back to Planning' }));
    expect(editor().getByRole('heading', { name: 'Planning' })).toBeTruthy();
    // The arrow's label and count badge.
    const label = screen
      .getByRole('group', { name: 'conductor v3 columns' })
      .querySelector('.wf-label-outcome .wf-gate');
    expect(label).toBeTruthy();
  });

  it('tells apart transitions that differ only by ticket kind (UXR-64)', async () => {
    await setup();
    fireEvent.click(arrow('Implementing', 'Needs input'));
    const list = arrowPanel().getByRole('list', { name: 'Transitions on this arrow' });
    expect(rowsOf(list)).toEqual([
      'Approve a messageThe agent · All tickets · No rules',
      'PR ready for reviewThe agent · Work only · 5 rules',
      'PR ready for reviewThe agent · Personal only · 4 rules',
      'Ask userThe agent · All tickets · No rules',
      'TimeoutThe system · All tickets · No rules',
    ]);
    fireEvent.click(within(list).getByRole('button', { name: /Personal only/ }));
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe(
      'personal_pr_ready_for_review',
    );
  });

  it('opens a single transition with Enter, and shows its requirements', async () => {
    await setup();
    fireEvent.keyDown(arrow('Implementing', 'Waiting external'), { key: 'Enter' });
    expect(screen.queryByRole('complementary', { name: 'Arrow' })).toBeNull();
    // A lone transition's arrow is no crumb; Back goes to its column.
    expect(crumbs()).toEqual(['Implementing', 'Ready for testing']);
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
    fireEvent.click(panel().getByRole('button', { name: 'Back to Implementing' }));
    expect(editor().getByRole('heading', { name: 'Implementing' })).toBeTruthy();
  });

  it('edit `when` and kinds, then save → the POSTed definition has them', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    type(panel().getByLabelText('When to take it'), 'The plan is done and approved.');
    // No `kinds` = both; unticking Personal leaves work only.
    fireEvent.click(panel().getByRole('checkbox', { name: 'Personal' }));
    type(panel().getByLabelText('Taken by'), 'agent');
    type(panel().getByLabelText('Title'), 'Ready to build');
    await save();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(onOf(saved[0]!, 'planning').plan_ready).toEqual({
      goto: 'implementing',
      title: 'Ready to build',
      when: 'The plan is done and approved.',
      kinds: ['work'],
      actor: 'agent',
    });
  });

  it('"Notify me when this is taken" sets `notify: true`; unticking drops it', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    const box = () =>
      panel().getByRole<HTMLInputElement>('checkbox', { name: 'Notify me when this is taken' });
    expect(box().checked).toBe(false);
    fireEvent.click(box());
    expect(box().checked).toBe(true);
    await save();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(onOf(saved[0]!, 'planning').plan_ready).toMatchObject({
      goto: 'implementing',
      notify: true,
    });
  });

  it('ticking and unticking "Notify me" leaves no `notify` key', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    const box = () =>
      panel().getByRole<HTMLInputElement>('checkbox', { name: 'Notify me when this is taken' });
    fireEvent.click(box());
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    type(panel().getByLabelText('Title'), 'Ready to build');
    await save();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect('notify' in (onOf(saved[0]!, 'planning').plan_ready as object)).toBe(false);
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
    await save();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect('kinds' in (onOf(saved[0]!, 'implementing').ready_for_testing as object)).toBe(false);
  });

  it('add a condition with no timeout → the rule-13 error is shown on that arrow', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    fireEvent.click(sectionHead('Conditions (0)'));
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
    await save();
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
    // UXR-63: a section the user closed opens again when a problem appears in it.
    fireEvent.click(arrow('Implementing', 'Waiting external'));
    fireEvent.click(sectionHead('Conditions'));
    expect(sectionHead('Conditions').getAttribute('aria-expanded')).toBe('false');
    await save();
    await screen.findByText(/workflow definition is invalid/);
    expect(sectionHead('Conditions').getAttribute('aria-expanded')).toBe('true');
    expect(sectionHead('Conditions').getAttribute('class')).toContain('error');
    expect(panel().getByRole('alert').textContent).toBe(
      'rule 13: conditions need condition_timeout',
    );
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
    // M2-T34: the shipped conductor no longer has an Implementing → Done arrow; this editor case
    // still runs on one (v2's personal `done`, added to the mock's latest).
    const api = createMockApi();
    const get = api.getWorkflow.bind(api);
    api.getWorkflow = async (id, version) => {
      const detail = await get(id, version);
      if (detail.version !== 3) return detail;
      const def = structuredClone(detail.definition);
      const v2On = onOf(CONDUCTOR_V2_DEF, 'implementing');
      const st = def.states.implementing!;
      if (st.type !== 'terminal') st.on = { ...st.on, done: structuredClone(v2On.done!) };
      return { ...detail, definition: def };
    };
    const { saved } = await setup(api);
    fireEvent.click(arrow('Implementing', 'Done'));
    fireEvent.click(panel().getByRole('button', { name: 'Remove check 1' }));
    fireEvent.click(panel().getByRole('button', { name: 'Add check' }));
    type(panel().getByLabelText('Check 2 name'), 'Lint passes');
    type(panel().getByLabelText('Check 2 command'), 'npm run lint');
    type(panel().getByLabelText('Check 2 timeout'), '5m');
    fireEvent.click(panel().getByRole('button', { name: 'Move check 2 up' }));
    type(panel().getByLabelText(/Before the checks/), 'custom');
    type(panel().getByLabelText('Setup command'), 'pnpm i --frozen-lockfile');
    fireEvent.click(sectionHead('Review (0)'));
    fireEvent.click(panel().getByRole('button', { name: 'Add review item' }));
    type(panel().getByLabelText('Review item 1'), 'The change matches the ticket');
    fireEvent.click(panel().getByRole('checkbox', { name: 'Open a pull request (by conductor)' }));
    type(panel().getByLabelText('With instruction'), 'Fix it.');
    await save();
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

  it('Title comes first; the name is under Advanced and renames on blur only (UXR-65)', async () => {
    const { saved } = await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    const title = panel().getByLabelText('Title');
    const name = () => panel().getByLabelText<HTMLInputElement>('Name');
    expect(title.compareDocumentPosition(name()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const advanced = panel().getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(
      panel().getByText('Agents report this name; prompts and history refer to it.'),
    ).toBeTruthy();

    // A duplicate or a space: the error shows, and leaving the field renames nothing.
    type(name(), 'impossible');
    expect(panel().getByText('this column already has a transition "impossible"')).toBeTruthy();
    fireEvent.blur(name());
    type(name(), 'plan done');
    expect(panel().getByText(/without spaces/)).toBeTruthy();
    fireEvent.blur(name());
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    // A valid name: nothing changes while typing, only on blur.
    type(name(), 'plan_done');
    expect(panel().queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    fireEvent.blur(name());
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(name().value).toBe('plan_done');
    // Enter applies too.
    type(name(), 'plan_finished');
    fireEvent.keyDown(name(), { key: 'Enter' });
    expect(name().value).toBe('plan_finished');
    await save();
    await waitFor(() => expect(saved).toHaveLength(1));
    const names = Object.keys(onOf(saved[0]!, 'planning'));
    expect(names[0]).toBe('plan_finished');
    expect(names).not.toContain('plan_ready');
    expect(names).not.toContain('plan_done');
  });

  it('Escape puts the name back without renaming', async () => {
    await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    const name = () => panel().getByLabelText<HTMLInputElement>('Name');
    type(name(), 'plan_done');
    fireEvent.keyDown(name(), { key: 'Escape' });
    expect(name().value).toBe('plan_ready');
    fireEvent.blur(name());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('adds a transition from a column’s panel, retargets it and removes it', async () => {
    await setup();
    fireEvent.click(lane('Needs input'));
    const list = editor().getByRole('list', { name: 'Transitions' });
    // UXR-65: rows by title, with where each goes, who takes it, the kinds and the rules.
    expect(rowsOf(list)).toEqual([
      'Back with this answer → the column that askedA person · All tickets · No rules',
      'Waiting on someone else → Waiting externalA person · All tickets · No rules',
      'Done → DoneA person · All tickets · No rules',
    ]);
    // `answer` goes back to the column that asked: no arrow, but listed and editable here.
    fireEvent.click(within(list).getByRole('button', { name: /^Back with this answer/ }));
    expect(panel().getByLabelText<HTMLSelectElement>('Goes to').value).toBe('$return_to');
    expect(crumbs()).toEqual(['Needs input', 'Back with this answer']);
    fireEvent.click(lane('Planning'));
    fireEvent.click(editor().getByRole('button', { name: 'Add transition' }));
    expect(panel().getByLabelText<HTMLInputElement>('Name').value).toBe('new_transition');
    expect(panel().getByRole('heading', { name: 'New transition' })).toBeTruthy();
    expect(arrow('Planning', 'Implementing').getAttribute('aria-pressed')).toBe('true');
    type(panel().getByLabelText('Goes to'), 'done');
    expect(crumbs()).toEqual(['Planning', 'New transition']);
    expect(arrow('Planning', 'Done').getAttribute('aria-pressed')).toBe('true');
    // FR-5: removing asks first.
    fireEvent.click(panel().getByRole('button', { name: 'Remove transition' }));
    const confirm = within(panel().getByRole('alertdialog', { name: 'Remove transition' }));
    expect(confirm.getByText('new_transition')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(panel().queryByRole('alertdialog')).toBeNull();
    expect(arrow('Planning', 'Done')).toBeTruthy();
    fireEvent.click(panel().getByRole('button', { name: 'Remove transition' }));
    fireEvent.click(
      within(panel().getByRole('alertdialog', { name: 'Remove transition' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(editor().getByRole('heading', { name: 'Planning' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Arrow Planning → Done:/ })).toBeNull();
  });

  it('removing one of several transitions on an arrow goes back to its list', async () => {
    await setup();
    fireEvent.click(arrow('Planning', 'Needs input'));
    fireEvent.click(arrowPanel().getByRole('button', { name: /^Impossible/ }));
    fireEvent.click(panel().getByRole('button', { name: 'Remove transition' }));
    fireEvent.click(
      within(panel().getByRole('alertdialog', { name: 'Remove transition' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    const list = arrowPanel().getByRole('list', { name: 'Transitions on this arrow' });
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    expect(within(list).queryByRole('button', { name: /^Impossible/ })).toBeNull();
  });
});

describe('transition editor: summary and sections (UXR-60, UXR-63)', () => {
  // The sections' headers, in order (not the Advanced toggle inside one).
  const heads = () => [
    ...screen
      .getByRole('complementary', { name: 'Transition' })
      .querySelectorAll<HTMLButtonElement>('.wf-section-head > button'),
  ];

  it('opens on a sentence saying what the transition does, then its sections', async () => {
    await setup();
    fireEvent.click(arrow('Implementing', 'Waiting external'));
    expect(panel().getByLabelText('Summary').textContent).toBe(
      'When the agent says Ready for testing (work tickets): set up with auto-detect, run Build ' +
        'passes and Tests pass, have a reviewer check 1 item, open a PR, then wait up to 3 days ' +
        'for PR checks and 1 approval → Waiting external. If not met: back to Implementing with ' +
        'your instruction, up to 3 times, then Needs input.',
    );
    const names = [
      'Who and when (the agent · work)',
      'Checks (2)',
      'Review (1)',
      'Actions (open a PR)',
      'Conditions (4 · wait 3d, poll 2m)',
      'If the requirements aren’t met (back to Implementing · 3× · then Needs input)',
    ];
    // In this order, all open (each has content).
    expect(heads().map((b) => b.textContent?.replace(/^[▾▸]/, ''))).toEqual(names);
    for (const n of names) {
      expect(panel().getByRole('button', { name: n }).getAttribute('aria-expanded')).toBe('true');
    }
    // A section closes and opens again from its header.
    fireEvent.click(sectionHead('Checks (2)'));
    expect(sectionHead('Checks (2)').getAttribute('aria-expanded')).toBe('false');
    expect(panel().queryByRole('button', { name: 'Add check' })).toBeNull();
    fireEvent.click(sectionHead('Checks (2)'));
    expect(panel().getByRole('button', { name: 'Add check' })).toBeTruthy();
  });

  it('a transition with no requirements: closed sections, "Nothing is required"', async () => {
    await setup();
    fireEvent.click(arrow('Planning', 'Implementing'));
    expect(panel().getByLabelText('Summary').textContent).toBe(
      'When the agent says Plan ready: move straight → Implementing.',
    );
    expect(sectionHead('Who and when').getAttribute('aria-expanded')).toBe('true');
    for (const n of ['Checks (0)', 'Review (0)', 'Actions (none)', 'Conditions (0)']) {
      expect(sectionHead(n).getAttribute('aria-expanded')).toBe('false');
    }
    expect(panel().queryByRole('button', { name: 'Add condition' })).toBeNull();
    expect(panel().getByText(/Nothing is required: the move happens as soon as/)).toBeTruthy();
    expect(panel().queryByRole('button', { name: /^If the requirements/ })).toBeNull();

    // The first requirement brings its not-met policy, open, right after the conditions; the
    // summary follows.
    fireEvent.click(sectionHead('Conditions (0)'));
    fireEvent.click(panel().getByRole('button', { name: 'Add condition' }));
    expect(panel().queryByText(/Nothing is required/)).toBeNull();
    const unmet = sectionHead('If the requirements aren’t met');
    expect(unmet.getAttribute('aria-expanded')).toBe('true');
    const conditions = sectionHead('Conditions (1 · poll 2m)');
    expect(conditions.getAttribute('class')).toContain('error');
    expect(
      conditions.compareDocumentPosition(unmet) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const summary = panel().getByLabelText('Summary').textContent;
    expect(summary).toContain('wait for PR checks → Implementing.');
    expect(summary).toContain('If not met: back to Planning, up to 3 times, then Needs input.');
    type(panel().getByLabelText('Wait at most'), '1d');
    expect(panel().getByLabelText('Summary').textContent).toContain('wait up to 1 day for');
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
    await save();
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
    const ctx = await setup(createMockApi(), { app: true });
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
    await screen.findByRole('group', { name: 'conductor v3 columns' }, DIAGRAM_WAIT);
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
    fireEvent.click(panel.getByRole('button', { name: /^Technical details/ }));
    await waitFor(() =>
      expect(panel.getByRole('group', { name: /m1_basic v2 diagram, current state/ })).toBeTruthy(),
    );
  });
});

describe('Workflow view: change proposals (ADR-0033 P3)', () => {
  it('lists the advisor’s open proposals under the editor', async () => {
    await setup();
    const region = await screen.findByRole('region', { name: 'Change proposals' });
    await within(region).findByRole('button', { name: /Build the web app inside m-one/ });
  });

  it('reloads the latest version after a workflow proposal is applied', async () => {
    const api = createMockApi();
    const calls: (number | undefined)[] = [];
    const get = api.getWorkflow.bind(api);
    api.getWorkflow = (id, version) => {
      calls.push(version);
      return get(id, version);
    };
    const wf = (await api.listChangeProposals({ status: 'all' })).proposals.find(
      (p) => p.kind === 'workflow',
    );
    const detail = { ...(await api.getChangeProposal(wf!.id)), status: 'proposed' as const };
    api.listChangeProposals = () =>
      Promise.resolve({ proposals: [{ ...wf!, status: 'proposed' }], next_cursor: null, total: 1 });
    api.getChangeProposal = () => Promise.resolve(detail);
    api.applyChangeProposal = () => Promise.resolve({ ...detail, status: 'applied' });
    await setup(api);
    const n = calls.length;
    const region = within(screen.getByRole('region', { name: 'Change proposals' }));
    fireEvent.click(await region.findByRole('button', { name: new RegExp(wf!.title) }));
    fireEvent.click(await region.findByRole('button', { name: 'Apply…' }));
    fireEvent.click(region.getByRole('button', { name: 'Confirm apply' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(n));
  });
});
