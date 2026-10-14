import type { SupplyModel, SupplySettings } from "./config.ts";
import { VLLM_PORT, deploymentName, endpointKey, openAiBase, probeEndpoints, vllmArgs, type CapacityOffer, type DeploymentStatus, type PriceQuote, type SupplyAdapter, type SupplyDeployment, type SupplyHealth } from "./types.ts";

// ionet-adapter (docs/Trellis_Backend.md §2): io.net container clusters (IO Cloud "CaaS") rented for high-volume models.
// OPEN lane, unless the operator configured the cluster as a confidential VM that serves a Graft attestation: then the
// adapter passes the attestation URL along and the attestor decides. The adapter itself never marks anything attested.
//
// What is taken from io.net's documentation (io.net/docs, read 2026-10), base https://api.io.solutions/enterprise/v1/io-cloud/caas,
// header `x-api-key`:
//   - GET  /available-replicas?hardware_id&hardware_qty            -> [{id, iso2, name, available_replicas}]
//   - GET  /price?location_ids&hardware_id&duration_hours&gpus_per_container&replica_count
//   - POST /deploy {resource_private_name, duration_hours, gpus_per_container, hardware_id, location_ids,
//                   container_config{replica_count, traffic_port, entrypoint, args, env_variables, secret_env_variables},
//                   registry_config{image_url, registry_username, registry_secret}}      -> {status, deployment_id}
//   - GET  /deployment/<id>            -> data{id, status, total_containers, compute_minutes_remaining, ...}
//   - GET  /deployment/<id>/containers -> data{total, workers[{container_id, status, public_url, ...}]}
//   - DELETE /deployment/<id>          -> {status, deployment_id}
//   - only HTTP server containers with a single traffic port are supported.
// io.net's confidential compute (Intel TDX / AMD SEV-SNP with NVIDIA confidential computing) is provisioned on request
// through its managed services; the pages show no API field that asks for it. So the adapter cannot request a
// confidential VM: the operator records the cluster's attestation URL in SUPPLY_MODELS when one exists.
// What could not be confirmed (the body of the price response, the status names, the routes for extending and resizing)
// is isolated in the `assumed*` functions below.

export type IonetLocation = { id: number; name: string; availableReplicas: number };
export type IonetDeploy = {
  resource_private_name: string;
  duration_hours: number;
  gpus_per_container: number;
  hardware_id: number;
  location_ids: number[];
  container_config: { replica_count: number; traffic_port: number; entrypoint: string[]; args: string[]; env_variables: Record<string, string>; secret_env_variables: Record<string, string> };
  registry_config: { image_url: string; registry_username: string; registry_secret: string };
};
export type IonetDeployment = { id: string; status: string; replicas: number; minutesRemaining: number | null };
export type IonetContainer = { id: string; status: string; publicUrl: string | null };

/** Everything the adapter asks of io.net. Tests pass a fake; production uses httpIonetClient. */
export interface IonetClient {
  availableReplicas(hardwareId: number, gpusPerContainer: number): Promise<IonetLocation[]>;
  priceUsd(q: { locationIds: number[]; hardwareId: number; durationHours: number; gpusPerContainer: number; replicaCount: number }): Promise<number | null>;
  deploy(body: IonetDeploy): Promise<{ deploymentId: string }>;
  deployment(id: string): Promise<IonetDeployment | null>;
  containers(id: string): Promise<IonetContainer[]>;
  destroy(id: string): Promise<void>;
  extend(id: string, hours: number): Promise<void>;
  resize(id: string, replicas: number): Promise<void>;
}

// ---- assumptions, one per function --------------------------------------------------------------------------------

/**
 * ASSUMED: the price response states the total for the requested duration in USD under `total_cost_usdc`,
 * `total_cost` or `total_price` (possibly inside `data`). The route and its query are documented; its body is a schema
 * reference the page does not expand.
 */
export function assumedPriceTotalUsd(json: unknown): number | null {
  const j = ((json as { data?: unknown })?.data ?? json ?? {}) as Record<string, unknown>;
  const v = Number(j.total_cost_usdc ?? j.total_cost ?? j.total_price ?? j.total);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** ASSUMED: status names of a deployment and of a container. Anything unknown counts as starting and is never registered. */
export function assumedStatus(status: string): DeploymentStatus {
  const s = status.toLowerCase();
  if (["running", "active"].includes(s)) return "running";
  if (["completed", "terminated", "destroyed", "stopped", "expired"].includes(s)) return "stopped";
  if (["failed", "error", "unpaid"].includes(s)) return "failed";
  return "starting";
}

/** ASSUMED: extending a rental is POST /deployment/<id>/extend {duration_hours} (the docs list the page, not the route). */
export const assumedExtendCall = (id: string, hours: number) => ({ method: "POST" as const, path: `/deployment/${encodeURIComponent(id)}/extend`, body: { duration_hours: hours } });

/** ASSUMED: changing the replica count is PATCH /deployment/<id> {container_config: {replica_count}} ("update deployment configuration"). */
export const assumedResizeCall = (id: string, replicas: number) => ({ method: "PATCH" as const, path: `/deployment/${encodeURIComponent(id)}`, body: { container_config: { replica_count: replicas } } });

// ---- the HTTP client -------------------------------------------------------------------------------------------------

/** IO Cloud CaaS over fetch. Errors name the method, the route template and the status: never a body or the key. */
export function httpIonetClient(o: { apiUrl: string; apiKey: string; fetch?: typeof fetch }): IonetClient {
  const f = o.fetch ?? fetch;
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, label: string, body?: unknown): Promise<unknown> => {
    const res = await f(`${o.apiUrl}${path}`, {
      method,
      headers: { accept: "application/json", "x-api-key": o.apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && method === "GET") { await res.body?.cancel().catch(() => undefined); return null; }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error(`io.net ${method} ${label} returned ${res.status}`); }
    return await res.json().catch(() => null);
  };
  const data = (json: unknown) => ((json as { data?: unknown })?.data ?? json ?? null) as Record<string, unknown> | unknown[] | null;
  return {
    async availableReplicas(hardwareId, gpusPerContainer) {
      const d = data(await call("GET", `/available-replicas?hardware_id=${hardwareId}&hardware_qty=${gpusPerContainer}`, "/available-replicas"));
      return (Array.isArray(d) ? d : []).map((x) => x as Record<string, unknown>).filter((x) => Number.isInteger(x.id)).map((x) => ({ id: x.id as number, name: String(x.name ?? x.iso2 ?? x.id), availableReplicas: Number(x.available_replicas) || 0 }));
    },
    async priceUsd(q) {
      const qs = new URLSearchParams({ location_ids: JSON.stringify(q.locationIds), hardware_id: String(q.hardwareId), duration_hours: String(q.durationHours), gpus_per_container: String(q.gpusPerContainer), replica_count: String(q.replicaCount) });
      return assumedPriceTotalUsd(await call("GET", `/price?${qs}`, "/price"));
    },
    async deploy(body) {
      const j = (await call("POST", "/deploy", "/deploy", body)) as { deployment_id?: unknown } | null;
      if (typeof j?.deployment_id !== "string" || !j.deployment_id) throw new Error("io.net POST /deploy returned no deployment id");
      return { deploymentId: j.deployment_id };
    },
    async deployment(id) {
      const d = data(await call("GET", `/deployment/${encodeURIComponent(id)}`, "/deployment/<id>")) as Record<string, unknown> | null;
      if (!d || typeof d.id !== "string") return null;
      const left = Number(d.compute_minutes_remaining);
      return { id: d.id, status: String(d.status ?? ""), replicas: Number(d.total_containers) || 0, minutesRemaining: Number.isFinite(left) ? left : null };
    },
    async containers(id) {
      const d = data(await call("GET", `/deployment/${encodeURIComponent(id)}/containers?page_size=100`, "/deployment/<id>/containers")) as { workers?: unknown } | null;
      return (Array.isArray(d?.workers) ? d.workers : []).map((w) => w as Record<string, unknown>).map((w) => ({ id: String(w.container_id ?? ""), status: String(w.status ?? ""), publicUrl: typeof w.public_url === "string" && w.public_url ? w.public_url : null }));
    },
    destroy: async (id) => void (await call("DELETE", `/deployment/${encodeURIComponent(id)}`, "/deployment/<id>")),
    extend: async (id, hours) => { const c = assumedExtendCall(id, hours); await call(c.method, c.path, "/deployment/<id>/extend", c.body); },
    resize: async (id, replicas) => { const c = assumedResizeCall(id, replicas); await call(c.method, c.path, "/deployment/<id>", c.body); },
  };
}

// ---- the adapter -----------------------------------------------------------------------------------------------------

export type IonetAdapterOptions = { settings: SupplySettings["ionet"]; appSecret: string; client?: IonetClient; fetch?: typeof fetch };

/** The deploy request of a pinned model: the vLLM image by digest, its arguments, one traffic port, the endpoint key as a secret variable. */
export function ionetDeployBody(spec: SupplyModel, replicas: number, settings: SupplySettings["ionet"], key: string): IonetDeploy {
  if (!settings.hardwareId) throw new Error("IONET_HARDWARE_ID is not set.");
  return {
    resource_private_name: deploymentName(spec),
    duration_hours: settings.durationHours,
    gpus_per_container: settings.gpusPerContainer,
    hardware_id: settings.hardwareId,
    location_ids: settings.locationIds,
    container_config: { replica_count: replicas, traffic_port: VLLM_PORT, entrypoint: [], args: vllmArgs(spec, VLLM_PORT), env_variables: {}, secret_env_variables: { VLLM_API_KEY: key } },
    registry_config: { image_url: spec.image, registry_username: "", registry_secret: "" },
  };
}

export function ionetAdapter(o: IonetAdapterOptions): SupplyAdapter {
  const { settings } = o;
  const hardwareId = settings.hardwareId;
  if (!hardwareId) throw new Error("IONET_HARDWARE_ID is not set.");
  const client = o.client ?? httpIonetClient({ apiUrl: settings.apiUrl, apiKey: settings.apiKey ?? "", fetch: o.fetch });
  const probe = o.fetch ?? fetch;

  const hourly = async (replicas: number) => {
    const total = await client.priceUsd({ locationIds: settings.locationIds, hardwareId, durationHours: settings.durationHours, gpusPerContainer: settings.gpusPerContainer, replicaCount: replicas });
    if (!total) throw new Error("io.net price is not available.");
    return total / settings.durationHours / replicas;
  };

  const describe = async (spec: SupplyModel, id: string, replicas: number): Promise<SupplyDeployment> => {
    const d = await client.deployment(id);
    const workers = d ? await client.containers(id) : [];
    const endpoints = workers.filter((w) => assumedStatus(w.status) === "running").map((w) => openAiBase(w.publicUrl)).filter((u): u is string => !!u);
    return {
      adapter: "ionet",
      externalId: id,
      modelId: spec.modelId,
      weightsSha256: spec.weightsSha256,
      replicas: d?.replicas || replicas,
      status: d ? assumedStatus(d.status) : "stopped",
      endpoints: [...new Set(endpoints)],
      // OPEN unless the operator recorded a Graft attestation URL for this cluster; even then the attestor decides.
      lane: spec.ionetAttestation ? "attestable" : "open",
      attestation: spec.ionetAttestation,
    };
  };

  return {
    name: "ionet",
    async listCapacity(): Promise<CapacityOffer[]> {
      const locations = (await client.availableReplicas(hardwareId, settings.gpusPerContainer)).filter((l) => settings.locationIds.includes(l.id));
      const available = locations.reduce((a, l) => a + l.availableReplicas, 0);
      const usd = await hourly(1).catch(() => null);
      return [{ adapter: "ionet", sku: String(hardwareId), label: `io.net hardware ${hardwareId} (${locations.map((l) => l.name).join(", ") || "no listed location"})`, usdPerReplicaHour: usd, available }];
    },
    async ensureWarm(spec, replicas, existing) {
      if (!(replicas > 0)) throw new Error("ensureWarm needs at least one replica; use tearDown to stop.");
      const current = existing?.externalId ? await client.deployment(existing.externalId) : null;
      if (current && ["running", "starting"].includes(assumedStatus(current.status))) {
        if (current.replicas && current.replicas !== replicas) await client.resize(current.id, replicas);
        // A rental ends on its own; extend it while the pool still wants it and under an hour is left.
        if (current.minutesRemaining != null && current.minutesRemaining < 60) await client.extend(current.id, settings.durationHours);
        return describe(spec, current.id, replicas);
      }
      const { deploymentId } = await client.deploy(ionetDeployBody(spec, replicas, settings, endpointKey(o.appSecret, "ionet", spec)));
      return describe(spec, deploymentId, replicas);
    },
    tearDown: (externalId) => client.destroy(externalId),
    async quote(_spec, replicas, hours): Promise<PriceQuote> {
      const usdPerReplicaHour = await hourly(replicas);
      const totalUsd = usdPerReplicaHour * replicas * hours;
      return { adapter: "ionet", replicas, hours, usdPerReplicaHour, totalUsd, settlement: { unit: "USDC", amount: totalUsd } };
    },
    health: (spec, deployment): Promise<SupplyHealth> => probeEndpoints(probe, spec, deployment.endpoints, endpointKey(o.appSecret, "ionet", spec)),
  };
}
