// UX-5: while conductor (not an agent) runs a gate step's checks, review or actions, the card and
// the session panel say so: "Conductor is checking · <item> (n/m)", with the live item list. The
// agent has finished its part, so its avatar shows as idle. Also the failed item of UX-4's
// "Step failed" request (its name and first error line).
import type { BoardCard, BoardChecking, BoardCheckingItem } from '@conductor/shared';
import './ConductorChecks.css';

type CardStep = Pick<BoardCard, 'checking' | 'badges'>;

/** In a gate step (`checking` set): the worker agent has exited; conductor owns the step. */
export function agentIdle(card: Pick<BoardCard, 'checking'>): boolean {
  return card.checking !== null;
}

/**
 * Conductor itself is running the step (checks, review, actions). Not in `conditions`: there the
 * session is `waiting_external` and the card keeps its "waiting for" checklist.
 */
export function isConductorStep(card: Pick<BoardCard, 'checking'>): boolean {
  return card.checking !== null && card.checking.phase !== 'conditions';
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
};

const CHECK_ICONS: Record<BoardCheckingItem['status'], string> = {
  passed: '✓',
  failed: '✗',
  running: '◌',
  todo: '◻',
  pending: '◻',
  disabled: '–',
  unsupported: '?',
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
 * FR-3: the Messages banner while conductor runs a gate step: what it is checking, the items with
 * their statuses in text, and what happens next. Updates with the card (SSE `card.upserted`).
 */
export function ConductorCheckBanner({ card, agent }: { card: CardStep; agent: string }) {
  const checking = card.checking;
  if (checking === null) return null;
  const items = checking.items ?? [];
  const slot = waitingForBuildSlot(card);
  return (
    <section className="conductor-checks" aria-label="Conductor is running checks">
      <div className="conductor-checks-head">
        <strong>Conductor is running checks</strong>
        <span className="muted"> · {checking.label ?? `Checks before ${checking.title}`}</span>
      </div>
      {slot && (
        <p className="conductor-checks-slot">
          Conductor is checking · waiting for a build slot. Checks run one at a time on this machine
          to protect it; this step starts when the one ahead of it finishes.
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
