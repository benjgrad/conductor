import { z } from 'zod';
import { AccountIdSchema, AuthModeSchema, IsoDateTimeSchema, UuidSchema } from '../domain.js';

// Web sign-in DTOs (M2-T01, ADR-0017 §Auth: behaviour, §Invites). Routes and status codes:
// 10-contracts §Accounts and web auth.

/** ADR-0017 password policy (NIST SP 800-63B): 12 to 256 characters, no composition rules. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const EMAIL_MAX = 254;
export const DISPLAY_NAME_MAX = 100;

export const PASSWORD_TOO_SHORT = `Use at least ${PASSWORD_MIN} characters.`;
export const PASSWORD_TOO_LONG = `Use at most ${PASSWORD_MAX} characters.`;
export const PASSWORD_IS_EMAIL = "Don't use your email address as your password.";

/**
 * What's wrong with a new password ([] = acceptable). Pure; the web shows it live and the server
 * enforces it on sign-up, reset and change. Length is counted in code points, so both sides agree
 * on non-BMP characters. The email comparison ignores case and surrounding whitespace.
 */
export function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN) problems.push(PASSWORD_TOO_SHORT);
  if (length > PASSWORD_MAX) problems.push(PASSWORD_TOO_LONG);
  const e = email.trim().toLowerCase();
  if (e !== '' && password.trim().toLowerCase() === e) problems.push(PASSWORD_IS_EMAIL);
  return problems;
}

/** An email as stored: trimmed, lower-cased, a valid address (sign-up, invites). */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(EMAIL_MAX));

/**
 * The login form's email: normalised like EmailSchema but not format-checked, so a malformed
 * email gets the same generic 401 as a wrong password.
 */
export const LoginEmailSchema = z.string().trim().toLowerCase().min(1).max(EMAIL_MAX);

/** A password in a request body: a size cap only (UTF-16 units); the policy is `passwordProblems`. */
export const PasswordFieldSchema = z
  .string()
  .min(1)
  .max(PASSWORD_MAX * 4);

/** One-time tokens in bodies and paths (invites, resets): opaque, base64url. */
const TokenSchema = z.string().min(1).max(512);

/**
 * POST /auth/login → 200 MeResponse + session cookie. 401 `unauthorized` "Email or password is
 * wrong" for an unknown email, a wrong password, a disabled user and a locked email alike; 429
 * `rate_limited` with Retry-After (per IP).
 */
export const LoginRequestSchema = z.object({
  email: LoginEmailSchema,
  password: PasswordFieldSchema,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * GET /api/me → 200 (401 without a session). In `local` mode the server answers with the local
 * user and the `local` account, `auth_mode: 'local'` (the web then hides sign-out and password
 * change).
 */
export const MeResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string(),
    display_name: z.string(),
    is_admin: z.boolean(),
  }),
  account: z.object({ id: AccountIdSchema, name: z.string() }),
  auth_mode: AuthModeSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * POST /auth/signup → 201 MeResponse + session cookie (ADR-0017 §Invites). 400 `bad_request` when
 * the invite is not valid, unused, unexpired and unrevoked, when it pins another email, or when
 * the password fails `passwordProblems` (issues at path `password`); 429 per IP.
 */
export const SignupRequestSchema = z
  .object({
    invite: TokenSchema,
    email: EmailSchema,
    display_name: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
    password: PasswordFieldSchema,
  })
  .superRefine((req, ctx) => {
    for (const message of passwordProblems(req.password, req.email)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message });
    }
  });
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

/**
 * GET /auth/invites/:token → 200 always: `{valid: false, expires_at: null}` for an unknown, used,
 * revoked or expired token; otherwise the expiry and the pinned email, if any. Nothing else.
 */
export const InvitePreviewSchema = z.object({
  valid: z.boolean(),
  email: EmailSchema.optional(),
  expires_at: IsoDateTimeSchema.nullable(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

/**
 * POST /auth/reset → 200 OkResponse: sets the password and revokes every session of the user.
 * 400 for a bad, used or expired token, or a password failing `passwordProblems` (checked by the
 * server against the user's email); 429 per IP.
 */
export const ResetRequestSchema = z.object({
  token: TokenSchema,
  password: PasswordFieldSchema,
});
export type ResetRequest = z.infer<typeof ResetRequestSchema>;

/**
 * POST /auth/password → 200 OkResponse: revokes the user's other sessions. 401 `unauthorized`
 * when `current` is wrong; 400 when `new` fails `passwordProblems`.
 */
export const PasswordChangeRequestSchema = z.object({
  current: PasswordFieldSchema,
  new: PasswordFieldSchema,
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

const NEXT_MAX = 2048;
const NEXT_BASE = 'http://conductor.invalid';

/** Control characters, whitespace (incl. NBSP and line/paragraph separators) and DEL. */
function hasUnsafeChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * ADR-0017 §`next` redirects: `next` if it is a same-origin path (one leading `/`, no `//`, no
 * backslash, no scheme, no control or whitespace characters, which URL parsers strip), else `/`.
 * The result is the normalised path + query + hash, itself re-checked for a leading `//`.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > NEXT_MAX) return '/';
  if (next[0] !== '/' || next[1] === '/' || next.includes('\\')) return '/';
  if (hasUnsafeChar(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== NEXT_BASE) return '/';
  const out = url.pathname + url.search + url.hash;
  // Dot-segment normalisation can produce `//host` (`/..//evil.com`): re-check the result.
  return out.startsWith('//') ? '/' : out;
}
