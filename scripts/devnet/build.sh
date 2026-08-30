#!/bin/bash
# Build the DEVNET flavour of the Trellis programs into target/deploy-devnet/.
#
#   scripts/devnet/build.sh              build all eight programs with `--features devnet`
#   scripts/devnet/build.sh trellis_tab  build one
#
# The programs compile their safety floors into the binary (72 h refund delay and dispute window, 14 d unbonding, 24 h
# reclaim grace and config timelock, ...). The `devnet` cargo feature swaps in short values so the money paths that wait
# can be watched in minutes on devnet and in the local integration test (scripts/test-chain.sh). THESE BINARIES ARE FOR
# DEVNET AND LOCAL TESTS ONLY. `anchor build` (and so target/deploy, the Anchor test suite and every mainnet build) never
# enables the feature; tests/floors.ts fails if target/deploy ever carries the short values.
#
# The IDLs are the same for both flavours (the feature changes constants, not interfaces): target/idl from `anchor build`
# is the one to publish.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."
OUT="target/deploy-devnet"
TOOLS_VERSION="${TRELLIS_TOOLS_VERSION:-v1.57}"
ARCH="${TRELLIS_SBPF_ARCH:-v3}"
ALL=(trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements)
PROGRAMS=("${@:-${ALL[@]}}")
mkdir -p "$OUT"
for p in "${PROGRAMS[@]}"; do
  [ -f "programs/$p/Cargo.toml" ] || { echo "unknown program $p" >&2; exit 1; }
  echo "building $p (devnet floors) -> $OUT/$p.so"
  # Same toolchain and SBPF version as `anchor build` (Anchor 1.2 defaults), so the two flavours differ only by the feature.
  cargo build-sbf --manifest-path "programs/$p/Cargo.toml" --tools-version "$TOOLS_VERSION" --arch "$ARCH" --features devnet --sbf-out-dir "$OUT" 2>&1 | grep -E "^(error|warning: unused)|Finished|To deploy" || true
  [ -f "$OUT/$p.so" ] || { echo "build of $p failed" >&2; exit 1; }
done
ls -l "$OUT"/*.so | awk '{print $5, $9}'
