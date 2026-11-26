// ADR-0046: the Resend mailer and its config. Pure: a fake fetch, no network, no database.
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/auth/config.js';
import { DEFAULT_MAIL_FROM, parseMailConfig } from '../../src/mail/config.js';
import {
  INVITE_SUBJECT,
  RESEND_EMAILS_URL,
  createResendMailer,
  inviteBodies,
  type InviteEmail,
} from '../../src/mail/resend.js';

const KEY = 're_test_123';
const EMAIL: InviteEmail = {
  inviteId: '6f1f5f3e-7a43-4c49-9d61-0f1a2b3c4d5e',
  to: 'dana@example.com',
  url: 'https://conductor.gradyserver.com/signup?invite=tok&x=<y>',
  expiresAt: new Date('2026-12-03T12:00:00Z'),
  invitedBy: 'Ben <admin>',
};

function fakeFetch(respond: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseMailConfig', () => {
  it('is off without RESEND_API_KEY, on with it, from conductor@gradyserver.com by default', () => {
    expect(parseMailConfig({})).toBeNull();
    expect(parseMailConfig({ RESEND_API_KEY: '  ' })).toBeNull();
    expect(parseMailConfig({ RESEND_API_KEY: ` ${KEY} ` })).toEqual({
      apiKey: KEY,
      from: DEFAULT_MAIL_FROM,
    });
    expect(DEFAULT_MAIL_FROM).toBe('Conductor <conductor@gradyserver.com>');
    expect(
      parseMailConfig({ RESEND_API_KEY: KEY, CONDUCTOR_MAIL_FROM: 'ops@example.com' })?.from,
    ).toBe('ops@example.com');
  });

  it('refuses a bad from address, naming the variable and never the key', () => {
    let err: unknown;
    try {
      parseMailConfig({ RESEND_API_KEY: KEY, CONDUCTOR_MAIL_FROM: 'not an address' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/CONDUCTOR_MAIL_FROM/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('createResendMailer', () => {
  it('POSTs the invite to Resend with the key, from, to, an idempotency key and the link', async () => {
    const f = fakeFetch(() => json(200, { id: 'email_1' }));
    const mailer = createResendMailer({ apiKey: KEY, from: DEFAULT_MAIL_FROM }, f.fn);
    expect(await mailer.sendInvite(EMAIL)).toEqual({ ok: true, id: 'email_1' });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(RESEND_EMAILS_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['idempotency-key']).toBe(`invite-${EMAIL.inviteId}`);
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(body).toMatchObject({ from: DEFAULT_MAIL_FROM, to: ['dana@example.com'] });
    expect(body.subject).toBe(INVITE_SUBJECT);
    expect(body.text).toContain(EMAIL.url);
    // The HTML escapes what it embeds: the link and the inviter's name.
    expect(body.html).toContain(
      'href="https://conductor.gradyserver.com/signup?invite=tok&amp;x=&lt;y&gt;"',
    );
    expect(body.html).toContain('Ben &lt;admin&gt; invited you');
    expect(body.html).not.toContain('<admin>');
  });

  it('a non-2xx, a network error and a timeout are results, not throws', async () => {
    const cfg = { apiKey: KEY, from: DEFAULT_MAIL_FROM };
    const refused = createResendMailer(
      cfg,
      fakeFetch(() => json(403, { message: 'The gradyserver.com domain is not verified' })).fn,
    );
    expect(await refused.sendInvite(EMAIL)).toEqual({
      ok: false,
      reason: 'Resend answered 403: The gradyserver.com domain is not verified',
    });
    const down = createResendMailer(
      cfg,
      fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).fn,
    );
    expect(await down.sendInvite(EMAIL)).toEqual({ ok: false, reason: 'network error' });
    const slow = createResendMailer(
      cfg,
      fakeFetch(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))).fn,
    );
    expect(await slow.sendInvite(EMAIL)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('the bodies say what conductor is and when the link expires', () => {
    const { text, html } = inviteBodies(EMAIL);
    expect(text).toMatch(/Claude Code agents/);
    expect(text).toContain('December 3, 2026');
    expect(html).toContain('December 3, 2026');
  });
});
