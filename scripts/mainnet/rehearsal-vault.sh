#!/bin/bash
# Build the REHEARSAL-ONLY stand-in for the Squads v4 program (scripts/mainnet/rehearsal-vault/src/lib.rs says what it
# is and why it must never exist on a public cluster) into the gitignored .data/mainnet-rehearsal-vault/.
#
#   scripts/mainnet/rehearsal-vault.sh        prints the path of the built .so
#
# The crate is not a member of the Trellis workspace, so `anchor build`, the test suite and every deploy script never
# see it. It is built in a copy with the workspace's own Cargo.lock, so it resolves to the same crate versions.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."
OUT="$PWD/.data/mainnet-rehearsal-vault"
SRC="scripts/mainnet/rehearsal-vault"
SO="$OUT/rehearsal_vault.so"
if [ -f "$SO" ] && [ -z "$(find "$SRC" -newer "$SO" -type f -print -quit)" ]; then echo "$SO"; exit 0; fi
mkdir -p "$OUT/crate"
rm -rf "$OUT/crate/src"
cp -R "$SRC/src" "$SRC/Cargo.toml" "$OUT/crate/"
cp Cargo.lock "$OUT/crate/Cargo.lock"
( cd "$OUT/crate" && CARGO_TARGET_DIR="$OUT/target" cargo build-sbf --tools-version "${TRELLIS_TOOLS_VERSION:-v1.57}" --arch "${TRELLIS_SBPF_ARCH:-v3}" --sbf-out-dir "$OUT" >&2 )
[ -f "$SO" ] || { echo "the rehearsal vault did not build" >&2; exit 1; }
echo "$SO"
