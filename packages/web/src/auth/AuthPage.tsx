import type { ReactNode } from 'react';
import { HelpLink } from '../help/HelpPage.js';
import './auth.css';

/** The frame of the sign-in pages: no app header, no board streams. */
export function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <p className="auth-brand">Conductor</p>
        <h1>{title}</h1>
        {children}
        <p className="auth-help">
          <HelpLink>Help: add a machine</HelpLink>
        </p>
      </main>
    </div>
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
