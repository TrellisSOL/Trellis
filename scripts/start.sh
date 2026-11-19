#!/bin/sh
# The image's default command: start what this container is, by its RUNTIME_ROLE (the API process, or a worker with the
# jobs of its WORKER_JOBS). The compose stacks name a command per service and never reach this; a platform that runs
# the one image as several services with nothing but variables to tell them apart starts every service here.
#
# Two steps run first, each only for the service that was given the settings for it:
#   - MIGRATION_DATABASE_URL (the schema owner's URL) and RUNTIME_DB_PASSWORD: the migration job, then the restricted
#     runtime role (scripts/runtime-role.ts). A production router does not migrate by itself (AUTO_MIGRATE=false)
#     and connects as that restricted role (its DATABASE_URL), never as the owner. Both settings are removed from the
#     environment before the service starts, so the running process cannot use them.
#   - UPSTREAM_API_KEY and UPSTREAM_BASE_URL, on a worker: register the upstream provider and import its catalogue
#     (scripts/init-upstream.ts stores the key encrypted with APP_SECRET and prints no secret). A failure is reported
#     and the worker still starts: the provider-registry job refreshes a catalogue that is already there.
set -eu
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
  DATABASE_URL="$MIGRATION_DATABASE_URL" bun scripts/migrate.ts
  DATABASE_URL="$MIGRATION_DATABASE_URL" bun scripts/runtime-role.ts
fi
unset MIGRATION_DATABASE_URL RUNTIME_DB_PASSWORD
case "${RUNTIME_ROLE:-api}" in
  api) exec bun src/index.ts ;;
  worker)
    if [ -n "${UPSTREAM_API_KEY:-}" ] && [ -n "${UPSTREAM_BASE_URL:-}" ]; then
      bun scripts/init-upstream.ts || echo "start: the upstream provider could not be registered now; the worker starts without it" >&2
    fi
    exec bun src/worker.ts ;;
  *) echo "RUNTIME_ROLE must be api or worker here (it is '${RUNTIME_ROLE}')." >&2; exit 2 ;;
esac
