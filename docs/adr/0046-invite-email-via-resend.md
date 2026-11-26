# ADR-0046 · Invite email through Resend

- **Status**: accepted (Ben, ticket "Support Signup", 2026-11-25: "use resend to send emails from conductor@gradyserver.com")
- **Date**: 2026-11-26
- **Deciders**: Ben (+ Claude, implementing session)
- **Supersedes, in [ADR-0017](0017-own-sign-in-and-self-hosting.md)**: "there is **no outbound email**", for invites only. Password resets stay hand-delivered links.

## Context
ADR-0017 kept conductor free of a mail service: an admin copied each one-time invite link and passed it on by hand. With sign-up into a new personal account working (M2-T15b) and every account isolated (M2-T12, M2-T21), inviting people is the way the instance grows, and copying links by hand is the friction. Ben asked for Resend, sending from `conductor@gradyserver.com`, whose SPF and DKIM records are set up.

## Decision
**When an admin creates an invite that names an email address, the orchestrator emails the one-time link to it through Resend's HTTP API (`POST https://api.resend.com/emails`), once, after the invite is stored. The link is still returned once to the admin; a failed or skipped send never fails the invite.**

- **Configuration** (`mail/config.ts`, checked at start like the VAPID keys):
  - `RESEND_API_KEY`: a secret, set in the deploy `.env` (`/home/bengrady4/deploy/conductor/.env` on gradyserver, mode 0600) and passed through `compose.yml`. Empty or unset means mail is off.
  - `CONDUCTOR_MAIL_FROM`: optional, default `Conductor <conductor@gradyserver.com>`. A value that is neither an address nor `Name <address>` stops the start.
- **Sending** (`mail/resend.ts`):
  - one POST with `Authorization: Bearer <key>`, a 10 s timeout, and `Idempotency-Key: invite-<invite id>`, so a duplicate request never sends twice;
  - the body (plain text and escaped HTML) says who invited them and what conductor is, and carries the link and its expiry.
- **No retries, no outbox**. The token exists only in the request and the admin's one-time response; queueing a retry would mean storing it. A failure is reported instead: `InviteCreated.emailed: false` with `email_error` (Resend's reason, never a secret), and the Admin page tells the admin to copy the link.
- **Secrets stay secret**. The key is never logged or returned. A failed send is logged as `invite <id>: email not sent (<reason>)`, without the link.

## Consequences
- **Good**: inviting someone is one form; the copy-link path still works with mail off or down.
- **Accepted**:
  - a third-party service (Resend) now sees invite links and addresses;
  - the link sits in the recipient's mailbox, which is the same exposure as pasting it into a chat. Invites stay single-use, short-lived, revocable and hashed at rest.
- **Follow-ups**: password-reset email; a "resend invite" action, which would need a new link because the old token is not stored.

## Alternatives considered
| Option | Why not |
|---|---|
| SMTP from gradyserver | A mail server to run and keep off blocklists; Ben chose Resend |
| An outbox with retries | Would have to store the plaintext token (or a way to make it) until sent |
| Email verification on sign-up | Not needed: only an invite creates a user, and a pinned email must match |
