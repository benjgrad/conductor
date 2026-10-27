#!/usr/bin/env bash
# Static checks of compose.yml, env.example, the Dockerfile and .dockerignore (M2-T07). No Docker
# needed; `docker compose config` and `docker build` run on gradyserver in the lead's QA step.
# Structural checks use PyYAML when python3 has it; the grep checks always run.
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMPOSE="$KIT/compose.yml"
echo "compose.test.sh"

compose="$(sed 's/#.*//' "$COMPOSE")"
postgres="$(yaml_service "$COMPOSE" postgres)"
migrate="$(yaml_service "$COMPOSE" migrate)"
orch="$(yaml_service "$COMPOSE" orchestrator)"

check "project name conductor" has "$compose" '^name: conductor$'
check "orchestrator published on 127.0.0.1 only" has "$orch" \
  "- '127\.0\.0\.1:\\$\{CONDUCTOR_HOST_PORT:-3040\}:7400'"
check "exactly one published port in the file" test "$(grep -c '^    ports:' <<<"$compose")" -eq 1
check "postgres has no ports" lacks "$postgres" 'ports:'
check "postgres:16" has "$postgres" 'image: postgres:16$'
check "postgres pg_isready healthcheck" has "$postgres" 'pg_isready -U conductor -d conductor'
check "postgres named volume pgdata" has "$postgres" '- pgdata:/var/lib/postgresql/data'
check "postgres password from .env (required)" has "$postgres" \
  'POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?'
check "migrate runs node-pg-migrate up" has "$migrate" "'up'"
check "migrate restart 'no'" has "$migrate" "restart: 'no'"
check "orchestrator waits for healthy postgres" has "$orch" 'condition: service_healthy'
check "orchestrator waits for migrate to complete" has "$orch" \
  'condition: service_completed_successfully'
check "orchestrator restart unless-stopped" has "$orch" 'restart: unless-stopped'
for kv in 'CONDUCTOR_AUTH: password' 'CONDUCTOR_BIND_HOST: 0\.0\.0\.0' \
  'CONDUCTOR_PUBLIC_URL: \$\{CONDUCTOR_PUBLIC_URL:\?' 'CONDUCTOR_TRUSTED_PROXY: ' 'DATABASE_URL: '; do
  check "orchestrator env ${kv%%:*}" has "$orch" "^      $kv"
done
check "subnet default 192.168.80.0/24" has "$compose" \
  'subnet: \$\{CONDUCTOR_SUBNET:-192\.168\.80\.0/24\}'
check "gateway default 192.168.80.1" has "$compose" 'gateway: \$\{CONDUCTOR_GATEWAY:-192\.168\.80\.1\}'
check "trusted proxy default = gateway" has "$compose" \
  'CONDUCTOR_TRUSTED_PROXY: \$\{CONDUCTOR_TRUSTED_PROXY:-192\.168\.80\.1\}'

# Every ${VAR} used in compose.yml is documented in env.example (CONDUCTOR_GIT_SHA is set by
# deploy.sh and documented in env.example's header instead).
env_example="$(cat "$KIT/env.example")"
for var in $(grep -oE '\$\{[A-Z_]+' "$COMPOSE" | sort -u | tr -d '${'); do
  if [[ "$var" == CONDUCTOR_GIT_SHA ]]; then
    check "env.example mentions $var" has "$env_example" "$var"
  else
    check "env.example defines $var" has "$env_example" "^$var="
  fi
done
check "env.example leaves POSTGRES_PASSWORD empty (deploy.sh fills it)" \
  has "$env_example" '^POSTGRES_PASSWORD=$'
check "env.example port matches the compose default" has "$env_example" '^CONDUCTOR_HOST_PORT=3040$'

if python3 -c 'import yaml' 2>/dev/null; then
  check "compose.yml structure (PyYAML)" python3 -I - "$COMPOSE" <<'PY'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
s = c["services"]
assert c["name"] == "conductor"
assert set(s) == {"postgres", "migrate", "orchestrator"}, set(s)
assert "ports" not in s["postgres"] and "ports" not in s["migrate"]
assert s["orchestrator"]["ports"] == ["127.0.0.1:${CONDUCTOR_HOST_PORT:-3040}:7400"]
assert s["migrate"]["image"] == s["orchestrator"]["image"]
assert s["migrate"]["build"] == s["orchestrator"]["build"]
assert s["migrate"]["build"]["context"] == "../.."
assert s["migrate"]["restart"] == "no"
assert s["migrate"]["command"][:2] == ["node", "node_modules/node-pg-migrate/bin/node-pg-migrate.js"]
assert s["migrate"]["depends_on"] == {"postgres": {"condition": "service_healthy"}}
assert s["orchestrator"]["depends_on"] == {
    "postgres": {"condition": "service_healthy"},
    "migrate": {"condition": "service_completed_successfully"},
}
assert s["migrate"]["environment"]["DATABASE_URL"] == s["orchestrator"]["environment"]["DATABASE_URL"]
assert s["orchestrator"]["environment"]["DATABASE_URL"].endswith("@postgres:5432/conductor")
assert "pg_isready" in " ".join(s["postgres"]["healthcheck"]["test"])
for name in s:
    assert s[name]["networks"] == ["conductor"], name
net = c["networks"]["conductor"]
assert net["name"] == "conductor"
assert net["ipam"]["config"][0]["subnet"] == "${CONDUCTOR_SUBNET:-192.168.80.0/24}"
assert "pgdata" in c["volumes"]
PY
else
  echo "  skip  compose.yml structure (python3 has no PyYAML)"
fi

dockerfile="$(sed 's/#.*//' "$REPO/Dockerfile")"
check "Dockerfile: node bookworm-slim base" has "$dockerfile" '^FROM node:\$\{NODE_VERSION\}-bookworm-slim'
check "Dockerfile: Node pinned to .npmrc's version" \
  has "$dockerfile" "^ARG NODE_VERSION=$(sed -n 's/^use-node-version=//p' "$REPO/.npmrc")\$"
check "Dockerfile: pnpm 10 via npm" has "$dockerfile" 'npm i -g pnpm@10'
check "Dockerfile: no corepack" lacks "$dockerfile" 'corepack'
check "Dockerfile: frozen lockfile" has "$dockerfile" 'pnpm install --frozen-lockfile'
check "Dockerfile: pnpm build" has "$dockerfile" '^RUN pnpm build$'
check "Dockerfile: prod deploy of the orchestrator" \
  has "$dockerfile" 'pnpm --filter @conductor/orchestrator --prod deploy'
check "Dockerfile: daemon-tarball stage" has "$dockerfile" '^FROM [^ ]+ AS daemon-tarball$'
check "Dockerfile: USER node" has "$dockerfile" '^USER node$'
check "Dockerfile: EXPOSE 7400" has "$dockerfile" '^EXPOSE 7400$'
check "Dockerfile: HEALTHCHECK on /healthz" has "$dockerfile" "fetch\('http://127\.0\.0\.1:7400/healthz'\)"
check "Dockerfile: CMD runs dist/bin.js" has "$dockerfile" '^CMD \["node", "dist/bin\.js"\]$'
check "Dockerfile: USER comes after the last COPY" test \
  "$(grep -n '^USER node' <<<"$dockerfile" | cut -d: -f1)" -gt \
  "$(grep -n '^COPY' <<<"$dockerfile" | tail -n 1 | cut -d: -f1)"

dockerignore="$(cat "$REPO/.dockerignore")"
for entry in node_modules .git .claude spikes '\*\*/dist' '\.env\*' '\.npmrc'; do
  check ".dockerignore has ${entry//\\/}" has "$dockerignore" "^$entry$"
done
check ".dockerignore keeps e2e/ (tsc -b references it)" lacks "$dockerignore" '^e2e'

finish
