# ADR-0017 · Conductor's own sign-in (email + password, invite-only), self-hosted on gradyserver, and the daemon served by the orchestrator

- **Status**: accepted (Ben's decisions, 2026-10-26)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26, M2 plan)
- **Resolves**: [U-057](../tracking/UNKNOWNS.md) (hosting platform, domain, Postgres), [U-067](../tracking/UNKNOWNS.md) (superseded: no npm publish), [U-051](../tracking/UNKNOWNS.md) (personal accounts only through M2), [U-056](../tracking/UNKNOWNS.md) (existing data goes to the bootstrap admin), [U-068](../tracking/UNKNOWNS.md) (a lost lease or a revoked machine goes to a human). The web-user half of [U-008](../tracking/UNKNOWNS.md).
- **Supersedes, in [ADR-0012](0012-hosted-multi-user-github-sign-in.md)**:
  - §Sign-in entirely (the GitHub OAuth App, the `/auth/github` flow, `CONDUCTOR_ALLOWED_GITHUB_LOGINS`). The session cookie design is kept, with the changes below;
  - §Deployment shape's "managed Postgres" and "the platform is Ben's choice (U-057)";
  - the `CONDUCTOR_AUTH=github` name everywhere in ADR-0012 (it is `password`), and the Alternatives row that rejected email + password;
  - `app_user (github_id, login, …)`: users are identified by email.
- **Kept from ADR-0012**: §Tenancy (account, `account_member`, `account_id NOT NULL` with a foreign key on every table, `AccountScope` on every repository function, 404 for another account's id, per-account buses and per-account `conductor`, no RLS at first), §Proving isolation (all four tests), local mode, the security-changes table (with `password` for `github`), audit by user id (U-042).
- **Amends [ADR-0013](0013-machine-enrollment-inventory-routing.md)**: the enrollment command (`npx @conductor/daemon enroll …` → the install script below), and the credential file location (`~/.conductor/machine.json`, not `~/.config/conductor/`). ADR-0013's working-copy section is already amended by the U-060 resolution (a daemon reference clone by default; the user's checkout opt-in per repo).
- **Affects [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md)**: the OAuth authorization server's login step is conductor's own sign-in page, not GitHub (§Effect on M3).

## Context
ADR-0012 planned Sign in with GitHub on a hosting platform to be chosen. On 2026-10-26 Ben decided otherwise:
- conductor has **its own sign-in**: email and password, no GitHub dependency for identity;
- sign-up is **invite-only**, and there is **no outbound email** (no mail service to run or pay for);
- it is **hosted on his own server**, gradyserver.com (Ubuntu 24.04, Docker 28, Compose v2), behind the nginx that already serves his other sites;
- machines get the daemon **from the orchestrator itself**, not from npm.

The tenancy design in ADR-0012 doesn't depend on how people prove who they are, so it stays.

## Decision
**Conductor authenticates people itself with email and argon2id-hashed passwords and server-side sessions in an httpOnly cookie. Accounts are invite-only: an admin hands out one-time links, and the first admin is created by a bootstrap command on the server. One Docker Compose stack (orchestrator + Postgres) runs on gradyserver behind the host's nginx at `https://conductor.gradyserver.com`. The orchestrator serves an install script and a daemon tarball, so adding a machine is one `curl … | sh` line.**

### Auth: schema sketch
All in one migration (M2-T03). Column types are indicative; T03 finalises them against [02](../design/02-data-model.md).

| Table | Columns | Notes |
|---|---|---|
| `account` | `id uuid pk`, `name`, `created_at` | ADR-0012. The migration creates the `local` account (fixed id `00000000-0000-0000-0000-000000000001`) and backfills every existing row into it |
| `app_user` | `id uuid pk`, `email citext unique` (or `text` with a `lower(email)` unique index), `display_name`, `password_hash text`, `is_admin bool`, `disabled_at`, `password_changed_at`, `created_at` | `password_hash` is a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), so its parameters travel with it |
| `account_member` | `account_id`, `user_id`, `role ('owner')`, pk both | ADR-0012. Personal only in M2 (U-051): each user owns exactly one account and nobody else is a member |
| `web_session` | `id_hash bytea pk`, `user_id`, `account_id`, `created_at`, `last_seen_at`, `expires_at`, `user_agent`, `ip` | ADR-0012's design. The cookie holds 32 random bytes; only their SHA-256 is stored |
| `invite` | `id`, `token_hash bytea unique`, `created_by`, `email null`, `is_admin bool`, `claims_account uuid null`, `expires_at`, `used_at`, `used_by`, `revoked_at` | One-time. `email` set → sign-up must use that email. `claims_account` is only set by bootstrap (below) |
| `password_reset` | `id`, `token_hash bytea unique`, `user_id`, `created_by` (an admin, or null for the CLI), `expires_at`, `used_at` | One-time, 1 hour |
| `login_throttle` | `email_norm text pk`, `failures int`, `locked_until`, `updated_at` | Keyed by the normalised email **string**, whether or not a user has it, so lockout reveals nothing |

`app_user`, `web_session`, `account`, `account_member`, `invite`, `password_reset` and `login_throttle` join the ADR-0012 schema test's allow-list (instance-level tables). Every other table carries `account_id`.

### Auth: behaviour
- **Passwords**: argon2id via `@node-rs/argon2` (prebuilt binaries for linux-x64-gnu and darwin-arm64, so the image needs no compiler). Parameters: the OWASP baseline `m = 19 MiB, t = 2, p = 1`; a hash with weaker parameters than the current ones is re-hashed on the next successful login. Policy (NIST SP 800-63B): 12 to 256 characters, not equal to the email, no composition rules. Emails are trimmed and lower-cased; there is no email verification (no mail), which is acceptable because only an invite creates a user.
- **Login** `POST /auth/login {email, password}`. The response is the same `401 {code: 'unauthorized', message: 'Email or password is wrong'}` for an unknown email, a wrong password and a disabled user; an unknown email still runs one argon2 verify against a fixed dummy hash, so timing matches.
- **Rate limiting and lockout** (three layers):
  1. nginx `limit_req` on `/auth/` and `/api/machines/enroll` (a few requests per second per IP, small burst);
  2. in the orchestrator, per client IP (`@fastify/rate-limit`, in memory: one instance): login 10/min, sign-up and reset 5/10 min, enroll 10/10 min; `429 {code: 'rate_limited'}` with `Retry-After`;
  3. per email, in `login_throttle`: 10 consecutive failures lock that email for 15 minutes (doubling for each further lockout, capped at 24 h); a success resets it; `conductor-admin unlock <email>` clears it. A locked email gets the same 401 as a wrong password, and the lock is only lifted by time or the admin.
  The client IP is only trusted from `X-Forwarded-For` when the TCP peer is `CONDUCTOR_TRUSTED_PROXY` (see Hosting).
- **Session cookie**:
  - hosted (`https` public URL): `__Host-conductor_session=<base64url 32 bytes>; HttpOnly; Secure; SameSite=Lax; Path=/`;
  - password mode on a loopback `http` URL (tests and e2e only): `conductor_session`, without `Secure` and without the `__Host-` prefix. The server refuses `http` public URLs that are not loopback.
  - **Lifetime**: 30 days absolute (`expires_at`), 7 days idle; `last_seen_at` is updated at most every 5 minutes. Logout (`POST /auth/logout`) deletes the row and clears the cookie. A password change revokes every **other** session of the user; a reset, a disable, or `conductor-admin revoke-sessions` revokes all of them.
- **CSRF** (chosen: `SameSite=Lax` + a strict Origin check + JSON-only bodies; **no CSRF token**):
  - every unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) on `/api/*` and `/auth/*` must carry `Origin` equal to the origin of `CONDUCTOR_PUBLIC_URL`. A request without `Origin` is accepted only with `Sec-Fetch-Site: same-origin`; otherwise 403 `forbidden`. Every current browser sends `Origin` on a `POST`;
  - unsafe requests must be `application/json` (M1-T14's 415 rule). A cross-site HTML form can't send that, and a cross-site `fetch` with it needs a CORS preflight, which the server never grants (no CORS headers at all);
  - `SameSite=Lax` keeps the cookie off cross-site sub-requests; `Strict` was rejected because following a link to a card from Slack or a mail would land signed-out;
  - every `GET` stays side-effect free (a rule the route-matrix test asserts: no `GET` writes).
  
  Why no token: the app is one same-origin SPA, every write is a JSON `fetch`, and the Origin check plus JSON-only gives the same guarantee without threading a token through the web client, SSE reconnects and M3's consent form (which is a JSON `POST` too).
- **Login CSRF** is covered by the same Origin check on `/auth/login`.
- **`next` redirects**: sign-in takes `?next=`, accepted only as a same-origin path starting with a single `/` (no `//`, no scheme); M3's `/oauth/authorize` relies on it.
- **Headers** (set by the orchestrator, so tests see them): `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. nginx adds HSTS, `X-Frame-Options DENY` and `X-Robots-Tag noindex` like the other sites.
- **Every `/api/*` route needs a session** (401 otherwise), except `POST /api/machines/enroll` (token-authenticated). Static files, `/install.sh`, `/downloads/*` and `/healthz` are public. SSE streams need the cookie (EventSource sends it on same-origin requests).

### Invites, sign-up, resets, the admin
- **Admin** is an instance role (`app_user.is_admin`), not an account role. An admin can create and revoke invites, create reset links, disable users and unlock emails. **An admin sees no other account's tickets, machines or workflows**: isolation applies to admins too.
- **Invite**: `POST /api/admin/invites {email?, days? (default 7, max 30)}` returns `https://<host>/signup?invite=<token>` once (256-bit token, stored hashed). The sign-up page and `POST /auth/signup {invite, email, display_name, password}` refuse anything without a valid, unexpired, unused, unrevoked invite. Using it, in one transaction: create the user, create their personal account (owner), seed its `conductor` workflow (ADR-0012 per-account seed), mark the invite used, and sign them in.
- **Password reset** (no mail): an admin creates a link (`POST /api/admin/users/:id/reset-link`, valid 1 hour) and passes it on by hand, or runs `conductor-admin reset-link <email>` on the server. `POST /auth/reset {token, password}` sets the password and revokes all the user's sessions.
- **Password change**: `POST /auth/password {current, new}` from the account menu.
- **Bootstrap** (the first account, U-056): `conductor-admin bootstrap` (run with `docker compose exec orchestrator conductor-admin bootstrap`) refuses if any `app_user` exists. Otherwise it prints a one-hour admin invite with `claims_account = local`. Signing up with it makes the first user an admin and the **owner of the `local` account** (renamed to their name), so everything that existed before M2 becomes theirs; no separate personal account is created for them. No password ever appears on a command line or in an env file. The env-token variant was rejected: a token left in `.env` outlives its use.
- **The CLI** (`conductor-admin`, a bin of `@conductor/orchestrator`, talking straight to `DATABASE_URL`): `bootstrap`, `invite [--email] [--days] [--admin]`, `reset-link <email>`, `unlock <email>`, `revoke-sessions <email>`, `disable <email>`, `list-users`. It prints links built from `CONDUCTOR_PUBLIC_URL`.

### Modes
`CONDUCTOR_AUTH=local | password`:
- `local` is M1's behaviour: loopback bind only, one implicit `local` account, no sign-in, daemons without credentials. Dev and the M1/M1b e2e scenarios use it. The server refuses to start in `local` mode on a non-loopback bind address.
- `password` needs `CONDUCTOR_PUBLIC_URL`. The host allow-list is the public URL's host; `CONDUCTOR_ALLOW_LOCAL_REPOS` and the Vite dev origins are refused (TD-069 goes away). The M2 two-account e2e runs `password` mode on loopback.

### Threat model highlights
| Threat | Mitigation |
|---|---|
| Password guessing and stuffing | Per-IP limits (nginx + app), per-email lockout keyed by the string, argon2id, a 12-character minimum, no account enumeration in responses or timing |
| Stolen database dump | Only argon2id hashes and SHA-256 hashes of session, invite, reset, enrollment and machine tokens; no third-party credentials (ADR-0016) |
| Session theft | `HttpOnly` + `Secure` + `__Host-` cookie, TLS only (HSTS), CSP, server-side sessions that can be revoked one by one or all at once |
| CSRF / login CSRF | Origin check + JSON-only + `SameSite=Lax`, no CORS |
| Cross-site WebSocket hijacking | The daemon WS needs `Authorization: Bearer <machine credential>`, which a browser can't send on a WebSocket |
| XSS through agent output or ticket text (repo content is untrusted) | React escaping, the existing markdown renderer's escaping, and the CSP without `unsafe-inline` scripts; each user only ever sees their own account's data, so stored XSS can't cross accounts |
| Cross-account access | ADR-0012's isolation tests (schema, route matrix, gateway, unscoped-query lint), 404 for foreign ids, admins included |
| Invite or reset link leak | Single use, short expiry (7 days / 1 hour), revocable, hashed at rest; a used reset revokes all sessions |
| Leaked enrollment token or machine credential | 30-minute single-use enrollment token; revocable credential; revoke closes the socket at once and sends the machine's sessions to a human |
| Server compromise | Out of scope beyond: the container runs as non-root, Postgres is reachable only on the compose network, the stack is published on `127.0.0.1` only, root steps are a separate script Ben reads and runs |
| Open redirect | `next` accepts same-origin paths only |

### Hosting topology (resolves U-057)
```
Internet ──TLS──▶ nginx (host, :443, cert for conductor.gradyserver.com via certbot --webroot /var/www/html)
                    │  /ws/daemon           → WebSocket upgrade, read timeout 1 h
                    │  /api/stream/*        → proxy_buffering off, read timeout 1 h (SSE)
                    │  /auth/*, /api/machines/enroll → stricter limit_req
                    │  everything else      → limit_req (general zone)
                    ▼
            127.0.0.1:3040 ──▶ [compose project "conductor", network "conductor" with a fixed subnet]
                                  orchestrator (Node 22, non-root; API + SSE + WS + web app + /install.sh + daemon tarball; :7400 in the container)
                                  migrate      (one-shot, same image, node-pg-migrate up; orchestrator depends_on it completing)
                                  postgres:16  (named volume, not published; healthcheck pg_isready)
```
- **Where**: `~/deploy/conductor` on gradyserver, owned by `bengrady4` (in the `docker` group, no passwordless sudo). `.env` there (mode 0600) holds `POSTGRES_PASSWORD` (random, generated on the first deploy), `CONDUCTOR_PUBLIC_URL=https://conductor.gradyserver.com`, `CONDUCTOR_AUTH=password`, `CONDUCTOR_TRUSTED_PROXY`.
- **Port**: `127.0.0.1:3040` (reso uses 3031; 3040 verified free by the lead on 2026-10-26). The nginx site and compose file share it through one variable.
- **Trusted proxy**: a port published on `127.0.0.1` reaches the container through Docker's userland proxy, so the TCP peer the orchestrator sees is the compose network's **gateway address**, not 127.0.0.1. The compose network gets a fixed subnet, `192.168.80.0/24` with gateway `192.168.80.1` (verified free by the lead on 2026-10-26: gradyserver's existing networks are 172.20–172.31/16, 192.168.32.0/20 and 192.168.48.0/20; 172.31.0.0/16 belongs to interviewme-agent), and `CONDUCTOR_TRUSTED_PROXY` is that gateway. Only that peer's `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` are believed.
- **Migrations**: a release step (ADR-0012), done by the `migrate` service on every `up`, never by the orchestrator process. A migration that fails leaves the old orchestrator container running.
- **nginx**: one site file `/etc/nginx/sites-available/conductor.gradyserver.com` following the reso pattern (an upstream with keepalive; `:80` serving `/.well-known/acme-challenge/` from `/var/www/html` and 301-ing the rest; `:443 ssl http2` with the Let's Encrypt `fullchain`/`privkey`, `options-ssl-nginx.conf`, `ssl_dhparam`; `X-Robots-Tag noindex`, `nosniff`, `X-Frame-Options DENY`, HSTS; per-site access and error logs; `client_max_body_size 4m`; `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`). `limit_req_zone` and the `map $http_upgrade $connection_upgrade` live in the **http** context, so they go in conf.d. This matches the server's existing pattern, verified by the lead on 2026-10-26: each site declares its zones in `/etc/nginx/conf.d/<app>-ratelimit.conf` (e.g. `reso-ratelimit.conf`: `limit_req_zone $binary_remote_addr zone=reso_mcp:10m rate=10r/s;`). Conductor's go in `/etc/nginx/conf.d/conductor-ratelimit.conf`, with `conductor_`-prefixed zone names. The upgrade map always ships in `/etc/nginx/conf.d/conductor-websocket.conf` as `map $http_upgrade $conductor_connection_upgrade`, under its own prefixed name so it never collides with or depends on another site's map.
- **Root steps** live in one idempotent script Ben reads and runs with sudo (`deploy/gradyserver/install-nginx-site.sh`): copy the site and conf.d files, obtain the certificate with `certbot certonly --webroot -w /var/www/html -d conductor.gradyserver.com` if it is missing, enable the site, `nginx -t`, and only then `systemctl reload nginx`. Everything else runs as `bengrady4` over `ssh -p 1024 bengrady4@gradyserver.com`.
- **Deploys**: `deploy/gradyserver/deploy.sh <git-ref>`, run by the lead from a checkout: `git archive` of the ref is streamed over ssh into `~/deploy/conductor/releases/<sha>`, `current` is pointed at it, then `docker compose -p conductor up -d --build`, then a smoke check. The server needs no GitHub credentials. Rolling back is a deploy of the previous sha (migrations don't roll back; a down-migration is a deliberate, separate step).
- **Backups**: `backup.sh` from `bengrady4`'s crontab, nightly: `docker compose exec -T postgres pg_dump -Fc` into `~/deploy/conductor/backups/`, keeping 14 days. The runbook has the restore steps and a restore test. No off-host copies (U-074, Ben 2026-10-26).
- **One instance** (ADR-0012, ADR-0003's revisit trigger unchanged).

### Daemon distribution (supersedes U-067: no npm publish)
- The image's build stage produces `conductor-daemon-<version>.tgz` (`pnpm --filter @conductor/daemon deploy --prod` or an equivalent self-contained bundle: the daemon and its production `node_modules`, no workspace links), with its SHA-256. `<version>` is the package version plus the git sha.
- The orchestrator serves:
  - `GET /install.sh`, a POSIX `sh` script templated with `CONDUCTOR_PUBLIC_URL`, the version and the SHA-256;
  - `GET /downloads/conductor-daemon-<version>.tgz`.
- **Add a machine** shows (once, with a 30-minute single-use token, ADR-0013):
  `curl -fsSL https://conductor.gradyserver.com/install.sh | sh -s -- --token <token>`
  The script: checks for Node ≥ 22, `git` and `claude` (it installs none of them, and says what is missing); downloads the tarball and checks its SHA-256; unpacks it to `~/.conductor/daemon/<version>`, points `~/.conductor/daemon/current` at it and links `~/.conductor/bin/conductor-daemon`; runs `conductor-daemon enroll --url <public url> --token <token>` (credential in `~/.conductor/machine.json`, 0600, directory 0700); and, with `--service`, installs a launchd agent (macOS) or a systemd user unit (Linux) that starts the daemon at login.
- **Upgrades**: re-running the script without `--token` installs the server's current version and keeps the credential. `register` carries `daemon_version` and `protocol_version`; the orchestrator refuses an incompatible protocol at register with a message naming the install command, and the Machines page marks out-of-date daemons.
- Windows stays out of M2 (U-071). Node itself is a prerequisite, not bundled.

### Effect on M3 ([ADR-0014](0014-tool-layer-and-oauth-mcp-server.md))
- `/oauth/authorize` needs a conductor web session. Without one it redirects to `/signin?next=<the authorize URL, as a path>`; there is no GitHub step.
- The consent page is a same-origin page posting JSON, covered by the Origin check above and `frame-ancestors 'none'`.
- M3's e2e signs in with a test user (bootstrap + invite) instead of a fake GitHub; Ben's manual check uses his own password.
- "GitHub login" in ADR-0014 and the M3 outline should be read as "conductor's sign-in". Nothing else in ADR-0014 changes.

## Alternatives considered
| Option | Why not |
|---|---|
| Sign in with GitHub (ADR-0012) | Ben's call: conductor's identity shouldn't depend on GitHub, and the OAuth app would be one more thing to register and rotate |
| Magic links / email verification | Needs an outbound mail service, which Ben ruled out |
| Passkeys now | Good later (no passwords to steal), but more UI and recovery design; not in M2 |
| A CSRF token (double-submit or synchronizer) | Same protection as Origin + JSON-only for a same-origin JSON SPA, with more plumbing |
| `SameSite=Strict` | Following a link to conductor from elsewhere would arrive signed-out |
| An env bootstrap token | Lingers in `.env` after use; the CLI's one-hour invite doesn't |
| JWT sessions | Can't be revoked without a server table, which we'd then have anyway |
| A PaaS (Fly, Render, Railway) + managed Postgres | Costs money and adds an external service; Ben already runs gradyserver with nginx and certbot |
| Migrations on orchestrator start | ADR-0012 keeps them a release step; the compose `migrate` service does that with no extra tooling |
| Publish `@conductor/daemon` to npm | A public package, a scope to own and a release process (U-067); serving the tarball from the orchestrator keeps the daemon in step with the server |
| A daemon binary with Node bundled (pkg / SEA) | Bigger artefacts per OS and arch; Node 22 is already a prerequisite for `claude` users. Revisit if installs fail on it |
| `pg_dump` from the host | The host has no Postgres client; `docker compose exec` needs none |

## Consequences
- **Good:**
  - no third-party identity provider or mail service;
  - one server Ben already operates; TLS and certs follow his existing pattern;
  - adding a machine is one copy-paste line, and daemons upgrade from the server they talk to.
- **Bad / accepted cost:**
  - conductor stores password hashes and must get throttling, lockout and session handling right (the threat model above; covered by M2-T08 tests and QA);
  - password recovery is manual (the admin, or the CLI on the server);
  - backups live on the same host (U-074: Ben chose no off-host copy for now);
  - a single host is a single point of failure;
  - `curl | sh` trusts the server's TLS; there is no signature on the tarball beyond its SHA-256 served alongside.
- **Follow-ups:** M2 tasks ([M2](../plan/milestones/M2-accounts-machines.md)); U-073 (resolved: the server database starts fresh), U-074 (resolved: on-host backups only), U-075 (resolved: the local board stays pinned to M1b until T25); passkeys later; [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md) note.

## Revisit when
A second person outside Ben's circle needs an account without an admin in the loop (open sign-up, email), passkeys are wanted, gradyserver can't hold the load or its uptime matters more than one host gives, or a tarball install fails for want of a bundled Node.
