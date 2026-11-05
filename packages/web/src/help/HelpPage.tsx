import type { MouseEvent, ReactNode } from 'react';
import { Markdown } from '../components/markdown.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import { goTo } from '../nav.js';
import addMachine from './add-a-machine.md?raw';
import connectClaude from './connect-claude.md?raw';
import repoChecks from './repo-checks.md?raw';
import './help.css';

// UX-8: the add-a-machine guide as a page of the app. The text is written once, in
// add-a-machine.md (docs/setup/add-a-machine.md is a copy, checked by a test). The page renders
// outside the app shell, like /signin: it works signed out, for any user, and calls no API.
// The Connect Claude (MCP) guide is a second page of the same kind, with docs/setup/connect-claude.md.

/** The MCP setup guide (ADR-0028), linked from the account menu. */
export const CONNECT_CLAUDE_URL = '/help/connect-claude';

/** What a repo's own checks are and how they run, linked from the Repo checks page. */
export const REPO_CHECKS_HELP_URL = '/help/repo-checks';

const GUIDES: Readonly<Record<string, string>> = {
  [SETUP_GUIDE_URL]: addMachine,
  [CONNECT_CLAUDE_URL]: connectClaude,
  [REPO_CHECKS_HELP_URL]: repoChecks,
};

/** Whether `pathname` is one of the help pages. */
export const isHelpPath = (pathname: string): boolean => Object.hasOwn(GUIDES, pathname);

/** The host the markdown uses in its examples; the page shows its own origin instead. */
export const EXAMPLE_ORIGIN = 'https://conductor.example.com';

/** The guide's markdown with this server's origin in the examples. */
export function guideText(origin: string, path: string = SETUP_GUIDE_URL): string {
  return (GUIDES[path] ?? addMachine).replaceAll(EXAMPLE_ORIGIN, origin);
}

/** `/help/add-a-machine`, `/help/connect-claude` or `/help/repo-checks`. */
export function HelpPage({ path = SETUP_GUIDE_URL }: { path?: string }) {
  return (
    <div className="help-page">
      <header className="help-head">
        <span className="help-brand">Conductor · Help</span>
        <a href="/" onClick={(e) => followInApp(e, '/')}>
          Back to conductor
        </a>
      </header>
      <main className="help-body">
        <Markdown text={guideText(window.location.origin, path)} headings="semantic" />
      </main>
    </div>
  );
}

/** A link to a guide (default: add a machine) that moves in-app (no reload); modified clicks open as usual. */
export function HelpLink({
  href = SETUP_GUIDE_URL,
  children,
  className,
  title,
  'aria-label': ariaLabel,
}: {
  /** The help page; defaults to the add-a-machine guide. */
  href?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
  /** UX-11: the top bar's compact mode names the icon-only link with these. */
  title?: string | undefined;
  'aria-label'?: string | undefined;
}) {
  return (
    <a
      href={href}
      className={className}
      title={title}
      aria-label={ariaLabel}
      onClick={(e) => followInApp(e, href)}
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
