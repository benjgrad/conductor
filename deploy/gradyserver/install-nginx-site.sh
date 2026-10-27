#!/usr/bin/env bash
# Root steps for conductor.gradyserver.com (M2-T07; ADR-0017 §Hosting topology). Ben reads this,
# then runs it on gradyserver from the deployed release:
#
#   sudo ~bengrady4/deploy/conductor/current/deploy/gradyserver/install-nginx-site.sh --email <email>
#
# --email is needed only while the Let's Encrypt certificate does not exist yet. Idempotent.
# What it does as root, and nothing else:
#   1. copies nginx/conductor-ratelimit.conf and nginx/conductor-websocket.conf into
#      /etc/nginx/conf.d/ and the site into /etc/nginx/sites-available/, backing up any different
#      existing copy to /var/backups/conductor-nginx/<UTC timestamp>/;
#   2. if /etc/letsencrypt/live/conductor.gradyserver.com is missing: enables a temporary HTTP-only
#      server block for the ACME challenge, reloads nginx, runs certbot certonly --webroot, and
#      removes the temporary block;
#   3. links the site into /etc/nginx/sites-enabled/;
#   4. nginx -t, and only then systemctl reload nginx. A failed nginx -t (or any failed step)
#      restores the backups, removes files this run created, and exits non-zero.
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-nginx-site.sh: must run as root (sudo $0 [--email <email>])" >&2
  exit 1
fi

DOMAIN=conductor.gradyserver.com
SRC="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/nginx"
CONF_D=/etc/nginx/conf.d
AVAILABLE=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
SITE="$AVAILABLE/$DOMAIN"
SITE_LINK="$ENABLED/$DOMAIN"
BOOTSTRAP="$AVAILABLE/$DOMAIN-bootstrap"
BOOTSTRAP_LINK="$ENABLED/$DOMAIN-bootstrap"
LIVE_CERT="/etc/letsencrypt/live/$DOMAIN"
WEBROOT=/var/www/html
BACKUP_DIR="/var/backups/conductor-nginx/$(date -u +%Y%m%dT%H%M%SZ)"

EMAIL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      EMAIL="${2:-}"
      shift 2 || true
      ;;
    --email=*)
      EMAIL="${1#--email=}"
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "install-nginx-site.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

step() { echo "==> $*"; }

for f in conductor-ratelimit.conf conductor-websocket.conf "$DOMAIN.conf"; do
  [[ -f "$SRC/$f" ]] || {
    echo "install-nginx-site.sh: missing $SRC/$f" >&2
    exit 1
  }
done
if [[ ! -d "$LIVE_CERT" && -z "$EMAIL" ]]; then
  echo "install-nginx-site.sh: no certificate in $LIVE_CERT yet; pass --email <email> for certbot" >&2
  exit 2
fi

# Rollback bookkeeping: files backed up (restored on failure) and paths this run created
# (removed on failure).
BACKED_UP=()
CREATED=()
RELOADED=0

rollback() {
  echo "!!> failed: rolling back nginx changes" >&2
  local f
  for f in "${CREATED[@]+"${CREATED[@]}"}"; do
    echo "!!> removing $f" >&2
    rm -f "$f"
  done
  for f in "${BACKED_UP[@]+"${BACKED_UP[@]}"}"; do
    echo "!!> restoring $f from $BACKUP_DIR" >&2
    cp -a "$BACKUP_DIR/$(basename "$f")" "$f"
  done
  # nginx was already reloaded once by this run (bootstrap block): put the restored config live.
  if [[ "$RELOADED" -eq 1 ]] && nginx -t; then
    echo "!!> systemctl reload nginx (restored configuration)" >&2
    systemctl reload nginx || true
  fi
}
trap 'rollback; exit 1' ERR

install_file() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    if cmp -s "$src" "$dst"; then
      step "$dst is up to date"
      return
    fi
    mkdir -p "$BACKUP_DIR"
    cp -a "$dst" "$BACKUP_DIR/$(basename "$dst")"
    BACKED_UP+=("$dst")
    step "backed up $dst to $BACKUP_DIR/"
  else
    CREATED+=("$dst")
  fi
  install -m 0644 "$src" "$dst"
  step "installed $dst"
}

link() {
  local target="$1" name="$2"
  if [[ "$(readlink "$name" 2>/dev/null || true)" == "$target" ]]; then
    step "$name already links to $target"
    return
  fi
  [[ -e "$name" || -L "$name" ]] || CREATED+=("$name")
  ln -sfn "$target" "$name"
  step "linked $name -> $target"
}

nginx_test() {
  step "nginx -t"
  if ! nginx -t; then
    trap - ERR
    rollback
    echo "install-nginx-site.sh: nginx -t failed; previous configuration restored, nginx not reloaded" >&2
    exit 1
  fi
}

reload_nginx() {
  step "systemctl reload nginx"
  systemctl reload nginx
  RELOADED=1
}

step "installing http-context files into $CONF_D"
install_file "$SRC/conductor-ratelimit.conf" "$CONF_D/conductor-ratelimit.conf"
install_file "$SRC/conductor-websocket.conf" "$CONF_D/conductor-websocket.conf"
step "installing the site into $AVAILABLE"
install_file "$SRC/$DOMAIN.conf" "$SITE"

if [[ ! -d "$LIVE_CERT" ]]; then
  step "no certificate in $LIVE_CERT: enabling an HTTP-only bootstrap server block for ACME"
  # The full site references the certificate files, so it can't be enabled before they exist.
  CREATED+=("$BOOTSTRAP")
  cat >"$BOOTSTRAP" <<EOF
# Temporary (install-nginx-site.sh): serves only the ACME challenge until the certificate exists.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }
    location / {
        return 404;
    }
}
EOF
  chmod 0644 "$BOOTSTRAP"
  link "$BOOTSTRAP" "$BOOTSTRAP_LINK"
  nginx_test
  reload_nginx
  step "certbot certonly --webroot -w $WEBROOT -d $DOMAIN"
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"
  step "removing the bootstrap server block"
  rm -f "$BOOTSTRAP_LINK" "$BOOTSTRAP"
else
  step "certificate present in $LIVE_CERT"
fi

step "enabling the site"
link "$SITE" "$SITE_LINK"
nginx_test
reload_nginx
trap - ERR
step "done: https://$DOMAIN is served by nginx (backups, if any, in $BACKUP_DIR)"
