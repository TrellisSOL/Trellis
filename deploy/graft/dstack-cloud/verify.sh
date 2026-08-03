#!/bin/sh
# Verify a Trellis Graft endpoint running in a dstack confidential VM on the TEE cloud.
#
#   sh deploy/graft/dstack-cloud/verify.sh --dir ./trellis-graft-dstack --name <cvm name> [--endpoint https://...]
#
# It checks, and prints one PASS/FAIL/WARN line each:
#   config       graft.yaml validates against deploy/graft/graft.schema.json
#   document     GET /.well-known/trellis-attestation (falls back to /attest, the only path older sidecars serve)
#                answers, and is not simulated (dev) evidence
#   evidence     bun scripts/graft-cli.ts verify: report data binds the TLS key, receipt key and digests; the
#                certificate carries the attestation name and the attested key; a fresh quote echoes a nonce; the
#                model digest is graft.yaml's
#   quote        the quote's signature and TCB verify at the cloud's public verifier (Intel DCAP collateral)
#   compose      the compose hash the quote binds equals sha256 of the CVM's app-compose.json, and that document
#                embeds the local docker-compose.yml byte for byte
#   model        bindings.model_digest equals graft.yaml model.weights_sha256
#   gpu          when the document carries GPU evidence: the quote's bindings commit to it, its nonce is derived from
#                the bound keys, and the NVIDIA Remote Attestation Service tokens verify against that service's
#                published keys, are unexpired and report success for an allowed model (sidecar/src/attestation/
#                gpu-verify.ts). A gpu.cc_mode "on" claim with no GPU evidence in the document fails.
# Exit 1 when any required check fails. Needs curl, jq or bun, sha256sum/shasum/openssl; bun and this repository
# for the evidence check; npx for the cloud CLI unless --app-compose names the document.
#
# -k is used only to download evidence documents: the sidecar's certificate is self-signed and bound to its quote,
# and the evidence check pins and checks that certificate against the quote.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
CLI=${DSTACK_CLOUD_CLI:-}
# The same public verifier the router uses (TEE_CLOUD_VERIFIER_URL in src/config.ts). No authentication.
VERIFIER_URL=${TEE_CLOUD_VERIFIER_URL:-}
PLACEHOLDER_SHA='sha256:0000000000000000000000000000000000000000000000000000000000000000'

usage() {
  cat <<'USAGE'
usage: verify.sh [--dir <dir>] [--name <cvm name>] [--endpoint <https://host>] [options]

  --dir <dir>            the directory deploy.sh wrote (default ./trellis-graft-dstack): graft.yaml, docker-compose.yml
  --name <cvm name>      the CVM on the cloud; used to read app-compose.json and, without --endpoint, the endpoint
  --endpoint <url>       https://<app_id>-8443s.<gateway domain> (the TLS-passthrough name, note the s)
  --app-compose <file>   the CVM's app-compose.json or attestation document, instead of asking the cloud CLI
  --router <url> --id <provider id>   also read the router's own verification of this provider
  --verifier-url <url>   quote verifier (or set TEE_CLOUD_VERIFIER_URL)
  --nras-url <url>       the NVIDIA Remote Attestation Service whose keys you trust for GPU tokens (default: graft.yaml's
                         gpu.nras_url, else https://nras.attestation.nvidia.com); never taken from the endpoint
  --nras-jwks-url <url>  where to fetch that service's signing keys (default: <nras url>/.well-known/jwks.json)
  --no-quote             skip the quote signature check (offline)
  --allow-simulated      do not fail on dev (simulated) evidence; every line then says SIMULATED
  --timeout <s>          per request (default 30)
  -h, --help
USAGE
}

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r | cut -d' ' -f1
  else die "need sha256sum, shasum or openssl"; fi
}
HAVE_JQ=0 HAVE_BUN=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1
command -v bun >/dev/null 2>&1 && HAVE_BUN=1
json_get() { # <file> <dotted path>
  if [ "$HAVE_JQ" = 1 ]; then jq -r "$2 // empty" "$1" 2>/dev/null || true
  elif [ "$HAVE_BUN" = 1 ]; then
    JSON_FILE=$1 JSON_FILTER=$2 bun -e '
      const d = JSON.parse(await Bun.file(process.env.JSON_FILE).text());
      let v = d; for (const k of process.env.JSON_FILTER.replace(/^\./, "").split(".").filter(Boolean)) v = v?.[k];
      if (v !== undefined && v !== null) console.log(typeof v === "string" ? v : JSON.stringify(v));' 2>/dev/null || true
  fi
}

PASSES=0 FAILS=0 WARNS=0
pass() { PASSES=$((PASSES + 1)); say "PASS  $1"; }
fail() { FAILS=$((FAILS + 1)); say "FAIL  $1"; }
warnl() { WARNS=$((WARNS + 1)); say "WARN  $1"; }

DIR=./trellis-graft-dstack NAME='' ENDPOINT='' APP_COMPOSE='' ROUTER='' PROVIDER_ID='' NO_QUOTE=0 ALLOW_SIM=0 TIMEOUT=30 NRAS_URL='' NRAS_JWKS_URL='' QUOTE_OK=0
while [ $# -gt 0 ]; do
  opt=$1
  case $opt in
    -h | --help) usage; exit 0 ;;
    --no-quote) NO_QUOTE=1; shift; continue ;;
    --allow-simulated) ALLOW_SIM=1; shift; continue ;;
    --*=*) val=${opt#*=}; opt=${opt%%=*}; shift ;;
    --*) [ $# -ge 2 ] || die "$opt needs a value"; val=$2; shift 2 ;;
    *) die "unexpected argument \"$opt\" (see --help)" ;;
  esac
  case $opt in
    --dir) DIR=$val ;;
    --name) NAME=$val ;;
    --endpoint) ENDPOINT=$val ;;
    --app-compose) APP_COMPOSE=$val ;;
    --router) ROUTER=$val ;;
    --id) PROVIDER_ID=$val ;;
    --verifier-url) VERIFIER_URL=$val ;;
    --nras-url) NRAS_URL=$val ;;
    --nras-jwks-url) NRAS_JWKS_URL=$val ;;
    --timeout) TIMEOUT=$val ;;
    *) die "unknown option $opt (see --help)" ;;
  esac
done
[ -d "$DIR" ] || die "$DIR is not a directory (deploy.sh writes it)"
DIR=$(cd "$DIR" && pwd)
[ "$HAVE_JQ" = 1 ] || [ "$HAVE_BUN" = 1 ] || die "need jq or bun to read JSON"
command -v curl >/dev/null 2>&1 || die "need curl"

say "Trellis Graft verify (dstack cloud)"

# ---- config -------------------------------------------------------------------------------------------------------------
GRAFT_YAML="$DIR/graft.yaml"
if [ ! -f "$GRAFT_YAML" ]; then
  fail "config: $GRAFT_YAML not found"
elif [ "$HAVE_BUN" = 1 ] && [ -f "$ROOT/deploy/graft/validate.ts" ]; then
  if bun "$ROOT/deploy/graft/validate.ts" "$GRAFT_YAML" >/dev/null 2>"$DIR/.validate.err"; then
    pass "config: graft.yaml is valid against deploy/graft/graft.schema.json"
  else
    fail "config: graft.yaml failed the schema check: $(tr '\n' ' ' <"$DIR/.validate.err")"
  fi
  rm -f "$DIR/.validate.err"
else
  warnl "config: bun or deploy/graft/validate.ts not available; graft.yaml was not checked against the schema"
fi
EXPECTED_DIGEST=''
[ -f "$GRAFT_YAML" ] && EXPECTED_DIGEST=$(sed -n 's/^ *weights_sha256: *"\{0,1\}\(sha256:[0-9a-f]\{64\}\)"\{0,1\}.*$/\1/p' "$GRAFT_YAML" | head -n 1)
# gpu.cc_mode, from the one-line form deploy.sh writes or the block form of graft.example.yaml (POSIX awk: no \| in sed).
CC_MODE=$(awk '
  /^gpu:/ { on = 1 }
  on && /^[^ #]/ && !/^gpu:/ { on = 0 }
  on && match($0, /cc_mode: *"?(on|off)"?/) { v = substr($0, RSTART, RLENGTH); gsub(/cc_mode: *|"/, "", v); print v; exit }' "$GRAFT_YAML" 2>/dev/null || true)

# ---- the CVM (endpoint and app-compose) -------------------------------------------------------------------------------------
CVM_JSON="$DIR/cvm.json"
if [ -n "$NAME" ] && [ -z "$ENDPOINT" ]; then
  # shellcheck disable=SC2086
  if [ -n "$CLI" ] && $CLI cvms get "$NAME" --json >"$CVM_JSON" 2>/dev/null && [ -s "$CVM_JSON" ]; then
    app_id=$(json_get "$CVM_JSON" '.app_id'); app_url=$(json_get "$CVM_JSON" '.app_url')
    if [ -n "$app_id" ] && [ -n "$app_url" ]; then
      host=${app_url#*://}; host=${host%%/*}; host=${host%%:*}
      ENDPOINT="https://$app_id-8443s.${host#*.}"
    fi
  fi
  [ -n "$ENDPOINT" ] || die "could not derive the endpoint for $NAME; pass --endpoint https://<app_id>-8443s.<gateway domain>"
fi
[ -n "$ENDPOINT" ] || die "--endpoint or --name is required"
ENDPOINT=${ENDPOINT%/}
case $ENDPOINT in https://*) ;; *) die "--endpoint must be https" ;; esac
say "endpoint:  $ENDPOINT"

if [ -z "$APP_COMPOSE" ] && [ -n "$NAME" ] && [ -n "$CLI" ]; then
  # shellcheck disable=SC2086
  if $CLI cvms attestation "$NAME" --json >"$DIR/attestation.json" 2>/dev/null && [ -s "$DIR/attestation.json" ]; then APP_COMPOSE="$DIR/attestation.json"; fi
fi

# ---- document -------------------------------------------------------------------------------------------------------------
ATTEST="$DIR/attest.json"
DOC_PATH=''
for p in /.well-known/trellis-attestation /attest; do
  if curl -fsSk --max-time "$TIMEOUT" "$ENDPOINT$p" -o "$ATTEST" 2>/dev/null && [ -s "$ATTEST" ]; then DOC_PATH=$p; break; fi
done
SIM=0
if [ -z "$DOC_PATH" ]; then
  fail "document: neither $ENDPOINT/.well-known/trellis-attestation nor $ENDPOINT/attest answered"
else
  if [ "$DOC_PATH" = /attest ]; then
    pass "document: $ENDPOINT/attest answered (this sidecar predates /.well-known/trellis-attestation; the document is the same)"
  else
    pass "document: $ENDPOINT$DOC_PATH answered"
  fi
  dev=$(json_get "$ATTEST" '.dev'); fmt=$(json_get "$ATTEST" '.format')
  if [ "$dev" = true ] || [ "$fmt" = dev-simulated ]; then
    SIM=1
    if [ "$ALLOW_SIM" = 1 ]; then warnl "document: SIMULATED evidence (dev). Nothing below proves an enclave is live."
    else fail "document: SIMULATED evidence (dev): the endpoint fabricates its quote. Refused (--allow-simulated to look anyway)."; fi
  else
    pass "document: evidence is not marked simulated"
  fi
fi

# ---- evidence (the project's client checks) ---------------------------------------------------------------------------------------
if [ -z "$DOC_PATH" ]; then
  say "      (evidence, quote, compose and model checks need the document; skipped)"
  say ""
  say "summary:   $PASSES passed, $FAILS failed, $WARNS warnings"
  exit 1
fi
if [ "$HAVE_BUN" = 1 ] && [ -f "$ROOT/scripts/graft-cli.ts" ]; then
  set -- "$ENDPOINT" --timeout-ms "$((TIMEOUT * 1000))"
  [ -f "$GRAFT_YAML" ] && set -- "$@" --config "$GRAFT_YAML"
  [ -n "$ROUTER" ] && set -- "$@" --router "$ROUTER" --id "${PROVIDER_ID:?--router needs --id <provider id>}"
  [ "$ALLOW_SIM" = 1 ] && set -- "$@" --allow-simulated
  set +e
  (cd "$ROOT" && bun scripts/graft-cli.ts verify "$@") >"$DIR/.verify.out" 2>&1; rc=$?
  set -e
  sed 's/^/      /' "$DIR/.verify.out"
  rm -f "$DIR/.verify.out"
  if [ "$rc" = 0 ]; then pass "evidence: graft verify passed (report data, certificate, fresh nonce, model digest${ROUTER:+, router record})"
  else fail "evidence: graft verify exited $rc"; fi
else
  warnl "evidence: bun or scripts/graft-cli.ts not available; the client checks were not run"
fi

# ---- quote signature at the cloud's verifier ------------------------------------------------------------------------------------
if [ "$NO_QUOTE" = 1 ]; then
  warnl "quote: signature check skipped (--no-quote)"
elif [ -s "$ATTEST" ] && [ "$SIM" = 0 ]; then
  quote=$(json_get "$ATTEST" '.evidence.quote')
  [ -n "$quote" ] || quote=$(json_get "$ATTEST" '.quote')
  if [ -z "$VERIFIER_URL" ]; then
    fail "quote: set TEE_CLOUD_VERIFIER_URL or pass --verifier-url"
  elif [ -z "$quote" ]; then
    fail "quote: no evidence.quote in the document"
  else
    printf '%s' "$quote" | tr -d '\n' >"$DIR/.quote.hex"
    if curl -fsS --max-time "$((TIMEOUT * 2))" "$VERIFIER_URL" -F "hex=<$DIR/.quote.hex" -o "$DIR/quote-verify.json" 2>/dev/null; then
      verified=$(json_get "$DIR/quote-verify.json" '.quote.verified')
      mrtd=$(json_get "$DIR/quote-verify.json" '.quote.body.mrtd'); rtmr3=$(json_get "$DIR/quote-verify.json" '.quote.body.rtmr3')
      if [ "$verified" = true ]; then QUOTE_OK=1; pass "quote: signature and collateral verified at $VERIFIER_URL (mrtd ${mrtd:-?}, rtmr3 ${rtmr3:-?})"
      else fail "quote: verifier did not report verified=true (saved $DIR/quote-verify.json)"; fi
    else
      fail "quote: $VERIFIER_URL did not answer (offline? --no-quote skips this)"
    fi
    rm -f "$DIR/.quote.hex"
  fi
elif [ "$SIM" = 1 ]; then
  warnl "quote: simulated evidence has no signature to verify"
fi

# ---- compose hash ------------------------------------------------------------------------------------------------------------
bound=$(json_get "$ATTEST" '.bindings.compose_hash' 2>/dev/null || true)
bound=${bound#sha256:}
if [ -z "$bound" ]; then
  fail "compose: the document has no bindings.compose_hash"
elif [ -z "$APP_COMPOSE" ]; then
  warnl "compose: bound compose hash sha256:$bound; no app-compose.json to compare (pass --name with the cloud CLI, or --app-compose <file>)"
elif [ ! -s "$APP_COMPOSE" ]; then
  fail "compose: $APP_COMPOSE is empty or missing"
else
  # The file is either app-compose.json itself (it has docker_compose_file at the top) or an attestation document
  # that carries it as a string. The hash is over the exact bytes of the document, so the raw file is copied as is.
  if [ -n "$(json_get "$APP_COMPOSE" '.docker_compose_file' | head -c 1)" ]; then
    cp "$APP_COMPOSE" "$DIR/app-compose.json"
    app_compose=present
  elif [ "$HAVE_JQ" = 1 ]; then
    app_compose=$(jq -r '
      def tcb: (.tcb_info // null) | if type == "string" then (try fromjson catch null) else . end;
      ((tcb | if type == "object" then .app_compose else null end) // .app_compose // .compose_file // empty)
      | if type == "string" then . else tojson end' "$APP_COMPOSE" 2>/dev/null || true)
    [ -z "$app_compose" ] || printf '%s' "$app_compose" >"$DIR/app-compose.json"
  else
    app_compose=$(ATT="$APP_COMPOSE" bun -e '
      const d = JSON.parse(await Bun.file(process.env.ATT).text());
      let t = d.tcb_info; if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = null; } }
      const w = t?.app_compose ?? d.app_compose ?? d.compose_file;
      if (w !== undefined && w !== null) process.stdout.write(typeof w === "string" ? w : JSON.stringify(w));' 2>/dev/null || true)
    [ -z "$app_compose" ] || printf '%s' "$app_compose" >"$DIR/app-compose.json"
  fi
  if [ -z "$app_compose" ]; then
    fail "compose: no app-compose document found in $APP_COMPOSE"
  else
    measured=$(sha256_stdin <"$DIR/app-compose.json")
    if [ "$measured" = "$bound" ]; then pass "compose: bound compose hash sha256:$bound equals sha256(app-compose.json)"
    else fail "compose: bound sha256:$bound but sha256(app-compose.json) is $measured"; fi
    if [ -f "$DIR/docker-compose.yml" ]; then
      if [ "$HAVE_JQ" = 1 ]; then jq -j '.docker_compose_file // empty' "$DIR/app-compose.json" >"$DIR/.embedded.yml" 2>/dev/null || :
      else AC="$DIR/app-compose.json" bun -e 'const d = JSON.parse(await Bun.file(process.env.AC).text()); process.stdout.write(d.docker_compose_file ?? "");' >"$DIR/.embedded.yml" 2>/dev/null || :; fi
      if [ -s "$DIR/.embedded.yml" ] && cmp -s "$DIR/.embedded.yml" "$DIR/docker-compose.yml"; then
        pass "compose: app-compose.json embeds $DIR/docker-compose.yml byte for byte"
      elif [ -s "$DIR/.embedded.yml" ]; then
        fail "compose: the CVM runs a different compose file than $DIR/docker-compose.yml (diff $DIR/.embedded.yml)"
      else
        warnl "compose: app-compose.json has no docker_compose_file to compare"
      fi
      [ -s "$DIR/.embedded.yml" ] && cmp -s "$DIR/.embedded.yml" "$DIR/docker-compose.yml" && rm -f "$DIR/.embedded.yml"
    fi
    if [ "$HAVE_BUN" = 1 ] && [ -f "$ROOT/scripts/check-reproducible.ts" ] && [ -f "$DIR/docker-compose.yml" ]; then
      say "      (full pin check: bun scripts/check-reproducible.ts --compose $DIR/docker-compose.yml --app-compose $DIR/app-compose.json --compose-hash sha256:$bound)"
    fi
  fi
fi

# ---- model digest --------------------------------------------------------------------------------------------------------------
md=$(json_get "$ATTEST" '.bindings.model_digest' 2>/dev/null || true)
src=$(json_get "$ATTEST" '.digest_source' 2>/dev/null || true)
if [ -z "$md" ]; then
  fail "model: the document has no bindings.model_digest"
elif [ -z "$EXPECTED_DIGEST" ]; then
  warnl "model: bound $md; graft.yaml has no weights_sha256 to compare"
elif [ "$EXPECTED_DIGEST" = "$PLACEHOLDER_SHA" ]; then
  warnl "model: graft.yaml still carries the <to-be-published> placeholder digest; bound $md"
elif [ "$md" = "$EXPECTED_DIGEST" ]; then
  pass "model: bound digest equals graft.yaml ($md${src:+, $src})"
else
  fail "model: bound $md but graft.yaml declares $EXPECTED_DIGEST"
fi

# ---- gpu -----------------------------------------------------------------------------------------------------------------------
# The document's gpu member is null unless the sidecar's gpu.cc_mode is on. When present, everything below is re-checked
# here, outside the enclave: nothing is taken on the sidecar's word except the driver state it recorded (see README).
GPU_BOUND=$(json_get "$ATTEST" '.bindings.gpu_evidence_sha256' 2>/dev/null || true)
GPU_PUBLISHED=$(json_get "$ATTEST" '.gpu.evidence_sha256' 2>/dev/null || true)
GPU_VERIFY="$ROOT/sidecar/src/attestation/gpu-verify.ts"
if [ -z "$GPU_BOUND" ] && [ -z "$GPU_PUBLISHED" ]; then
  if [ "$CC_MODE" = on ]; then
    fail "gpu: graft.yaml claims gpu.cc_mode on, but the document carries no GPU evidence (gpu: null) and the quote commits to none. The claim is unsupported: set gpu.cc_mode on in the sidecar's own configuration (README.md, GPU)"
  elif [ -n "$CC_MODE" ]; then
    pass "gpu: no confidential-GPU claim (cc_mode off) and no GPU evidence: only the CPU side is attested"
  fi
elif [ "$HAVE_BUN" != 1 ] || [ ! -f "$GPU_VERIFY" ]; then
  warnl "gpu: the document carries GPU evidence (sha256 ${GPU_BOUND:-?}), but bun or sidecar/src/attestation/gpu-verify.ts is not available to check it"
else
  set +e
  ATTEST_FILE="$ATTEST" GRAFT_FILE="$GRAFT_YAML" GPU_VERIFY="$GPU_VERIFY" NRAS_URL="$NRAS_URL" NRAS_JWKS_URL="$NRAS_JWKS_URL" bun -e '
    const { verifyGpuEvidence } = await import(process.env.GPU_VERIFY);
    const doc = JSON.parse(await Bun.file(process.env.ATTEST_FILE).text());
    let declared = {};
    try { declared = Bun.YAML.parse(await Bun.file(process.env.GRAFT_FILE).text())?.gpu ?? {}; } catch {}
    const models = Array.isArray(declared.allowed_models) ? declared.allowed_models.map(String) : [];
    const issuer = process.env.NRAS_URL || declared.nras_url || undefined;
    const r = await verifyGpuEvidence(doc, { issuer, jwksUrl: process.env.NRAS_JWKS_URL || undefined, policy: models.length ? { allowedModels: models } : {} });
    const gpus = r.gpus.map((g) => `${g.id} ${g.model}${g.driver_version ? ` driver ${g.driver_version}` : ""} cc ${g.cc_state}`).join("; ");
    if (r.ok) console.log(`${r.gpus.length} GPU(s) [${gpus}], verified ${r.verifiedAt}, tokens valid until ${r.expiresAt}${models.length ? `, models allowed by graft.yaml: ${models.join(", ")}` : ", no allowed_models in graft.yaml so the model was not judged"}`);
    else console.log(r.failures.map((f) => `${f.code}: ${f.message}`).join(" | ") || r.status);
    process.exit(r.ok ? 0 : 1);' >"$DIR/.gpu.out" 2>&1; rc=$?
  set -e
  detail=$(tr '\n' ' ' <"$DIR/.gpu.out"); rm -f "$DIR/.gpu.out"
  if [ "$rc" = 0 ]; then
    pass "gpu: NVIDIA attestation tokens verify and the bindings commit to them: $detail"
    [ "$QUOTE_OK" = 1 ] || warnl "gpu: the binding is only as good as the quote, whose signature was not verified in this run"
    [ "$CC_MODE" = on ] || warnl "gpu: the endpoint attests its GPUs but graft.yaml does not claim gpu.cc_mode on"
    say "      (not established: that the GPU is hardware-bound to this TD, and the CC state beyond what the in-guest driver reported; README.md, GPU)"
  else
    fail "gpu: GPU evidence did not verify: $detail"
  fi
fi

say ""
sim_note=''
[ "$SIM" = 0 ] || sim_note=' (SIMULATED evidence)'
say "summary:   $PASSES passed, $FAILS failed, $WARNS warnings$sim_note"
[ "$FAILS" = 0 ] || exit 1
