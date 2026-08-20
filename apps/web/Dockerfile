# syntax=mirror.gcr.io/docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
#
# apps/web — Next.js 16 + React 19 standalone production build.
#
# We deliberately use Next.js's `output: "standalone"` mode (configured in
# `next.config.mjs`) so the runtime image carries only the bundled server
# + the minimal `node_modules` Next needs at runtime — about 30 MB instead
# of the multi-hundred-MB unbundled tree.
#
# Web has zero direct DB access — every read goes through `/v1/*` to the
# api service, so this image carries no native modules and no SQLite.
# `AGENTIC_API_URL` controls where rewrites point.
#
# Build:
#   docker build --build-arg AGENTIC_API_URL=http://api:3501 -f apps/web/Dockerfile -t agentic-web:dev .
#
# Run:
#   docker run --rm -p 3599:3599 -e AGENTIC_API_URL=http://api:3501 agentic-web:dev

# Supply-chain releases and the local production installer pass an exact
# platform digest. The tag default remains only for ad-hoc developer builds.
ARG NODE_BASE_IMAGE=node:26.5.0-slim

# --- base ----------------------------------------------------------------
FROM ${NODE_BASE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# python3/make/g++ are needed because the whole-workspace `pnpm install` builds
# better-sqlite3 from source on Node 26 (no prebuilt binary) — mirror apps/api.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# node:26.5.0-slim does NOT ship corepack; install pnpm via npm.
RUN npm install --global pnpm@11.3.0
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
# Workspace skeleton — keep dep installs cache-friendly.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json .nvmrc ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/
COPY packages packages
COPY tenants tenants
# Root `preinstall` runs scripts/ensure-node-version.mjs (reads .nvmrc) and
# `postinstall` runs scripts/ensure-native-modules.mjs during install.
COPY scripts scripts
COPY .npmrc ./

# Install workspace deps. Web only needs @agentic/contracts at runtime,
# but the pnpm workspace install is whole-graph so dependants resolve.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now the source.
COPY apps/web apps/web
COPY packages packages

# `next build` reads the same env at build time as `next dev`. Inject a
# build-time API URL so rewrites compile in.
ARG AGENTIC_API_URL
ENV AGENTIC_API_URL=${AGENTIC_API_URL}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @agentic/web build
# Next 的 `public/` 是可选目录，本仓没有它：663eca0（2026-07-20）清理未追踪的
# 运行时产物时删掉了它，而它当时唯一的内容 `public/demo/index.html` 属于按
# docs/merge/2026-07-20-kenny-merge-playbook.md 必须永久删除的 demo 模式。
# 所以正确做法不是把目录加回版本控制（那会复活一个已被决策删除的东西），而是
# 在这里保证它存在——下面 runtime 阶段的 COPY 是无条件的，缺了就整条生产构建
# 断在最后一步：
#   COPY /app/apps/web/public → failed to compute cache key: "…/public": not found
# 建空目录后，「将来真的加了静态资源」与「现在没有」两种情况都能构建。
# 契约由 apps/api/test/dockerfile-copy-paths.test.ts 守住。
RUN mkdir -p /app/apps/web/public

# --- runtime -------------------------------------------------------------
FROM ${NODE_BASE_IMAGE} AS runtime
ARG AGENTIC_BUILD_ID=unverified-local-build
ARG AGENTIC_SOURCE_REPOSITORY=local-worktree
LABEL org.opencontainers.image.revision=$AGENTIC_BUILD_ID \
      org.opencontainers.image.source=$AGENTIC_SOURCE_REPOSITORY \
      io.agentic.sandbox.role=web
ENV NODE_ENV=production
ENV PORT=3599
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agentic \
 && useradd  --system --uid 1001 --gid agentic --home /app --shell /usr/sbin/nologin agentic
WORKDIR /app

# Next.js standalone output is self-contained: server.js + its trimmed
# node_modules. Copy alongside .next/static + public.
COPY --from=build --chown=agentic:agentic /app/apps/web/.next/standalone /app/
COPY --from=build --chown=agentic:agentic /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build --chown=agentic:agentic /app/apps/web/public /app/apps/web/public

USER agentic
EXPOSE 3599

# Service-local liveness only. Rendering `/` may invoke API rewrites and would
# create web → API readiness → host attestation → web bootstrap recursion.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=require('node:net').connect({host:'127.0.0.1',port:Number(process.env.PORT||3599)});s.setTimeout(4000);s.once('connect',()=>{s.end();process.exit(0)});s.once('timeout',()=>process.exit(1));s.once('error',()=>process.exit(1))" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
