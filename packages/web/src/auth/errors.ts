import { ApiRequestError } from '../api/client.js';

// M2-T05: the sign-in pages' and admin page's error texts (ADR-0017 §Auth: behaviour).

export const THROTTLED = 'Too many attempts. Try again in a few minutes.';
export const INVALID_INVITE =
  'This invite link is not valid. Ask the person who sent it for a new one.';
export const INVALID_RESET = 'This reset link is not valid. Ask an admin for a new one.';
export const FORBIDDEN = "You don't have permission to do that.";
export const NETWORK = "Can't reach the server. Check your connection and try again.";

/**
 * A message for the user from anything an auth or admin call threw: 429 and 403 get fixed
 * texts, other API errors their server message (a failed sign-in is the generic "Email or
 * password is wrong"), anything else (fetch's TypeError) is a network problem.
 */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return THROTTLED;
    if (err.status === 403) return FORBIDDEN;
    return err.message;
  }
  return NETWORK;
}

/** The `passwordProblems`-style messages a 400 carries at path `password`, if any. */
export function passwordDetails(err: unknown): string[] {
  if (!(err instanceof ApiRequestError) || err.status !== 400) return [];
  return err.details.filter((d) => d.path === 'password').map((d) => d.message);
}
