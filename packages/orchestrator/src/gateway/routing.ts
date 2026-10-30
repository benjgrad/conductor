import {
  CANONICAL_REMOTE_RE,
  isCanonicalRemote,
  requiredCapabilities,
  type BoardCardRouting,
  type CapabilityRequirement,
  type RequiredCapabilitiesFn,
  type TicketKind,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { DefinitionCache } from '../engine/rows.js';

// M2-T16a: routing (ADR-0013 §Routing; 10-contracts §Machines protocol v2 "Matching"). The claim
// applies these rules in SQL (claim.ts); the board's routing badge and the machine drawer's
// "Can't take" list apply the same rules here, on a machine's stored keys.

/** A bare `skill:<name>` / `agent:<name>`: also met by the `@<ticket repo>` scoped key. */
export const REPO_SCOPED_RE = /^(?:skill|agent):[^@]+$/;

/** The same as REPO_SCOPED_RE, for Postgres (`~`). */
export const REPO_SCOPED_SQL = '^(skill|agent):[^@]+$';

/** CANONICAL_REMOTE_RE for Postgres (ARE accepts `(?:…)`); pair it with `!~* '\.git$'`. */
export const CANONICAL_REMOTE_SQL = CANONICAL_REMOTE_RE.source;

/** A machine's routing facts: its lower-cased repo remotes and its capability keys. */
export interface MachineFacts {
  id: string;
  /** `lower(remote)` of every machine_repo with a remote. */
  remotes: ReadonlySet<string>;
  keys: ReadonlySet<string>;
  /** The same keys lower-cased (the `@<repo>` part compares case-insensitively). */
  lowerKeys: ReadonlySet<string>;
}

export function machineFacts(id: string, remotes: Iterable<string>, keys: Iterable<string>) {
  const k = new Set(keys);
  return {
    id,
    remotes: new Set([...remotes].map((r) => r.toLowerCase())),
    keys: k,
    lowerKeys: new Set([...k].map((x) => x.toLowerCase())),
  } satisfies MachineFacts;
}

/**
 * Whether a machine's keys meet one requirement for a ticket of `ticketRepo`: the exact key; a
 * key with `@<repo>` case-insensitively; a bare skill / agent met by `…@<ticketRepo>`
 * (case-insensitive). `satisfiesCapability` with the 10-contracts case rule; the claim's SQL is
 * the same.
 */
export function keySatisfies(
  m: Pick<MachineFacts, 'keys' | 'lowerKeys'>,
  req: CapabilityRequirement,
  ticketRepo: string,
): boolean {
  if (m.keys.has(req)) return true;
  if (req.includes('@') && m.lowerKeys.has(req.toLowerCase())) return true;
  return REPO_SCOPED_RE.test(req) && m.lowerKeys.has(`${req}@${ticketRepo}`.toLowerCase());
}

/** The requirements `m` doesn't meet, de-duplicated, in order. */
export function missingKeys(
  m: Pick<MachineFacts, 'keys' | 'lowerKeys'>,
  reqs: readonly CapabilityRequirement[],
  ticketRepo: string,
): CapabilityRequirement[] {
  return [...new Set(reqs)].filter((r) => !keySatisfies(m, r, ticketRepo));
}

/** Why `m` can't take a ticket (null = it can). A non-canonical repo (local mode) skips the repo. */
export function cannotTake(
  m: MachineFacts,
  ticketRepo: string,
  reqs: readonly CapabilityRequirement[],
): BoardCardRouting | null {
  const repoOk = !isCanonicalRemote(ticketRepo) || m.remotes.has(ticketRepo.toLowerCase());
  const missing = missingKeys(m, reqs, ticketRepo);
  if (repoOk && missing.length === 0) return null;
  return { ...(repoOk ? {} : { missing_repo: ticketRepo }), missing_capabilities: missing };
}

/**
 * A Queued card's `routing`: undefined when some online machine can take it. Else the repo when
 * no online machine has it, and the capabilities the closest machine lacks (fewest missing; among
 * those with the repo when any has it); with no online machine, every requirement.
 */
export function routingFor(
  machines: readonly MachineFacts[],
  ticketRepo: string,
  reqs: readonly CapabilityRequirement[],
): BoardCardRouting | undefined {
  const canonical = isCanonicalRemote(ticketRepo);
  const withRepo = canonical
    ? machines.filter((m) => m.remotes.has(ticketRepo.toLowerCase()))
    : machines;
  const pool = withRepo.length > 0 ? withRepo : machines;
  let closest: CapabilityRequirement[] | null = null;
  for (const m of pool) {
    const missing = missingKeys(m, reqs, ticketRepo);
    if (closest === null || missing.length < closest.length) closest = missing;
  }
  if (withRepo.length > 0 && closest !== null && closest.length === 0) return undefined;
  return {
    ...(canonical && withRepo.length === 0 ? { missing_repo: ticketRepo } : {}),
    missing_capabilities: closest ?? [...new Set(reqs)],
  };
}

/** Routing facts of every online, unrevoked machine of an account. */
export async function loadOnlineMachines(q: Queryable, accountId: string): Promise<MachineFacts[]> {
  const m = await q.query<{ id: string }>(
    `SELECT id FROM machine
      WHERE account_id = $1 AND status = 'online' AND revoked_at IS NULL ORDER BY id`,
    [accountId],
  );
  const ids = m.rows.map((r) => r.id);
  return loadMachineFacts(q, ids);
}

/** Routing facts of the given machines (in that order). */
export async function loadMachineFacts(q: Queryable, ids: string[]): Promise<MachineFacts[]> {
  if (ids.length === 0) return [];
  const repos = await q.query<{ machine_id: string; remote: string }>(
    `SELECT machine_id, remote FROM machine_repo
      WHERE machine_id = ANY($1::text[]) AND remote IS NOT NULL`,
    [ids],
  );
  const caps = await q.query<{ machine_id: string; key: string }>(
    'SELECT machine_id, key FROM machine_capability WHERE machine_id = ANY($1::text[])',
    [ids],
  );
  return ids.map((id) =>
    machineFacts(
      id,
      repos.rows.filter((r) => r.machine_id === id).map((r) => r.remote),
      caps.rows.filter((r) => r.machine_id === id).map((r) => r.key),
    ),
  );
}

/**
 * `requiredCapabilities(def, kind)` per (workflow, version, kind), cached: definitions are
 * immutable per version.
 * TD: computed from the definition until M2-T12 stores required_capabilities on save.
 */
export class RequiredCaps {
  private readonly cache = new Map<string, CapabilityRequirement[]>();
  private readonly defs = new DefinitionCache();

  constructor(private readonly fn: RequiredCapabilitiesFn = requiredCapabilities) {}

  async get(
    q: Queryable,
    workflowId: string,
    version: number,
    kind: TicketKind | null,
  ): Promise<CapabilityRequirement[]> {
    const key = `${workflowId}\0${version}\0${kind ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const reqs = this.fn(await this.defs.get(q, workflowId, version), kind);
    this.cache.set(key, reqs);
    return reqs;
  }
}

/** The process-wide cache (the claim, the board, the machines API). */
export const requiredCaps = new RequiredCaps();

/** SQL for a ticket's effective workflow version: pinned, else the latest. Needs `ticket t`. */
export const EFFECTIVE_VERSION_SQL =
  'COALESCE(t.workflow_version, ' +
  '(SELECT max(w.version) FROM workflow_definition w WHERE w.id = t.workflow_id))';
