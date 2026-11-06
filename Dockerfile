# syntax=docker/dockerfile:1
#
# Conductor orchestrator image (M2-T07; ADR-0017 §Hosting topology). One image serves the API,
# SSE, the daemon WebSocket, the web app, /install.sh and the daemon tarballs. The `migrate`
# service in deploy/gradyserver/compose.yml runs the same image with node-pg-migrate.
#
# The daemon tarballs (one per target, MR-T15) are not built here: CI builds them
# (.github/workflows/daemon-dist.yml) and the deploy puts them in the build context as daemon-dist/
# (deploy/gradyserver/ci-deploy.sh, deploy.sh). For a local image: `scripts/build-daemon-dist.sh
# daemon-dist && docker build --build-arg DAEMON_DIST_PARTIAL=1 .` (this machine's target only).
#
# Node is pinned to the version in .npmrc (`use-node-version`). .npmrc itself is dockerignored:
# inside the image pnpm would otherwise download a second copy of Node for scripts.
ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
# pnpm 10 from npm, never corepack (CLAUDE.md §Rules).
RUN npm i -g pnpm@10
WORKDIR /repo

# ---- build: install everything, build all packages, assemble the production app ----
FROM base AS build
# If a dependency ever needs a native build without a prebuilt linux-x64 glibc binary
# (e.g. argon2 from M2-T08), add: RUN apt-get update && apt-get install -y python3 make g++
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
# `pnpm deploy --legacy` (pnpm 10 without inject-workspace-packages) copies the orchestrator with
# production deps only: no @types. Its own dist/ and migrations/ and the
# workspace dep @conductor/shared (with dist/) come along; the checks below fail the build if
# that ever stops being true.
RUN pnpm --filter @conductor/orchestrator --prod deploy --legacy /out/app \
 && rm -rf /out/app/src /out/app/test /out/app/tsconfig.json \
 && test -f /out/app/dist/bin.js \
 && test -d /out/app/migrations \
 && test -f /out/app/node_modules/@conductor/shared/dist/index.js \
 && test -f /out/app/node_modules/node-pg-migrate/bin/node-pg-migrate.js \
 && test -f /out/app/assets/install.sh.tmpl \
 && test -f /out/app/assets/install.ps1.tmpl \
 && cp -r packages/web/dist /out/app/web \
 && test -f /out/app/web/index.html

# ==== daemon-dist (MR-T15) =====================================================================
# conductor-daemon-<version>-<target>.tgz and .sha256 for every target (ADR-0026 §4), from the
# build context's daemon-dist/. Every target must be there with a matching SHA-256, and all of one
# version; DAEMON_DIST_PARTIAL=1 (local builds only) accepts any non-empty subset.
FROM base AS daemon-dist
ARG DAEMON_DIST_PARTIAL=0
COPY daemon-dist/ /out/downloads/
RUN set -eu; cd /out/downloads; found=0; versions=""; \
    for t in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu \
             aarch64-unknown-linux-gnu x86_64-pc-windows-msvc; do \
      set -- conductor-daemon-*-"$t".tgz; \
      if [ ! -e "$1" ]; then \
        [ "$DAEMON_DIST_PARTIAL" = 1 ] && continue; \
        echo "daemon-dist: no build for $t" >&2; exit 1; \
      fi; \
      [ $# -eq 1 ] || { echo "daemon-dist: $# builds for $t" >&2; exit 1; }; \
      sha256sum -c "$1.sha256"; \
      v="${1#conductor-daemon-}"; versions="$versions ${v%-"$t".tgz}"; found=$((found + 1)); \
    done; \
    [ "$found" -gt 0 ] || { echo "daemon-dist: no daemon builds in daemon-dist/" >&2; exit 1; }; \
    [ "$(printf '%s\n' $versions | sort -u | wc -l)" -eq 1 ] || \
      { echo "daemon-dist: more than one version:$versions" >&2; exit 1; }; \
    ls -l /out/downloads

# ---- runtime: production deps, built output, web app, migrations; non-root ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    CONDUCTOR_PORT=7400 \
    CONDUCTOR_WEB_DIR=/app/web \
    CONDUCTOR_GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
COPY --from=daemon-dist --chown=node:node /out/downloads /app/downloads
USER node
EXPOSE 7400
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7400/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The migrate service overrides this with:
#   node node_modules/node-pg-migrate/bin/node-pg-migrate.js up --migrations-dir migrations
# (not node_modules/.bin/node-pg-migrate: pnpm's .bin shims hardcode the /out/app build path).
CMD ["node", "dist/bin.js"]
