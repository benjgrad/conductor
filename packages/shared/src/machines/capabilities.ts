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
  /** `~/.claude/skills/<name>`, or `<repo>/.claude/skills/<name>` with `repo` set. */
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

/** Every key a capability satisfies: an authed cli also satisfies `cli:<name>`. */
export function capabilityKeys(c: Capability): CapabilityRequirement[] {
  return c.kind === 'cli' && c.authed ? [`cli:${c.name}`, capabilityKey(c)] : [capabilityKey(c)];
}

/** The requirements none of `caps` satisfies, in the order given, de-duplicated. */
export function missingCapabilities(
  caps: readonly Capability[],
  required: readonly CapabilityRequirement[],
): CapabilityRequirement[] {
  const have = new Set(caps.flatMap(capabilityKeys));
  return [...new Set(required)].filter((r) => !have.has(r));
}
