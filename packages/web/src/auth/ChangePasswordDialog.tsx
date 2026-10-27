import { passwordProblems } from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { PasswordProblems } from './AuthPage.js';
import { authErrorMessage, passwordDetails } from './errors.js';
import { PASSWORDS_DIFFER } from './Reset.js';

export const WRONG_CURRENT_PASSWORD = 'Your current password is wrong.';

const wrongCurrent = (err: unknown): boolean =>
  err instanceof ApiRequestError &&
  err.status === 400 &&
  err.details.some((d) => d.path === 'current');

interface ChangePasswordDialogProps {
  api: ApiClient;
  email: string;
  onClose: () => void;
}

/**
 * POST /auth/password (ADR-0017): signs out the user's other sessions. A wrong current password
 * is a 400 with a detail at path `current`; a 401 means the session is gone, and
 * `withAuthRedirect` sends the user to sign in (TD-125).
 */
export function ChangePasswordDialog({ api, email, onClose }: ChangePasswordDialogProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  const problems = next === '' ? [] : passwordProblems(next, email);
  const mismatch = confirm !== '' && confirm !== next;
  const valid = current !== '' && next !== '' && problems.length === 0 && confirm === next;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setServerProblems([]);
    try {
      await api.changePassword({ current, new: next });
      setDone(true);
    } catch (err) {
      const details = passwordDetails(err);
      if (details.length > 0) setServerProblems(details);
      else if (wrongCurrent(err)) setError(WRONG_CURRENT_PASSWORD);
      else setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-dialog" role="dialog" aria-label="Change password">
      <h2>Change password</h2>
      {done ? (
        <>
          <p role="status">Password changed. Your other sessions were signed out.</p>
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </>
      ) : (
        <form className="auth-form" onSubmit={(e) => void onSubmit(e)}>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              aria-describedby="change-password-problems"
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <PasswordProblems
            id="change-password-problems"
            problems={problems.length > 0 ? problems : serverProblems}
          />
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          {mismatch && <p className="password-problems">{PASSWORDS_DIFFER}</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="auth-actions">
            <button type="submit" disabled={busy || !valid}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
