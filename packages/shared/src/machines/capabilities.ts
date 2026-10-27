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

const REQUIREMENT_RE =
  /^(?:claude|cli:[^\s:@\0]+(?::authed)?|mcp:[^\s:@\0]+|(?:skill|agent):[^\s:@\0]+(?:@(.*))?)$/;

/**
 * Whether `s` is a capability key (the 10-contracts key table): `claude`, `cli:<name>`,
 * `cli:<name>:authed`, `mcp:<name>`, `skill:<name>[@<repo>]`, `agent:<name>[@<repo>]`. A name has
 * no whitespace, `:` or `@`; `<repo>` is a canonical remote. So `cli:a:b:c` is refused.
 */
export function isCapabilityRequirement(s: string): boolean {
  const m = REQUIREMENT_RE.exec(s);
  if (m === null) return false;
  return m[1] === undefined || isCanonicalRemote(m[1]);
}

/** A required capability, as a key (`isCapabilityRequirement`). */
export const CapabilityRequirementSchema = z
  .string()
  .refine(isCapabilityRequirement, 'expected a capability key (e.g. cli:gh:authed)');
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
