#!/usr/bin/env node
import { runAdminCli, runVapidKeys } from './auth/admin-commands.js';
import { ConfigError, PUBLIC_URL_ENV, parsePublicUrl } from './auth/config.js';
import { createDb } from './db/index.js';

// `conductor-admin` (M2-T15a; commands in auth/admin-commands.ts). Env: DATABASE_URL (required),
// CONDUCTOR_PUBLIC_URL (for the links); `vapid-keys` needs neither. In the container: `node dist/admin-cli.js <command>`.
const write = (stream: NodeJS.WriteStream) => (line: string) => {
  stream.write(`${line}\n`);
};

async function run(): Promise<number> {
  const err = write(process.stderr);
  const [command, ...args] = process.argv.slice(2);
  // UX-15: key generation touches no database.
  if (command === 'vapid-keys') return runVapidKeys(args, write(process.stdout), err);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    err('[conductor-admin] DATABASE_URL is required');
    return 1;
  }
  const rawUrl = process.env[PUBLIC_URL_ENV]?.trim();
  let publicUrl: URL | null = null;
  if (rawUrl) {
    try {
      publicUrl = parsePublicUrl(rawUrl).publicUrl;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      err(`[conductor-admin] ${e.message}`);
      return 1;
    }
  }
  const db = createDb({ databaseUrl });
  try {
    return await runAdminCli(process.argv.slice(2), {
      db,
      publicUrl,
      now: () => new Date(),
      out: write(process.stdout),
      err,
    });
  } finally {
    await db.end();
  }
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(
      `[conductor-admin] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exitCode = 1;
  },
);
