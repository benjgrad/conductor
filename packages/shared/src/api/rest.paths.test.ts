import { describe, expect, it } from 'vitest';
import { API_PATHS, ApiErrorSchema, apiPathTemplates } from './rest.js';

describe('API_PATHS', () => {
  const templates = apiPathTemplates();

  it('lists every entry once, each starting with /', () => {
    expect(templates.map((t) => t.key)).toEqual(Object.keys(API_PATHS));
    for (const { key, path } of templates) {
      expect(path.startsWith('/'), key).toBe(true);
      expect(path.startsWith('//'), key).toBe(false);
    }
    const paths = templates.map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('parameterised entries take exactly one parameter', () => {
    for (const entry of Object.values(API_PATHS)) {
      if (typeof entry === 'function') expect(entry.length).toBe(1);
    }
  });

  it('has the M2 paths', () => {
    const byKey = Object.fromEntries(templates.map((t) => [t.key, t.path]));
    expect(byKey).toMatchObject({
      authLogin: '/auth/login',
      authLogout: '/auth/logout',
      authMe: '/api/me',
      authSignup: '/auth/signup',
      authInvitePreview: '/auth/invites/:token',
      authReset: '/auth/reset',
      authPassword: '/auth/password',
      adminInvites: '/api/admin/invites',
      adminInvite: '/api/admin/invites/:id',
      adminUsers: '/api/admin/users',
      adminUserResetLink: '/api/admin/users/:id/reset-link',
      adminUserDisable: '/api/admin/users/:id/disable',
      adminUserUnlock: '/api/admin/users/:id/unlock',
      machinesEnroll: '/api/machines/enroll',
      machineEnrollmentTokens: '/api/machines/enrollment-tokens',
      machine: '/api/machines/:id',
      machineRevoke: '/api/machines/:id/revoke',
      machineAlertClear: '/api/machines/alerts/:id/clear',
      installScript: '/install.sh',
      installScriptWindows: '/install.ps1',
      daemonDownload: '/downloads/:file',
      healthz: '/healthz',
      pushVapidPublicKey: '/api/push/vapid-public-key',
      pushSubscriptions: '/api/push/subscriptions',
      pushTest: '/api/push/test',
      session: '/api/sessions/:id',
    });
  });

  it('has the OAuth and MCP paths (ADR-0028)', () => {
    const byKey = Object.fromEntries(templates.map((t) => [t.key, t.path]));
    expect(byKey).toMatchObject({
      mcp: '/mcp',
      oauthRegister: '/oauth/register',
      oauthAuthorize: '/oauth/authorize',
      oauthToken: '/oauth/token',
      wellKnownAuthServer: '/.well-known/oauth-authorization-server',
      wellKnownProtectedResource: '/.well-known/oauth-protected-resource',
      wellKnownProtectedResourceMcp: '/.well-known/oauth-protected-resource/mcp',
    });
  });
});

describe('ApiErrorSchema', () => {
  it.each([
    'unauthorized',
    'forbidden',
    'rate_limited',
    'unsupported_media_type',
    'not_found',
    'push_disabled',
  ])('accepts code %s', (code) => {
    expect(ApiErrorSchema.safeParse({ error: { code, message: 'm' } }).success).toBe(true);
  });
});
