// @vitest-environment jsdom
import type { AnswerInputRequest } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CancelSessionRequest } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';

// U-037: the quick actions on a non-agent input request, checked against apply()'s
// input.provided handling (packages/shared/src/engine/apply.ts onInput):
//   target = goto ?? return_to ?? def.start
// so retry = no goto (back to return_to, else the start state), skip to X = goto X, and abort is
// not an answer at all but POST /cancel (operator.cancel, valid from needs_input).

afterEach(cleanup);

async function setup(override?: { returnTo: null }) {
  const api = createMockApi();
  const answers: [string, AnswerInputRequest][] = [];
  const cancels: [string, CancelSessionRequest | undefined][] = [];
  const answer = api.answer.bind(api);
  const cancel = api.cancel.bind(api);
  const getSession = api.getSession.bind(api);
  api.answer = (sid, req) => {
    answers.push([sid, req]);
    return answer(sid, req);
  };
  api.cancel = (sid, req) => {
    cancels.push([sid, req]);
    return cancel(sid, req);
  };
  if (override) {
    api.getSession = async (sid) => ({ ...(await getSession(sid)), return_to: override.returnTo });
  }
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Fix flaky checkout test' }));
  const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
  const actions = within(await panel.findByRole('group', { name: 'Quick actions' }));
  return { answers, cancels, actions, panel };
}

const { session, input } = SEED_IDS.askOlder;

describe('quick actions (U-037)', () => {
  it('retry answers with no goto, so the engine returns to return_to', async () => {
    const { answers, actions } = await setup();
    const retry = actions.getByRole('button', { name: 'Retry test' });
    // UXR-39: Retry is the primary action.
    expect(retry.classList.contains('primary')).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual([session, { input_request_id: input, answer: 'retry' }]);
    expect('goto' in answers[0]![1]).toBe(false);
  });

  it('retry names the workflow start when there is no return_to (apply falls back to it)', async () => {
    const { actions } = await setup({ returnTo: null });
    expect(actions.getByRole('button', { name: 'Retry implement' })).toBeTruthy();
  });

  it('skip to X answers with goto X, on the choice (a menu, no separate Skip button)', async () => {
    const { answers, actions } = await setup();
    const menuButton = actions.getByRole('button', { name: /Skip to/ });
    expect(menuButton.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(menuButton);
    const menu = within(actions.getByRole('menu', { name: 'Skip to state' }));
    fireEvent.click(menu.getByRole('menuitem', { name: 'build' }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual([
      session,
      { input_request_id: input, answer: 'skip to build', goto: 'build' },
    ]);
  });

  it('skip offers only non-human states (goto into a human state would just ask again)', async () => {
    const { actions } = await setup();
    fireEvent.click(actions.getByRole('button', { name: /Skip to/ }));
    const options = within(actions.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((o) => o.textContent);
    expect(options).toEqual(['implement', 'build', 'test', 'done']);
  });

  it('Escape closes the skip menu without answering', async () => {
    const { answers, actions } = await setup();
    fireEvent.click(actions.getByRole('button', { name: /Skip to/ }));
    fireEvent.keyDown(actions.getByRole('menu'), { key: 'Escape' });
    expect(actions.queryByRole('menu')).toBeNull();
    expect(answers).toEqual([]);
  });

  it('abort cancels the session instead of answering', async () => {
    const { answers, cancels, actions, panel } = await setup();
    fireEvent.click(actions.getByRole('button', { name: 'Abort…' }));
    // UXR-39: Abort asks first; the first click cancels nothing.
    expect(cancels).toEqual([]);
    const confirm = within(panel.getByRole('group', { name: 'Confirm abort' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Abort session' }));
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]).toEqual([session, { reason: 'aborted from UI' }]);
    expect(answers).toEqual([]);
  });

  it('Keep it closes the abort confirmation without cancelling', async () => {
    const { cancels, actions, panel } = await setup();
    fireEvent.click(actions.getByRole('button', { name: 'Abort…' }));
    fireEvent.click(panel.getByRole('button', { name: 'Keep it' }));
    expect(panel.queryByRole('group', { name: 'Confirm abort' })).toBeNull();
    expect(cancels).toEqual([]);
  });

  it("shows the failed run's output under the question (FR-4)", async () => {
    const { panel } = await setup();
    const out = panel.getByRole('region', { name: 'Failure output' });
    expect(out.textContent).toContain('FAIL checkout.spec.ts › applies coupon');
  });
});
