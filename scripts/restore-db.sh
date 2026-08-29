#!/usr/bin/env bash
# Restore only to an explicitly selected empty database; never overwrites an existing schema.
set -euo pipefail
umask 077
: "${PGDATABASE:?Select a fresh isolated database explicitly}"
: "${RESTORE_ACK:?Set RESTORE_ACK=isolated-empty-database after verifying the target}"
[ "$RESTORE_ACK" = isolated-empty-database ] || exit 2
: "${AGE_IDENTITY_FILE:?Provide the approved recovery identity path through the secret manager}"
input=${1:?usage: restore-db.sh /private/path/backup.dump.age}
# Authenticate the complete encrypted stream before giving any bytes to pg_restore.
# A pipeline can let pg_restore commit before age reports a late authentication failure.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age -d -i "$AGE_IDENTITY_FILE" "$input" > "$work/snapshot.dump"
pg_restore --list "$work/snapshot.dump" >/dev/null
count=$(psql -X -At -v ON_ERROR_STOP=1 -c "
  select
    (select count(*) from pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema')) +
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') +
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') +
    (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')")
[ "$count" = 0 ] || { echo 'Refusing to restore into a nonempty database.' >&2; exit 1; }
pg_restore --dbname="$PGDATABASE" --no-owner --no-acl --exit-on-error --single-transaction "$work/snapshot.dump"
# Security review R5-08: a restored database is behind the chain. Freeze every vault outflow before any worker can
# start on it; only scripts/restore-reconcile.ts --apply clears this (src/services/settlement.ts, "After a database
# restore"). An existing freeze is kept as it is.
psql -X -v ON_ERROR_STOP=1 -c "
  insert into kv (key, value) values ('restore_state', jsonb_build_object('frozen', true, 'since', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'reason', 'restored from a backup (scripts/restore-db.sh)'))
  on conflict (key) do update set value = excluded.value where coalesce((kv.value->>'frozen')::boolean, false) = false" >/dev/null
echo 'Restored, and vault outflows are FROZEN (kv restore_state). Keep workers/ingress off; run: bun scripts/restore-reconcile.ts (dry run), then --apply. See MAINNET.md, "The database is lost".'
