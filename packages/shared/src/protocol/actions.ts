import { z } from 'zod';
import { GITHUB_PR_URL_RE } from '../domain.js';
import { ApprovalIdSchema, PathGlobSchema } from '../workflow/schema.js';

// `run_action` args and `action_result.result` shapes per action (ADR-0010 open_pr, ADR-0020 §4
// inspect_pr / merge_pr / close_pr). The WS envelope carries them as JSON objects
// (`RunActionPayloadSchema.args`, `action_result.result`); the daemon parses the args with these,
// and the engine parses the results. 10-contracts §Review and merge.
//
// Reporting rule: `inspect_pr`, `close_pr` and `open_pr` report success in `result` and a failure
// in `error` (one sentence, a failed action → `on_unmet.else`). `merge_pr` reports every outcome
// gh gave in `result` as a MergePrResult (`ok: false` included); `error` only when its args don't
// parse or the daemon itself failed.

/** A full git commit id (40 lower-case hex), as `EvaluateConditionsArgs.head_sha`. */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, '40 hex commit id');
/** A GitHub pull request URL (`GITHUB_PR_URL_RE`), the only PR URL conductor records. */
export const PrUrlSchema = z.string().regex(GITHUB_PR_URL_RE, 'a GitHub pull request URL');
/** A repository-relative file path a PR changes. */
export const PrFilePathSchema = z.string().min(1).max(1_000);

/** Cap on `InspectPrResult.files` (and on each `matched` list). */
export const PR_FILES_MAX = 300;
/** Cap on a one-sentence `detail` / `note` / `reason` from the daemon (gh's output tail, U-045). */
export const ACTION_DETAIL_MAX = 2_000;
/** Cap on `ClosePrArgs.reason`: the human's text (`TransitionSessionRequest.text`). */
export const CLOSE_REASON_MAX = 20_000;

const detail = z.string().max(ACTION_DETAIL_MAX);
const approvalIdRecord = <T extends z.ZodType>(value: T) =>
  z
    .record(ApprovalIdSchema, value)
    .refine((r) => Object.keys(r).length <= 5, 'at most 5 approvals');

// ---------------------------------------------------------------- open_pr (ADR-0010)

/** `open_pr` args: the PR title and body (apply's `actionArgs`). */
export const OpenPrArgsSchema = z.object({
  title: z.string().max(1_000),
  body: z.string().max(65_536),
});
export type OpenPrArgs = z.infer<typeof OpenPrArgsSchema>;

/**
 * `open_pr` result. ADR-0020 adds `head_sha`, the commit pushed (`run_action.expected_sha`, or the
 * tip when it was null); the engine records it as `context.__pr.head_sha` (M2r-T04). Optional so
 * results from daemons before M2r-T05 still parse.
 */
export const OpenPrResultSchema = z.object({
  pr_url: PrUrlSchema,
  head_sha: GitShaSchema.optional(),
});
export type OpenPrResult = z.infer<typeof OpenPrResultSchema>;

// ---------------------------------------------------------------- inspect_pr (ADR-0020 §4)

/**
 * `inspect_pr` args: the PR (`context.__pr.pr_url`) and each approval's globs, keyed by approval
 * id (the transition's `requires.approvals` into the target, e.g. Ready to merge's `merge`).
 */
export const InspectPrArgsSchema = z.object({
  pr_url: PrUrlSchema,
  approval_paths: approvalIdRecord(z.array(PathGlobSchema).min(1).max(20)),
});
export type InspectPrArgs = z.infer<typeof InspectPrArgsSchema>;

/** gh's `mergeable`. */
export const PrMergeableSchema = z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
export type PrMergeable = z.infer<typeof PrMergeableSchema>;
/** gh's `state`. */
export const PrStateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED']);
export type PrState = z.infer<typeof PrStateSchema>;

/**
 * `inspect_pr` result, stored as `context.__pr.inspect`. `files`: the first PR_FILES_MAX changed
 * paths; `files_truncated` when there were more (every approval is then active, fail safe).
 * `matched[id]`: the changed files matching that approval's globs (absent or [] = none).
 */
export const InspectPrResultSchema = z.object({
  head_sha: GitShaSchema,
  files: z.array(PrFilePathSchema).max(PR_FILES_MAX),
  files_truncated: z.boolean(),
  mergeable: PrMergeableSchema,
  state: PrStateSchema,
  matched: approvalIdRecord(z.array(PrFilePathSchema).max(PR_FILES_MAX)),
});
export type InspectPrResult = z.infer<typeof InspectPrResultSchema>;

// ---------------------------------------------------------------- merge_pr (ADR-0020 §4)

/**
 * `merge_pr` args. `expected_sha` = `context.__qa.head_sha` (the commit QA reviewed): the merge is
 * `--match-head-commit` it. `method` is `merge` only (a merge commit). `approved_paths`: the files
 * of the approvals the human ticked (`step.approvals.files`, flattened), for the daemon's re-check.
 */
export const MergePrArgsSchema = z.object({
  pr_url: PrUrlSchema,
  expected_sha: GitShaSchema,
  method: z.literal('merge'),
  approved_paths: z.array(PrFilePathSchema).max(PR_FILES_MAX * 5),
});
export type MergePrArgs = z.infer<typeof MergePrArgsSchema>;

/** `merge_pr` unmet reasons (`on_unmet.routes` keys; counted, back to a worker or QA). */
export const MergePrUnmetSchema = z.enum(['head_moved', 'conflict']);
/** `merge_pr` errors (→ `on_unmet.else`, the detail as the question). */
export const MergePrErrorSchema = z.enum(['closed', 'blocked', 'approval_missing', 'error']);

/**
 * `merge_pr` result:
 * - merged (now, or `already` before: idempotent, also when merged on GitHub). `note` e.g.
 *   "merged a different head" when the merged head isn't `expected_sha`;
 * - `unmet`: `head_moved` (`observed_sha` = the PR head now) or `conflict`;
 * - `error`: `closed` on GitHub, `blocked` by branch protection, `approval_missing` (a changed file
 *   matches an approval not in `approved_paths`), or any other gh failure.
 * The two failure shapes are strict, so a result can't carry both `unmet` and `error`.
 */
export const MergePrResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    merged: z.literal(true),
    already: z.boolean(),
    merge_commit_sha: GitShaSchema,
    head_sha: GitShaSchema,
    note: detail.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    unmet: MergePrUnmetSchema,
    observed_sha: GitShaSchema.optional(),
    detail,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: MergePrErrorSchema,
    detail,
  }),
]);
export type MergePrResult = z.infer<typeof MergePrResultSchema>;

// ---------------------------------------------------------------- close_pr (ADR-0020 §4)

/**
 * `close_pr` args: the PR (null when the ticket never opened one: a no-op success) and the
 * human's reason, posted as the closing comment.
 */
export const ClosePrArgsSchema = z.object({
  pr_url: PrUrlSchema.nullable(),
  reason: z.string().trim().min(1).max(CLOSE_REASON_MAX),
});
export type ClosePrArgs = z.infer<typeof ClosePrArgsSchema>;

/**
 * `close_pr` result. `closed`: the PR is closed (or there was none); `merged`: it had been merged
 * (Done is then badged `merged`); `already`: nothing to do (closed or merged before, or no PR).
 */
export const ClosePrResultSchema = z.object({
  closed: z.boolean(),
  merged: z.boolean(),
  already: z.boolean(),
});
export type ClosePrResult = z.infer<typeof ClosePrResultSchema>;
