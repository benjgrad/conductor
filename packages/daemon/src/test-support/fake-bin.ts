import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Portable fake executables for tests (ADR-0024 §9, windows-spike FR-2 N13).
 *
 * POSIX: `<dir>/<name>`, a `#!/usr/bin/env node` script, mode 755.
 * win32: `<dir>/<name>.mjs` plus a `<dir>/<name>.cmd` shim (`@node "%~dp0<name>.mjs" %*`), so
 * `PATH` lookup of `<name>` finds the `.cmd` through `PATHEXT`. A `.cmd` can only be started
 * through `cmd.exe`, so callers on win32 must go through `cmd.exe /d /s /c` with escaped args.
 *
 * `jsSource` runs as an ES module on win32 (`.mjs`) and through Node's module detection on POSIX
 * (an extensionless file), so write it with `import`, never `require`.
 *
 * Returns the path to start: the script on POSIX, the `.cmd` shim on win32.
 */
export function writeFakeBin(
  dir: string,
  name: string,
  jsSource: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    writeFileSync(join(dir, `${name}.mjs`), jsSource);
    const shim = join(dir, `${name}.cmd`);
    writeFileSync(shim, `@node "%~dp0${name}.mjs" %*\r\n`);
    return shim;
  }
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${jsSource}`);
  chmodSync(file, 0o755);
  return file;
}

/** `dirs` joined with the platform `PATH` delimiter (`:` on POSIX, `;` on win32). */
export function pathWith(...dirs: string[]): string {
  return dirs.filter((d) => d !== '').join(delimiter);
}

/**
 * `base` with `PATH` replaced. Every case variant is removed first: Windows env names are
 * case-insensitive, `{...process.env}` keeps `Path`, and a second `PATH` key next to it would lose
 * to it in a case-insensitive lookup (platform/spawn.ts envGet takes the first match).
 */
export function envWithPath(base: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (k.toLowerCase() !== 'path') out[k] = v;
  out.PATH = path;
  return out;
}
