import type { MouseEvent } from 'react';
import { CONNECT_CLAUDE_URL } from '../help/HelpPage.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import { goTo } from '../nav.js';
import { FEATURES, PITCH, STEPS, TAGLINE } from './content.js';
import './landing.css';

/** The landing page's path: where a signed-out visit to `/` goes (App). */
export const LANDING_PATH = '/welcome';

/** Follow an in-app link without a reload (a modified click opens a tab as usual). */
function inApp(e: MouseEvent<HTMLAnchorElement>, to: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goTo(to);
}

interface PreviewCard {
  title: string;
  repo: string;
  badge?: string;
  tone?: 'attention' | 'ok' | 'info';
}

/** The illustration: a small board, drawn with the app's own card style. Decorative only. */
const PREVIEW: { column: string; cards: PreviewCard[] }[] = [
  { column: 'Queued', cards: [{ title: 'Add CSV export to reports', repo: 'acme/web' }] },
  {
    column: 'Planning',
    cards: [
      { title: 'Rate-limit the public API', repo: 'acme/api', badge: 'mac-mini', tone: 'info' },
    ],
  },
  {
    column: 'Needs input',
    cards: [
      {
        title: 'Migrate sessions to Redis',
        repo: 'acme/api',
        badge: 'Which TTL? Recommends 7 days',
        tone: 'attention',
      },
    ],
  },
  {
    column: 'In review',
    cards: [
      { title: 'Fix flaky checkout test', repo: 'acme/web', badge: 'Checks pass', tone: 'ok' },
    ],
  },
];

/**
 * The public landing page (`/welcome`): what conductor is, its main features and how to start.
 * Signed out and API-free, like the help pages. Sign-up is by invite, so its call to action is
 * Sign in, with a word on invites.
 */
export function Landing() {
  return (
    <div className="landing">
      <header className="landing-bar">
        <a className="landing-brand" href={LANDING_PATH} onClick={(e) => inApp(e, LANDING_PATH)}>
          <span className="landing-logo" aria-hidden="true">
            ◆
          </span>
          Conductor
        </a>
        <nav aria-label="Landing">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a className="landing-button ghost" href="/signin" onClick={(e) => inApp(e, '/signin')}>
            Sign in
          </a>
        </nav>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-text">
            <p className="landing-eyebrow">Agent orchestration for Claude Code</p>
            <h1 id="landing-title">{TAGLINE}</h1>
            <p className="landing-pitch">{PITCH}</p>
            <div className="landing-cta">
              <a className="landing-button" href="/signin" onClick={(e) => inApp(e, '/signin')}>
                Sign in
              </a>
              <a className="landing-button ghost" href="#how">
                See how it works
              </a>
            </div>
            <p className="landing-invite">
              Conductor is invite-only. Got an invite? Open the link in your email to create your
              account.
            </p>
          </div>
          <div className="landing-preview" aria-hidden="true">
            {PREVIEW.map((col) => (
              <div className="landing-col" key={col.column}>
                <p className="landing-col-title">{col.column}</p>
                {col.cards.map((c) => (
                  <div className="landing-card" key={c.title}>
                    <p className="landing-card-title">{c.title}</p>
                    <p className="landing-card-repo">{c.repo}</p>
                    {c.badge && (
                      <span className={`landing-chip ${c.tone ?? 'info'}`}>{c.badge}</span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="landing-section" aria-labelledby="features-title">
          <h2 id="features-title">Everything an agent needs, nothing you have to babysit</h2>
          <ul className="landing-features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" className="landing-section" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="landing-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="landing-step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Ready when your invite is</h2>
          <p>Sign in to your board, or read how to add your first machine.</p>
          <div className="landing-cta">
            <a className="landing-button" href="/signin" onClick={(e) => inApp(e, '/signin')}>
              Sign in
            </a>
            <a
              className="landing-button ghost"
              href={SETUP_GUIDE_URL}
              onClick={(e) => inApp(e, SETUP_GUIDE_URL)}
            >
              Add a machine
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <span>Conductor</span>
        <a href={SETUP_GUIDE_URL} onClick={(e) => inApp(e, SETUP_GUIDE_URL)}>
          Add a machine
        </a>
        <a href={CONNECT_CLAUDE_URL} onClick={(e) => inApp(e, CONNECT_CLAUDE_URL)}>
          Connect Claude
        </a>
      </footer>
    </div>
  );
}
