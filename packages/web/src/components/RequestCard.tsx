// UXR-35 (11-web-ui §Requests): the one frame of a request waiting on a human, inline in the chat.
// Its kind sets the colour (question blue, review green, permission violet, failure red: the
// only red) and the chip names it, so colour is never the only cue.
import type { ReactNode } from 'react';
import type { RequestTone } from './request-preview.js';

interface RequestCardProps {
  tone: RequestTone;
  /** The chip: "Question", "Ready for review", "Needs permission", "Step failed"… */
  label: string;
  /** Who asks, muted after the chip: "Avery asks", "Olga finished". */
  who: ReactNode;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

export function RequestCard({
  tone,
  label,
  who,
  ariaLabel,
  className,
  children,
}: RequestCardProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={`pending request request-${tone}${className ? ` ${className}` : ''}`}
    >
      <div className="pending-head">
        <span className={`request-chip request-chip-${tone}`}>{label}</span>
        <span className="muted">{who}</span>
      </div>
      {children}
    </section>
  );
}
