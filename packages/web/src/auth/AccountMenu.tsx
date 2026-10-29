import type { MeResponse } from '@conductor/shared';
import { CircleUser } from 'lucide-react';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { NavIcon } from '../components/NavIcon.js';
import { ChangePasswordDialog } from './ChangePasswordDialog.js';
import { authErrorMessage } from './errors.js';
import './auth.css';

interface AccountMenuProps {
  api: ApiClient;
  me: MeResponse;
  /** Opens the admin view (through the app's route guard). Shown to admins only. */
  onAdmin: () => void;
  /** After POST /auth/logout succeeded. */
  onSignedOut: () => void;
  /** UX-11: icon-only button; the name moves to `aria-label`, the email to the tooltip. */
  compact?: boolean | undefined;
}

/**
 * The header's account menu: the user's name; "Admin" for admins; "Change password" and "Sign
 * out" in `password` mode (in `local` mode there is nothing to sign out of).
 */
export function AccountMenu({ api, me, onAdmin, onSignedOut, compact }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordMode = me.auth_mode === 'password';

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await api.logout();
      setOpen(false);
      onSignedOut();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account">
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...(compact ? { 'aria-label': me.user.display_name, title: me.user.email } : {})}
      >
        <NavIcon icon={CircleUser} />
        <span className="nav-label">{me.user.display_name}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="Account">
          <p className="account-email">{me.user.email}</p>
          {me.user.is_admin && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAdmin();
              }}
            >
              Admin
            </button>
          )}
          {passwordMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setChanging(true);
              }}
            >
              Change password
            </button>
          )}
          {passwordMode && (
            <button type="button" role="menuitem" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </button>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
      {changing && (
        <ChangePasswordDialog api={api} email={me.user.email} onClose={() => setChanging(false)} />
      )}
    </div>
  );
}
