// The version token of a CLI's `--version` output (M2-T10). Only the matched `X.Y.Z[-pre]` is ever
// returned, never the rest of the output, so no account or host text can leak into a report.

const VERSION_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export function cliVersionFrom(output: string): string | null {
  return VERSION_TOKEN.exec(output)?.[0] ?? null;
}
