#!/usr/bin/env bash
# Static checks of the nginx files (M2-T07 acceptance). No nginx needed.
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SITE="$KIT/nginx/conductor.gradyserver.com.conf"
RATE="$KIT/nginx/conductor-ratelimit.conf"
WS="$KIT/nginx/conductor-websocket.conf"
echo "nginx-site.test.sh"

site="$(sed 's/#.*//' "$SITE")"
ws_loc="$(nginx_block "$SITE" '^[[:space:]]*location /ws/ ')"
stream_loc="$(nginx_block "$SITE" '^[[:space:]]*location /api/stream/ ')"
auth_loc="$(nginx_block "$SITE" 'location ~ \^/\(auth/\|api/machines/enroll\)')"
root_loc="$(nginx_block "$SITE" '^[[:space:]]*location / ' last)"
acme_loc="$(nginx_block "$SITE" 'location /\.well-known/acme-challenge/ ')"

check "/ws/ location exists" test -n "$ws_loc"
check "/ws/ passes Upgrade" has "$ws_loc" 'proxy_set_header Upgrade \$http_upgrade;'
check "/ws/ uses the prefixed upgrade map" has "$ws_loc" \
  'proxy_set_header Connection \$conductor_connection_upgrade;'
check "/ws/ HTTP/1.1" has "$ws_loc" 'proxy_http_version 1\.1;'
check "/ws/ read timeout 3600s" has "$ws_loc" 'proxy_read_timeout 3600s;'
check "/ws/ repeats X-Forwarded-For" has "$ws_loc" 'X-Forwarded-For \$proxy_add_x_forwarded_for;'

check "/api/stream/ location exists" test -n "$stream_loc"
check "/api/stream/ proxy_buffering off" has "$stream_loc" 'proxy_buffering off;'
check "/api/stream/ proxy_cache off" has "$stream_loc" 'proxy_cache off;'
check "/api/stream/ read timeout 3600s" has "$stream_loc" 'proxy_read_timeout 3600s;'
check "/api/stream/ HTTP/1.1" has "$stream_loc" 'proxy_http_version 1\.1;'
check "/api/stream/ clears Connection" has "$stream_loc" 'proxy_set_header Connection "";'
check "/api/stream/ repeats X-Forwarded-Proto" has "$stream_loc" 'X-Forwarded-Proto \$scheme;'

check "auth/enroll location uses conductor_auth" has "$auth_loc" 'limit_req zone=conductor_auth '
check "/ location uses conductor_general" has "$root_loc" 'limit_req zone=conductor_general '
check "ratelimit.conf defines conductor_auth" has "$(cat "$RATE")" \
  '^limit_req_zone \$binary_remote_addr zone=conductor_auth:[0-9]+m rate='
check "ratelimit.conf defines conductor_general" has "$(cat "$RATE")" \
  '^limit_req_zone \$binary_remote_addr zone=conductor_general:[0-9]+m rate='
check "site declares no limit_req_zone (http context lives in conf.d)" lacks "$site" 'limit_req_zone'
check "websocket.conf defines the prefixed map" has "$(cat "$WS")" \
  '^map \$http_upgrade \$conductor_connection_upgrade \{'
check "site has no unprefixed \$connection_upgrade" lacks "$site" '[^_]\$connection_upgrade'

check "ACME location serves /var/www/html" has "$acme_loc" 'root /var/www/html;'
http_root_loc="$(nginx_block "$SITE" '^[[:space:]]*location / ')"
check ":80 location / is the 301" has "$http_root_loc" 'return 301 https://'
check ":80 redirects with 301 to https" has "$site" 'return 301 https://\$host\$request_uri;'
check ":443 ssl http2" has "$site" 'listen 443 ssl http2;'
check "Let's Encrypt fullchain" has "$site" \
  'ssl_certificate /etc/letsencrypt/live/conductor\.gradyserver\.com/fullchain\.pem;'
for h in Strict-Transport-Security X-Frame-Options X-Content-Type-Options X-Robots-Tag; do
  check "server-level add_header $h" has "$site" "^    add_header $h "
done
check "no add_header inside a location (it would drop the server-level headers)" \
  lacks "$ws_loc$stream_loc$auth_loc$root_loc$acme_loc" 'add_header'
check "client_max_body_size 4m" has "$site" 'client_max_body_size 4m;'
check "per-site access log" has "$site" 'access_log /var/log/nginx/conductor\.gradyserver\.com\.access\.log;'

compose_port="$(sed -nE 's/.*127\.0\.0\.1:\$\{CONDUCTOR_HOST_PORT:-([0-9]+)\}:7400.*/\1/p' \
  "$KIT/compose.yml")"
check "upstream port = compose CONDUCTOR_HOST_PORT default ($compose_port)" \
  has "$site" "server 127\.0\.0\.1:${compose_port:-none};"
check "upstream keepalive" has "$site" 'keepalive [0-9]+;'

finish
