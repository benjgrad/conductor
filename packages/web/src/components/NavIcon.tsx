import type { LucideIcon } from 'lucide-react';

/**
 * UX-11: one size, stroke and alignment for every top-bar icon. Decorative: the control's label
 * (or its `aria-label` in compact mode) names it. Lucide strokes with `currentColor`, so the icon
 * follows the text colour in both themes and on the active (`aria-current`) tab.
 */
export function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon className="nav-icon" size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
  );
}
