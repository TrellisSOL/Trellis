#!/bin/bash
# Deploy the Trellis Anchor programs to Solana devnet, in priority order, as far as the deployer's balance reaches.
#
#   scripts/devnet/deploy.sh                 deploy every program that is not yet on devnet
#   scripts/devnet/deploy.sh --dry-run       print what would be deployed and the SOL each needs; records the skeleton
#   scripts/devnet/deploy.sh trellis_tab     deploy (or finish) a single program
#   scripts/devnet/deploy.sh --upgrade [program]
#                                            upgrade the programs already on devnet to this tree's build, one at a time:
#                                            skip a program whose on-chain code already matches, extend its data account
#                                            when the new build is larger, write and swap the buffer, confirm no buffer
#                                            is left holding rent, then publish the refreshed IDL (anchor idl upgrade)
#   WAIT_MINUTES=45 scripts/devnet/deploy.sh poll the balance every 2 minutes (airdrops arriving) before giving up
#
# Idempotent: a program that `solana program show` already finds is skipped (its IDL is still published if that step
# was never recorded). Each deployment's program id and signature go to deployments/devnet.json; the program keypairs
# in target/deploy give the same ids as Anchor.toml [programs.devnet] and the IDLs in src/solana/idl. The upgrade
# authority is the deployer wallet (production hands it to the Squads 2-of-3). Requires: jq, the Solana CLI and Anchor on
# PATH (the toolchain line below adds the usual install locations).
#
# What is deployed is the DEVNET build: target/deploy-devnet/*.so from scripts/devnet/build.sh (cargo feature `devnet`),
# the same code as `anchor build` with short floors and a 30 s config timelock so the devnet walkthroughs can run in
# minutes. It is built here when missing or older than the sources. NEVER deploy that build to mainnet: mainnet uses the
# default build (target/deploy, scripts/mainnet/**), whose floors are the published delays. The IDLs are identical.
#
# The RPC endpoint may carry a provider key: it is never printed (every line this script writes passes through a mask).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/../.."

RPC="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"
WALLET="${SOLANA_KEYPAIR:-$HOME/.config/solana/id.json}"
OUT="deployments/devnet.json"
NETWORK="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
WAIT_MINUTES="${WAIT_MINUTES:-0}"
DRY_RUN=0
UPGRADE=0
ONLY=""
SO_DIR="target/deploy-devnet"
# Mask the endpoint in everything written from here on (stdout and stderr): the exact URL, and any URL on its host.
RPC_HOST="$(printf '%s' "$RPC" | sed -E 's#^[a-z]+://([^/:?]+).*#\1#')"
exec > >(RPC_MASK="$RPC" RPC_HOST="$RPC_HOST" perl -pe 'BEGIN { $| = 1; $r = $ENV{RPC_MASK}; $h = $ENV{RPC_HOST}; } s/\Q$r\E/<devnet rpc>/g; s#https?://\Q$h\E[^\s"]*#<devnet rpc>#g unless $h =~ /^api\.devnet\.solana\.com$/;') 2>&1
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --upgrade) UPGRADE=1 ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) ONLY="$arg" ;;
  esac
done
# Priority order: the funding path first, then receipts, rulebooks, tabs, bonds, fees, capacity, the measurement registry.
ORDER=(trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements)
FEE_MARGIN_LAMPORTS=100000000 # 0.1 SOL per program for the ~350 write transactions (priority fee included) and the IDL account

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v solana >/dev/null || { echo "solana CLI not on PATH" >&2; exit 1; }
[ -f "$WALLET" ] || { echo "deployer keypair not found at $WALLET" >&2; exit 1; }
stale=0
for p in "${ORDER[@]}"; do
  if [ ! -f "$SO_DIR/$p.so" ] || [ -n "$(find "programs/$p" Cargo.toml -newer "$SO_DIR/$p.so" \( -name '*.rs' -o -name 'Cargo.toml' \) -print -quit)" ]; then stale=1; fi
done
if [ "$stale" -eq 1 ]; then echo "building the devnet-flavour programs (scripts/devnet/build.sh)"; scripts/devnet/build.sh >/dev/null; fi
for p in "${ORDER[@]}"; do [ -f "$SO_DIR/$p.so" ] || { echo "$SO_DIR/$p.so is missing; run scripts/devnet/build.sh" >&2; exit 1; }; done

DEPLOYER="$(solana-keygen pubkey "$WALLET")"
mkdir -p deployments
if [ ! -f "$OUT" ]; then
  jq -n --arg rpc "$RPC" --arg net "$NETWORK" --arg dep "$DEPLOYER" \
    '{cluster:"devnet", rpc:$rpc, network:$net, deployer:$dep, programs:{}}' > "$OUT"
fi

record() { # record <jq filter> [--arg k v ...]: update deployments/devnet.json in place
  local filter="$1"; shift
  local tmp; tmp="$(mktemp)"
  jq "$@" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg dep "$DEPLOYER" "$filter | .updatedAt = \$now | .deployer = \$dep" "$OUT" > "$tmp" && mv "$tmp" "$OUT"
}
balance_lamports() { solana balance -u "$RPC" -k "$WALLET" --lamports | awk 'NF {print $1; exit}'; }
rent_lamports() { solana rent "$1" -u "$RPC" --lamports | awk 'NF >= 2 {print $(NF-1); exit}'; }
program_id() { solana-keygen pubkey "target/deploy/$1-keypair.json"; }
is_deployed() { solana program show "$1" -u "$RPC" >/dev/null 2>&1; }
sol() { awk -v l="$1" 'BEGIN{printf "%.4f", l/1e9}'; }

# Rent the deploy needs from the wallet: the buffer (37 + size) is drained back into the payer before the ProgramData
# account (45 + size, max_len defaults to the program length) is created, so the peak is about one copy of the rent
# plus the 36-byte program account and fees.
needed_lamports() {
  local size; size="$(wc -c < "$SO_DIR/$1.so" | tr -d ' ')"
  local pd pa; pd="$(rent_lamports $((size + 45)))"; pa="$(rent_lamports 36)"
  echo $((pd + pa + FEE_MARGIN_LAMPORTS))
}

publish_idl() { # publish_idl <program> <id>: anchor idl init, tolerant of an IDL account that already exists
  local p="$1" id="$2" out status
  if [ "$(jq -r --arg p "$p" '.programs[$p].idl.status // empty' "$OUT")" = "published" ]; then return 0; fi
  echo "  publishing IDL for $p"
  if out="$(anchor idl init -f "target/idl/$p.json" "$id" --provider.cluster devnet --provider.wallet "$WALLET" 2>&1)"; then
    status="published"; echo "$out" | sed 's/^/    /'
  elif echo "$out" | grep -qi "already in use\|already exists\|already initialized\|custom program error: 0x0"; then
    status="published"; echo "    IDL account already exists"
  else
    status="failed"; echo "$out" | sed 's/^/    /' >&2; echo "  IDL publish failed for $p (rerun deploy.sh later)" >&2
  fi
  record '.programs[$p].idl = {status:$s, at:$now}' --arg p "$p" --arg s "$status"
}

deploy_one() { # deploy_one <program>: returns 0 deployed/already live, 2 insufficient balance, 1 failure
  local p="$1" id need have out sig
  id="$(program_id "$p")"
  if is_deployed "$id"; then
    echo "$p already deployed at $id"
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed"})' --arg p "$p" --arg id "$id"
    publish_idl "$p" "$id"
    return 0
  fi
  need="$(needed_lamports "$p")"; have="$(balance_lamports)"
  if [ "$have" -lt "$need" ]; then
    echo "$p needs about $(sol "$need") SOL, balance is $(sol "$have") SOL; pending"
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"pending", neededSol:($n|tonumber)})' --arg p "$p" --arg id "$id" --arg n "$(sol "$need")"
    return 2
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$p would deploy -> $id ($(wc -c < "$SO_DIR/$p.so" | tr -d ' ') bytes, ~$(sol "$need") SOL)"
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"pending", neededSol:($n|tonumber)})' --arg p "$p" --arg id "$id" --arg n "$(sol "$need")"
    return 0
  fi
  echo "deploying $p -> $id ($(wc -c < "$SO_DIR/$p.so" | tr -d ' ') bytes, ~$(sol "$need") SOL)"
  local tmp; tmp="$(mktemp)"
  if solana program deploy --program-id "target/deploy/$p-keypair.json" "$SO_DIR/$p.so" \
      -u "$RPC" -k "$WALLET" --upgrade-authority "$WALLET" \
      --with-compute-unit-price 5000 --max-sign-attempts 200 --output json > "$tmp" 2> >(sed 's/^/    /' >&2); then
    out="$(cat "$tmp")"; rm -f "$tmp"
    sig="$(echo "$out" | jq -r '.signature // empty' 2>/dev/null || true)"
    [ -n "$sig" ] || sig="$(echo "$out" | sed -n 's/^Signature: //p' | head -1)"
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed", deploySignature:$sig, deployedAt:$now, soBytes:($b|tonumber), upgradeAuthority:$dep}) | del(.programs[$p].neededSol)' \
      --arg p "$p" --arg id "$id" --arg sig "$sig" --arg b "$(wc -c < "$SO_DIR/$p.so" | tr -d ' ')"
    echo "  deployed; signature $sig"
    solana program show "$id" -u "$RPC" | sed 's/^/    /'
    publish_idl "$p" "$id"
    return 0
  else
    rm -f "$tmp"
    echo "deploy of $p failed; reclaiming any leftover buffer rent" >&2
    solana program close --buffers -u "$RPC" -k "$WALLET" >/dev/null 2>&1 || true
    return 1
  fi
}

# ---- Upgrade ---------------------------------------------------------------------------------------------------------------
onchain_len() { solana program show "$1" -u "$RPC" --output json | jq -r '.dataLen'; }
# Lamports an upgrade may cost the wallet when its buffer was closed back into it: transaction fees only. A buffer left
# open would hold the whole program's rent (over 1 SOL), so the balance tells the two apart without getProgramAccounts
# (which `solana program show --buffers` needs and keyed RPC providers often refuse).
MAX_UPGRADE_COST_LAMPORTS=50000000
matches_onchain() { # matches_onchain <program> <id>: the on-chain code is the local build (the rest is zero padding)
  local p="$1" id="$2" dump; dump="$(mktemp)"
  solana program dump "$id" "$dump" -u "$RPC" >/dev/null 2>&1 || { rm -f "$dump"; return 1; }
  local size; size="$(wc -c < "$SO_DIR/$p.so" | tr -d ' ')"
  local rc=1
  if [ "$(head -c "$size" "$dump" | shasum -a 256 | cut -d' ' -f1)" = "$(shasum -a 256 < "$SO_DIR/$p.so" | cut -d' ' -f1)" ] && [ "$(tail -c "+$((size + 1))" "$dump" | tr -d '\0' | wc -c | tr -d ' ')" = "0" ]; then rc=0; fi
  rm -f "$dump"; return "$rc"
}
upgrade_idl() { # upgrade_idl <program> <id>: write the refreshed IDL into the program's IDL account
  local p="$1" id="$2" out status="upgraded"
  echo "  publishing the refreshed IDL for $p"
  if ! out="$(anchor idl upgrade -f "target/idl/$p.json" "$id" --provider.cluster "$RPC" --provider.wallet "$WALLET" 2>&1)"; then
    # No IDL account yet: create it.
    if ! out="$(anchor idl init -f "target/idl/$p.json" "$id" --provider.cluster "$RPC" --provider.wallet "$WALLET" 2>&1)"; then status="failed"; fi
  fi
  echo "$out" | tail -3 | sed 's/^/    /'
  [ "$status" = "failed" ] && echo "  IDL publish failed for $p (rerun deploy.sh --upgrade $p later)" >&2
  record '.programs[$p].idl = {status:$s, at:$now}' --arg p "$p" --arg s "$status"
}
upgrade_one() { # upgrade_one <program>: 0 upgraded or already current, 1 failure
  local p="$1" id size have_len out sig tmp before
  id="$(program_id "$p")"
  is_deployed "$id" || { echo "$p is not deployed at $id; deploy it first (scripts/devnet/deploy.sh $p)" >&2; return 1; }
  size="$(wc -c < "$SO_DIR/$p.so" | tr -d ' ')"
  if matches_onchain "$p" "$id"; then
    echo "$p: the code on chain is already this build ($size bytes)"
    record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed", soBytes:($b|tonumber), build:"devnet"})' --arg p "$p" --arg id "$id" --arg b "$size"
    if [ "$DRY_RUN" -eq 0 ] && [ "$(jq -r --arg p "$p" '.programs[$p].idl.status // empty' "$OUT")" != "upgraded" ]; then upgrade_idl "$p" "$id"; fi
    return 0
  fi
  have_len="$(onchain_len "$id")"
  before="$(balance_lamports)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$p would upgrade -> $id ($size bytes; the data account holds $have_len$([ "$size" -gt "$have_len" ] && echo ", extend by $((size - have_len))"))"
    return 0
  fi
  if [ "$size" -gt "$have_len" ]; then
    # The loader extends in steps of at least 10,240 bytes. Done here, before the upgrade, so the rent it adds to the
    # program data account is not mistaken for a buffer left open.
    local grow=$((size - have_len)); [ "$grow" -lt 10240 ] && grow=10240
    echo "$p: extending the program data account by $grow bytes (the build is $((size - have_len)) bytes larger)"
    solana program extend "$id" "$grow" -u "$RPC" -k "$WALLET" >/dev/null || { echo "  could not extend $p" >&2; return 1; }
    before="$(balance_lamports)" # the extension's rent stays in the program data account
  fi
  echo "upgrading $p -> $id ($size bytes), balance $(sol "$before") SOL"
  tmp="$(mktemp)"
  if solana program deploy --program-id "$id" "$SO_DIR/$p.so" -u "$RPC" -k "$WALLET" --upgrade-authority "$WALLET" \
      --with-compute-unit-price 5000 --max-sign-attempts 200 --output json > "$tmp" 2> >(sed 's/^/    /' >&2); then
    out="$(cat "$tmp")"; rm -f "$tmp"
    sig="$(echo "$out" | jq -r '.signature // empty' 2>/dev/null || true)"
  else
    rm -f "$tmp"
    echo "upgrade of $p failed; reclaiming any leftover buffer rent" >&2
    solana program close --buffers -u "$RPC" -k "$WALLET" >/dev/null 2>&1 || true
    return 1
  fi
  # The buffer is closed into the payer by the upgrade itself; make sure nothing is left holding rent before the next one.
  local after; after="$(balance_lamports)"
  if [ $((before - after)) -gt "$MAX_UPGRADE_COST_LAMPORTS" ]; then
    echo "  the balance fell by $(sol $((before - after))) SOL: a buffer is still holding rent; closing it" >&2
    solana program close --buffers -u "$RPC" -k "$WALLET" >/dev/null 2>&1 || true
    after="$(balance_lamports)"
    [ $((before - after)) -le "$MAX_UPGRADE_COST_LAMPORTS" ] || { echo "  the buffer's rent did not come back; close it by hand (solana program close --buffers) before going on" >&2; return 1; }
  fi
  matches_onchain "$p" "$id" || { echo "  after the upgrade the code on chain is not the local build" >&2; return 1; }
  record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed", upgradeSignature:$sig, upgradedAt:$now, soBytes:($b|tonumber), build:"devnet", upgradeAuthority:$dep})' \
    --arg p "$p" --arg id "$id" --arg sig "$sig" --arg b "$size"
  echo "  upgraded; signature ${sig:-(not reported)}; buffer closed (rent back in the wallet); balance $(sol "$after") SOL (was $(sol "$before"))"
  upgrade_idl "$p" "$id"
  return 0
}

echo "deployer $DEPLOYER on <devnet rpc>, balance $(sol "$(balance_lamports)") SOL"
if [ "$DRY_RUN" -eq 1 ] && [ "$UPGRADE" -eq 0 ]; then
  echo "dry run: nothing is sent; deployments/devnet.json gets the program ids with status pending"
  total=0
  for p in "${ORDER[@]}"; do
    id="$(program_id "$p")"; need="$(needed_lamports "$p")"
    if is_deployed "$id"; then
      printf "  %-20s %-45s deployed\n" "$p" "$id"
      record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"deployed"}) | del(.programs[$p].neededSol)' --arg p "$p" --arg id "$id"
    else
      printf "  %-20s %-45s pending  %8s bytes  ~%s SOL\n" "$p" "$id" "$(wc -c < "$SO_DIR/$p.so" | tr -d ' ')" "$(sol "$need")"
      record '.programs[$p] = ((.programs[$p] // {}) + {programId:$id, status:"pending", soBytes:($b|tonumber), neededSol:($n|tonumber)})' --arg p "$p" --arg id "$id" --arg b "$(wc -c < "$SO_DIR/$p.so" | tr -d ' ')" --arg n "$(sol "$need")"
      total=$((total + need))
    fi
  done
  have="$(balance_lamports)"
  echo "total still needed: $(sol "$total") SOL (rent for the ProgramData accounts plus 0.1 SOL per program for fees and the IDL account); balance $(sol "$have") SOL"
  if [ "$have" -lt "$total" ]; then echo "shortfall: $(sol $((total - have))) SOL"; fi
  exit 0
fi
targets=("${ORDER[@]}")
if [ -n "$ONLY" ]; then
  [ -f "$SO_DIR/$ONLY.so" ] || { echo "unknown program $ONLY" >&2; exit 1; }
  targets=("$ONLY")
fi
if [ "$UPGRADE" -eq 1 ]; then
  # Largest first, so a balance that cannot carry every upgrade fails on the first one rather than half way.
  sorted=(); while read -r _ p; do sorted+=("$p"); done < <(for p in "${targets[@]}"; do echo "$(wc -c < "$SO_DIR/$p.so" | tr -d ' ') $p"; done | sort -rn)
  for p in "${sorted[@]}"; do upgrade_one "$p" || { echo "stopping after a failed upgrade; rerun to resume" >&2; exit 1; }; done
  echo "upgrade pass complete; next: bun scripts/devnet/init.ts (creates the credits outflow limiter if it is missing), then bun scripts/devnet/verify.ts"
  exit 0
fi

deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
pending=()
for p in "${targets[@]}"; do
  while :; do
    rc=0; deploy_one "$p" || rc=$?
    if [ "$rc" -eq 0 ]; then break; fi
    if [ "$rc" -eq 1 ]; then echo "stopping after a failed deploy; rerun to resume" >&2; exit 1; fi
    if [ "$(date +%s)" -lt "$deadline" ]; then
      echo "  waiting 2 minutes for the balance (until $(date -r "$deadline" +%H:%M 2>/dev/null || date -d "@$deadline" +%H:%M))"
      sleep 120
      continue
    fi
    pending+=("$p")
    break
  done
done

echo
echo "live:    $(jq -r '[.programs | to_entries[] | select(.value.status == "deployed") | .key] | join(" ")' "$OUT")"
if [ "${#pending[@]}" -gt 0 ]; then
  total=0
  for p in "${pending[@]}"; do total=$((total + $(needed_lamports "$p"))); done
  echo "pending: ${pending[*]} (about $(sol "$total") SOL more, balance $(sol "$(balance_lamports)") SOL)"
  exit 2
fi
echo "all requested programs are live; next: bun scripts/devnet/init.ts"
