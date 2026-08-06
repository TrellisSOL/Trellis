#!/usr/bin/env bash
# First start (and safe re-run) of the Trellis stack in this folder.
#
#   ./bootstrap.sh --init               create stack.env, .env.production and secrets/ from the templates (never overwrites), then stop
#   ./bootstrap.sh --generate-secrets   fill the EMPTY infrastructure secrets (database, Redis, APP_SECRET, ADMIN_TOKEN); prints nothing secret
#   ./bootstrap.sh --check              validate the compose file and every service's settings; start nothing
#   ./bootstrap.sh                      check, then: database, migrations, runtime role, gateway provider, API, workers, Caddy
#   options: --no-gateway               skip the attested gateway seeding
#            --declare "<source>"       pass the operator's retention declaration to seed-gateway.ts (see that file)
#            --profile <name>           also start a compose profile (slasher, makegood, monitoring); repeatable
#
# What it does, in order, and nothing else:
#   1. checks the files and their permissions (0600; secrets/ 0700)
#   2. docker compose config, then deploy/production/check-env.ts through the application image
#   3. starts PostgreSQL and Redis and waits for them (the database itself is created by the PostgreSQL image on first start)
#   4. runs the migrations as the database owner, then creates or updates the runtime role (data changes only)
#   5. registers the attested gateway provider (seed-gateway.ts: provider row, one attestor pass, catalogue)
#   6. starts the API, the workers and Caddy, waits for the API and prints the readiness checks by name
# It never generates or reads a signing key, never prints a secret, and is idempotent: every step can be repeated.
set -euo pipefail
cd "$(dirname "$0")"
umask 077

MODE="up"
GATEWAY=1
DECLARE=""
PROFILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --init) MODE="init" ;;
    --generate-secrets) MODE="generate" ;;
    --check) MODE="check" ;;
    --no-gateway) GATEWAY=0 ;;
    --declare) shift; DECLARE="${1:?--declare needs the source of the declaration}" ;;
    --profile) shift; PROFILES+=("${1:?--profile needs a name}") ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

if [ "$MODE" = "init" ]; then
  [ -f stack.env ] || { cp stack.env.example stack.env; echo "created stack.env"; }
  [ -f .env.production ] || { cp .env.production.example .env.production; echo "created .env.production"; }
  mkdir -p secrets
  for f in secrets.example/*.env; do t="secrets/$(basename "$f")"; [ -f "$t" ] || { cp "$f" "$t"; echo "created $t"; }; done
  chmod 700 secrets; chmod 600 stack.env .env.production secrets/*.env
  echo "Fill them in (README.md lists what each needs), then: ./bootstrap.sh --generate-secrets && ./bootstrap.sh --check"
  exit 0
fi

for f in stack.env .env.production; do [ -f "$f" ] || die "$f is missing: run ./bootstrap.sh --init"; done
for f in api settlement anchor tabs; do [ -f "secrets/$f.env" ] || die "secrets/$f.env is missing: run ./bootstrap.sh --init"; done

# Fill an empty KEY= line with a fresh random value; a value that is already set is left alone. Nothing is printed.
fill() { # fill <file> <KEY> <bytes>
  local file="$1" key="$2" bytes="$3" value tmp
  grep -q "^$key=" "$file" || die "$file has no $key= line"
  [ -z "$(sed -n "s/^$key=//p" "$file" | head -1)" ] || return 0
  value="$(openssl rand -hex "$bytes")"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k && !done { print k, v; done = 1; next } { print }' "$file" > "$tmp"
  cat "$tmp" > "$file"; rm -f "$tmp"
  echo "generated $key in $file"
}
if [ "$MODE" = "generate" ]; then
  command -v openssl >/dev/null || die "openssl is required to generate secrets"
  fill stack.env POSTGRES_PASSWORD 24
  fill stack.env RUNTIME_DB_PASSWORD 24
  fill stack.env REDIS_PASSWORD 24
  fill .env.production APP_SECRET 32
  fill .env.production ADMIN_TOKEN 24
  chmod 600 stack.env .env.production
  echo "Infrastructure secrets are set. Signing keys are yours to generate (MAINNET.md, key generation); this script never makes one."
  exit 0
fi

command -v docker >/dev/null || die "docker is required"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
dc() { docker compose --env-file stack.env "$@"; }

say "1. files and permissions"
bad=0
for f in stack.env .env.production secrets/*.env; do
  mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
  case "$mode" in 600|400) ;; *) echo "  $f has mode $mode; chmod 600 $f" >&2; bad=1 ;; esac
done
[ "$bad" -eq 0 ] || die "Fix the permissions above."
echo "  ok"

say "2. compose file and settings"
dc --profile '*' config -q
echo "  compose file is valid"
# The resolved configuration goes to the checker on standard input; it is never written to disk.
dc --profile '*' config --format json | dc --profile tools run --rm -T --no-deps env-check
if [ "$MODE" = "check" ]; then echo; echo "check only: nothing was started"; exit 0; fi

say "3. PostgreSQL and Redis"
dc up -d --wait postgres redis
echo "  both healthy"

say "4. migrations and the runtime database role"
dc run --rm migrate
dc run --rm runtime-role-grants
echo "  schema migrated; trellis_runtime can read and write data and cannot change the schema"

say "5. attested gateway provider"
gateway_url="$(sed -n 's/^PRIVATE_AI_BASE_URL=//p' .env.production | head -1)"
if [ "$GATEWAY" -eq 0 ]; then echo "  skipped (--no-gateway)"
elif [ -z "$gateway_url" ]; then echo "  skipped: PRIVATE_AI_BASE_URL is empty in .env.production. The SEALED lane has no supply until it is set and this script is run again."
else
  if [ -n "$DECLARE" ]; then dc --profile tools run --rm tools bun deploy/production/seed-gateway.ts --declare "$DECLARE"
  else dc --profile tools run --rm tools bun deploy/production/seed-gateway.ts; fi
fi

say "6. API, workers and Caddy"
profile_args=()
if [ "${#PROFILES[@]}" -gt 0 ]; then for p in "${PROFILES[@]}"; do profile_args+=(--profile "$p"); done; fi
dc ${profile_args[@]+"${profile_args[@]}"} up -d
for _ in $(seq 1 60); do
  if dc exec -T api bun -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 2
done
dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
echo
echo "readiness (GET /ready inside the API container; names and verdicts only):"
dc exec -T api bun -e "fetch('http://127.0.0.1:8787/ready').then(async r=>{const b=await r.json();console.log('  HTTP',r.status,'ok',b.ok);for(const [k,v] of Object.entries(b.checks||{}))console.log('  '+(v?'ok  ':'FAIL')+' '+k)}).catch(e=>{console.log('  the API did not answer');process.exit(1)})" || true
echo
echo "Next: point DNS at this host, open ports 80 and 443, then check from outside: bun scripts/monitor.ts https://<your domain>"
