// @vitest-environment jsdom
import type { EntryCheck } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChecksFields, MAX_CHECKS, type ChecksIssue, type ChecksValue } from './ChecksFields.js';

afterEach(cleanup);

const TWO: EntryCheck[] = [
  { name: 'Build', cmd: 'npm run build', timeout: '10m' },
  { name: 'Tests', cmd: 'npm test' },
];

function renderFields(
  checks: EntryCheck[] = TWO,
  issues: ChecksIssue[] = [],
  setup: string | undefined = undefined,
) {
  const onChange = vi.fn<(next: ChecksValue) => void>();
  render(<ChecksFields checks={checks} setup={setup} onChange={onChange} issues={issues} />);
  return { onChange };
}

describe('ChecksFields (UXR-61)', () => {
  it('lists the setup first, then the checks as a labelled table', () => {
    renderFields();
    const setup = screen.getByLabelText(/^Setup: runs first/);
    const table = screen.getByRole('table', { name: 'Checks' });
    expect(setup.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Command', 'Timeout', 'Order']);
    expect(screen.getByLabelText<HTMLInputElement>('Check 1 timeout').value).toBe('10m');
    expect(screen.getByLabelText<HTMLInputElement>('Check 2 command').value).toBe('npm test');
  });

  it('no checks: no table and no setup, just Add check', () => {
    const { onChange } = renderFields([]);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByLabelText(/^Setup/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
    expect(onChange).toHaveBeenCalledWith({ checks: [{ name: '', cmd: '' }], setup: undefined });
  });

  it('edits, moves and removes a row', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('Check 1 timeout'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({
      checks: [{ name: 'Build', cmd: 'npm run build' }, TWO[1]],
      setup: undefined,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move check 2 up' }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [TWO[1], TWO[0]], setup: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Remove check 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ checks: [TWO[1]], setup: undefined });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Move check 1 up' }).disabled,
    ).toBe(true);
  });

  it('shows a row’s problems right under that row', () => {
    renderFields(TWO, [{ suffix: 'checks.1.cmd', message: 'Check 2: Command is required' }]);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Check 2: Command is required');
    expect(alert.closest('tr')?.previousElementSibling).toBe(
      screen.getByLabelText('Check 2 command').closest('tr'),
    );
  });

  it('a custom setup command', () => {
    const { onChange } = renderFields(TWO, [], 'make deps');
    expect(screen.getByLabelText<HTMLInputElement>('Setup command').value).toBe('make deps');
    fireEvent.change(screen.getByLabelText(/^Setup: runs first/), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ checks: TWO, setup: '' });
  });

  it('Add check is disabled at the limit', () => {
    renderFields(Array.from({ length: MAX_CHECKS }, (_, i) => ({ name: `c${i}`, cmd: 'x' })));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add check' }).disabled).toBe(
      true,
    );
  });
});
