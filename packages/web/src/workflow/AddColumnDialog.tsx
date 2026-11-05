import { IMPLEMENT_TEMPLATE, type WorkflowDefinition } from '@conductor/shared';
import { useEffect, useId, useRef, useState } from 'react';
import {
  addColumnProblem,
  columnTitle,
  LANE_KIND_ICONS,
  LANE_KIND_LABELS,
  NEW_COLUMN_KINDS,
  PROMPT_TEMPLATES,
  slugFromTitle,
  type NewColumn,
  type NewColumnKind,
} from './columns.js';

// UXR-67: add a column after another one: its title, what kind of column it is, and (an agent
// column) its work. The state name comes from the title and is fixed once saved: agents report it
// and tickets sit in it. Nothing leads to the new column yet; the designer says so until a
// transition does.

export interface AddColumnDialogProps {
  definition: WorkflowDefinition;
  /** The lane it goes after (a state, or QUEUED_LANE for the first column). */
  after: string;
  onAdd: (col: NewColumn) => void;
  onCancel: () => void;
}

const KIND_TEXT: Record<NewColumnKind, string> = {
  agent: 'An agent works on the ticket',
  person: 'A person answers or approves',
  waiting: 'Waits until someone approves',
  end: 'Final: the ticket is done',
};

export function AddColumnDialog({ definition, after, onAdd, onCancel }: AddColumnDialogProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NewColumnKind>('agent');
  const [prompt, setPrompt] = useState<string>(IMPLEMENT_TEMPLATE);
  const [model, setModel] = useState('');
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const problem = addColumnProblem(definition, kind);
  const blank = title.trim() === '';
  const name = slugFromTitle(definition, blank ? 'column' : title);
  const submit = () => {
    if (blank || problem !== null) return;
    onAdd({
      title: title.trim(),
      kind,
      after,
      ...(kind === 'agent' ? { prompt, model } : {}),
    });
  };
  return (
    <div className="wf-review-backdrop" onClick={onCancel}>
      <div
        className="wf-review-dialog wf-add-column"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={`${uid}-title`}>Add a column</h3>
        <p className="muted wf-note">After {columnTitle(definition, after)}.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="wf-field">
            Title
            <input
              ref={titleRef}
              value={title}
              maxLength={60}
              placeholder="e.g. Needs design"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <p className="muted wf-note" aria-live="polite">
            Name <code>{name}</code>. The name can’t change after you save.
          </p>
          <fieldset className="wf-field wf-kinds">
            <legend>Kind</legend>
            {NEW_COLUMN_KINDS.map((k) => (
              <label key={k} className={`wf-kind wf-lane-kind-${k}`}>
                <input
                  type="radio"
                  name={`${uid}-kind`}
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span aria-hidden="true">{LANE_KIND_ICONS[k]}</span> {LANE_KIND_LABELS[k]}
                <span className="muted"> · {KIND_TEXT[k]}</span>
              </label>
            ))}
          </fieldset>
          {kind === 'agent' && (
            <div className="wf-unmet">
              <label htmlFor={`${uid}-prompt`}>Prompt template</label>
              <input
                id={`${uid}-prompt`}
                list={`${uid}-templates`}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <datalist id={`${uid}-templates`}>
                {PROMPT_TEMPLATES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <label htmlFor={`${uid}-model`}>Model</label>
              <input
                id={`${uid}-model`}
                value={model}
                placeholder="account default"
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          )}
          {problem !== null && (
            <p className="wf-field-error" role="alert">
              {problem}
            </p>
          )}
          <p className="muted wf-note">
            Nothing leads to the new column yet: draw a transition into it from another column.
          </p>
          <div className="wf-review-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={blank || problem !== null}>
              Add column
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
