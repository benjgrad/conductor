# syntax=docker/dockerfile:1
#
# Conductor orchestrator image (M2-T07; ADR-0017 §Hosting topology). One image serves the API,
# SSE, the daemon WebSocket, the web app, /install.sh and the daemon tarball. The `migrate`
# service in deploy/gradyserver/compose.yml runs the same image with node-pg-migrate.
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
# production deps only: no @conductor/daemon, no @types. Its own dist/ and migrations/ and the
# workspace dep @conductor/shared (with dist/) come along; the checks below fail the build if
# that ever stops being true.
RUN pnpm --filter @conductor/orchestrator --prod deploy --legacy /out/app \
 && rm -rf /out/app/src /out/app/test /out/app/tsconfig.json \
 && test -f /out/app/dist/bin.js \
 && test -d /out/app/migrations \
 && test -f /out/app/node_modules/@conductor/shared/dist/index.js \
 && test -f /out/app/node_modules/node-pg-migrate/bin/node-pg-migrate.js \
 && test ! -e /out/app/node_modules/@conductor/daemon \
 && cp -r packages/web/dist /out/app/web \
 && test -f /out/app/web/index.html

# ==== daemon-tarball (M2-T14) ===================================================================
# conductor-daemon-<version>.tgz and its .sha256 into /out/downloads (ADR-0017 §Daemon
# distribution): a `pnpm deploy --legacy` of the daemon, <version> = package version + the short
# GIT_SHA. The script also unpacks the result and runs `bin/conductor-daemon --help` with only
# Node on PATH. .git is dockerignored, so the sha comes only from the build arg.
FROM build AS daemon-tarball
ARG GIT_SHA=unknown
RUN sha="$(printf %.7s "$GIT_SHA")"; if [ "$GIT_SHA" = unknown ]; then sha=; fi; \
    CONDUCTOR_BUILD_SHA="$sha" packages/orchestrator/scripts/build-daemon-tarball.sh /out/downloads \
 && ls /out/downloads/conductor-daemon-*.tgz /out/downloads/conductor-daemon-*.tgz.sha256 \
 && test -f /out/app/assets/install.sh.tmpl

# ---- runtime: production deps, built output, web app, migrations; non-root ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    CONDUCTOR_PORT=7400 \
    CONDUCTOR_WEB_DIR=/app/web \
    CONDUCTOR_GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
COPY --from=daemon-tarball --chown=node:node /out/downloads /app/downloads
USER node
EXPOSE 7400
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7400/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The migrate service overrides this with:
#   node node_modules/node-pg-migrate/bin/node-pg-migrate.js up --migrations-dir migrations
# (not node_modules/.bin/node-pg-migrate: pnpm's .bin shims hardcode the /out/app build path).
CMD ["node", "dist/bin.js"]
