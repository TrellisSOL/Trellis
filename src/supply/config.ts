import { z } from "zod";

// Supply adapters (docs/Trellis_Backend.md §2): Trellis-operated capacity rented on the Nosana GPU market and on io.net,
// kept warm to match demand. Everything is off by default. Credentials come from the environment only and are never
// logged, returned by a route or written to the database.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const opt = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

export const supplyEnv = {
  SUPPLY_NOSANA_ENABLED: bool.default(false),
  SUPPLY_IONET_ENABLED: bool.default(false),
  /** Most the warm pool may cost per hour across both adapters, in USD. 0 keeps every pool at zero replicas. */
  SUPPLY_HOURLY_BUDGET_USD: z.coerce.number().min(0).max(100_000).default(0),
  /** JSON list of the pinned open-weight models the pool may deploy (see supplyModelSchema). */
  SUPPLY_MODELS: opt,
  SUPPLY_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000),
  /** Replicas are sized for demand times this factor. */
  SUPPLY_HEADROOM: z.coerce.number().min(1).max(5).default(1.2),
  /** A deployment younger than this is never torn down, so a quiet five minutes does not throw away a warm model. */
  SUPPLY_SCALE_DOWN_AFTER_MIN: z.coerce.number().int().min(0).max(1_440).default(30),
  /** The registry status a newly registered supply endpoint starts with: shadow (canaries first, the default) or live. */
  SUPPLY_PROVIDER_STATUS: z.enum(["shadow", "live"]).default("shadow"),
  NOSANA_API_URL: z.string().default("https://dashboard.k8s.prd.nos.ci/api"),
  NOSANA_API_KEY: opt,
  NOSANA_MARKET: opt, // address of the GPU market the jobs are posted to
  NOSANA_TIMEOUT_MIN: z.coerce.number().int().min(10).max(10_080).default(120),
  NOSANA_STRATEGY: z.string().regex(/^[A-Z-]{3,32}$/).default("SIMPLE"),
  IONET_API_URL: z.string().default("https://api.io.solutions/enterprise/v1/io-cloud/caas"),
  IONET_API_KEY: opt,
  IONET_HARDWARE_ID: z.coerce.number().int().positive().optional(),
  IONET_LOCATION_IDS: opt, // comma list of io.net location ids
  IONET_GPUS_PER_CONTAINER: z.coerce.number().int().min(1).max(8).default(1),
  IONET_DURATION_HOURS: z.coerce.number().int().min(1).max(720).default(1),
  /** io.net clusters are rented for high-volume models only: output-equivalent tokens in the last hour at or above this. */
  IONET_MIN_TOKENS_PER_HOUR: z.coerce.number().int().min(0).default(5_000_000),
};

const HEX64 = /^[0-9a-f]{64}$/;
const usdPerMtok = z.number().min(0).max(10_000);

/** One pinned model the pool may deploy. Nothing floats: the image is named by digest and the weights by commit and sha256. */
export const supplyModelSchema = z.strictObject({
  /** Catalogue id (author/slug) the endpoint is listed under. */
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/, "must be a lower-case author/slug"),
  hf_repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a Hugging Face owner/repo"),
  /** The commit of hf_repo the weights are loaded from. */
  revision: z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character commit id, not a branch or tag"),
  /** sha256 of the weights manifest at that commit: the model digest receipts and the catalogue record. */
  weights_sha256: z.string().regex(HEX64, "must be 64 lower-case hex characters"),
  /** The vLLM image, pinned by digest. */
  image: z.string().regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/, "must be pinned by digest (name@sha256:...)"),
  context_length: z.number().int().positive().max(4_000_000),
  max_output_tokens: z.number().int().positive().optional(),
  quantization: z.string().regex(/^[a-z0-9]{2,12}$/).default("bf16"),
  price_prompt_usd_per_mtok: usdPerMtok,
  price_completion_usd_per_mtok: usdPerMtok,
  /** Output-equivalent tokens one replica serves in an hour; the pool divides demand by it. */
  tokens_per_replica_hour: z.number().int().positive(),
  min_replicas: z.number().int().min(0).max(64).default(0),
  max_replicas: z.number().int().min(1).max(64).default(2),
  adapters: z.array(z.enum(["nosana", "ionet"])).min(1).default(["nosana"]),
  /** Further vLLM arguments (flags only; the model, revision, served name and port are set by the adapter). */
  extra_args: z.array(z.string().max(120)).max(24).default([]),
  /** Set only for an io.net cluster that is a confidential VM running the Graft container: where its attestation is served. */
  ionet_attestation_url: z.string().url().startsWith("https://").optional(),
  ionet_tee_kind: z.enum(["tdx", "snp", "nvidia-cc"]).optional(),
});
export type SupplyModelInput = z.infer<typeof supplyModelSchema>;

export type SupplyModel = {
  modelId: string;
  hfRepo: string;
  revision: string;
  weightsSha256: string;
  image: string;
  contextLength: number;
  maxOutputTokens: number | null;
  quantization: string;
  pricePromptUsdPerMtok: number;
  priceCompletionUsdPerMtok: number;
  tokensPerReplicaHour: number;
  minReplicas: number;
  maxReplicas: number;
  adapters: ("nosana" | "ionet")[];
  extraArgs: string[];
  ionetAttestation: { url: string; teeKind: string } | null;
};

export function toSupplyModel(m: SupplyModelInput): SupplyModel {
  if (m.min_replicas > m.max_replicas) throw new Error(`SUPPLY_MODELS ${m.model}: min_replicas is above max_replicas.`);
  if (m.extra_args.some((a) => /^--(model|revision|served-model-name|port|host|api-key)\b/.test(a))) throw new Error(`SUPPLY_MODELS ${m.model}: extra_args may not set the model, revision, served name, port, host or key.`);
  if (!!m.ionet_attestation_url !== !!m.ionet_tee_kind) throw new Error(`SUPPLY_MODELS ${m.model}: ionet_attestation_url and ionet_tee_kind go together.`);
  return {
    modelId: m.model,
    hfRepo: m.hf_repo,
    revision: m.revision,
    weightsSha256: m.weights_sha256,
    image: m.image,
    contextLength: m.context_length,
    maxOutputTokens: m.max_output_tokens ?? null,
    quantization: m.quantization,
    pricePromptUsdPerMtok: m.price_prompt_usd_per_mtok,
    priceCompletionUsdPerMtok: m.price_completion_usd_per_mtok,
    tokensPerReplicaHour: m.tokens_per_replica_hour,
    minReplicas: m.min_replicas,
    maxReplicas: m.max_replicas,
    adapters: [...new Set(m.adapters)],
    extraArgs: m.extra_args,
    ionetAttestation: m.ionet_attestation_url && m.ionet_tee_kind ? { url: m.ionet_attestation_url, teeKind: m.ionet_tee_kind } : null,
  };
}

const supplyEnvShape = z.object(supplyEnv);
type SupplyEnv = z.infer<typeof supplyEnvShape>;

function apiUrl(name: string, value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be an https URL without credentials, a query or a fragment.`);
  return url.href.replace(/\/$/, "");
}

export function supplySettings(e: SupplyEnv) {
  let models: SupplyModel[] = [];
  if (e.SUPPLY_MODELS) {
    let raw: unknown;
    try { raw = JSON.parse(e.SUPPLY_MODELS); } catch { throw new Error("SUPPLY_MODELS must be JSON."); }
    const parsed = z.array(supplyModelSchema).max(64).safeParse(raw);
    if (!parsed.success) throw new Error(`SUPPLY_MODELS: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    models = parsed.data.map(toSupplyModel);
    if (new Set(models.map((m) => m.modelId)).size !== models.length) throw new Error("SUPPLY_MODELS lists a model twice.");
  }
  if (e.SUPPLY_NOSANA_ENABLED && (!e.NOSANA_API_KEY || !e.NOSANA_MARKET)) throw new Error("SUPPLY_NOSANA_ENABLED needs NOSANA_API_KEY and NOSANA_MARKET.");
  if (e.SUPPLY_IONET_ENABLED && (!e.IONET_API_KEY || !e.IONET_HARDWARE_ID || !e.IONET_LOCATION_IDS)) throw new Error("SUPPLY_IONET_ENABLED needs IONET_API_KEY, IONET_HARDWARE_ID and IONET_LOCATION_IDS.");
  const locationIds = (e.IONET_LOCATION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (locationIds.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error("IONET_LOCATION_IDS must be a comma list of positive integers.");
  return {
    budgetUsdPerHour: e.SUPPLY_HOURLY_BUDGET_USD,
    models,
    intervalMs: e.SUPPLY_INTERVAL_MS,
    headroom: e.SUPPLY_HEADROOM,
    scaleDownAfterMs: e.SUPPLY_SCALE_DOWN_AFTER_MIN * 60_000,
    providerStatus: e.SUPPLY_PROVIDER_STATUS,
    nosana: {
      enabled: e.SUPPLY_NOSANA_ENABLED,
      apiUrl: apiUrl("NOSANA_API_URL", e.NOSANA_API_URL),
      apiKey: e.NOSANA_API_KEY,
      market: e.NOSANA_MARKET,
      timeoutMin: e.NOSANA_TIMEOUT_MIN,
      strategy: e.NOSANA_STRATEGY,
    },
    ionet: {
      enabled: e.SUPPLY_IONET_ENABLED,
      apiUrl: apiUrl("IONET_API_URL", e.IONET_API_URL),
      apiKey: e.IONET_API_KEY,
      hardwareId: e.IONET_HARDWARE_ID ?? null,
      locationIds,
      gpusPerContainer: e.IONET_GPUS_PER_CONTAINER,
      durationHours: e.IONET_DURATION_HOURS,
      minTokensPerHour: e.IONET_MIN_TOKENS_PER_HOUR,
    },
  };
}
export type SupplySettings = ReturnType<typeof supplySettings>;
