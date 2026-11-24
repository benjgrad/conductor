// The Links tab (11-web-ui §Detail panel): every link, pull request and file the session's
// conversation mentions, grouped by who posted it, worked out from what the panel already loaded.
// Only http(s) URLs are kept. Conductor's own PR comes from `card.pr_url` (validated server-side,
// ADR-0010); a PR found in text is only ever "mentioned", never conductor's.
import type { SessionDetail } from '@conductor/shared';
import { shortener, type Entry, type ToolCall } from './OutputLog.js';

export type LinkSource = 'agent' | 'you' | 'ticket' | 'read';
export type PrSource = 'conductor' | LinkSource;

export interface LinkItem {
  url: string;
  /** The markdown link text (or a page's title) when there is one, else the URL. */
  label: string;
  /** When it was first mentioned; null when unknown. */
  firstAt: string | null;
  /** How many times it was mentioned. */
  count: number;
  /** An attached page (ADR-0038) whose hosted copy no longer opens. */
  expired?: boolean;
}

export interface PrItem {
  url: string;
  owner: string;
  repo: string;
  number: number;
  source: PrSource;
  /** Conductor's PR only: merged, closed or open. */
  state?: 'merged' | 'closed' | 'open';
  firstAt: string | null;
}

export interface SearchItem {
  query: string;
  at: string;
}

export interface FileItem {
  path: string;
  ops: ('edit' | 'write')[];
  firstAt: string;
}

export interface LinkIndex {
  prs: PrItem[];
  agent: LinkItem[];
  you: LinkItem[];
  ticket: LinkItem[];
  read: LinkItem[];
  searches: SearchItem[];
  files: FileItem[];
}

export interface CollectInput {
  entries: readonly Entry[];
  detail: Pick<
    SessionDetail,
    'card' | 'ticket_body' | 'input_requests' | 'pages' | 'worktree_path'
  >;
}

// ---------------------------------------------------------------- URL extraction

const MD_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'`\][{}|\\^]+/g;
const TRAILING = /[.,;:!?'"*_~>]+$/;
const PR_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface FoundUrl {
  url: string;
  label: string | null;
}

/** Strip trailing punctuation and a closing paren that has no opening one in the URL. */
function trimUrl(raw: string): string {
  let u = raw;
  for (;;) {
    const before = u;
    u = u.replace(TRAILING, '');
    if (u.endsWith(')') && count(u, '(') < count(u, ')')) u = u.slice(0, -1);
    if (u === before) return u;
  }
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** A well-formed http(s) URL, or null (javascript:, file:, credentials and garbage are dropped). */
export function safeHttpUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '' || u.hostname === '') return null;
  return raw;
}

/** The http(s) URLs in a text: markdown links (with their text) first, then bare URLs. */
export function extractUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  let rest = text;
  for (const m of text.matchAll(MD_LINK)) {
    const url = safeHttpUrl(trimUrl(m[2]!));
    if (url !== null) out.push({ url, label: m[1]!.trim() || null });
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(BARE_URL)) {
    const url = safeHttpUrl(trimUrl(m[0]));
    if (url !== null) out.push({ url, label: null });
  }
  return out;
}

/** Dedupe key: no fragment, no trailing slash. */
export function urlKey(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/+$/, '');
}

/** A GitHub pull request URL (any sub-page) → its parts and canonical URL. */
export function parsePr(
  url: string,
): { owner: string; repo: string; number: number; url: string } | null {
  const m = PR_RE.exec(url);
  if (!m) return null;
  const [, owner, repo, n] = m;
  return {
    owner: owner!,
    repo: repo!,
    number: Number(n),
    url: `https://github.com/${owner}/${repo}/pull/${n}`,
  };
}

/** Every string in a JSON-ish value (tool inputs, results), depth-limited. */
function strings(v: unknown, depth = 0): string[] {
  if (typeof v === 'string') return [v];
  if (depth > 4 || v === null || typeof v !== 'object') return [];
  return Object.values(v as Record<string, unknown>).flatMap((x) => strings(x, depth + 1));
}

// ---------------------------------------------------------------- collection

const PRECEDENCE: Record<PrSource, number> = { conductor: 0, agent: 1, you: 2, ticket: 3, read: 4 };
const ASK_USER = 'mcp__conductor__ask_user';
const COMPLETE_STATE = 'mcp__conductor__complete_state';
const FILE_TOOLS: Record<string, 'edit' | 'write'> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
};

interface Mention {
  url: string;
  label: string | null;
  source: LinkSource;
  at: string | null;
  expired?: boolean;
}

function isSearchTool(name: string): boolean {
  return name === 'WebSearch' || /(^|_)search$/.test(name);
}

export function collectLinks({ entries, detail }: CollectInput): LinkIndex {
  const mentions: Mention[] = [];
  const prMentions: { url: string; source: LinkSource; at: string | null }[] = [];
  const searches: SearchItem[] = [];
  const files = new Map<string, FileItem>();
  const short = shortener(detail.worktree_path);

  const fromText = (text: string, source: LinkSource, at: string | null) => {
    for (const f of extractUrls(text)) mentions.push({ ...f, source, at });
  };
  const prsFromText = (text: string, source: LinkSource, at: string | null) => {
    for (const f of extractUrls(text))
      if (parsePr(f.url)) mentions.push({ url: f.url, label: null, source, at });
  };

  // The ticket: its body, else the opening prompt (older servers).
  const ticketEntry = entries.find((e) => e.kind === 'user' && e.ticket === true);
  const body = detail.ticket_body ?? (ticketEntry?.kind === 'user' ? ticketEntry.text : null);
  if (body) fromText(body, 'ticket', detail.card.created_at);

  for (const e of entries) {
    switch (e.kind) {
      case 'text':
        fromText(e.text, 'agent', e.ts);
        break;
      case 'user':
        if (!e.ticket) fromText(e.text, 'you', e.ts);
        break;
      case 'tool':
        tool(e.call, e.result, e.ts);
        break;
      default:
        break;
    }
  }

  function tool(call: ToolCall, result: string | null, at: string) {
    const input = call.input ?? {};
    if (call.name === ASK_USER) {
      for (const s of strings(input)) fromText(s, 'agent', at);
      return;
    }
    if (call.name === COMPLETE_STATE) {
      for (const s of strings(input.result)) fromText(s, 'agent', at);
      return;
    }
    if (call.name.startsWith('mcp__conductor__')) return;
    const op = FILE_TOOLS[call.name];
    const path = input.file_path ?? input.notebook_path;
    if (op && typeof path === 'string') {
      const p = short(path);
      const f = files.get(p) ?? { path: p, ops: [], firstAt: at };
      if (!f.ops.includes(op)) f.ops.push(op);
      files.set(p, f);
      return;
    }
    if (isSearchTool(call.name) && typeof input.query === 'string' && input.query.trim() !== '') {
      searches.push({ query: input.query.trim(), at });
    }
    for (const s of strings(input)) fromText(s, 'read', at);
    // A PR a command printed (`gh pr create`), e.g. in a Bash result.
    if (result) prsFromText(result, 'agent', at);
  }

  // The agent's attached pages (ADR-0038).
  for (const p of detail.pages ?? []) {
    const url = safeHttpUrl(p.url);
    if (url !== null) {
      mentions.push({ url, label: p.title, source: 'agent', at: null, expired: p.expired });
    }
  }

  // Answers to the session's questions, when the chat didn't carry them (TD-085 pairing).
  for (const r of detail.input_requests ?? []) {
    if (r.answer) fromText(r.answer, 'you', r.answered_at);
  }

  // ---- pull requests
  const prs = new Map<string, PrItem>();
  const conductorPr = detail.card.pr_url ? parsePr(detail.card.pr_url) : null;
  if (conductorPr) {
    const pr = detail.card.pr;
    prs.set(conductorPr.url, {
      ...conductorPr,
      source: 'conductor',
      state: pr?.merged ? 'merged' : pr?.closed ? 'closed' : 'open',
      firstAt: null,
    });
  }
  const links: Mention[] = [];
  for (const m of mentions) {
    if (parsePr(m.url)) prMentions.push({ url: m.url, source: m.source, at: m.at });
    else links.push(m);
  }
  for (const m of prMentions) {
    const p = parsePr(m.url)!;
    const had = prs.get(p.url);
    if (!had) {
      prs.set(p.url, { ...p, source: m.source, firstAt: m.at });
      continue;
    }
    if (PRECEDENCE[m.source] < PRECEDENCE[had.source]) had.source = m.source;
    had.firstAt = earliest(had.firstAt, m.at);
  }

  // ---- plain links: one row per URL, under the highest-precedence source that mentioned it.
  const byKey = new Map<string, { item: LinkItem; source: LinkSource }>();
  for (const m of links) {
    const key = urlKey(m.url);
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, {
        item: {
          url: m.url,
          label: m.label ?? m.url,
          firstAt: m.at,
          count: 1,
          ...(m.expired ? { expired: true } : {}),
        },
        source: m.source,
      });
      continue;
    }
    had.item.count += 1;
    had.item.firstAt = earliest(had.item.firstAt, m.at);
    if (had.item.label === had.item.url && m.label) had.item.label = m.label;
    if (PRECEDENCE[m.source] < PRECEDENCE[had.source]) had.source = m.source;
  }
  const group = (s: LinkSource) =>
    [...byKey.values()].filter((v) => v.source === s).map((v) => v.item);

  return {
    prs: [...prs.values()],
    agent: group('agent'),
    you: group('you'),
    ticket: group('ticket'),
    read: group('read'),
    searches,
    files: [...files.values()],
  };
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** Nothing at all to show (the tab's empty state). */
export function isEmpty(i: LinkIndex): boolean {
  return (
    i.prs.length +
      i.agent.length +
      i.you.length +
      i.ticket.length +
      i.read.length +
      i.searches.length +
      i.files.length ===
    0
  );
}
