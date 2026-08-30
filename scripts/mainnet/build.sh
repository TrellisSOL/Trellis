#!/bin/bash
# Build the programs of a launch tier with the DEFAULT (mainnet) profile, in a clean target directory.
#
#   scripts/mainnet/build.sh --tier credits            build what the tier deploys; prints the output directory
#   scripts/mainnet/build.sh --programs credits,tab    an arbitrary set
#   scripts/mainnet/build.sh --tier full --force       build again even when this exact source was already built
#   scripts/mainnet/build.sh --tier credits --allow-dirty   REHEARSALS ONLY: build from a tree with uncommitted changes
#   scripts/mainnet/build.sh --tier credits --verifiable    the Docker build (`anchor build --verifiable`) of the commit,
#                                                           into target/verifiable, with its manifest beside it
#
# It refuses a dirty tree (security/REVIEW-ROUND3-2026-10.md R3-10): the source root must be a git work tree of its
# own, at a commit, with no uncommitted change anywhere outside deployments/ (scripts/mainnet/source-state.sh), and the
# commit is written into build.json. Otherwise "the commit the programs were built from" names something else than
# what was compiled. --allow-dirty lifts that for a rehearsal; build.json then says "dirty (rehearsal only)", and the
# mainnet preflight refuses a build directory that says so. deploy.sh and preflight.ts never pass it on mainnet.
#
# What is compiled is the COMMIT, not the working tree (security/REVIEW-ROUND4-2026-10.md R4-16). `git status` can be
# clean while a file differs from the commit (an index entry marked skip-worktree or assume-unchanged, a source file a
# local exclude rule hides). So a clean build (1) refuses a tree whose index carries such a flag or whose build paths
# differ from the commit by content, and (2) does not compile the working tree at all: it writes the commit's files
# to a throwaway directory with `git archive HEAD` and builds there. The output directory is named after the source
# key of that export, and build.json records the key, the commit and the sha256 of every binary: verify.ts and the
# preflight hold a binary to that manifest. Only a rehearsal's --allow-dirty build compiles the tree as it lies.
#
# --verifiable does the same for the Docker build: `anchor build --verifiable -p <program>` is run inside the export
# of the commit, the binaries are copied to target/verifiable and target/verifiable/build.json is written, so that
# `--prebuilt target/verifiable` is bound to the commit like the default build. It has no --allow-dirty. (The Docker
# build itself has not been run by this kit's tests or rehearsals: they run this path with a stand-in for anchor.)
#
# Why the kit builds for itself instead of taking whatever lies in target/deploy: the programs compile their safety
# floors into the binary (72 h refund delay and dispute window, 14 d unbonding, 24 h config timelock), and the `devnet`
# cargo feature swaps in 1-second floors and a 30-second timelock. The two builds have the same IDL, the same accounts and
# almost the same size. So this script:
#   1. refuses to build when anything could switch the feature on: a `default` feature list that is not empty, a
#      [features] entry in Anchor.toml that names it, a cargo config or an environment variable that injects features or
#      rustc flags (RUSTFLAGS, CARGO_ENCODED_RUSTFLAGS, CARGO_BUILD_RUSTFLAGS, CARGO_TARGET_*_RUSTFLAGS);
#      or anything that stands in for the compiler or comes from outside the commit (R5-17): RUSTC, RUSTC_WRAPPER and
#      their relatives, a CARGO_HOME that is not $HOME/.cargo, a .cargo/config.toml in any directory above the source
#      root or in the cargo home;
#   2. builds with `cargo build-sbf` and NO --features, into a target directory that did not exist before, so nothing
#      compiled earlier with other features can be reused;
#   3. names the output directory after the sha256 of every source file that goes into the build, so the same source is
#      built once and a changed source is never mistaken for it;
#   4. writes a manifest (build.json) with the commit, whether the tree was clean, and the sha256 of every .so.
# The output directory is a cache and is not trusted (R5-17): a binary already there is reused, and listed in the
# manifest again, only while it still has the sha256 the manifest recorded for it; otherwise the run stops.
#
# Build on a machine that holds no key. The build executes the build scripts of every dependency and platform tools
# that cargo-build-sbf downloads, with this user's rights: nothing above can stop such code from reading a keypair file
# that lies on the same machine. The preflight passes no key path and no RPC URL into the build's environment
# (lib.ts buildEnvironment), which hides the paths, not the files. For mainnet: build here, on a machine without the
# deployer, guardian and program keypairs, and carry the output directory (with its build.json) to the deploy machine,
# where deploy.sh takes it with --prebuilt and holds every binary to that manifest and to the commit.
#
# The preflight then loads these very files into an in-process SVM and asks each program for its build_profile
# (scripts/mainnet/simulate.ts): a binary that does not behave like the mainnet build is refused whatever its origin.
#
# This is the same toolchain and SBPF version as `anchor build` (Anchor 1.2 defaults), and the output is byte for byte
# what `anchor build` produces from the same source on the same machine. It is NOT the Docker-based verifiable build:
# for explorers to show "verified", build with --verifiable and pass target/verifiable to the preflight with
# --prebuilt (scripts/mainnet/README.md); a prebuilt directory goes through the same checks.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# shellcheck source=scripts/mainnet/source-state.sh
source "$(dirname "$0")/source-state.sh"
ROOT="$(source_root)"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ALL=(trellis_credits trellis_anchor trellis_rules trellis_tab trellis_bond trellis_fee_router trellis_capacity trellis_measurements)
TIER=""; PROGRAMS_ARG=""; FORCE=0; ALLOW_DIRTY=0; VERIFIABLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="${2:?--tier needs a value}"; shift 2 ;;
    --tier=*) TIER="${1#--tier=}"; shift ;;
    --programs) PROGRAMS_ARG="${2:?--programs needs a value}"; shift 2 ;;
    --programs=*) PROGRAMS_ARG="${1#--programs=}"; shift ;;
    --force) FORCE=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --verifiable) VERIFIABLE=1; shift ;;
    --help|-h) sed -n '2,61p' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -n "$TIER" ] && [ -n "$PROGRAMS_ARG" ]; then echo "pass --tier or --programs, not both" >&2; exit 2; fi
if [ "$VERIFIABLE" -eq 1 ] && [ "$ALLOW_DIRTY" -eq 1 ]; then echo "--verifiable takes no --allow-dirty: a verifiable build is the build of a commit" >&2; exit 2; fi
case "${TIER:-}" in
  "") if [ -n "$PROGRAMS_ARG" ]; then SELECTED=(); IFS=',' read -r -a raw <<< "$PROGRAMS_ARG"; for r in "${raw[@]}"; do r="${r// /}"; [ -n "$r" ] || continue; case "$r" in trellis_*) ;; *) r="trellis_$r" ;; esac; SELECTED+=("$r"); done; else SELECTED=(trellis_credits); fi ;;
  minimal) SELECTED=() ;;
  credits) SELECTED=(trellis_credits) ;;
  payments) SELECTED=(trellis_credits trellis_anchor trellis_tab) ;;
  full) SELECTED=("${ALL[@]}") ;;
  *) echo "unknown tier $TIER (minimal, credits, payments, full)" >&2; exit 2 ;;
esac
for p in ${SELECTED[@]+"${SELECTED[@]}"}; do
  found=0; for a in "${ALL[@]}"; do [ "$a" = "$p" ] && found=1; done
  [ "$found" -eq 1 ] || { echo "unknown program $p" >&2; exit 2; }
done

refuse() { echo "Refusing to build: $1" >&2; exit 1; }
# 0. The source: a clean tree at a commit (judged by content, not by `git status` alone), or a rehearsal that says it is not.
SOURCE_COMMIT="$(source_commit "$ROOT")"
SOURCE_TREE="clean"
SOURCE_REFUSAL="$(source_refusal "$ROOT")"
if [ -n "$SOURCE_REFUSAL" ]; then
  [ "$ALLOW_DIRTY" -eq 1 ] || refuse "$SOURCE_REFUSAL. (A rehearsal may pass --allow-dirty; a mainnet build may not.)"
  SOURCE_TREE="dirty (rehearsal only)"
fi
# Nothing may pass flags to rustc, or move the target directory, behind this script's back.
for v in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET_DIR; do
  [ -z "${!v:-}" ] || refuse "$v is set in the environment. A mainnet build takes no compiler flags or target directory from the environment (unset it)."
done
# Nor may anything stand in for the compiler, or point cargo at another home (its configuration, registry and
# credentials): what compiles the programs is the toolchain on PATH and nothing wrapped around it (R5-17).
for v in RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER; do
  [ -z "${!v:-}" ] || refuse "$v is set in the environment: it names a program that would run in place of, or around, the compiler. Unset it."
done
if [ -n "${CARGO_HOME:-}" ] && [ "${CARGO_HOME%/}" != "$HOME/.cargo" ]; then
  # The same directory under another spelling (a link) is still the default; a directory that does not exist is not.
  cargo_home="$(cd "$CARGO_HOME" 2>/dev/null && pwd -P || true)"
  if [ -z "$cargo_home" ] || [ "$cargo_home" != "$(cd "$HOME/.cargo" 2>/dev/null && pwd -P || true)" ]; then refuse "CARGO_HOME is set to a directory that is not \$HOME/.cargo. Unset it: the build uses the default cargo home."; fi
fi
if env | grep -Eq '^CARGO_TARGET_[A-Z0-9_]+_(RUSTFLAGS|LINKER|RUNNER)=|^CARGO_FEATURE_|^ANCHOR_.*FEATURES='; then refuse "the environment carries CARGO_TARGET_*_RUSTFLAGS, _LINKER or _RUNNER, CARGO_FEATURE_* or ANCHOR_*FEATURES."; fi

# What is compiled, and the key it is named after. A clean build compiles an export of the commit and carries the
# commit's source key; a rehearsal's dirty build compiles the tree as it lies and carries the key of that.
STORE="$HERE/.data/mainnet-build"
mkdir -p "$STORE"
SCRATCH="$(mktemp -d "$STORE/run.XXXXXX")"
trap 'rm -rf "${SCRATCH:?}"' EXIT
if [ "$SOURCE_TREE" = "clean" ]; then
  SOURCE_KEY="$(source_head_key "$ROOT")"
  [[ "$SOURCE_KEY" =~ ^[0-9a-f]{64}$ ]] || refuse "the commit's program sources could not be read from git (git archive HEAD failed)."
  BUILT_FROM="an export of the commit (git archive)"
  BUILD_ROOT="$SCRATCH/source"
  source_export "$ROOT" "$BUILD_ROOT" || refuse "the commit's program sources could not be exported (git archive HEAD failed)."
  # The export is what the key names: hashed again where it lies, before anything is compiled from it.
  [ "$(source_key "$BUILD_ROOT")" = "$SOURCE_KEY" ] || refuse "the export of the commit does not hash to the commit's source key."
else
  SOURCE_KEY="$(source_key "$ROOT")"
  BUILT_FROM="the working tree (rehearsal only)"
  BUILD_ROOT="$ROOT"
fi

# 1. Nothing may switch the `devnet` feature on. Checked on what is compiled (the export, for a clean build), and for
# cargo configuration also where cargo would find it from the working tree.
for cfg in "$ROOT/.cargo/config.toml" "$ROOT/.cargo/config" "$ROOT/programs/.cargo/config.toml" "$BUILD_ROOT/.cargo/config.toml" "$BUILD_ROOT/.cargo/config" "$BUILD_ROOT/programs/.cargo/config.toml"; do
  if [ -f "$cfg" ] && grep -Eq 'rustflags|features|devnet' "$cfg"; then refuse "${cfg#"$SCRATCH/source/"} sets rustflags or features."; fi
done
# A cargo configuration OUTSIDE the commit: cargo also reads .cargo/config.toml of every directory above the one it
# builds in, and of its home. No commit holds those files and nobody reviews them, and one line there replaces the
# compiler (build.rustc-wrapper) or the linker. So none may exist: not above the source root, not above the export,
# not in the cargo home (R5-17).
outside_config() {
  local d="$1" f
  while :; do
    d="$(dirname "$d")"
    for f in "$d/.cargo/config.toml" "$d/.cargo/config"; do if [ -e "$f" ]; then echo "$f"; return 0; fi; done
    [ "$d" = "/" ] && break
  done
  for f in "$HOME/.cargo/config.toml" "$HOME/.cargo/config"; do if [ -e "$f" ]; then echo "$f"; return 0; fi; done
  return 0
}
for start in "$ROOT" "$BUILD_ROOT"; do
  found="$(outside_config "$start")"
  [ -z "$found" ] || refuse "a cargo configuration outside the commit would be read by this build: $found. Move it away for the build (or build on a machine that has none): it can replace the compiler, the linker and the registry, and no commit records it."
done
[ -f "$BUILD_ROOT/Anchor.toml" ] || refuse "Anchor.toml is missing from what would be built."
if grep -Eq 'devnet[[:space:]]*=|features[[:space:]]*=.*devnet|--features' "$BUILD_ROOT/Anchor.toml"; then
  if awk '/^\[programs\.devnet\]/{skip=1; next} /^\[/{skip=0} !skip' "$BUILD_ROOT/Anchor.toml" | grep -Eq 'devnet[[:space:]]*=|features[[:space:]]*=.*devnet|--features'; then refuse "Anchor.toml names the devnet feature or passes --features."; fi
fi
for p in "${ALL[@]}"; do
  m="$BUILD_ROOT/programs/$p/Cargo.toml"
  [ -f "$m" ] || refuse "programs/$p/Cargo.toml is missing."
  grep -Eq '^default = \[\]$' "$m" || refuse "programs/$p/Cargo.toml: the default feature list is not empty. The mainnet build is the default build; \`devnet\` must stay opt-in."
  grep -Eq '^devnet = \[\]$' "$m" || refuse "programs/$p/Cargo.toml: the devnet feature is not declared as \`devnet = []\` (it may not pull in other features)."
  # A dependency on another Trellis program must not turn that program's devnet feature on either.
  if grep -E '^trellis_[a-z_]+ *=' "$m" | grep -q 'devnet'; then refuse "programs/$p/Cargo.toml enables the devnet feature of a dependency."; fi
done
grep -Eq 'devnet' "$BUILD_ROOT/Cargo.toml" && refuse "the workspace Cargo.toml mentions devnet."

# 4. The manifest: what was built, from what, and the hash of each binary. verify.ts and the preflight hold a binary to
# it. Only a binary with a `.built` mark of this directory is listed: a file that merely lies there is not vouched for.
write_manifest() { # write_manifest <dir> <kind> <profile> <toolchain> <arch>
  local dir="$1" first=1 p
  {
    printf '{\n  "kind": "%s",\n  "profile": "%s",\n  "sourceKey": "%s",\n  "sourceCommit": "%s",\n  "sourceTree": "%s",\n  "builtFrom": "%s",\n  "toolsVersion": "%s",\n  "arch": "%s",\n  "programs": {' "$2" "$3" "$SOURCE_KEY" "$SOURCE_COMMIT" "$SOURCE_TREE" "$BUILT_FROM" "$4" "$5"
    for p in "${ALL[@]}"; do
      [ -f "$dir/$p.so" ] && [ -f "$dir/$p.built" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s": { "sha256": "%s", "bytes": %s, "builtAt": "%s" }' "$p" "$(shasum -a 256 "$dir/$p.so" | cut -d' ' -f1)" "$(wc -c < "$dir/$p.so" | tr -d ' ')" "$(cat "$dir/$p.built")"
    done
    printf '\n  }\n}\n'
  } > "$dir/build.json"
}
# The sha256 the manifest of a directory recorded for one program; empty when there is no manifest or no entry.
recorded_sha() { [ -f "$1/build.json" ] || return 0; sed -n "s/^ *\"$2\": { \"sha256\": \"\([0-9a-f]\{64\}\)\".*/\1/p" "$1/build.json" | head -1; }
# R5-17: a binary that already lies in the output directory is reused, and listed in the manifest this run writes, only
# when it is still the file the manifest there recorded. Before, the directory was trusted: a binary swapped after the
# build was not rebuilt, and the manifest was rewritten with the swapped file's hash, so that it read as a build of the
# commit. Now: a marked binary whose hash is not the recorded one stops the run (and --force builds it again); one that
# no manifest recorded loses its mark, so it is built again when this run wants it and is not listed when it does not.
# <rebuilt> names the programs this run compiles anyway (nothing of theirs is reused).
verify_cached() { # verify_cached <dir> <programs this run rebuilds...>
  local dir="$1" p q want have skip; shift
  for p in "${ALL[@]}"; do
    [ -f "$dir/$p.so" ] && [ -f "$dir/$p.built" ] || continue
    skip=0; for q in "$@"; do [ "$q" = "$p" ] && skip=1; done
    [ "$skip" -eq 0 ] || continue
    want="$(recorded_sha "$dir" "$p")"
    if [ -z "$want" ]; then rm -f "${dir:?}/$p.built"; continue; fi
    have="$(shasum -a 256 "$dir/$p.so" | cut -d' ' -f1)"
    [ "$have" = "$want" ] || refuse "${dir#"$HERE/"}/$p.so is not the binary its build.json recorded (sha256 $have, recorded $want): the file was changed after it was built. It is not reused and not listed again. Find out what changed it; --force builds $p again from the source."
  done
}
# Whether the manifest of a directory says its binaries were compiled from the clean export of this very source key.
manifest_is_clean() { [ -f "$1/build.json" ] && grep -q "\"sourceKey\": \"$SOURCE_KEY\"" "$1/build.json" && grep -q '"sourceTree": "clean"' "$1/build.json"; }

if [ "$VERIFIABLE" -eq 1 ]; then
  # The Docker build of the commit, run in the export: nothing but the commit's files is there to be mounted into it.
  command -v anchor >/dev/null || refuse "anchor is not on PATH (the verifiable build is \`anchor build --verifiable\`)."
  OUT="$ROOT/target/verifiable"
  mkdir -p "$OUT"
  # One manifest describes one build of one commit: marks of a build of another commit do not stay beside it.
  if ! manifest_is_clean "$OUT"; then for p in "${ALL[@]}"; do rm -f "${OUT:?}/$p.built"; done; rm -f "${OUT:?}/build.json"; fi
  verify_cached "$OUT" ${SELECTED[@]+"${SELECTED[@]}"}
  for p in ${SELECTED[@]+"${SELECTED[@]}"}; do
    echo "building $p (anchor build --verifiable, in an export of commit ${SOURCE_COMMIT:0:12})" >&2
    rm -f "${OUT:?}/$p.built"
    if ! (cd "$BUILD_ROOT" && anchor build --verifiable -p "$p") > "$OUT/$p.log" 2>&1; then tail -30 "$OUT/$p.log" >&2; echo "verifiable build of $p failed" >&2; exit 1; fi
    [ -f "$BUILD_ROOT/target/verifiable/$p.so" ] || { echo "the verifiable build of $p produced no target/verifiable/$p.so" >&2; exit 1; }
    cp "$BUILD_ROOT/target/verifiable/$p.so" "$OUT/$p.so"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/$p.built"
  done
  write_manifest "$OUT" "verifiable-build" "default (no cargo features), in the Docker image of anchor build --verifiable" "anchor build --verifiable" "as the Docker image builds"
  echo "$OUT"
  exit 0
fi

# 2 and 3. A directory named after the source: sha256 over every file that goes into the build.
OUT="$STORE/$SOURCE_KEY"
mkdir -p "$OUT"
TOOLS_VERSION="${TRELLIS_TOOLS_VERSION:-v1.57}"
ARCH="${TRELLIS_SBPF_ARCH:-v3}"
# The directory is shared by every build of the same source key, a rehearsal's dirty one included. A clean build does
# not vouch for binaries a dirty build compiled from the working tree: unless the manifest there says they came from
# the commit's export, it compiles them again.
if [ "$SOURCE_TREE" = "clean" ] && ! manifest_is_clean "$OUT"; then FORCE=1; fi
if [ "$FORCE" -eq 1 ]; then verify_cached "$OUT" ${SELECTED[@]+"${SELECTED[@]}"}; else verify_cached "$OUT"; fi
built=0
# One target directory per run, created here and now and removed at the end: nothing compiled before this run, with
# whatever features, can be reused.
T="$SCRATCH/target"
for p in ${SELECTED[@]+"${SELECTED[@]}"}; do
  if [ "$FORCE" -eq 0 ] && [ -f "$OUT/$p.so" ] && [ -f "$OUT/$p.built" ]; then continue; fi
  rm -f "${OUT:?}/$p.so" "${OUT:?}/$p.built"
  [ "$built" -gt 0 ] || echo "note: the build runs dependency build scripts and downloaded platform tools with this user's rights. Build on a machine that holds no key (no deployer, guardian or program keypair, no RPC credentials); a prebuilt directory with its build.json is then passed to deploy.sh with --prebuilt." >&2
  echo "building $p (default profile, clean target directory, from $BUILT_FROM)" >&2
  if ! CARGO_TARGET_DIR="$T" cargo build-sbf --manifest-path "$BUILD_ROOT/programs/$p/Cargo.toml" --tools-version "$TOOLS_VERSION" --arch "$ARCH" --sbf-out-dir "$OUT" > "$OUT/$p.log" 2>&1; then
    tail -30 "$OUT/$p.log" >&2; echo "build of $p failed" >&2; exit 1
  fi
  [ -f "$OUT/$p.so" ] || { echo "build of $p produced no .so" >&2; exit 1; }
  # cargo build-sbf drops a fresh random keypair beside the .so. It is not a program keypair of this deployment.
  rm -f "${OUT:?}/$p-keypair.json"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/$p.built"
  built=$((built + 1))
done
# A dirty run that compiled nothing leaves a clean manifest as it is (the binaries it describes are still the export's);
# a dirty run that compiled something makes the whole directory a rehearsal's, and says so.
if [ "$SOURCE_TREE" = "clean" ]; then
  # Binaries this clean run did not compile and that no clean manifest vouches for are not listed as the commit's.
  if ! manifest_is_clean "$OUT"; then for p in "${ALL[@]}"; do keep=0; for q in ${SELECTED[@]+"${SELECTED[@]}"}; do [ "$q" = "$p" ] && keep=1; done; [ "$keep" -eq 1 ] || rm -f "${OUT:?}/$p.built"; done; fi
  write_manifest "$OUT" "clean-default-build" "default (no cargo features)" "$TOOLS_VERSION" "$ARCH"
elif [ "$built" -gt 0 ] || ! manifest_is_clean "$OUT"; then
  write_manifest "$OUT" "clean-default-build" "default (no cargo features)" "$TOOLS_VERSION" "$ARCH"
fi
[ "$built" -eq 0 ] || echo "built $built program(s) into ${OUT#"$HERE/"}" >&2
echo "$OUT"
