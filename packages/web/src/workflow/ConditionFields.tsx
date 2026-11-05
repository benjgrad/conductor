import {
  AVAILABLE_CONDITION_TYPES,
  conditionEnabled,
  conditionLabel,
  type Condition,
} from '@conductor/shared';
import { Fragment, useState, type FocusEvent, type ReactNode } from 'react';
import { ItemActions } from './ChecksFields.js';

// One condition of a transition's `requires` (TransitionEditor), as the sentence it means with its
// inputs inline (UXR-62): "At least [1] PR approval". The card label is behind "Rename on the
// card". A type conductor can't evaluate yet is shown read-only, "Not available yet: skipped"
// (UXR-78): it can be removed, not edited, and is never offered for a new condition.

export interface ConditionRowProps {
  condition: Condition;
  i: number;
  n: number;
  onChange: (next: Condition) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  /** The problems at `.<field>` of this condition ('' for the condition itself). */
  issuesAt: (field: string) => ReactNode;
  /** Focus left somewhere in the row (UXR-71: a new condition is validated once it is left). */
  onBlur?: (e: FocusEvent<HTMLLIElement>) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function ConditionRow({
  condition: c,
  i,
  n,
  onChange,
  onMove,
  onRemove,
  issuesAt,
  onBlur,
}: ConditionRowProps) {
  const available = AVAILABLE_CONDITION_TYPES.includes(c.type);
  const [renaming, setRenaming] = useState(c.label !== undefined);
  const row = `Condition ${i + 1}`;
  /** An input in the sentence, or its value as text when the row is read-only. */
  const value = (text: string): ReactNode => (
    <span className="wf-condition-value">{text === '' ? '?' : text}</span>
  );

  let sentence: ReactNode;
  switch (c.type) {
    case 'pr_checks_green':
      sentence = (
        <>
          PR checks are green (count as green if no CI reports within{' '}
          {available ? (
            <input
              aria-label={`${row} no CI after`}
              className="mono wf-short"
              value={c.no_checks_after ?? ''}
              placeholder="5m"
              onChange={(e) => {
                const next = { ...c };
                delete next.no_checks_after;
                onChange(
                  e.target.value === '' ? next : { ...next, no_checks_after: e.target.value },
                );
              }}
            />
          ) : (
            value(c.no_checks_after ?? '')
          )}
          )
        </>
      );
      break;
    case 'pr_approvals':
      sentence = (
        <>
          At least{' '}
          {available ? (
            <input
              aria-label={`${row} approvals`}
              type="number"
              min={1}
              max={20}
              step={1}
              value={Number.isNaN(c.min) ? '' : c.min}
              onChange={(e) =>
                onChange({ ...c, min: e.target.value === '' ? NaN : Number(e.target.value) })
              }
            />
          ) : (
            value(String(c.min))
          )}{' '}
          PR {plural(c.min, 'approval')}
        </>
      );
      break;
    case 'pr_merged':
      sentence = 'PR merged';
      break;
    case 'pr_screenshots':
      sentence = (
        <>
          Before/after screenshots for changes to{' '}
          {available ? (
            <ListInput
              label={`${row} UI paths`}
              className="mono wf-long"
              value={c.ui_paths}
              placeholder="**/*.{tsx,css}"
              onChange={(ui_paths) => onChange({ ...c, ui_paths })}
            />
          ) : (
            value(c.ui_paths.join(', '))
          )}{' '}
          (at least{' '}
          {available ? (
            <input
              aria-label={`${row} screenshot pairs`}
              type="number"
              min={1}
              max={20}
              step={1}
              placeholder="1"
              value={c.min_pairs ?? ''}
              onChange={(e) => {
                const next = { ...c };
                delete next.min_pairs;
                onChange(
                  e.target.value === '' ? next : { ...next, min_pairs: Number(e.target.value) },
                );
              }}
            />
          ) : (
            value(String(c.min_pairs ?? 1))
          )}{' '}
          {plural(c.min_pairs ?? 1, 'pair')})
        </>
      );
      break;
    case 'jira_fields_set':
      sentence = (
        <>
          Jira fields{' '}
          {available ? (
            <ListInput
              label={`${row} Jira fields`}
              className="wf-long"
              value={c.fields}
              placeholder="resolution, status"
              onChange={(fields) => onChange({ ...c, fields })}
            />
          ) : (
            value(c.fields.join(', '))
          )}{' '}
          are set
        </>
      );
      break;
    case 'azure_pipeline_succeeded':
      sentence = (
        <>
          Azure pipeline{' '}
          {available ? (
            <input
              aria-label={`${row} pipeline`}
              className="wf-long"
              value={c.pipeline}
              placeholder="pipeline name"
              onChange={(e) => onChange({ ...c, pipeline: e.target.value })}
            />
          ) : (
            value(c.pipeline)
          )}{' '}
          succeeded
        </>
      );
      break;
  }

  const fieldOf: Record<Condition['type'], string[]> = {
    pr_checks_green: ['no_checks_after'],
    pr_approvals: ['min'],
    pr_merged: [],
    pr_screenshots: ['ui_paths', 'min_pairs'],
    jira_fields_set: ['fields'],
    azure_pipeline_succeeded: ['pipeline'],
  };
  const defaultLabel = conditionLabel({ ...c, label: undefined });

  return (
    <li className="wf-item" data-item={i} onBlur={onBlur}>
      <div className="wf-condition" aria-label={row} role="group">
        <p className="wf-condition-text">{sentence}</p>
        {fieldOf[c.type].map((f) => (
          <Fragment key={f}>{issuesAt(`.${f}`)}</Fragment>
        ))}
        {!available && (
          <p className="wf-condition-note muted">
            Not available yet: skipped
            {conditionEnabled(c) && (
              <button type="button" onClick={() => onChange({ ...c, enabled: false })}>
                Skip it
              </button>
            )}
          </p>
        )}
        {available && !conditionEnabled(c) && (
          <p className="wf-condition-note muted">
            Turned off: skipped
            <button
              type="button"
              onClick={() => {
                const next = { ...c };
                delete next.enabled;
                onChange(next);
              }}
            >
              Turn on
            </button>
          </p>
        )}
        {issuesAt('')}
        {available &&
          (renaming ? (
            <label className="wf-field">
              Name on the card
              <input
                aria-label={`${row} card label`}
                value={c.label ?? ''}
                placeholder={defaultLabel}
                onChange={(e) => {
                  const next = { ...c };
                  delete next.label;
                  onChange(e.target.value === '' ? next : { ...next, label: e.target.value });
                }}
              />
            </label>
          ) : (
            <button type="button" className="wf-link-button" onClick={() => setRenaming(true)}>
              Rename on the card
            </button>
          ))}
        {!available && c.label !== undefined && (
          <p className="muted wf-condition-note">On the card: {c.label}</p>
        )}
        {issuesAt('.label')}
      </div>
      <ItemActions what="condition" i={i} n={n} onMove={onMove} onRemove={onRemove} />
    </li>
  );
}

/** A comma-separated list, kept as typed while editing. */
export function ListInput({
  label,
  value,
  placeholder,
  className,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  className?: string;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      aria-label={label}
      className={className}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
