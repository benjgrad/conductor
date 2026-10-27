# Runbook: conductor on gradyserver

How conductor runs at **https://conductor.gradyserver.com**. Design: [ADR-0017 §Hosting topology](../adr/0017-own-sign-in-and-self-hosting.md#hosting-topology-resolves-u-057) and [ADR-0012 §Deployment shape](../adr/0012-hosted-multi-user-github-sign-in.md) (migrations are a release step). The files are in [`deploy/gradyserver/`](../../deploy/gradyserver/) and the image is the root [`Dockerfile`](../../Dockerfile).

Who does what: unmarked steps are the **lead's**, run from a checkout on a Mac or over `ssh` as `bengrady4`. Steps marked **(Ben)** need Ben, and **(Ben, sudo)** need Ben with root on gradyserver. Nothing else needs root.

```
Internet ─TLS─▶ nginx (host :443, Let's Encrypt cert)
                  /ws/            → WebSocket upgrade, 1 h read timeout
                  /api/stream/    → SSE, proxy_buffering off, 1 h read timeout
                  /auth/*, /api/machines/enroll → limit_req zone conductor_auth
                  /               → limit_req zone conductor_general
                  ▼
          127.0.0.1:3040 ─▶ compose project "conductor", network "conductor" (192.168.80.0/24)
                              orchestrator  (non-root, :7400 in the container)
                              migrate       (one-shot node-pg-migrate up, same image)
                              postgres:16   (volume conductor_pgdata, not published)
```

| What | Where (on gradyserver) |
|---|---|
| Releases (one per deployed sha, last 5 kept) | `~/deploy/conductor/releases/<sha>` |
| Active release (switched only after a successful deploy) | `~/deploy/conductor/current` → `releases/<sha>` |
| Deployed image selector (non-secret) | `~/deploy/conductor/current.env`: `CONDUCTOR_GIT_SHA=<sha>` |
| Secrets and settings (mode 0600) | `~/deploy/conductor/.env` (from [`env.example`](../../deploy/gradyserver/env.example)) |
| Nightly dumps (14 days) | `~/deploy/conductor/backups/conductor-<UTC>.dump` |
| Backup log | `~/deploy/conductor/logs/backup.log` |
| nginx site / conf.d | `/etc/nginx/sites-available/conductor.gradyserver.com`, `/etc/nginx/conf.d/conductor-ratelimit.conf`, `/etc/nginx/conf.d/conductor-websocket.conf` |

Shorthand used below (on gradyserver, in `~/deploy/conductor`):

```bash
alias cdc='docker compose -p conductor -f ~/deploy/conductor/current/deploy/gradyserver/compose.yml --env-file ~/deploy/conductor/.env --env-file ~/deploy/conductor/current.env'
```

The second `--env-file` (`current.env`, written by `deploy.sh` after a successful deploy) sets `CONDUCTOR_GIT_SHA`, so `cdc up`, `cdc run` and `cdc start` use the deployed image `conductor-orchestrator:<sha>` and never build a `:latest` one. `backup.sh` passes it the same way. Don't deploy with a bare `cdc up`: `deploy.sh` owns the migration gate (§6).

## 1. Prerequisites

- `ssh -p 1024 bengrady4@gradyserver.com` works from the lead's machine. `bengrady4` is in the `docker` group (no sudo needed for Docker) and `docker compose version` reports v2.
- DNS: `conductor.gradyserver.com` resolves to gradyserver (`dig +short conductor.gradyserver.com`).
- nginx and certbot are installed on the host, with `/var/www/html` as the webroot used by the other sites, and `/etc/letsencrypt/options-ssl-nginx.conf` and `ssl-dhparams.pem` present (they are, from the existing certbot sites).
- `openssl` on gradyserver (deploy.sh uses it to generate the database password).
- The code being deployed includes M2-T08 (`CONDUCTOR_BIND_HOST`, `CONDUCTOR_TRUSTED_PROXY`, auth, CSP) and M2-T14 (`/healthz`, `/install.sh`, the daemon tarball). Before those land, the container listens only on its own loopback, its health check fails, and `deploy.sh` times out waiting for "healthy". That's expected.

## 2. First-time checks

Run these on gradyserver before the first deploy. The values in brackets are what the lead found on **2026-10-26**. If one has changed, change `.env` (and the nginx upstream for the port) before deploying.

```bash
# The host port is free [3040 free; reso uses 3031].
ss -ltn | grep -E ':3040\b' || echo "3040 free"

# The compose subnet is free [192.168.80.0/24 free; existing networks are 172.20–172.31/16,
# 192.168.32.0/20, 192.168.48.0/20; 172.31.0.0/16 belongs to interviewme-agent].
docker network inspect $(docker network ls -q) \
  --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' | sort -k2

# Rate-limit zones live in conf.d, one file per app [reso-ratelimit.conf exists].
ls /etc/nginx/conf.d/*-ratelimit.conf
```

Conductor's zones go in `/etc/nginx/conf.d/conductor-ratelimit.conf` (`conductor_auth`, `conductor_general`). The WebSocket upgrade map always ships as `/etc/nginx/conf.d/conductor-websocket.conf` under the prefixed name `$conductor_connection_upgrade`, so it never collides with or depends on another site's `$connection_upgrade` map.

If the port must change: set `CONDUCTOR_HOST_PORT` in `.env` **and** the `server 127.0.0.1:<port>;` line in `deploy/gradyserver/nginx/conductor.gradyserver.com.conf` (commit it, then redeploy and rerun §4). If the subnet must change: set `CONDUCTOR_SUBNET`, `CONDUCTOR_GATEWAY` and `CONDUCTOR_TRUSTED_PROXY` (= the gateway) together.

## 3. First deploy

From a checkout on the lead's machine, with the sha to deploy:

```bash
deploy/gradyserver/deploy.sh <sha> --no-smoke   # nginx isn't set up yet, so skip the smoke test
```

This uploads `git archive <sha>` to `releases/<sha>`, creates `.env` with a random `POSTGRES_PASSWORD` (mode 0600; an existing `.env` is never touched), builds the image, starts postgres, runs `migrate`, starts the orchestrator, and waits for it to be healthy. Only then does it point `current` at the release and write `current.env`. Then check it from the server:

```bash
ssh -p 1024 bengrady4@gradyserver.com 'curl -fsS http://127.0.0.1:3040/healthz; echo'
ssh -p 1024 bengrady4@gradyserver.com 'cat ~/deploy/conductor/.env | grep -v PASSWORD'   # review settings
```

## 4. nginx and the certificate (Ben, sudo)

**(Ben)** Read the script first: [`deploy/gradyserver/install-nginx-site.sh`](../../deploy/gradyserver/install-nginx-site.sh). Its header lists every root action. It copies the two conf.d files and the site, gets the certificate if it's missing (through a temporary HTTP-only server block), enables the site, runs `nginx -t`, and only then runs `systemctl reload nginx`. If anything fails, it restores the previous files and exits non-zero. Backups of replaced files go to `/var/backups/conductor-nginx/<UTC>/`.

**(Ben, sudo)** On gradyserver:

```bash
sudo ~bengrady4/deploy/conductor/current/deploy/gradyserver/install-nginx-site.sh --email <your email>
```

`--email` is only needed the first time, for certbot. Rerunning the script is safe; rerun it whenever the nginx files change in a deployed release. Renewal is certbot's existing timer, through the `:80` ACME location.

Then, from the lead's machine:

```bash
deploy/gradyserver/smoke.sh https://conductor.gradyserver.com
```

The SSE check runs only with `SMOKE_COOKIE='<cookie name>=<value>'` taken from a signed-in browser (§5).

## 5. Bootstrap the first user (Ben)

On gradyserver, the lead prints the one-hour admin invite. `conductor-admin` comes from M2-T15 (`src/admin-cli.ts`); in the image it is `dist/admin-cli.js`:

```bash
cdc exec orchestrator node dist/admin-cli.js bootstrap
```

**(Ben)** Open the printed link, sign up, and you own the (empty) `local` account. Then add your Mac from the Machines page (see `docs/setup/add-a-machine.md`, M2-T18).

Turn on the nightly backups (as `bengrady4`, not root):

```bash
~/deploy/conductor/current/deploy/gradyserver/install-cron.sh   # idempotent; 03:17 server time
crontab -l | grep conductor-backup
```

## 6. Routine deploys

```bash
deploy/gradyserver/deploy.sh <git-ref>      # e.g. main, a tag, a sha
```

Every deploy runs these steps, in this order, from the new release's compose file:

1. `compose build`: the image `conductor-orchestrator:<sha>`. A failed build changes nothing.
2. `compose up -d postgres`, then wait until it's healthy. Postgres is only recreated if its own config changed.
3. **The migration gate**: `compose run --rm migrate` (only new migrations apply; the output streams to your terminal). If it fails, `deploy.sh` prints `migration failed — the previous orchestrator is still running` and exits 1. Nothing has touched the orchestrator yet, so the old one keeps serving, and `current` still points at the old release.
4. `compose up -d --no-deps orchestrator`: recreates only the orchestrator, then waits until it's healthy. If it doesn't become healthy, `deploy.sh` prints its logs and exits 1, with `current` unchanged. The migrations are applied by then, so roll back (§7) by deploying the previous sha.
5. Only after that: `current` → `releases/<sha>`, `current.env` gets `CONDUCTOR_GIT_SHA=<sha>`, and the last 5 releases are kept.
6. The smoke test (unless `--no-smoke`), then `deployed <sha>`.

The orchestrator deliberately has no `depends_on` on `migrate` in `compose.yml`. Compose v2 recreates dependents in its create phase and only waits for `service_completed_successfully` at start, so a bare `up` would stop the old orchestrator before migrating and leave the new one `Created` when the migration fails.

Which sha is live: `ssh -p 1024 bengrady4@gradyserver.com 'cat ~/deploy/conductor/current.env'`.

## 7. Rollback

Deploy the previous sha: `deploy/gradyserver/deploy.sh <previous sha>`. Old releases are in `~/deploy/conductor/releases/` (newest first: `ls -1t`).

**Migrations don't roll back.** The old code must work with the new schema; M2 migrations are additive. If a down-migration is really needed, run it as a deliberate, separate step **before** deploying the old sha, and take a backup first (§8):

```bash
cdc run --rm migrate node node_modules/node-pg-migrate/bin/node-pg-migrate.js down --migrations-dir migrations
```

## 8. Backups and restores

Nightly at 03:17 `backup.sh` writes `pg_dump -Fc` to `~/deploy/conductor/backups/conductor-<UTC>.dump` (mode 0600), deletes dumps older than `BACKUP_KEEP_DAYS` (default 14, settable in `.env`), and exits non-zero (logged in `logs/backup.log`) if the dump is empty. Backups stay on the server (U-074). On-demand backup: `~/deploy/conductor/current/deploy/gradyserver/backup.sh`.

### Restore into a scratch database (inspection, and the restore test)

```bash
dump=$(ls -1t ~/deploy/conductor/backups/conductor-*.dump | head -n 1)
cdc exec -T postgres createdb -U conductor conductor_restore_test
cdc exec -T postgres pg_restore -U conductor -d conductor_restore_test --no-owner < "$dump"
cdc exec -T postgres psql -U conductor -d conductor_restore_test -c \
  "select (select count(*) from ticket) tickets, (select count(*) from session) sessions, (select count(*) from pgmigrations) migrations"
cdc exec -T postgres dropdb -U conductor conductor_restore_test
```

**Restore test** (done at M2-T25, then after any change to backups): run `backup.sh` by hand, restore the new dump into `conductor_restore_test` as above, and compare the counts with the live database (the same query with `-d conductor`). They match. Then drop the scratch database.

### Full restore (replaces the live data)

```bash
~/deploy/conductor/current/deploy/gradyserver/backup.sh       # keep a copy of what you replace
cdc stop orchestrator
cdc exec -T postgres pg_restore -U conductor -d conductor --clean --if-exists --no-owner < <dump>
cdc start orchestrator
```

## 9. Optional: copy a local database to the server (U-073)

U-073 is resolved: **the server database starts fresh**, and nothing is copied. If a copy is ever wanted, dump on the Mac, copy, and restore into an empty server database (after §3, before §5):

```bash
# Mac (read-only on the source; never write to, migrate or point a server at the live local board):
pg_dump -Fc -d <local-db> -f /tmp/conductor-local.dump
scp -P 1024 /tmp/conductor-local.dump bengrady4@gradyserver.com:~/deploy/conductor/backups/
# gradyserver: the source schema must be at the same migration as the server (check pgmigrations).
cdc stop orchestrator
cdc exec -T postgres pg_restore -U conductor -d conductor --clean --if-exists --no-owner \
  < ~/deploy/conductor/backups/conductor-local.dump
cdc start orchestrator
```

## 10. Logs

| What | Command / file |
|---|---|
| Orchestrator | `cdc logs -f orchestrator` |
| Migrations (last run) | `cdc logs migrate` |
| Postgres | `cdc logs postgres` |
| Container state and health | `cdc ps -a` |
| nginx | `/var/log/nginx/conductor.gradyserver.com.access.log`, `…error.log` |
| Backups | `~/deploy/conductor/logs/backup.log` |
| Certificates | `/var/log/letsencrypt/letsencrypt.log` (Ben, sudo) |

## 11. Rotate `POSTGRES_PASSWORD`

The `postgres` image only reads `POSTGRES_PASSWORD` when it first creates the volume, so rotation is: change the role's password, then `.env`, then recreate the orchestrator (the next `migrate` run picks up the new `.env` by itself).

```bash
cd ~/deploy/conductor
new=$(openssl rand -hex 32)                       # hex: URL-safe inside DATABASE_URL
cdc exec -T postgres psql -U conductor -d conductor -c "ALTER ROLE conductor PASSWORD '$new'"
cp -p .env .env.bak && sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$new/" .env && rm .env.bak
cdc up -d --no-deps orchestrator                   # recreates it with the new DATABASE_URL
cdc ps                                             # orchestrator healthy again
unset new
```

`psql` inside the container connects over the local socket (trust auth), so the old password isn't needed. If the orchestrator can't connect afterwards, the `.env` value and the role disagree: rerun the `ALTER ROLE` with the value in `.env`.
