// ADR-0038: the pages an agent attached to its result (a mockup, a diagram, a data walkthrough),
// under the plan in Plan review and in the Plan sheet. A page this conductor hosts (`/p/<id>` on
// this origin) opens inline in a sandboxed iframe: `allow-scripts` only, never
// `allow-same-origin`, so its script can't reach the app or the session cookie (the server's CSP
// sandboxes it too). Any other host is a link: the app's CSP would block framing it anyway.
import { hostedPageId, type SessionDetail, type TicketPage } from '@conductor/shared';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';
import './PlanPages.css';

/** Exactly the iframe's sandbox: scripts run, in an opaque origin. */
export const PAGE_SANDBOX = 'allow-scripts';

/** The page id when `url` is a page this app's origin hosts, else null. */
export function embeddablePageId(url: string, origin: string): string | null {
  return hostedPageId(url, origin);
}

/** Whether the page opens inline: ours, and not expired. */
export function isEmbeddable(page: Pick<TicketPage, 'url' | 'expired'>, origin: string): boolean {
  return !page.expired && embeddablePageId(page.url, origin) !== null;
}

/** The pages `state` attached (the plan's state); every page when `state` is null. */
export function pagesOf(detail: Pick<SessionDetail, 'pages'>, state: string | null): TicketPage[] {
  const all = detail.pages ?? [];
  return state === null ? all : all.filter((p) => p.state === state);
}

function expiryText(p: TicketPage): string | null {
  if (p.expires_at === null) return null;
  const when = new Date(p.expires_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return p.expired ? `expired ${when}` : `until ${when}`;
}

export function PlanPages({
  pages,
  api,
  origin = window.location.origin,
}: {
  pages: readonly TicketPage[];
  /** For Share; absent = no Share button. */
  api?: ApiClient;
  origin?: string;
}) {
  if (pages.length === 0) return null;
  return (
    <section className="plan-pages" aria-label="Pages">
      <h4 className="plan-pages-title">Pages</h4>
      <ul className="plan-pages-list">
        {pages.map((p) => (
          <PageItem key={p.url} page={p} origin={origin} {...(api ? { api } : {})} />
        ))}
      </ul>
    </section>
  );
}

function PageItem({ page, origin, api }: { page: TicketPage; origin: string; api?: ApiClient }) {
  const id = embeddablePageId(page.url, origin);
  const embed = isEmbeddable(page, origin);
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<{ url: string } | { error: string } | null>(null);
  const expiry = expiryText(page);
  const onShare = async () => {
    if (!api || id === null) return;
    try {
      const { share_url } = await api.sharePage(id);
      setShare({ url: share_url });
      await navigator.clipboard?.writeText(share_url).catch(() => undefined);
    } catch (e) {
      setShare({ error: e instanceof Error ? e.message : 'Share failed' });
    }
  };
  return (
    <li className={`plan-page${page.expired ? ' expired' : ''}`}>
      <div className="plan-page-head">
        {page.expired ? (
          <span className="plan-page-name">{page.title}</span>
        ) : (
          <a
            className="plan-page-name"
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {page.title}
          </a>
        )}
        {expiry !== null && <span className="muted plan-page-expiry">{expiry}</span>}
        {embed && (
          <button
            type="button"
            className="link"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide' : 'Show here'}
          </button>
        )}
        {embed && api && (
          <button type="button" className="link" onClick={() => void onShare()}>
            Share
          </button>
        )}
      </div>
      {share !== null &&
        ('url' in share ? (
          <p className="plan-page-share">
            Link copied (opens without signing in): <code>{share.url}</code>
          </p>
        ) : (
          <p className="plan-page-share error">{share.error}</p>
        ))}
      {embed && open && (
        <iframe
          className="plan-page-frame"
          title={page.title}
          src={page.url}
          sandbox={PAGE_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      )}
    </li>
  );
}
