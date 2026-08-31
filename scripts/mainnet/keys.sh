#!/bin/bash
# Program keypairs for mainnet, and the id sync a mainnet build needs.
#
#   scripts/mainnet/keys.sh             generate the missing program keypairs (never overwrites one) and list the ids
#   scripts/mainnet/keys.sh --check     compare the keypairs with declare_id! and Anchor.toml [programs.mainnet]; exit 1 on any difference
#   scripts/mainnet/keys.sh --apply     write the ids into programs/*/src/lib.rs (declare_id!) and Anchor.toml [programs.mainnet]
#   scripts/mainnet/keys.sh --tier credits    (or --programs a,b,c) with any of the above: also say which ids this tier deploys
#
# Launch tiers (scripts/mainnet/tiers.ts): a tier deploys only some of the eight programs, but this script always makes
# and syncs ALL EIGHT ids. An id costs nothing until its program is deployed, and the programs name each other:
# trellis_tab's config holds trellis_rules' id, trellis_bond's config holds a PDA of trellis_capacity, and
# trellis_capacity compiles in trellis_bond's id. Reserving every id now means a later tier lands exactly where the
# earlier ones already point, with no rebuild of what is deployed.
#
# The keypairs live outside the repository, in TRELLIS_MAINNET_KEYS_DIR (default ~/.config/trellis/mainnet/program-keys,
# directory 0700, files 0600). A program keypair signs exactly once, for the first deploy of its address; after that the
# upgrade authority governs the program and the keypair has no power. Keep the directory until every program is deployed
# and verified, then move it to offline storage with the other deployment records.
#
# Why mainnet never reuses the devnet program keypairs (target/deploy/*-keypair.json):
#   1. Whoever holds a program keypair before the first deploy can deploy anything at that address. The devnet keypairs
#      have sat unencrypted in a build directory on development machines and were read by build tools, test runs and CI
#      caches; their addresses are public in Anchor.toml and deployments/devnet.json. On mainnet that would let a third
#      party who obtained one put its own program, with its own upgrade authority, at the address the router is about to
#      trust with customer USDC.
#   2. Different addresses per cluster make a cluster mix-up fail closed. With shared ids a router pointed at the wrong
#      RPC, or a devnet env file used against mainnet, keeps "working"; with separate ids every instruction fails.
#   3. `declare_id!` is compiled into each program, and trellis_capacity also compiles in trellis_bond's id. An id is
#      therefore a property of a build: the mainnet build is its own build, with its own verifiable hash.
#
# The id sync changes tracked source (eight declare_id! lines and one Anchor.toml section). The tests and the devnet
# deployment pin the localnet/devnet ids, so do it on a release branch, not on main:
#
#   git switch -c mainnet-release            # from the commit you intend to ship
#   scripts/mainnet/keys.sh                  # once: generate the keypairs
#   scripts/mainnet/keys.sh --apply          # declare_id! and [programs.mainnet]
#   git diff --stat                          # exactly programs/*/src/lib.rs (one line each) and Anchor.toml
#   git commit -am "Mainnet program ids"     # the commit a verifiable build is made from, and the one explorers verify
#   scripts/mainnet/build.sh --tier credits --verifiable   # the Docker build of that commit -> target/verifiable/*.so and
#                                                          # the build.json that binds them to it (mainnet refuses a
#                                                          # verifiable build without one: R4-16, R5-17). Optional:
#                                                          # the preflight makes its own, non-Docker build otherwise.
#   scripts/mainnet/keys.sh --check
#
# The router does not need the rebuilt IDLs: src/solana/idl/*.json differ from them only in `address`, and the router
# takes every program id from TRELLIS_*_PROGRAM_ID.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROOT="${TRELLIS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
KEYS_DIR="${TRELLIS_MAINNET_KEYS_DIR:-$HOME/.config/trellis/mainnet/program-keys}"
PROGRAMS=(trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements)
MODE="generate"
ALLOW_MAIN=0
TIER=""; TIER_PROGRAMS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    --allow-main) ALLOW_MAIN=1; shift ;;
    --tier) TIER="${2:?--tier needs a value}"; shift 2 ;;
    --tier=*) TIER="${1#--tier=}"; shift ;;
    --programs) TIER_PROGRAMS="${2:?--programs needs a value}"; shift 2 ;;
    --programs=*) TIER_PROGRAMS="${1#--programs=}"; shift ;;
    --help|-h) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
# Which programs the tier deploys (for the listing only: every id is made and synced whatever the tier).
case "$TIER" in
  "") DEPLOYS="${TIER_PROGRAMS:-}" ;;
  minimal) DEPLOYS="none" ;;
  credits) DEPLOYS="trellis_credits" ;;
  payments) DEPLOYS="trellis_credits,trellis_anchor,trellis_tab" ;;
  full) DEPLOYS="all" ;;
  *) echo "unknown tier $TIER (minimal, credits, payments, full)" >&2; exit 2 ;;
esac
deploys() { # deploys <program>: "deploy", "reserved" or "" when no tier was named
  [ -n "$DEPLOYS" ] || { echo ""; return; }
  [ "$DEPLOYS" = "all" ] && { echo "deploy"; return; }
  case ",$DEPLOYS," in *",$1,"*|*",${1#trellis_},"*) echo "deploy" ;; *) echo "reserved" ;; esac
}
command -v solana-keygen >/dev/null || { echo "solana-keygen is not on PATH" >&2; exit 1; }
for p in "${PROGRAMS[@]}"; do [ -f "$ROOT/programs/$p/src/lib.rs" ] || { echo "programs/$p/src/lib.rs is missing under $ROOT" >&2; exit 1; }; done

declared_id() { sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");.*/\1/p' "$ROOT/programs/$1/src/lib.rs" | head -1; }
toml_id() { # toml_id <section> <program>
  awk -v section="[programs.$1]" -v key="$2" '
    /^\[/ { inside = ($0 == section) }
    inside && $1 == key { gsub(/"/, "", $3); print $3; exit }' "$ROOT/Anchor.toml"
}
key_id() { solana-keygen pubkey "$KEYS_DIR/$1-keypair.json"; }

if [ "$MODE" = "generate" ]; then
  umask 077
  mkdir -p "$KEYS_DIR"
  chmod 700 "$KEYS_DIR"
  for p in "${PROGRAMS[@]}"; do
    f="$KEYS_DIR/$p-keypair.json"
    if [ -f "$f" ]; then continue; fi
    # --no-bip39-passphrase: a program keypair is used once and kept as a file; there is no seed phrase to write down.
    solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
    chmod 600 "$f"
    echo "generated $p"
  done
fi

missing=0
for p in "${PROGRAMS[@]}"; do [ -f "$KEYS_DIR/$p-keypair.json" ] || { echo "no keypair for $p in the keys directory (run scripts/mainnet/keys.sh)" >&2; missing=1; }; done
[ "$missing" -eq 0 ] || exit 1

# A program keypair is a secret until its program is deployed: a file that others can read is not used (R3-21).
# shellcheck source=scripts/mainnet/source-state.sh
source "$(dirname "$0")/source-state.sh"
loose=0
for p in "${PROGRAMS[@]}"; do key_file_private "$KEYS_DIR/$p-keypair.json" || loose=1; done
[ "$loose" -eq 0 ] || exit 1

# A mainnet id must differ from every localnet/devnet id.
reused=0
for p in "${PROGRAMS[@]}"; do
  id="$(key_id "$p")"
  for section in localnet devnet; do
    if [ "$id" = "$(toml_id "$section" "$p")" ]; then echo "$p: the keypair in the keys directory is the $section keypair; mainnet needs a fresh one" >&2; reused=1; fi
  done
done
[ "$reused" -eq 0 ] || exit 1

if [ "$MODE" = "apply" ]; then
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [ "$branch" = "main" ] && [ "$ALLOW_MAIN" -ne 1 ]; then
    echo "Refusing to write mainnet ids on branch main: the tests and devnet pin the current ids. Create a release branch (git switch -c mainnet-release), or pass --allow-main." >&2
    exit 1
  fi
  if [ -n "$(git -C "$ROOT" status --porcelain -- programs Anchor.toml 2>/dev/null)" ]; then
    echo "Refusing to write: programs/ or Anchor.toml has uncommitted changes. Commit or stash them so the id sync is its own reviewable diff." >&2
    exit 1
  fi
  for p in "${PROGRAMS[@]}"; do
    id="$(key_id "$p")"
    ID="$id" perl -0pi -e 's/^declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\);/declare_id!("$ENV{ID}");/m or die "no declare_id! line\n"' "$ROOT/programs/$p/src/lib.rs"
  done
  # Rewrite [programs.mainnet]: drop an existing section, then insert the new one before [provider].
  block="[programs.mainnet]"$'\n'
  for p in "${PROGRAMS[@]}"; do block+="$p = \"$(key_id "$p")\""$'\n'; done
  BLOCK="$block" perl -0pi -e '
    s/^\[programs\.mainnet\]\n(?:(?!\[).*\n)*\n?//m;
    s/^\[provider\]/$ENV{BLOCK}\n[provider]/m or die "Anchor.toml has no [provider] section\n"' "$ROOT/Anchor.toml"
  echo "wrote declare_id! for ${#PROGRAMS[@]} programs and Anchor.toml [programs.mainnet]"
  echo "next: review git diff, commit, then scripts/mainnet/deploy.sh ... --dry-run (the preflight builds the commit itself). For the Docker build explorers verify: scripts/mainnet/build.sh --tier <tier> --verifiable, then --prebuilt target/verifiable."
fi

status=0
printf '%-22s %-45s %-10s %-12s %s\n' "program" "mainnet program id" "declare_id" "Anchor.toml" "${DEPLOYS:+in this tier}"
for p in "${PROGRAMS[@]}"; do
  id="$(key_id "$p")"
  d="differs"; [ "$(declared_id "$p")" = "$id" ] && d="synced"
  t="differs"; [ "$(toml_id mainnet "$p")" = "$id" ] && t="synced"
  printf '%-22s %-45s %-10s %-12s %s\n' "$p" "$id" "$d" "$t" "$(deploys "$p")"
  if [ "$d" != "synced" ] || [ "$t" != "synced" ]; then status=1; fi
done
if [ "$MODE" = "check" ]; then
  [ "$status" -eq 0 ] && echo "ids are synced" || echo "ids are NOT synced: scripts/mainnet/keys.sh --apply, then rebuild" >&2
  exit "$status"
fi
if [ "$MODE" = "generate" ] && [ "$status" -ne 0 ]; then echo "next: scripts/mainnet/keys.sh --apply (on a release branch), commit, then the preflight (scripts/mainnet/deploy.sh ... --dry-run builds the commit itself; scripts/mainnet/build.sh --tier <tier> --verifiable makes the Docker build)"; fi
exit 0
