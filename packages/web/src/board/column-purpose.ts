import type { BoardColumnInfo } from '@conductor/shared';

// UXR-54: an empty column says, in one muted line, what it is for (11-web-ui §Empty columns).

/** The columns of the `conductor` and `routine` workflows, by id. */
const BY_ID: Readonly<Record<string, string>> = {
  queued: 'Tickets waiting for a machine.',
  planning: 'Agents plan tickets here.',
  implementing: 'Agents do the work here.',
  running: 'Agents run routine jobs here.',
  needs_input: 'Tickets waiting on you.',
  waiting_external: 'Waiting on a PR review or CI.',
  done: 'Finished tickets.',
};

/** Any other workflow's columns, by the type of state they show. */
const BY_KIND: Readonly<Record<BoardColumnInfo['kind'], string>> = {
  queued: BY_ID.queued!,
  agent: 'An agent works on tickets here.',
  command: 'Checks run here.',
  event: 'Waiting on something outside conductor.',
  connector: 'Waiting on another service.',
  human: 'Tickets waiting on you.',
  terminal: 'Finished tickets.',
};

/** One short line: what `col` is for. */
export function columnPurpose(col: Pick<BoardColumnInfo, 'id' | 'kind'>): string {
  return (Object.hasOwn(BY_ID, col.id) ? BY_ID[col.id] : undefined) ?? BY_KIND[col.kind];
}
