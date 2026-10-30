import {
  CANONICAL_REMOTE_RE,
  isCanonicalRemote,
  repoRulesMatch,
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
// "Can't take" list apply the same rules here, on a machine's stored keys and repo rules
// (`machine.repo_allow` / `repo_exclusive`, ADR-0013 amendment 2026-10-30).

/** A bare `skill:<name>` / `agent:<name>`: also met by the `@<ticket repo>` scoped key. */
export const REPO_SCOPED_RE = /^(?:skill|agent):[^@]+$/;

/** The same as REPO_SCOPED_RE, for Postgres (`~`). */
export const REPO_SCOPED_SQL = '^(skill|agent):[^@]+$';

/** CANONICAL_REMOTE_RE for Postgres (ARE accepts `(?:…)`); pair it with `!~* '\.git$'`. */
export const CANONICAL_REMOTE_SQL = CANONICAL_REMOTE_RE.source;

/**
 * `repoPatternMatches(p, t.repo)` in SQL, for a pattern column or alias `p` and `ticket t`: the
 * same repo case-insensitively, or for `prefix/*` a repo under `prefix/` (`starts_with`, not
 * LIKE: `_` is legal in a segment).
 */
export const REPO_PATTERN_MATCH_SQL =
  "(lower(t.repo) = lower(p) OR (right(p, 2) = '/*' AND " +
  'starts_with(lower(t.repo), lower(left(p, -1)))))';

/** A machine's routing facts: its lower-cased repo remotes, its capability keys, its repo_allow. */
export interface MachineFacts {
  id: string;
  /** `lower(remote)` of every machine_repo with a remote. */
  remotes: ReadonlySet<string>;
  keys: ReadonlySet<string>;
  /** The same keys lower-cased (the `@<repo>` part compares case-insensitively). */
  lowerKeys: ReadonlySet<string>;
  /** `machine.repo_allow`: the repo patterns it may take; null = any. */
  repoAllow: readonly string[] | null;
}

/** An unrevoked machine's `repo_exclusive` (online or not): repos only it may take. */
export interface ExclusiveRule {
  machineId: string;
  /** The display name (`name`, else the hostname), for `exclusive_to`. */
  name: string;
  patterns: readonly string[];
}

export function machineFacts(
  id: string,
  remotes: Iterable<string>,
  keys: Iterable<string>,
  repoAllow: readonly string[] | null = null,
) {
  const k = new Set(keys);
  return {
    id,
    remotes: new Set([...remotes].map((r) => r.toLowerCase())),
    keys: k,
    lowerKeys: new Set([...k].map((x) => x.toLowerCase())),
    repoAllow,
  } satisfies MachineFacts;
}

/** Whether the machine's own `repo_allow` excludes `ticketRepo`. */
export function excludedByAllow(m: Pick<MachineFacts, 'repoAllow'>, ticketRepo: string): boolean {
  return m.repoAllow !== null && !repoRulesMatch(m.repoAllow, ticketRepo);
}

/** The exclusive rules of machines other than `machineId` that claim `ticketRepo`. */
export function exclusiveHolders(
  exclusive: readonly ExclusiveRule[],
  machineId: string | null,
  ticketRepo: string,
): ExclusiveRule[] {
  return exclusive.filter(
    (r) => r.machineId !== machineId && repoRulesMatch(r.patterns, ticketRepo),
  );
}

/** The repo-rule part of `cannotTake`: `{}` when the rules let `m` take the repo. */
function ruleReasons(
  m: MachineFacts,
  ticketRepo: string,
  exclusive: readonly ExclusiveRule[],
): Pick<BoardCardRouting, 'excluded_by_rule' | 'exclusive_to'> {
  const holders = exclusiveHolders(exclusive, m.id, ticketRepo);
  return {
    ...(excludedByAllow(m, ticketRepo) ? { excluded_by_rule: true as const } : {}),
    ...(holders.length > 0 ? { exclusive_to: holders.map((h) => h.name) } : {}),
  };
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

/**
 * Why `m` can't take a ticket (null = it can). A non-canonical repo (local mode) skips the repo.
 * `exclusive`: the account's exclusive rules (`loadExclusiveRules`); `m`'s own are ignored.
 */
export function cannotTake(
  m: MachineFacts,
  ticketRepo: string,
  reqs: readonly CapabilityRequirement[],
  exclusive: readonly ExclusiveRule[] = [],
): BoardCardRouting | null {
  const repoOk = !isCanonicalRemote(ticketRepo) || m.remotes.has(ticketRepo.toLowerCase());
  const missing = missingKeys(m, reqs, ticketRepo);
  const rules = ruleReasons(m, ticketRepo, exclusive);
  if (repoOk && missing.length === 0 && Object.keys(rules).length === 0) return null;
  return {
    ...(repoOk ? {} : { missing_repo: ticketRepo }),
    missing_capabilities: missing,
    ...rules,
  };
}

/**
 * A Queued card's `routing`: undefined when some online machine can take it. The repo rules go
 * first: only the online machines they allow are considered. Among those, the repo when none has
 * it, and the capabilities the closest machine lacks (fewest missing; among those with the repo
 * when any has it); with no machine, every requirement. `exclusive_to` names the machines whose
 * `repo_exclusive` claims the repo when none of them may take it now (offline); `excluded_by_rule`
 * says some online machine's own `repo_allow` leaves it out. When the rules allow no online
 * machine, only those two are reported (`missing_capabilities: []`).
 */
export function routingFor(
  machines: readonly MachineFacts[],
  ticketRepo: string,
  reqs: readonly CapabilityRequirement[],
  exclusive: readonly ExclusiveRule[] = [],
): BoardCardRouting | undefined {
  const allowed = machines.filter(
    (m) => Object.keys(ruleReasons(m, ticketRepo, exclusive)).length === 0,
  );
  const base = poolRouting(allowed, ticketRepo, reqs);
  if (base === undefined) return undefined;
  const holders = exclusiveHolders(exclusive, null, ticketRepo);
  const rules: Pick<BoardCardRouting, 'excluded_by_rule' | 'exclusive_to'> = {
    ...(machines.some((m) => excludedByAllow(m, ticketRepo)) ? { excluded_by_rule: true } : {}),
    ...(holders.length > 0 && !holders.some((h) => allowed.some((m) => m.id === h.machineId))
      ? { exclusive_to: holders.map((h) => h.name) }
      : {}),
  };
  // The rules alone keep it waiting: what the excluded machines lack is beside the point.
  if (allowed.length === 0 && Object.keys(rules).length > 0) {
    return { missing_capabilities: [], ...rules };
  }
  return { ...base, ...rules };
}

/** `routingFor` on a pool of machines, without the repo rules. */
function poolRouting(
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

/** The `repo_exclusive` rules of every unrevoked machine of an account, online or not. */
export async function loadExclusiveRules(
  q: Queryable,
  accountId: string,
): Promise<ExclusiveRule[]> {
  const r = await q.query<{ id: string; name: string; repo_exclusive: string[] }>(
    `SELECT id, COALESCE(name, hostname) AS name, repo_exclusive FROM machine
      WHERE account_id = $1 AND revoked_at IS NULL AND cardinality(repo_exclusive) > 0
      ORDER BY id`,
    [accountId],
  );
  return r.rows.map((x) => ({ machineId: x.id, name: x.name, patterns: x.repo_exclusive }));
}

/** What `routingFor` needs for an account: its online machines and its exclusive rules. */
export interface RoutingFleet {
  online: MachineFacts[];
  exclusive: ExclusiveRule[];
}

export async function loadRoutingFleet(q: Queryable, accountId: string): Promise<RoutingFleet> {
  return {
    online: await loadOnlineMachines(q, accountId),
    exclusive: await loadExclusiveRules(q, accountId),
  };
}

/** Routing facts of the given machines (in that order). */
export async function loadMachineFacts(q: Queryable, ids: string[]): Promise<MachineFacts[]> {
  if (ids.length === 0) return [];
  const allow = await q.query<{ id: string; repo_allow: string[] | null }>(
    'SELECT id, repo_allow FROM machine WHERE id = ANY($1::text[])',
    [ids],
  );
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
      allow.rows.find((r) => r.id === id)?.repo_allow ?? null,
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
