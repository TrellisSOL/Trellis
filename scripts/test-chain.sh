#!/bin/bash
# Router <-> programs integration test (tests/integration/*.ts): start a fresh local validator with the eight Trellis
# programs, run the mocha suite against it, stop the validator. One validator per machine on port 8899; refuses to start
# when the port is taken.
#
# The programs are the DEVNET flavour from target/deploy-devnet (scripts/devnet/build.sh, built here when missing or
# older than the sources): the same code as target/deploy with the short devnet floors, because a real validator's clock
# cannot be moved and the suite has to wait out a refund delay, a dispute window and an unbond period. The mainnet
# floors themselves are exercised by the Anchor suite (`anchor test`, tests/*.ts) on the default build with a warped
# clock. The IDLs in src/solana/idl are the same for both flavours.
#
# Every `init_*` instruction only accepts the program's upgrade authority, so the programs are loaded as upgradeable
# with a keypair generated for this run; the suite reads it from TRELLIS_CHAIN_ADMIN_KEYPAIR and initialises with it.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
PORT="${TRELLIS_TEST_VALIDATOR_PORT:-8899}"
RPC="http://127.0.0.1:$PORT"
if (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then echo "port $PORT is in use; stop the other validator first" >&2; exit 1; fi
PROGRAMS=(credits anchor rules fee_router tab bond capacity measurements)
stale=0
for p in "${PROGRAMS[@]}"; do
  so="target/deploy-devnet/trellis_$p.so"
  if [ ! -f "$so" ] || [ -n "$(find "programs/trellis_$p" Cargo.toml -newer "$so" \( -name '*.rs' -o -name 'Cargo.toml' \) -print -quit)" ]; then stale=1; fi
done
if [ "$stale" -eq 1 ]; then echo "building the devnet-flavour programs (scripts/devnet/build.sh)"; scripts/devnet/build.sh >/dev/null; fi
LEDGER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trellis-chain-test.XXXXXX")"
ADMIN_KEYPAIR="$LEDGER_DIR/admin.json"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$ADMIN_KEYPAIR" >/dev/null
ADMIN="$(solana-keygen pubkey "$ADMIN_KEYPAIR")"
ARGS=()
for p in "${PROGRAMS[@]}"; do
  id="$(sed -n "s/^trellis_$p = \"\(.*\)\"/\1/p" Anchor.toml | head -1)" # [programs.localnet] comes first; devnet repeats the ids
  ARGS+=(--upgradeable-program "$id" "target/deploy-devnet/trellis_$p.so" "$ADMIN")
done
solana-test-validator --reset --quiet --rpc-port "$PORT" --ledger "$LEDGER_DIR/ledger" "${ARGS[@]}" > "$LEDGER_DIR/validator.log" 2>&1 &
VPID=$!
cleanup() { kill "$VPID" 2>/dev/null || true; wait "$VPID" 2>/dev/null || true; rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT
for _ in $(seq 1 90); do solana cluster-version -u "$RPC" >/dev/null 2>&1 && break; sleep 1; done
solana cluster-version -u "$RPC" >/dev/null 2>&1 || { echo "the local validator did not come up; see $LEDGER_DIR/validator.log" >&2; cat "$LEDGER_DIR/validator.log" >&2 || true; exit 1; }
# The launch surface (src/surface/): anchor-memo.ts and router-chain.ts exercise features beyond the core surface (tabs,
# the hosted facilitator, bonds, the anchor program), so they run the full surface; router-core.ts starts its router with
# LAUNCH_SURFACE=core itself and walks the launch configuration end to end. router-chain.ts runs before router-core.ts
# (it initialises trellis_credits on this validator); shared.ts carries the settlement key both use. router-core.ts alone
# also works (it initialises the program itself when nobody has): TRELLIS_CHAIN_SUITES=tests/integration/router-core.ts.
LAUNCH_SURFACE=all LAUNCH_SURFACE_ACK=i-have-reviewed-the-extra-features TRELLIS_CHAIN_RPC="$RPC" TRELLIS_CHAIN_ADMIN_KEYPAIR="$ADMIN_KEYPAIR" bun ./node_modules/mocha/bin/mocha.js -t 900000 ${TRELLIS_CHAIN_SUITES:-tests/integration/anchor-memo.ts tests/integration/router-chain.ts tests/integration/router-core.ts}
