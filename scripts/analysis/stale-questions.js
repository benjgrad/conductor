#!/usr/bin/env node
// @ts-check
// Stale questions: how often did Ben's answer equal the agent's recommendation? The number that
// decides the needs_input watch policy in workflow v6 (escalate after 2 h, or let the agent
// proceed with its stated recommendation and record the assumption; ADR-0037 draft).
//
//   psql … -f scripts/analysis/stale-questions.sql > /tmp/stale-questions.json   (see that file)
//   node scripts/analysis/stale-questions.js /tmp/stale-questions.json \
//     [--overrides scripts/analysis/stale-questions.overrides.json] [--rows]
//
// The heuristic classifier below is a first pass. A person (or agent) reads every row with
// --rows and records a judgement in the overrides file where the heuristic is wrong. That file
// holds only ids, classes, flags and short notes, never question or answer text, so the export
// stays out of git and a re-run on a newer export reuses the judgements already made.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {'accepted' | 'modified' | 'rejected' | 'unclear'} Class */
/** @typedef {'ask_user' | 'plan_approval' | 'question_transition' | 'engine'} OriginGroup */
/**
 * One row of the SQL export.
 * @typedef {object} Row
 * @property {string} id
 * @property {string | null} ticket_kind
 * @property {string} question
 * @property {unknown} options
 * @property {string} answer
 * @property {string | null} return_to
 * @property {number} wait_minutes
 * @property {string | null} origin_transition
 * @property {string | null} closing_transition
 * @property {string | null} closing_from
 * @property {string | null} closing_to
 */
/**
 * A judgement recorded by hand. Every field is optional: the heuristic fills in the rest.
 * `needs_human`: the recommended path needed Ben to do or supply something (run a command, merge,
 * paste a log, give a URL), so auto-proceeding on it could not have unblocked the agent.
 * @typedef {{ class?: Class, has_rec?: boolean, needs_human?: boolean, note?: string }} Override
 */
/**
 * @typedef {object} Classified
 * @property {Row} row
 * @property {string | null} rec          the recommended answer, as extracted
 * @property {boolean} hasRec
 * @property {Class} cls
 * @property {Class} heuristic           what the heuristic said, before any override
 * @property {boolean} needsHuman
 * @property {OriginGroup} origin
 * @property {string} kind               ticket kind (NULL counted as work, as the board shows it)
 * @property {string | undefined} note
 */

export const CLASSES = /** @type {const} */ (['accepted', 'modified', 'rejected', 'unclear']);

/** The PR hand-offs: `question: true` transitions that are not questions (the SQL drops them too). */
export const PR_HANDOFFS = new Set(['pr_ready_for_review', 'personal_pr_ready_for_review']);

/** Engine-written agent_question texts (packages/shared/src/engine): no agent recommendation. */
const ENGINE_QUESTION =
  /^(Agent stopped without reporting an outcome|The agent named an unknown transition|QA could not start|Nothing to QA: no pull request)/;

/**
 * The option labels of an input_request: `options` is `{items: [{label}], multi_select}` (the
 * Questions UX shape); a bare array is accepted too.
 * @param {unknown} options @returns {string[]}
 */
export function optionLabels(options) {
  if (options === null || typeof options !== 'object') return [];
  /** @type {unknown} */
  const items = Array.isArray(options)
    ? options
    : /** @type {{ items?: unknown }} */ (options).items;
  if (!Array.isArray(items)) return [];
  return /** @type {unknown[]} */ (items)
    .map((i) =>
      i !== null && typeof i === 'object' ? /** @type {{ label?: unknown }} */ (i).label : i,
    )
    .filter((l) => typeof l === 'string');
}

/** @param {string} s */
export const normalise = (s) =>
  s
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** "(A, recommended)", "My recommendation is (A)", "I recommend (A)", "Recommended: (a)". */
const LETTER_REC = [
  /\(([A-Ea-e1-5])\s*,\s*recommended\)/,
  /\brecommend(?:ation)?(?: is| would be)?:?\s*\(?([A-Ea-e1-5])\)/i,
  /\(([A-Ea-e1-5])\)[^.?!]{0,80}\b(?:is what I'd recommend|is my recommendation|which I recommend)/i,
  /\bI recommend \(([A-Ea-e1-5])\)/i,
];
/** A sentence that states a recommendation in prose. */
const PROSE_REC =
  /\b(I recommend|I'd recommend|my recommendation|recommended:|recommendation:|I'd suggest|I suggest|I propose|I'd rather)/i;

/**
 * The agent's recommended answer.
 * - options: the first label (the ask_user contract lists the recommended choice first);
 * - plan_needs_approval: the plan itself (approving it is the recommendation);
 * - a lettered recommendation, "(A, recommended)": `(A)`;
 * - else the first sentence that states one in prose;
 * - else null.
 * @param {string} question @param {unknown} options @param {string | null} [origin]
 * @returns {string | null}
 */
export function extractRecommendation(question, options, origin = null) {
  const labels = optionLabels(options);
  if (labels.length > 0) return labels[0] ?? null;
  if (origin === 'plan_needs_approval') return 'approve the plan';
  for (const re of LETTER_REC) {
    const m = re.exec(question);
    if (m) return `(${m[1]})`;
  }
  const sentences = question.split(/(?<=[.?!])\s+/);
  const hit = sentences.find(
    (s) => PROSE_REC.test(s) && !/\b(don't|do not|not) recommend/i.test(s),
  );
  return hit === undefined ? null : hit.trim();
}

const AFFIRMATIVE_ONLY =
  /^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|do it|approved?|agreed?|lgtm|sounds good|proceed|ship it|\[answer\]|recommended|option 1|1|try again|try now|retry)$/;
const AFFIRMATIVE_START =
  /^(y|yes|yep|yeah|ok|okay|sure|go ahead|do it|approved?|agreed?|lgtm|sounds good|proceed|plan approved|try again|try now|retry)\b/;
const NEGATION =
  /(^no\b|\bdon'?t\b|\bdo not\b|\binstead\b|\brather\b|\bnot that\b|\bwrong\b|^stop\b|\bcancel\b|^changes requested\b)/;
/** The board's Approve button on a plan writes this text. */
const PLAN_APPROVED = /^plan approved\b/;

/**
 * Is this the answer the closing move recorded as `answer`? An answer typed in the board's
 * answer box (input.provided) records no transition name, and goes back to `return_to`.
 * @param {Pick<Row, 'closing_transition' | 'closing_to' | 'return_to'>} row
 */
export const closedByAnswer = (row) =>
  row.closing_transition === 'answer' ||
  (row.closing_transition === null && row.closing_to !== null && row.closing_to === row.return_to);

/**
 * The letter an answer picks: "A", "(b)", "a", "Go with (b): …", "option 2".
 * @param {string} a normalised answer @returns {string | null}
 */
function pickedLetter(a) {
  const m =
    /^\(?([a-e1-5])\)?$/.exec(a) ??
    /^(?:go with|pick|option|choose|do)\s*\(?([a-e1-5])\)?(?=\W|$)/.exec(a) ??
    /^\(?([a-e1-5])\)[\s:,-]/.exec(a);
  return m ? (m[1] ?? null) : null;
}

/**
 * The heuristic class of Ben's answer against the recommendation.
 * @param {Pick<Row, 'answer' | 'options'>} row @param {string | null} rec @returns {Class}
 */
export function classify(row, rec) {
  const a = normalise(row.answer);
  const labels = optionLabels(row.options).map(normalise);
  if (a === '') return 'unclear';
  if (labels.length > 0) {
    if (a === labels[0]) return 'accepted';
    if (labels.slice(1).includes(a)) return 'rejected';
  }
  if (PLAN_APPROVED.test(a)) return 'accepted';
  if (rec !== null && a === normalise(rec)) return 'accepted';
  const letter = pickedLetter(a);
  if (letter !== null && rec !== null && /^\([a-e1-5]\)$/i.test(rec)) {
    if (letter === rec.slice(1, 2).toLowerCase()) return a.length <= 4 ? 'accepted' : 'modified';
    return 'rejected';
  }
  if (AFFIRMATIVE_ONLY.test(a)) return 'accepted';
  const negates = NEGATION.test(a);
  if (AFFIRMATIVE_START.test(a) && !negates) {
    // A short reason after the yes ("try again, my computer was asleep") is still a yes.
    return a.split(' ').length <= 10 ? 'accepted' : 'modified';
  }
  if (negates)
    return rec === null ? 'unclear' : /^changes requested/.test(a) ? 'modified' : 'rejected';
  return 'unclear';
}

/** @param {Row} row @returns {OriginGroup} */
export function originGroup(row) {
  if (ENGINE_QUESTION.test(row.question)) return 'engine';
  if (row.origin_transition === 'plan_needs_approval') return 'plan_approval';
  // The ask_user tool records no transition name on the move it makes; a named ask_user does.
  if (row.origin_transition === null || row.origin_transition === 'ask_user') return 'ask_user';
  return 'question_transition';
}

/**
 * Classify every row closed by `answer` (FR-1), with overrides applied.
 * @param {Row[]} rows @param {Record<string, Override>} [overrides] @returns {Classified[]}
 */
export function classifyAll(rows, overrides = {}) {
  return rows
    .filter((r) => !PR_HANDOFFS.has(r.origin_transition ?? '') && closedByAnswer(r))
    .map((row) => {
      const o = overrides[row.id] ?? {};
      const rec = extractRecommendation(row.question, row.options, row.origin_transition);
      const heuristic = classify(row, rec);
      return {
        row,
        rec,
        hasRec: o.has_rec ?? rec !== null,
        cls: o.class ?? heuristic,
        heuristic,
        needsHuman: o.needs_human ?? false,
        origin: originGroup(row),
        kind: row.ticket_kind ?? 'work',
        note: o.note,
      };
    });
}

/**
 * Nearest-rank percentile; null for no values.
 * @param {number[]} values @param {number} p 0–100 @returns {number | null}
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * @typedef {object} Stats
 * @property {number} n
 * @property {Record<Class, number>} counts
 */
/** @param {Classified[]} items @returns {Stats} */
export function stats(items) {
  /** @type {Record<Class, number>} */
  const counts = { accepted: 0, modified: 0, rejected: 0, unclear: 0 };
  for (const i of items) counts[i.cls] += 1;
  return { n: items.length, counts };
}

/** Thresholds for `recommend`: a judgement call, printed next to the result. */
export const THRESHOLDS = { minAccepted: 0.8, maxRejected: 0.1, minN: 5 };

/**
 * Does auto-proceed hold for these questions? Accepted at least 80 % and rejected under 10 %, over
 * at least 5 questions.
 * @param {Stats} s
 */
export const autoProceedHolds = (s) =>
  s.n >= THRESHOLDS.minN &&
  s.counts.accepted / s.n >= THRESHOLDS.minAccepted &&
  s.counts.rejected / s.n < THRESHOLDS.maxRejected;

/**
 * The FR-4 line, over the agent-initiated questions that offered a recommendation.
 * @param {{ all: Stats, personal: Stats, work: Stats }} s
 * @returns {'auto-proceed' | 'auto-proceed only when the question offers a recommendation and the ticket is personal' | 'escalate'}
 */
export function recommend(s) {
  if (autoProceedHolds(s.all)) return 'auto-proceed';
  if (autoProceedHolds(s.personal) && !autoProceedHolds(s.work)) {
    return 'auto-proceed only when the question offers a recommendation and the ticket is personal';
  }
  return 'escalate';
}

/** @param {number} n @param {number} d */
const pct = (n, d) => (d === 0 ? '–' : `${Math.round((100 * n) / d)} %`);
/** @param {number | null} m */
const mins = (m) => (m === null ? '–' : `${Math.round(m)} min`);
/** @param {string} s @param {number} n */
const clip = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|');

/** @param {Classified[]} items @param {string} title */
function classTable(items, title) {
  const s = stats(items);
  const lines = [
    `**${title}** (n = ${s.n})`,
    '',
    '| class | n | share | median wait | p90 wait |',
    '|---|---|---|---|---|',
  ];
  for (const c of CLASSES) {
    const waits = items.filter((i) => i.cls === c).map((i) => i.row.wait_minutes);
    lines.push(
      `| ${c} | ${s.counts[c]} | ${pct(s.counts[c], s.n)} | ${mins(percentile(waits, 50))} | ${mins(percentile(waits, 90))} |`,
    );
  }
  const all = items.map((i) => i.row.wait_minutes);
  lines.push(
    `| all | ${s.n} | | ${mins(percentile(all, 50))} | ${mins(percentile(all, 90))} |`,
    '',
  );
  return lines.join('\n');
}

/** @param {Classified[]} items @param {(i: Classified) => string} key */
function split(items, key) {
  /** @type {Map<string, Classified[]>} */
  const m = new Map();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

/** @param {Map<string, Classified[]>} groups @param {string} label */
function splitTable(groups, label) {
  const lines = [
    `| ${label} | n | accepted | modified | rejected | unclear |`,
    '|---|---|---|---|---|---|',
  ];
  for (const [k, items] of [...groups].sort()) {
    const s = stats(items);
    lines.push(
      `| ${k} | ${s.n} | ${CLASSES.map((c) => `${s.counts[c]} (${pct(s.counts[c], s.n)})`).join(' | ')} |`,
    );
  }
  return [...lines, ''].join('\n');
}

/**
 * The Markdown report.
 * @param {Classified[]} items @param {{ rows?: boolean, excluded?: number }} [opts]
 */
export function report(items, opts = {}) {
  const agent = items.filter((i) => i.origin !== 'engine');
  const withRec = agent.filter((i) => i.hasRec);
  // The auto-proceed set: questions the needs_input watch could act on. Plan approvals are left
  // out: they are policy gates (schema changes, ADR reversals, spend) that are never auto-taken,
  // and from v5 on plan_needs_approval goes to plan_review, not needs_input.
  const decidable = withRec.filter((i) => !i.needsHuman && i.origin !== 'plan_approval');
  const byKind = (/** @type {string} */ k) => stats(decidable.filter((i) => i.kind === k));
  const s = { all: stats(decidable), personal: byKind('personal'), work: byKind('work') };
  const out = [
    "# Stale questions: answer vs the agent's recommendation",
    '',
    `${items.length} agent questions closed by \`answer\`` +
      (opts.excluded ? ` (${opts.excluded} more closed by another move are not counted)` : '') +
      `; ${agent.length} from the agent, ${withRec.length} of them with a recommendation, ` +
      `${withRec.filter((i) => i.needsHuman).length} of those needing Ben to act or supply something.`,
    '',
    classTable(items, 'All answered questions'),
    classTable(withRec, 'Agent questions with a recommendation'),
    classTable(
      decidable,
      'The auto-proceed set: not a plan approval, with a recommendation the agent could have acted on alone',
    ),
    classTable(
      items.filter((i) => i.origin === 'plan_approval'),
      'Plan approvals (context: never auto-proceeded)',
    ),
    '**By ticket kind** (auto-proceed set)',
    '',
    splitTable(
      split(decidable, (i) => i.kind),
      'kind',
    ),
    '**By recommendation present** (agent questions)',
    '',
    splitTable(
      split(agent, (i) => (i.hasRec ? 'recommendation' : 'none')),
      'recommendation',
    ),
    '**By origin** (all)',
    '',
    splitTable(
      split(items, (i) => i.origin),
      'origin',
    ),
    `**Recommendation: ${recommend(s)}**`,
    '',
    `Thresholds (a judgement call): auto-proceed holds when accepted is at least ${100 * THRESHOLDS.minAccepted} % and rejected is under ${100 * THRESHOLDS.maxRejected} % over at least ${THRESHOLDS.minN} questions in the auto-proceed set; ` +
      `personal-only when it holds for personal tickets and not for work. ` +
      `Here: all ${pct(s.all.counts.accepted, s.all.n)} accepted / ${pct(s.all.counts.rejected, s.all.n)} rejected; ` +
      `personal ${pct(s.personal.counts.accepted, s.personal.n)} / ${pct(s.personal.counts.rejected, s.personal.n)}; ` +
      `work ${pct(s.work.counts.accepted, s.work.n)} / ${pct(s.work.counts.rejected, s.work.n)}.`,
    '',
    '## Rejected',
    '',
    ...items
      .filter((i) => i.cls === 'rejected')
      .map(
        (i) =>
          `- \`${i.row.id.slice(0, 8)}\` (${i.kind}, ${i.origin}, ${mins(i.row.wait_minutes)}): rec: ${clip(i.rec ?? '(none)', 200)} — answer: ${clip(i.row.answer, 200)}${i.note ? ` — ${i.note}` : ''}`,
      ),
    '',
  ];
  if (opts.rows) {
    out.push(
      '## Rows',
      '',
      '| id | kind | origin | wait | class | heuristic | rec | human | recommendation | answer |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...items.map(
        (i) =>
          `| ${i.row.id.slice(0, 8)} | ${i.kind} | ${i.origin} | ${mins(i.row.wait_minutes)} | ${i.cls} | ${i.heuristic} | ${i.hasRec ? 'y' : 'n'} | ${i.needsHuman ? 'y' : 'n'} | ${cell(clip(i.rec ?? '', 80))} | ${cell(clip(i.row.answer, 80))} |`,
      ),
      '',
    );
  }
  return out.join('\n');
}

/**
 * Overrides keyed by the full input_request id, or by a unique prefix of at least 8 characters.
 * Keys starting with `_` are comments.
 * @param {Row[]} rows @param {Record<string, Override | string>} raw
 * @returns {Record<string, Override>}
 */
export function resolveOverrides(rows, raw) {
  /** @type {Record<string, Override>} */
  const out = {};
  for (const [key, o] of Object.entries(raw)) {
    if (key.startsWith('_') || typeof o === 'string') continue;
    const hits = rows.filter((r) => r.id.startsWith(key));
    if (key.length < 8 || hits.length !== 1) {
      throw new Error(
        `override ${key}: matches ${hits.length} rows (need exactly one, prefix ≥ 8)`,
      );
    }
    if (o.class !== undefined && !CLASSES.includes(o.class)) {
      throw new Error(`override ${key}: unknown class ${String(o.class)}`);
    }
    out[/** @type {Row} */ (hits[0]).id] = o;
  }
  return out;
}

/** @param {string} file @returns {unknown} */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** @param {string[]} argv */
function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (file === undefined) {
    process.stderr.write('usage: stale-questions.js <export.json> [--overrides <file>] [--rows]\n');
    process.exit(2);
  }
  const oi = argv.indexOf('--overrides');
  const rows = /** @type {Row[]} */ (readJson(file));
  const overrides =
    oi >= 0 && argv[oi + 1] !== undefined
      ? resolveOverrides(
          rows,
          /** @type {Record<string, Override | string>} */ (
            readJson(/** @type {string} */ (argv[oi + 1]))
          ),
        )
      : {};
  const items = classifyAll(rows, overrides);
  process.stdout.write(
    report(items, { rows: argv.includes('--rows'), excluded: rows.length - items.length }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
