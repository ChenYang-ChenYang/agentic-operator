# syntax=mirror.gcr.io/docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
#
# apps/api — Fastify 5 + Drizzle (better-sqlite3) on Node 26.
#
# The normal API uses three stages; two additional curated runtime targets
# package the external Agent Factory control/workload roles without copying
# the primary model tree into either image.
#
#   1. base   — Node 26 + pnpm 11 + corepack pinning. Shared by the build
#               and runtime stages so both speak the same lockfile.
#   2. build  — installs every workspace dep (including dev) and runs
#               `pnpm -r --filter "@agentic/api..." typecheck`. We don't
#               emit JS — the runtime container runs `tsx`, which strips
#               TypeScript on the fly — so `typecheck` is the build gate.
#               Native modules (better-sqlite3) are compiled against the
#               Debian-slim libc here and copied verbatim into the runtime
#               stage.
#   3. runtime — Node 26 slim with only the production node_modules graph,
#               our compiled source tree, and a non-root `agentic` user.
#               `data/` is not baked in. Seed manifests are baked into
#               `/app/models`; compose mounts a writable named volume there,
#               which Docker initializes from those files on first use.
#
# Build:
#   docker build -f apps/api/Dockerfile -t agentic-api:dev .
#
# Run (development sanity check — production runs through compose):
#   docker run --rm -p 3501:3501 \
#     -v $(pwd)/data:/app/data \
#     -v $(pwd)/models:/app/models \
#     --env-file .env.production \
#     agentic-api:dev

# Local builds retain a convenient exact-version tag. Supply-chain releases
# override this global arg with a reviewed docker.io/library/node@sha256:<index
# digest>, which pins the build, runtime and sandbox-common roots to the same
# bytes.
ARG NODE_BASE_IMAGE=node:26.5.0-slim

# --- base ----------------------------------------------------------------
FROM ${NODE_BASE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Better-sqlite3 requires Python and a C++ toolchain to build natively.
# `apt-get -y --no-install-recommends` keeps the layer small.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --fix-missing --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*
# node:26.5.0-slim does NOT ship corepack; install pnpm via npm to keep the
# layer reproducible (avoids `corepack: not found`).
RUN npm install --global pnpm@11.21.0
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
# Copy lockfiles + workspace manifests first so dep installs are cacheable
# independent of source-code changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json .nvmrc ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/
COPY packages packages
COPY tenants tenants
# The root `preinstall` runs scripts/ensure-node-version.mjs (reads .nvmrc, copied
# above) and the `postinstall` runs scripts/ensure-native-modules.mjs during
# `pnpm install` (enable-pre-post-scripts=true), so scripts/ + .npmrc + .nvmrc must
# be in the context BEFORE install or it dies with ENOENT/MODULE_NOT_FOUND.
COPY scripts scripts
COPY .npmrc ./
# Install every workspace package so better-sqlite3 builds against this
# image's libc + node ABI. `--ignore-scripts=false` is the default; the
# pnpm-workspace allowBuilds list pre-approves the natives we trust.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now copy the rest of the source. Layer caching on the previous step
# means a code-only change won't reinstall deps.
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
COPY packages packages
COPY tenants tenants
COPY models models

# Build gate — typecheck the api + its workspace dependencies.
RUN pnpm --filter @agentic/api... typecheck

# --- codex-harness-runtime -----------------------------------------------
# App-server is packaged independently from the pnpm workspace so its native
# platform payload is present only in the full API image. Factory control,
# workload, production CodeAct and one-shot candidate targets do not inherit
# this stage or its binary.
FROM ${NODE_BASE_IMAGE} AS codex-harness-runtime
ARG CODEX_HARNESS_VERSION=0.150.1
WORKDIR /opt/codex
COPY codex.version ./codex.version
COPY deploy/codex/package.json deploy/codex/package-lock.json ./
RUN node -e "const fs=require('node:fs');const expected=process.argv[1];const pinned=fs.readFileSync('codex.version','utf8').trim();const pkg=require('./package.json').dependencies['@openai/codex'];if(pinned!==expected||pkg!==expected)throw new Error('Codex runtime pins do not match '+expected)" "$CODEX_HARNESS_VERSION"
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node -e "const cp=require('node:child_process');const expected=process.argv[1];const out=cp.execFileSync(process.execPath,['node_modules/@openai/codex/bin/codex.js','--version'],{encoding:'utf8'}).trim();if(out!=='codex-cli '+expected)throw new Error('unexpected Codex runtime: '+out)" "$CODEX_HARNESS_VERSION"

# --- runtime -------------------------------------------------------------
FROM ${NODE_BASE_IMAGE} AS runtime
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=api
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV PORT=3501
ENV HOST=0.0.0.0
ENV AGENTIC_DATA_DIR=/app/data
# #AUDIT-FIX(P0-06) — factory 文件存储读 AGENTIC_DATA_ROOT（草稿/策略/上传本体/blob/cassette）
ENV AGENTIC_DATA_ROOT=/app/data
ENV AGENTIC_MODELS_DIR=/app/models
ENV AGENTIC_IMPORTS_DIR=/app/models/.imports
ENV AGENTIC_LOGS_DIR=/app/data/logs
ENV AGENTIC_ARTIFACTS_DIR=/app/data/artifacts
ENV AGENTIC_TENANTS_DIR=/app/data/tenants
ENV CODEX_CLI_PATH=/opt/codex/node_modules/@openai/codex/bin/codex.js
# document.convert uses the system browser as an isolated, deterministic
# text-to-PDF renderer. Keep the path explicit so dependency discovery is not
# distro/PATH dependent at runtime.
ENV DOCUMENT_CHROMIUM_PATH=/usr/bin/chromium
# Default DB path lives on the persistent volume; override via env_file
# when running against a different layout.
ENV DATABASE_URL=file:/app/data/agentic.db
# `tini` is dropped in via the runtime base to forward SIGTERM into the
# Node process; without it, signals from `docker stop` go to PID 1 and
# never reach our graceful shutdown hook.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --fix-missing --no-install-recommends \
      tini \
      ca-certificates \
      chromium \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agentic \
 && useradd  --system --uid 1001 --gid agentic --home /app --shell /usr/sbin/nologin agentic

RUN npm install --global pnpm@11.21.0

WORKDIR /app

# Copy the workspace exactly as the build stage left it — pnpm's
# isolated module layout means each workspace has its own node_modules
# symlinked into the .pnpm store; we need both the store and the symlinks.
COPY --from=build --chown=agentic:agentic /app /app
COPY --from=codex-harness-runtime --chown=agentic:agentic /opt/codex /opt/codex

# Default data / artifact directories — content is volume-mounted at
# runtime; create the mount points so a fresh container without volumes
# still boots (e.g. for `docker run --rm` smoke tests).
RUN mkdir -p /app/data/logs /app/data/artifacts /app/data/backups /app/data/tenants \
             /app/models/.imports \
             /sandbox/control/logs /sandbox/control/artifacts /sandbox/control/models \
             /sandbox/control/tenants /sandbox/db /sandbox/models /sandbox/data/logs \
             /sandbox/data/artifacts /sandbox/data/tenants \
 && chown -R agentic:agentic /app/data /app/models /sandbox

USER agentic
EXPOSE 3501

# Docker needs process liveness, not final readiness: /health depends on the
# host-signed image proof, whose first observation in turn needs this container
# to become healthy. External load balancers must continue to use /health.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3501) +'/live').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

# Entry-point wrapper script — starts the single-writer supervisor, which
# holds one canonical lease across migration and the complete server lifetime.
# Lives in the image so operators don't need to remember a separate
# `db:migrate` step on first boot.
COPY --chown=agentic:agentic apps/api/docker-entrypoint.sh /app/apps/api/docker-entrypoint.sh
RUN chmod +x /app/apps/api/docker-entrypoint.sh

# `tini -- ...` makes tini PID 1 so it forwards SIGTERM into the Node
# process unmodified (without tini, signals to PID 1 don't trigger our
# P4-API-01 graceful-shutdown handler).
#
# tsx ships a shell wrapper at .bin/tsx and the real JS entry under
# `dist/cli.mjs`. We invoke the shell wrapper directly (tini → /bin/sh
# → node), which keeps PATH resolution simple and survives pnpm's
# isolated-module layout. The tsx wrapper exec's node, so our SIGTERM
# handler sits on the only Node process in the tree.
WORKDIR /app/apps/api
ENTRYPOINT ["/usr/bin/tini", "--", "/app/apps/api/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/server.ts"]

# --- sandbox-common -------------------------------------------------------
# Do not derive these images from `runtime`: that stage has already copied the
# complete `/app`, including production models and tenant adapters.  Curated
# COPY operations keep those files physically out of the final image layers.
FROM ${NODE_BASE_IMAGE} AS sandbox-common
ENV NODE_ENV=production
ENV HOST=0.0.0.0

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --fix-missing --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agentic \
 && useradd --system --uid 1001 --gid agentic --home /app --shell /usr/sbin/nologin agentic

WORKDIR /app

# pnpm workspace links resolve through both the root store and each package's
# node_modules directory. Copy the installed dependency graph and generic
# workspace packages, but never copy `models/` here.
COPY --from=build --chown=agentic:agentic /app/package.json /app/tsconfig.base.json /app/pnpm-workspace.yaml /app/
COPY --from=build --chown=agentic:agentic /app/node_modules /app/node_modules
COPY --from=build --chown=agentic:agentic /app/packages /app/packages
COPY --from=build --chown=agentic:agentic /app/apps/api/package.json /app/apps/api/tsconfig.json /app/apps/api/
COPY --from=build --chown=agentic:agentic /app/apps/api/node_modules /app/apps/api/node_modules

RUN mkdir -p /sandbox/control/logs /sandbox/control/artifacts \
             /sandbox/db /sandbox/models /sandbox/data/logs /sandbox/data/artifacts \
             /sandbox/data/tenants /sandbox/gateway \
 && chown -R agentic:agentic /sandbox

# Chromium/CJK fonts are large but change far less often than Factory source.
# Keep them in a source-independent workload base so the generate -> test ->
# revise loop does not reinstall the browser whenever packages/ or apps/ move.
FROM ${NODE_BASE_IMAGE} AS sandbox-workload-base
ENV NODE_ENV=production
ENV HOST=0.0.0.0
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --fix-missing --no-install-recommends \
      tini ca-certificates chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agentic \
 && useradd --system --uid 1001 --gid agentic --home /app --shell /usr/sbin/nologin agentic
WORKDIR /app
COPY --from=build --chown=agentic:agentic /app/package.json /app/tsconfig.base.json /app/pnpm-workspace.yaml /app/
COPY --from=build --chown=agentic:agentic /app/node_modules /app/node_modules
COPY --from=build --chown=agentic:agentic /app/packages /app/packages
COPY --from=build --chown=agentic:agentic /app/apps/api/package.json /app/apps/api/tsconfig.json /app/apps/api/
COPY --from=build --chown=agentic:agentic /app/apps/api/node_modules /app/apps/api/node_modules
RUN mkdir -p /sandbox/db /sandbox/models /sandbox/data/logs /sandbox/data/artifacts /sandbox/data/tenants \
 && chown -R agentic:agentic /sandbox

# --- sandbox-control ------------------------------------------------------
# The HMAC signer receives only its entrypoint and direct control-plane
# dependencies. In particular, it has no production tenant tree, model tree,
# bootstrap module, Inngest workload route, or candidate executor source.
FROM sandbox-common AS sandbox-control
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=control
COPY --from=build --chown=agentic:agentic /app/apps/api/src/sandbox-runner.ts /app/apps/api/src/sandbox-runner.ts
COPY --from=build --chown=agentic:agentic \
  /app/apps/api/src/services/agent-factory/sandbox-remote-protocol.ts \
  /app/apps/api/src/services/agent-factory/sandbox-runner-attestation.ts \
  /app/apps/api/src/services/agent-factory/sandbox-runner-delete-control.ts \
  /app/apps/api/src/services/agent-factory/sandbox-lifecycle-store.ts \
  /app/apps/api/src/services/agent-factory/sandbox-cancel-fence.ts \
  /app/apps/api/src/services/agent-factory/

USER agentic
WORKDIR /app/apps/api
EXPOSE 3560
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/sandbox-runner.ts"]

# --- production-codeact-executor -----------------------------------------
# Curated long-lived launcher for already-promoted CodeAct. It gets the
# generic runtime package graph needed for container RPC, but only this one
# API entrypoint: no primary server, sandbox control/workload implementation,
# models, tenant adapter tree, migrations or provider configuration.
FROM sandbox-common AS production-codeact-executor
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=production-codeact-executor
COPY --from=build --chown=agentic:agentic \
  /app/apps/api/src/codeact-executor.ts \
  /app/apps/api/src/codeact-executor.ts

USER agentic
WORKDIR /app/apps/api
EXPOSE 3570
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "src/codeact-executor.ts"]

# --- sandbox-broker-gateway ----------------------------------------------
# Production sandbox brokers keep their raw Dashboard/GraphQL surface on a
# backend-only network. This mediator exposes normal SDK/event traffic and
# signed callbacks, but app registry read/delete is an exact allowlist behind
# an independent bearer. It receives no runner HMAC or broker event key.
FROM sandbox-common AS sandbox-broker-gateway
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=gateway
COPY --from=build --chown=agentic:agentic \
  /app/apps/api/src/sandbox-broker-gateway.ts \
  /app/apps/api/src/sandbox-broker-gateway.ts
COPY --from=build --chown=agentic:agentic \
  /app/apps/api/src/services/agent-factory/sandbox-gateway-tombstone.ts \
  /app/apps/api/src/services/agent-factory/sandbox-gateway-tombstone.ts

USER agentic
WORKDIR /app/apps/api
EXPOSE 3562
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "src/sandbox-broker-gateway.ts"]

# --- sandbox-workload -----------------------------------------------------
# Workload needs the reviewed tenant adapter packages selected by the signed
# bundle, but still receives no production `models/` tree. Candidate manifests
# and replay material are created only on the isolated `/sandbox/*` volumes.
FROM sandbox-workload-base AS sandbox-workload
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=workload
COPY --from=build --chown=agentic:agentic /app/apps/api/src /app/apps/api/src
COPY --from=build --chown=agentic:agentic /app/apps/api/scripts /app/apps/api/scripts
COPY --from=build --chown=agentic:agentic /app/tenants /app/tenants
COPY --chown=agentic:agentic apps/api/docker-entrypoint.sh /app/apps/api/docker-entrypoint.sh
RUN chmod +x /app/apps/api/docker-entrypoint.sh \
 && mkdir -p /sandbox/models/.imports \
 && chown -R agentic:agentic /sandbox/models

ENV AGENTIC_IMPORTS_DIR=/sandbox/models/.imports
ENV DOCUMENT_CHROMIUM_PATH=/usr/bin/chromium
USER agentic
WORKDIR /app/apps/api
EXPOSE 3561
ENTRYPOINT ["/usr/bin/tini", "--", "/app/apps/api/docker-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "src/sandbox-runner.ts"]

# --- codeact-candidate ----------------------------------------------------
# One invocation == one container. The image contains only Node plus the
# trusted stdio bootstrap: generated code, inputs, capability replies and the
# final result all cross stdin/stdout. The workload launches this digest-pinned
# image with network=none, read-only rootfs, no mounts, no capabilities and a
# numeric non-root identity; this stage itself contains no workspace, model,
# tenant adapter, credential or package-manager tree.
FROM ${NODE_BASE_IMAGE} AS codeact-candidate
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=codeact-candidate
RUN mkdir -p /opt/agentic && chmod 0555 /opt/agentic
COPY --chmod=0444 packages/runtime/src/codeact-candidate-bootstrap.cjs /opt/agentic/codeact-candidate-bootstrap.cjs
USER 65532:65532
WORKDIR /
ENTRYPOINT ["node", "/opt/agentic/codeact-candidate-bootstrap.cjs"]
CMD []

# Keep the historical no-`--target` Docker build behavior: the default output
# remains the full API image, while Compose/release select the curated targets by
# name for the external sandbox profile.
FROM runtime AS api-runtime
