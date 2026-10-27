import { existsSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { WorkingCopyModeSchema } from '@conductor/shared';
import {
  fileConfigPath,
  machineFacts,
  readFileConfig,
  rootDirFrom,
  rootsFromEnv,
  writeFileConfig,
  type MachineFacts,
} from '../config.js';

// `conductor-daemon config …` (M2-T10; ADR-0013 §Inventory): the repo roots the inventory scans
// and each repo's working-copy mode (U-060), in `<root>/config.json` (0600). A running daemon
// re-reads the file on its next scan: send it SIGHUP (or restart it) to apply a change now.

export const CONFIG_USAGE = [
  'usage: conductor-daemon config roots <dir…>',
  '       conductor-daemon config repo <path> --mode reference|checkout',
  '       conductor-daemon config show',
].join('\n');

export interface ConfigDeps {
  env: Record<string, string | undefined>;
  facts: Pick<MachineFacts, 'home'>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultDeps(): ConfigDeps {
  return {
    env: process.env,
    facts: machineFacts(),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`[conductor-daemon] ${l}\n`),
  };
}

const APPLY_HINT =
  'a running daemon picks this up on its next scan; `kill -HUP <pid>` (or a restart) applies it now';

/** An existing directory as a realpath (the inventory reports realpaths), or an error. */
function existingDir(raw: string): { path: string } | { error: string } {
  const abs = resolve(raw);
  try {
    if (!statSync(abs).isDirectory()) return { error: `${abs} is not a directory` };
    return { path: realpathSync(abs) };
  } catch {
    return { error: `${abs} does not exist` };
  }
}

const under = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function configCommand(argv: string[], deps: Partial<ConfigDeps> = {}): number {
  const d = { ...defaultDeps(), ...deps };
  const root = rootDirFrom(d.env, d.facts);
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'roots': {
        if (rest.length === 0) {
          d.err('config roots needs at least one directory');
          d.err(CONFIG_USAGE);
          return 2;
        }
        const roots: string[] = [];
        for (const raw of rest) {
          const r = existingDir(raw);
          if ('error' in r) {
            d.err(r.error);
            return 2;
          }
          if (!roots.includes(r.path)) roots.push(r.path);
        }
        const cfg = readFileConfig(root);
        const path = writeFileConfig(root, { ...cfg, roots });
        d.out(`roots: ${roots.join(', ')} (saved to ${path})`);
        if (rootsFromEnv(d.env) !== null) d.err('note: CONDUCTOR_ROOTS is set and overrides these');
        d.out(APPLY_HINT);
        return 0;
      }
      case 'repo': {
        let values: { mode?: string };
        let positionals: string[];
        try {
          ({ values, positionals } = parseArgs({
            args: rest,
            options: { mode: { type: 'string' } },
            strict: true,
            allowPositionals: true,
          }));
        } catch (e) {
          d.err(e instanceof Error ? e.message : String(e));
          d.err(CONFIG_USAGE);
          return 2;
        }
        const mode = WorkingCopyModeSchema.safeParse(values.mode);
        if (positionals.length !== 1 || !mode.success) {
          d.err(
            positionals.length !== 1
              ? 'config repo needs exactly one <path>'
              : `--mode must be reference or checkout (got ${values.mode ?? 'nothing'})`,
          );
          d.err(CONFIG_USAGE);
          return 2;
        }
        const r = existingDir(positionals[0]!);
        if ('error' in r) {
          d.err(r.error);
          return 2;
        }
        if (!existsSync(join(r.path, '.git'))) {
          d.err(`${r.path} is not a git work tree (no .git)`);
          return 2;
        }
        const cfg = readFileConfig(root);
        const roots = rootsFromEnv(d.env) ?? cfg.roots;
        const path = writeFileConfig(root, {
          ...cfg,
          repos: { ...cfg.repos, [r.path]: { mode: mode.data } },
        });
        d.out(`${r.path}: mode ${mode.data} (saved to ${path})`);
        if (!roots.some((x) => under(r.path, x))) {
          d.err(`warning: ${r.path} is not under a configured root, so it isn't scanned`);
        }
        d.out(APPLY_HINT);
        return 0;
      }
      case 'show': {
        const cfg = readFileConfig(root);
        const override = rootsFromEnv(d.env);
        d.out(
          JSON.stringify(
            {
              file: fileConfigPath(root),
              roots: override ?? cfg.roots,
              roots_from: override !== null ? 'CONDUCTOR_ROOTS' : 'file',
              repos: cfg.repos,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      default:
        d.err(sub === undefined ? 'config needs a subcommand' : `unknown config command: ${sub}`);
        d.err(CONFIG_USAGE);
        return 2;
    }
  } catch (e) {
    d.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
