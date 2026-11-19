# The data inventory behind the website's "What we keep" page: generated from the schema and the descriptions in src/privacy by the
# code in this image, so the page, /keep/inventory.json and the hash the router logs cannot disagree with the schema.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS inventory
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800
COPY src ./src
COPY scripts/gen-inventory.ts ./scripts/gen-inventory.ts
RUN bun scripts/gen-inventory.ts --out /out/inventory.generated.json

# Website: static Next.js export, served by the router at /.
FROM node:22.23.4-bookworm-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc AS web
WORKDIR /web
RUN npm install -g pnpm@11.19.0
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/next.config.mjs ./
COPY web/app ./app
COPY --from=inventory /out/inventory.generated.json ./app/keep/inventory.generated.json
# The commit shown on /keep. The image build cannot see git: pass --build-arg TRELLIS_BUILD_COMMIT=<40-hex commit> (or set it as a
# service variable); without it the page says the build did not record a commit.
ARG TRELLIS_BUILD_COMMIT=""
ENV TRELLIS_BUILD_COMMIT=$TRELLIS_BUILD_COMMIT
# Public settings for /zkapi/. Pass as build arguments (or service variables); without them the page stays disabled.
ARG NEXT_PUBLIC_ZKAPI_ENABLED="false"
ARG NEXT_PUBLIC_ZKAPI_MANIFEST_URL=""
ARG NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256=""
ENV NEXT_PUBLIC_ZKAPI_ENABLED=$NEXT_PUBLIC_ZKAPI_ENABLED NEXT_PUBLIC_ZKAPI_MANIFEST_URL=$NEXT_PUBLIC_ZKAPI_MANIFEST_URL NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256=$NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256
COPY web/components ./components
COPY web/lib ./lib
COPY web/public ./public
# The protocol specification the /spec and /graft pages render (web/lib/graft-spec.js reads it at build time).
COPY spec /spec
# The build writes the installable app's service worker from the exported shell.
COPY web/scripts/build-pwa.mjs ./scripts/build-pwa.mjs
RUN pnpm build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# The full lockfile, not --production: src/solana/programs/idl.ts imports @anchor-lang/core at run time and package.json
# lists it under devDependencies, so a production-only install starts a router that cannot load its program clients.
# Once that package is moved to "dependencies", put --production back here to drop the test and build tools.
RUN bun install --frozen-lockfile --ignore-scripts --minimum-release-age 604800

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
ENV TRELLIS_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY config ./config
# What the one-off jobs of deploy/production run from this image: the gateway seeding and the env check.
COPY deploy/production/seed-gateway.ts deploy/production/check-env.ts ./deploy/production/
COPY --from=web /web/out ./web/out
# The commit of this build, shown at GET /api/v1/status. Pass --build-arg RELEASE_COMMIT=$(git rev-parse HEAD); a
# production router that runs against the deployed programs refuses to start without the full 40-character commit.
ARG RELEASE_COMMIT=""
ENV RELEASE_COMMIT=$RELEASE_COMMIT
USER bun
EXPOSE 8787
# Liveness of the API process. Workers override it with the heartbeat check (scripts/worker-healthcheck.sh); readiness
# (GET /ready) is for monitoring, not for restarts: a failing dependency must not block the deploy that fixes it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD bun -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The API by default; scripts/start.sh starts a worker instead when RUNTIME_ROLE=worker (see that file).
CMD ["sh", "scripts/start.sh"]
