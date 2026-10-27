import {
  cliVersionAtLeast,
  GH_MIN_VERSION,
  type BoardCardRouting,
  type MachineDetail,
} from '@conductor/shared';

// M2-T11: text for the Machines page and the board's routing / alert badges.

/** The setup guide the Add-a-machine panel links to (M2-T18), served from the repo on GitHub. */
export const SETUP_GUIDE_URL =
  'https://github.com/benjgrad/conductor/blob/main/docs/setup/add-a-machine.md';

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
 * The install command with `--service` (start the daemon at login). 10-contracts says the web
 * appends ` --service`; that is right while the command ends in `sh -s -- --token <t>`. If the
 * command pipes into a bare `sh` (the token in an env var, T17's fix), the script's arguments
 * need `-s --` first, or `sh` would take `--service` as its own option.
 */
export function serviceCommand(command: string): string {
  const trimmed = command.trimEnd();
  if (/\bsh -s --(\s|$)/.test(trimmed)) return `${trimmed} --service`;
  if (/\bsh$/.test(trimmed)) return `${trimmed} -s -- --service`;
  return `${trimmed} --service`;
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
