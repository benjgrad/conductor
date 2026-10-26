import { describe, expect, it } from 'vitest';
import {
  EmailSchema,
  InvitePreviewSchema,
  LoginRequestSchema,
  MeResponseSchema,
  PASSWORD_IS_EMAIL,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  PasswordChangeRequestSchema,
  passwordProblems,
  ResetRequestSchema,
  safeNextPath,
  SignupRequestSchema,
} from './auth.js';
import {
  INVITE_PREVIEW_FIXTURES,
  LOGIN_REQUEST_FIXTURE,
  ME_RESPONSE_FIXTURE,
  PASSWORD_CHANGE_REQUEST_FIXTURE,
  RESET_REQUEST_FIXTURE,
  SIGNUP_REQUEST_FIXTURE,
} from './fixtures.js';

describe('passwordProblems', () => {
  it('flags a password that is too short', () => {
    expect(passwordProblems('a'.repeat(11), 'ben@example.com')).toEqual([PASSWORD_TOO_SHORT]);
  });

  it('flags a password that is too long', () => {
    expect(passwordProblems('a'.repeat(257), 'ben@example.com')).toEqual([PASSWORD_TOO_LONG]);
  });

  it('flags a password equal to the email, ignoring case and whitespace', () => {
    expect(passwordProblems('Ben.Grady@Example.com', ' ben.grady@example.com ')).toEqual([
      PASSWORD_IS_EMAIL,
    ]);
  });

  it('accepts 12 characters, 256 characters and 12 emoji (code points)', () => {
    expect(passwordProblems('a'.repeat(12), 'ben@example.com')).toEqual([]);
    expect(passwordProblems('a'.repeat(256), 'ben@example.com')).toEqual([]);
    expect(passwordProblems('🔑'.repeat(12), 'ben@example.com')).toEqual([]);
    expect(passwordProblems('🔑'.repeat(11), 'ben@example.com')).toEqual([PASSWORD_TOO_SHORT]);
  });
});

describe('safeNextPath', () => {
  it.each([
    null,
    undefined,
    '',
    '//evil.com',
    'https://x',
    '/\\evil',
    '/\\\\evil',
    'javascript:alert(1)',
    '/\t/evil.com',
    '/\n/evil.com',
    ' /board',
    'board',
    `/${'a'.repeat(3000)}`,
  ])('returns / for %j', (next) => {
    expect(safeNextPath(next)).toBe('/');
  });

  it('keeps a same-origin path with query and hash', () => {
    expect(safeNextPath('/sessions/abc?x=1#y')).toBe('/sessions/abc?x=1#y');
    expect(safeNextPath('/oauth/authorize?client_id=c&redirect_uri=x')).toBe(
      '/oauth/authorize?client_id=c&redirect_uri=x',
    );
    expect(safeNextPath('/')).toBe('/');
  });

  it('normalises dot segments without leaving the origin', () => {
    expect(safeNextPath('/a/../b')).toBe('/b');
    expect(safeNextPath('/..//evil.com')).toBe('/');
    expect(safeNextPath('/a/..//evil.com')).toBe('/');
  });
});

describe('auth schemas', () => {
  it('EmailSchema trims and lower-cases, and rejects a non-email', () => {
    expect(EmailSchema.parse(' Ben@Example.COM ')).toBe('ben@example.com');
    expect(EmailSchema.safeParse('not an email').success).toBe(false);
  });

  it('LoginRequest accepts a malformed email (the server answers the generic 401)', () => {
    expect(LoginRequestSchema.parse({ email: ' Ben ', password: 'x' }).email).toBe('ben');
  });

  it('SignupRequest reports password problems at path `password`', () => {
    const r = SignupRequestSchema.safeParse({ ...SIGNUP_REQUEST_FIXTURE, password: 'short' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['password', PASSWORD_TOO_SHORT],
    ]);
    const same = SignupRequestSchema.safeParse({
      ...SIGNUP_REQUEST_FIXTURE,
      password: SIGNUP_REQUEST_FIXTURE.email,
    });
    expect(same.error?.issues.map((i) => i.message)).toEqual([PASSWORD_IS_EMAIL]);
  });

  it('every auth fixture parses', () => {
    expect(LoginRequestSchema.parse(LOGIN_REQUEST_FIXTURE)).toEqual(LOGIN_REQUEST_FIXTURE);
    expect(MeResponseSchema.parse(ME_RESPONSE_FIXTURE)).toEqual(ME_RESPONSE_FIXTURE);
    expect(SignupRequestSchema.parse(SIGNUP_REQUEST_FIXTURE)).toEqual(SIGNUP_REQUEST_FIXTURE);
    for (const f of Object.values(INVITE_PREVIEW_FIXTURES)) {
      expect(InvitePreviewSchema.parse(f)).toEqual(f);
    }
    expect(ResetRequestSchema.parse(RESET_REQUEST_FIXTURE)).toEqual(RESET_REQUEST_FIXTURE);
    expect(PasswordChangeRequestSchema.parse(PASSWORD_CHANGE_REQUEST_FIXTURE)).toEqual(
      PASSWORD_CHANGE_REQUEST_FIXTURE,
    );
  });
});
