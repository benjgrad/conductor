// ADR-0037 P5: an instruction field (`on_unmet.instruction`, later a watch's
// `on_broken.instruction`): its own text, or a saved instruction picked from the workflow's
// `instructions`, stored as a `$instructions.<slug>` ref. A ref shows its text read-only.
import { instructionRef, type WorkflowDefinition } from '@conductor/shared';
import { BasePreview } from './BasePreview.js';
import { instructionsOf, refOf } from './instructions.js';

interface InstructionFieldProps {
  definition: WorkflowDefinition;
  id: string;
  value: string | undefined;
  placeholder?: string;
  /** undefined: no instruction. */
  onChange: (next: string | undefined) => void;
}

const OWN = '';

export function InstructionField({
  definition,
  id,
  value,
  placeholder,
  onChange,
}: InstructionFieldProps) {
  const saved = instructionsOf(definition);
  const ref = value === undefined ? null : instructionRef(value);
  const slug = ref?.slug ?? null;
  const text = slug !== null ? (definition.instructions?.[slug] ?? '') : (value ?? '');
  return (
    <div className="wf-instruction">
      {(saved.length > 0 || ref !== null) && (
        <select
          aria-label="Use a saved instruction"
          value={slug ?? OWN}
          onChange={(e) => {
            const next = e.target.value;
            // "Write your own" keeps the saved text as a starting point.
            if (next === OWN) onChange(text.trim() === '' ? undefined : text);
            else onChange(refOf(next));
          }}
        >
          <option value={OWN}>Write your own</option>
          {saved.map(([k]) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
          {slug !== null && !saved.some(([k]) => k === slug) && (
            <option value={slug}>{slug} (missing)</option>
          )}
        </select>
      )}
      <textarea
        id={id}
        rows={3}
        value={text}
        readOnly={ref !== null}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim() === '' ? undefined : e.target.value)}
      />
      <BasePreview text={text} />
      {slug !== null && (
        <span className="muted wf-instruction-note">
          Saved instruction <code>{slug}</code>: edit it under Instructions.
        </span>
      )}
    </div>
  );
}
