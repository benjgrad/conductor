import { passwordProblems } from '@conductor/shared';
import { useId, useState, type FormEvent, type RefObject } from 'react';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { ModalDialog } from '../components/ModalDialog.js';
import { PasswordProblems, PasswordRule, SubmitWithHint } from './AuthPage.js';
import { authErrorMessage, passwordDetails } from './errors.js';
import { stillNeeded } from './missing.js';
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
  /** Where focus goes after close when the opener is gone (the account button). */
  returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * A modal `<dialog>` (UXR-51): backdrop, focus kept inside, Esc closes it.
 *
 * POST /auth/password (ADR-0017): signs out the user's other sessions. A wrong current password
 * is a 400 with a detail at path `current`; a 401 means the session is gone, and
 * `withAuthRedirect` sends the user to sign in (TD-125).
 */
export function ChangePasswordDialog({
  api,
  email,
  onClose,
  returnFocus,
}: ChangePasswordDialogProps) {
  const headingId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  const problems = next === '' ? [] : passwordProblems(next, email);
  const mismatch = confirm !== '' && confirm !== next;
  const missing = stillNeeded([
    [current === '', 'your current password'],
    [next === '', 'a new password'],
    [problems.length > 0, 'a new password that meets the rule'],
    [confirm !== next, 'the new password twice'],
  ]);
  const valid = missing === null;

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
    <ModalDialog labelledBy={headingId} onClose={onClose} returnFocus={returnFocus}>
      <h2 id={headingId}>Change password</h2>
      {done ? (
        <>
          <p role="status">Password changed. Your other sessions were signed out.</p>
          <button type="button" className="primary" onClick={onClose} autoFocus>
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
              aria-describedby="change-password-rule change-password-problems"
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <PasswordRule id="change-password-rule" />
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
            <SubmitWithHint
              id={`${headingId}-missing`}
              label="Change password"
              busyLabel="Saving…"
              busy={busy}
              missing={missing}
            />
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
