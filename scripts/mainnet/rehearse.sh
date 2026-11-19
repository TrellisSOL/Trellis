#!/bin/bash
# Rehearse the whole mainnet procedure against throwaway local validators: preflight (with its own clean build and the
# in-process simulation), deploy, init, verify, both phases of the hand-over, the after-hand-over verify with the
# production-guard report, and the refusals that must happen. Nothing here can reach a public cluster: the scripts run
# with --rehearsal, which accepts a loopback RPC only and refuses the genesis hash of mainnet-beta, devnet and testnet.
#
#   scripts/mainnet/rehearse.sh
#   REHEARSAL_PORT=8911 scripts/mainnet/rehearse.sh
#   REHEARSAL_ONLY=1 scripts/mainnet/rehearse.sh        part 1 only (2: part 2 only)
#
# Two parts, each on a validator of its own, because a real validator's clock cannot be moved:
#
#   PART 1  the MAINNET build (default profile, 24 h timelock), the recommended launch: tier `credits`, then `payments`
#           added on top. The preflight builds the programs itself in a clean target directory and reads each binary's
#           build_profile; deploy, init, verify (which reads build_profile of EVERY deployed program ON CHAIN: profile 0
#           and the mainnet floors); the guardian key pauses, is refused a second pause by the program (cooldown) and the
#           authority renews and unpauses; the settlement key commits a spent root and pays an unknown account, and the
#           monitor reports both from the program's event logs; the hand-over is PROPOSED, its status says 24 hours and
#           7 days, the guardian's cancellation is refused by the program, resolving is refused, and the operator
#           cancels. Tier `minimal` is preflighted.
#   PART 2  the hand-over END TO END, tier `full`, on `devnet`-feature binaries (target/deploy-devnet: 30 s timelock,
#           60 s pause), which the kit accepts only in a rehearsal and only with --allow-devnet-build: every one of the
#           eight says "profile 1" itself. A pause is left to lapse (60 s) and the monitor says so before and after;
#           propose, wait 30 s, resolve as the vault with the operator co-signing, check, verify at the multisig stage,
#           the router's production guard, the monitor. The same steps on the mainnet build, with the clock moved 24
#           hours, 72 hours and 7 days, are tests/mainnet-handover.ts (in-process SVM, run by `anchor test`); the
#           preflight runs them too. A proposal EXPIRING is shown only there: a validator's clock cannot be moved.
#
# What the rehearsal does NOT cover (say so in any report of it):
#   - the real Squads program. The vault signs through scripts/mainnet/rehearsal-vault, a stand-in loaded at the Squads
#     program id that applies Squads' signer rule (the vault signs by CPI, any other signer must sign the outer
#     transaction) and nothing else: no members, votes or time lock. The multisig account is hand-encoded;
#   - the fresh mainnet program ids (scripts/mainnet/rehearse-fresh-ids.sh does that), the Docker verifiable build,
#     IDL publication (the Program Metadata program is not on a bare local validator), real fees, hardware wallets and
#     the typed confirmations (a rehearsal passes --yes; on mainnet that flag is refused, which is checked here).
# The third security pass (security/REVIEW-ROUND3-2026-10.md) added, with every refusal asserted:
#   R3-08  a selection narrower than what is deployed: in part 2 `credits` is handed over first, the other seven programs
#          are deployed afterwards with --tier, and with MAINNET_TIER=credits `handover.ts check` and `verify.ts --expect
#          multisig` refuse and write no report; `--tier minimal` over a deployed credits program refuses in part 1
#   R3-09  the multisig account is judged every time: threshold 1, a config authority, an extra member, a member without
#          the vote permission, another owner, a missing member list, a time lock below the configured minimum are each
#          refused; part 2's multisig has never created a transaction, so its hand-over runs with --multisig-untested-ok,
#          which is recorded and makes neither `check` nor the report a plain pass
#   R3-10  a dirty tree is refused by build.sh and deploy.sh (a throwaway git tree is made dirty to show it; the
#          rehearsal itself runs from a snapshot of the sources and says so with --allow-dirty); verify re-hashes the
#          build of that snapshot and fails when the chain differs from it or no build is there
#   R3-11  a guardian from the environment that differs from the chain is refused; --set-guardian replaces it, visibly
#   R3-20  verify fails while a proposal is pending
#   R3-21  deploy.sh writes no record before the confirmation and reads the upgrade authority from the chain; init.ts
#          refuses a role that differs from the environment and leaves the record alone; pause.ts does not fall back to
#          the deployer key and fails when nothing was paused; a keypair file others can read is refused; MAINNET_ANCHORER
#          is required; anchorer-rotate.ts refuses to print a history that drops earlier keys
# The fourth security pass (security/REVIEW-ROUND4-2026-10.md) added, again with every refusal asserted:
#   R4-16  the rehearsal's source is committed to a throwaway git tree and built from an EXPORT of that commit
#          (build.sh's clean path): the binary is byte for byte the one that was deployed, verify establishes source
#          equivalence from it WITHOUT --allow-dirty (the manifest binds binary, commit and chain), and refuses a
#          skip-worktree edit, a source file hidden by an exclude rule, and the deployed binary lying in
#          target/verifiable of a later commit with no manifest
#   R4-17  in part 2, after credits was handed over and seven programs were added on the operator key, verify fails
#          with or without --expect and writes no report
#   R4-18  mainnet refuses TRELLIS_DEPLOYMENTS_FILE; a copy of the record that does not name a deployed program hides
#          nothing from `check` and verify
#   R4-29  a multisig that created a transaction and executed none, and one whose member is the guardian key, are
#          refused; --multisig-untested-ok is refused on mainnet at propose; lamports sent to a program's
#          pending-proposal address stop neither verify nor the next proposal; --publish-idl with --skip-idl is refused
#   R3-21  (residual) deploy.sh with another deployer keypair, or with nothing to deploy and no terminal, leaves the
#          record byte for byte;   R3-11 (residual) init.ts names each role address and has each confirmed
# The fifth security pass (security/REVIEW-ROUND5-2026-10.md) added, each action dry-run first, then sent, then read back:
#   R5-16  every action of MAINNET.md's incident section, from a normal checkout (pause.ts, config-change.ts and
#          anchorer-rotate.ts run without the rehearsal's source root and act at the RECORDED program id; in
#          rehearse-fresh-ids.sh this working tree declares other ids than the deployed ones, and verify.ts is shown to
#          still refuse from it). Part 1, by the operator key on the mainnet build: the authority pauses, renews and
#          unpauses; a new settlement key and the write-down are proposed (24 h), read by handover.ts and the monitor,
#          refused before the timelock and under another name, and cancelled; a record with another program id, and a
#          --program-id that disagrees with the record, are refused. Part 2, on the 30-second build: a made-up spent
#          root is written down and the outflow cap is clamped at once and restored by proposal and apply (operator
#          key); after the hand-over the VAULT proposes, cancels, proposes again and applies a new settlement key and a
#          new guardian (printed for a Squads proposal, executed through the stand-in), the record follows, and the old
#          guardian can no longer pause
#   R5-17  a multisig with no time lock is refused (the fixture's multisig has one hour); the anchorer rotation reads its
#          keys from files and refuses one in the environment; deploy.sh stops at a program it finds under an upgrade
#          authority that is neither the deployer nor the recorded vault
# The mainnet rule the rehearsal cannot meet on purpose: mainnet runs from a clean tree at a commit. A rehearsal runs
# from a snapshot of the program sources taken when it starts (so that edits made while it runs cannot change what was
# deployed under it), which is not a git tree; every build, deploy and verify here therefore passes --allow-dirty,
# which mainnet refuses, and what they write says "dirty (rehearsal only)".
# State and keys go to the gitignored .data/mainnet-rehearsal/ and are deleted at the start of each run.
set -euo pipefail
# The rehearsal walks every tier, so it runs with every release switch on (src/features.json, UPDATES.md): a router
# guard that is asked about tier credits or full must not stop at a switch that is off on main.
export FEATURES=all
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."
PORT="${REHEARSAL_PORT:-8911}"
FAUCET_PORT=$((PORT + 900))
export REHEARSAL_RPC_URL="http://127.0.0.1:$PORT"
DIR=".data/mainnet-rehearsal"
if (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then echo "port $PORT is in use; set REHEARSAL_PORT" >&2; exit 1; fi
rm -rf "$DIR"
mkdir -p "$DIR/keys"
export TRELLIS_DEPLOYMENTS_FILE="$PWD/$DIR/deployment.json"
# By default the working tree at its localnet ids. scripts/mainnet/rehearse-fresh-ids.sh points these at a copy of the
# sources with freshly generated ids: its program keypairs, its source root (what the preflight builds) and its
# devnet-feature binaries.
export TRELLIS_MAINNET_KEYS_DIR="${REHEARSAL_KEYS_DIR:-$PWD/target/deploy}"
DEVNET_SO_DIR="${REHEARSAL_DEVNET_SO_DIR:-$PWD/target/deploy-devnet}"
unset MAINNET_RPC_URL MAINNET_DEPLOYER_KEYPAIR TRELLIS_SO_DIR MAINNET_TIER MAINNET_PROGRAMS MAINNET_MULTISIG_THRESHOLD MAINNET_MULTISIG_MIN_TIME_LOCK MAINNET_MULTISIG_VAULT_INDEX MAINNET_IDL_RPC_URL || true
ONLY="${REHEARSAL_ONLY:-}"
ALL=(trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements)

# The devnet-feature binaries of part 2 (scripts/devnet/build.sh), built when missing or older than the sources.
if [ -z "${REHEARSAL_DEVNET_SO_DIR:-}" ] && [ "$ONLY" != "1" ]; then
  stale=0
  for p in "${ALL[@]}"; do
    so="target/deploy-devnet/$p.so"
    if [ ! -f "$so" ] || [ -n "$(find "programs/$p" Cargo.toml -newer "$so" \( -name '*.rs' -o -name 'Cargo.toml' \) -print -quit)" ]; then stale=1; fi
  done
  if [ "$stale" -eq 1 ]; then echo "building the devnet-feature programs for part 2 (scripts/devnet/build.sh)"; scripts/devnet/build.sh >/dev/null; fi
fi
VAULT_SO="$(scripts/mainnet/rehearsal-vault.sh)"

eval "$(bun scripts/mainnet/rehearsal-fixtures.ts "$PWD/$DIR/keys")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trellis-rehearsal.XXXXXX")"
# The source the rehearsal builds from: a snapshot of the program sources as they are now (or the copy that
# rehearse-fresh-ids.sh made). Whatever is edited in the working tree while this runs, every build and every
# "is the chain a build of this source" check below is about one and the same source.
if [ -n "${REHEARSAL_ROOT:-}" ]; then export TRELLIS_ROOT="$REHEARSAL_ROOT"; else
  mkdir -p "$WORK/source"
  cp -R programs Cargo.toml Cargo.lock Anchor.toml "$WORK/source/"
  export TRELLIS_ROOT="$WORK/source"
fi
# Likewise the devnet-feature binaries of part 2: the files as they are now.
if [ "$ONLY" != "1" ]; then mkdir -p "$WORK/devnet-so"; cp "$DEVNET_SO_DIR"/*.so "$WORK/devnet-so/"; DEVNET_SO_DIR="$WORK/devnet-so"; fi
# A snapshot is not a git tree, so no commit names it: the rehearsal says so wherever mainnet would require a clean tree.
A=(--allow-dirty)
# Commands that claim mainnet run without the rehearsal's overrides (its source root, its record file), which mainnet
# refuses by itself (asserted below).
M=(env -u TRELLIS_ROOT -u TRELLIS_DEPLOYMENTS_FILE)
# The incident scripts (pause.ts, config-change.ts) run "from a normal checkout" (R5-16): without the rehearsal's source
# root, so that the tree they see is this working tree, whatever ids it declares. In rehearse-fresh-ids.sh the deployed
# ids are fresh ones that no file of this tree names: there the scripts can only find the programs through the record.
NC=(env -u TRELLIS_ROOT)
CC=("${NC[@]}" bun scripts/mainnet/config-change.ts)
VPID=""
stop_validator() { if [ -n "$VPID" ]; then kill "$VPID" 2>/dev/null || true; wait "$VPID" 2>/dev/null || true; VPID=""; fi; }
cleanup() { stop_validator; rm -rf "$WORK"; }
trap cleanup EXIT
start_validator() { # start_validator <name> [accounts...]: a fresh chain with the USDC and $TRLS mints, the multisig accounts and the stand-in vault program
  local name="$1"; shift
  local accounts=("$@")
  [ "${#accounts[@]}" -gt 0 ] || accounts=("${VALIDATOR_ACCOUNTS[@]}")
  set -- "$name"
  stop_validator
  rm -rf "$WORK/ledger-$1" "$PWD/$DIR"/deployment*.json
  # Ports of its own for gossip and the dynamic range too, so another local validator (the chain tests, on 8899) can run beside it.
  solana-test-validator --reset --quiet --rpc-port "$PORT" --faucet-port "$FAUCET_PORT" --gossip-port $((PORT + 2000)) --dynamic-port-range "$((PORT + 2100))-$((PORT + 2200))" --ledger "$WORK/ledger-$1" "${accounts[@]}" --bpf-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf "$VAULT_SO" > "$WORK/validator-$1.log" 2>&1 &
  VPID=$!
  for _ in $(seq 1 90); do solana cluster-version -u "$REHEARSAL_RPC_URL" >/dev/null 2>&1 && break; sleep 1; done
  solana cluster-version -u "$REHEARSAL_RPC_URL" >/dev/null 2>&1 || { echo "the local validator did not come up" >&2; tail -20 "$WORK/validator-$1.log" >&2 || true; exit 1; }
}
fund() { solana airdrop "$2" "$1" -u "$REHEARSAL_RPC_URL" >/dev/null; }

step() { printf '\n==================== %s ====================\n' "$*"; }
expect_refusal() { # expect_refusal <description> <command...>: the command must exit non-zero
  local what="$1"; shift
  if "$@" > "$WORK/refusal.log" 2>&1; then echo "FAIL: $what was NOT refused" >&2; cat "$WORK/refusal.log" >&2; exit 1; fi
  echo "refused as required: $what"
  sed -n '1,2p' "$WORK/refusal.log" | sed 's/^/    /'
}
said() { grep -q -- "$1" "$WORK/refusal.log" || { echo "FAIL: the refusal did not say: $1" >&2; cat "$WORK/refusal.log" >&2; exit 1; }; }
# How many transactions the chain knows for an address (a dry run must leave that number alone).
tx_count() { A="$1" bun -e 'import { Connection, PublicKey } from "@solana/web3.js"; const c = new Connection(process.env.REHEARSAL_RPC_URL, "confirmed"); console.log((await c.getSignaturesForAddress(new PublicKey(process.env.A))).length);'; }
# What trellis_credits holds on chain, read by `config-change.ts status` from a normal checkout: one line per field.
cc_status() { "${CC[@]}" status --rehearsal > "$WORK/cc-status.log" || { cat "$WORK/cc-status.log" >&2; echo "FAIL: config-change.ts status did not read the chain" >&2; exit 1; }; }
cc_shows() { cc_status; grep -q -- "$1" "$WORK/cc-status.log" || { echo "FAIL: the chain does not show: $1" >&2; cat "$WORK/cc-status.log" >&2; exit 1; }; }
VAULT="$MAINNET_MULTISIG_VAULT"; MS="$REHEARSAL_MULTISIG_ACCOUNT"
# The multisig account is part of the configuration from the start: verify.ts and handover.ts read and judge it every time.
export MAINNET_MULTISIG_ACCOUNT="$MS"
# A throwaway git tree holding the manifests, with one commit made by plumbing (no hook, no identity file): what
# build.sh and deploy.sh see as "a clean tree at a commit", and, one edit later, as a dirty one.
git_commit() { # git_commit <dir>: everything in <dir> as one more commit (the first, when there is none)
  (cd "$1" && export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=rehearsal GIT_AUTHOR_EMAIL= GIT_COMMITTER_NAME=rehearsal GIT_COMMITTER_EMAIL= && { [ -d .git ] || git init -q; } && git add -A && if git rev-parse -q --verify HEAD >/dev/null; then git update-ref HEAD "$(git commit-tree "$(git write-tree)" -p HEAD -m rehearsal)"; else git update-ref HEAD "$(git commit-tree "$(git write-tree)" -m rehearsal)"; fi)
}
git_tree() { # git_tree <dir>
  mkdir -p "$1"
  for p in "${ALL[@]}"; do mkdir -p "$1/programs/$p"; cp "programs/$p/Cargo.toml" "$1/programs/$p/Cargo.toml"; done
  cp Cargo.toml Cargo.lock Anchor.toml "$1/"
  git_commit "$1"
}
# The rehearsal's own source (every program file, as it is built and deployed here) as a git tree with one commit:
# what mainnet runs from. target/ is ignored there, as in the repository.
git_source_tree() { # git_source_tree <dir>
  mkdir -p "$1"
  cp -R "$TRELLIS_ROOT/programs" "$TRELLIS_ROOT/Cargo.toml" "$TRELLIS_ROOT/Cargo.lock" "$TRELLIS_ROOT/Anchor.toml" "$1/"
  printf 'target/\n.data/\n' > "$1/.gitignore"
  git_commit "$1"
}

# =================================================================================================================================
if [ "$ONLY" != "2" ]; then
step "PART 1: the mainnet build, tier credits (then payments on top)"
start_validator part1

step "refusals before anything is funded"
expect_refusal "deploy.sh without a mode flag" scripts/mainnet/deploy.sh --dry-run
said "pass --i-understand-this-is-mainnet"
# The genesis-hash guard, both copies of it: the shell guard in deploy.sh and the TypeScript guard every other script
# starts with. Each is pointed at this local validator while claiming mainnet, and must stop on the genesis hash.
expect_refusal "deploy.sh claiming mainnet against a chain that is not mainnet (shell genesis guard)" "${M[@]}" MAINNET_RPC_URL="$REHEARSAL_RPC_URL" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --dry-run
said "not mainnet-beta's 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
expect_refusal "the TypeScript genesis guard in mainnet mode against a chain that is not mainnet" bun -e 'import { assertCluster, connect } from "./scripts/mainnet/lib.ts"; await assertCluster(connect(process.env.REHEARSAL_RPC_URL), "mainnet"); console.log("accepted");'
said "not mainnet-beta's 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
expect_refusal "mainnet mode with an http RPC URL" "${M[@]}" MAINNET_RPC_URL="$REHEARSAL_RPC_URL" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" bun scripts/mainnet/preflight.ts --i-understand-this-is-mainnet
said "MAINNET_RPC_URL must be https"
expect_refusal "--yes on mainnet" "${M[@]}" MAINNET_RPC_URL="$REHEARSAL_RPC_URL" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --yes
said "--yes is not accepted on mainnet"
expect_refusal "--allow-devnet-build on mainnet" "${M[@]}" MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" bun scripts/mainnet/preflight.ts --i-understand-this-is-mainnet --allow-devnet-build
said "--allow-devnet-build is for rehearsals only"
expect_refusal "a rehearsal pointed at a non-loopback RPC" env REHEARSAL_RPC_URL="https://api.devnet.solana.com" bun scripts/mainnet/preflight.ts --rehearsal
said "A rehearsal only runs against a local validator"
expect_refusal "mainnet mode with no MAINNET_RPC_URL" "${M[@]}" bun scripts/mainnet/init.ts --i-understand-this-is-mainnet --precheck
said "MAINNET_RPC_URL is not set"
# R3-10: mainnet takes no rehearsal override, each refused before anything is read (the RPC named here is never contacted).
expect_refusal "mainnet mode with TRELLIS_ROOT set (a source root other than the repository)" env MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet
said "TRELLIS_ROOT is set"
expect_refusal "deploy.sh on mainnet with TRELLIS_ROOT set" env MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --dry-run
said "TRELLIS_ROOT is set"
expect_refusal "mainnet mode with TRELLIS_SO_DIR set (binaries that would stand in for the build)" "${M[@]}" TRELLIS_SO_DIR="$PWD/target/deploy" MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" bun scripts/mainnet/preflight.ts --i-understand-this-is-mainnet
said "TRELLIS_SO_DIR is set"
expect_refusal "--allow-dirty on mainnet (deploy.sh)" "${M[@]}" MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --allow-dirty
said "--allow-dirty is for rehearsals only"
expect_refusal "--allow-dirty on mainnet (verify.ts)" "${M[@]}" MAINNET_RPC_URL="https://rpc.invalid" bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet --allow-dirty
said "--allow-dirty is for rehearsals only"
expect_refusal "--build-dir on mainnet (verify.ts)" "${M[@]}" MAINNET_RPC_URL="https://rpc.invalid" bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet --build-dir "$PWD/target/deploy"
said "--build-dir is for rehearsals only"
# R4-18: the deployments record of a mainnet run is deployments/mainnet.json of the repository; the override is refused.
expect_refusal "mainnet mode with TRELLIS_DEPLOYMENTS_FILE set (verify.ts)" env -u TRELLIS_ROOT MAINNET_RPC_URL="https://rpc.invalid" bun scripts/mainnet/verify.ts --i-understand-this-is-mainnet
said "Refusing to run on mainnet: TRELLIS_DEPLOYMENTS_FILE is set"
expect_refusal "mainnet mode with TRELLIS_DEPLOYMENTS_FILE set (handover.ts check)" env -u TRELLIS_ROOT MAINNET_RPC_URL="https://rpc.invalid" bun scripts/mainnet/handover.ts check --i-understand-this-is-mainnet --multisig "$VAULT"
said "Refusing to run on mainnet: TRELLIS_DEPLOYMENTS_FILE is set"
expect_refusal "deploy.sh on mainnet with TRELLIS_DEPLOYMENTS_FILE set" env -u TRELLIS_ROOT MAINNET_RPC_URL="https://rpc.invalid" MAINNET_DEPLOYER_KEYPAIR="$REHEARSAL_DEPLOYER_KEYPAIR" scripts/mainnet/deploy.sh --i-understand-this-is-mainnet --dry-run
said "Refusing to run on mainnet: TRELLIS_DEPLOYMENTS_FILE is set"
# R4-29: a multisig that has not made its vault sign is never waved through on mainnet, in any phase.
for phase in propose resolve check; do
  expect_refusal "--multisig-untested-ok on mainnet ($phase)" "${M[@]}" MAINNET_RPC_URL="https://rpc.invalid" bun scripts/mainnet/handover.ts "$phase" --i-understand-this-is-mainnet --multisig "$VAULT" --multisig-untested-ok
  said "--multisig-untested-ok is not accepted on mainnet ($phase)"
done
expect_refusal "--publish-idl together with --skip-idl" scripts/mainnet/deploy.sh --rehearsal --publish-idl --skip-idl --dry-run
said "--publish-idl and --skip-idl contradict each other"
expect_refusal "an unknown tier" bun scripts/mainnet/preflight.ts --rehearsal --tier everything
said "unknown tier"
expect_refusal "trellis_capacity without trellis_bond" bun scripts/mainnet/preflight.ts --rehearsal --programs credits,capacity
said "trellis_capacity needs trellis_bond"
expect_refusal "preflight with an unfunded deployer" bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}"
said "the deployer holds"

step "R3-10: a dirty tree is refused at build and at deploy; the rehearsal's own source is not a commit, and says so"
# The rehearsal's source is a snapshot, which no commit names: without the rehearsal-only override nothing is built or deployed.
expect_refusal "deploy.sh from a source that is not a git tree, without --allow-dirty" scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl --dry-run
said "Refusing to deploy: the source root is not a git work tree of its own"
expect_refusal "preflight.ts from a source that is not a git tree, without --allow-dirty" bun scripts/mainnet/preflight.ts --rehearsal --tier minimal
said "Refusing to go on: the source root is not a git work tree of its own"
expect_refusal "build.sh from a source that is not a git tree, without --allow-dirty" scripts/mainnet/build.sh --tier minimal
said "Refusing to build: the source root is not a git work tree of its own"
# A real git tree: clean, it builds and build.json names the commit; one edit later it is refused, at build and at deploy.
git_tree "$WORK/git-source"
GIT_BUILD="$(TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/build.sh --tier minimal)"
jq -e --arg c "$(git -C "$WORK/git-source" rev-parse HEAD)" '.sourceTree == "clean" and .sourceCommit == $c and .builtFrom == "an export of the commit (git archive)"' "$GIT_BUILD/build.json" >/dev/null || { echo "FAIL: build.json of a clean tree does not name its commit and that it was built from an export of it" >&2; exit 1; }
[ "$(basename "$GIT_BUILD")" = "$(TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/source-state.sh --json | jq -r .headKey)" ] || { echo "FAIL: the build directory of a clean tree is not named after the source key of the commit" >&2; exit 1; }
echo "a clean tree builds, and build.json names commit $(jq -r .sourceCommit "$GIT_BUILD/build.json" | cut -c1-12)"
TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/deploy.sh --rehearsal --tier minimal --skip-idl --dry-run > "$WORK/clean-tree.log"
grep -q "Source: commit $(git -C "$WORK/git-source" rev-parse HEAD), no uncommitted change" "$WORK/clean-tree.log" || { echo "FAIL: the preflight did not name the commit of a clean tree" >&2; exit 1; }
echo "# edited after the commit" >> "$WORK/git-source/programs/trellis_credits/Cargo.toml"
expect_refusal "build.sh on a tree with an uncommitted change" env TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/build.sh --tier minimal
said "Refusing to build: the source tree has uncommitted changes (1 path(s), first: programs/trellis_credits/Cargo.toml)"
expect_refusal "deploy.sh on a tree with an uncommitted change" env TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/deploy.sh --rehearsal --tier minimal --skip-idl --dry-run
said "Refusing to deploy: the source tree has uncommitted changes"
GIT_BUILD="$(TRELLIS_ROOT="$WORK/git-source" scripts/mainnet/build.sh --tier minimal --allow-dirty)"
jq -e '.sourceTree == "dirty (rehearsal only)" and .builtFrom == "the working tree (rehearsal only)"' "$GIT_BUILD/build.json" >/dev/null || { echo "FAIL: a build made with --allow-dirty does not say so" >&2; exit 1; }
echo "with --allow-dirty the same tree builds, and build.json says: $(jq -r .sourceTree "$GIT_BUILD/build.json")"

step "R3-21: a keypair file that other users can read is refused, for every key the kit loads"
cp "$REHEARSAL_DEPLOYER_KEYPAIR" "$WORK/deployer-loose.json"; chmod 644 "$WORK/deployer-loose.json"
cp "$REHEARSAL_GUARDIAN_KEYPAIR" "$WORK/guardian-loose.json"; chmod 640 "$WORK/guardian-loose.json"
expect_refusal "deploy.sh with a deployer keypair file of mode 644" env REHEARSAL_DEPLOYER_KEYPAIR="$WORK/deployer-loose.json" scripts/mainnet/deploy.sh --rehearsal --tier minimal --skip-idl --dry-run "${A[@]}"
said "deployer-loose.json is readable by other users"
expect_refusal "init.ts with a deployer keypair file of mode 644" env REHEARSAL_DEPLOYER_KEYPAIR="$WORK/deployer-loose.json" bun scripts/mainnet/init.ts --rehearsal --precheck
said "deployer-loose.json is readable by other users"
expect_refusal "preflight.ts with program keypair files of mode 644" env TRELLIS_MAINNET_KEYS_DIR="$WORK/loose-keys" bash -c 'mkdir -p "$TRELLIS_MAINNET_KEYS_DIR" && cp "$0"/*-keypair.json "$TRELLIS_MAINNET_KEYS_DIR/" && chmod 644 "$TRELLIS_MAINNET_KEYS_DIR"/*.json && bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl --allow-dirty' "$TRELLIS_MAINNET_KEYS_DIR"
said "is readable by other users"

step "R3-21: MAINNET_ANCHORER is required as soon as a program is deployed (in memo mode its signature is the root)"
expect_refusal "tier credits without MAINNET_ANCHORER" env -u MAINNET_ANCHORER bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}"
said "MAINNET_ANCHORER is not set"

step "tier minimal: nothing to deploy, and it says what it costs"
scripts/mainnet/deploy.sh --rehearsal --tier minimal --skip-idl --dry-run "${A[@]}" | tee "$WORK/minimal.log"
grep -q "programs       none: nothing is deployed" "$WORK/minimal.log" || { echo "FAIL: tier minimal still plans a deploy" >&2; exit 1; }
grep -q "LAUNCH_TIER=minimal" "$WORK/minimal.log" || { echo "FAIL: tier minimal does not name the router tier" >&2; exit 1; }

step "fund the rehearsal deployer with what tier credits needs, and no more"
fund "$REHEARSAL_DEPLOYER" 3
fund "$MAINNET_GUARDIAN" 0.01
solana balance "$REHEARSAL_DEPLOYER" -u "$REHEARSAL_RPC_URL"

step "a build that was not made for the program keypairs is refused"
# Fresh keypairs beside a build compiled for other ids: what happens when keys.sh ran but the programs were not rebuilt.
mkdir -p "$WORK/other-keys"
for p in "${ALL[@]}"; do solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/other-keys/$p-keypair.json" >/dev/null; done
expect_refusal "preflight with program keypairs the build was not compiled for" env TRELLIS_MAINNET_KEYS_DIR="$WORK/other-keys" bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}"
said "does not carry the program id"

step "a devnet-feature binary is refused (it says so itself: build_profile returns profile 1 and 30 s, not 24 h)"
expect_refusal "preflight on the devnet-feature build without --allow-devnet-build" bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}" --prebuilt "$DEVNET_SO_DIR"
said 'is not the mainnet build: profile is 1 (the `devnet` cargo feature), the mainnet build reports 0'
said "config_timelock is 30 s, the mainnet build has 86400 s"

step "a guardian that is the vault, or the deployer, is refused"
expect_refusal "MAINNET_GUARDIAN = the multisig vault" env MAINNET_GUARDIAN="$VAULT" bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}"
said "the guardian must be a separate key"
expect_refusal "MAINNET_GUARDIAN = the deployer" env MAINNET_GUARDIAN="$REHEARSAL_DEPLOYER" bun scripts/mainnet/preflight.ts --rehearsal --tier credits --skip-idl "${A[@]}"
said "guardian is the deployer key"

step "init --prepare (tier credits needs one token account: the treasury)"
bun scripts/mainnet/init.ts --rehearsal --tier credits --prepare --yes

step "deploy --dry-run: the preflight builds the default profile in a clean target directory, simulates, prints the SOL"
scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl --dry-run "${A[@]}" | tee "$WORK/preflight-credits.log"
grep -q "Source: NOT a clean tree at a commit: the source root is not a git work tree of its own" "$WORK/preflight-credits.log" && grep -q "accepted for this rehearsal only (--allow-dirty)" "$WORK/preflight-credits.log" || { echo "FAIL: the preflight did not say what source it builds from" >&2; exit 1; }
grep -q "trellis_credits  *build_profile: mainnet build, all 8 floors (timelock 86400 s, proposal expiry 604800 s, pause 259200 s)" "$WORK/preflight-credits.log" || { echo "FAIL: the preflight did not read the mainnet build profile from the binary" >&2; exit 1; }
grep -q "build profiles, init, pauses (72 h, guardian cooldown), proposal expiry, refusal before the timelock, refusal without the vault, resolution by operator and vault, upgrade authority: all as planned" "$WORK/preflight-credits.log" || { echo "FAIL: the preflight's simulation did not run the whole procedure" >&2; exit 1; }
grep "TOTAL to have ready" "$WORK/preflight-credits.log"

step "R3-21: a deploy that stops at the confirmation leaves no record behind"
# The record exists already (init.ts --prepare wrote the treasury account into it); deploy.sh must not have touched it.
cp "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-deploy.json"
expect_refusal "deploy.sh with no terminal to type the confirmation on" bash -c 'scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl --allow-dirty < /dev/null'
said "No terminal attached: the confirmation must be typed by the operator. Nothing was sent."
cmp -s "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-deploy.json" && jq -e '.tier == null and .sourceCommit == null and .build == null and .programs == {}' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: deploy.sh wrote the deployments record before the confirmation" >&2; exit 1; }
echo "the deployments record is byte for byte what it was: nothing was written before the confirmation"

step "deploy tier credits"
scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl --yes "${A[@]}" | tee "$WORK/deploy-credits.log"
jq -e '.tier == "credits" and (.programs.trellis_credits.soHash | length) == 64 and .programs.trellis_credits.profile == "mainnet" and (.reserved | length) == 8 and .build.kind == "clean-default-build"' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record lacks the tier, the hash, the measured profile or the reserved ids" >&2; exit 1; }
# R3-21: the binary was hashed again right before the deploy, and the upgrade authority in the record is the one the chain names.
grep -q "binary unchanged since the preflight, sha256 $(jq -r .programs.trellis_credits.soSha256 "$TRELLIS_DEPLOYMENTS_FILE")" "$WORK/deploy-credits.log" || { echo "FAIL: deploy.sh did not re-hash the binary before deploying it" >&2; exit 1; }
grep -q "upgrade authority read from chain: $REHEARSAL_DEPLOYER" "$WORK/deploy-credits.log" || { echo "FAIL: deploy.sh did not read the upgrade authority from the chain" >&2; exit 1; }
[ "$(solana program show "$(jq -r .programs.trellis_credits.programId "$TRELLIS_DEPLOYMENTS_FILE")" -u "$REHEARSAL_RPC_URL" --output json | jq -r .authority)" = "$(jq -r .programs.trellis_credits.upgradeAuthority "$TRELLIS_DEPLOYMENTS_FILE")" ] || { echo "FAIL: the recorded upgrade authority is not the one on chain" >&2; exit 1; }
# R3-10: the record says what was deployed from what.
jq -e '.programs.trellis_credits.sourceTree == "dirty (rehearsal only)" and (.programs.trellis_credits.sourceKey | length) == 64 and .programs.trellis_credits.buildKind == "clean-default-build" and .build.sourceTree == "dirty (rehearsal only)"' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not say which source the program was deployed from" >&2; exit 1; }

step "R4-16: the same source as a commit: built from an export of it, byte for byte the deployed binary, and bound to the commit by its manifest"
# The rehearsal deployed a build of its snapshot, compiled where it lay (--allow-dirty). Here the same files are a commit
# in a throwaway git tree, and build.sh's clean path is run for real: it does not compile that tree, it compiles what
# `git archive HEAD` writes out. The directory is the same (same source key), its manifest said "dirty", so the clean
# run compiles again; the result must be the very bytes that were deployed.
git_source_tree "$WORK/git-full"
DEPLOYED_SHA="$(jq -r .programs.trellis_credits.soSha256 "$TRELLIS_DEPLOYMENTS_FILE")"
SNAPSHOT_KEY="$(jq -r .programs.trellis_credits.sourceKey "$TRELLIS_DEPLOYMENTS_FILE")"
[ "$(TRELLIS_ROOT="$WORK/git-full" scripts/mainnet/source-state.sh --json | jq -r .headKey)" = "$SNAPSHOT_KEY" ] || { echo "FAIL: the commit of the rehearsal's source does not have the source key of the snapshot it was copied from" >&2; exit 1; }
EXPORT_BUILD="$(TRELLIS_ROOT="$WORK/git-full" scripts/mainnet/build.sh --programs trellis_credits 2> "$WORK/export-build.log")" || { cat "$WORK/export-build.log" >&2; echo "FAIL: the build from an export of the commit did not complete" >&2; exit 1; }
grep -q "building trellis_credits (default profile, clean target directory, from an export of the commit (git archive))" "$WORK/export-build.log" || { echo "FAIL: the clean build did not compile the export of the commit (it must not reuse a rehearsal's binary)" >&2; cat "$WORK/export-build.log" >&2; exit 1; }
[ "$EXPORT_BUILD" = "$PWD/.data/mainnet-build/$SNAPSHOT_KEY" ] || { echo "FAIL: the build of the commit is not named after its source key" >&2; exit 1; }
[ "$(shasum -a 256 "$EXPORT_BUILD/trellis_credits.so" | cut -d' ' -f1)" = "$DEPLOYED_SHA" ] || { echo "FAIL: the build from the export of the commit is not byte for byte the binary that was deployed" >&2; exit 1; }
jq -e --arg c "$(git -C "$WORK/git-full" rev-parse HEAD)" --arg k "$SNAPSHOT_KEY" --arg sha "$DEPLOYED_SHA" '.sourceTree == "clean" and .sourceCommit == $c and .sourceKey == $k and .builtFrom == "an export of the commit (git archive)" and .programs.trellis_credits.sha256 == $sha' "$EXPORT_BUILD/build.json" >/dev/null || { echo "FAIL: the manifest of the clean build does not bind the binary to the commit" >&2; exit 1; }
echo "built from an export of commit $(git -C "$WORK/git-full" rev-parse --short=12 HEAD): sha256 $DEPLOYED_SHA, the binary that is on chain"

step "init (tier credits): guardian and settlement key are the final keys from the start"
bun scripts/mainnet/init.ts --rehearsal --precheck
# R3-11 (residual): each address init.ts would write is shown with where it came from and confirmed by itself.
cp "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-init.json"
expect_refusal "init.ts with no terminal to confirm the role addresses on" bash -c 'bun scripts/mainnet/init.ts --rehearsal < /dev/null'
said "guardian  *$MAINNET_GUARDIAN  *MAINNET_GUARDIAN  *guardian ${MAINNET_GUARDIAN: -6}"
said "settlement  *$MAINNET_SETTLEMENT_AUTHORITY  *MAINNET_SETTLEMENT_AUTHORITY  *settlement ${MAINNET_SETTLEMENT_AUTHORITY: -6}"
said "anchorer  *$MAINNET_ANCHORER  *MAINNET_ANCHORER  *anchorer ${MAINNET_ANCHORER: -6}"
said "vault  *$VAULT  *MAINNET_MULTISIG_VAULT  *vault ${VAULT: -6}"
said "No terminal attached: the confirmation must be typed by the operator. Nothing was sent."
cmp -s "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-init.json" || { echo "FAIL: an init that stopped at the first address confirmation touched the record" >&2; exit 1; }
bun scripts/mainnet/init.ts --rehearsal --yes | tee "$WORK/init-credits.log"
for phrase in "vault ${VAULT: -6}" "guardian ${MAINNET_GUARDIAN: -6}" "settlement ${MAINNET_SETTLEMENT_AUTHORITY: -6}" "anchorer ${MAINNET_ANCHORER: -6}"; do
  grep -qF "(rehearsal: confirmation \"$phrase\" skipped by --yes)" "$WORK/init-credits.log" || { echo "FAIL: init.ts did not ask for the confirmation: $phrase" >&2; exit 1; }
done
bun scripts/mainnet/init.ts --rehearsal --yes | tail -3
# R3-21: the record is what was read back. A role that differs between the chain and the environment is a refusal,
# and the record is left alone (before, a rerun silently rewrote it from the environment).
OTHER_KEY="$(solana-keygen pubkey "$WORK/other-keys/trellis_credits-keypair.json")"
expect_refusal "init.ts with a settlement key in the environment that is not the one on chain" env MAINNET_SETTLEMENT_AUTHORITY="$OTHER_KEY" bun scripts/mainnet/init.ts --rehearsal --yes
said "trellis_credits: the settlement authority on chain is $MAINNET_SETTLEMENT_AUTHORITY, the environment (MAINNET_SETTLEMENT_AUTHORITY) names $OTHER_KEY"
said "were NOT rewritten"
jq -e --arg s "$MAINNET_SETTLEMENT_AUTHORITY" --arg a "$MAINNET_ANCHORER" '.authorities.settlementAuthority == $s and .authorities.anchorer == $a' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: init.ts rewrote the record from the environment" >&2; exit 1; }

step "verify (operator stage): recorded hash, build_profile read on chain (profile 0, mainnet floors), the floor refused, the limiter, the guardian a key of its own"
bun scripts/mainnet/verify.ts --rehearsal --write-report --allow-dirty --env | tee "$WORK/verify-credits.log"
# R3-10: source equivalence was established in this run, from the build of the rehearsal's source, hashed again.
grep -q "ok   source equivalence: the on-chain bytes equal .data/mainnet-build/$(jq -r .programs.trellis_credits.sourceKey "$TRELLIS_DEPLOYMENTS_FILE")/trellis_credits.so" "$WORK/verify-credits.log" || { echo "FAIL: verify did not re-hash the build of this source" >&2; exit 1; }
jq -e '.checks[] | select(.id == "contracts.source_equivalence") | .status == "pass" and .evidence.programs.trellis_credits.established == true and .evidence.programs.trellis_credits.buildSha256 == .evidence.programs.trellis_credits.onChainSha256 and (.evidence.tree | startswith("not clean"))' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the report does not carry how source equivalence was established" >&2; exit 1; }
# R3-09: the multisig behind the vault was read and judged, also before anything is handed to it.
grep -q "ok   the multisig behind the vault is what was configured: owned by the Squads program, threshold 2, 3 expected members" "$WORK/verify-credits.log" || { echo "FAIL: verify did not judge the multisig account" >&2; exit 1; }
jq -e --arg ms "$MS" --arg v "$VAULT" '.exceptions == [] and (.checks[] | select(.id == "multisig.account") | .status == "pass" and .evidence.address == $ms and .evidence.threshold == 2 and (.evidence.members | length) == 3 and .evidence.vault == $v and .evidence.configAuthority == null)' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the report does not carry the multisig that was read" >&2; exit 1; }
grep -q "ok   no proposal is pending" "$WORK/verify-credits.log" && grep -q "the record lists no IDL published by this kit" "$WORK/verify-credits.log" || { echo "FAIL: verify did not report on proposals and the IDL" >&2; exit 1; }
tail -4 "$WORK/verify-credits.log" | grep -q "^wrote " || { echo "FAIL: no report was written" >&2; exit 1; }
grep -q "^all checks passed$" "$WORK/verify-credits.log" || { echo "FAIL: verify at the operator stage is not a plain pass" >&2; exit 1; }
# The refusals of the same step: no override, a build that is not the one on chain, no build at all.
rm -f "$WORK/report-before.json"; cp "$DIR/deployment.verification.json" "$WORK/report-before.json"
expect_refusal "verify without --allow-dirty from a source no commit names" bun scripts/mainnet/verify.ts --rehearsal --write-report
said "FAIL source equivalence: NOT ESTABLISHED: the source root is not a git work tree of its own"
said "No report written"
expect_refusal "verify against a build directory whose binary is not the one on chain" bun scripts/mainnet/verify.ts --rehearsal --write-report --allow-dirty --build-dir "$DEVNET_SO_DIR"
said "FAIL source equivalence: the on-chain bytes (sha256 .*) differ from"
expect_refusal "verify when no build of this source is on the machine" env TRELLIS_ROOT="$WORK/git-source" TRELLIS_SO_DIR="$PWD/.data/mainnet-build/$(jq -r .programs.trellis_credits.sourceKey "$TRELLIS_DEPLOYMENTS_FILE")" bun scripts/mainnet/verify.ts --rehearsal --write-report --allow-dirty
said "FAIL source equivalence: NOT ESTABLISHED: no build output of the current source is on this machine"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-before.json" || { echo "FAIL: a refused verification rewrote the report" >&2; exit 1; }
echo "the report is unchanged by the three refused runs (TRELLIS_SO_DIR pointed at the right binary and was not consulted)"
# R4-16: from the commit of the same source, verify needs no override: the tree is clean by content, and the manifest
# beside the build binds binary, commit and chain. (A separate report file: this is about the check, not the report.)
TRELLIS_ROOT="$WORK/git-full" bun scripts/mainnet/verify.ts --rehearsal > "$WORK/verify-commit.log" || { cat "$WORK/verify-commit.log" >&2; echo "FAIL: verify from a clean commit of the deployed source did not pass" >&2; exit 1; }
grep -q "ok   the source tree is clean at commit $(git -C "$WORK/git-full" rev-parse HEAD)" "$WORK/verify-commit.log" && grep -q "ok   source equivalence: the on-chain bytes equal .data/mainnet-build/$SNAPSHOT_KEY/trellis_credits.so .*; build.json binds it to source key ${SNAPSHOT_KEY:0:16} of commit $(git -C "$WORK/git-full" rev-parse --short=12 HEAD), the commit checked out now" "$WORK/verify-commit.log" || { echo "FAIL: verify did not establish source equivalence from the commit and its manifest" >&2; cat "$WORK/verify-commit.log" >&2; exit 1; }
echo "from the commit, without --allow-dirty: $(grep -c '^  ok ' "$WORK/verify-commit.log") checks pass and source equivalence is bound to the commit by build.json"
# git says "clean" and the content is not the commit's: an index entry git was told not to look at, a file an exclude rule hides.
echo "// edited behind a skip-worktree flag" >> "$WORK/git-full/programs/trellis_credits/src/lib.rs"
git -C "$WORK/git-full" update-index --skip-worktree programs/trellis_credits/src/lib.rs
[ -z "$(git -C "$WORK/git-full" status --porcelain)" ] || { echo "FAIL: the skip-worktree fixture is not clean for git" >&2; exit 1; }
expect_refusal "verify from a tree with a skip-worktree edit that git status does not show" env TRELLIS_ROOT="$WORK/git-full" bun scripts/mainnet/verify.ts --rehearsal --write-report
said "FAIL source equivalence: NOT ESTABLISHED: the index marks 1 path(s) skip-worktree or assume-unchanged (first: programs/trellis_credits/src/lib.rs)"
said "No report written"
expect_refusal "build.sh from a tree with a skip-worktree edit" env TRELLIS_ROOT="$WORK/git-full" scripts/mainnet/build.sh --tier minimal
said "Refusing to build: the index marks 1 path(s) skip-worktree or assume-unchanged"
expect_refusal "deploy.sh from a tree with a skip-worktree edit" env TRELLIS_ROOT="$WORK/git-full" scripts/mainnet/deploy.sh --rehearsal --tier minimal --skip-idl --dry-run
said "Refusing to deploy: the index marks 1 path(s) skip-worktree or assume-unchanged"
git -C "$WORK/git-full" update-index --no-skip-worktree programs/trellis_credits/src/lib.rs
git -C "$WORK/git-full" checkout-index -f -- programs/trellis_credits/src/lib.rs
echo "hidden.rs" >> "$WORK/git-full/.git/info/exclude"
echo "// a source file an exclude rule hides" > "$WORK/git-full/programs/trellis_credits/src/hidden.rs"
[ -z "$(git -C "$WORK/git-full" status --porcelain)" ] || { echo "FAIL: the excluded-file fixture is not clean for git" >&2; exit 1; }
expect_refusal "verify from a tree with a source file that a local exclude rule hides" env TRELLIS_ROOT="$WORK/git-full" bun scripts/mainnet/verify.ts --rehearsal --write-report
said "FAIL source equivalence: NOT ESTABLISHED: the program sources on disk differ in 1 path(s) from the commit although .git status. is clean (first: programs/trellis_credits/src/hidden.rs)"
mv "$WORK/git-full/programs/trellis_credits/src/hidden.rs" "$WORK/hidden.rs.removed"
# The review's sequence: the binary that is on chain lies in target/verifiable; the source moves on to another commit;
# the tree is clean. Nothing binds that file to the new commit, and its place does not.
mkdir -p "$WORK/git-full/target/verifiable"
cp "$EXPORT_BUILD/trellis_credits.so" "$WORK/git-full/target/verifiable/trellis_credits.so"
echo "// commit Y: a change nobody built" >> "$WORK/git-full/programs/trellis_credits/src/lib.rs"
git_commit "$WORK/git-full"
expect_refusal "verify with the deployed binary in target/verifiable of a LATER commit, no manifest" env TRELLIS_ROOT="$WORK/git-full" bun scripts/mainnet/verify.ts --rehearsal --write-report
said "FAIL source equivalence: the on-chain bytes equal .*target/verifiable/trellis_credits.so, but nothing binds that file to the commit checked out now: .*holds no build manifest (build.json)"
# With the manifest of the EARLIER commit beside it, the mismatch is named.
cp "$EXPORT_BUILD/build.json" "$WORK/git-full/target/verifiable/build.json"
expect_refusal "verify with the deployed binary and the manifest of an earlier commit in target/verifiable" env TRELLIS_ROOT="$WORK/git-full" bun scripts/mainnet/verify.ts --rehearsal --write-report
said "build.json names source key ${SNAPSHOT_KEY:0:16} .*; the commit checked out now has $(TRELLIS_ROOT="$WORK/git-full" scripts/mainnet/source-state.sh --json | jq -r '.headKey[0:16]'): the binaries were not built from this source"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-before.json" || { echo "FAIL: a refused verification rewrote the report" >&2; exit 1; }
echo "the report is unchanged by the R4-16 refusals"
# R3-08: a selection narrower than what is deployed is a refusal, not an empty success.
expect_refusal "verify --tier minimal over a deployed credits program" bun scripts/mainnet/verify.ts --rehearsal --tier minimal --allow-dirty --write-report
said "trellis_credits is deployed but not covered by the selection (tier minimal: no program)"
expect_refusal "handover.ts check --tier minimal over a deployed credits program" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" --tier minimal
said "HANDOVER INCOMPLETE"
said "outside the selected tier (minimal)"
grep -q "ok   build_profile read on chain: profile 0, min_refund_delay 259200 s, min_expiry_grace 2592000 s, min_credit_ttl 15552000 s, config_timelock 86400 s, settle_window 86400 s, pause_ttl 259200 s, guardian_pause_cooldown 604800 s, proposal_ttl 604800 s: the mainnet build (all 8 floors)" "$WORK/verify-credits.log" || { echo "FAIL: verify did not read the mainnet build profile and floors from the deployed program" >&2; exit 1; }
grep -q "ok   config timelock read on chain: 86400 s (24 h)" "$WORK/verify-credits.log" || { echo "FAIL: verify did not read the timelock on chain" >&2; exit 1; }
grep -q "ok   outflow limiter .*: rate 2000 bps of the vault per 24 h (expected 2000)" "$WORK/verify-credits.log" || { echo "FAIL: verify did not read the outflow limiter at limiter_v2" >&2; exit 1; }
jq -e '.checks[] | select(.id == "contracts.build_profile") | .evidence.profiles.trellis_credits | .profile == 0 and .kind == "mainnet" and .floors.proposalTtl == 604800 and .floors.pauseTtl == 259200' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the verification report does not carry the build profile read on chain" >&2; exit 1; }
grep -q "a proposal below the floor (refund delay 72 h - 1 s) is refused with OutOfBounds" "$WORK/verify-credits.log" || { echo "FAIL: verify did not see the floor refuse" >&2; exit 1; }
grep -q "^LAUNCH_TIER=credits" "$WORK/verify-credits.log" && grep -q "^ANCHOR_MODE=memo" "$WORK/verify-credits.log" || { echo "FAIL: the router env block is not the credits tier in memo mode" >&2; exit 1; }
step "the router's production guard accepts tier credits (and refuses LAUNCH_TIER=full on it)"
bun scripts/mainnet/rehearsal-guard.ts
expect_refusal "verify --expect multisig before the hand-over" bun scripts/mainnet/verify.ts --rehearsal --expect multisig "${A[@]}"
said "the deployer key still holds: trellis_credits upgrade, trellis_credits authority"

step "R4-29: lamports sent to the pending-proposal address of trellis_credits are not a proposal"
# Anyone can do this. It must stop neither verification (the below-floor probe still runs) nor, further down, the hand-over proposal.
PENDING_ADDRESS="$(bun -e 'import { assertCluster, connect, loadRecord, programIds, rpcUrl } from "./scripts/mainnet/lib.ts"; import { pendingAddress } from "./scripts/mainnet/plan.ts"; const conn = connect(rpcUrl("rehearsal")); const rec = loadRecord("rehearsal", await assertCluster(conn, "rehearsal")); console.log(pendingAddress("trellis_credits", programIds("rehearsal", rec, ["trellis_credits"]).trellis_credits).toBase58());')"
fund "$PENDING_ADDRESS" 0.01
bun scripts/mainnet/verify.ts --rehearsal "${A[@]}" > "$WORK/verify-prefunded.log" || { cat "$WORK/verify-prefunded.log" >&2; echo "FAIL: lamports at the pending-proposal address made verify fail" >&2; exit 1; }
grep -q "note the pending-proposal address $PENDING_ADDRESS holds lamports in an account the program does not own" "$WORK/verify-prefunded.log" && grep -q "ok   a proposal below the floor (refund delay 72 h - 1 s) is refused with OutOfBounds" "$WORK/verify-prefunded.log" && grep -q "ok   no proposal is pending" "$WORK/verify-prefunded.log" || { echo "FAIL: verify did not run the below-floor probe beside a funded pending-proposal address" >&2; cat "$WORK/verify-prefunded.log" >&2; exit 1; }
echo "verify passes with $PENDING_ADDRESS funded by a stranger; the probe ran and the floor refused"

step "the guardian key pauses for 72 hours, once; the authority renews; only the authority unpauses"
monitor() { bun scripts/monitor.ts --once --cluster rehearsal --json > "$1" || true; }
# R3-21: a pause is the guardian's. Without its keypair file the script stops; it does not reach for the deployer key,
# which is the authority here and COULD pause. And a guardian keypair file others can read is not loaded.
expect_refusal "pause.ts without a guardian keypair (no fallback to the deployer key)" env -u REHEARSAL_GUARDIAN_KEYPAIR "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --settlements --yes
said "REHEARSAL_GUARDIAN_KEYPAIR is not set"
said "NOTHING IS PAUSED"
said "--as-authority"
expect_refusal "pause.ts with a guardian keypair path that does not exist" env REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --settlements --yes
said "NOTHING IS PAUSED"
expect_refusal "pause.ts with a guardian keypair file of mode 640" env REHEARSAL_GUARDIAN_KEYPAIR="$WORK/guardian-loose.json" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --settlements --yes
said "guardian-loose.json is readable by other users"
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --status | grep -c "running" | grep -qx 2 || { echo "FAIL: something was paused by a run that was refused" >&2; exit 1; }
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --settlements --yes
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --status | tee "$WORK/pause-status.log"
[ "$(grep -c "PAUSED until .* (72.0 h left; set by the guardian)" "$WORK/pause-status.log")" -eq 2 ] || { echo "FAIL: the status does not show two guardian pauses of 72 hours" >&2; exit 1; }
expect_refusal "verify while deposits are paused" bun scripts/mainnet/verify.ts --rehearsal "${A[@]}"
said "deposits not paused: PAUSED until"
monitor "$WORK/monitor-paused.json"
jq -e '.checks["pause.none"] == false and .checks["limiter.not_paused"] == false and .checks["credits.deposits_not_paused"] == false and .checks["guardian.pause_ready"] == false and .checks["pause.expiring"] == true and .checks["pause.lapsed"] == true and .values["pause.trellis_credits.deposits.by"] == "guardian" and .values["pause.trellis_credits.settlements.by"] == "guardian" and .values["pause.trellis_credits.deposits.seconds_left"] > 259000 and .values["build.trellis_credits.profile"] == 0 and .values["build.trellis_credits.kind"] == "mainnet"' "$WORK/monitor-paused.json" >/dev/null || { echo "FAIL: the monitor did not report the two pauses, who set them, when they lapse and the guardian's cooldown" >&2; jq '{failing, details, values}' "$WORK/monitor-paused.json" >&2; exit 1; }
echo "monitor: $(jq -r '.details["pause.none"]' "$WORK/monitor-paused.json"); limiter paused and guardian cooldown: reported"
# The page BEFORE a pause lapses: with a warning window longer than what is left, the same state fails pause.expiring.
MONITOR_PAUSE_RENEW_WARN_HOURS=100 bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-expiring.json" || true
jq -e '.checks["pause.expiring"] == false' "$WORK/monitor-expiring.json" >/dev/null || { echo "FAIL: the monitor did not warn ahead of the pause lapsing" >&2; exit 1; }
echo "monitor: $(jq -r '.details["pause.expiring"]' "$WORK/monitor-expiring.json" | cut -c1-150)"
# The guardian again: the kit does not send it, and the authority's renewal is what extends a pause.
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --settlements --yes | tee "$WORK/pause-again.log"
grep -q "already paused until" "$WORK/pause-again.log" && grep -q "Nothing to send" "$WORK/pause-again.log" || { echo "FAIL: a second pause was sent while the first is in force" >&2; exit 1; }
sleep 2
REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --renew --settlements --yes
monitor "$WORK/monitor-renewed.json"
jq -e '.checks["pause.none"] == false and .values["pause.trellis_credits.deposits.by"] == "authority" and .values["pause.trellis_credits.settlements.by"] == "authority" and .checks["guardian.pause_ready"] == false' "$WORK/monitor-renewed.json" >/dev/null || { echo "FAIL: the monitor does not show the authority's renewal" >&2; jq '{failing, values}' "$WORK/monitor-renewed.json" >&2; exit 1; }
echo "monitor: after the renewal the pauses read as set by the authority; the guardian is still in its cooldown"
REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --unpause --settlements --yes
bun scripts/mainnet/verify.ts --rehearsal "${A[@]}" > /dev/null && echo "verify passes again after the authority unpaused"
# Nothing is paused now, and the guardian still cannot pause: 7 days must pass after its pause was due to lapse. The kit
# says so and FAILS (nothing was paused, and the exit status says so: R3-21); when the transaction is sent anyway the
# PROGRAM refuses it.
expect_refusal "a pause by the guardian inside its cooldown: nothing is sent, and that is not a success" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --yes
said "the guardian cannot pause this again before"
said "Nothing to send"
said "NOT PAUSED: trellis_credits.deposits"
# The authority can pause, when the command says it is the authority that pauses; then it lifts it again.
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --as-authority --yes | tee "$WORK/pause-authority.log"
grep -q "(the authority, --as-authority)" "$WORK/pause-authority.log" && grep -q "^paused trellis_credits.deposits" "$WORK/pause-authority.log" || { echo "FAIL: the authority did not pause with --as-authority" >&2; exit 1; }
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --unpause --yes | tail -1
expect_refusal "a second pause by the guardian inside its cooldown, sent to the chain" bun scripts/mainnet/rehearsal-probe.ts guardian-repause
said "GuardianCooldown"

step "the settlement key commits a large spent root and pays an account nobody knows: the monitor reads it from the program's events"
fund "$MAINNET_SETTLEMENT_AUTHORITY" 1
eval "$(bun scripts/mainnet/rehearsal-settle.ts)"
MONITOR_SETTLE_ALLOWLIST="$SETTLE_KNOWN" bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-settled.json" || true
jq -e '.checks["events.read"] == true and .checks["events.spent_root_delta"] == false and .checks["events.settle_destination"] == false and .checks["limiter.settle_headroom"] == false and .checks["limiter.refund_headroom"] == true and .checks["limiter.rate"] == true and .values["events.spent_roots"] == 1 and .values["events.spent_root_max_delta_usdc"] == 3000 and .values["events.settlements"] == 2 and .values["events.settlements_unknown"] == 1 and .values["limiter.settle_allowance_usdc"] < 25' "$WORK/monitor-settled.json" >/dev/null || { echo "FAIL: the monitor did not report the spent-root delta, the unknown settlement destination and the drained allowance" >&2; jq '{failing, details, values}' "$WORK/monitor-settled.json" >&2; exit 1; }
jq -e --arg u "$SETTLE_UNKNOWN" --arg k "$SETTLE_KNOWN" '(.details["events.settle_destination"] | contains($u)) and (.details["events.settle_destination"] | contains($k) | not)' "$WORK/monitor-settled.json" >/dev/null || { echo "FAIL: the monitor did not name exactly the unknown destination" >&2; exit 1; }
echo "monitor: $(jq -r '.details["events.spent_root_delta"]' "$WORK/monitor-settled.json" | cut -c1-170)"
echo "monitor: $(jq -r '.details["events.settle_destination"]' "$WORK/monitor-settled.json" | cut -c1-120)"
echo "monitor: $(jq -r '.details["limiter.settle_headroom"]' "$WORK/monitor-settled.json")"
# The same transactions pass once the bound covers the commit and both accounts are on the allow-list.
MONITOR_SPENT_DELTA_MAX_USDC=5000 MONITOR_SETTLE_ALLOWLIST="$SETTLE_KNOWN,$SETTLE_UNKNOWN" bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-settled-ok.json" || true
jq -e '.checks["events.read"] == true and .checks["events.spent_root_delta"] == true and .checks["events.settle_destination"] == true' "$WORK/monitor-settled-ok.json" >/dev/null || { echo "FAIL: the event checks do not pass with a covering bound and allow-list" >&2; jq '{failing, details}' "$WORK/monitor-settled-ok.json" >&2; exit 1; }
# A window too small to read every transaction is a finding, not a pass.
MONITOR_EVENTS_MAX_TRANSACTIONS=1 bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-bounded.json" || true
jq -e '.checks["events.read"] == false' "$WORK/monitor-bounded.json" >/dev/null || { echo "FAIL: the monitor passed although it could not read every recent transaction" >&2; exit 1; }
bun scripts/mainnet/verify.ts --rehearsal "${A[@]}" | grep "payable now"

step "hand-over, phase 1 on the mainnet build: propose, then 24 hours stand between it and the resolution"
expect_refusal "hand-over to an ordinary wallet address" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$MAINNET_SETTLEMENT_AUTHORITY" --dry-run
expect_refusal "propose without --multisig-account" env -u MAINNET_MULTISIG_ACCOUNT bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --yes
expect_refusal "a vault that is not the multisig's vault 0" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$(bun -e 'import {PublicKey} from "@solana/web3.js"; console.log(PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"))[0].toBase58())')" --multisig-account "$MS" --yes
expect_refusal "check before the hand-over" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT"
expect_refusal "resolve before anything is proposed" bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --print
said "nothing is proposed"
step "R3-09: the multisig account is read and judged before anything is proposed, and again by check and verify"
refuse_multisig() { # refuse_multisig <what> <multisig account> <what the refusal must say>
  expect_refusal "propose to $1" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$2" --yes
  said "$3"
  said "Nothing was sent"
  expect_refusal "check against $1" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" --multisig-account "$2"
  said "$3"
  expect_refusal "verify --expect multisig against $1" bun scripts/mainnet/verify.ts --rehearsal --expect multisig --multisig-account "$2" "${A[@]}"
  said "$3"
}
refuse_multisig "a multisig with threshold 1" "$REHEARSAL_MULTISIG_THRESHOLD1" "the multisig's threshold is 1 (of 3 voting members), expected 2"
refuse_multisig "a controlled multisig (it has a config authority)" "$REHEARSAL_MULTISIG_CONTROLLED" "this is a controlled multisig: its config authority"
refuse_multisig "a multisig with a member nobody expected" "$REHEARSAL_MULTISIG_EXTRA_MEMBER" "member $REHEARSAL_STRANGER_MEMBER (initiate+vote+execute) is not an expected member"
refuse_multisig "a multisig whose third member cannot vote" "$REHEARSAL_MULTISIG_NO_VOTE" "has permissions initiate+execute, expected initiate+vote+execute"
refuse_multisig "an account that the Squads program does not own" "$REHEARSAL_MULTISIG_FOREIGN_OWNER" "not the Squads v4 program"
# R4-29: created is not executed, and the guardian is not one of the keys that vote.
refuse_multisig "a multisig that created a transaction and executed none" "$REHEARSAL_MULTISIG_CREATED_ONLY" "this multisig has created 1 transaction(s) and none of them is an executed vault transaction of vault 0"
refuse_multisig "a multisig whose third member is the guardian key" "$REHEARSAL_MULTISIG_GUARDIAN_MEMBER" "the guardian $MAINNET_GUARDIAN (trellis_credits) is a member of the multisig"
# Every one of those is also at another address than the multisig whose vault was named: the derivation says so.
expect_refusal "propose when the vault is not derived from the multisig account given" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$REHEARSAL_MULTISIG_THRESHOLD1" --yes
said "the vault $VAULT is not vault 0 of multisig $REHEARSAL_MULTISIG_THRESHOLD1"
expect_refusal "propose without the expected members configured" env -u MAINNET_MULTISIG_MEMBERS bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "set MAINNET_MULTISIG_MEMBERS"
expect_refusal "propose with one expected member replaced by a key that is not in the multisig" env MAINNET_MULTISIG_MEMBERS="$(echo "$MAINNET_MULTISIG_MEMBERS" | cut -d, -f1,2),$REHEARSAL_STRANGER_MEMBER" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "expected member $REHEARSAL_STRANGER_MEMBER is missing from the multisig"
said "is not an expected member"
expect_refusal "propose to a multisig whose time lock is below the configured minimum" env MAINNET_MULTISIG_MIN_TIME_LOCK=7200 bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "the multisig's time lock is 3600 s, below the configured minimum (MAINNET_MULTISIG_MIN_TIME_LOCK) of 7200 s"
# R5-17: no time lock at all is a refusal (it was a pass with a note). The acknowledgement turns exactly that problem
# into a recorded exception; this account is refused all the same, because the vault is not derived from it.
refuse_multisig "a multisig with no time lock" "$REHEARSAL_MULTISIG_ZERO_TIME_LOCK" "the multisig has NO time lock (0 s)"
expect_refusal "an acknowledgement that is not the sentence" env MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK=yes bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK must be exactly upgrades-take-effect-at-once"
expect_refusal "the acknowledged multisig with no time lock, at another address than the vault's" env MAINNET_MULTISIG_ZERO_TIME_LOCK_ACK=upgrades-take-effect-at-once bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$REHEARSAL_MULTISIG_ZERO_TIME_LOCK" --yes
said "EXCEPTION (recorded): the multisig has NO time lock (0 s)"
said "is not vault 0 of multisig $REHEARSAL_MULTISIG_ZERO_TIME_LOCK"
expect_refusal "an expected threshold of 1" env MAINNET_MULTISIG_THRESHOLD=1 bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT"
said "MAINNET_MULTISIG_THRESHOLD must be an integer from 2 to 64"
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" | tail -1 | grep -q "Nothing is proposed yet" || { echo "FAIL: a refused proposal left something proposed" >&2; exit 1; }

step "R3-11: the hand-over does not replace the guardian unless --set-guardian names the new key"
NEW_GUARDIAN="$(solana-keygen pubkey "$WORK/other-keys/trellis_tab-keypair.json")"
expect_refusal "propose with a MAINNET_GUARDIAN that is not the guardian on chain" env MAINNET_GUARDIAN="$NEW_GUARDIAN" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "trellis_credits: the guardian on chain is $MAINNET_GUARDIAN, but MAINNET_GUARDIAN names $NEW_GUARDIAN. The hand-over does not replace a guardian by itself"
said "--set-guardian"
said "Nothing was sent"
expect_refusal "propose with a --guardian that is not the guardian on chain" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --guardian "$NEW_GUARDIAN" --yes
said "but --guardian names $NEW_GUARDIAN"
expect_refusal "--set-guardian naming the vault" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --set-guardian "$VAULT" --yes
said "--set-guardian names the multisig vault"
expect_refusal "--set-guardian naming the settlement key" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --set-guardian "$MAINNET_SETTLEMENT_AUTHORITY" --yes
said "--set-guardian names the settlement key"
expect_refusal "--set-guardian without a terminal to type the two keys on" bash -c 'bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$0" --multisig-account "$1" --set-guardian "$2" < /dev/null' "$VAULT" "$MS" "$NEW_GUARDIAN"
said "to confirm you will type exactly:  replace guardian ${MAINNET_GUARDIAN: -6} with ${NEW_GUARDIAN: -6}"
said "the confirmation must be typed"
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" | tail -1 | grep -q "Nothing is proposed yet" || { echo "FAIL: a refused guardian replacement left something proposed" >&2; exit 1; }
# With the flag: the old and the new key are shown, the confirmation names both, and the proposal carries the new guardian.
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --set-guardian "$NEW_GUARDIAN" --yes | tee "$WORK/set-guardian.log"
grep -q "REPLACES THE GUARDIAN: $MAINNET_GUARDIAN -> $NEW_GUARDIAN" "$WORK/set-guardian.log" && grep -q "confirmation \"replace guardian ${MAINNET_GUARDIAN: -6} with ${NEW_GUARDIAN: -6}\" skipped by --yes" "$WORK/set-guardian.log" || { echo "FAIL: the guardian replacement was not shown and confirmed with both keys" >&2; exit 1; }
jq -e --arg g "$NEW_GUARDIAN" --arg old "$MAINNET_GUARDIAN" '.handover.setGuardian.to == $g and .handover.setGuardian.from.trellis_credits == $old' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not carry the guardian replacement" >&2; exit 1; }
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" > "$WORK/status-guardian.log"
grep -q "hand-over to the vault and guardian -> $NEW_GUARDIAN" "$WORK/status-guardian.log" || { echo "FAIL: the status does not show that the pending hand-over replaces the guardian" >&2; exit 1; }
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-guardian.json" || true
jq -e '.checks["proposal.changes_guardian"] == false' "$WORK/monitor-guardian.json" >/dev/null || { echo "FAIL: the monitor did not report that a pending proposal changes the guardian" >&2; exit 1; }
bun scripts/mainnet/handover.ts cancel --rehearsal --multisig "$VAULT" --yes | tail -1
jq -e '.handover.setGuardian == null' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the cancelled guardian replacement is still in the record" >&2; exit 1; }

step "hand-over, phase 1 on the mainnet build: the proposal that leaves the guardian alone"
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --dry-run
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes | tee "$WORK/propose.log"
! grep -q "GUARDIAN" "$WORK/propose.log" || { echo "FAIL: a plain hand-over proposal touched the guardian" >&2; exit 1; }
jq -e --arg ms "$MS" '.handover.multisig.address == $ms and .handover.multisig.threshold == 2 and (.handover.multisig.members | length) == 3 and .handover.multisig.executedVaultTransaction.index == 1 and .handover.multisig.executedVaultTransaction.approvals == 2' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not carry the multisig as propose read it, with the vault transaction it executed" >&2; exit 1; }
grep -q "note: vault transaction 1 was executed (2 approval(s)" "$WORK/propose.log" || { echo "FAIL: propose did not say which executed vault transaction shows that the multisig works" >&2; exit 1; }
# R4-29: the proposal went through although a stranger had funded the pending-proposal address: the program took it over.
[ "$(solana account "$PENDING_ADDRESS" -u "$REHEARSAL_RPC_URL" --output json | jq -r .account.owner)" = "$(jq -r .programs.trellis_credits.programId "$TRELLIS_DEPLOYMENTS_FILE")" ] || { echo "FAIL: the pending-proposal address is not the program's after the proposal" >&2; exit 1; }
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes | tail -2
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" | tee "$WORK/status.log"
grep -q "in 24.0 h" "$WORK/status.log" || { echo "FAIL: the status does not show the 24 hour wait" >&2; exit 1; }
grep -q "the proposals expire 7.0 d after they become effective" "$WORK/status.log" || { echo "FAIL: the status does not show the 7 day expiry" >&2; exit 1; }
jq -e '.handover.proposals.trellis_credits | (.expiresAt - .effectiveAt) == 604800' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not carry the proposal's expiry" >&2; exit 1; }
# The guardian can pause and nothing else: its cancellation of the pending hand-over is refused by the program (RR-02).
expect_refusal "the guardian cancelling the pending hand-over" bun scripts/mainnet/rehearsal-probe.ts guardian-cancel
said "Unauthorized"
expect_refusal "resolve before the 24 hours have passed (print)" bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --print
said "the timelock has not passed"
expect_refusal "resolve before the 24 hours have passed (through the vault)" bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-proposed.json" || true
jq -e '.checks["config.proposed"] == false and .checks["proposal.changes_authority"] == false and .checks["proposal.changes_guardian"] == true and .checks["proposal.applicable"] == true and .checks["proposal.expiring"] == true and .checks["proposal.expired"] == true and .values["proposal.trellis_credits.state"] == "pending" and .values["proposal.trellis_credits.changes_authority"] == 1 and .values["proposal.trellis_credits.seconds_to_effective"] > 86000 and .values["config.proposals_pending"] == 1' "$WORK/monitor-proposed.json" >/dev/null || { echo "FAIL: the monitor did not report the pending proposal, its state and that it changes the authority" >&2; jq '{failing, details, values}' "$WORK/monitor-proposed.json" >&2; exit 1; }
echo "monitor: $(jq -r '.details["config.proposed"]' "$WORK/monitor-proposed.json" | cut -c1-160)"
# R3-20: a pending proposal fails verification (it may be for a new settlement key or a new authority), no report is
# written, and the below-floor probe that cannot run beside it is a failure too, not a note.
expect_refusal "verify while a proposal is pending" bun scripts/mainnet/verify.ts --rehearsal --write-report "${A[@]}"
said "FAIL no proposal is pending: a proposal is PENDING (pending): new authority $VAULT"
said "FAIL the below-floor probe (refund delay 72 h - 1 s) could not be run"
said "No report written"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-before.json" || { echo "FAIL: verify rewrote the report while a proposal was pending" >&2; exit 1; }
bun scripts/mainnet/handover.ts cancel --rehearsal --multisig "$VAULT" --yes
bun scripts/mainnet/verify.ts --rehearsal "${A[@]}" | grep "ok   no proposal is pending"
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" | tail -1

step "R5-16: the incident actions from a normal checkout: each is dry-run first, then sent, and the chain is read back"
CREDITS_ID="$(jq -r .programs.trellis_credits.programId "$TRELLIS_DEPLOYMENTS_FILE")"
if [ -n "${REHEARSAL_ROOT:-}" ]; then
  # Fresh ids: this working tree declares another id than the one that is deployed, as a normal checkout does on mainnet.
  [ "$(sed -n 's/^declare_id!("\(.*\)");.*/\1/p' programs/trellis_credits/src/lib.rs)" != "$CREDITS_ID" ] || { echo "FAIL: the working tree declares the deployed id; this is not a normal-checkout run" >&2; exit 1; }
  echo "this checkout declares $(sed -n 's/^declare_id!("\(.*\)");.*/\1/p' programs/trellis_credits/src/lib.rs) for trellis_credits; the deployment is at $CREDITS_ID (the record)"
  # The scripts that must NOT follow the record still refuse from here (R4-18 is unchanged).
  expect_refusal "verify.ts from a checkout whose declare_id! is not the deployment's" "${NC[@]}" bun scripts/mainnet/verify.ts --rehearsal "${A[@]}"
  said "trellis_credits: the deployments record names $CREDITS_ID, the source's declare_id! is"
fi
# (Printed for the authority: the guardian is in its cooldown here, and a signer that cannot pause gets no instruction.)
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --print --signer "$REHEARSAL_DEPLOYER" --settlements > "$WORK/pause-print.log" || true
grep -q "trellis_credits  *$CREDITS_ID  *(the deployments record)" "$WORK/pause-print.log" && grep -q "program $CREDITS_ID" "$WORK/pause-print.log" || { echo "FAIL: pause.ts did not build its instructions at the recorded program id" >&2; cat "$WORK/pause-print.log" >&2; exit 1; }
# A record that names another program id: the pause does not land somewhere else and call it a success.
jq --arg other "$OTHER_KEY" '.programs.trellis_credits.programId = $other | .reserved.trellis_credits = $other' "$TRELLIS_DEPLOYMENTS_FILE" > "$WORK/tampered-record.json"
expect_refusal "a pause against a record whose program id was changed" env TRELLIS_DEPLOYMENTS_FILE="$WORK/tampered-record.json" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --as-authority --yes
said "NOT PAUSED: trellis_credits"
expect_refusal "a pause whose --program-id is not the record's" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --as-authority --yes --program-id "trellis_credits=$OTHER_KEY"
said "--program-id names $OTHER_KEY, the deployments record names $CREDITS_ID"
# The authority pauses, renews and unpauses for real from the normal checkout (the guardian's own pause ran above, the same way).
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --as-authority --settlements --yes | tail -2
[ "$("${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --status | grep -c "PAUSED until")" -eq 2 ] || { echo "FAIL: the pause sent from a normal checkout is not on chain" >&2; exit 1; }
REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --renew --settlements --yes | tail -1
REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --unpause --settlements --yes | tail -1
[ "$("${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --status | grep -c "PAUSED until")" -eq 0 ] || { echo "FAIL: the unpause sent from a normal checkout did not lift the pauses" >&2; exit 1; }

# The settlement key is exposed: the authority (the operator key, before the hand-over) proposes a new one and the
# write-down of what the thief committed. 24 hours stand between that and the apply on this build; the apply itself is
# rehearsed in part 2, on the 30-second build.
NEW_SETTLEMENT="$(solana-keygen pubkey "$WORK/other-keys/trellis_bond-keypair.json")"
cc_shows "settlement key  *$MAINNET_SETTLEMENT_AUTHORITY"
cc_shows "spent / settled  *3,000 / 240 USDC"
"${CC[@]}" propose --rehearsal --settlement "$NEW_SETTLEMENT" --write-down | tee "$WORK/cc-propose-dry.log"
grep -q "DRY RUN: nothing is sent" "$WORK/cc-propose-dry.log" && grep -q "program $CREDITS_ID" "$WORK/cc-propose-dry.log" && grep -q "simulation: the chain accepts it" "$WORK/cc-propose-dry.log" && grep -q "Dry run: 1 instruction built and simulated. Nothing was sent." "$WORK/cc-propose-dry.log" || { echo "FAIL: the dry run of the settlement key proposal did not build, print and simulate it" >&2; exit 1; }
cc_shows "pending proposal  *none"
expect_refusal "config-change.ts --send without a terminal to type the confirmation on" bash -c '"$@" < /dev/null' bash "${CC[@]}" propose --rehearsal --settlement "$NEW_SETTLEMENT" --write-down --send
said "No terminal attached: the confirmation must be typed by the operator. Nothing was sent."
cc_shows "pending proposal  *none"
"${CC[@]}" propose --rehearsal --settlement "$NEW_SETTLEMENT" --write-down --send --yes | tee "$WORK/cc-propose.log"
grep -qF "(rehearsal: confirmation \"propose settlement ${NEW_SETTLEMENT: -6} write-down\" skipped by --yes)" "$WORK/cc-propose.log" || { echo "FAIL: the proposal was sent without its confirmation" >&2; exit 1; }
cc_shows "pending proposal  *settlement key -> $NEW_SETTLEMENT; write spent_total down to settled_total  *\[applicable in 24.0 h"
# The same proposal, read by the hand-over script and by the monitor: it is on chain, and it is not a hand-over.
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" > "$WORK/status-cc.log" || true
grep -q "NOT the hand-over (authority unchanged, settlement_authority, write_down_spent)" "$WORK/status-cc.log" || { echo "FAIL: the pending settlement key proposal is not what handover.ts reads on chain" >&2; cat "$WORK/status-cc.log" >&2; exit 1; }
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-cc.json" || true
jq -e '.checks["config.proposed"] == false and .values["config.proposals_pending"] == 1 and .checks["proposal.changes_authority"] == true' "$WORK/monitor-cc.json" >/dev/null || { echo "FAIL: the monitor did not report the pending settlement key proposal" >&2; jq '{failing, values}' "$WORK/monitor-cc.json" >&2; exit 1; }
# Twice: nothing more is sent. Too early: refused. A change the command does not name: never applied.
"${CC[@]}" propose --rehearsal --settlement "$NEW_SETTLEMENT" --write-down --send --yes | grep "Nothing to send: exactly this change is proposed already"
expect_refusal "apply before the 24 hours have passed" "${CC[@]}" apply --rehearsal --settlement "$NEW_SETTLEMENT" --write-down --send --yes
said "the timelock has not passed: applicable in 24.0 h"
expect_refusal "apply naming another key than the pending proposal carries" "${CC[@]}" apply --rehearsal --settlement "$OTHER_KEY" --write-down --send --yes
said "the pending proposal is NOT what this command names"
expect_refusal "a second proposal beside the pending one" "${CC[@]}" propose --rehearsal --guardian "$NEW_GUARDIAN" --send --yes
said "another proposal is pending"
# A proposal you did not make is cancelled: resolve_config(apply = false). Dry run, then sent, then read back.
"${CC[@]}" cancel --rehearsal | tee "$WORK/cc-cancel-dry.log"
grep -q "resolve_config(apply = false): drop the pending proposal" "$WORK/cc-cancel-dry.log" && grep -q "simulation: the chain accepts it" "$WORK/cc-cancel-dry.log" && grep -q "Nothing was sent" "$WORK/cc-cancel-dry.log" || { echo "FAIL: the dry run of the cancellation did not build and simulate it" >&2; exit 1; }
cc_shows "pending proposal  *settlement key -> $NEW_SETTLEMENT"
"${CC[@]}" cancel --rehearsal --send --yes | tail -3
cc_shows "pending proposal  *none"
cc_shows "settlement key  *$MAINNET_SETTLEMENT_AUTHORITY"
"${CC[@]}" cancel --rehearsal --send --yes | grep "Nothing to send: no proposal is pending"
bun scripts/mainnet/verify.ts --rehearsal "${A[@]}" | grep "ok   no proposal is pending"
# The guardian replacement and the clamp, as dry runs here (sent and applied in part 2).
"${CC[@]}" propose --rehearsal --guardian "$NEW_GUARDIAN" | grep "simulation: the chain accepts it"
"${CC[@]}" tighten --rehearsal --outflow-cap-usdc 1000 | grep "simulation: the chain accepts it"
expect_refusal "a key that already holds a role, named as the new settlement key" "${CC[@]}" propose --rehearsal --settlement "$MAINNET_GUARDIAN"
said "--settlement names the guardian"
cc_shows "outflow limit  *2000 bps of the vault per 24 h, at most 25,000 USDC"

step "memo mode: the anchorer key is rotated in one memo that the old key and the new key both sign"
fund "$MAINNET_ANCHORER" 0.1
NEXT="$WORK/anchorer-next.json"
solana-keygen new --no-bip39-passphrase --silent --outfile "$NEXT" >/dev/null
# R5-17: the script takes the two keys as FILES (mode 600), never from the environment; neither is printed. And it runs
# from a normal checkout (R5-16): it reads no program id.
ROTATE=("${NC[@]}" bun scripts/mainnet/anchorer-rotate.ts --rehearsal --yes)
expect_refusal "a rotation with the anchorer key in the environment" env ANCHORER_PRIVATE_KEY=in-the-environment "${ROTATE[@]}" --first-rotation --current-key-file "$REHEARSAL_ANCHORER_KEYPAIR" --next-key-file "$NEXT"
said "ANCHORER_PRIVATE_KEY is set in the environment"
# R3-21: without the history so far the printed ANCHORER_KEYS line would start at the current key. That is refused,
# unless the current key is said to be the first one (and its own history does not show otherwise).
expect_refusal "a rotation without ANCHORER_KEYS and without --first-rotation" "${ROTATE[@]}" --current-key-file "$REHEARSAL_ANCHORER_KEYPAIR" --next-key-file "$NEXT"
said "ANCHORER_KEYS is not set"
said "--first-rotation"
# The dry run first: the line is built and shown, nothing lands (the new key has signed nothing afterwards).
"${ROTATE[@]}" --first-rotation --dry-run --current-key-file "$REHEARSAL_ANCHORER_KEYPAIR" --next-key-file "$NEXT" | tee "$WORK/rotate-dry.log"
grep -q "Dry run: nothing was sent" "$WORK/rotate-dry.log" && grep -q "line  *trellis:anchorer:v1:" "$WORK/rotate-dry.log" || { echo "FAIL: the anchorer rotation's dry run did not show the line and stop" >&2; exit 1; }
[ "$(tx_count "$(solana-keygen pubkey "$NEXT")")" -eq 0 ] || { echo "FAIL: the dry run of the anchorer rotation sent a transaction" >&2; exit 1; }
"${ROTATE[@]}" --first-rotation --current-key-file "$REHEARSAL_ANCHORER_KEYPAIR" --next-key-file "$NEXT" | tee "$WORK/rotate.log"
# On chain: the rotation is a transaction the new key signed too.
[ "$(tx_count "$(solana-keygen pubkey "$NEXT")")" -eq 1 ] || { echo "FAIL: the anchorer rotation is not on chain as a transaction of the new key" >&2; exit 1; }
KEYS="$(sed -n 's/^ANCHORER_KEYS=//p' "$WORK/rotate.log")"
[ -n "$KEYS" ] || { echo "FAIL: the rotation printed no ANCHORER_KEYS line" >&2; exit 1; }
# The router loads the printed history with the new key as the current one, and refuses it with the old key.
ANCHORER_KEYS="$KEYS" ANCHORER_ADDRESS="$(solana-keygen pubkey "$NEXT")" bun -e 'import { loadConfig } from "./src/config.ts"; const c = loadConfig({ ANCHORER_KEYS: process.env.ANCHORER_KEYS, ANCHORER_ADDRESS: process.env.ANCHORER_ADDRESS }); if (c.launch.anchor.anchorers.length !== 2 || c.launch.anchor.anchorers[1].rotationTx === null) process.exit(1); console.log("the router loads the two-key history; current anchorer " + c.launch.anchor.anchorer);'
expect_refusal "the old anchorer key with the new key history" env ANCHORER_KEYS="$KEYS" ANCHORER_ADDRESS="$MAINNET_ANCHORER" bun -e 'import { loadConfig } from "./src/config.ts"; loadConfig({ ANCHORER_KEYS: process.env.ANCHORER_KEYS, ANCHORER_ADDRESS: process.env.ANCHORER_ADDRESS });'
said "must end with the current anchorer key"
expect_refusal "a rotation whose hour is already over" "${ROTATE[@]}" --first-rotation --from-hour 3600 --current-key-file "$REHEARSAL_ANCHORER_KEYPAIR" --next-key-file "$NEXT"
said "must be announced before the end of the hour"
# The key that was just handed the role is not a first key: rotating it on without the history is refused from its own transactions.
NEXT2="$WORK/anchorer-next2.json"
solana-keygen new --no-bip39-passphrase --silent --outfile "$NEXT2" >/dev/null
fund "$(solana-keygen pubkey "$NEXT")" 0.1
expect_refusal "the second rotation without ANCHORER_KEYS, claiming to be the first" "${ROTATE[@]}" --first-rotation --current-key-file "$NEXT" --next-key-file "$NEXT2"
said "so it is not the first anchorer"
said "Set ANCHORER_KEYS to the router's"
# With the history, the second rotation goes through and the printed line keeps all three keys.
ANCHORER_KEYS="$KEYS" "${ROTATE[@]}" --from-hour "$(( ($(date +%s) / 3600 + 2) * 3600 ))" --current-key-file "$NEXT" --next-key-file "$NEXT2" | tee "$WORK/rotate2.log"
[ "$(sed -n 's/^ANCHORER_KEYS=//p' "$WORK/rotate2.log" | jq 'length')" -eq 3 ] && [ "$(sed -n 's/^ANCHORER_KEYS=//p' "$WORK/rotate2.log" | jq -r '.[0].key')" = "$MAINNET_ANCHORER" ] || { echo "FAIL: the second rotation dropped an earlier key from the printed history" >&2; exit 1; }

step "a later tier: payments on top of credits deploys only what is missing"
fund "$REHEARSAL_DEPLOYER" 4
scripts/mainnet/deploy.sh --rehearsal --tier payments --skip-idl --yes "${A[@]}" | tee "$WORK/deploy-payments.log"
grep -q "About to deploy: trellis_anchor trellis_tab$" "$WORK/deploy-payments.log" || { echo "FAIL: the payments tier did not deploy exactly the two missing programs" >&2; exit 1; }
bun scripts/mainnet/init.ts --rehearsal --tier payments --yes | tee "$WORK/init-payments.log"
grep -q "trellis_credits .*exists with the expected authority; skip" "$WORK/init-payments.log" || { echo "FAIL: init touched the credits config again" >&2; exit 1; }
bun scripts/mainnet/verify.ts --rehearsal --write-report --allow-dirty --env | tee "$WORK/verify-payments.log" | tail -45
grep -q "^LAUNCH_TIER=payments" "$WORK/verify-payments.log" && grep -q "^ANCHOR_MODE=program" "$WORK/verify-payments.log" || { echo "FAIL: the router env block is not the payments tier in program mode" >&2; exit 1; }
[ "$(grep -c "ok   build_profile read on chain: profile 0, .*: the mainnet build (all" "$WORK/verify-payments.log")" -eq 3 ] || { echo "FAIL: not every one of the three deployed programs reported the mainnet build profile on chain" >&2; exit 1; }
grep -q "ok   build_profile read on chain: profile 0, config_timelock 86400 s, root_retention 34560000 s, proposal_ttl 604800 s: the mainnet build (all 3 floors)" "$WORK/verify-payments.log" || { echo "FAIL: trellis_anchor did not report its build profile on chain" >&2; exit 1; }
bun scripts/mainnet/rehearsal-guard.ts
jq -e '.tier == "payments" and ([.programs[] | select(.status == "deployed")] | length) == 3' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record is not a three-program payments tier" >&2; exit 1; }
# R3-08, the review's sequence up to the 24 hours: the environment still says `credits` after `payments` was deployed
# and initialised with --tier. Nothing reads green over part of what is deployed, and nothing is marked done.
cp "$DIR/deployment.verification.json" "$WORK/report-payments.json"
expect_refusal "verify with MAINNET_TIER=credits over a payments deployment" env MAINNET_TIER=credits bun scripts/mainnet/verify.ts --rehearsal --write-report "${A[@]}"
said "trellis_anchor, trellis_tab are deployed but not covered by the selection (tier credits: trellis_credits)"
expect_refusal "verify --expect multisig with MAINNET_TIER=credits over a payments deployment" env MAINNET_TIER=credits bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report "${A[@]}"
said "the deployer key still holds: trellis_credits upgrade, trellis_anchor upgrade, trellis_tab upgrade, trellis_credits authority, trellis_tab authority"
expect_refusal "handover.ts check with MAINNET_TIER=credits over a payments deployment" env MAINNET_TIER=credits bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT"
said "HANDOVER INCOMPLETE"
said "trellis_tab .*outside the selected tier (credits)"
expect_refusal "handover.ts propose with MAINNET_TIER=credits over a payments deployment" env MAINNET_TIER=credits bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "Nothing was sent"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-payments.json" && jq -e '.handover.at == null and .tier == "payments"' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: a narrower selection rewrote the report or the record" >&2; exit 1; }
# R3-21 (residual): with everything deployed, deploy.sh sends nothing; what is left is a rewrite of the record, which
# needs its own confirmation, and no run changes which key the record calls the operator.
cp "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-rewrite.json"
expect_refusal "deploy.sh with nothing to deploy and no terminal to confirm the rewrite of the record on" bash -c 'scripts/mainnet/deploy.sh --rehearsal --tier payments --skip-idl --allow-dirty < /dev/null'
said "Every requested program is already deployed"
said "Nothing is rewritten without the typed confirmation: rewrite the rehearsal record"
said "No terminal attached: the confirmation must be typed by the operator. Nothing was sent."
expect_refusal "deploy.sh with a deployer keypair that is not the record's deployer" env REHEARSAL_DEPLOYER_KEYPAIR="$WORK/other-keys/trellis_bond-keypair.json" scripts/mainnet/deploy.sh --rehearsal --tier payments --skip-idl --yes "${A[@]}"
said "the deployments record names $REHEARSAL_DEPLOYER as the deployer"
said "this run's deployer keypair is $(solana-keygen pubkey "$WORK/other-keys/trellis_bond-keypair.json")"
cmp -s "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-rewrite.json" || { echo "FAIL: a refused deploy.sh rewrote the deployments record" >&2; exit 1; }
echo "the deployments record is byte for byte what it was after both refused runs"
# And a later run with the narrower tier does not shrink the record's tier.
scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl --yes "${A[@]}" | tee "$WORK/deploy-rewrite.log" | tail -3
grep -q '(rehearsal: confirmation "rewrite the rehearsal record" skipped by --yes)' "$WORK/deploy-rewrite.log" || { echo "FAIL: deploy.sh rewrote the record without its confirmation" >&2; exit 1; }
jq -e '.tier == "payments" and (.selected | length) == 3' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: deploy.sh --tier credits shrank the record of a payments deployment" >&2; exit 1; }
solana balance "$REHEARSAL_DEPLOYER" -u "$REHEARSAL_RPC_URL"

step "R5-17: a program that is already deployed under an upgrade authority deploy.sh does not expect stops the run"
# The last step on this validator: trellis_tab's upgrade authority is handed to a key nobody here holds (as if the
# program had been deployed, or taken, by somebody else). deploy.sh used to record it as deployed and go on.
TAB_ID="$(jq -r .programs.trellis_tab.programId "$TRELLIS_DEPLOYMENTS_FILE")"
solana program set-upgrade-authority "$TAB_ID" --new-upgrade-authority "$OTHER_KEY" --skip-new-upgrade-authority-signer-check -k "$REHEARSAL_DEPLOYER_KEYPAIR" -u "$REHEARSAL_RPC_URL" >/dev/null
expect_refusal "deploy.sh over a program whose upgrade authority is neither the deployer nor the recorded vault" scripts/mainnet/deploy.sh --rehearsal --tier payments --skip-idl --yes "${A[@]}"
said "STOP: trellis_tab is already deployed, and the chain names $OTHER_KEY as its upgrade authority: neither the deployer $REHEARSAL_DEPLOYER nor the vault"
jq -e --arg op "$REHEARSAL_DEPLOYER" '.programs.trellis_tab.upgradeAuthority == $op' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: deploy.sh recorded an upgrade authority it had just refused" >&2; exit 1; }
echo "the record still names the deployer for trellis_tab: nothing was recorded for the program that was found under another key"
fi

# =================================================================================================================================
if [ "$ONLY" != "1" ]; then
step "PART 2: the hand-over end to end, credits first and the other seven added afterwards, on devnet-feature binaries (30 s timelock; rehearsal only)"
# This validator's multisig account has never created a transaction: the stand-in vault program creates no Squads
# transaction, so "untested" is simply true here, and the bypass that accepts it is exercised for real.
start_validator part2 "${VALIDATOR_ACCOUNTS_UNTESTED[@]}"
fund "$REHEARSAL_DEPLOYER" 40
fund "$VAULT" 1
fund "$MAINNET_GUARDIAN" 0.01
D=(--prebuilt "$DEVNET_SO_DIR" --allow-devnet-build "${A[@]}")
# verify on this validator: the devnet build is accepted, the chain is compared with the directory that was deployed,
# and the untested multisig is accepted as a recorded exception.
V=(--allow-devnet-build --allow-dirty --build-dir "$DEVNET_SO_DIR")
U=(--multisig-untested-ok)
monitor() { bun scripts/monitor.ts --once --cluster rehearsal --json > "$1" || true; }

step "launch tier credits: init --prepare, deploy, init"
bun scripts/mainnet/init.ts --rehearsal --tier credits --prepare --yes
scripts/mainnet/deploy.sh --rehearsal --tier credits --skip-idl "${D[@]}" --yes
bun scripts/mainnet/init.ts --rehearsal --yes | tail -2

step "R5-16: a made-up spent root is written down and the outflows are clamped at once: tighten, propose, 30 s (24 h on mainnet), apply, by the operator key"
fund "$MAINNET_SETTLEMENT_AUTHORITY" 1
bun scripts/mainnet/rehearsal-settle.ts made-up-root 100
cc_shows "spent / settled  *100 / 0 USDC  *(100 committed and not paid out)"
cc_shows "outflow limit  *2000 bps of the vault per 24 h, at most 25,000 USDC"
# The clamp (closure refunds are not stopped by any pause; this is their brake): dry run, sent, read back, sent again.
"${CC[@]}" tighten --rehearsal --outflow-cap-usdc 1000 | tee "$WORK/cc-tighten-dry.log"
grep -q "update_config (at once): outflow cap per 24 h -> 1,000 USDC" "$WORK/cc-tighten-dry.log" && grep -q "simulation: the chain accepts it" "$WORK/cc-tighten-dry.log" && grep -q "Nothing was sent" "$WORK/cc-tighten-dry.log" || { echo "FAIL: the dry run of the clamp did not build and simulate it" >&2; exit 1; }
cc_shows "at most 25,000 USDC"
"${CC[@]}" tighten --rehearsal --outflow-cap-usdc 1000 --send --yes | tail -2
cc_shows "outflow limit  *2000 bps of the vault per 24 h, at most 1,000 USDC"
"${CC[@]}" tighten --rehearsal --outflow-cap-usdc 1000 --send --yes | grep "Nothing to send: the chain already carries exactly these values"
expect_refusal "raising the cap again with tighten" "${CC[@]}" tighten --rehearsal --outflow-cap-usdc 25000 --send --yes
said "that loosens, and loosening waits 24 hours"
expect_refusal "verify while the outflow cap is clamped" bun scripts/mainnet/verify.ts --rehearsal "${V[@]}"
said "FAIL outflow limiter: cap per window"
# The way back, and the write-down, in one proposal: proposed, refused before its timelock, applied after it.
"${CC[@]}" propose --rehearsal --write-down --outflow-cap-usdc 25000 | grep "simulation: the chain accepts it"
"${CC[@]}" propose --rehearsal --write-down --outflow-cap-usdc 25000 --send --yes | tail -2
cc_shows "pending proposal  *write spent_total down to settled_total; outflow cap per 24 h -> 25,000 USDC"
expect_refusal "apply inside the timelock" "${CC[@]}" apply --rehearsal --write-down --outflow-cap-usdc 25000 --send --yes
said "the timelock has not passed"
sleep 34
"${CC[@]}" apply --rehearsal --write-down --outflow-cap-usdc 25000 | tee "$WORK/cc-apply-dry.log"
grep -q "resolve_config(apply = true)" "$WORK/cc-apply-dry.log" && grep -q "simulation: the chain accepts it" "$WORK/cc-apply-dry.log" && grep -q "Nothing was sent" "$WORK/cc-apply-dry.log" || { echo "FAIL: the dry run of the apply did not build and simulate it" >&2; exit 1; }
cc_shows "spent / settled  *100 / 0 USDC"
"${CC[@]}" apply --rehearsal --write-down --outflow-cap-usdc 25000 --send --yes | tail -2
cc_shows "spent / settled  *0 / 0 USDC$"
cc_shows "outflow limit  *2000 bps of the vault per 24 h, at most 25,000 USDC"
cc_shows "pending proposal  *none"
"${CC[@]}" apply --rehearsal --write-down --outflow-cap-usdc 25000 --send --yes | grep "Nothing to send: no proposal is pending and the chain already carries this change"

step "R3-09: a multisig that has never created a transaction is refused, and accepted only as a RECORDED exception"
expect_refusal "propose to a multisig that never created a transaction" bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes
said "this multisig has never created a transaction"
said "Nothing was sent"
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes "${U[@]}" | tee "$WORK/propose-untested.log"
grep -q "EXCEPTION (recorded): this multisig has never created a transaction; accepted with --multisig-untested-ok" "$WORK/propose-untested.log" && grep -q "Proposed WITH 1 RECORDED EXCEPTION (multisig-untested-ok)" "$WORK/propose-untested.log" || { echo "FAIL: the bypass was not said and recorded at propose" >&2; exit 1; }
jq -e '.handover.exceptions | length == 1 and .[0].id == "multisig-untested-ok" and .[0].phase == "propose"' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not carry the bypass" >&2; exit 1; }

step "hand over credits: wait out the (devnet) timelock, resolve as the vault with the operator co-signing, check"
sleep 34
expect_refusal "resolve through a multisig that never created a transaction, without the bypass" bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes
said "this multisig has never created a transaction"
bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes "${U[@]}"
expect_refusal "check without the bypass" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT"
said "HANDOVER INCOMPLETE"
said "the multisig: this multisig has never created a transaction"
jq -e '.handover.at == null' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: a refused check marked the hand-over done" >&2; exit 1; }
bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}" | tee "$WORK/check-credits.log"
grep -q "No authority and no role remains on the operator key, and no proposal is pending, on any of the 1 deployed program(s)" "$WORK/check-credits.log" && grep -q "HAND-OVER RECORDED WITH 1 RECORDED EXCEPTION (multisig-untested-ok): not a plain pass" "$WORK/check-credits.log" || { echo "FAIL: check did not record the hand-over with its exception" >&2; exit 1; }
jq -e --arg v "$VAULT" '.handover.at != null and .authorities.authority == $v and .handover.multisig.transactionsCreated == 0 and (.handover.exceptions | length) == 1' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record of the credits hand-over is incomplete" >&2; exit 1; }
expect_refusal "verify --expect multisig without the bypass" bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report "${V[@]}"
said "this multisig has never created a transaction"
[ ! -e "$DIR/deployment.verification.json" ] || { echo "FAIL: a refused verification wrote a report" >&2; exit 1; }
bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report "${V[@]}" "${U[@]}" | tee "$WORK/verify-credits-handed.log" | tail -6
grep -q "^all checks passed, WITH 1 RECORDED EXCEPTION (multisig-untested-ok): not a plain pass$" "$WORK/verify-credits-handed.log" || { echo "FAIL: a verification that used a bypass reads as a plain pass" >&2; exit 1; }
! grep -q "^all checks passed$" "$WORK/verify-credits-handed.log" || { echo "FAIL: a verification that used a bypass reads as a plain pass" >&2; exit 1; }
jq -e --arg ms "$MS" --arg v "$VAULT" '(.exceptions | map(.id)) == ["multisig-untested-ok"] and (.checks[] | select(.id == "multisig.account") | .status == "warn" and .evidence.address == $ms and .evidence.vault == $v and .evidence.derivedVault == $v and .evidence.threshold == 2 and .evidence.timeLockSeconds == 3600 and .evidence.transactionsCreated == 0 and (.evidence.members | length) == 3) and (.checks[] | select(.id == "roles.operator_key") | .evidence.onOperatorKey == [])' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the report does not carry the multisig that was read and the bypass" >&2; exit 1; }
bun scripts/mainnet/rehearsal-guard.ts > "$WORK/guard-credits.log"
head -1 "$WORK/guard-credits.log"

step "R3-08: the other seven programs are deployed and initialised with --tier; the environment still says credits"
bun scripts/mainnet/init.ts --rehearsal --tier full --prepare --yes
scripts/mainnet/deploy.sh --rehearsal --tier full --skip-idl "${D[@]}" --yes | tee "$WORK/deploy-full.log" | tail -4
grep -q "About to deploy: trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements$" "$WORK/deploy-full.log" || { echo "FAIL: the full tier did not deploy exactly the seven missing programs" >&2; exit 1; }
bun scripts/mainnet/init.ts --rehearsal --tier full --yes | tail -2
cp "$DIR/deployment.verification.json" "$WORK/report-credits-handed.json"
cp "$TRELLIS_DEPLOYMENTS_FILE" "$WORK/record-before-narrow.json"
# The review's sequence: with MAINNET_TIER=credits both commands looked at one program, held by the vault, and said done.
expect_refusal "handover.ts check with MAINNET_TIER=credits after seven more programs were deployed" env MAINNET_TIER=credits bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}"
said "HANDOVER INCOMPLETE. Nothing was recorded."
said "trellis_anchor, trellis_rules, trellis_tab, trellis_bond, trellis_fee_router, trellis_capacity, trellis_measurements are deployed but not covered by the selection (tier credits: trellis_credits)"
said "trellis_tab  *OPERATOR .*OPERATOR .*outside the selected tier (credits)"
said "still on the operator key: .*trellis_tab upgrade.*trellis_tab authority"
expect_refusal "handover.ts check --tier credits (the flag) after seven more programs were deployed" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" --tier credits "${U[@]}"
said "HANDOVER INCOMPLETE"
expect_refusal "verify --expect multisig --write-report with MAINNET_TIER=credits after seven more programs were deployed" env MAINNET_TIER=credits bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report "${V[@]}" "${U[@]}"
said "are deployed but not covered by the selection (tier credits: trellis_credits)"
said "the deployer key still holds: .*trellis_tab upgrade.*trellis_tab authority"
said "No report written"
expect_refusal "verify --tier minimal over eight deployed programs" bun scripts/mainnet/verify.ts --rehearsal --tier minimal --expect multisig --write-report "${V[@]}" "${U[@]}"
said "not covered by the selection (tier minimal: no program)"
expect_refusal "handover.ts check --tier minimal over eight deployed programs" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" --tier minimal "${U[@]}"
said "HANDOVER INCOMPLETE"
# And with the whole deployment selected it is refused as well, for the right reason: seven programs are on the operator key.
expect_refusal "handover.ts check over all eight before the seven are handed over" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}"
said "the operator key still holds: trellis_anchor upgrade, trellis_rules upgrade, trellis_rules authority, trellis_tab upgrade, trellis_tab authority"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-credits-handed.json" || { echo "FAIL: a refused verification rewrote the report" >&2; exit 1; }
[ "$(jq -S 'del(.updatedAt)' "$TRELLIS_DEPLOYMENTS_FILE")" = "$(jq -S 'del(.updatedAt)' "$WORK/record-before-narrow.json")" ] || { echo "FAIL: a refused check rewrote the deployments record" >&2; exit 1; }
echo "neither the report nor the record was touched by the refused runs"

step "verify refuses the devnet build unless the rehearsal says so, and then names it: all eight programs say profile 1 themselves"
expect_refusal "verify on devnet-feature binaries without --allow-devnet-build" bun scripts/mainnet/verify.ts --rehearsal --allow-dirty --build-dir "$DEVNET_SO_DIR" "${U[@]}"
[ "$(grep -c "FAIL build_profile read on chain: profile 1, .*: the devnet build \[profile is 1 (the .devnet. cargo feature), the mainnet build reports 0; " "$WORK/refusal.log")" -eq 8 ] || { echo "FAIL: verify did not refuse each of the eight devnet-feature programs by its own build_profile" >&2; cat "$WORK/refusal.log" >&2; exit 1; }
said "FAIL config timelock read on chain: 30 s; the mainnet build has 86400"
# R4-17: the hand-over of credits is recorded, and seven programs now sit on the operator key. Verification fails for
# that reason and that reason alone, with or without --expect, and no report is written (before, this run was green
# and --write-report wrote ok: true).
expect_refusal "verify (no --expect) with the hand-over recorded and seven later programs on the operator key" bun scripts/mainnet/verify.ts --rehearsal --write-report "${V[@]}" "${U[@]}"
cp "$WORK/refusal.log" "$WORK/verify-devnet.log"
said "FAIL the hand-over is recorded as complete (.*) and it is not: trellis_anchor upgrade is held by the operator key, trellis_rules upgrade is held by the operator key"
said "trellis_tab authority is held by the operator key"
said "^1 check(s) FAILED:"
said "the hand-over is recorded as complete and .* are not the vault's"
said "No report written"
expect_refusal "verify --expect operator with the hand-over recorded" bun scripts/mainnet/verify.ts --rehearsal --expect operator --write-report "${V[@]}" "${U[@]}"
said "FAIL the hand-over is recorded as complete"
cmp -s "$DIR/deployment.verification.json" "$WORK/report-credits-handed.json" || { echo "FAIL: a verification that failed on the recorded hand-over rewrote the report" >&2; exit 1; }
# R4-18: an older copy of the record, from before trellis_tab was deployed, hides nothing: its id is the source's.
jq 'del(.programs.trellis_tab) | del(.reserved.trellis_tab) | del(.configs.trellis_tab) | .selected = ["trellis_credits"] | .tier = "credits" | del(.handover.at)' "$TRELLIS_DEPLOYMENTS_FILE" > "$WORK/older-record.json"
expect_refusal "handover.ts check against a copy of the record that does not name trellis_tab" env TRELLIS_DEPLOYMENTS_FILE="$WORK/older-record.json" bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}"
said "HANDOVER INCOMPLETE"
said "trellis_tab  *OPERATOR .*OPERATOR .*deployed at its reserved id but not listed in the deployments record"
jq -e '.handover.at == null' "$WORK/older-record.json" >/dev/null || { echo "FAIL: a refused check marked the hand-over done in the older record" >&2; exit 1; }
expect_refusal "verify against a copy of the record that does not name trellis_tab" env TRELLIS_DEPLOYMENTS_FILE="$WORK/older-record.json" bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report "${V[@]}" "${U[@]}"
said "deployed at the ids this deployment reserves: trellis_credits, trellis_anchor, trellis_rules, trellis_tab"
said "are deployed but not covered by the selection (tier credits: trellis_credits)"
[ ! -e "$WORK/older-record.verification.json" ] || { echo "FAIL: a report was written beside the older record" >&2; exit 1; }
jq --arg other "$(solana-keygen pubkey "$DIR/keys/member-1.json")" '.reserved.trellis_rules = $other' "$TRELLIS_DEPLOYMENTS_FILE" > "$WORK/edited-record.json"
expect_refusal "verify against a record whose id for trellis_rules is not the source's declare_id!" env TRELLIS_DEPLOYMENTS_FILE="$WORK/edited-record.json" bun scripts/mainnet/verify.ts --rehearsal "${V[@]}" "${U[@]}"
said "trellis_rules: the deployments record names .*, the source's declare_id! is"
[ "$(grep -c "ok   build_profile read on chain: profile 1, .*: the devnet build (accepted for this rehearsal only)" "$WORK/verify-devnet.log")" -eq 8 ] || { echo "FAIL: verify --allow-devnet-build did not read build_profile of all eight programs" >&2; exit 1; }
[ "$(grep -c "ok   source equivalence: the on-chain bytes equal .*re-hashed --build-dir (rehearsal only" "$WORK/verify-devnet.log")" -eq 8 ] || { echo "FAIL: verify did not compare all eight programs with the build directory" >&2; exit 1; }

step "a pause lapses by itself (60 s on the devnet build, 72 h on mainnet): the monitor says so before and after"
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --only trellis_tab --yes
monitor "$WORK/monitor-pause-running.json"
jq -e '.checks["pause.none"] == false and .checks["pause.expiring"] == false and .checks["pause.lapsed"] == true and .values["pause.trellis_tab.active"] == 1 and .values["pause.trellis_tab.by"] == "guardian" and .values["build.trellis_tab.profile"] == 1 and (.skipped["build.profile"] | length) > 0' "$WORK/monitor-pause-running.json" >/dev/null || { echo "FAIL: the monitor did not report the running pause and that it lapses soon" >&2; jq '{failing, details, values, skipped}' "$WORK/monitor-pause-running.json" >&2; exit 1; }
echo "monitor, while it runs: $(jq -r '.details["pause.expiring"]' "$WORK/monitor-pause-running.json" | cut -c1-120)"
sleep 63
monitor "$WORK/monitor-pause-lapsed.json"
jq -e '.checks["pause.none"] == true and .checks["pause.lapsed"] == false and .checks["guardian.pause_ready"] == false and .values["pause.trellis_tab.active"] == 0 and .values["pause.trellis_tab.lapsed"] == 1' "$WORK/monitor-pause-lapsed.json" >/dev/null || { echo "FAIL: the monitor did not report the lapsed pause" >&2; jq '{failing, details, values}' "$WORK/monitor-pause-lapsed.json" >&2; exit 1; }
echo "monitor, after it lapsed: $(jq -r '.details["pause.lapsed"]' "$WORK/monitor-pause-lapsed.json" | cut -c1-150)"
# (verify still fails here on the recorded hand-over, R4-17, and on nothing else: the lapsed pause is a note, not a failure.)
bun scripts/mainnet/verify.ts --rehearsal "${V[@]}" "${U[@]}" > "$WORK/verify-lapsed.log" || true
grep "trellis_tab: the pause flag is still set but the pause lapsed" "$WORK/verify-lapsed.log" || { echo "FAIL: verify did not note the lapsed pause" >&2; exit 1; }
grep -q "^1 check(s) FAILED:" "$WORK/verify-lapsed.log" && grep -q "^  - the hand-over is recorded as complete" "$WORK/verify-lapsed.log" && ! grep -q "FAIL .*PAUSED until" "$WORK/verify-lapsed.log" || { echo "FAIL: verify treats a lapsed pause as a pause" >&2; exit 1; }
REHEARSAL_GUARDIAN_KEYPAIR=/nonexistent "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --unpause --only trellis_tab --yes | tee "$WORK/pause-clear.log"
grep -q "trellis_tab: clear the flag of the lapsed pause" "$WORK/pause-clear.log" || { echo "FAIL: the authority did not clear the lapsed pause's flag" >&2; exit 1; }

step "hand-over of the seven, phase 1: propose (credits is skipped: the vault holds it)"
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes "${U[@]}" | tee "$WORK/propose-seven.log" | tail -14
grep -q "the vault already holds the config authority" "$WORK/propose-seven.log" || { echo "FAIL: propose did not skip the program that is handed over already" >&2; exit 1; }
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT"
expect_refusal "resolve inside the timelock" bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes "${U[@]}"
said "the timelock has not passed"

step "wait out the (devnet) timelock"
sleep 34
bun scripts/mainnet/handover.ts status --rehearsal --multisig "$VAULT" | tee "$WORK/status-ready.log" | tail -2
grep -q "ready; expires in" "$WORK/status-ready.log" && grep -q "execute the vault transactions before" "$WORK/status-ready.log" || { echo "FAIL: the status does not say the proposals are resolvable and until when" >&2; exit 1; }
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-applicable.json" || true
jq -e '.checks["proposal.applicable"] == false and .checks["proposal.expiring"] == false and .checks["proposal.changes_authority"] == false and .checks["proposal.expired"] == true and .values["config.proposals_pending"] == 6 and .values["proposal.trellis_fee_router.state"] == "applicable" and .values["proposal.trellis_measurements.state"] == "applicable"' "$WORK/monitor-applicable.json" >/dev/null || { echo "FAIL: the monitor did not report the six proposals as applicable and about to expire" >&2; jq '{failing, details, values}' "$WORK/monitor-applicable.json" >&2; exit 1; }
echo "monitor: $(jq -r '.details["proposal.applicable"]' "$WORK/monitor-applicable.json" | cut -c1-160)"

step "hand-over, phase 2: the vault transactions, printed as the multisig would receive them"
bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --print "${U[@]}" | tee "$WORK/resolve-print.log" | tail -12
jq -e '(.transactions | length) == 7 and ([.transactions[] | select(.program != "trellis_measurements" and .program != "trellis_anchor") | .coSigners | length == 1] | all)' "$DIR/deployment.handover-resolve.json" >/dev/null || { echo "FAIL: the resolve file does not list seven vault transactions with the operator as co-signer" >&2; exit 1; }

step "the vault alone is not enough: without the operator's signature nothing resolves"
expect_refusal "the resolving instructions sent as the vault but without the operator co-signing" env VAULT="$VAULT" MS="$MS" bun -e '
import { Keypair, Transaction, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { assertCluster, connect, loadRecord, recordedIds, rpcUrl } from "./scripts/mainnet/lib.ts";
import { resolveInstructions } from "./scripts/mainnet/plan.ts";
import { rehearsalVaultExecuteIx } from "./scripts/mainnet/squads.ts";
const conn = connect(rpcUrl("rehearsal")); const genesis = await assertCluster(conn, "rehearsal");
const rec = loadRecord("rehearsal", genesis); const ids = recordedIds(rec, ["trellis_tab"]);
const stranger = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(stranger.publicKey, 1e9), "confirmed");
const ix = rehearsalVaultExecuteIx(new PublicKey(process.env.MS), resolveInstructions("trellis_tab", ids.trellis_tab, { operator: new PublicKey(rec.deployer), vault: new PublicKey(process.env.VAULT), config: true, upgrade: true }));
for (const k of ix.keys) if (k.pubkey.toBase58() === rec.deployer) k.isSigner = false;
await sendAndConfirmTransaction(conn, new Transaction().add(ix), [stranger], { commitment: "confirmed" }); console.log("ACCEPTED");'
said "InvalidAccount"

step "hand-over, phase 2: resolve as the vault, with the operator co-signing"
bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes "${U[@]}"
bun scripts/mainnet/handover.ts resolve --rehearsal --multisig "$VAULT" --multisig-account "$MS" --via-rehearsal-vault --yes "${U[@]}" | tail -1
# A narrower selection is still refused, now that everything IS handed over: what is looked at never depends on it.
expect_refusal "check with MAINNET_TIER=credits after all eight were handed over" env MAINNET_TIER=credits bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}"
said "are deployed but not covered by the selection"
bun scripts/mainnet/handover.ts check --rehearsal --multisig "$VAULT" "${U[@]}" | tee "$WORK/check-all.log"
grep -q "No authority and no role remains on the operator key, and no proposal is pending, on any of the 8 deployed program(s)" "$WORK/check-all.log" || { echo "FAIL: check did not cover all eight programs" >&2; exit 1; }
jq -e '(.handover.resolved | length) == 8' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not list eight resolved hand-overs" >&2; exit 1; }
bun scripts/mainnet/handover.ts propose --rehearsal --multisig "$VAULT" --multisig-account "$MS" --yes "${U[@]}" | tail -1

step "after the hand-over: the operator key can change nothing and can neither pause nor unpause"
expect_refusal "operator update_config after the hand-over" bun scripts/mainnet/rehearsal-probe.ts
expect_refusal "a pause by the operator key after the hand-over (--as-authority: it is the authority no more)" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --as-authority --yes
said "Nothing to send"
said "NOT PAUSED: trellis_credits.deposits, trellis_tab, trellis_bond, trellis_capacity, trellis_rules"
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --unpause --print --signer "$VAULT" | tail -2
echo "the guardian key can still pause in one transaction (printed, not sent, so the deployment stays unpaused):"
# (trellis_tab is left out: the guardian paused it above and may still be in its cooldown there, which --print reports
# as NOT PAUSED with exit 1, as it must: R4-29.)
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --print --signer "$MAINNET_GUARDIAN" --only trellis_credits,trellis_bond,trellis_capacity,trellis_rules --settlements | tail -1

step "verify (multisig stage) with the production-guard report and the router env"
bun scripts/mainnet/verify.ts --rehearsal --expect multisig --write-report --env "${V[@]}" "${U[@]}" | tee "$WORK/verify-final.log"
grep -q "ok   the deployer key holds no authority and no role on any of the 8 deployed program(s)" "$WORK/verify-final.log" && grep -q "ok   every upgrade authority and config authority is the multisig vault" "$WORK/verify-final.log" || { echo "FAIL: verify did not judge every role of all eight programs" >&2; exit 1; }
# R4-17, R4-18: the report says where the hand-over stands and accounts for every one of the eight programs.
grep -q "ok   the hand-over is recorded as complete (.*) and it is: every upgrade authority and config authority is the multisig vault" "$WORK/verify-final.log" || { echo "FAIL: verify did not judge the recorded hand-over" >&2; exit 1; }
jq -e --arg v "$VAULT" '.ok == true and .handover.recordedAt != null and .handover.complete == true and .handover.stage == "multisig" and .handover.vault == $v and .handover.onOperatorKey == [] and .handover.notOnVault == [] and (.checks[] | select(.id == "handover.complete") | .status == "pass") and (.checks[] | select(.id == "roles.operator_key") | .status == "pass") and (.checks[] | select(.id == "deployment.coverage") | [.evidence.accounted[] | select(.state == "deployed" and .inspected == true)] | length == 8)' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the final report does not carry the hand-over's standing and the eight programs accounted for" >&2; exit 1; }
jq -e '(.exceptions | map(.id)) == ["multisig-untested-ok"] and (.checks[] | select(.id == "deployment.coverage") | (.evidence.deployed | length) == 8) and (.checks[] | select(.id == "contracts.source_equivalence") | [.evidence.programs[] | .established] | all and length == 8) and (.checks[] | select(.id == "proposals.none_pending") | [.evidence.programs[]] | any | not)' "$DIR/deployment.verification.json" >/dev/null || { echo "FAIL: the final report does not cover all eight programs" >&2; exit 1; }

step "the router's production guard accepts the manifest and report (src/config.ts contractPathGuards)"
bun scripts/mainnet/rehearsal-guard.ts

step "monitor: authority drift against the rehearsal record"
# The role keys hold no SOL on the local validator, so the balance floors fail; what is asserted here is the drift check.
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor.json" || true
jq -e '.checks["authority.drift"] == true and .checks["programs.deployed"] == true and .checks["programs.initialised"] == true and .checks["caps.within_ceilings"] == true and .checks["fees.zero_split"] == true and .checks["pause.none"] == true and .checks["config.proposed"] == true and .checks["limiter.not_paused"] == true and .checks["guardian.separate"] == true and .checks["pause.lapsed"] == true and .checks["pause.expiring"] == true and .checks["credits.deposits_not_paused"] == true and .checks["limiter.present"] == true and .checks["limiter.rate"] == true and .checks["limiter.settle_headroom"] == true and .checks["proposal.changes_authority"] == true and .checks["proposal.changes_guardian"] == true and .checks["proposal.applicable"] == true and .checks["proposal.expired"] == true and .checks["events.read"] == true and .checks["events.spent_root_delta"] == true and .checks["events.settle_destination"] == true and ([.values | to_entries[] | select(.key | test("^build\\..*\\.profile$")) | .value] == [1,1,1,1,1,1,1,1])' "$WORK/monitor.json" >/dev/null \
  || { echo "FAIL: the monitor does not see the handed-over deployment as matching its record" >&2; jq '{failing, details}' "$WORK/monitor.json" >&2; exit 1; }
echo "monitor: authority drift, pauses, proposals, limiter and event checks pass against the record ($(jq -r '.values["authority.holders_checked"]' "$WORK/monitor.json") holders checked; all eight programs report build profile 1)"
# A record that still names the operator key (the state before the hand-over) must now show as drift.
jq --arg op "$REHEARSAL_DEPLOYER" '.authorities.authority = $op' "$TRELLIS_DEPLOYMENTS_FILE" > "$WORK/stale-record.json"
TRELLIS_DEPLOYMENTS_FILE="$WORK/stale-record.json" bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-stale.json" || true
jq -e '.checks["authority.drift"] == false' "$WORK/monitor-stale.json" >/dev/null || { echo "FAIL: the monitor did not report drift against a stale record" >&2; exit 1; }
echo "monitor: drift reported as required against a record that names the old holder"
jq -r '.details["authority.drift"]' "$WORK/monitor-stale.json" | tr ';' '\n' | sed -n '1,2p' | sed 's/^ */    /'

step "R5-16 after the hand-over: the VAULT replaces the settlement key and the guardian, and cancels a proposal; printed for Squads, executed through the stand-in"
CREDITS_ID="$(jq -r .programs.trellis_credits.programId "$TRELLIS_DEPLOYMENTS_FILE")"
for k in settlement-next guardian-next; do solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/$k.json" >/dev/null; done
NEW_SETTLEMENT="$(solana-keygen pubkey "$WORK/settlement-next.json")"; NEW_GUARDIAN="$(solana-keygen pubkey "$WORK/guardian-next.json")"
ROLES=(--settlement "$NEW_SETTLEMENT" --guardian "$NEW_GUARDIAN")
cc_shows "config authority  *$VAULT  *(the multisig vault)"
# The operator key is the authority no more: --send is refused and says what to run instead. A dry run needs no key.
expect_refusal "config-change.ts --send with the operator key after the hand-over" "${CC[@]}" propose --rehearsal "${ROLES[@]}" --send --yes
said "the operator key $REHEARSAL_DEPLOYER is not the config authority: the chain names $VAULT (the multisig vault)"
said "--print --signer $VAULT"
expect_refusal "config-change.ts --print for a signer that is not the authority" "${CC[@]}" propose --rehearsal "${ROLES[@]}" --print --signer "$MAINNET_GUARDIAN"
said "is not the config authority"
# What the members put into ONE Squads vault transaction: printed, written beside the record, simulated, not sent.
"${CC[@]}" propose --rehearsal "${ROLES[@]}" --print --signer "$VAULT" | tee "$WORK/cc-vault-print.log"
grep -q "1 instruction printed for a Squads vault transaction (vault 0)" "$WORK/cc-vault-print.log" && grep -q "simulation: the chain accepts it" "$WORK/cc-vault-print.log" || { echo "FAIL: the proposal was not printed for the vault and simulated" >&2; exit 1; }
jq -e --arg v "$VAULT" --arg id "$CREDITS_ID" '.vault == $v and .action == "propose" and (.transactions | length) == 1 and .transactions[0].coSigners == [] and .transactions[0].instructions[0].programId == $id and ([.transactions[0].instructions[0].accounts[] | select(.isSigner) | .pubkey] == [$v])' "$DIR/deployment.config-change.json" >/dev/null || { echo "FAIL: the file for the Squads proposal does not carry one instruction of trellis_credits signed by the vault alone" >&2; exit 1; }
cc_shows "pending proposal  *none"
# Executed as the vault (the stand-in signs for it by CPI, as Squads does), then cancelled as the vault: this is the
# answer to a proposal the members did not make.
"${CC[@]}" propose --rehearsal "${ROLES[@]}" --via-rehearsal-vault --yes | tail -2
cc_shows "pending proposal  *settlement key -> $NEW_SETTLEMENT; guardian -> $NEW_GUARDIAN"
bun scripts/monitor.ts --once --cluster rehearsal --json > "$WORK/monitor-vault-proposal.json" || true
jq -e '.checks["config.proposed"] == false and .checks["proposal.changes_guardian"] == false' "$WORK/monitor-vault-proposal.json" >/dev/null || { echo "FAIL: the monitor did not report the vault's pending proposal and that it changes the guardian" >&2; exit 1; }
"${CC[@]}" cancel --rehearsal --print --signer "$VAULT" | tee "$WORK/cc-vault-cancel.log"
grep -q "resolve_config(apply = false): drop the pending proposal" "$WORK/cc-vault-cancel.log" && grep -q "1 instruction printed for a Squads vault transaction" "$WORK/cc-vault-cancel.log" || { echo "FAIL: the cancellation was not printed for the vault" >&2; exit 1; }
cc_shows "pending proposal  *settlement key -> $NEW_SETTLEMENT"
"${CC[@]}" cancel --rehearsal --via-rehearsal-vault --yes | tail -2
cc_shows "pending proposal  *none"
# Proposed again, the (devnet) timelock waited out, applied as the vault: the chain carries the new keys and so does the record.
"${CC[@]}" propose --rehearsal "${ROLES[@]}" --via-rehearsal-vault --yes | tail -1
sleep 34
"${CC[@]}" apply --rehearsal "${ROLES[@]}" --print --signer "$VAULT" | grep "simulation: the chain accepts it"
cc_shows "settlement key  *$MAINNET_SETTLEMENT_AUTHORITY"
"${CC[@]}" apply --rehearsal "${ROLES[@]}" --via-rehearsal-vault --yes | tee "$WORK/cc-vault-apply.log" | tail -4
cc_shows "settlement key  *$NEW_SETTLEMENT"
cc_shows "guardian  *$NEW_GUARDIAN"
cc_shows "pending proposal  *none"
jq -e --arg s "$NEW_SETTLEMENT" --arg g "$NEW_GUARDIAN" '.authorities.settlementAuthority == $s and .authorities.guardian == $g' "$TRELLIS_DEPLOYMENTS_FILE" >/dev/null || { echo "FAIL: the record does not carry the keys the apply installed" >&2; exit 1; }
"${CC[@]}" record --rehearsal | grep "Nothing to write"
"${CC[@]}" apply --rehearsal "${ROLES[@]}" --via-rehearsal-vault --yes | grep "Nothing to send: no proposal is pending and the chain already carries this change"
# The brake moved with the key: the old guardian can no longer pause trellis_credits, the new one can.
expect_refusal "a pause of trellis_credits by the guardian that was replaced" "${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --print --signer "$MAINNET_GUARDIAN" --only trellis_credits
said "the signer is neither the guardian nor the authority"
"${NC[@]}" bun scripts/mainnet/pause.ts --rehearsal --print --signer "$NEW_GUARDIAN" --only trellis_credits --settlements | tail -1 | grep "2 instruction(s) printed"
fi

step "rehearsal complete"
echo "record: $DIR/deployment.json"
