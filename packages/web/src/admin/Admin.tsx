import {
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  type AdminUserRow,
  type CreateInviteRequest,
  type InviteRow,
  type MeResponse,
} from '@conductor/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { authErrorMessage } from '../auth/errors.js';
import { formatTime, inviteStatus } from './format.js';
import { OneTimeLink } from './OneTimeLink.js';
import './admin.css';

export const ADMINS_ONLY = 'Only admins can see this page.';
/** Sign-up with an API-created (general) invite is refused until M2-T15b. */
export const NEW_ACCOUNTS_NOTE = 'New accounts arrive with M2-T15b';

interface AdminPageProps {
  api: ApiClient;
  me: MeResponse;
}

type Lists =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; text: string }
  | { kind: 'loaded'; users: AdminUserRow[]; invites: InviteRow[] };

/** A URL shown once: the created invite or reset link (cleared on close). */
interface ShownLink {
  title: 'Invite link' | 'Reset link';
  url: string;
  expiresAt: string;
}

/**
 * `#/admin` (ADR-0017 §Invites, sign-up, resets, the admin): users with reset link / unlock /
 * disable, and invites with create / revoke. Every call is admin-only on the server (403
 * otherwise); this page only hides itself for non-admins.
 */
export function AdminPage({ api, me }: AdminPageProps) {
  const [lists, setLists] = useState<Lists>({ kind: 'loading' });
  const [link, setLink] = useState<ShownLink | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<AdminUserRow | null>(null);
  const isAdmin = me.user.is_admin;

  const load = useCallback(() => {
    Promise.all([api.listUsers(), api.listInvites()]).then(
      ([users, invites]) => setLists({ kind: 'loaded', users, invites }),
      (err: unknown) =>
        setLists(
          err instanceof ApiRequestError && err.status === 403
            ? { kind: 'forbidden' }
            : { kind: 'error', text: authErrorMessage(err) },
        ),
    );
  }, [api]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  /** Runs one admin action, then reloads both lists. */
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setActionError(null);
    try {
      return await fn();
    } catch (err) {
      setActionError(authErrorMessage(err));
      return undefined;
    } finally {
      load();
    }
  }

  async function resetLink(user: AdminUserRow) {
    const created = await act(() => api.createResetLink(user.id));
    if (created) setLink({ title: 'Reset link', url: created.url, expiresAt: created.expires_at });
  }

  if (!isAdmin || lists.kind === 'forbidden') {
    return (
      <section className="admin" aria-label="Admin">
        <p role="alert" className="error">
          {ADMINS_ONLY}
        </p>
      </section>
    );
  }

  return (
    <section className="admin" aria-label="Admin">
      <h2>Admin</h2>
      {link && (
        <OneTimeLink
          title={link.title}
          url={link.url}
          expiresAt={link.expiresAt}
          onClose={() => setLink(null)}
        />
      )}
      {actionError && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      {confirmDisable && (
        <div className="admin-confirm" role="alertdialog" aria-label="Disable user">
          <span>
            Disable {confirmDisable.email}? This signs them out and revokes their machines.
          </span>
          <button
            type="button"
            className="danger"
            onClick={() => {
              const user = confirmDisable;
              setConfirmDisable(null);
              void act(() => api.disableUser(user.id));
            }}
          >
            Disable
          </button>
          <button type="button" onClick={() => setConfirmDisable(null)} autoFocus>
            Cancel
          </button>
        </div>
      )}
      {lists.kind === 'loading' && <p className="loading">Loading…</p>}
      {lists.kind === 'error' && (
        <p role="alert" className="error">
          {lists.text}{' '}
          <button type="button" onClick={load}>
            Retry
          </button>
        </p>
      )}
      {lists.kind === 'loaded' && (
        <>
          <section aria-label="Users">
            <h3>Users</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Admin</th>
                  <th>Locked</th>
                  <th>Disabled</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lists.users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>{u.display_name}</td>
                    <td>{u.is_admin ? 'Yes' : 'No'}</td>
                    <td>{u.locked ? 'Locked' : 'No'}</td>
                    <td>{u.disabled_at ? formatTime(u.disabled_at) : '—'}</td>
                    <td className="admin-actions">
                      {u.disabled_at === null && (
                        <button
                          type="button"
                          aria-label={`Reset link for ${u.email}`}
                          onClick={() => void resetLink(u)}
                        >
                          Reset link
                        </button>
                      )}
                      {u.locked && (
                        <button
                          type="button"
                          aria-label={`Unlock ${u.email}`}
                          onClick={() => void act(() => api.unlockUser(u.id))}
                        >
                          Unlock
                        </button>
                      )}
                      {u.disabled_at === null && u.id !== me.user.id && (
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Disable ${u.email}`}
                          onClick={() => setConfirmDisable(u)}
                        >
                          Disable
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section aria-label="Invites">
            <h3>Invites</h3>
            <NewInviteForm
              onCreate={async (req) => {
                const created = await act(() => api.createInvite(req));
                if (created) {
                  setLink({
                    title: 'Invite link',
                    url: created.url,
                    expiresAt: created.expires_at,
                  });
                }
              }}
            />
            <p className="admin-note">{NEW_ACCOUNTS_NOTE}</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Admin</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lists.invites.map((inv) => {
                  const status = inviteStatus(inv);
                  return (
                    <tr key={inv.id}>
                      <td>{inv.email ?? 'Anyone'}</td>
                      <td>{inv.is_admin ? 'Yes' : 'No'}</td>
                      <td>{formatTime(inv.expires_at)}</td>
                      <td className={`invite-${status}`}>{status}</td>
                      <td className="admin-actions">
                        {status === 'open' && (
                          <button
                            type="button"
                            aria-label={`Revoke invite for ${inv.email ?? 'anyone'}`}
                            onClick={() => void act(() => api.revokeInvite(inv.id))}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </section>
  );
}

function NewInviteForm({ onCreate }: { onCreate: (req: CreateInviteRequest) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(String(INVITE_DEFAULT_DAYS));
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const n = Number.parseInt(days, 10);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= INVITE_MAX_DAYS;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!daysOk) return;
    setBusy(true);
    const trimmed = email.trim();
    await onCreate({ ...(trimmed !== '' ? { email: trimmed } : {}), days: n, admin });
    setBusy(false);
    setEmail('');
    setAdmin(false);
  }

  return (
    <form className="new-invite" aria-label="New invite" onSubmit={(e) => void onSubmit(e)}>
      <label>
        Email (optional)
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Days
        <input
          type="number"
          min={1}
          max={INVITE_MAX_DAYS}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        Admin
      </label>
      <button type="submit" disabled={busy || !daysOk}>
        New invite
      </button>
    </form>
  );
}
