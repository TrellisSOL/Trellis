import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isSolanaPublicKey, SOLANA_PUBLIC_KEY_MESSAGE } from "../util.ts";
import { basename, join, resolve } from "node:path";
import { Flags, UsageError } from "./args.ts";
import { askValid, askYesNo, type Io } from "./io.ts";
import { BUN_IMAGE, DEFAULT_SIDECAR_COMMIT, DEFAULT_SIDECAR_REPO, DEFAULT_SIDECAR_TARBALL_SHA256, LLAMACPP_IMAGE } from "./pins.ts";

// Everything the wizard needs to know, gathered from flags first, then (in a terminal) from questions, then defaults.
// Every value is validated here, before anything is written, because several end up inside a compose file that is
// measured into the attestation.

export const TARGETS = ["dstack-cpu", "dstack-gpu", "tdx-host"] as const;
export type Target = (typeof TARGETS)[number];
export type Server = "vllm" | "llamacpp";

export type GpuCc = { ccMode: "on" | "off"; allowedModels: string[]; nrasUrl?: string };

export type DataPolicy = { training: boolean; retains_prompts: boolean; retention_days?: number; zdr?: boolean };

export type InitSpec = {
  target: Target;
  server: Server;
  /** Reserve NVIDIA GPUs for the model server. */
  gpu: boolean;
  /**
   * sidecar.yaml's `gpu` block, present whenever the deployment has GPUs. With ccMode "on" the sidecar attests every GPU
   * through the NVIDIA Remote Attestation Service before it starts; "off" declares that only the CPU side is attested.
   */
  gpuCc?: GpuCc;
  /** The sidecar image, pinned by digest, that replaces the Bun image and source tarball. Required with ccMode "on". */
  sidecarImage?: string;
  outDir: string;
  providerId: string;
  providerName: string;
  servedName: string;
  /** Absolute path of the weights (a directory, or a single file). */
  weightsPath: string;
  weightsIsFile: boolean;
  /** Where the weights are on the TDX host, when that is not the path they have here. */
  hostWeightsPath?: string;
  exclude: string[];
  /** Where a dstack VM downloads the weights from: a Hugging Face repository at an exact commit. */
  hf?: { repo: string; revision: string };
  modelImage: string;
  /** Names or addresses for the TLS certificate, in addition to the gateway name on dstack. */
  hostnames: string[];
  sidecar: { repo: string; commit: string; sha256?: string; fetchHash: boolean };
  quota: { requestsPerMinute: number; tokensPerMinute: number };
  royaltyRecipient?: string;
  contact?: string;
  datacenters: string[];
  payoutAddress?: string;
  dataPolicy: DataPolicy;
  contextSize: number;
  maxTokens?: number;
  maxModelLen?: number;
  /** The endpoint's public https origin, when it is already known (a dstack cloud only assigns it at deploy). */
  url?: string;
  force: boolean;
};

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SERVED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_PINNED = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const GPU_MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export const check = {
  providerId: (v: string) => (PROVIDER_ID.test(v) ? null : "use 2 to 41 characters: lowercase letters, digits and -, starting with a letter or digit"),
  servedName: (v: string) => (SERVED_NAME.test(v) ? null : "use letters, digits and . _ : / - (at most 128 characters)"),
  hfRepo: (v: string) => (HF_REPO.test(v) ? null : "expected owner/name, for example Qwen/Qwen2.5-0.5B-Instruct-GGUF"),
  hfRevision: (v: string) => (GIT_SHA.test(v) ? null : "expected a full 40-character commit hash (a branch or tag can move, so it cannot be pinned)"),
  image: (v: string) => (IMAGE_PINNED.test(v) ? null : "expected an image pinned by digest: <name>[:tag]@sha256:<64 hex>"),
  hostname: (v: string) => (HOSTNAME.test(v) || /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? null : "expected a DNS name or an IPv4 address"),
  address: (v: string) => (isSolanaPublicKey(v) ? null : SOLANA_PUBLIC_KEY_MESSAGE),
  githubRepo: (v: string) => (GITHUB_REPO.test(v) ? null : "expected owner/name"),
  commit: (v: string) => (GIT_SHA.test(v) ? null : "expected a full 40-character commit hash"),
  sha256: (v: string) => (SHA256.test(v) ? null : "expected 64 hex characters"),
  gpuModel: (v: string) => (GPU_MODEL.test(v) ? null : 'expected a GPU hardware model as the NVIDIA attestation service names it in hwmodel, for example "GH100"'),
};

/**
 * The `gpu` block an earlier `init` wrote in this directory, so that running `init --force` again without the GPU flags
 * keeps it rather than dropping it. Read from the manifest; anything unreadable counts as absent.
 */
function previousGpu(outDir: string): { gpu?: GpuCc; sidecarImage?: string } {
  const path = join(outDir, "trellis-provider.json");
  if (!existsSync(path)) return {};
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as { gpu?: { cc_mode?: unknown; allowed_models?: unknown; nras_url?: unknown }; sidecar?: { image?: unknown } };
    const g = m.gpu;
    const gpu =
      g && (g.cc_mode === "on" || g.cc_mode === "off") && Array.isArray(g.allowed_models) && g.allowed_models.every((x) => typeof x === "string" && GPU_MODEL.test(x))
        ? { ccMode: g.cc_mode as "on" | "off", allowedModels: g.allowed_models as string[], ...(typeof g.nras_url === "string" ? { nrasUrl: g.nras_url } : {}) }
        : undefined;
    return { gpu, sidecarImage: typeof m.sidecar?.image === "string" && IMAGE_PINNED.test(m.sidecar.image) ? m.sidecar.image : undefined };
  } catch {
    return {};
  }
}

/** sidecar.yaml's gpu block, from the flags, else from what an earlier init recorded, else cc_mode "off". */
function resolveGpu(flags: Flags, hasGpu: boolean, outDir: string, force: boolean): { gpuCc?: GpuCc; sidecarImage?: string } {
  const kept = force ? previousGpu(outDir) : {};
  const ccMode = pick(flags, "cc-mode", ["on", "off"] as const) ?? kept.gpu?.ccMode ?? "off";
  const models = flags.has("gpu-models") ? flags.list("gpu-models").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean) : (kept.gpu?.allowedModels ?? []);
  for (const m of models) must(check.gpuModel(m), "gpu-models");
  const nrasUrl = flags.str("nras-url") !== undefined ? normalizeOrigin(flags.str("nras-url")!, "--nras-url") : kept.gpu?.nrasUrl;
  if (nrasUrl && !nrasUrl.startsWith("https://")) throw new UsageError("--nras-url must be https");
  const given = flags.str("sidecar-image");
  if (given !== undefined) must(check.image(given), "sidecar-image");
  const sidecarImage = given ?? (ccMode === "on" ? kept.sidecarImage : undefined);
  if (!hasGpu) {
    if (ccMode === "on" || flags.has("gpu-models") || flags.has("nras-url")) throw new UsageError("--cc-mode, --gpu-models and --nras-url need a deployment with GPUs: --target dstack-gpu, or tdx-host with --server vllm --gpu");
    return { sidecarImage };
  }
  if (ccMode === "on") {
    if (models.length === 0) throw new UsageError('--cc-mode on needs --gpu-models <list>: the GPU hardware models the sidecar may attest, as the NVIDIA attestation service reports them in hwmodel (Hopper parts report "GH100")');
    if (!sidecarImage) throw new UsageError("--cc-mode on needs --sidecar-image <name@sha256:...>: a sidecar image that contains NVIDIA's nvattest (build sidecar/Dockerfile with --target gpu and pin its digest). The default deployment runs the sidecar source in a plain Bun image, which cannot collect GPU evidence.");
  }
  return { gpuCc: { ccMode, allowedModels: [...new Set(models)], ...(nrasUrl ? { nrasUrl } : {}) }, sidecarImage };
}


function must(problem: string | null, flag: string): void {
  if (problem) throw new UsageError(`--${flag}: ${problem}`);
}

/** An https origin (loopback may be plain http, for a router on this machine). Path, query and credentials are dropped. */
export function normalizeOrigin(value: string, what: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`${what} is not a URL: ${value}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new UsageError(`${what} must be https (plain http only for localhost)`);
  if (u.username || u.password) throw new UsageError(`${what} must not contain credentials`);
  return u.origin;
}

/** The sidecar's origin from whatever the operator pasted: https://host, https://host/v1, https://host/attest. */
export function endpointOrigin(value: string): string {
  return normalizeOrigin(value, "the endpoint URL");
}

function pick<T extends string>(flags: Flags, name: string, allowed: readonly T[]): T | undefined {
  const v = flags.str(name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);

export async function resolveInit(flags: Flags, io: Io): Promise<InitSpec> {
  const ask = io.interactive;
  const need = async (flag: string, question: string, verify: (v: string) => string | null, def?: string): Promise<string> => {
    const given = flags.str(flag);
    if (given !== undefined) {
      must(verify(given), flag);
      return given;
    }
    if (ask) return askValid(io, question, verify, def);
    if (def !== undefined) return def;
    throw new UsageError(`--${flag} is required (or run in a terminal to be asked)`);
  };

  let target = pick(flags, "target", TARGETS);
  if (!target) {
    if (!ask) throw new UsageError(`--target is required: one of ${TARGETS.join(", ")}`);
    io.err("Where will the model run?\n  dstack-cpu  a dstack cloud confidential VM, CPU only (llama.cpp)\n  dstack-gpu  a dstack cloud confidential VM with NVIDIA GPUs (vLLM)\n  tdx-host   your own Intel TDX host or VM (vLLM or llama.cpp)");
    target = (await askValid(io, "target", (v) => ((TARGETS as readonly string[]).includes(v) ? null : `one of ${TARGETS.join(", ")}`), "dstack-cpu")) as Target;
  }

  const weightsInput = await need("weights", "path to the model weights (a directory, or one GGUF file)", (v) => (v.trim() ? null : "a path is required"));
  const weightsPath = resolve(weightsInput);
  let weightsIsFile: boolean;
  try {
    weightsIsFile = (await stat(weightsPath)).isFile();
  } catch (e) {
    throw new UsageError(`--weights ${weightsPath} cannot be read: ${(e as Error).message}`);
  }

  const hostWeightsPath = flags.str("host-weights-path");
  if (hostWeightsPath !== undefined) {
    if (target !== "tdx-host") throw new UsageError("--host-weights-path is for tdx-host: a dstack VM downloads its weights");
    if (!hostWeightsPath.startsWith("/") || /[\r\n]/.test(hostWeightsPath)) throw new UsageError("--host-weights-path must be an absolute path on the TDX host");
  }

  const server = pick(flags, "server", ["vllm", "llamacpp"] as const) ?? (target === "dstack-cpu" || (target === "tdx-host" && weightsIsFile) ? "llamacpp" : "vllm");
  if (target === "dstack-cpu" && server !== "llamacpp") throw new UsageError("dstack-cpu runs llama.cpp; use dstack-gpu or tdx-host for vLLM");
  if (target === "dstack-gpu" && server !== "vllm") throw new UsageError("dstack-gpu runs vLLM; llama.cpp here is the CPU build");
  if (server === "llamacpp" && !weightsIsFile) throw new UsageError("llama.cpp serves one GGUF file: point --weights at the file (use vLLM for a directory of safetensors)");
  if (server === "vllm" && weightsIsFile) throw new UsageError("vLLM serves a directory of weights: point --weights at the directory (use llama.cpp for one GGUF file)");

  const servedDefault = basename(weightsPath).replace(/\.gguf$/i, "").replace(/[^A-Za-z0-9._:/-]+/g, "-");
  const servedName = await need("served-name", "model name the endpoint serves", check.servedName, servedDefault || "model");
  const providerId = await need("id", "provider id (the short name the router lists you under)", check.providerId, slug(servedName) || undefined);
  const providerName = flags.str("name") ?? (ask ? await askValid(io, "display name", (v) => (v.length >= 1 && v.length <= 80 ? null : "1 to 80 characters"), providerId) : providerId);
  if (providerName.length < 1 || providerName.length > 80) throw new UsageError("--name must be 1 to 80 characters");

  let hf: InitSpec["hf"];
  if (target !== "tdx-host") {
    const repo = await need("hf-repo", "Hugging Face repository the VM downloads the weights from (owner/name)", check.hfRepo);
    const revision = await need("hf-revision", "the repository commit those weights are from (40 hex)", check.hfRevision);
    hf = { repo, revision };
  }

  let modelImage = flags.str("model-image");
  if (modelImage !== undefined) must(check.image(modelImage), "model-image");
  else if (server === "llamacpp") modelImage = LLAMACPP_IMAGE;
  else modelImage = await need("model-image", "vLLM image, pinned by digest (name@sha256:…)", check.image);

  const hostnames = flags.list("hostname");
  for (const h of hostnames) must(check.hostname(h), "hostname");
  if (target === "tdx-host" && hostnames.length === 0) hostnames.push(await need("hostname", "DNS name or address clients reach this host at (goes in the TLS certificate)", check.hostname));

  const commit = flags.str("sidecar-commit") ?? DEFAULT_SIDECAR_COMMIT;
  must(check.commit(commit), "sidecar-commit");
  const repo = flags.str("sidecar-repo") ?? DEFAULT_SIDECAR_REPO;
  must(check.githubRepo(repo), "sidecar-repo");
  let sha256 = flags.str("sidecar-sha256");
  if (sha256 !== undefined) must(check.sha256(sha256), "sidecar-sha256");
  const fetchHash = flags.bool("fetch-source-hash");
  if (sha256 === undefined && !fetchHash) {
    if (commit === DEFAULT_SIDECAR_COMMIT && repo === DEFAULT_SIDECAR_REPO) sha256 = DEFAULT_SIDECAR_TARBALL_SHA256;
    else throw new UsageError("a sidecar commit other than the default needs --sidecar-sha256 <hash of its tarball>, or --fetch-source-hash to compute it now");
  }

  const rpm = flags.int("requests-per-minute", 1, 100_000) ?? 120;
  const tpm = flags.int("tokens-per-minute", 1000, 1_000_000_000) ?? 120_000;

  const royaltyRecipient = flags.str("royalty-recipient");
  if (royaltyRecipient) must(check.address(royaltyRecipient), "royalty-recipient");
  const payoutAddress = flags.str("payout-address");
  if (payoutAddress) must(check.address(payoutAddress), "payout-address");
  const contact = flags.str("contact") ?? (ask ? (await io.ask("contact for the router operator (email or handle, optional)")) || undefined : undefined);
  if (contact && contact.length > 200) throw new UsageError("--contact is at most 200 characters");
  const datacenters = flags.list("datacenter");
  if (datacenters.length > 20 || datacenters.some((d) => d.length < 1 || d.length > 40)) throw new UsageError("--datacenter: up to 20 values of 1 to 40 characters");

  // The data policy is the operator's own declaration to the router. The defaults declare nothing the operator has not chosen:
  // they say prompts are not used for training and not kept, so an operator who keeps them must say so.
  const retains = flags.has("retains-prompts") ? flags.bool("retains-prompts") : ask ? await askYesNo(io, "Does your deployment keep prompts or responses (logs, caches, disks)?", false) : false;
  const training = flags.bool("training");
  const retentionDays = flags.int("retention-days", 0, 3650);
  if (!retains && retentionDays) throw new UsageError("--retention-days only applies together with --retains-prompts");
  const dataPolicy: DataPolicy = { training, retains_prompts: retains, ...(retains ? { retention_days: retentionDays ?? 30 } : { retention_days: 0 }), ...(flags.bool("zdr") ? { zdr: true } : {}) };
  if (dataPolicy.zdr && (retains || training)) throw new UsageError("--zdr (zero data retention) cannot be declared together with --retains-prompts or --training");

  const url = flags.str("url") ? endpointOrigin(flags.str("url")!) : undefined;

  const contextSize = flags.int("context-size", 256, 10_000_000) ?? 4096;
  const maxTokens = flags.int("max-tokens", 1, 10_000_000);
  const maxModelLen = flags.int("max-model-len", 256, 10_000_000);
  if (server === "vllm" && flags.has("context-size")) throw new UsageError("--context-size is for llama.cpp; use --max-model-len for vLLM");
  if (server === "llamacpp" && (flags.has("max-model-len"))) throw new UsageError("--max-model-len is for vLLM; use --context-size for llama.cpp");

  const gpu = target === "dstack-gpu" || (server === "vllm" && flags.bool("gpu"));
  const outDir = resolve(flags.str("out") ?? "trellis-provider");
  return {
    target,
    server,
    gpu,
    ...resolveGpu(flags, gpu, outDir, flags.bool("force")),
    outDir,
    providerId,
    providerName,
    servedName,
    weightsPath,
    weightsIsFile,
    hostWeightsPath,
    exclude: flags.list("exclude"),
    hf,
    modelImage: modelImage!,
    hostnames,
    sidecar: { repo, commit, sha256, fetchHash },
    quota: { requestsPerMinute: rpm, tokensPerMinute: tpm },
    royaltyRecipient,
    contact,
    datacenters,
    payoutAddress,
    dataPolicy,
    contextSize,
    maxTokens,
    maxModelLen,
    url,
    force: flags.bool("force"),
  };
}

export const RUNTIME_IMAGE = BUN_IMAGE;
