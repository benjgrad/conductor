// ADR-0037 P5: the workflow's saved instructions (`instructions`): add, rename the slug (every ref
// and saved reply follows), edit the text, and delete, refused while anything uses it.
import type { WorkflowDefinition } from '@conductor/shared';
import { useId, useState } from 'react';
import type { ColumnIssue } from './columns.js';
import {
  addInstruction,
  instructionSlugProblem,
  instructionsOf,
  removeInstruction,
  renameInstruction,
  setInstructionText,
  describeUse,
} from './instructions.js';

interface InstructionsEditorProps {
  definition: WorkflowDefinition;
  issues: readonly ColumnIssue[];
  readOnly?: boolean;
  onChange: (next: WorkflowDefinition) => void;
}

export function InstructionsEditor({
  definition,
  issues,
  readOnly,
  onChange,
}: InstructionsEditorProps) {
  const entries = instructionsOf(definition);
  const own = issues.filter((i) => i.path.startsWith('instructions.'));
  const [open, setOpen] = useState(false);
  const uid = useId();
  const shown = open || own.length > 0;
  return (
    <section className="wf-instructions" aria-label="Instructions">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={`${uid}-list`}
        onClick={() => setOpen(!shown)}
      >
        <span className="wf-chevron" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
        Instructions ({entries.length})
      </button>
      {shown && (
        <div id={`${uid}-list`}>
          <p className="muted wf-note">
            Saved texts that “If the requirements aren’t met” can use, and that a person’s button
            can offer as a saved reply.
          </p>
          <ol className="wf-instruction-list">
            {entries.map(([slug, text]) => (
              <InstructionRow
                // The index keeps a row (and its slug field) mounted across a rename.
                key={entries.findIndex(([k]) => k === slug)}
                definition={definition}
                slug={slug}
                text={text}
                issues={own.filter((i) => i.path === `instructions.${slug}`)}
                readOnly={readOnly === true}
                onChange={onChange}
              />
            ))}
          </ol>
          {!readOnly && (
            <button type="button" onClick={() => onChange(addInstruction(definition).definition)}>
              Add instruction
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function InstructionRow({
  definition,
  slug,
  text,
  issues,
  readOnly,
  onChange,
}: {
  definition: WorkflowDefinition;
  slug: string;
  text: string;
  issues: readonly ColumnIssue[];
  readOnly: boolean;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const uid = useId();
  const [slugText, setSlugText] = useState(slug);
  const [refused, setRefused] = useState<string[] | null>(null);
  const problem = instructionSlugProblem(definition, slug, slugText);
  const commit = () => {
    if (slugText !== slug && problem === null)
      onChange(renameInstruction(definition, slug, slugText));
  };
  return (
    <li className="wf-instruction-row">
      <label htmlFor={`${uid}-slug`}>Name</label>
      <input
        id={`${uid}-slug`}
        value={slugText}
        readOnly={readOnly}
        aria-invalid={problem !== null}
        onChange={(e) => setSlugText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <label htmlFor={`${uid}-text`}>Text</label>
      <textarea
        id={`${uid}-text`}
        rows={3}
        value={text}
        readOnly={readOnly}
        onChange={(e) => onChange(setInstructionText(definition, slug, e.target.value))}
      />
      {issues.map((i) => (
        <p key={i.message} className="error" role="alert">
          {i.message}
        </p>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="link danger"
          aria-label={`Delete instruction ${slug}`}
          onClick={() => {
            const r = removeInstruction(definition, slug);
            if (r.ok) onChange(r.definition);
            else setRefused(r.uses.map((u) => describeUse(definition, u)));
          }}
        >
          Delete
        </button>
      )}
      {refused !== null && (
        <p className="error" role="alert">
          Can’t delete “{slug}”: it is used by {refused.join(', ')}.
        </p>
      )}
    </li>
  );
}
