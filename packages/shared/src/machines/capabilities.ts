import { z } from 'zod';
import { isCanonicalRemote } from './inventory.js';

// A machine's capabilities (ADR-0013 §Inventory, ADR-0016 owns the names). Names and versions
// only: never account names, tokens, MCP commands, args, env or URLs.

const NameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !/[\s\0]/.test(s), 'no whitespace');
const RepoScopeSchema = z.string().refine(isCanonicalRemote, 'expected host/org/repo');

export const CapabilitySchema = z.discriminatedUnion('kind', [
  /** `gh`, `az`, `jira`, `git`: `version` from `--version` (null = unknown), `authed` from a read-only probe. */
  z.object({
    kind: z.literal('cli'),
    name: NameSchema,
    version: z.string().nullable(),
    authed: z.boolean(),
  }),
  /** An MCP server name from the user's Claude Code config (user scope and plugins). */
  z.object({ kind: z.literal('mcp'), name: NameSchema }),
  /**
   * `~/.claude/skills/<name>`, or `<repo>/.claude/skills/<name>` with `repo` = that repo's
   * canonical remote. A repo whose remote is null has its skills and agents not reported.
   */
  z.object({ kind: z.literal('skill'), name: NameSchema, repo: RepoScopeSchema.optional() }),
  /** `~/.claude/agents/<name>`, or a repo's `.claude/agents/<name>` with `repo` set. */
  z.object({ kind: z.literal('agent'), name: NameSchema, repo: RepoScopeSchema.optional() }),
  /** The `claude` CLI (also `machine.claude_code_version`). */
  z.object({ kind: z.literal('claude'), version: z.string() }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityKind = Capability['kind'];

/**
 * A required capability, as a key (`capabilityKey` grammar): `claude`, `cli:<name>`,
 * `cli:<name>:authed`, `mcp:<name>`, `skill:<name>[@<repo>]`, `agent:<name>[@<repo>]`.
 */
export const CapabilityRequirementSchema = z
  .string()
  .regex(/^(?:claude|(?:cli|mcp|skill|agent):\S+)$/);
export type CapabilityRequirement = string;

/**
 * The most specific key of a capability: `cli:gh:authed` (`cli:gh` when not authed),
 * `mcp:slack`, `skill:review` / `skill:review@github.com/org/app`, `agent:…` alike, `claude`.
 * Stable: versions are never part of a key.
 */
export function capabilityKey(c: Capability): CapabilityRequirement {
  switch (c.kind) {
    case 'cli':
      return c.authed ? `cli:${c.name}:authed` : `cli:${c.name}`;
    case 'mcp':
      return `mcp:${c.name}`;
    case 'skill':
    case 'agent':
      return c.repo === undefined ? `${c.kind}:${c.name}` : `${c.kind}:${c.name}@${c.repo}`;
    case 'claude':
      return 'claude';
  }
}

/**
 * Every key a capability satisfies: an authed cli also satisfies `cli:<name>`. These are the rows
 * T09 stores in `machine_capability (machine_id, key)` (PK `(machine_id, key)`), so
 * `skill:review` and `skill:review@github.com/o/app` are separate rows.
 */
export function capabilityKeys(c: Capability): CapabilityRequirement[] {
  return c.kind === 'cli' && c.authed ? [`cli:${c.name}`, capabilityKey(c)] : [capabilityKey(c)];
}

/**
 * Whether a machine's stored keys satisfy one requirement for a ticket of `ticketRepo` (its
 * canonical repo; null = none). An exact key matches. A bare `skill:<name>` / `agent:<name>` is
 * also met by the repo-scoped `skill:<name>@<ticketRepo>`, but never by a skill of another repo.
 * The claim (M2-T16) applies the same rule in SQL.
 */
export function satisfiesCapability(
  keys: ReadonlySet<string>,
  required: CapabilityRequirement,
  ticketRepo: string | null,
): boolean {
  if (keys.has(required)) return true;
  const repoScoped = /^(?:skill|agent):[^@]+$/.test(required);
  return repoScoped && ticketRepo !== null && keys.has(`${required}@${ticketRepo}`);
}

/**
 * The requirements none of `caps` satisfies for a ticket of `ticketRepo` (see
 * satisfiesCapability), in the order given, de-duplicated. The Queued card's routing badge.
 */
export function missingCapabilities(
  caps: readonly Capability[],
  required: readonly CapabilityRequirement[],
  ticketRepo: string | null,
): CapabilityRequirement[] {
  const keys = new Set(caps.flatMap(capabilityKeys));
  return [...new Set(required)].filter((r) => !satisfiesCapability(keys, r, ticketRepo));
}

/**
 * The oldest `gh` open_pr accepts (M2-T10). A safe floor, not a verified minimum (U-076): gh 2.14
 * could not run `gh pr create --repo --head --base` outside a git repository, which open_pr does
 * by design; 2.40.0 (Dec 2023) is well past it. T11 reads it to flag an old gh on a machine.
 */
export const GH_MIN_VERSION = '2.40.0';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+\S*)?$/;

function parseVersion(v: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/**
 * Whether `version` (`X.Y.Z`, optional `v`, `-pre` and `+build`) is at least `min`. A pre-release
 * sorts below its release (`2.40.0-rc.1` < `2.40.0`). Anything unparsable (either side) → false.
 */
export function cliVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (typeof version !== 'string') return false;
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i]! !== b.nums[i]!) return a.nums[i]! > b.nums[i]!;
  }
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) >= 0;
}
