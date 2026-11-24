// The session panel's Links tab (11-web-ui §Detail panel): the pull requests, the links the agent
// and the human posted, the ticket's links, what the agent read and the files it changed, with
// where the session runs. Built from the loaded conversation by `collectLinks` (links.ts).
import { baseLabel, type OutputChunk, type SessionDetail } from '@conductor/shared';
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { HistoryNotice } from '../board/hooks.js';
import { collectLinks, isEmpty, type LinkItem, type PrItem } from './links.js';
import { buildEntries } from './OutputLog.js';
import { timeFormat } from './transitions.js';
import './LinksTab.css';

interface LinksTabProps {
  detail: SessionDetail;
  output: readonly OutputChunk[];
  history: HistoryNotice | null;
}

const PR_SOURCE: Record<PrItem['source'], string> = {
  conductor: "Conductor's PR",
  agent: 'Mentioned by the agent',
  you: 'Mentioned by you',
  ticket: 'In the ticket',
  read: 'Seen by the agent',
};

const when = (at: string | null) => (at === null ? null : timeFormat.format(new Date(at)));

export function LinksTab({ detail, output, history }: LinksTabProps) {
  const index = useMemo(
    () => collectLinks({ entries: buildEntries(output), detail }),
    [output, detail],
  );
  const { card } = detail;
  const base = baseLabel(card.base, card.base_ref ?? null, detail.workflow, card.kind ?? null);
  const repoUrl = /^github\.com\/[\w.-]+\/[\w.-]+$/.test(card.repo) ? `https://${card.repo}` : null;

  return (
    <div className="links-view">
      {isEmpty(index) && <p className="muted links-empty">No links in this session yet.</p>}
      {index.prs.length > 0 && (
        <LinkSection title="Pull requests" count={index.prs.length}>
          <ul className="links-list">
            {index.prs.map((pr) => (
              <li key={pr.url}>
                <ExternalLink href={pr.url}>
                  {pr.owner}/{pr.repo}#{pr.number}
                </ExternalLink>
                <span className={`chip pr-source pr-source-${pr.source}`}>
                  {PR_SOURCE[pr.source]}
                </span>
                {pr.state && pr.state !== 'open' && (
                  <span className={`chip pr-state pr-state-${pr.state}`}>
                    {pr.state === 'merged' ? 'Merged' : 'Closed'}
                  </span>
                )}
                <When at={pr.firstAt} />
              </li>
            ))}
          </ul>
        </LinkSection>
      )}
      <Links title="From the agent" items={index.agent} />
      <Links title="From you" items={index.you} />
      <Links title="In the ticket" items={index.ticket} />
      {(index.read.length > 0 || index.searches.length > 0) && (
        <LinkSection
          title="Pages the agent read"
          count={index.read.length + index.searches.length}
          collapsed
        >
          {index.searches.length > 0 && (
            <ul className="links-list links-searches" aria-label="Searches">
              {index.searches.map((s, i) => (
                <li key={`${s.at}-${i}`}>
                  <span className="muted">Searched </span>“{s.query}”
                  <When at={s.at} />
                </li>
              ))}
            </ul>
          )}
          <LinkRows items={index.read} />
        </LinkSection>
      )}
      {index.files.length > 0 && (
        <LinkSection title="Files changed" count={index.files.length} collapsed>
          <ul className="links-list links-files">
            {index.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className="muted links-ops">
                  {f.ops.map((o) => (o === 'write' ? 'written' : 'edited')).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </LinkSection>
      )}
      <LinkSection title="Where it runs">
        <dl className="links-where">
          <dt>Repo</dt>
          <dd>{repoUrl ? <ExternalLink href={repoUrl}>{card.repo}</ExternalLink> : card.repo}</dd>
          {detail.branch !== null && (
            <>
              <dt>Branch</dt>
              <dd>
                <code>{detail.branch}</code>
              </dd>
            </>
          )}
          <dt>Base</dt>
          <dd>{base.text}</dd>
          {detail.worktree_path !== null && (
            <>
              <dt>Worktree</dt>
              <dd>
                <code>{detail.worktree_path}</code>
              </dd>
            </>
          )}
        </dl>
      </LinkSection>
      <p className="muted links-note">
        From this session&apos;s conversation
        {detail.output_complete === false && history?.kind !== 'loaded'
          ? ". The start of the conversation couldn't be loaded, so early links may be missing."
          : '.'}
      </p>
    </div>
  );
}

function Links({ title, items }: { title: string; items: readonly LinkItem[] }) {
  if (items.length === 0) return null;
  return (
    <LinkSection title={title} count={items.length}>
      <LinkRows items={items} />
    </LinkSection>
  );
}

function LinkRows({ items }: { items: readonly LinkItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="links-list">
      {items.map((l) => (
        <li key={l.url}>
          <ExternalLink href={l.url}>{l.label}</ExternalLink>
          {l.label !== l.url && <span className="muted links-url">{l.url}</span>}
          {l.expired && <span className="chip pr-state-closed">Expired</span>}
          {l.count > 1 && (
            <span className="muted links-count" aria-label={`mentioned ${l.count} times`}>
              ×{l.count}
            </span>
          )}
          <When at={l.firstAt} />
        </li>
      ))}
    </ul>
  );
}

function When({ at }: { at: string | null }) {
  const text = when(at);
  return text === null ? null : (
    <time className="muted links-when" dateTime={at!}>
      {text}
    </time>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="links-link">
      {children}
    </a>
  );
}

/** One section: an h3 with its count; `collapsed` ones open on a click. */
function LinkSection({
  title,
  count,
  collapsed = false,
  children,
}: {
  title: string;
  count?: number;
  collapsed?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsed);
  const bodyId = useId();
  const heading = (
    <>
      {title}
      {count !== undefined && <span className="links-section-count">{count}</span>}
    </>
  );
  return (
    <section className="links-section" aria-label={title}>
      <h3>
        {collapsed ? (
          <button
            type="button"
            className="links-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="proposals-chevron" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {heading}
          </button>
        ) : (
          heading
        )}
      </h3>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
