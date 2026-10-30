import {
  cliVersionAtLeast,
  GH_MIN_VERSION,
  type BoardCardRouting,
  type MachineCannotTake,
  type MachineDetail,
} from '@conductor/shared';

// M2-T11: text for the Machines page and the board's routing / alert badges.

/**
 * The add-a-machine guide (UX-8): a page of the web app itself (help/HelpPage.tsx), which works
 * signed out and makes no API calls. docs/setup/add-a-machine.md is a copy for the repo.
 */
export const SETUP_GUIDE_URL = '/help/add-a-machine';

/**
 * Whether the installer's `--service` (start the daemon at login) works yet. The daemon's
 * `service install` arrives with M2-T18; until then the setup guide says it's coming.
 */
// TD-189: flip when M2-T18 ships `conductor-daemon service install`.
export const SERVICE_INSTALL_AVAILABLE = false;

/**
 * The machine's `gh` version when it is below GH_MIN_VERSION (open_pr can't use it), else null.
 * An unknown version (null) is not flagged: the probe may simply have failed.
 */
export function ghTooOld(capabilities: MachineDetail['capabilities']): string | null {
  const gh = capabilities.cli.find((c) => c.name === 'gh');
  if (!gh || gh.version === null) return null;
  return cliVersionAtLeast(gh.version, GH_MIN_VERSION) ? null : gh.version;
}

export function ghTooOldText(version: string): string {
  return `gh ${version} is too old for pull requests (needs ≥ ${GH_MIN_VERSION})`;
}

/**
 * The install command with `--service` (start the daemon at login), or null when `command` isn't
 * one of the two shapes we know; the page then hides the variant rather than guess. 10-contracts
 * says the web appends ` --service`, which is right for `… | sh -s -- --token <t>`. A command that
 * pipes into a bare `sh` (the token in CONDUCTOR_ENROLL_TOKEN, T17's fix) needs `-s --` first, or
 * `sh` would take `--service` as its own option.
 */
export function serviceCommand(command: string): string | null {
  const trimmed = command.trimEnd();
  if (/(^|[\s|])sh -s -- /.test(trimmed)) return `${trimmed} --service`;
  if (/(^|[\s|])sh$/.test(trimmed)) return `${trimmed} -s -- --service`;
  return null;
}

/** `mm:ss` for a countdown; never negative. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** `github.com/org/app` → `org/app`; other hosts keep the host. */
export function shortRepo(remote: string): string {
  return remote.replace(/^github\.com\//i, '');
}

/** A capability key (10-contracts key table) as a person reads it: `cli:az:authed` → `az (signed in)`. */
export function formatRequirement(key: string): string {
  if (key === 'claude') return 'claude';
  const [kind, ...rest] = key.split(':');
  const name = rest.join(':');
  switch (kind) {
    case 'cli':
      return name.endsWith(':authed') ? `${name.slice(0, -':authed'.length)} (signed in)` : name;
    case 'mcp':
      return `${name} MCP server`;
    case 'skill':
    case 'agent': {
      const at = name.indexOf('@');
      return `${kind} ${at === -1 ? name : name.slice(0, at)}`;
    }
    default:
      return key;
  }
}

/** What a Queued card is waiting for (ADR-0013 §Routing): the repo first, then capabilities. */
export function routingNeeds(routing: BoardCardRouting): string[] {
  return [
    ...(routing.missing_repo ? [shortRepo(routing.missing_repo)] : []),
    ...routing.missing_capabilities.map(formatRequirement),
  ];
}

/** `only A takes this repo`, `only A and B take this repo`, `only A, B and C take this repo`. */
function onlyTakes(names: readonly string[]): string {
  if (names.length <= 1) return `only ${names[0] ?? ''} takes this repo`;
  return `only ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} take this repo`;
}

/**
 * The repo-rule part of a Queued card's routing (ADR-0013 amendment 2026-10-30), or null: the
 * machines that alone take the repo (none online), else that the online machines' own repo rules
 * leave it out.
 */
export function routingRule(routing: BoardCardRouting): string | null {
  if (routing.exclusive_to && routing.exclusive_to.length > 0) {
    return onlyTakes(routing.exclusive_to);
  }
  return routing.excluded_by_rule ? "left out by the machines' repo rules" : null;
}

/** Why one machine can't take a queued ticket: its repo rules first, then what it lacks. */
export function cannotTakeReasons(t: MachineCannotTake): string[] {
  const needs = routingNeeds(t);
  return [
    ...(t.exclusive_to && t.exclusive_to.length > 0 ? [onlyTakes(t.exclusive_to)] : []),
    ...(t.excluded_by_rule ? ["not in this machine's repo rules"] : []),
    ...(needs.length > 0 ? [`needs ${needs.join(', ')}`] : []),
  ];
}
