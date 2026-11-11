// UX-5: while conductor (not an agent) runs a gate step's checks, review or actions, the card and
// the session panel say so: "Conductor is checking · <item> (n/m)", with the live item list. The
// agent has finished its part, so its avatar shows as idle. Also the failed item of UX-4's
// "Step failed" request (its name and first error line).
import type { BoardCard, BoardChecking, BoardCheckingItem } from '@conductor/shared';
import { useId, useState } from 'react';
import { routeHash } from '../nav.js';
import './ConductorChecks.css';

type CardStep = Pick<BoardCard, 'checking' | 'badges'>;

/** In a gate step (`checking` set): the worker agent has exited; conductor owns the step. */
export function agentIdle(card: Pick<BoardCard, 'checking'>): boolean {
  return card.checking !== null;
}

/**
 * Conductor itself is running the step (checks, review, actions). Not in `conditions` or `held`:
 * there the session is `waiting_external` and the card keeps its "waiting for" checklist.
 */
export function isConductorStep(card: Pick<BoardCard, 'checking'>): boolean {
  return (
    card.checking !== null && card.checking.phase !== 'conditions' && card.checking.phase !== 'held'
  );
}

/**
 * ADR-0037 P4: the move waits its turn (`requires.concurrency`): "Queued behind #abcd1234", or
 * null when the card isn't held.
 */
export function queuedSummary(card: Pick<BoardCard, 'checking'>): string | null {
  if (card.checking?.phase !== 'held') return null;
  return card.checking.label ?? 'Queued';
}

/** FR-5: the step's next check is queued behind the machine's build semaphore. */
export function waitingForBuildSlot(card: CardStep): boolean {
  return isConductorStep(card) && card.badges.includes('waiting_for_build_slot');
}

/** The running item and its 1-based position, or null (older servers send no items). */
function currentItem(checking: BoardChecking): { item: BoardCheckingItem; n: number } | null {
  const items = checking.items ?? [];
  const i = checking.current ?? null;
  const item = i === null ? undefined : items[i];
  return item && i !== null ? { item, n: i + 1 } : null;
}

/**
 * "Conductor is checking · Unit tests (3/5)"; "… · waiting for a build slot" (FR-5; the daemon
 * reports no queue position); "… · <label or title>" when the server sends no items.
 */
export function checkingSummary(card: CardStep): string {
  const checking = card.checking;
  if (checking === null) return '';
  if (waitingForBuildSlot(card)) return 'Conductor is checking · waiting for a build slot';
  const cur = currentItem(checking);
  if (cur) return `Conductor is checking · ${cur.item.label} (${cur.n}/${checking.items!.length})`;
  return `Conductor is checking · ${checking.label ?? checking.title}`;
}

export const CHECK_STATUS_TEXT: Record<BoardCheckingItem['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  running: 'running',
  todo: 'to do',
  pending: 'not yet',
  disabled: 'disabled',
  unsupported: 'not supported yet',
  skipped: 'not checked',
};

const CHECK_ICONS: Record<BoardCheckingItem['status'], string> = {
  passed: '✓',
  failed: '✗',
  running: '◌',
  todo: '◻',
  pending: '◻',
  disabled: '–',
  unsupported: '?',
  skipped: '–',
};

const ERROR_LINE = /error|fail|✗|×|ERR!/i;
const MAX_ERROR_LINE = 200;

/** The first non-empty line that looks like an error, else the first non-empty line; capped. */
export function firstErrorLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const line = lines.find((l) => ERROR_LINE.test(l)) ?? lines[0];
  if (line === undefined) return null;
  return line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE - 1)}…` : line;
}

/**
 * One sentence for screen readers: the running item ("Unit tests: running (3 of 5)"), else the
 * last item that has started. Only its text changes per item change, so the polite live region
 * announces once per change and stays quiet on an identical re-render (NFR-3).
 */
export function checkingAnnouncement(card: CardStep): string {
  const checking = card.checking;
  if (checking === null) return '';
  if (waitingForBuildSlot(card)) return 'Conductor is waiting for a build slot';
  const items = checking.items ?? [];
  const cur = currentItem(checking);
  if (cur)
    return `${cur.item.label}: ${CHECK_STATUS_TEXT[cur.item.status]} (${cur.n} of ${items.length})`;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.status !== 'todo') {
      return `${item.label}: ${CHECK_STATUS_TEXT[item.status]} (${i + 1} of ${items.length})`;
    }
  }
  return checkingSummary(card);
}

/** What happens when the step finishes, for the banner's note. */
function nextNote(checking: BoardChecking, agent: string): string {
  const opensPr = (checking.items ?? []).some(
    (i) => i.kind === 'action' && i.label === 'PR opened' && i.status !== 'passed',
  );
  return opensPr
    ? `When the checks pass, conductor opens the PR; if one fails, ${agent} resumes to fix it.`
    : `${agent} resumes when the step finishes.`;
}

/**
 * The banner head's progress while collapsed: "waiting for a build slot", the running item
 * ("Unit tests (3/5)"), else "1 failed" or "2/5 passed"; '' with no items.
 */
export function checkingProgress(card: CardStep): string {
  const checking = card.checking;
  if (checking === null) return '';
  if (waitingForBuildSlot(card)) return 'waiting for a build slot';
  const cur = currentItem(checking);
  const items = checking.items ?? [];
  if (cur) return `${cur.item.label} (${cur.n}/${items.length})`;
  if (items.length === 0) return '';
  const failed = items.filter((i) => i.status === 'failed').length;
  if (failed > 0) return `${failed} failed`;
  const passed = items.filter((i) => i.status === 'passed').length;
  return `${passed}/${items.length} passed`;
}

const checksStorageKey = (sessionId: string) => `conductor.checks.open.${sessionId}`;

function readChecksOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(checksStorageKey(sessionId)) === 'open';
  } catch {
    return false;
  }
}

function writeChecksOpen(sessionId: string, open: boolean) {
  try {
    localStorage.setItem(checksStorageKey(sessionId), open ? 'open' : 'closed');
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

/**
 * FR-3: the Messages banner while conductor runs a gate step: what it is checking, the items with
 * their statuses in text, and what happens next. Updates with the card (SSE `card.upserted`).
 * A disclosure, collapsed by default (the head carries the progress), remembered per session;
 * the live region announces either way.
 */
export function ConductorCheckBanner({
  card,
  agent,
  sessionId,
}: {
  /** `repo` links the Repo checks badge; without it the badge isn't shown. */
  card: CardStep & Partial<Pick<BoardCard, 'repo'>>;
  agent: string;
  /** Remembers the open state per session; without it the state isn't persisted. */
  sessionId?: string;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(() => (sessionId ? readChecksOpen(sessionId) : false));
  const checking = card.checking;
  if (checking === null) return null;
  const progress = checkingProgress(card);
  const items = checking.items ?? [];
  const slot = waitingForBuildSlot(card);
  // UXR-75: the step runs the repo's own checks (ADR-0030), not the workflow's: say so, and link.
  const repo =
    checking.checks_source === 'repo' && card.repo && items.some((i) => i.kind === 'check')
      ? card.repo
      : null;
  return (
    <section className="conductor-checks" aria-label="Conductor is running checks">
      <div className="conductor-checks-head">
        <button
          type="button"
          className="conductor-checks-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            if (sessionId) writeChecksOpen(sessionId, !open);
          }}
        >
          <span className="conductor-checks-chevron" aria-hidden="true">
            ▸
          </span>
          <strong>Conductor is running checks</strong>
          <span className="muted"> · {checking.label ?? `Checks before ${checking.title}`}</span>
          {progress !== '' && (
            <span className="muted conductor-checks-progress"> · {progress}</span>
          )}
        </button>
        {repo !== null && (
          <>
            <a
              className="badge conductor-checks-source"
              href={routeHash({ view: 'repo-checks', repo })}
              title="This repo's own checks replace the workflow's"
              aria-label={`Repo checks: ${repo} runs its own checks instead of the workflow's`}
            >
              Repo checks
            </a>
          </>
        )}
      </div>
      <div id={bodyId} className="conductor-checks-body" hidden={!open}>
        {slot && (
          <p className="conductor-checks-slot">
            Conductor is checking · waiting for a build slot. Checks run one at a time on this
            machine to protect it; this step starts when the one ahead of it finishes.
          </p>
        )}
        {items.length > 0 && (
          <ol className="conductor-checks-items">
            {items.map((item, i) => {
              const error = item.status === 'failed' ? firstErrorLine(item.detail) : null;
              return (
                <li
                  key={`${i}-${item.label}`}
                  className={`check-item check-item-${item.status}`}
                  data-status={item.status}
                  title={item.detail ?? undefined}
                >
                  <span className="check-icon" aria-hidden="true">
                    {CHECK_ICONS[item.status]}
                  </span>
                  <span className="check-label">{item.label}</span>
                  <span className="check-status"> · {CHECK_STATUS_TEXT[item.status]}</span>
                  {error && <span className="check-error">: {error}</span>}
                </li>
              );
            })}
          </ol>
        )}
        <p className="conductor-checks-note muted">
          {agent} has finished its part; it isn&apos;t running. {nextNote(checking, agent)}
        </p>
      </div>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {checkingAnnouncement(card)}
      </p>
    </section>
  );
}

/** The failed item of a step-failure question, as the engine words it (apply.ts). */
export interface FailedItem {
  /** The check, action or review that failed; null when the wording names none. */
  item: string | null;
  /** Its first error line (the output's, else the reason). */
  error: string | null;
}

const RETRY = /\s*Retry, skip, or abort\?\s*$/;

/**
 * FR-4: the failed item of UX-4's "Step failed" request, from the question the engine writes
 * (`stepUnmet` / `stepFail` / a refused check / a missing verdict); null if it doesn't parse.
 * TD-152: reads the engine's wording until M2c persists structured check results.
 */
/**
 * UXR-39 (FR-4): the output a failure question quotes for `item` (its `Last output of "<item>":`
 * block, up to the next one or the retry line); null when it quotes none.
 */
export function lastOutputOfQuestion(question: string, item: string | null): string | null {
  const lines = question.trim().split('\n');
  const head =
    item !== null
      ? lines.indexOf(`Last output of "${item}":`)
      : lines.findIndex((l) => /^Last output of ".*":$/.test(l));
  if (head < 0) return null;
  const rest = lines.slice(head + 1);
  const end = rest.findIndex((l) => /^Last output of ".*":$/.test(l) || RETRY.test(l));
  const text = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return text === '' ? null : text;
}

export function failedItemOfQuestion(question: string): FailedItem | null {
  const text = question.trim();
  // stepUnmet after the retries: "- <item>: <reason>" lines, then each one's last output.
  const lines = text.split('\n');
  const listed = lines.map((l) => /^- (.+?): (.*)$/.exec(l)).find((m) => m !== null);
  if (/were not met after/.test(lines[0] ?? '') && listed) {
    const item = listed[1]!;
    const head = lines.indexOf(`Last output of "${item}":`);
    let output: string | null = null;
    if (head >= 0) {
      const rest = lines.slice(head + 1);
      const end = rest.findIndex((l) => /^Last output of ".*":$/.test(l) || RETRY.test(l));
      output = (end === -1 ? rest : rest.slice(0, end)).join('\n');
    }
    return { item, error: firstErrorLine(output) ?? firstErrorLine(listed[2]) };
  }
  const refused =
    /^Could not run the check "(.+?)" \(`.*?`\) to .*?: (.+?)\.?\s*Retry, skip, or abort\?$/s.exec(
      text,
    );
  if (refused) return { item: refused[1]!, error: firstErrorLine(refused[2]) };
  const action =
    /^Conductor (?:could not|cannot) (.+?) (?:to|yet, so it did not) (?:take|enter) .*?: (.+)$/s.exec(
      text,
    );
  if (action) {
    return { item: action[1]!, error: firstErrorLine(action[2]!.replace(RETRY, '')) };
  }
  const verdict = /^The requirements review .*? produced no verdict \((.+)\)\./s.exec(text);
  if (verdict) return { item: 'Review', error: firstErrorLine(verdict[1]) };
  return null;
}
