// ADR-0039 (B3, FR-1): the ticket's Base: its kind's default, a base of the workflow by name, or
// a custom ref (with the branch its PR goes to, needed when the ref is a commit). Used by the New
// ticket sheet and by a Queued ticket's editor; a started ticket's base is fixed.
import {
  TicketBaseSchema,
  type BaseSpec,
  type TicketBase,
  type TicketKind,
  type WorkflowFeature,
} from '@conductor/shared';
import { useId, useState } from 'react';
import { basesAvailable, webWorkflowFeatures } from '../workflow/features.js';
import type { WorkflowBases } from './useWorkflowBases.js';

/** The value `BaseField` reports: `valid` false while a custom ref can't be stored. */
export interface BaseChoice {
  value: TicketBase | null;
  valid: boolean;
}

interface BaseFieldProps {
  value: TicketBase | null;
  onChange: (next: BaseChoice) => void;
  /** The workflow's bases and defaults; null while unknown (only Default and Custom). */
  workflow: WorkflowBases | null;
  kind: TicketKind | null;
  features?: readonly WorkflowFeature[];
}

const DEFAULT = '';
const CUSTOM = '\u0000custom';

/** How a base is described in the list: `master · branch`, `hotfix · command → PR into master`. */
export function baseSpecSummary(spec: BaseSpec): string {
  if ('ref' in spec) return spec.ref === '$default_branch' ? 'default branch' : spec.ref;
  return `command${spec.pr_into !== undefined ? ` → PR into ${spec.pr_into}` : ''}`;
}

export function BaseField({
  value,
  onChange,
  workflow,
  kind,
  features = webWorkflowFeatures(),
}: BaseFieldProps) {
  const uid = useId();
  const available = basesAvailable(features);
  const [custom, setCustom] = useState(value !== null && typeof value !== 'string');
  const [ref, setRef] = useState(value !== null && typeof value !== 'string' ? value.ref : '');
  const [prInto, setPrInto] = useState(
    value !== null && typeof value !== 'string' ? (value.pr_into ?? '') : '',
  );
  const names = Object.keys(workflow?.bases ?? {});
  const defaultName = kind !== null ? workflow?.base_default?.[kind] : undefined;
  const selected = custom ? CUSTOM : typeof value === 'string' ? value : DEFAULT;

  const customChoice = (r: string, pr: string): BaseChoice => {
    const raw = { ref: r.trim(), ...(pr.trim() !== '' ? { pr_into: pr.trim() } : {}) };
    const parsed = TicketBaseSchema.safeParse(raw);
    return parsed.success ? { value: parsed.data, valid: true } : { value: null, valid: false };
  };
  const problem = (() => {
    if (!custom || ref.trim() === '') return null;
    const parsed = TicketBaseSchema.safeParse({
      ref: ref.trim(),
      ...(prInto.trim() !== '' ? { pr_into: prInto.trim() } : {}),
    });
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'not a valid ref');
  })();

  return (
    <div className="base-field wide">
      <label htmlFor={`${uid}-base`}>Base</label>
      <select
        id={`${uid}-base`}
        value={selected}
        disabled={!available}
        aria-describedby={!available ? `${uid}-note` : undefined}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            setCustom(true);
            onChange(customChoice(ref, prInto));
          } else {
            setCustom(false);
            onChange({ value: v === DEFAULT ? null : v, valid: true });
          }
        }}
      >
        <option value={DEFAULT}>
          Default for this kind{defaultName !== undefined ? ` (${defaultName})` : ''}
        </option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n} · {baseSpecSummary(workflow!.bases![n]!)}
          </option>
        ))}
        {typeof value === 'string' && !names.includes(value) && workflow !== null && (
          <option value={value}>{value} (not in the workflow)</option>
        )}
        {typeof value === 'string' && workflow === null && <option value={value}>{value}</option>}
        <option value={CUSTOM}>Custom ref…</option>
      </select>
      {!available && (
        <p id={`${uid}-note`} className="muted base-field-note">
          Not available yet: tickets start from the repo’s default branch.
        </p>
      )}
      {custom && available && (
        <div className="base-field-custom">
          <label>
            Ref
            <input
              className="mono"
              value={ref}
              placeholder="branch or commit sha"
              aria-invalid={problem !== null}
              onChange={(e) => {
                setRef(e.target.value);
                onChange(customChoice(e.target.value, prInto));
              }}
            />
          </label>
          <label>
            PR into
            <input
              className="mono"
              value={prInto}
              placeholder="optional; needed for a sha"
              onChange={(e) => {
                setPrInto(e.target.value);
                onChange(customChoice(ref, e.target.value));
              }}
            />
          </label>
          {problem !== null && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
