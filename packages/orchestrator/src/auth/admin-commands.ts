import { EmailSchema, LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { withTransaction } from '../db/index.js';
import { revokeMachine, type MachineSockets } from '../gateway/revoke.js';
import type { Db } from '../main.js';
import { PUBLIC_URL_ENV } from './config.js';
import { createInvite } from './invites.js';
import { createResetLink } from './reset.js';
import { clearThrottle, isLocked, throttleKey } from './throttle.js';

// M2-T15a: `conductor-admin` (ADR-0017 §Invites, sign-up, resets, the admin; U-056), run on the
// server against DATABASE_URL (`node dist/admin-cli.js …` in the container). The entry point
// is src/admin-cli.ts; the commands live here so tests can run them in-process. Output is links
// and plain facts only: never a hash, never a password. `invite` (general invites) is M2-T15b.

export const BOOTSTRAP_TTL_MS = 3600_000;
export const BOOTSTRAP_UNPINNED_WARNING =
  'warning: this invite works for any email; run bootstrap --email <addr> to pin it to yours';
const BOOTSTRAP_USAGE = 'usage: conductor-admin bootstrap [--email <addr>]';

export interface AdminCliIo {
  db: Db;
  /** CONDUCTOR_PUBLIC_URL, parsed; null when unset (commands that print links refuse). */
  publicUrl: URL | null;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = [
  'usage: conductor-admin <command>',
  '  bootstrap [--email <addr>]',
  '                            print a one-hour admin invite that claims the local account',
  '                            (--email pins it: only that email can sign up with it)',
  '  reset-link <email>        print a one-hour password reset link',
  '  unlock <email>            clear the sign-in lockout for an email',
  '  revoke-sessions <email>   sign the user out everywhere',
  "  disable <email>           disable the user, sign them out, revoke their accounts' machines",
  '  list-users                list users',
].join('\n');

/** The CLI has no gateway: it can't reach the orchestrator process's daemon sockets. */
const NO_SOCKETS: MachineSockets = { disconnectMachine: () => undefined };

interface UserRow {
  id: string;
  email: string;
}

/** Run one command; resolves to the process exit code (0 ok, 1 refused or failed, 2 usage). */
export async function runAdminCli(argv: string[], io: AdminCliIo): Promise<number> {
  const [command, ...args] = argv;
  const { db, now, out, err } = io;

  const needUrl = (): URL | null => {
    if (io.publicUrl === null) err(`${PUBLIC_URL_ENV} is required for this command`);
    return io.publicUrl;
  };
  const oneEmail = (): string | null => {
    if (args.length !== 1 || args[0]!.trim() === '') {
      err(`usage: conductor-admin ${command} <email>`);
      return null;
    }
    return throttleKey(args[0]!);
  };
  const findUser = async (email: string): Promise<UserRow | null> => {
    const res = await db.query<UserRow>('SELECT id, email FROM app_user WHERE lower(email) = $1', [
      email,
    ]);
    const user = res.rows[0] ?? null;
    if (user === null) err(`no user with the email ${email}`);
    return user;
  };

  switch (command) {
    case 'bootstrap': {
      // `bootstrap`, `bootstrap --email <addr>` or `bootstrap --email=<addr>`.
      let rawEmail: string | null = null;
      if (args.length === 2 && args[0] === '--email') rawEmail = args[1]!;
      else if (args.length === 1 && args[0]!.startsWith('--email=')) {
        rawEmail = args[0]!.slice('--email='.length);
      } else if (args.length !== 0) {
        err(BOOTSTRAP_USAGE);
        return 2;
      }
      let email: string | null = null;
      if (rawEmail !== null) {
        // Normalised like the sign-up body, so the pinned email compares equal.
        const parsed = EmailSchema.safeParse(rawEmail);
        if (!parsed.success) {
          err(`invalid email: ${rawEmail}`);
          err(BOOTSTRAP_USAGE);
          return 2;
        }
        email = parsed.data;
      }
      const publicUrl = needUrl();
      if (publicUrl === null) return 1;
      const t = now();
      const invite = await withTransaction(db, async (tx) => {
        // Serialise concurrent bootstraps; the check and the insert see the same users.
        await tx.query('LOCK TABLE invite IN SHARE ROW EXCLUSIVE MODE');
        const users = await tx.query('SELECT 1 FROM app_user LIMIT 1');
        if ((users.rowCount ?? 0) > 0) return null;
        // Only the newest bootstrap link works.
        await tx.query(
          'UPDATE invite SET revoked_at = $1 ' +
            'WHERE claims_account IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL',
          [t],
        );
        return createInvite(tx, {
          publicUrl,
          now: t,
          ttlMs: BOOTSTRAP_TTL_MS,
          isAdmin: true,
          claimsAccount: LOCAL_ACCOUNT_ID,
          email,
          createdBy: null,
        });
      });
      if (invite === null) {
        err('refusing: a user already exists (use reset-link <email> to recover access)');
        return 1;
      }
      if (email === null) err(BOOTSTRAP_UNPINNED_WARNING);
      out(
        email === null
          ? 'Admin invite (claims the local account). Open it and sign up:'
          : `Admin invite for ${email} (claims the local account). Open it and sign up:`,
      );
      out(invite.url);
      out(`expires ${invite.expires_at.toISOString()} (1 hour)`);
      return 0;
    }

    case 'reset-link': {
      const email = oneEmail();
      if (email === null) return 2;
      const publicUrl = needUrl();
      if (publicUrl === null) return 1;
      const user = await findUser(email);
      if (user === null) return 1;
      const link = await createResetLink(db, {
        userId: user.id,
        publicUrl,
        now: now(),
        createdBy: null,
      });
      out(`Password reset link for ${user.email} (works once):`);
      out(link.url);
      out(`expires ${link.expires_at.toISOString()} (1 hour)`);
      return 0;
    }

    case 'unlock': {
      const email = oneEmail();
      if (email === null) return 2;
      // Keyed by the string, user or not (ADR-0017 layer 3).
      await clearThrottle(db, email);
      out(`unlocked ${email}`);
      return 0;
    }

    case 'revoke-sessions': {
      const email = oneEmail();
      if (email === null) return 2;
      const user = await findUser(email);
      if (user === null) return 1;
      const res = await db.query('DELETE FROM web_session WHERE user_id = $1', [user.id]);
      out(`revoked ${res.rowCount ?? 0} session(s) for ${user.email}`);
      return 0;
    }

    case 'disable': {
      const email = oneEmail();
      if (email === null) return 2;
      const user = await findUser(email);
      if (user === null) return 1;
      const t = now();
      const sessions = await withTransaction(db, async (tx) => {
        await tx.query(
          'UPDATE app_user SET disabled_at = COALESCE(disabled_at, $2) WHERE id = $1',
          [user.id, t],
        );
        const res = await tx.query('DELETE FROM web_session WHERE user_id = $1', [user.id]);
        return res.rowCount ?? 0;
      });
      // "The user's machines": those of the accounts they own (machines have no per-user owner).
      const machines = await db.query<{ id: string; account_id: string }>(
        'SELECT m.id, m.account_id FROM machine m JOIN account_member am ' +
          "ON am.account_id = m.account_id AND am.role = 'owner' " +
          'WHERE am.user_id = $1 AND m.revoked_at IS NULL ORDER BY m.id',
        [user.id],
      );
      for (const m of machines.rows) {
        // TD-174: a live daemon socket stays open until it reconnects (the gateway is in
        // another process) until M2-T15b runs this in-process with the gateway; its credential
        // is revoked and its outbox rows failed, so the reconnect is refused and it gets no new
        // commands.
        await revokeMachine(
          { db, sockets: NO_SOCKETS },
          { account_id: m.account_id, actor: { kind: 'system' } },
          m.id,
        );
      }
      out(
        `disabled ${user.email}: revoked ${sessions} session(s) and ${machines.rows.length} machine(s)`,
      );
      return 0;
    }

    case 'list-users': {
      if (args.length !== 0) {
        err('usage: conductor-admin list-users');
        return 2;
      }
      const res = await db.query<{
        email: string;
        display_name: string;
        is_admin: boolean;
        disabled_at: Date | null;
        created_at: Date;
      }>(
        'SELECT email, display_name, is_admin, disabled_at, created_at FROM app_user ' +
          'ORDER BY created_at, email',
      );
      if (res.rows.length === 0) {
        out('no users (run bootstrap)');
        return 0;
      }
      const t = now();
      out('email\tname\tadmin\tdisabled\tlocked\tcreated');
      for (const u of res.rows) {
        const locked = await isLocked(db, throttleKey(u.email), t);
        out(
          [
            u.email,
            u.display_name,
            u.is_admin ? 'yes' : 'no',
            u.disabled_at === null ? 'no' : u.disabled_at.toISOString(),
            locked ? 'yes' : 'no',
            u.created_at.toISOString(),
          ].join('\t'),
        );
      }
      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      (command === undefined ? err : out)(USAGE);
      return command === undefined ? 2 : 0;

    default:
      err(`unknown command: ${command}`);
      err(USAGE);
      return 2;
  }
}
