import { createHmac } from "node:crypto";
import { sha256 } from "../lib/util.ts";
import type { SupplyModel } from "./config.ts";

// The contract every supply adapter implements (docs/Trellis_Backend.md §2). An adapter turns "keep N replicas of this
// pinned model warm" into calls to one GPU network, and reports what that costs. It never registers anything with the
// router: the warm pool (warm-pool.ts) decides the targets and registers the endpoints through the provider registry.

export type AdapterName = "nosana" | "ionet";

/** What the endpoint may claim. `open`: no attestation claim. `attestable`: an attestation URL was configured for the
 *  cluster; the provider is still OPEN until the attestor has verified a Graft attestation from it. */
export type SupplyLane = "open" | "attestable";

export type CapacityOffer = {
  adapter: AdapterName;
  /** The adapter's own name for the hardware: a Nosana market address, an io.net hardware id. */
  sku: string;
  label: string;
  usdPerReplicaHour: number | null;
  /** Replicas that could be started now; null when the network does not say. */
  available: number | null;
};

export type DeploymentStatus = "starting" | "running" | "stopped" | "failed";

export type SupplyDeployment = {
  adapter: AdapterName;
  /** The network's id for the deployment. */
  externalId: string;
  modelId: string;
  /** sha256 of the weights the deployment was started with. */
  weightsSha256: string;
  replicas: number;
  status: DeploymentStatus;
  /** OpenAI-compatible base URLs (ending in /v1) that answer for the model; empty until the network exposes them. */
  endpoints: string[];
  lane: SupplyLane;
  attestation: { url: string; teeKind: string } | null;
};

export type PriceQuote = {
  adapter: AdapterName;
  replicas: number;
  hours: number;
  usdPerReplicaHour: number;
  totalUsd: number;
  /** What the network is paid in, and the amount in that unit when the adapter can tell. */
  settlement: { unit: "NOS" | "USDC" | "credits"; amount: number | null };
};

export type SupplyHealth = { ok: boolean; endpoints: { url: string; ok: boolean; status: number | null }[] };

export interface SupplyAdapter {
  readonly name: AdapterName;
  /** Hardware that could host a model now, with its hourly price. */
  listCapacity(): Promise<CapacityOffer[]>;
  /** Make sure `replicas` copies of the pinned model are deployed (creating, resizing or restarting as needed). */
  ensureWarm(spec: SupplyModel, replicas: number, existing?: { externalId: string } | null): Promise<SupplyDeployment>;
  /** Stop paying for a deployment. */
  tearDown(externalId: string): Promise<void>;
  quote(spec: SupplyModel, replicas: number, hours: number): Promise<PriceQuote>;
  /** Whether each endpoint of a deployment answers for the model. */
  health(spec: SupplyModel, deployment: Pick<SupplyDeployment, "endpoints">): Promise<SupplyHealth>;
}

/** The name vLLM serves the model under: the catalogue id's slug, which is also the provider-side model id. */
export const servedModelName = (spec: Pick<SupplyModel, "modelId">) => spec.modelId.split("/").slice(1).join("/");

/** A stable, short deployment name: the same model at the same weights always maps to the same deployment. */
export const deploymentName = (spec: Pick<SupplyModel, "modelId" | "weightsSha256">) => `trellis-${sha256(`${spec.modelId}\n${spec.weightsSha256}`).slice(0, 16)}`;

/**
 * The bearer key a deployment's vLLM server requires, so a public endpoint on a GPU network serves the router only.
 * Derived from APP_SECRET and the pinned model, so it needs no storage and survives a restart of either side.
 */
export const endpointKey = (appSecret: string, adapter: AdapterName, spec: Pick<SupplyModel, "modelId" | "weightsSha256">) =>
  `sk-supply-${createHmac("sha256", appSecret).update(`supply-endpoint/1\n${adapter}\n${spec.modelId}\n${spec.weightsSha256}`).digest("hex").slice(0, 48)}`;

/** The vLLM arguments of a pinned model: weights by repository and commit, one served name, fixed port. */
export function vllmArgs(spec: SupplyModel, port: number): string[] {
  return [
    "--model", spec.hfRepo,
    "--revision", spec.revision,
    "--served-model-name", servedModelName(spec),
    "--max-model-len", String(spec.contextLength),
    "--host", "0.0.0.0",
    "--port", String(port),
    ...spec.extraArgs,
  ];
}

export const VLLM_PORT = 8000;

/** GET <endpoint>/models with the endpoint key: the endpoint is healthy when it lists the served model. */
export async function probeEndpoints(fetchFn: typeof fetch, spec: SupplyModel, endpoints: string[], key: string): Promise<SupplyHealth> {
  const served = servedModelName(spec);
  const out: SupplyHealth["endpoints"] = [];
  for (const url of endpoints) {
    try {
      const res = await fetchFn(`${url.replace(/\/$/, "")}/models`, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      let ok = false;
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
        ok = Array.isArray(json?.data) && json.data.some((m) => m?.id === served);
      } else await res.body?.cancel().catch(() => undefined);
      out.push({ url, ok, status: res.status });
    } catch {
      out.push({ url, ok: false, status: null });
    }
  }
  return { ok: out.length > 0 && out.every((e) => e.ok), endpoints: out };
}

/** An https base URL ending in /v1, or null when the network handed back something else. */
export function openAiBase(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let u: URL;
  try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}
