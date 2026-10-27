import { safeNextPath, type MeResponse } from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../api/client.js';
import { goTo } from '../nav.js';
import { AuthPage } from './AuthPage.js';
import { authErrorMessage } from './errors.js';

interface SignInProps {
  api: ApiClient;
  /** `?next=`: where to go afterwards, if it is a same-origin path (`safeNextPath`). */
  next: string | null;
  onSignedIn: (me: MeResponse) => void;
}

/** `/signin` (ADR-0017 §Auth: behaviour): POST /auth/login, then `next`. */
export function SignIn({ api, next, onSignedIn }: SignInProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login({ email: email.trim(), password });
      onSignedIn(me);
      goTo(safeNextPath(next), { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthPage title="Sign in">
      <form className="auth-form" aria-label="Sign in" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || email.trim() === '' || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-hint">
        No account? Ask an admin for an invite link. Forgot your password? Ask an admin for a reset
        link.
      </p>
    </AuthPage>
  );
}
