#!/bin/bash
# The whole mainnet procedure with freshly generated program ids, on a local validator: what scripts/mainnet/rehearse.sh
# cannot show from the working tree's own ids. It copies the program sources to a throwaway directory, generates new
# program keypairs there (keys.sh), writes them into declare_id! and Anchor.toml (keys.sh --apply), and runs rehearse.sh
# against that copy: the preflight builds the copy's default profile itself in a clean target directory and checks that
# each binary carries its new id and reports the mainnet build profile; part 2 uses devnet-feature binaries built from
# the same copy. Deploy, init, verify (build_profile of every deployed program, read on chain at the fresh ids), the
# pauses and their lapse, the monitor's event checks, both phases of the hand-over, the report the router's production
# guard reads, and every refusal: every assertion of rehearse.sh, against ids no checked-in file names.
# It is also where "the incident scripts run from a normal checkout" (R5-16) means something: the ids deployed here are
# named by no file of the working tree, whose declare_id! lines stay the localnet ones, and pause.ts, config-change.ts
# and anchorer-rotate.ts are run against that working tree (rehearse.sh drops the copy's source root for them).
# That includes every refusal of the third security pass (the narrower tier, the multisig account, the guardian, the
# dirty tree, the pending proposal, the pause and keypair cases): rehearse.sh lists them in its header. The copy made
# here is the source root of the run (REHEARSAL_ROOT); it is not a git tree of its own, so the run passes --allow-dirty
# wherever mainnet would require a clean tree at a commit, exactly as rehearse.sh does with its snapshot.
#
#   scripts/mainnet/rehearse-fresh-ids.sh        a few minutes longer than rehearse.sh: every program is compiled twice
#
# Nothing in the working tree is changed: the copy, its keys and its builds live under the gitignored
# .data/mainnet-rehearsal-build/ (its target/ is kept between runs, so only the eight program crates recompile).
# What it still does not cover: the real Squads program, the Docker-based verifiable build, IDL publication, real fees.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."
DIR="$PWD/.data/mainnet-rehearsal-build"
mkdir -p "$DIR"
rm -rf "$DIR/programs" "$DIR/keys" "$DIR/target/deploy-devnet"
cp -R programs Cargo.toml Cargo.lock Anchor.toml package.json "$DIR/"
export TRELLIS_ROOT="$DIR" TRELLIS_MAINNET_KEYS_DIR="$DIR/keys"
scripts/mainnet/keys.sh >/dev/null
# --allow-main: this is a throwaway copy inside the repository's ignored .data/, not the branch it sits under.
scripts/mainnet/keys.sh --apply --allow-main
scripts/mainnet/keys.sh --check --tier full
unset TRELLIS_ROOT TRELLIS_MAINNET_KEYS_DIR
# Part 2 of the rehearsal waits out the hand-over on a real validator, so it runs the devnet-feature build (30 s
# timelock) of the same fresh-id sources. Built here exactly as scripts/devnet/build.sh builds the working tree.
mkdir -p "$DIR/target/deploy-devnet"
for p in trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements; do
  echo "building $p with fresh ids (devnet floors, for part 2)"
  CARGO_TARGET_DIR="$DIR/target" cargo build-sbf --manifest-path "$DIR/programs/$p/Cargo.toml" --tools-version "${TRELLIS_TOOLS_VERSION:-v1.57}" --arch "${TRELLIS_SBPF_ARCH:-v3}" --features devnet --sbf-out-dir "$DIR/target/deploy-devnet" 2>&1 | grep -E "^error|Finished" || true
  [ -f "$DIR/target/deploy-devnet/$p.so" ] || { echo "build of $p failed" >&2; exit 1; }
  rm -f "$DIR/target/deploy-devnet/$p-keypair.json"
done
REHEARSAL_KEYS_DIR="$DIR/keys" REHEARSAL_ROOT="$DIR" REHEARSAL_DEVNET_SO_DIR="$DIR/target/deploy-devnet" scripts/mainnet/rehearse.sh
