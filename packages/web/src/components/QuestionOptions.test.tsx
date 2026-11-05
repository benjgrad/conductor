// @vitest-environment jsdom
// Questions UX: the agent's options in the session panel's pending request.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { QuestionOptions } from './QuestionOptions.js';

afterEach(cleanup);

const SINGLE = {
  multi_select: false,
  items: [
    { label: 'Postgres', description: 'recommended' },
    { label: 'SQLite' },
    { label: 'MySQL' },
  ],
};

function renderOptions(options = SINGLE, onAnswer = vi.fn(() => Promise.resolve())) {
  const onTypeInstead = vi.fn();
  render(<QuestionOptions options={options} onAnswer={onAnswer} onTypeInstead={onTypeInstead} />);
  return { onAnswer, onTypeInstead };
}

describe('QuestionOptions', () => {
  it('numbers the options, with the description under the label', () => {
    renderOptions();
    const list = screen.getByRole('list', { name: 'Choose an option' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '1.Postgresrecommended',
      '2.SQLite',
      '3.MySQL',
    ]);
    expect(screen.getByRole('button', { name: /Postgres/ }).getAttribute('aria-describedby')).toBe(
      screen.getByText('recommended').id,
    );
  });

  it('a click answers with the label, once while in flight', async () => {
    let release = () => {};
    const onAnswer = vi.fn(() => new Promise<void>((r) => (release = r)));
    renderOptions(SINGLE, onAnswer);
    const pg = screen.getByRole('button', { name: /Postgres/ });
    fireEvent.click(pg);
    fireEvent.click(pg);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('Postgres');
    release();
    await waitFor(() => expect(pg.hasAttribute('disabled')).toBe(false));
  });

  it('a digit picks the option while focus is in the list; arrows move focus', () => {
    const { onAnswer } = renderOptions();
    const first = screen.getByRole('button', { name: /Postgres/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /SQLite/ }));
    fireEvent.keyDown(document.activeElement!, { key: '3' });
    expect(onAnswer).toHaveBeenCalledWith('MySQL');
    fireEvent.keyDown(document.activeElement!, { key: '9' }); // no such option
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('multi-select: checkboxes, then Submit (n) answers the labels in their order', () => {
    const { onAnswer } = renderOptions({ ...SINGLE, multi_select: true });
    const submit = screen.getByRole('button', { name: 'Submit (0)' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /MySQL/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Postgres/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit (2)' }));
    expect(onAnswer).toHaveBeenCalledWith('Postgres, MySQL');
  });

  it('shows a failed post and allows another try', async () => {
    const onAnswer = vi.fn(() => Promise.reject(new Error('409 already answered')));
    renderOptions(SINGLE, onAnswer);
    fireEvent.click(screen.getByRole('button', { name: /SQLite/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('already answered');
    expect(screen.getByRole('button', { name: /SQLite/ }).hasAttribute('disabled')).toBe(false);
  });

  it('"Type a different answer" hands off to the composer', () => {
    const { onTypeInstead } = renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Type a different answer' }));
    expect(onTypeInstead).toHaveBeenCalled();
  });
});

describe('the session panel (mock: "Add audit log table" has options)', () => {
  it('shows them under the question; a click answers; "Type…" focuses the composer', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    const answer = vi.spyOn(api, 'answer');
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add audit log table' }));
    const el = await screen.findByRole('complementary', { name: 'Session detail' });
    const pending = within(await within(el).findByRole('region', { name: 'Pending input' }));
    // UXR-35: a question is blue, with a "Question" chip (no "Action needed" caps).
    expect(pending.getByText('Question', { selector: '.request-chip' })).toBeTruthy();
    expect(el.querySelector('section.request-question')).toBeTruthy();
    expect(pending.queryByText(/Action needed/i)).toBeNull();
    fireEvent.click(pending.getByRole('button', { name: 'Type a different answer' }));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    fireEvent.click(pending.getByRole('button', { name: /SQLite/ }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer.mock.calls[0]![1].answer).toBe('SQLite');
  });
});
