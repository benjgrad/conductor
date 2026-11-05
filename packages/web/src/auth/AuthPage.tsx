import { PASSWORD_MIN } from '@conductor/shared';
import type { ReactNode } from 'react';
import { HelpLink } from '../help/HelpPage.js';
import './auth.css';

interface AuthPageProps {
  title: string;
  children: ReactNode;
  /** The "Help: add a machine" link. Default true; Sign up has none (UXR-52). */
  help?: boolean;
  /** UXR-52: a "Sign in instead" link under the form (Sign up, Reset). */
  signIn?: boolean;
}

/** The frame of the sign-in pages: no app header, no board streams. */
export function AuthPage({ title, children, help = true, signIn = false }: AuthPageProps) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <p className="auth-brand">Conductor</p>
        <h1>{title}</h1>
        {children}
        {signIn && (
          <p className="auth-alt">
            Already have an account? <a href="/signin">Sign in instead</a>
          </p>
        )}
        {help && (
          <p className="auth-help">
            <HelpLink>Help: add a machine</HelpLink>
          </p>
        )}
      </main>
    </div>
  );
}

/** UXR-52: the password policy, shown under a new-password field before anything is typed. */
export const PASSWORD_RULE = `Use at least ${PASSWORD_MIN} characters, and not your email address.`;

export function PasswordRule({ id }: { id: string }) {
  return (
    <p id={id} className="auth-hint">
      {PASSWORD_RULE}
    </p>
  );
}

/** The live `passwordProblems` list under a new-password field. */
export function PasswordProblems({ id, problems }: { id: string; problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul id={id} className="password-problems" aria-live="polite">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/** The form's main button, and under it what it still needs while it is disabled (UXR-52). */
export function SubmitWithHint({
  id,
  label,
  busyLabel,
  busy,
  missing,
}: {
  id: string;
  label: string;
  busyLabel: string;
  busy: boolean;
  /** `stillNeeded(…)`: null when the form is complete. */
  missing: string | null;
}) {
  const hint = !busy && missing !== null;
  return (
    <div className="auth-submit">
      <button
        type="submit"
        className="primary"
        disabled={busy || missing !== null}
        {...(hint ? { 'aria-describedby': id } : {})}
      >
        {busy ? busyLabel : label}
      </button>
      {hint && (
        <span id={id} className="form-hint">
          {missing}
        </span>
      )}
    </div>
  );
}
