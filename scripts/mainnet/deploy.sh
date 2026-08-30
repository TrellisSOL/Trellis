#!/bin/bash
# Deploy the Trellis programs of a launch tier to Solana mainnet-beta.
#
#   scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --tier credits --dry-run   preflight only: build, sizes, SOL, mints, parameters, simulation; sends nothing
#   scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --tier credits             preflight, typed confirmation, then deploy what is not yet deployed
#   scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --tier payments            later: on top of `credits` this deploys only trellis_anchor and trellis_tab
#   scripts/mainnet/deploy.sh --i-understand-this-is-mainnet trellis_tab                one program (to finish an interrupted run)
#   scripts/mainnet/deploy.sh --rehearsal [--yes] [--skip-idl]                          the same code against a local validator (scripts/mainnet/rehearse.sh)
#
#   --publish-idl               ALSO publish each program's IDL from this run. Off by default (see below): it runs a
#                               package fetched at that moment with the deployer keypair. --skip-idl says "no" explicitly.
#
#   --tier minimal|credits|payments|full, or --programs a,b,c   what this deployment has (scripts/mainnet/tiers.ts).
#                               Default: the tier of the deployments record, else `credits`. `minimal` deploys nothing.
#   --prebuilt <dir>            deploy the .so files of that directory (e.g. target/verifiable) instead of building. On
#                               mainnet the directory must carry the build manifest that binds them to the commit
#                               (scripts/mainnet/build.sh --verifiable writes it for the Docker build)
#   --allow-devnet-build        rehearsal only: accept binaries that report the `devnet` build profile (30 s timelock)
#   --allow-dirty               rehearsal only: run from a tree with uncommitted changes (or from a copy of the sources).
#                               Mainnet deploys from a clean tree at a commit, and records that commit per program.
#
# It refuses to run unless the mode flag is given AND the RPC reports the matching genesis hash (mainnet-beta:
# 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d); a rehearsal refuses every public cluster. Before anything is sent the
# preflight (scripts/mainnet/preflight.ts) prints every program's size, the exact rent and the fee estimate, the deployer
# balance, the USDC and $TRLS mints, every role key and every parameter init.ts will set, and the script stops for a
# typed confirmation that cannot be answered in advance on mainnet.
#
# Program addresses come from fresh keypairs in TRELLIS_MAINNET_KEYS_DIR (scripts/mainnet/keys.sh, which also explains
# why the devnet keypairs are never reused). `declare_id!` and Anchor.toml [programs.mainnet] must carry those ids and
# the programs must be rebuilt after the sync; the preflight checks the keypair against Anchor.toml, the built IDL and
# the id compiled into each .so, and refuses a devnet id.
#
# The build: the preflight compiles the tier's programs itself, with the default profile and a clean target directory
# (scripts/mainnet/build.sh), then asks each binary for its build_profile in an in-process SVM and refuses anything that is not
# the mainnet build. For a build explorers can show as "verified", make it with
# `scripts/mainnet/build.sh --tier <tier> --verifiable` (the Docker build of the commit, with the manifest that binds the
# binaries to it; binaries made by running `anchor build --verifiable` by hand carry no manifest and are refused on
# mainnet) and pass --prebuilt target/verifiable: it goes through the same checks. The sha256 of every deployed
# .so is written to the deployments record, and verify.ts compares the chain with those hashes.
#
# What this script guarantees about its own steps (security/REVIEW-ROUND3-2026-10.md R3-10, R3-21):
#   - nothing is written to the deployments record before the typed confirmation, and a program is recorded only after
#     its deploy was confirmed and its upgrade authority was READ from the chain (and is the deployer);
#   - a program that is ALREADY at its id is recorded only when its upgrade authority is the deployer or, after that
#     program's hand-over was recorded, the vault; under any other authority the run stops (R5-17);
#   - each binary is hashed again right before it is deployed and must still be the file the preflight read;
#   - every keypair file it hands to the CLI (the deployer, each program keypair) must be readable by its owner only;
#   - the RPC URL of MAINNET_RPC_URL reaches no command line and no output: the Solana CLI reads it from a private
#     temporary config file, and whatever the CLI prints is passed through a filter that removes it;
#   - the IDL is NOT published unless this run is told to (--publish-idl), and never with that URL. `anchor idl init`
#     (Anchor 1.2) runs `npx program-metadata --rpc <url>`: it puts the URL on a command line, and it downloads an npm
#     package at that moment and runs it with the path of the deployer keypair, the one key that holds every authority
#     until the hand-over (security/REVIEW-ROUND4-2026-10.md R4-29). This kit cannot pin what anchor fetches, so the
#     step is off by default and recorded as not published. With --publish-idl it runs only after a confirmation of
#     its own ("publish idl with the deployer key"), and on mainnet only when MAINNET_IDL_RPC_URL names an endpoint
#     WITHOUT a key (host only, e.g. the public endpoint), which is the URL that command line then shows;
#   - the record is not rewritten in silence (R3-21): a run whose deployer keypair is not the deployer the record names
#     is refused (the record says which key is "the operator"), and a run that finds everything deployed already asks
#     for a confirmation of its own before it rewrites the record's tier, build and source fields.
#
# Environment (config/mainnet.env.example; none of it is ever written to a tracked file):
#   MAINNET_RPC_URL            the RPC URL from your RPC provider. Environment only: there is no flag and no default.
#   MAINNET_IDL_RPC_URL        optional, with --publish-idl only: a mainnet RPC URL that carries NO key (https, a host and
#                              nothing else), used only for IDL publication. It is visible in the process list while
#                              the IDL is written.
#   MAINNET_DEPLOYER_KEYPAIR   path of the deployer keypair (0600). It pays, and it holds every authority until handover.ts.
#   TRELLIS_MAINNET_KEYS_DIR   program keypairs (default ~/.config/trellis/mainnet/program-keys)
#   COMPUTE_UNIT_PRICE         priority fee in micro-lamports per compute unit (default 5000)
#   PROGRAM_HEADROOM_BYTES     spare bytes reserved in each ProgramData account for later upgrades (default 0)
#   DEPLOY_USE_RPC=1           send write transactions through the RPC instead of the leaders' TPU ports
#   MAINNET_* role public keys read by the preflight and by init.ts
#
# Idempotent: a program that is already deployed is skipped and recorded. Each deployment is written to
# deployments/mainnet.json and nowhere else (TRELLIS_DEPLOYMENTS_FILE moves a rehearsal's record; on mainnet it is
# refused, R4-18): program id, signature, size, sha256, upgrade authority. The upgrade authority is the deployer
# until `bun scripts/mainnet/handover.ts` moves it to the Squads vault.
#
# Run `bun scripts/mainnet/init.ts` IMMEDIATELY after this script: each program's config is created by whoever calls
# its init instruction first.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/mainnet/source-state.sh
source scripts/mainnet/source-state.sh

MODE=""
ALLOW_DIRTY=0
DRY_RUN=0
YES=0
SKIP_IDL=0
PUBLISH_IDL=0
ONLY=""
PREFLIGHT_ARGS=()
# Options that take a value are handed to the preflight as they are.
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tier|--programs|--prebuilt|--role-float-sol|--spent-roots-per-day) [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }; PREFLIGHT_ARGS+=("$1" "$2"); shift 2 ;;
    --tier=*|--programs=*|--prebuilt=*|--role-float-sol=*|--spent-roots-per-day=*) PREFLIGHT_ARGS+=("$1"); shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
for arg in ${ARGS[@]+"${ARGS[@]}"}; do
  case "$arg" in
    --i-understand-this-is-mainnet) [ -z "$MODE" ] || { echo "pass one mode flag only" >&2; exit 2; }; MODE="mainnet"; PREFLIGHT_ARGS+=("$arg") ;;
    --rehearsal) [ -z "$MODE" ] || { echo "pass one mode flag only" >&2; exit 2; }; MODE="rehearsal"; PREFLIGHT_ARGS+=("$arg") ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --skip-idl) SKIP_IDL=1 ;;
    --publish-idl) PUBLISH_IDL=1 ;;
    --skip-id-embed-check|--allow-devnet-build) PREFLIGHT_ARGS+=("$arg") ;;
    --allow-dirty) ALLOW_DIRTY=1; PREFLIGHT_ARGS+=("$arg") ;;
    --help|-h) sed -n '2,75p' "$0"; exit 0 ;;
    --*) echo "unknown flag $arg" >&2; exit 2 ;;
    *) ONLY="$arg" ;;
  esac
done
if [ -z "$MODE" ]; then
  echo "Refusing to run: pass --i-understand-this-is-mainnet (the RPC must be mainnet-beta) or --rehearsal (a local validator)." >&2
  exit 2
fi
if [ "$MODE" = "mainnet" ] && [ "$YES" -eq 1 ]; then echo "--yes is not accepted on mainnet: the confirmation must be typed." >&2; exit 2; fi
if [ "$MODE" = "mainnet" ] && [ "$ALLOW_DIRTY" -eq 1 ]; then echo "--allow-dirty is for rehearsals only: mainnet deploys from a clean tree at a commit." >&2; exit 2; fi
if [ "$MODE" = "mainnet" ]; then
  # Rehearsal overrides that would point a mainnet deploy at other sources, other binaries or another record.
  for v in TRELLIS_SO_DIR TRELLIS_ROOT TRELLIS_DEPLOYMENTS_FILE; do
    [ -z "${!v:-}" ] || { echo "Refusing to run on mainnet: $v is set. It is a rehearsal override; unset it." >&2; exit 2; }
  done
fi
# The IDL: published only when this run asks for it (R4-29). Decided here, so that the preflight plans for the same thing.
IDL_DECISION="$(idl_decision "$PUBLISH_IDL" "$SKIP_IDL")" || exit 2
IDL_PUBLISH=0; IDL_WHY=""
if [ "$IDL_DECISION" = "publish" ]; then IDL_PUBLISH=1; else IDL_WHY="${IDL_DECISION#skip: }"; PREFLIGHT_ARGS+=(--skip-idl); fi

if [ "$MODE" = "mainnet" ]; then
  RPC="${MAINNET_RPC_URL:?MAINNET_RPC_URL is not set (environment only; from your RPC provider)}"
  WALLET="${MAINNET_DEPLOYER_KEYPAIR:?MAINNET_DEPLOYER_KEYPAIR is not set}"
  OUT="deployments/mainnet.json"
  EXPECT_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
else
  RPC="${REHEARSAL_RPC_URL:-http://127.0.0.1:8899}"
  WALLET="${REHEARSAL_DEPLOYER_KEYPAIR:?REHEARSAL_DEPLOYER_KEYPAIR is not set}"
  OUT="${TRELLIS_DEPLOYMENTS_FILE:-.data/mainnet-rehearsal/deployment.json}"
  EXPECT_GENESIS=""
  case "$RPC" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "A rehearsal only runs against a local validator (REHEARSAL_RPC_URL on 127.0.0.1 or localhost)." >&2; exit 2 ;; esac
fi
[ -f "$WALLET" ] || { echo "the deployer keypair file does not exist" >&2; exit 1; }
key_file_private "$WALLET" || exit 2
# Tools are checked after the key file, so a keypair other users can read is refused before anything else (R3-21).
for tool in jq solana solana-keygen bun; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH" >&2; exit 1; }; done
DEPLOYER="$(solana-keygen pubkey "$WALLET")"
CU_PRICE="${COMPUTE_UNIT_PRICE:-5000}"
HEADROOM="${PROGRAM_HEADROOM_BYTES:-0}"
# DEPLOY_USE_RPC=1 sends the write transactions through the RPC instead of straight to the leaders; some RPC providers
# need it. --no-auto-extend: this script never grows a program account by itself.
EXTRA=(--no-auto-extend)
if [ "${DEPLOY_USE_RPC:-0}" = "1" ]; then EXTRA+=(--use-rpc); fi

# The solana CLI reads the RPC URL and the fee payer from a private config file, so a keyed URL never appears in a
# process list or in this script's output.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
CFG="$WORK/cli.yml"
( umask 077; printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: "%s"\ncommitment: confirmed\n' "$RPC" "$WALLET" > "$CFG" )
# Whatever the CLI prints goes through this filter: an error that quotes the URL it could not reach names "[rpc url]"
# instead. The URL is handed to awk through the environment, never as an argument.
redact() { RPC_REDACT="$RPC" awk 'BEGIN { u = ENVIRON["RPC_REDACT"] } { while (length(u) && (i = index($0, u)) > 0) $0 = substr($0, 1, i - 1) "[rpc url]" substr($0, i + length(u)); print; fflush() }'; }
sol_cli() { solana -C "$CFG" "$@" 2> >(redact >&2) | redact; return "${PIPESTATUS[0]}"; }

# The cluster guard, in this shell as well as in the preflight: nothing below runs against the wrong chain.
GENESIS="$(sol_cli genesis-hash)"
if [ "$MODE" = "mainnet" ]; then
  [ "$GENESIS" = "$EXPECT_GENESIS" ] || { echo "Refusing to run: the RPC reports genesis hash $GENESIS, not mainnet-beta's $EXPECT_GENESIS." >&2; exit 2; }
else
  case "$GENESIS" in
    5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d|EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG|4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY)
      echo "Refusing to rehearse against a public cluster (genesis hash $GENESIS)." >&2; exit 2 ;;
  esac
fi

# The record says which key is the operator. Another keypair does not get to change that by running this script (R3-21).
# (Checked after the cluster guard, like everything below: a run against the wrong chain is refused for that reason first.)
[ ! -f "$OUT" ] || [ "$(jq -r .cluster "$OUT")" = "$MODE" ] || { echo "$OUT is not a $MODE record" >&2; exit 1; }
record_deployer_conflict "$OUT" "$DEPLOYER" || { echo "Refusing to run: nothing was sent and the record was not touched." >&2; exit 1; }

# The source this run deploys from: a clean tree at a commit. A rehearsal may say otherwise, explicitly. (Checked
# after the cluster guard, so that a run against the wrong chain is always refused for that reason first.)
SOURCE_ROOT="$(source_root)"
SOURCE_COMMIT="$(source_commit "$SOURCE_ROOT")"
SOURCE_TREE="clean"
SOURCE_REFUSAL="$(source_refusal "$SOURCE_ROOT")"
if [ -n "$SOURCE_REFUSAL" ]; then
  if [ "$ALLOW_DIRTY" -ne 1 ]; then
    echo "Refusing to deploy: $SOURCE_REFUSAL." >&2
    [ "$MODE" = "mainnet" ] || echo "(A rehearsal may pass --allow-dirty; a mainnet deploy may not.)" >&2
    exit 1
  fi
  SOURCE_TREE="dirty (rehearsal only)"
fi

PLAN="$WORK/plan.json"
bun scripts/mainnet/preflight.ts "${PREFLIGHT_ARGS[@]}" --headroom-bytes "$HEADROOM" --plan-out "$PLAN" || { rc=$?; [ "$rc" -eq 1 ] && echo "Preflight found blockers; nothing was sent." >&2; exit "$rc"; }
if [ "$DRY_RUN" -eq 1 ]; then echo "dry run: stopping after the preflight"; exit 0; fi

# Nothing is written to the record before the confirmation below (a run that stops there leaves no trace of a deploy
# that did not happen). `start_record` runs once, right after it.
record() { # record <jq filter> [--arg k v ...]
  local filter="$1"; shift
  local tmp; tmp="$(mktemp "$WORK/rec.XXXXXX")"
  jq "$@" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg dep "$DEPLOYER" "$filter | .updatedAt = \$now | .deployer = \$dep" "$OUT" > "$tmp" && cat "$tmp" > "$OUT"
}
start_record() {
  mkdir -p "$(dirname "$OUT")"
  if [ ! -f "$OUT" ]; then
    local network
    if [ "$MODE" = "mainnet" ]; then network="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; else network="solana:${GENESIS:0:32}"; fi
    jq -n --arg cluster "$MODE" --arg net "$network" --arg gen "$GENESIS" --arg dep "$DEPLOYER" '{cluster:$cluster, network:$net, genesisHash:$gen, deployer:$dep, programs:{}}' > "$OUT"
  fi
  # The commit and tree state of THIS run. Each program also carries the commit it was deployed from (below): a later
  # tier deployed from a later commit must not rewrite where an earlier program came from.
  record '.sourceCommit = $c | .sourceTree = $t' --arg c "${SOURCE_COMMIT:-unknown}" --arg t "$SOURCE_TREE"
  # The tier of everything selected so far (it grows, it never shrinks to a later, narrower --tier), the id reserved
  # for every program (deployed or not) and how the binaries were built and checked.
  record '.tier = $plan[0].recordTier | .selected = $plan[0].recordSelected | .reserved = $plan[0].reserved | .build = $plan[0].build' --slurpfile plan "$PLAN"
}

plan_field() { jq -r --arg p "$1" --arg f "$2" '.programs[] | select(.program == $p) | .[$f]' "$PLAN"; }
# The typed confirmation: the operator types the phrase exactly. --yes answers it in a rehearsal only (mainnet refused
# the flag above), and without a terminal there is nobody to type it.
typed_confirmation() { # typed_confirmation <phrase>: returns 0 when confirmed, 2 without a terminal, 3 on a mismatch
  local phrase="$1" answer
  if [ "$YES" -eq 1 ]; then echo "(rehearsal: confirmation \"$phrase\" skipped by --yes)"; return 0; fi
  [ -t 0 ] || { echo "No terminal attached: the confirmation must be typed by the operator. Nothing was sent." >&2; return 2; }
  printf '\nType exactly  %s  to continue (anything else aborts): ' "$phrase"
  read -r answer
  [ "$answer" = "$phrase" ] || { echo "Confirmation did not match. Nothing was sent." >&2; return 3; }
}
PENDING=()
while IFS= read -r name; do PENDING+=("$name"); done < <(jq -r '.programs[] | select(.deployed | not) | .program' "$PLAN")
ALL=()
while IFS= read -r name; do ALL+=("$name"); done < <(jq -r '.programs[].program' "$PLAN")
if [ -n "$ONLY" ]; then
  found=0; for p in "${ALL[@]}"; do [ "$p" = "$ONLY" ] && found=1; done
  [ "$found" -eq 1 ] || { echo "unknown program $ONLY" >&2; exit 2; }
  ALL=("$ONLY")
  kept=()
  if [ "${#PENDING[@]}" -gt 0 ]; then for p in "${PENDING[@]}"; do [ "$p" = "$ONLY" ] && kept+=("$p"); done; fi
  PENDING=()
  if [ "${#kept[@]}" -gt 0 ]; then PENDING=("${kept[@]}"); fi
fi

if [ "${#PENDING[@]}" -gt 0 ]; then
  PHRASE="deploy ${#PENDING[@]} programs to $MODE"
  echo
  echo "About to deploy: ${PENDING[*]}"
  echo "From commit ${SOURCE_COMMIT:-unknown} (tree: $SOURCE_TREE)."
  echo "Upgrade authority of each: $DEPLOYER (the deployer) until handover."
  typed_confirmation "$PHRASE" || exit $?
elif [ "${#ALL[@]}" -eq 0 ]; then
  echo; echo "This tier deploys no program. Nothing to send."
  echo "The router runs with LAUNCH_TIER=$(jq -r .routerTier "$PLAN") and ANCHOR_MODE=$(jq -r .anchorMode "$PLAN"); fund the role keys listed above."
  exit 0
else
  # Nothing to deploy. What is left is a rewrite of the record, and that is not done in silence (R3-21): the record is
  # what verify.ts, handover.ts and the monitor judge the chain against.
  echo; echo "Every requested program is already deployed; nothing will be sent to deploy. This run would rewrite the deployments record:"
  was() { if [ -f "$OUT" ]; then jq -r "$1 // \"not recorded\"" "$OUT" 2>/dev/null || echo "unreadable"; else echo "no record yet"; fi; }
  echo "  deployer (the operator key every role is judged against): $(was .deployer) -> $DEPLOYER"
  echo "  tier:                $(was .tier) -> $(jq -r .recordTier "$PLAN")"
  echo "  build:               $(was .build.kind) from $(was .build.dir) -> $(jq -r .build.kind "$PLAN") from $(jq -r .build.dir "$PLAN")"
  echo "  source commit, tree: $(was .sourceCommit), $(was .sourceTree) -> ${SOURCE_COMMIT:-unknown}, $SOURCE_TREE"
  echo "  and, for each of ${ALL[*]}: the upgrade authority the chain names now"
  echo "Nothing is rewritten without the typed confirmation: rewrite the $MODE record"
  typed_confirmation "rewrite the $MODE record" || exit $?
fi
start_record

# IDL publication happens only with --publish-idl, and never uses MAINNET_RPC_URL (see the header). The endpoint it may
# use carries no key.
IDL_RPC=""
if [ "$IDL_PUBLISH" -ne 1 ]; then :
elif [ "$MODE" = "rehearsal" ]; then IDL_RPC="$(printf 'http://%s' "$(bun -e 'console.log(new URL(process.env.REHEARSAL_RPC_URL ?? "http://127.0.0.1:8899").host)')")"
elif [ -z "${MAINNET_IDL_RPC_URL:-}" ]; then IDL_WHY="MAINNET_IDL_RPC_URL is not set: the IDL is not published with the keyed RPC URL"
else
  # https, a host and nothing else: no user info, no path, no query. A key in any of those would land on a command line.
  if IDL_HOST="$(U="$MAINNET_IDL_RPC_URL" bun -e 'const u = new URL(process.env.U); if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) process.exit(1); console.log(u.host);' 2>/dev/null)"; then
    IDL_RPC="https://$IDL_HOST"
    [ "$(solana genesis-hash -u "$IDL_RPC" 2>/dev/null)" = "$EXPECT_GENESIS" ] || { IDL_RPC=""; IDL_WHY="the endpoint in MAINNET_IDL_RPC_URL did not report mainnet-beta's genesis hash"; }
  else IDL_WHY="MAINNET_IDL_RPC_URL must be https with a host and nothing else (no path, no query, no user info): it will be visible on a command line"
  fi
fi
if [ "$IDL_PUBLISH" -eq 1 ] && [ -n "$IDL_RPC" ]; then
  # What --publish-idl does, said before it is done, and confirmed by itself.
  echo
  echo "--publish-idl: for each program, anchor fetches the npm package program-metadata NOW and runs it with the path of"
  echo "the deployer keypair ($DEPLOYER), which holds every authority until the hand-over. This kit cannot pin what is fetched."
  if ! typed_confirmation "publish idl with the deployer key"; then IDL_PUBLISH=0; IDL_WHY="--publish-idl was not confirmed"; fi
elif [ "$IDL_PUBLISH" -eq 1 ]; then IDL_PUBLISH=0
fi
[ -z "$IDL_WHY" ] || [ "$SKIP_IDL" -eq 1 ] || echo "IDLs will not be published by this run: $IDL_WHY."

publish_idl() { # publish_idl <program> <id>: tolerant of an IDL account that already exists
  local p="$1" id="$2" out status idl
  [ "$SKIP_IDL" -eq 1 ] && return 0
  if [ "$(jq -r --arg p "$p" '.programs[$p].idl.status // empty' "$OUT")" = "published" ]; then return 0; fi
  if [ "$IDL_PUBLISH" -ne 1 ] || [ -z "$IDL_RPC" ]; then record '.programs[$p].idl = {status:"not-published", at:$now, reason:$why}' --arg p "$p" --arg why "$IDL_WHY"; return 0; fi
  # Nothing below runs unless this run asked for publication (--publish-idl) and the operator confirmed it.
  [ "$IDL_PUBLISH" -eq 1 ] || return 0
  command -v anchor >/dev/null || { echo "  anchor is not on PATH; IDL for $p not published (rerun later)" >&2; return 0; }
  idl="$(plan_field "$p" idl)"
  echo "  publishing IDL for $p through $(printf '%s' "$IDL_RPC" | sed 's|^[a-z]*://||') (an endpoint without a key; anchor runs npx program-metadata with it)"
  # $IDL_RPC is the keyless endpoint checked above, never the URL of MAINNET_RPC_URL.
  if out="$(anchor idl init -f "$idl" "$id" --provider.cluster "$IDL_RPC" --provider.wallet "$WALLET" 2>&1)"; then
    status="published"
  elif echo "$out" | grep -qi "already in use\|already exists\|already initialized\|custom program error: 0x0"; then
    status="published"; echo "    IDL account already exists"
  else
    status="failed"; echo "  IDL publish failed for $p (rerun deploy.sh later; the program itself is deployed)" >&2
  fi
  record '.programs[$p].idl = {status:$s, at:$now}' --arg p "$p" --arg s "$status"
}

show_authority() { sol_cli program show "$1" --output json 2>/dev/null | jq -r '.authority // "none"'; }

for p in "${ALL[@]}"; do
  id="$(plan_field "$p" programId)"; so="$(plan_field "$p" so)"; kp="$(plan_field "$p" keypair)"
  bytes="$(plan_field "$p" bytes)"; sha="$(plan_field "$p" sha256)"; maxlen="$(plan_field "$p" maxLen)"
  hash="$(plan_field "$p" hash)"; profile="$(plan_field "$p" profile)"
  if sol_cli program show "$id" >/dev/null 2>&1; then
    echo "$p already deployed at $id"
    # A program found at its id is this deployment's only when its upgrade authority is the one expected there: the
    # deployer, or, once that program's hand-over is recorded, the vault. Anything else stops the run (R5-17: it used
    # to be recorded as deployed, and the run went on to the next program).
    auth="$(show_authority "$id")"
    deployed_authority_expected "$OUT" "$p" "$auth" "$DEPLOYER" || exit 1
    # Recorded as found: its id and the upgrade authority the chain names. Hashes and the commit stay as an earlier run
    # of this script wrote them; a program this script never deployed has none, and verify.ts says so.
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed", upgradeAuthority:$auth})' --arg p "$p" --arg id "$id" --arg auth "$auth"
    publish_idl "$p" "$id"
    continue
  fi
  # The program keypair signs this one deploy: it is a secret until then.
  key_file_private "$kp" || exit 2
  # Between the preflight and now: the file must still be the one that was simulated and whose hash the plan carries.
  binary_unchanged "$so" "$sha" || { echo "Nothing was sent for $p." >&2; exit 1; }
  echo "deploying $p -> $id ($bytes bytes, max_len $maxlen; binary unchanged since the preflight, sha256 $sha)"
  tmp="$(mktemp "$WORK/deploy.XXXXXX")"
  if sol_cli program deploy --program-id "$kp" "$so" --upgrade-authority "$WALLET" --max-len "$maxlen" \
      --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 200 "${EXTRA[@]}" --output json > "$tmp" 2> >(sed 's/^/    /' >&2); then
    sig="$(jq -r '.signature // empty' "$tmp" 2>/dev/null || true)"
    [ -n "$sig" ] || sig="$(sed -n 's/^Signature: //p' "$tmp" | head -1)"
    # The upgrade authority is READ from the ProgramData account, not assumed. Anything but the deployer stops the run.
    auth="$(show_authority "$id")"
    if [ "$auth" != "$DEPLOYER" ]; then
      echo "STOP: $p was deployed at $id, but the chain names $auth as its upgrade authority, not the deployer $DEPLOYER." >&2
      echo "Nothing was recorded for it. Do not initialise it; find out who holds that key before anything else." >&2
      exit 1
    fi
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed", deploySignature:$sig, deployedAt:$now, soBytes:($b|tonumber), soSha256:$sha, soHash:$hash, profile:$profile, maxLen:($m|tonumber), upgradeAuthority:$auth, sourceCommit:$commit, sourceTree:$tree, sourceKey:$plan[0].build.sourceKey, buildKind:$plan[0].build.kind})' \
      --arg p "$p" --arg id "$id" --arg sig "$sig" --arg b "$bytes" --arg sha "$sha" --arg hash "$hash" --arg profile "$profile" --arg m "$maxlen" --arg auth "$auth" --arg commit "${SOURCE_COMMIT:-unknown}" --arg tree "$SOURCE_TREE" --slurpfile plan "$PLAN"
    echo "  deployed; signature $sig; upgrade authority read from chain: $auth"
    sol_cli program show "$id" | sed 's/^/    /'
    publish_idl "$p" "$id"
  else
    echo "deploy of $p failed. Nothing is lost: the rent sits in a buffer account owned by the deployer." >&2
    echo "Rerun this script to resume, or recover the rent with: solana program close --buffers (same RPC and keypair)." >&2
    exit 1
  fi
done

echo
echo "deployed: $(jq -r '[.programs | to_entries[] | select(.value.status == "deployed") | .key] | join(" ")' "$OUT")"
echo "balance:  $(sol_cli balance)"
echo
if [ "$MODE" = "mainnet" ]; then FLAG="--i-understand-this-is-mainnet"; else FLAG="--rehearsal"; fi
echo "NEXT, NOW: bun scripts/mainnet/init.ts $FLAG"
echo "Only the upgrade authority (the deployer) can initialise a program; do it at once all the same, so nothing is deployed and unconfigured."
