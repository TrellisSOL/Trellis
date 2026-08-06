# The backup job of deploy/production (compose profile "backup"): pg_dump from PostgreSQL 16, age for encryption to
# public recipients, and bun for scripts/backup-offsite.ts, which uploads the archive, verifies it and records it for
# the backup_fresh readiness check. It also carries the restore and drill scripts, so a restore test runs from the same
# image (README.md, "Backups").
#
#   docker compose --env-file stack.env --profile backup build backup
#   docker compose --env-file stack.env --profile backup run --rm --no-deps backup
#
# Both base images are pinned by digest. pg_dump must be the server's major version or newer: keep POSTGRES_IMAGE on
# the major version of the POSTGRES_IMAGE in stack.env.
ARG POSTGRES_IMAGE=postgres:16.6@sha256:557fea37a744d5f4c8faab304b0a90858b53ab119735a88c131fd19dab802f36
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS bun

FROM ${POSTGRES_IMAGE}
# age encrypts the archive; perl provides shasum, which scripts/recovery-drill.sh calls.
RUN apt-get update && apt-get install -y --no-install-recommends age perl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
# The full lockfile, as in the application image: the restore drill loads the router's ledger code, which imports a
# package that package.json lists under devDependencies (see the note in the root Dockerfile).
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/backup-offsite.ts scripts/backup-db.sh scripts/restore-db.sh scripts/recovery-drill.sh scripts/recovery-drill.ts ./scripts/
# Debian already has a system user called "backup"; this job runs as its own unprivileged user.
RUN chmod +x scripts/*.sh && useradd --uid 10001 --create-home trellis-backup && mkdir -p /work && chown trellis-backup /work
USER trellis-backup
ENV TMPDIR=/work
ENTRYPOINT []
CMD ["bun", "--no-env-file", "scripts/backup-offsite.ts"]
