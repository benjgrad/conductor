import { passwordProblems, type InvitePreview, type MeResponse } from '@conductor/shared';
import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../api/client.js';
import { goTo } from '../nav.js';
import { AuthPage, PasswordProblems } from './AuthPage.js';
import { authErrorMessage, INVALID_INVITE, passwordDetails } from './errors.js';

interface SignUpProps {
  api: ApiClient;
  /** `?invite=` */
  invite: string | null;
  onSignedIn: (me: MeResponse) => void;
}

type Preview = { kind: 'loading' } | { kind: 'error'; text: string } | InvitePreview;

/**
 * `/signup?invite=` (ADR-0017 §Invites): GET /auth/invites/:token first; only a valid invite
 * gets the form. A pinned email is filled in and read-only. The password policy is checked live
 * with the server's own `passwordProblems`.
 */
export function SignUp({ api, invite, onSignedIn }: SignUpProps) {
  const [preview, setPreview] = useState<Preview>(() =>
    invite ? { kind: 'loading' } : { valid: false, expires_at: null },
  );
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  useEffect(() => {
    if (!invite) return;
    let cancelled = false;
    api.previewInvite(invite).then(
      (p) => {
        if (cancelled) return;
        setPreview(p);
        if (p.email) setEmail(p.email);
      },
      (err: unknown) => {
        if (!cancelled) setPreview({ kind: 'error', text: authErrorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, invite]);

  if ('kind' in preview) {
    return (
      <AuthPage title="Create your account">
        {preview.kind === 'loading' ? (
          <p className="loading">Checking the invite…</p>
        ) : (
          <p role="alert" className="error">
            {preview.text}
          </p>
        )}
      </AuthPage>
    );
  }
  if (!preview.valid || !invite) {
    return (
      <AuthPage title="Create your account">
        <p role="alert" className="error">
          {INVALID_INVITE}
        </p>
      </AuthPage>
    );
  }

  const pinned = preview.email !== undefined;
  const problems = password === '' ? [] : passwordProblems(password, email);
  const valid =
    email.trim() !== '' && name.trim() !== '' && password !== '' && problems.length === 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !invite) return;
    setBusy(true);
    setError(null);
    setServerProblems([]);
    try {
      const me = await api.signup({
        invite,
        email: email.trim(),
        display_name: name.trim(),
        password,
      });
      onSignedIn(me);
      goTo('/', { replace: true });
    } catch (err) {
      const details = passwordDetails(err);
      if (details.length > 0) setServerProblems(details);
      else setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthPage title="Create your account">
      <form className="auth-form" aria-label="Sign up" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            readOnly={pinned}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        {pinned && <p className="auth-hint">This invite is for this email address.</p>}
        <label>
          Name
          <input
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            aria-describedby="signup-password-problems"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <PasswordProblems
          id="signup-password-problems"
          problems={problems.length > 0 ? problems : serverProblems}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !valid}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthPage>
  );
}
