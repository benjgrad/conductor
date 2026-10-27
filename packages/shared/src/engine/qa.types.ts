import { z } from 'zod';
import { IsoDateTimeSchema } from '../domain.js';
import { GitShaSchema, InspectPrResultSchema, PrUrlSchema } from '../protocol/actions.js';

// ADR-0020 §2, §4, §7: what a `role: 'qa'` state reports, and the context conductor keeps about
// QA (`__qa`) and the PR (`__pr`). Shapes only; the engine behaviour is M2r-T03 / T04.
// 10-contracts §Review and merge.

/** Session context key of the QA bookkeeping (QaContext); in RESERVED_CONTEXT_KEYS. */
export const QA_CONTEXT_KEY = '__qa';

export const QaVerdictSchema = z.enum(['pass', 'pass_with_debt', 'fail']);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;
export const QA_VERDICTS = QaVerdictSchema.options;

export const QaSeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit']);
export type QaSeverity = z.infer<typeof QaSeveritySchema>;

/** ADR-0020 §2 caps (model text, U-045; sized like ADR-0019's claims). */
export const QA_LIMITS = {
  requirements: 50,
  findings: 50,
  required_fixes: 20,
  debt: 20,
  unknowns: 10,
  tests_run: 20,
  /** Every free-text field except `summary`. */
  text: 1_000,
  summary: 2_000,
  /** A requirement id (`FR-1`), a file path. */
  ref: 1_000,
} as const;

const text = z.string().trim().min(1).max(QA_LIMITS.text);

/**
 * The `complete_state` result of a `role: 'qa'` state (ADR-0020 §2), kept as `context.<qa state>`
 * (each round overwrites it). Lists default to [] so a pass may omit them. Whether it matches the
 * transition taken (`qa_pass` needs pass / pass_with_debt and no fixes; `qa_fail` needs fail and
 * ≥ 1 fix) is apply's check (M2r-T03), not the schema's.
 */
export const QaResultSchema = z.object({
  verdict: QaVerdictSchema,
  /** ADR-0019 §4's review grades, one per ticket requirement id. */
  requirements: z
    .array(
      z.object({
        req: z.string().trim().min(1).max(40),
        met: z.boolean(),
        reason: z.string().max(QA_LIMITS.text),
      }),
    )
    .max(QA_LIMITS.requirements)
    .optional(),
  findings: z
    .array(
      z.object({
        severity: QaSeveritySchema,
        text,
        file: z.string().min(1).max(QA_LIMITS.ref).optional(),
        line: z.number().int().positive().optional(),
      }),
    )
    .max(QA_LIMITS.findings)
    .default([]),
  required_fixes: z.array(text).max(QA_LIMITS.required_fixes).default([]),
  /** Proposed TD rows (no ids: the lead records them). */
  debt: z
    .array(
      z.object({
        text,
        site: z.string().min(1).max(QA_LIMITS.ref).optional(),
        payoff: text.optional(),
      }),
    )
    .max(QA_LIMITS.debt)
    .default([]),
  /** Proposed U rows. */
  unknowns: z
    .array(z.object({ question: text, why: text }))
    .max(QA_LIMITS.unknowns)
    .default([]),
  tests_run: z
    .array(
      z.object({
        cmd: text,
        result: z.enum(['pass', 'fail']),
        note: text.optional(),
      }),
    )
    .max(QA_LIMITS.tests_run)
    .default([]),
  summary: z.string().trim().min(1).max(QA_LIMITS.summary),
});
export type QaResult = z.infer<typeof QaResultSchema>;
/** As the agent may send it (lists optional). */
export type QaResultInput = z.input<typeof QaResultSchema>;

/**
 * `context.__qa` (ADR-0020 §7), written by the engine on entering a QA state (M2r-T03):
 * - `head_sha`: the commit QA reviews (`__pr.head_sha`, or the head `inspect_pr` / `merge_pr`
 *   observed after `head_moved`);
 * - `verdict`: null until the round's QA reported;
 * - `round` (1-based) of `max_rounds` (the `qa_fail` transition's `retries` + 1);
 * - `claude_session_id`: the QA's own conversation (never `session.claude_session_id`);
 * - `next_sha`: set by T04 on an unmet `head_moved`; the next QA round reviews it.
 */
export const QaContextSchema = z
  .object({
    head_sha: GitShaSchema,
    verdict: QaVerdictSchema.nullable(),
    round: z.number().int().min(1).max(11),
    max_rounds: z.number().int().min(1).max(11),
    claude_session_id: z.string().min(1).max(200).nullable(),
    next_sha: GitShaSchema.optional(),
  })
  .refine((q) => q.round <= q.max_rounds, { message: 'round must be ≤ max_rounds' });
export type QaContext = z.infer<typeof QaContextSchema>;

/**
 * `context.__pr` (PR_CONTEXT_KEY), written only by the engine from action results (ADR-0010
 * hardening). M1b wrote `{pr_url, state?}`; ADR-0020 adds `head_sha` (open_pr's pushed commit),
 * `inspect` (the last InspectPrResult), and `merged` / `closed` once Done (M2r-T04). Unknown keys
 * pass, so older rows parse.
 */
export const PrContextSchema = z.object({
  pr_url: PrUrlSchema,
  head_sha: GitShaSchema.optional(),
  inspect: InspectPrResultSchema.optional(),
  merged: z
    .object({
      at: IsoDateTimeSchema,
      merge_commit_sha: GitShaSchema,
      /** The actor who clicked Merge (or `github` when merged there first). */
      by: z.string().min(1).max(200),
      note: z.string().max(2_000).optional(),
    })
    .optional(),
  closed: z
    .object({
      at: IsoDateTimeSchema,
      reason: z.string().max(20_000),
      by: z.string().min(1).max(200),
    })
    .optional(),
});
export type PrContext = z.infer<typeof PrContextSchema>;
