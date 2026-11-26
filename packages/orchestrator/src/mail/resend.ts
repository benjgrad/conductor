import type { MailConfig } from './config.js';

// ADR-0046: invite emails through Resend's HTTP API (https://resend.com/docs/api-reference).
// One POST per invite, after the invite row is committed; never retried (the token exists only
// in this request and the one-time API response). A failure is a result, never a throw: the
// admin still gets the link to copy. Nothing here logs the key or the link.

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const SEND_TIMEOUT_MS = 10_000;

export interface InviteEmail {
  /** The invite row's id: Resend's Idempotency-Key. */
  inviteId: string;
  to: string;
  /** The one-time sign-up link. */
  url: string;
  expiresAt: Date;
  /** Who sent it (the admin's display name), shown in the body. */
  invitedBy: string;
}

export type SendResult = { ok: true; id: string | null } | { ok: false; reason: string };

/** What the invite route sends through; tests pass a fake. */
export interface Mailer {
  sendInvite(email: InviteEmail): Promise<SendResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const expiry = (d: Date): string =>
  d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const INVITE_SUBJECT = 'You’re invited to Conductor';

/** The plain-text and HTML bodies of an invite email. */
export function inviteBodies(e: InviteEmail): { text: string; html: string } {
  const by = e.invitedBy.trim() || 'Someone';
  const until = expiry(e.expiresAt);
  const text =
    `${by} invited you to Conductor.\n\n` +
    'Conductor runs Claude Code agents on your tickets across your own machines, and brings ' +
    'you in only when a decision is yours.\n\n' +
    `Create your account: ${e.url}\n\n` +
    `The link works once and expires on ${until}. If you weren’t expecting it, ignore this email.\n`;
  const html =
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;' +
    'margin:0 auto;padding:24px;color:#1a1a2e">' +
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(by)} invited you to Conductor</h1>` +
    '<p style="line-height:1.5">Conductor runs Claude Code agents on your tickets across your ' +
    'own machines, and brings you in only when a decision is yours.</p>' +
    `<p style="margin:24px 0"><a href="${escapeHtml(e.url)}" style="background:#4f46e5;` +
    'color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">' +
    'Create your account</a></p>' +
    `<p style="font-size:13px;color:#555;line-height:1.5">The link works once and expires on ` +
    `${escapeHtml(until)}. If you weren’t expecting it, ignore this email.</p></div>`;
  return { text, html };
}

/** The Resend-backed mailer. `fetchImpl` is for tests. */
export function createResendMailer(config: MailConfig, fetchImpl: FetchLike = fetch): Mailer {
  return {
    async sendInvite(e) {
      const { text, html } = inviteBodies(e);
      let res: Response;
      try {
        res = await fetchImpl(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': `invite-${e.inviteId}`,
          },
          body: JSON.stringify({
            from: config.from,
            to: [e.to],
            subject: INVITE_SUBJECT,
            text,
            html,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return {
          ok: false,
          reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error',
        };
      }
      if (!res.ok) {
        // Resend's error body names the problem (e.g. an unverified domain); it never echoes the key.
        let detail = '';
        try {
          const body = (await res.json()) as { message?: unknown };
          if (typeof body.message === 'string') detail = `: ${body.message.slice(0, 200)}`;
        } catch {
          // not JSON
        }
        return { ok: false, reason: `Resend answered ${res.status}${detail}` };
      }
      try {
        const body = (await res.json()) as { id?: unknown };
        return { ok: true, id: typeof body.id === 'string' ? body.id : null };
      } catch {
        return { ok: true, id: null };
      }
    },
  };
}
