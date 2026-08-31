#!/bin/bash
# What the mainnet kit knows about the source it builds and deploys from, in one place (security/REVIEW-ROUND3-2026-10.md
# R3-10, R3-21; security/REVIEW-ROUND4-2026-10.md R4-16). Sourced by build.sh and deploy.sh; run by preflight.ts and verify.ts:
#
#   scripts/mainnet/source-state.sh --json     {"root", "ownTree", "commit", "dirty": [...], "sourceKey", "headKey",
#                                               "indexFlags": [...], "differs": [...], "replaceRefCount"}
#
#   source_root            the directory the programs are built from: the repository, or TRELLIS_ROOT (a rehearsal's copy
#                          of the sources; every mainnet script refuses to start with TRELLIS_ROOT set)
#   source_own_tree R      0 when R is the top level of a git work tree of its own. A copy inside another repository's
#                          ignored directory is not: that repository's HEAD does not name the copy's contents.
#   source_commit R        the 40-hex HEAD of that tree; empty when there is none
#   source_dirty R         one line per uncommitted change, tracked or not: `git status --porcelain`, every path except
#                          deployments/ (the kit's own records, which it writes while it runs). Empty means clean.
#   source_key R           sha256 over every file that goes into a program build, AS IT LIES ON DISK under R: every file
#                          under programs/, and Cargo.toml and Cargo.lock (one "sha256  path" line each, sorted)
#   source_export R D      the same paths (and Anchor.toml) AS THE COMMIT HOLDS THEM, written to the empty directory D
#                          with `git archive HEAD`: nothing of the working tree, the index or an ignore rule is in it
#   source_head_key R      source_key of that export: the SOURCE KEY OF THE COMMIT. It names build.sh's output directory,
#                          build.json records it beside the binaries, and verify.ts holds a binary to it. Empty without a commit.
#   source_index_flags R   index entries marked skip-worktree or assume-unchanged (one path per line). git does not look
#                          at such a file, so `git status` calls the tree clean whatever the file holds.
#   source_differs R       build paths whose content on disk is not the commit's, or that exist on one side only (one
#                          path per line): a comparison by content, with no trust in the index or in an ignore rule
#   source_replace_refs R  the repository's replace refs (git replace), one per line. Every git call here runs with
#                          --no-replace-objects, and a repository that has any is refused (R5-17).
#   source_refusal R       why a MAINNET build or deploy must not start from R; empty when it may
#   binary_unchanged F S   0 when sha256(F) is S; otherwise says so and returns 1 (deploy.sh, between preflight and deploy)
#   key_file_private F     0 when F is readable by its owner only; otherwise says so and returns 1
#   record_deployer_conflict REC KEY   deploy.sh: 0 unless the record REC names another deployer than KEY (R3-21)
#   idl_decision PUBLISH SKIP          deploy.sh: "publish", or "skip: <why>" (R4-29)
#   deployed_authority_expected REC P AUTH KEY   deploy.sh: 0 when a program found at its id is held by the deployer, or
#                                      by the vault of its recorded hand-over; otherwise says STOP and returns 1 (R5-17)
#
# The rule: a mainnet build or deploy starts from a clean tree at a commit, and records that commit. "Clean" covers the
# whole tree, not only programs/: the scripts that deploy and verify are part of what is being trusted. And clean is
# judged by content, not by `git status` alone (R4-16): an index entry git was told not to look at, a source file a
# local exclude rule hides, or anything else that makes the build paths differ from the commit is a refusal. A
# rehearsal may run from a dirty tree, but only when it says so (--allow-dirty), and everything it writes then says so too.

source_root() { if [ -n "${TRELLIS_ROOT:-}" ]; then (cd "$TRELLIS_ROOT" && pwd -P); else (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); fi; }
# The git variables that could point git at another repository, index or object store are not honoured here.
# Nor are replacement objects (R5-17): with `git replace <commit> <other>` every git command serves the OTHER commit's
# tree under the first one's id, so status is clean, the id is the honest one, and what is on disk and in an export is
# something else. --no-replace-objects makes git answer with the objects the ids really name.
_git() { local root="$1"; shift; env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_COMMON_DIR -u GIT_REPLACE_REF_BASE git --no-replace-objects -C "$root" "$@"; }
# Replace refs of the repository (one ref name per line). Any at all is a refusal: a tree that is built for mainnet
# has no use for them, and their mere presence means other git tools on this machine show another history.
source_replace_refs() { source_own_tree "$1" || return 0; _git "$1" for-each-ref --format='%(refname)' refs/replace/ 2>/dev/null || true; }
source_own_tree() {
  local top
  top="$(_git "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$1" && pwd -P)" ]
}
source_commit() { source_own_tree "$1" || return 0; _git "$1" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null || true; }
source_dirty() { source_own_tree "$1" || return 0; _git "$1" status --porcelain --untracked-files=all -- . ':(exclude)deployments' 2>/dev/null || echo "?? (git status failed)"; }
# What goes into a program build. Anchor.toml is exported with them (the build checks read it) and is not part of the key.
SOURCE_PATHS=(programs Cargo.toml Cargo.lock)
source_key() {
  (cd "$1" && find "${SOURCE_PATHS[@]}" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done) | shasum -a 256 | cut -d' ' -f1
}
# One "sha256  path" line per file of the build paths under $1 (what source_key hashes).
_source_lines() { (cd "$1" && find "${SOURCE_PATHS[@]}" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done); }
source_export() { # source_export <root> <empty dir>: the commit's build paths (and Anchor.toml), from git's objects
  local root="$1" dest="$2" paths=() p
  source_own_tree "$root" || return 1
  for p in "${SOURCE_PATHS[@]}" Anchor.toml; do _git "$root" cat-file -e "HEAD:$p" 2>/dev/null && paths+=("$p"); done
  [ "${#paths[@]}" -gt 0 ] || return 1
  mkdir -p "$dest" && _git "$root" archive --format=tar HEAD -- "${paths[@]}" | tar -x -C "$dest"
}
# The lines of the commit, through a throwaway export.
_head_lines() {
  local tmp rc=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/trellis-source.XXXXXX")" || return 1
  if source_export "$1" "$tmp" 2>/dev/null; then _source_lines "$tmp"; else rc=1; fi
  rm -rf "$tmp"
  return "$rc"
}
source_head_key() { local lines; lines="$(_head_lines "$1")" || return 0; printf '%s\n' "$lines" | shasum -a 256 | cut -d' ' -f1; }
source_index_flags() {
  source_own_tree "$1" || return 0
  # `git ls-files -v`: H is an ordinary entry; a lowercase letter is assume-unchanged, S is skip-worktree.
  _git "$1" ls-files -v -- . ':(exclude)deployments' 2>/dev/null | grep -v '^H ' | cut -c3- || true
}
source_differs() {
  source_own_tree "$1" || return 0
  local head disk
  head="$(_head_lines "$1")" || { echo "(the commit's build paths could not be exported)"; return 0; }
  disk="$(_source_lines "$1")"
  # Lines that are on one side only: a changed file shows on both, an added or missing one on one. The path is the answer.
  { diff <(printf '%s\n' "$head") <(printf '%s\n' "$disk") || true; } | sed -n 's/^[<>] [0-9a-f]*  //p' | LC_ALL=C sort -u
}
source_refusal() {
  local root="$1" commit dirty flags differs n
  if ! source_own_tree "$root"; then echo "the source root is not a git work tree of its own, so no commit names what would be built"; return 0; fi
  commit="$(source_commit "$root")"
  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then echo "the source tree has no commit (git rev-parse HEAD failed)"; return 0; fi
  flags="$(source_replace_refs "$root")"
  if [ -n "$flags" ]; then
    n="$(printf '%s\n' "$flags" | wc -l | tr -d ' ')"
    echo "the repository carries $n replace ref(s) (git replace; first: $(printf '%s\n' "$flags" | head -1)): with them a commit id names another tree than the one everybody else gets for it. Delete them (git replace -d <object>) and check the tree out again"
    return 0
  fi
  dirty="$(source_dirty "$root")"
  if [ -n "$dirty" ]; then
    n="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
    echo "the source tree has uncommitted changes ($n path(s), first: $(printf '%s\n' "$dirty" | head -1 | cut -c4-)); commit them, so that the recorded commit names what is built and what verifies it"
    return 0
  fi
  # `git status` is clean. That is git's word; these two are the content's (R4-16).
  flags="$(source_index_flags "$root")"
  if [ -n "$flags" ]; then
    n="$(printf '%s\n' "$flags" | wc -l | tr -d ' ')"
    echo "the index marks $n path(s) skip-worktree or assume-unchanged (first: $(printf '%s\n' "$flags" | head -1)): git does not look at them, so a clean \`git status\` says nothing about what they hold. Clear the flags (git update-index --no-skip-worktree --no-assume-unchanged <path>) and commit or discard what they hid"
    return 0
  fi
  differs="$(source_differs "$root")"
  if [ -n "$differs" ]; then
    n="$(printf '%s\n' "$differs" | wc -l | tr -d ' ')"
    echo "the program sources on disk differ from the commit in $n path(s) that \`git status\` does not show (first: $(printf '%s\n' "$differs" | head -1)): a file an ignore or exclude rule hides, or content the index was told not to compare. Remove or commit them, so that the commit names what is built"
  fi
  return 0
}
binary_unchanged() {
  local now
  now="$(shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$now" ] || [ "$now" != "$2" ]; then echo "$(basename "$1") changed since the preflight read it (sha256 then $2, now ${now:-unreadable}): not deployed. Run the preflight again and read what it says." >&2; return 1; fi
  return 0
}
key_file_private() {
  local mode
  mode="$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null)" || { echo "$1 could not be examined" >&2; return 1; }
  case "$mode" in *00) return 0 ;; esac
  echo "keypair file $1 is readable by other users (mode $mode); chmod 600" >&2
  return 1
}

# deploy.sh (R3-21): the record says which key is "the operator" (`deployer`), and verify.ts, handover.ts and the monitor
# judge every role against it. A run with another keypair does not get to change that by running.
record_deployer_conflict() { # record_deployer_conflict <record file> <this run's deployer>
  local recorded
  [ -f "$1" ] || return 0
  recorded="$(jq -r '.deployer // empty' "$1" 2>/dev/null)" || return 0
  [ -z "$recorded" ] || [ "$recorded" = "$2" ] && return 0
  echo "the deployments record names $recorded as the deployer (the operator key every role is judged against); this run's deployer keypair is $2. deploy.sh does not change who the operator is: use the recorded deployer's keypair, or, if the record is wrong, correct it by hand in a reviewed change" >&2
  return 1
}
# deploy.sh (R5-17): a program that is already deployed at its id. Its upgrade authority, as the chain names it, must be
# the deployer, or the vault (or "none", when the upgrades were frozen) of a hand-over the record lists as resolved for
# THAT program. Any other key holding the program means somebody else deployed there or took it: the run stops.
deployed_authority_expected() { # deployed_authority_expected <record file> <program> <upgrade authority on chain> <deployer>
  local rec="$1" p="$2" auth="$3" deployer="$4" vault="" resolved="" frozen=""
  [ -n "$auth" ] && [ "$auth" = "$deployer" ] && return 0
  if [ -f "$rec" ]; then
    vault="$(jq -r '.handover.multisigVault // empty' "$rec" 2>/dev/null || true)"
    resolved="$(jq -r --arg p "$p" '.handover.resolved[$p] // empty' "$rec" 2>/dev/null || true)"
    frozen="$(jq -r '.handover.frozen // empty' "$rec" 2>/dev/null || true)"
  fi
  if [ -n "$resolved" ] && [ -n "$vault" ] && [ "$auth" = "$vault" ]; then return 0; fi
  if [ -n "$resolved" ] && [ "$frozen" = "true" ] && [ "$auth" = "none" ]; then return 0; fi
  local hint=""
  # The vault, but no hand-over of this program in the record: `handover.ts check` is what records one.
  if [ -n "$vault" ] && [ "$auth" = "$vault" ]; then hint=" (That key is the multisig vault the record names. If its hand-over of $p has resolved, run scripts/mainnet/handover.ts check first: it records the hand-over, and this run then expects the vault.)"; fi
  echo "STOP: $p is already deployed, and the chain names ${auth:-unreadable} as its upgrade authority: neither the deployer $deployer nor the vault of a hand-over the record lists for $p. Nothing was recorded for it and nothing further was deployed. Do not initialise it; find out who holds that key before anything else.$hint" >&2
  return 1
}
# deploy.sh (R4-29): `anchor idl init` (Anchor 1.2) runs `npx program-metadata`, a package fetched at that moment, with
# the path of the deployer keypair. That is not done unless the run asks for it.
idl_decision() { # idl_decision <publish 0|1> <skip 0|1>
  if [ "$1" = "1" ] && [ "$2" = "1" ]; then echo "--publish-idl and --skip-idl contradict each other" >&2; return 2; fi
  if [ "$2" = "1" ]; then echo "skip: --skip-idl"; return 0; fi
  if [ "$1" = "1" ]; then echo "publish"; return 0; fi
  echo "skip: IDL publication is off by default: it runs a package fetched at that moment (\`anchor idl init\` runs \`npx program-metadata\`) with the deployer keypair. Pass --publish-idl to do it from this run"
}

_json_list() { # _json_list <lines>: the first 20 as JSON strings, comma separated
  local first=1 line
  [ -n "$1" ] || return 0
  while IFS= read -r line; do
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '"%s"' "$(printf '%s' "$line" | sed 's/[\\"]/\\&/g')"
  done <<< "$(printf '%s\n' "$1" | head -20)"
}
_count() { if [ -n "$1" ]; then printf '%s\n' "$1" | wc -l | tr -d ' '; else echo 0; fi; }

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    --json)
      R="$(source_root)"
      OWN=false; source_own_tree "$R" && OWN=true
      DIRTY="$(source_dirty "$R")"
      FLAGS="$(source_index_flags "$R")"
      # The comparison by content is the answer to "git status is clean": it is made only then.
      DIFFERS=""; if [ "$OWN" = true ] && [ -z "$DIRTY" ]; then DIFFERS="$(source_differs "$R")"; fi
      printf '{"root":"%s","ownTree":%s,"commit":"%s","dirty":[' "$R" "$OWN" "$(source_commit "$R")"
      _json_list "$(printf '%s' "$DIRTY" | cut -c4-)"
      printf '],"dirtyCount":%s,"sourceKey":"%s","headKey":"%s","indexFlags":[' "$(_count "$DIRTY")" "$(source_key "$R")" "$(source_head_key "$R")"
      _json_list "$FLAGS"
      printf '],"indexFlagCount":%s,"differs":[' "$(_count "$FLAGS")"
      _json_list "$DIFFERS"
      printf '],"differsCount":%s,"replaceRefCount":%s}\n' "$(_count "$DIFFERS")" "$(_count "$(source_replace_refs "$R")")"
      ;;
    *) sed -n '2,40p' "$0"; exit 2 ;;
  esac
fi
