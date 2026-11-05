import { ArrowLeft } from 'lucide-react';
import { Fragment } from 'react';

// The head of the arrow and transition panels (UXR-66): a back arrow to the parent, a breadcrumb
// (Column › arrow › Transition) whose earlier crumbs open those panels, the title and a close ×.

export interface Crumb {
  label: string;
  /** Omitted for the last crumb (the panel itself). */
  onClick?: () => void;
}

export function EditorHead({
  crumbs,
  title,
  back,
  closeLabel,
  onClose,
  fullScreen = false,
}: {
  crumbs: Crumb[];
  title: string;
  back: { label: string; onClick: () => void };
  closeLabel: string;
  onClose: () => void;
  /** UXR-44: on a phone the panel is full-screen; its 44 px Back replaces the ×. */
  fullScreen?: boolean;
}) {
  return (
    <>
      <div className="wf-editor-head">
        <button type="button" className="wf-back" aria-label={back.label} onClick={back.onClick}>
          {fullScreen ? <ArrowLeft size={20} aria-hidden="true" /> : '←'}
        </button>
        <nav aria-label="Breadcrumb" className="wf-crumbs">
          <ol>
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <li aria-hidden="true" className="wf-crumb-sep">
                    ›
                  </li>
                )}
                <li>
                  {c.onClick ? (
                    <button type="button" className="wf-crumb" onClick={c.onClick}>
                      {c.label}
                    </button>
                  ) : (
                    <span aria-current="page">{c.label}</span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
        {!fullScreen && (
          <button type="button" onClick={onClose} aria-label={closeLabel}>
            ×
          </button>
        )}
      </div>
      <h3>{title}</h3>
    </>
  );
}
