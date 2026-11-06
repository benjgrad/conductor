import {
  AVAILABLE_CONDITION_TYPES,
  transitionObject,
  DEFAULT_CONDITION_POLL,
  MIN_WATCH_POLL,
  type Condition,
  type ConditionType,
  type Watch,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { ReactNode } from 'react';
import { ConditionRow } from './ConditionFields.js';
import { columnTitle, humanStates, setWatch, watchOfColumn } from './columns.js';
import { InstructionField } from './InstructionField.js';
import { CONDITION_TEXT, conditionOfType } from './transitions.js';

// ADR-0037 P1 (T6): "While here, keep checking" on a human or event column: the conditions a
// ticket waiting here keeps being checked against (in order, stopping at the first one not met),
// how often, and what happens when one breaks: send it back (to a column, with an instruction,
// optionally coming back here, a number of times, then a human), or notify me.

const MAX_WATCH_CONDITIONS = 10;

type MoveForm = Extract<Watch['on_broken'], { goto: string }>;

export interface WatchFieldsProps {
  uid: string;
  definition: WorkflowDefinition;
  state: string;
  onChange: (next: WorkflowDefinition) => void;
  /** This column's problems under `.watch`, by path suffix ('' for the watch itself). */
  issues: readonly { suffix: string; message: string }[];
}

/** A new watch: GitHub mergeability, and back to the first agent column with retries. */
function defaultWatch(def: WorkflowDefinition, state: string): Watch {
  return {
    conditions: [{ type: 'pr_mergeable' }],
    on_broken: defaultMove(def, state),
  };
}

function defaultMove(def: WorkflowDefinition, state: string): MoveForm {
  const targets = gotoTargets(def, state);
  // The agent column that moves tickets here (it can fix what broke), else the first agent one.
  const feeder = Object.entries(def.states).find(
    ([n, s]) =>
      n !== state &&
      s.type === 'agent' &&
      Object.values(s.on ?? {}).some((t) => transitionObject(t).goto === state),
  )?.[0];
  const humans = humanStates(def).filter((n) => n !== state);
  return {
    goto: feeder ?? targets[0] ?? state,
    retries: 2,
    else: humans.includes('needs_input') ? 'needs_input' : (humans[0] ?? 'needs_input'),
  };
}

/** Where a broken watch may send the ticket: any column but this one and the terminal ones. */
function gotoTargets(def: WorkflowDefinition, state: string): string[] {
  return Object.entries(def.states)
    .filter(([n, s]) => n !== state && s.type !== 'terminal')
    .sort(([, a], [, b]) => (a.type === 'agent' ? 0 : 1) - (b.type === 'agent' ? 0 : 1))
    .map(([n]) => n);
}

export function WatchFields({ uid, definition, state, onChange, issues }: WatchFieldsProps) {
  const at = (suffix: string): ReactNode =>
    issues
      .filter((i) => i.suffix === suffix)
      .map((i) => (
        <p key={i.message} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ));
  // Anything not shown next to a field goes at the end of the panel.
  const placed = (suffix: string) =>
    /^\.conditions\.\d+(\.[a-z_]+)?$/.test(suffix) ||
    [
      '.conditions',
      '.poll',
      '.on_broken',
      '.on_broken.goto',
      '.on_broken.instruction',
      '.on_broken.return_to',
      '.on_broken.retries',
      '.on_broken.else',
    ].includes(suffix);
  const unplaced = issues.filter((i) => !placed(i.suffix));
  const w = watchOfColumn(definition, state);
  const title = columnTitle(definition, state);
  const set = (next: Watch | null) => onChange(setWatch(definition, state, next));
  const setConditions = (conditions: Condition[]) => w && set({ ...w, conditions });
  const move = w !== null && 'goto' in w.on_broken ? w.on_broken : null;
  const setMove = (patch: Partial<MoveForm>) =>
    move && w && set({ ...w, on_broken: { ...move, ...patch } });

  return (
    <section aria-label="While here, keep checking">
      <h4>While here, keep checking</h4>
      <label className="wf-field wf-toggle">
        <input
          type="checkbox"
          checked={w !== null}
          onChange={(e) => set(e.target.checked ? defaultWatch(definition, state) : null)}
        />
        Keep checking while a ticket waits in {title}
      </label>
      {w === null ? (
        <p className="muted wf-note">
          Off. When on, conductor re-checks conditions (e.g. that the pull request still merges
          cleanly) while a ticket waits here, and acts when one breaks.
        </p>
      ) : (
        <>
          <p className="muted wf-note">
            Checked in order; a later one runs only when every earlier one holds.
          </p>
          <ol className="wf-items" aria-label="Watched conditions">
            {w.conditions.map((c, i) => (
              <ConditionRow
                key={`${i}:${c.type}:${w.conditions.length}`}
                condition={c}
                i={i}
                n={w.conditions.length}
                onChange={(next) => setConditions(w.conditions.map((x, j) => (j === i ? next : x)))}
                onMove={(j) => {
                  const next = [...w.conditions];
                  [next[i], next[j]] = [next[j]!, next[i]!];
                  setConditions(next);
                }}
                onRemove={() => setConditions(w.conditions.filter((_, j) => j !== i))}
                issuesAt={(field) => at(`.conditions.${i}${field}`)}
              />
            ))}
          </ol>
          {at('.conditions')}
          <div>
            <select
              aria-label="Add watched condition"
              value=""
              disabled={w.conditions.length >= MAX_WATCH_CONDITIONS}
              onChange={(e) => {
                const type = e.target.value;
                if (type !== '') {
                  setConditions([...w.conditions, conditionOfType(type as ConditionType)]);
                }
              }}
            >
              <option value="">Add condition…</option>
              {AVAILABLE_CONDITION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONDITION_TEXT[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="wf-unmet">
            <label htmlFor={`${uid}-wpoll`}>Check every</label>
            <input
              id={`${uid}-wpoll`}
              className="mono"
              value={w.poll ?? ''}
              placeholder={`${DEFAULT_CONDITION_POLL} (default)`}
              onChange={(e) => {
                const next = { ...w };
                delete next.poll;
                set(e.target.value === '' ? next : { ...next, poll: e.target.value });
              }}
            />
          </div>
          <p className="muted wf-note">
            At least {MIN_WATCH_POLL}; slower while nothing changes (up to 15m).
          </p>
          {at('.poll')}

          <fieldset className="wf-fieldset">
            <legend>If one breaks</legend>
            <label className="wf-toggle">
              <input
                type="radio"
                name={`${uid}-wbroken`}
                checked={move !== null}
                onChange={() => set({ ...w, on_broken: defaultMove(definition, state) })}
              />
              Send it back
            </label>
            <label className="wf-toggle">
              <input
                type="radio"
                name={`${uid}-wbroken`}
                checked={move === null}
                onChange={() => set({ ...w, on_broken: { notify: 'escalate' } })}
              />
              Notify me
            </label>
          </fieldset>
          {move === null ? (
            <p className="muted wf-note">
              Conductor notifies you once per stay; the ticket stays in {title}.
            </p>
          ) : (
            <div className="wf-unmet">
              <label htmlFor={`${uid}-wgoto`}>Back to</label>
              <select
                id={`${uid}-wgoto`}
                value={move.goto}
                onChange={(e) => setMove({ goto: e.target.value })}
              >
                {[...new Set([move.goto, ...gotoTargets(definition, state)])].map((n) => (
                  <option key={n} value={n}>
                    {columnTitle(definition, n)}
                  </option>
                ))}
              </select>
              <label htmlFor={`${uid}-winstruction`}>With instruction</label>
              <InstructionField
                definition={definition}
                id={`${uid}-winstruction`}
                value={move.instruction}
                placeholder="What the agent should do about it (optional)"
                onChange={(v) => {
                  const rest = { ...move };
                  delete rest.instruction;
                  set({ ...w, on_broken: v === undefined ? rest : { ...rest, instruction: v } });
                }}
              />
              <span />
              <label className="wf-toggle">
                <input
                  type="checkbox"
                  checked={move.return_to === '$self'}
                  onChange={(e) => {
                    const rest = { ...move };
                    delete rest.return_to;
                    set({
                      ...w,
                      on_broken: e.target.checked ? { ...rest, return_to: '$self' } : rest,
                    });
                  }}
                />
                Come back to {title} when done
              </label>
              <label htmlFor={`${uid}-wretries`}>Up to (times)</label>
              <input
                id={`${uid}-wretries`}
                type="number"
                min={0}
                max={10}
                step={1}
                value={Number.isNaN(move.retries) ? '' : move.retries}
                onChange={(e) =>
                  setMove({ retries: e.target.value === '' ? NaN : Number(e.target.value) })
                }
              />
              <label htmlFor={`${uid}-welse`}>Then</label>
              <select
                id={`${uid}-welse`}
                value={move.else}
                onChange={(e) => setMove({ else: e.target.value })}
              >
                {[
                  ...new Set([move.else, ...humanStates(definition).filter((n) => n !== state)]),
                ].map((n) => (
                  <option key={n} value={n}>
                    {columnTitle(definition, n)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {at('.on_broken')}
          {at('.on_broken.goto')}
          {at('.on_broken.instruction')}
          {at('.on_broken.return_to')}
          {at('.on_broken.retries')}
          {at('.on_broken.else')}
        </>
      )}
      {unplaced.map((i) => (
        <p key={`${i.suffix}:${i.message}`} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ))}
    </section>
  );
}
