import { passwordProblems } from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { AuthPage, PasswordProblems } from './AuthPage.js';
import { authErrorMessage, INVALID_RESET, passwordDetails } from './errors.js';

export const PASSWORDS_DIFFER = "The passwords don't match.";
const EXPIRED_RESET = 'This reset link is not valid or has expired. Ask an admin for a new one.';

interface ResetProps {
  api: ApiClient;
  /** `?token=` */
  token: string | null;
}

/**
 * `/reset?token=` (ADR-0017 §Invites, password reset): the new password twice, then POST
 * /auth/reset, which signs the user out everywhere; they sign in again. The page doesn't know
 * the user's email, so the "not your email" rule is the server's (a 400 with details).
 */
export function Reset({ api, token }: ResetProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  if (!token) {
    return (
      <AuthPage title="Choose a new password">
        <p role="alert" className="error">
          {INVALID_RESET}
        </p>
      </AuthPage>
    );
  }
  if (done) {
    return (
      <AuthPage title="Choose a new password">
        <p role="status">Password changed. Sign in with your new password.</p>
        <p>
          <a href="/signin">Sign in</a>
        </p>
      </AuthPage>
    );
  }

  const problems = password === '' ? [] : passwordProblems(password, '');
  const mismatch = confirm !== '' && confirm !== password;
  const valid = password !== '' && problems.length === 0 && confirm === password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !token) return;
    setBusy(true);
    setError(null);
    setServerProblems([]);
    try {
      await api.resetPassword({ token, password });
      setDone(true);
    } catch (err) {
      const details = passwordDetails(err);
      if (details.length > 0) setServerProblems(details);
      else if (err instanceof ApiRequestError && err.status === 400) setError(EXPIRED_RESET);
      else setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPage title="Choose a new password">
      <form className="auth-form" aria-label="Reset password" onSubmit={(e) => void onSubmit(e)}>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            aria-describedby="reset-password-problems"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <PasswordProblems
          id="reset-password-problems"
          problems={problems.length > 0 ? problems : serverProblems}
        />
        <label>
          Confirm password
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
        <button type="submit" disabled={busy || !valid}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </AuthPage>
  );
}
