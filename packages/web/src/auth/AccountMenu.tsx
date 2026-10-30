import type { MeResponse } from '@conductor/shared';
import { CircleUser } from 'lucide-react';
import { useState, type MouseEvent, type ReactNode } from 'react';
import type { ApiClient } from '../api/client.js';
import { NavIcon } from '../components/NavIcon.js';
import {
  disableNotifications,
  enableNotifications,
  notifyState,
  type NotifyState,
} from '../notify/settings.js';
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
  /**
   * 11-web-ui §Top bar: links that leave the bar on a phone (Add a machine, Help) and show at the
   * top of the menu instead.
   */
  extraItems?: readonly AccountMenuLink[] | undefined;
}

export interface AccountMenuLink {
  label: string;
  href: string;
  icon?: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * The header's account menu: the user's name; "Admin" for admins; "Change password" and "Sign
 * out" in `password` mode (in `local` mode there is nothing to sign out of). UX-14: the
 * Notifications toggle (hidden when the browser has no `Notification`).
 */
export function AccountMenu({
  api,
  me,
  onAdmin,
  onSignedOut,
  compact,
  extraItems = [],
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyState>(notifyState);
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

  // UX-14 FR-4: the permission prompt comes only from this click, never on load.
  async function toggleNotifications() {
    if (notify === 'on') {
      disableNotifications();
      setNotify('off');
    } else if (notify === 'off') {
      setNotify(await enableNotifications());
    }
  }

  return (
    <div className="account">
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          // The permission can change in the browser's site settings while the page is open.
          if (!open) setNotify(notifyState());
          setOpen((v) => !v);
        }}
        {...(compact ? { 'aria-label': me.user.display_name, title: me.user.email } : {})}
      >
        <NavIcon icon={CircleUser} />
        <span className="nav-label">{me.user.display_name}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="Account">
          <p className="account-email">{me.user.email}</p>
          {extraItems.map((item) => (
            <a
              key={item.href}
              role="menuitem"
              className="account-link"
              href={item.href}
              onClick={(e) => {
                setOpen(false);
                item.onClick?.(e);
              }}
            >
              {item.icon}
              {item.label}
            </a>
          ))}
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
          {notify !== 'unsupported' && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={notify === 'on'}
              disabled={notify === 'blocked'}
              title={
                notify === 'blocked'
                  ? "Allow notifications for this site in the browser's settings"
                  : undefined
              }
              onClick={() => void toggleNotifications()}
            >
              {notify === 'blocked'
                ? 'Notifications: blocked by the browser'
                : `Notifications: ${notify}`}
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
