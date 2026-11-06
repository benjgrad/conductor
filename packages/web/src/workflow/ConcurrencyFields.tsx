import type { Concurrency, WorkflowDefinition } from '@conductor/shared';
import type { ReactNode } from 'react';
import { columnStates, columnTitle, humanStates } from './columns.js';

// ADR-0037 P4 (T7): "One at a time" on an agent's transition (`requires.concurrency`). Before
// its checks run, the move waits while `max` other tickets on the same repo are in the chosen
// columns (or on their way in), released oldest first, or until the hold timeout sends it to the
// "not met" column. "Only when files overlap" holds only tickets whose plans name the same files.

export interface ConcurrencyFieldsProps {
  uid: string;
  definition: WorkflowDefinition;
  value: Concurrency | undefined;
  onChange: (next: Concurrency | undefined) => void;
  /** Problems under `.requires.concurrency`, by path suffix ('' for the block itself). */
  issues: readonly { suffix: string; message: string }[];
}

/** A new rule: one at a time on the repo, in review (the first human column), files overlap, 1d. */
export function defaultConcurrency(def: WorkflowDefinition): Concurrency {
  const humans = humanStates(def).filter((n) => n !== 'needs_input');
  const scope = humans.includes('in_review') ? 'in_review' : (humans[0] ?? def.start);
  return {
    key: '$repo',
    max_in_flight: 1,
    scope: [scope],
    order: 'oldest_first',
    overlap: 'planned_files',
    hold_timeout: '1d',
  };
}

export function ConcurrencyFields({
  uid,
  definition,
  value,
  onChange,
  issues,
}: ConcurrencyFieldsProps) {
  const at = (suffix: string): ReactNode =>
    issues
      .filter(
        (i) => i.suffix === suffix || (suffix === '.scope' && /^\.scope\.\d+$/.test(i.suffix)),
      )
      .map((i) => (
        <p key={`${i.suffix}:${i.message}`} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ));
  const columns = columnStates(definition).filter((n) => definition.states[n]?.type !== 'terminal');
  const set = (patch: Partial<Concurrency>) => value && onChange({ ...value, ...patch });
  const toggleScope = (state: string, on: boolean) => {
    if (!value) return;
    const next = columns.filter((n) => (n === state ? on : value.scope.includes(n)));
    // Keep a column the definition no longer lists (the validator names it).
    const kept = value.scope.filter((n) => !columns.includes(n));
    set({ scope: [...next, ...kept] });
  };

  return (
    <div>
      <label className="wf-field wf-toggle">
        <input
          type="checkbox"
          checked={value !== undefined}
          onChange={(e) => onChange(e.target.checked ? defaultConcurrency(definition) : undefined)}
        />
        Hold this move while other tickets on the repo are in flight
      </label>
      {value === undefined ? (
        <p className="muted wf-note">
          Off. When on, the move waits (before its checks) while too many other tickets on the same
          repo are past it, and goes oldest first when one leaves.
        </p>
      ) : (
        <>
          <div className="wf-unmet">
            <label htmlFor={`${uid}-ckey`}>Same</label>
            <select
              id={`${uid}-ckey`}
              value={value.key}
              onChange={(e) => set({ key: e.target.value as Concurrency['key'] })}
            >
              <option value="$repo">repo</option>
              <option value="$repo+$kind">repo and kind</option>
            </select>
            <label htmlFor={`${uid}-cmax`}>At most (tickets)</label>
            <input
              id={`${uid}-cmax`}
              type="number"
              min={1}
              max={10}
              step={1}
              value={Number.isNaN(value.max_in_flight) ? '' : value.max_in_flight}
              onChange={(e) =>
                set({ max_in_flight: e.target.value === '' ? NaN : Number(e.target.value) })
              }
            />
            <label htmlFor={`${uid}-ctimeout`}>Wait at most</label>
            <input
              id={`${uid}-ctimeout`}
              className="mono"
              value={value.hold_timeout}
              placeholder="e.g. 1d"
              onChange={(e) => set({ hold_timeout: e.target.value })}
            />
          </div>
          {at('.key')}
          {at('.max_in_flight')}
          {at('.hold_timeout')}
          <fieldset className="wf-field">
            <legend>In flight means in</legend>
            {columns.map((n) => (
              <label key={n} className="wf-toggle">
                <input
                  type="checkbox"
                  checked={value.scope.includes(n)}
                  onChange={(e) => toggleScope(n, e.target.checked)}
                />
                {columnTitle(definition, n)}
              </label>
            ))}
          </fieldset>
          {at('.scope')}
          <label className="wf-field wf-toggle">
            <input
              type="checkbox"
              checked={value.overlap === 'planned_files'}
              onChange={(e) => {
                const next: Concurrency = { ...value };
                if (e.target.checked) next.overlap = 'planned_files';
                else delete next.overlap;
                onChange(next);
              }}
            />
            Only when their planned files overlap
          </label>
          <p className="muted wf-note">
            {value.overlap === 'planned_files'
              ? 'A ticket whose plan names no files is never held and holds no one.'
              : 'Every ticket on the key counts, whatever it changes.'}
          </p>
          {at('.overlap')}
          {at('')}
        </>
      )}
    </div>
  );
}
