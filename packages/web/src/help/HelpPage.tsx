import type { MouseEvent, ReactNode } from 'react';
import { Markdown } from '../components/markdown.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import { goTo } from '../nav.js';
import guide from './add-a-machine.md?raw';
import './help.css';

// UX-8: the add-a-machine guide as a page of the app. The text is written once, in
// add-a-machine.md (docs/setup/add-a-machine.md is a copy, checked by a test). The page renders
// outside the app shell, like /signin: it works signed out, for any user, and calls no API.

/** The host the markdown uses in its examples; the page shows its own origin instead. */
export const EXAMPLE_ORIGIN = 'https://conductor.example.com';

/** The guide's markdown with this server's origin in the examples. */
export function guideText(origin: string): string {
  return guide.replaceAll(EXAMPLE_ORIGIN, origin);
}

/** `/help/add-a-machine`. */
export function HelpPage() {
  return (
    <div className="help-page">
      <header className="help-head">
        <span className="help-brand">Conductor · Help</span>
        <a href="/" onClick={(e) => followInApp(e, '/')}>
          Back to conductor
        </a>
      </header>
      <main className="help-body">
        <Markdown text={guideText(window.location.origin)} headings="semantic" />
      </main>
    </div>
  );
}

/** A link to the guide that moves in-app (no reload); modified clicks open as usual. */
export function HelpLink({
  children,
  className,
  title,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string | undefined;
  /** UX-11: the top bar's compact mode names the icon-only link with these. */
  title?: string | undefined;
  'aria-label'?: string | undefined;
}) {
  return (
    <a
      href={SETUP_GUIDE_URL}
      className={className}
      title={title}
      aria-label={ariaLabel}
      onClick={(e) => followInApp(e, SETUP_GUIDE_URL)}
    >
      {children}
    </a>
  );
}

/** A plain click opens `url` in the app (no reload); a modified click keeps the browser's default. */
export function followInApp(e: MouseEvent<HTMLAnchorElement>, url: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goTo(url);
}
