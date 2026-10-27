#!/usr/bin/env bash
# Smoke test of a deployed conductor (M2-T07). Runs every check, prints ok / FAIL / skip for each,
# and exits with the number of failures (0 = all passed).
#
#   deploy/gradyserver/smoke.sh https://conductor.gradyserver.com
#
# SMOKE_COOKIE: a signed-in session cookie ("name=value"); enables the SSE check.
# SMOKE_EXPECT_SHA: the git sha that must be live; /healthz's `version` (package version + git
#   sha, ADR-0017 §Daemon distribution) must contain it. deploy.sh sets it.
# Expected to fail until M2-T08 (auth, CSP, Origin check) and M2-T14 (/healthz, /install.sh) are
# deployed.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <base-url>   (e.g. https://conductor.gradyserver.com)" >&2
  exit 2
fi
URL="${1%/}"
FAILS=0

ok() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*"
  FAILS=$((FAILS + 1))
}
skip() { echo "skip  $*"; }

# status <curl args...>: prints the HTTP status code (000 on a connection or TLS error).
status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || true; }

expect_status() {
  local want="$1" what="$2"
  shift 2
  local got
  got="$(status "$@")"
  if [[ "$got" == "$want" ]]; then ok "$what → $got"; else fail "$what → $got (want $want)"; fi
}

# 1. TLS: curl verifies the certificate chain and host name by default.
if curl -sS -o /dev/null --max-time 15 "$URL/"; then
  ok "TLS certificate valid for $URL"
else
  fail "TLS / connection to $URL"
fi
if [[ "$URL" == https://* ]] && command -v openssl >/dev/null; then
  host="${URL#https://}"
  host="${host%%/*}"
  enddate="$(openssl s_client -connect "$host:443" -servername "$host" </dev/null 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null || true)"
  [[ -n "$enddate" ]] && echo "info  certificate $enddate"
fi

# 2. Security headers (nginx: HSTS, X-Frame-Options, nosniff; orchestrator: CSP).
headers="$(curl -sS -D - -o /dev/null --max-time 15 "$URL/" 2>/dev/null || true)"
for h in 'strict-transport-security:' 'x-frame-options:' 'x-content-type-options: *nosniff' \
  'content-security-policy:'; do
  if grep -qiE "^$h" <<<"$headers"; then ok "header ${h%%:*}"; else fail "header ${h%%:*} missing"; fi
done

# 3. Health, auth and the Origin check.
expect_status 200 "GET /healthz" "$URL/healthz"
if [[ -n "${SMOKE_EXPECT_SHA:-}" ]]; then
  health_body="$(curl -fsS --max-time 15 "$URL/healthz" 2>/dev/null || true)"
  version="$(sed -nE 's/.*"version" *: *"([^"]*)".*/\1/p' <<<"$health_body")"
  # The version may carry a short sha: match on its first 7 characters.
  if [[ -n "$version" && "$version" == *"${SMOKE_EXPECT_SHA:0:7}"* ]]; then
    ok "/healthz version $version is $SMOKE_EXPECT_SHA"
  else
    fail "/healthz version '${version:-none}' is not $SMOKE_EXPECT_SHA (stale orchestrator?)"
  fi
fi
expect_status 401 "GET /api/board without a cookie" "$URL/api/board"
expect_status 403 "POST /auth/login without Origin" -X POST -H 'content-type: application/json' \
  -d '{}' "$URL/auth/login"

# 4. SSE headers (needs a session).
if [[ -n "${SMOKE_COOKIE:-}" ]]; then
  # The stream never ends: curl stops after 5 s (exit 28), headers already received.
  sse="$(curl -sS -D - -o /dev/null --max-time 5 -H "Cookie: $SMOKE_COOKIE" \
    "$URL/api/stream/board" 2>/dev/null || true)"
  if grep -qiE '^content-type: *text/event-stream' <<<"$sse"; then
    ok "GET /api/stream/board → text/event-stream"
  else
    fail "GET /api/stream/board did not answer text/event-stream"
  fi
else
  skip "SSE check (set SMOKE_COOKIE to a signed-in session cookie)"
fi

# 5. Daemon WebSocket without a credential → 401 at the upgrade.
expect_status 401 "WS upgrade /ws/daemon without a credential" --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$URL/ws/daemon"

# 6. The install script is served.
install_sh="$(curl -fsS --max-time 15 "$URL/install.sh" 2>/dev/null || true)"
if [[ "$install_sh" == '#!'* ]]; then ok "GET /install.sh served"; else fail "GET /install.sh not served"; fi

if [[ "$FAILS" -eq 0 ]]; then
  echo "smoke: all checks passed"
else
  echo "smoke: $FAILS check(s) failed"
fi
exit "$FAILS"
