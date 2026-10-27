import {
  ADMIN_USER_ROW_FIXTURES,
  API_PATHS,
  INVITE_CREATED_FIXTURE,
  INVITE_PREVIEW_FIXTURES,
  INVITE_ROW_FIXTURES,
  ME_RESPONSE_FIXTURE,
  RESET_LINK_CREATED_FIXTURE,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './client.js';
import { createHttpApi } from './http.js';

// M2-T05: the auth and admin calls over HTTP (10-contracts §Accounts and web auth).

interface Call {
  url: string;
  method: string;
  body: unknown;
  contentType: string | undefined;
}

function recordingFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      contentType: headers['content-type'],
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, fetch: fn };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const USER = ADMIN_USER_ROW_FIXTURES.admin.id;
const INVITE = INVITE_ROW_FIXTURES.open.id;

function respond(call: Call): Response {
  const path = call.url.replace('http://conductor.test', '');
  if (path === API_PATHS.authMe || path === API_PATHS.authLogin || path === API_PATHS.authSignup) {
    return json(path === API_PATHS.authSignup ? 201 : 200, ME_RESPONSE_FIXTURE);
  }
  if (path.startsWith('/auth/invites/')) return json(200, INVITE_PREVIEW_FIXTURES.pinned);
  if (path === API_PATHS.adminInvites) {
    return call.method === 'GET'
      ? json(200, Object.values(INVITE_ROW_FIXTURES))
      : json(201, INVITE_CREATED_FIXTURE);
  }
  if (path === API_PATHS.adminUsers) return json(200, Object.values(ADMIN_USER_ROW_FIXTURES));
  if (path === API_PATHS.adminUserResetLink(USER)) return json(201, RESET_LINK_CREATED_FIXTURE);
  return json(200, { ok: true });
}

describe('createHttpApi auth and admin (M2-T05)', () => {
  it('maps every call to its API_PATHS route, method and JSON body', async () => {
    const { calls, fetch } = recordingFetch(respond);
    const api = createHttpApi({ baseUrl: 'http://conductor.test', fetch });

    expect(await api.me()).toEqual(ME_RESPONSE_FIXTURE);
    await api.login({ email: 'ben@example.com', password: 'pw' });
    await api.logout();
    await api.signup({
      invite: 'tok',
      email: 'dana@example.com',
      display_name: 'Dana',
      password: 'a long enough passphrase',
    });
    expect(await api.previewInvite('a/b?c')).toEqual(INVITE_PREVIEW_FIXTURES.pinned);
    await api.resetPassword({ token: 'r', password: 'a brand new passphrase' });
    await api.changePassword({ current: 'old', new: 'a brand new passphrase' });
    expect(await api.listInvites()).toHaveLength(3);
    expect(await api.createInvite({ days: 3, admin: true })).toEqual(INVITE_CREATED_FIXTURE);
    await api.revokeInvite(INVITE);
    expect(await api.listUsers()).toHaveLength(3);
    expect(await api.createResetLink(USER)).toEqual(RESET_LINK_CREATED_FIXTURE);
    await api.disableUser(USER);
    await api.unlockUser(USER);

    const base = 'http://conductor.test';
    expect(calls.map((c) => [c.method, c.url.replace(base, ''), c.body])).toEqual([
      ['GET', '/api/me', undefined],
      ['POST', '/auth/login', { email: 'ben@example.com', password: 'pw' }],
      ['POST', '/auth/logout', {}],
      [
        'POST',
        '/auth/signup',
        {
          invite: 'tok',
          email: 'dana@example.com',
          display_name: 'Dana',
          password: 'a long enough passphrase',
        },
      ],
      ['GET', '/auth/invites/a%2Fb%3Fc', undefined],
      ['POST', '/auth/reset', { token: 'r', password: 'a brand new passphrase' }],
      ['POST', '/auth/password', { current: 'old', new: 'a brand new passphrase' }],
      ['GET', '/api/admin/invites', undefined],
      ['POST', '/api/admin/invites', { days: 3, admin: true }],
      ['DELETE', `/api/admin/invites/${INVITE}`, {}],
      ['GET', '/api/admin/users', undefined],
      ['POST', `/api/admin/users/${USER}/reset-link`, {}],
      ['POST', `/api/admin/users/${USER}/disable`, {}],
      ['POST', `/api/admin/users/${USER}/unlock`, {}],
    ]);
    // 10-contracts CSRF rule: every unsafe request is JSON, bodiless ones and DELETE included.
    for (const c of calls.filter((c) => c.method !== 'GET')) {
      expect(c.contentType).toBe('application/json');
    }
  });

  it('turns 401 and 429 ApiError bodies into ApiRequestErrors', async () => {
    const { fetch } = recordingFetch((call) =>
      call.url.endsWith('/auth/login')
        ? json(429, { error: { code: 'rate_limited', message: 'slow down' } })
        : json(401, { error: { code: 'unauthorized', message: 'Email or password is wrong' } }),
    );
    const api = createHttpApi({ fetch });
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    const err = await api.login({ email: 'a@b.c', password: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
  });
});
