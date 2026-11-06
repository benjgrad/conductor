// ADR-0037 P5: a human button's saved instructions (`presets`), as chips above its text box. A
// chip fills the box with the instruction's text, which stays editable; the post is unchanged.
import type { HumanTransitionOption } from '@conductor/shared';

export type Preset = NonNullable<HumanTransitionOption['presets']>[number];

interface PresetChipsProps {
  presets: readonly Preset[] | undefined;
  disabled?: boolean;
  onPick: (text: string) => void;
}

export function PresetChips({ presets, disabled, onPick }: PresetChipsProps) {
  if (presets === undefined || presets.length === 0) return null;
  return (
    <div className="preset-chips" role="group" aria-label="Saved instructions">
      {presets.map((p) => (
        <button
          key={p.slug}
          type="button"
          className="preset-chip"
          disabled={disabled}
          title={p.text}
          onClick={() => onPick(p.text)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
