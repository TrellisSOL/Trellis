#!/bin/sh
# Trellis Graft on the dstack cloud (Intel TDX confidential VMs, optional NVIDIA GPUs in confidential-computing mode).
#
#   sh deploy/graft/dstack-cloud/deploy.sh --name my-graft --payout-address <base58> [options]
#   sh deploy/graft/dstack-cloud/deploy.sh --dry-run ...          # write the files, print the CLI commands, call nothing
#
# From a checkout of this repository it: renders graft.yaml (checked against deploy/graft/graft.schema.json), a
# router API key (0600, never printed), network.json (payout address, router, on-chain anchor program) and
# docker-compose.yml from a pinned template; then creates the CVM through the cloud's CLI (`$DSTACK_CLOUD_CLI deploy`), waits
# for it, reads its attestation and prints the attestation URL and the compose hash the platform measured. Running it
# again with the same options changes no file and creates nothing twice. Nothing is pushed to any registry.
#
# POSIX sh, set -eu. Needs: sha256sum, shasum or openssl; jq or bun for JSON; npx (Node) for the cloud CLI; docker
# only with --build or --pull. The API key is read by the CLI itself and never by this script.
#
# Profiles:
#   cpu  (default) the approved network build: llama.cpp + Qwen2.5-0.5B GGUF on a small TDX instance; the sidecar runs
#        from a pinned public source tarball. Template: deploy/network/approved/tdx-qwen2.5-0.5b/docker-compose.template.yml
#        (the sidecar's dstack example with a token for your router key hash).
#   gpu  vLLM on NVIDIA GPUs + the Graft image (ghcr.io/<org>/graft, pinned by digest). Template:
#        docker-compose.gpu.template.yml next to this script.

set -eu

DEPLOY_VERSION=0.1.0
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
DEFAULT_ROUTER=https://trellis.example
DEFAULT_GRAFT_IMAGE='ghcr.io/<org>/graft'
PLACEHOLDER_SHA='sha256:0000000000000000000000000000000000000000000000000000000000000000'
CLI=${DSTACK_CLOUD_CLI:-}

# Patterns shared with graft.schema.json (see deploy/graft/install.sh).
RE_HOST_ID='^0x[0-9a-f]{64}$'
RE_HF_REPO='^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'
RE_SHA256='^sha256:[0-9a-f]{64}$'
RE_SERVED_NAME='^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
RE_POLICY='^[a-z0-9][a-z0-9._-]{0,63}$'
RE_KMS='^[a-z0-9][a-z0-9-]{0,63}$'
RE_REGION='^[a-z0-9][a-z0-9-]{1,31}$'
RE_PRICE='^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$'
RE_IMAGE='^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$'
RE_IMAGE_PLACEHOLDER='^[a-z0-9][a-z0-9._/:<>-]*@sha256:<to-be-published>$'
RE_NAME='^[a-z0-9][a-z0-9-]{0,62}$'
RE_BASE58='^[1-9A-HJ-NP-Za-km-z]{32,44}$'
RE_HEX40='^[0-9a-f]{40}$'
RE_INT='^[1-9][0-9]{0,3}$'
RE_URL='^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$'
RE_DISK='^[1-9][0-9]{0,3}G$'
RE_GPU_MODEL='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
RE_HTTPS_URL='^https://[A-Za-z0-9._-]+(:[0-9]{1,5})?$'
DEFAULT_NRAS_URL=https://nras.attestation.nvidia.com

usage() {
  cat <<'USAGE'
Trellis Graft on the dstack cloud

usage: deploy.sh [options]

The CVM:
  --name <name>             CVM name on the cloud (default trellis-graft)
  --profile cpu|gpu         cpu: approved build, llama.cpp + Qwen2.5-0.5B (default). gpu: vLLM + the Graft image
  --instance-type <type>    cloud instance type (default tdx.medium for cpu; required for gpu: `$DSTACK_CLOUD_CLI instance-types gpu`)
  --region <code>           cloud region (default: the cloud chooses) and graft.yaml region (default us-east)
  --disk-size <nG>          data disk (default 20G for cpu, 200G for gpu)
  --os-image <name>         pin the dstack OS image version (default: the cloud chooses one for the instance type)
  --node-id <id>            pin a node (default: the cloud chooses)
  --public-logs             leave container logs public (default: off; the sidecar logs no request content anyway)
  --update                  if the CVM exists, redeploy it with the newly rendered compose file (default: leave it)

The model (gpu profile):
  --graft-image <ref>       the Graft image, name@sha256:<64 hex> (default ghcr.io/<org>/graft@sha256:<to-be-published>)
  --build                   build sidecar/Dockerfile as --graft-image's name and pin the resulting digest (needs docker)
  --pull                    pull --graft-image's name:tag and pin its digest (needs docker)
  --vllm-image <ref>        vLLM image, name@sha256:<64 hex>                                           (required for gpu)
  --hf-repo <owner/name>    Hugging Face repository of the weights                                      (required for gpu)
  --hf-revision <40 hex>    the commit to download (a branch name is refused)                           (required for gpu)
  --served-name <name>      the model id vLLM serves (default: the repository name, lower case)
  --gpu-count <n>           GPUs for vLLM (default 1; >1 sets multi_gpu ppcie unless --multi-gpu says otherwise)
  --multi-gpu single|nvle|ppcie
  --gpu-models <list>       GPU hardware models the sidecar accepts, comma-separated, as the NVIDIA attestation
                            service names them in hwmodel (Hopper: GH100)                  (required with --cc-mode on)
  --nras-url <https url>    NVIDIA Remote Attestation Service (default https://nras.attestation.nvidia.com)

What is declared (graft.yaml and network.json):
  --model-digest <digest>   Trellis model digest, sha256:<64 hex> (default: zeros, written as <to-be-published>)
  --lanes <list>            public, attested, unlinkable (default public,attested)
  --price-in <usdc>         USDC per million input tokens (default 0.20)   --price-out <usdc> (default 0.90)
  --policy <id>             measured policy id (default default-v1)        --kms <id> (default trellis-main)
  --cc-mode on|off          NVIDIA confidential-computing mode (default: on for gpu, off for cpu). on is enforced: the
                            sidecar refuses to start unless every GPU attests, and binds that evidence into its quote
  --host-id <0x + 64 hex>   HostBond id (default: generated once, then kept)
  --payout-address <b58>    USDC payout owner, a base58 Solana public key   (required unless --dry-run)
  --router <url>            the Trellis router (default https://trellis.example)
  --anchor-program-id <id>  trellis_anchor program (default: deployments/devnet.json)   --cluster <name> (default devnet)

Running it:
  --out <dir>               where to write the files (default ./trellis-graft-dstack)
  --dry-run                 write the files, print every cloud command, run none of them
  --wait-seconds <n>        how long to wait for the CVM (default 1800)
  -h, --help                this text          --version     the script version

The cloud CLI manages its own credentials; this script never reads or prints it. The router API key is
written to <dir>/router-api-key (0600) and never printed: hand it to the router's operator privately.
USAGE
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
matches() {
  case $2 in *'
'*) return 1 ;; esac
  printf '%s\n' "$2" | grep -Eq -- "$1"
}
need() { matches "$3" "$2" || die "$1 \"$2\" is not $4"; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r | cut -d' ' -f1
  else die "need sha256sum, shasum or openssl"; fi
}
random_hex32() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
install_file() { # <tmp> <dest> <mode>
  chmod "$3" "$1"
  if [ -f "$2" ] && cmp -s "$1" "$2"; then rm -f "$1"; say "  unchanged  $2"
  else mv -f "$1" "$2"; say "  wrote      $2"; fi
}
# json_get <file> <jq filter>: one value, or empty. jq when present, else bun.
json_get() {
  if command -v jq >/dev/null 2>&1; then jq -r "$2 // empty" "$1" 2>/dev/null || true
  elif command -v bun >/dev/null 2>&1; then
    JSON_FILE=$1 JSON_FILTER=$2 bun -e '
      const d = JSON.parse(await Bun.file(process.env.JSON_FILE).text());
      const f = process.env.JSON_FILTER.replace(/^\./, "").split(".").filter(Boolean);
      let v = d; for (const k of f) v = v?.[k];
      if (v !== undefined && v !== null) console.log(typeof v === "string" ? v : JSON.stringify(v));' 2>/dev/null || true
  else
    warn "neither jq nor bun found: cannot read JSON ($2)"
  fi
}

# ---- options --------------------------------------------------------------------------------------------------------
NAME=trellis-graft PROFILE=cpu INSTANCE_TYPE='' CLOUD_REGION='' DISK_SIZE='' OS_IMAGE='' NODE_ID='' PUBLIC_LOGS=0 UPDATE=0
GRAFT_IMAGE='' BUILD=0 PULL=0 VLLM_IMAGE='' HF_REPO='' HF_REVISION='' SERVED_NAME='' GPU_COUNT=1 MULTI_GPU=''
MODEL_DIGEST='' LANES=public,attested PRICE_IN=0.20 PRICE_OUT=0.90 POLICY=default-v1 KMS=trellis-main CC_MODE='' HOST_ID=''
GPU_MODELS='' NRAS_URL=$DEFAULT_NRAS_URL
PAYOUT='' ROUTER=$DEFAULT_ROUTER ANCHOR_PROGRAM_ID='' CLUSTER=devnet REGION=''
OUT=./trellis-graft-dstack DRY_RUN=0 WAIT_SECONDS=1800

while [ $# -gt 0 ]; do
  opt=$1
  case $opt in
    -h | --help) usage; exit 0 ;;
    --version) say "$DEPLOY_VERSION"; exit 0 ;;
    --dry-run) DRY_RUN=1; shift; continue ;;
    --build) BUILD=1; shift; continue ;;
    --pull) PULL=1; shift; continue ;;
    --public-logs) PUBLIC_LOGS=1; shift; continue ;;
    --update) UPDATE=1; shift; continue ;;
    --*=*) val=${opt#*=}; opt=${opt%%=*}; shift ;;
    --*) [ $# -ge 2 ] || die "$opt needs a value"; val=$2; shift 2 ;;
    *) die "unexpected argument \"$opt\" (see --help)" ;;
  esac
  case $opt in
    --name) NAME=$val ;;
    --profile) PROFILE=$val ;;
    --instance-type) INSTANCE_TYPE=$val ;;
    --region) CLOUD_REGION=$val; REGION=$val ;;
    --disk-size) DISK_SIZE=$val ;;
    --os-image) OS_IMAGE=$val ;;
    --node-id) NODE_ID=$val ;;
    --graft-image) GRAFT_IMAGE=$val ;;
    --vllm-image) VLLM_IMAGE=$val ;;
    --hf-repo) HF_REPO=$val ;;
    --hf-revision) HF_REVISION=$val ;;
    --served-name) SERVED_NAME=$val ;;
    --gpu-count) GPU_COUNT=$val ;;
    --multi-gpu) MULTI_GPU=$val ;;
    --gpu-models) GPU_MODELS=$val ;;
    --nras-url) NRAS_URL=$val ;;
    --model-digest) MODEL_DIGEST=$val ;;
    --lanes) LANES=$val ;;
    --price-in) PRICE_IN=$val ;;
    --price-out) PRICE_OUT=$val ;;
    --policy) POLICY=$val ;;
    --kms) KMS=$val ;;
    --cc-mode) CC_MODE=$val ;;
    --host-id) HOST_ID=$val ;;
    --payout-address) PAYOUT=$val ;;
    --router) ROUTER=$val ;;
    --anchor-program-id) ANCHOR_PROGRAM_ID=$val ;;
    --cluster) CLUSTER=$val ;;
    --out) OUT=$val ;;
    --wait-seconds) WAIT_SECONDS=$val ;;
    *) die "unknown option $opt (see --help)" ;;
  esac
done

say "Trellis Graft on the dstack cloud, deploy.sh $DEPLOY_VERSION"
[ "$DRY_RUN" = 1 ] && say "dry run:   files are written locally; no cloud command runs"

# ---- checks ---------------------------------------------------------------------------------------------------------
need --name "$NAME" "$RE_NAME" "a lower-case name (letters, digits, dashes)"
case $PROFILE in cpu | gpu) ;; *) die "--profile must be cpu or gpu" ;; esac
ROUTER=${ROUTER%/}
need --router "$ROUTER" "$RE_URL" "an http(s) URL without a path"
need --policy "$POLICY" "$RE_POLICY" "a policy id"
need --kms "$KMS" "$RE_KMS" "a KMS cluster id"
need --price-in "$PRICE_IN" "$RE_PRICE" "a decimal like 0.20"
need --price-out "$PRICE_OUT" "$RE_PRICE" "a decimal like 0.90"
matches '^[0-9]+$' "$WAIT_SECONDS" || die "--wait-seconds must be a number"
[ -n "$REGION" ] || REGION=us-east
need --region "$REGION" "$RE_REGION" "a region code like us-east"
if [ -n "$DISK_SIZE" ]; then need --disk-size "$DISK_SIZE" "$RE_DISK" "a size like 50G"; fi
if [ -n "$HOST_ID" ]; then need --host-id "$HOST_ID" "$RE_HOST_ID" "0x and 64 lowercase hex"; fi
if [ -n "$PAYOUT" ]; then need --payout-address "$PAYOUT" "$RE_BASE58" "a base58 Solana public key"
elif [ "$DRY_RUN" = 0 ]; then die "--payout-address <base58 Solana public key> is required (where USDC is paid out)"
else PAYOUT='<payout address, base58>'; fi
need --cluster "$CLUSTER" '^[a-z0-9-]{1,32}$' "a cluster name like devnet"

lanes_yaml='' seen=','
old_ifs=$IFS; IFS=,
for lane in $LANES; do
  case $lane in public | attested | unlinkable) ;; *) IFS=$old_ifs; die "--lanes: \"$lane\" is not public, attested or unlinkable" ;; esac
  case $seen in *",$lane,"*) IFS=$old_ifs; die "--lanes lists $lane twice" ;; esac
  seen="$seen$lane,"; lanes_yaml="${lanes_yaml:+$lanes_yaml, }$lane"
done
IFS=$old_ifs
[ -n "$lanes_yaml" ] || die "--lanes is empty"

# Without --model-digest the placeholder stays: the approved build's GGUF digest is <to-be-published>, and a GPU
# model's digest is yours to compute (bun sidecar/src/main.ts digest <weights dir>).
[ -n "$MODEL_DIGEST" ] || MODEL_DIGEST=$PLACEHOLDER_SHA
case $MODEL_DIGEST in sha256:*) ;; *) MODEL_DIGEST=sha256:$MODEL_DIGEST ;; esac
need --model-digest "$MODEL_DIGEST" "$RE_SHA256" "sha256:<64 lowercase hex>"
[ "$MODEL_DIGEST" != "$PLACEHOLDER_SHA" ] || warn "model digest is the <to-be-published> placeholder: the sidecar will refuse to start until a real digest is on its allow-list (bun sidecar/src/main.ts digest <weights>)"

# The anchor program the router's receipt anchor writes to (deployments/<cluster>.json).
if [ -z "$ANCHOR_PROGRAM_ID" ]; then
  dep="$ROOT/deployments/$CLUSTER.json"
  if [ -f "$dep" ]; then
    ANCHOR_PROGRAM_ID=$(json_get "$dep" '.programs.trellis_anchor.programId')
    [ -n "$ANCHOR_PROGRAM_ID" ] || ANCHOR_PROGRAM_ID=$(sed -n '/"trellis_anchor"/,/}/p' "$dep" | sed -n 's/.*"programId": *"\([1-9A-HJ-NP-Za-km-z]*\)".*/\1/p' | head -n 1)
  fi
  [ -n "$ANCHOR_PROGRAM_ID" ] || die "could not read programs.trellis_anchor.programId from $dep; pass --anchor-program-id"
fi
need --anchor-program-id "$ANCHOR_PROGRAM_ID" "$RE_BASE58" "a base58 program id"

# ---- profile ----------------------------------------------------------------------------------------------------------
if [ "$PROFILE" = cpu ]; then
  TEMPLATE="$ROOT/deploy/network/approved/tdx-qwen2.5-0.5b/docker-compose.template.yml"
  [ -n "$INSTANCE_TYPE" ] || INSTANCE_TYPE=tdx.medium
  [ -n "$DISK_SIZE" ] || DISK_SIZE=20G
  [ -n "$CC_MODE" ] || CC_MODE=off
  [ -n "$MULTI_GPU" ] || MULTI_GPU=single
  ENGINE=llamacpp ENGINE_URL=http://llama:8080 HF_REPO=Qwen/Qwen2.5-0.5B-Instruct-GGUF SERVED_NAME=qwen2.5-0.5b-instruct QUANT=q4_k_m
  [ "$CC_MODE" = off ] || die "--cc-mode on makes no sense for the CPU profile (no GPU in the CVM)"
  [ -z "$GRAFT_IMAGE$VLLM_IMAGE$HF_REVISION" ] || warn "--graft-image, --vllm-image and --hf-revision are ignored by the cpu profile (the approved build pins its own images)"
else
  TEMPLATE="$HERE/docker-compose.gpu.template.yml"
  [ -n "$INSTANCE_TYPE" ] || { [ "$DRY_RUN" = 1 ] && INSTANCE_TYPE='<gpu instance type>'; }
  [ -n "$INSTANCE_TYPE" ] || die "--instance-type is required for the gpu profile: pick one from \`$CLI instance-types gpu\`"
  [ -n "$DISK_SIZE" ] || DISK_SIZE=200G
  [ -n "$CC_MODE" ] || CC_MODE=on
  need --gpu-count "$GPU_COUNT" "$RE_INT" "a count"
  if [ -z "$MULTI_GPU" ]; then if [ "$GPU_COUNT" = 1 ]; then MULTI_GPU=single; else MULTI_GPU=ppcie; fi; fi
  ENGINE=vllm ENGINE_URL=http://vllm:8000 QUANT=bf16
  [ -n "$HF_REPO" ] || { [ "$DRY_RUN" = 1 ] && HF_REPO='example-org/example-model'; }
  [ -n "$HF_REPO" ] || die "--hf-repo <owner/name> is required for the gpu profile"
  need --hf-repo "$HF_REPO" "$RE_HF_REPO" "owner/name"
  [ -n "$HF_REVISION" ] || { [ "$DRY_RUN" = 1 ] && HF_REVISION=0000000000000000000000000000000000000000; }
  [ -n "$HF_REVISION" ] || die "--hf-revision <40 hex commit> is required for the gpu profile (a branch name is not a pin)"
  need --hf-revision "$HF_REVISION" "$RE_HEX40" "a 40 hex commit"
  [ -n "$SERVED_NAME" ] || SERVED_NAME=$(printf '%s' "${HF_REPO#*/}" | tr 'A-Z' 'a-z')
  need --served-name "$SERVED_NAME" "$RE_SERVED_NAME" "a model id"
  [ -n "$VLLM_IMAGE" ] || { [ "$DRY_RUN" = 1 ] && VLLM_IMAGE='vllm/vllm-openai@sha256:<to-be-published>'; }
  [ -n "$VLLM_IMAGE" ] || die "--vllm-image name@sha256:<64 hex> is required for the gpu profile"
  matches "$RE_IMAGE" "$VLLM_IMAGE" || { [ "$DRY_RUN" = 1 ] && matches "$RE_IMAGE_PLACEHOLDER" "$VLLM_IMAGE"; } || die "--vllm-image must be pinned by digest (name@sha256:<64 hex>)"
  [ -n "$GRAFT_IMAGE" ] || GRAFT_IMAGE="$DEFAULT_GRAFT_IMAGE@sha256:<to-be-published>"
  if [ "$BUILD" = 1 ] || [ "$PULL" = 1 ]; then
    command -v docker >/dev/null 2>&1 || die "--build/--pull need docker"
    img_name=${GRAFT_IMAGE%@*}
    case $img_name in *'<org>'*) die "--build/--pull need a real image name: --graft-image <registry>/<org>/graft" ;; esac
    if [ "$DRY_RUN" = 1 ]; then
      say "would run: docker buildx build --build-arg SOURCE_DATE_EPOCH --output type=image,name=$img_name,push=false,rewrite-timestamp=true $ROOT/sidecar/"
    elif [ "$BUILD" = 1 ]; then
      say "building:  $img_name from sidecar/Dockerfile"
      SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0} docker buildx build --build-arg SOURCE_DATE_EPOCH --load -t "$img_name" "$ROOT/sidecar/"
      warn "a locally built image has no registry digest until it is pushed; push it (docker push $img_name) and pass --graft-image $img_name@sha256:<digest>, or use --pull after pushing"
    else
      say "pulling:   $img_name"
      docker pull "$img_name" >/dev/null
      digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$img_name" 2>/dev/null | sed -n 's/.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p')
      [ -n "$digest" ] || die "could not read the registry digest of $img_name"
      GRAFT_IMAGE="${img_name%%:*}@$digest"
    fi
  fi
  matches "$RE_IMAGE" "$GRAFT_IMAGE" || { [ "$DRY_RUN" = 1 ] && matches "$RE_IMAGE_PLACEHOLDER" "$GRAFT_IMAGE"; } || die "--graft-image must be pinned by digest (name@sha256:<64 hex>); build and push the sidecar image first (sidecar/README.md, Reproducible image)"
  GRAFT_IMAGE_DIGEST=${GRAFT_IMAGE##*@}
fi
case $CC_MODE in on | off) ;; *) die "--cc-mode must be on or off" ;; esac
case $MULTI_GPU in single | nvle | ppcie) ;; *) die "--multi-gpu must be single, nvle or ppcie" ;; esac
# The GPU gate: with cc_mode on the sidecar attests every GPU at boot and accepts only these hardware models.
NRAS_URL=${NRAS_URL%/}
need --nras-url "$NRAS_URL" "$RE_HTTPS_URL" "an https URL without a path"
GPU_MODELS_YAML=''
if [ "$CC_MODE" = on ]; then
  [ -n "$GPU_MODELS" ] || { [ "$DRY_RUN" = 1 ] && GPU_MODELS=GH100; }
  [ -n "$GPU_MODELS" ] || die "--gpu-models <list> is required with --cc-mode on: the hardware models the sidecar may attest, as the NVIDIA attestation service reports them in hwmodel (Hopper parts report GH100; if unsure, deploy once and read the model from the sidecar's refusal in the logs)"
  for m in $(printf '%s' "$GPU_MODELS" | tr ',' ' '); do
    need --gpu-models "$m" "$RE_GPU_MODEL" "a hardware model name such as GH100"
    GPU_MODELS_YAML="${GPU_MODELS_YAML:+$GPU_MODELS_YAML, }\"$m\""
  done
elif [ -n "$GPU_MODELS" ]; then
  warn "--gpu-models is ignored with --cc-mode off (the sidecar attests no GPU)"
fi
[ "$MULTI_GPU" != ppcie ] || warn "multi-gpu ppcie: NVLink traffic between GPUs is not encrypted; disclose it"
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"
say "profile:   $PROFILE  instance=$INSTANCE_TYPE disk=$DISK_SIZE engine=$ENGINE gpu_cc=$CC_MODE"

# ---- write the files --------------------------------------------------------------------------------------------------
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
umask 077

if [ -z "$HOST_ID" ] && [ -f "$OUT/graft.yaml" ]; then
  HOST_ID=$(sed -n 's/^host_id: *"\{0,1\}\(0x[0-9a-f]\{64\}\)"\{0,1\} *$/\1/p' "$OUT/graft.yaml" | head -n 1)
fi
[ -n "$HOST_ID" ] || HOST_ID=0x$(random_hex32)

if [ ! -s "$OUT/router-api-key" ]; then
  random_hex32 >"$OUT/router-api-key.tmp.$$"
  chmod 600 "$OUT/router-api-key.tmp.$$"
  mv -f "$OUT/router-api-key.tmp.$$" "$OUT/router-api-key"
  say "  wrote      $OUT/router-api-key (0600, not shown)"
else
  chmod 600 "$OUT/router-api-key"
  say "  kept       $OUT/router-api-key"
fi
KEY_SHA256=$(printf %s "$(cat "$OUT/router-api-key")" | sha256_stdin)

digest_comment=''
[ "$MODEL_DIGEST" != "$PLACEHOLDER_SHA" ] || digest_comment='  # <to-be-published>'
tmp="$OUT/graft.yaml.tmp.$$"
{
  say "# graft.yaml, written by deploy/graft/dstack-cloud/deploy.sh $DEPLOY_VERSION. Schema: deploy/graft/graft.schema.json (version 1)."
  say "# Re-run deploy.sh to change it; it keeps host_id and the router key."
  say "# The schema is closed (no extra keys), so the network settings live in network.json next to this file:"
  say "#   payout address $PAYOUT, router $ROUTER, anchor program $ANCHOR_PROGRAM_ID ($CLUSTER)."
  say "version: 1"
  say "host_id: \"$HOST_ID\""
  say "engine: $ENGINE"
  say "engine_url: \"$ENGINE_URL\""
  say "model:"
  say "  served_name: \"$SERVED_NAME\""
  say "  hf_repo: \"$HF_REPO\""
  say "  weights_sha256: \"$MODEL_DIGEST\"$digest_comment"
  say "  quant: \"$QUANT\""
  say "lanes: [$lanes_yaml]"
  say "pricing: { input_per_m_usdc: $PRICE_IN, output_per_m_usdc: $PRICE_OUT }"
  say "policy: \"$POLICY\""
  say "tee: tdx"
  if [ "$CC_MODE" = on ]; then
    say "gpu: { cc_mode: \"on\", multi_gpu: $MULTI_GPU, allowed_models: [$GPU_MODELS_YAML], nras_url: \"$NRAS_URL\" }"
  else
    say "gpu: { cc_mode: \"$CC_MODE\", multi_gpu: $MULTI_GPU }"
  fi
  say "kms: \"$KMS\""
  say "region: \"$REGION\""
} >"$tmp"
validator="$ROOT/deploy/graft/validate.ts"
if [ -f "$validator" ] && command -v bun >/dev/null 2>&1; then
  set +e; bun "$validator" "$tmp" >/dev/null; rc=$?; set -e
  if [ "$rc" = 3 ]; then rm -f "$tmp"; die "graft.yaml failed the schema check (see above)"
  elif [ "$rc" = 0 ]; then say "  checked    graft.yaml against graft.schema.json"
  else warn "the schema validator could not run (exit $rc)"; fi
else
  warn "bun not found: graft.yaml was not checked against graft.schema.json"
fi
install_file "$tmp" "$OUT/graft.yaml" 644

tmp="$OUT/network.json.tmp.$$"
{
  say "{"
  say "  \"cluster\": \"$CLUSTER\","
  say "  \"anchor_program_id\": \"$ANCHOR_PROGRAM_ID\","
  say "  \"router_url\": \"$ROUTER\","
  say "  \"payout_address\": \"$PAYOUT\","
  say "  \"router_key_sha256\": \"$KEY_SHA256\","
  say "  \"cvm\": { \"name\": \"$NAME\", \"profile\": \"$PROFILE\", \"instance_type\": \"$INSTANCE_TYPE\", \"disk_size\": \"$DISK_SIZE\" }"
  say "}"
} >"$tmp"
install_file "$tmp" "$OUT/network.json" 644

tmp="$OUT/docker-compose.yml.tmp.$$"
if [ "$PROFILE" = cpu ]; then
  sed -e "s|__ROUTER_KEY_SHA256__|$KEY_SHA256|g" "$TEMPLATE" >"$tmp"
  if [ "$MODEL_DIGEST" != "$PLACEHOLDER_SHA" ]; then
    sed -i.bak -e "s|sha256:<to-be-published>|$MODEL_DIGEST|g" "$tmp" && rm -f "$tmp.bak"
  fi
else
  sed -e "s|__GRAFT_IMAGE_DIGEST__|$GRAFT_IMAGE_DIGEST|g" -e "s|__GRAFT_IMAGE__|$GRAFT_IMAGE|g" -e "s|__VLLM_IMAGE__|$VLLM_IMAGE|g" \
    -e "s|__HF_REPO__|$HF_REPO|g" -e "s|__HF_REVISION__|$HF_REVISION|g" -e "s|__SERVED_NAME__|$SERVED_NAME|g" \
    -e "s|__MODEL_DIGEST__|$MODEL_DIGEST|g" -e "s|__ROUTER_KEY_SHA256__|$KEY_SHA256|g" -e "s|__GPU_COUNT__|$GPU_COUNT|g" \
    -e "s|__GPU_CC_MODE__|$CC_MODE|g" -e "s|__GPU_ALLOWED_MODELS__|$GPU_MODELS_YAML|g" -e "s|__NRAS_URL__|$NRAS_URL|g" "$TEMPLATE" >"$tmp"
fi
grep -q '__[A-Z_]*__' "$tmp" && die "unreplaced token in the rendered compose file: $(grep -o '__[A-Z_]*__' "$tmp" | head -n 1)"
install_file "$tmp" "$OUT/docker-compose.yml" 644

# sidecar.yaml: the verbatim copy the compose file carries, for reading and for `cli.ts doctor`.
tmp="$OUT/sidecar.yaml.tmp.$$"
awk '/^      SIDECAR_CONFIG_YAML: \|$/ { on = 1; next } on && /^    [^ ]/ { exit } on { sub(/^        /, ""); print }' "$OUT/docker-compose.yml" >"$tmp"
install_file "$tmp" "$OUT/sidecar.yaml" 644

tmp="$OUT/.gitignore.tmp.$$"
printf '%s\n' '# The router key never goes into a repository.' router-api-key '*.tmp.*' attest.json attestation.json cvm.json >"$tmp"
install_file "$tmp" "$OUT/.gitignore" 644

COMPOSE_SHA256=$(sha256_stdin <"$OUT/docker-compose.yml")
say "compose:   sha256 of docker-compose.yml $COMPOSE_SHA256 (the measured compose hash is sha256 of app-compose.json, which embeds it; printed after deploy)"

# ---- the cloud ----------------------------------------------------------------------------------------------------------
display_cli=${CLI:-'$DSTACK_CLOUD_CLI'}
deploy_cmd="$display_cli deploy -n $NAME -c $OUT/docker-compose.yml -t $INSTANCE_TYPE --disk-size $DISK_SIZE --wait"
[ -z "$CLOUD_REGION" ] || deploy_cmd="$deploy_cmd -r $CLOUD_REGION"
[ -z "$OS_IMAGE" ] || deploy_cmd="$deploy_cmd --image $OS_IMAGE"
[ -z "$NODE_ID" ] || deploy_cmd="$deploy_cmd --node-id $NODE_ID"
[ "$PUBLIC_LOGS" = 1 ] || deploy_cmd="$deploy_cmd --no-public-logs --no-public-sysinfo"

if [ "$DRY_RUN" = 1 ]; then
  say ""
  say "Would run, in order (nothing was run):"
  say "  $display_cli status                              # the cloud CLI is authenticated"
  say "  $display_cli cvms get $NAME --json               # exists already? then nothing is created"
  say "  $deploy_cmd"
  say "  $display_cli cvms get $NAME --json               # until status is running (up to ${WAIT_SECONDS}s)"
  say "  $display_cli cvms attestation $NAME --json       # app-compose.json, whose sha256 is the measured compose hash"
  say ""
  say "Then: sh $HERE/verify.sh --dir $OUT --name $NAME"
  say "Files in $OUT: graft.yaml, sidecar.yaml, network.json, docker-compose.yml, router-api-key (0600, not shown)."
  say "host_id:   $HOST_ID"
  exit 0
fi

case $GRAFT_IMAGE in *'<to-be-published>'*) [ "$PROFILE" = cpu ] || die "the Graft image is not pinned: pass --graft-image name@sha256:<64 hex> (or --pull)" ;; esac
case $VLLM_IMAGE in *'<to-be-published>'*) [ "$PROFILE" = cpu ] || die "the vLLM image is not pinned: pass --vllm-image name@sha256:<64 hex>" ;; esac
[ -n "$CLI" ] || die "Set DSTACK_CLOUD_CLI to the authenticated cloud CLI command."
# shellcheck disable=SC2086
$CLI status >/dev/null 2>&1 || die "the cloud CLI could not authenticate ($CLI status); check the API key"

set +e
# shellcheck disable=SC2086
$CLI cvms get "$NAME" --json >"$OUT/cvm.json" 2>/dev/null; exists=$?
set -e
if [ "$exists" = 0 ] && [ -s "$OUT/cvm.json" ]; then
  if [ "$UPDATE" = 1 ]; then
    say "updating:  $NAME exists; redeploying the rendered compose file"
    # shellcheck disable=SC2086
    $CLI deploy --cvm-id "$NAME" -c "$OUT/docker-compose.yml" --wait
  else
    say "exists:    $NAME is already on the cloud; not created again (pass --update to redeploy the compose file)"
  fi
else
  say "creating:  $deploy_cmd"
  # shellcheck disable=SC2086
  $deploy_cmd
fi

waited=0 status=''
while :; do
  # shellcheck disable=SC2086
  $CLI cvms get "$NAME" --json >"$OUT/cvm.json" 2>/dev/null || true
  status=$(json_get "$OUT/cvm.json" '.status')
  [ -n "$status" ] || status=$(grep -o '"status": *"[A-Za-z_-]*"' "$OUT/cvm.json" 2>/dev/null | head -n 1 | sed 's/.*"\([A-Za-z_-]*\)"$/\1/')
  case $status in running | Running | RUNNING) break ;; esac
  [ "$waited" -lt "$WAIT_SECONDS" ] || die "$NAME did not reach status running within ${WAIT_SECONDS}s (last: ${status:-unknown}); $CLI logs sidecar --cvm-id $NAME --stderr"
  sleep 15; waited=$((waited + 15))
done
say "running:   $NAME"

APP_ID=$(json_get "$OUT/cvm.json" '.app_id')
APP_URL=$(json_get "$OUT/cvm.json" '.app_url')
GATEWAY=''
if [ -n "$APP_URL" ]; then
  host=${APP_URL#*://}; host=${host%%/*}; host=${host%%:*}
  GATEWAY=${host#*.}
fi
if [ -n "$APP_ID" ] && [ -n "$GATEWAY" ]; then
  ENDPOINT="https://$APP_ID-8443s.$GATEWAY"
else
  ENDPOINT="https://<app_id>-8443s.<gateway domain>"
  warn "could not derive the endpoint from $OUT/cvm.json (app_id/app_url); read it from the dashboard: the TLS-passthrough name for port 8443 (note the s)"
fi

# shellcheck disable=SC2086
if $CLI cvms attestation "$NAME" --json >"$OUT/attestation.json" 2>/dev/null && [ -s "$OUT/attestation.json" ]; then
  app_compose=''
  if command -v jq >/dev/null 2>&1; then
    app_compose=$(jq -r '
      def tcb: (.tcb_info // null) | if type == "string" then (try fromjson catch null) else . end;
      ((tcb | if type == "object" then .app_compose else null end) // .app_compose // .compose_file // empty)
      | if type == "string" then . else tojson end' "$OUT/attestation.json" 2>/dev/null || true)
  elif command -v bun >/dev/null 2>&1; then
    app_compose=$(ATT="$OUT/attestation.json" bun -e '
      const d = JSON.parse(await Bun.file(process.env.ATT).text());
      let t = d.tcb_info; if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = null; } }
      const w = t?.app_compose ?? d.app_compose ?? d.compose_file;
      if (w !== undefined && w !== null) process.stdout.write(typeof w === "string" ? w : JSON.stringify(w));' 2>/dev/null || true)
  fi
  if [ -n "$app_compose" ]; then
    COMPOSE_HASH=$(printf '%s' "$app_compose" | sha256_stdin)
    say "measured:  compose hash sha256:$COMPOSE_HASH (sha256 of app-compose.json; saved $OUT/attestation.json)"
  else
    warn "could not find app_compose in $OUT/attestation.json; verify.sh --app-compose <file> accepts the document the dashboard offers"
  fi
else
  warn "$CLI cvms attestation $NAME --json returned nothing (the command is marked unstable upstream); verify.sh can read the app-compose document from a file"
fi

say ""
say "Done. Files in $OUT: graft.yaml, sidecar.yaml, network.json, docker-compose.yml, router-api-key (0600, not shown)."
say "host_id:      $HOST_ID"
say "endpoint:     $ENDPOINT"
say "attestation:  $ENDPOINT/attest   (a current sidecar serves the same document at /.well-known/trellis-attestation)"
say "verify:       sh $HERE/verify.sh --dir $OUT --name $NAME --endpoint $ENDPOINT"
say "logs:         $CLI logs sidecar --cvm-id $NAME --stderr -n 200"
say "join:         deploy/network/approved/tdx-qwen2.5-0.5b/README.md, step 5 (payout $PAYOUT, anchor $ANCHOR_PROGRAM_ID on $CLUSTER)"
