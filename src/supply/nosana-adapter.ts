import type { SupplyModel, SupplySettings } from "./config.ts";
import { VLLM_PORT, deploymentName, endpointKey, openAiBase, probeEndpoints, vllmArgs, type CapacityOffer, type DeploymentStatus, type PriceQuote, type SupplyAdapter, type SupplyDeployment, type SupplyHealth } from "./types.ts";

// nosana-adapter (docs/Trellis_Backend.md §2): pinned open-weight models as vLLM jobs on the Nosana GPU market. OPEN lane
// only: a Nosana node makes no attestation claim, so nothing here ever sets one.
//
// What is taken from Nosana's documentation (learn.nosana.com, read 2026-10):
//   - the job definition: {version: "0.1", type: "container", meta: {trigger}, ops: [{type: "container/run", id,
//     args: {image, cmd, gpu, expose, env, resources}}]}; the vLLM example exposes port 8000;
//   - deployments are created with POST <api>/deployments/create {name, market, timeout (minutes), replicas, strategy,
//     job_definition} and an API key from the dashboard sent as `Authorization: Bearer nos_...`;
//   - POST <api>/deployments/<id>/start, GET <api>/deployments, GET <api>/deployments/<id>;
//   - GET <api>/markets and GET <api>/markets/<address>; the SDK exposes stop, archive and updateReplicaCount.
// What could not be confirmed from the pages (the REST paths behind the SDK's stop/archive/updateReplicaCount, the field
// names of a deployment and of a market, the NOS price route) is isolated in the `assumed*` functions below, one per
// assumption, so a correction touches one function.
//
// Payment: an API-key deployment is paid from the account's Nosana balance; the market's price is quoted in USD per
// hour and the NOS amount is derived from Nosana's own NOS price when that route answers.

export type NosanaMarket = { address: string; name: string; usdPerHour: number | null };
export type NosanaDeployment = { id: string; name: string; status: string; replicas: number; endpoints: string[] };
export type NosanaCreate = { name: string; market: string; timeout: number; replicas: number; strategy: string; job_definition: NosanaJobDefinition };

export type NosanaJobDefinition = {
  version: "0.1";
  type: "container";
  meta: { trigger: string };
  ops: { type: "container/run"; id: string; args: { image: string; cmd: string[]; gpu: true; expose: number; env: Record<string, string> } }[];
};

/** Everything the adapter asks of Nosana. Tests pass a fake; production uses httpNosanaClient. */
export interface NosanaClient {
  market(address: string): Promise<NosanaMarket | null>;
  nosPriceUsd(): Promise<number | null>;
  listDeployments(): Promise<NosanaDeployment[]>;
  getDeployment(id: string): Promise<NosanaDeployment | null>;
  createDeployment(input: NosanaCreate): Promise<NosanaDeployment>;
  startDeployment(id: string): Promise<void>;
  stopDeployment(id: string): Promise<void>;
  archiveDeployment(id: string): Promise<void>;
  updateReplicas(id: string, replicas: number): Promise<void>;
}

// ---- assumptions, one per function --------------------------------------------------------------------------------

type HttpCall = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown };

/** ASSUMED: stopping is POST /deployments/<id>/stop, mirroring the documented POST /deployments/<id>/start. */
export const assumedStopCall = (id: string): HttpCall => ({ method: "POST", path: `/deployments/${encodeURIComponent(id)}/stop` });

/** ASSUMED: archiving (the SDK's deployment.archive()) is PATCH /deployments/<id>/archive with no body. */
export const assumedArchiveCall = (id: string): HttpCall => ({ method: "PATCH", path: `/deployments/${encodeURIComponent(id)}/archive` });

/** ASSUMED: resizing (the SDK's deployment.updateReplicaCount(n)) is PATCH /deployments/<id>/update-replica-count {replicas}. */
export const assumedReplicaCall = (id: string, replicas: number): HttpCall => ({ method: "PATCH", path: `/deployments/${encodeURIComponent(id)}/update-replica-count`, body: { replicas } });

/** ASSUMED: GET /markets/price answers the NOS price in USD as {price} or {usd} (the docs name the route, not its body). */
export function assumedNosPrice(json: unknown): number | null {
  const j = (json ?? {}) as Record<string, unknown>;
  const v = Number(j.price ?? j.usd ?? j.nos_usd);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * ASSUMED: a deployment object carries `id`, `name`, `status`, `replicas` and `endpoints` as a list of {url} (or plain
 * strings). The create response is documented to "contain the created deployment, including its id"; the other names
 * follow the request body and the SDK's deployment object.
 */
export function assumedDeploymentShape(json: unknown): NosanaDeployment | null {
  const j = ((json as { data?: unknown })?.data ?? json ?? {}) as Record<string, unknown>;
  if (typeof j.id !== "string" || !j.id) return null;
  const raw = Array.isArray(j.endpoints) ? j.endpoints : [];
  const endpoints = raw.map((e) => openAiBase(typeof e === "string" ? e : (e as { url?: unknown })?.url)).filter((u): u is string => !!u);
  return { id: j.id, name: typeof j.name === "string" ? j.name : "", status: typeof j.status === "string" ? j.status : "", replicas: Number.isInteger(j.replicas) ? (j.replicas as number) : 0, endpoints };
}

/** ASSUMED: a market object carries `address`, `name` and an hourly USD price under `price_per_hour_usd` (or `usd_reward_per_hour`). */
export function assumedMarketShape(json: unknown): NosanaMarket | null {
  const j = ((json as { data?: unknown })?.data ?? json ?? {}) as Record<string, unknown>;
  if (typeof j.address !== "string" || !j.address) return null;
  const price = Number(j.price_per_hour_usd ?? j.usd_reward_per_hour);
  return { address: j.address, name: typeof j.name === "string" ? j.name : j.address, usdPerHour: Number.isFinite(price) && price > 0 ? price : null };
}

/** ASSUMED: deployment status names. Anything unknown counts as starting, so an unrecognised state is never registered as serving. */
export function assumedStatus(status: string): DeploymentStatus {
  const s = status.toUpperCase();
  if (s === "RUNNING") return "running";
  if (["STOPPED", "STOPPING", "ARCHIVED", "DRAFT"].includes(s)) return "stopped";
  if (["ERROR", "FAILED", "INSUFFICIENT_FUNDS"].includes(s)) return "failed";
  return "starting";
}

// ---- the HTTP client -------------------------------------------------------------------------------------------------

/** Nosana's deployment API over fetch. Errors name the method, the route template and the status: never a body or the key. */
export function httpNosanaClient(o: { apiUrl: string; apiKey: string; fetch?: typeof fetch }): NosanaClient {
  const f = o.fetch ?? fetch;
  const call = async (c: HttpCall, label: string): Promise<unknown> => {
    const res = await f(`${o.apiUrl}${c.path}`, {
      method: c.method,
      headers: { accept: "application/json", authorization: `Bearer ${o.apiKey}`, ...(c.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && c.method === "GET") { await res.body?.cancel().catch(() => undefined); return null; }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error(`Nosana ${c.method} ${label} returned ${res.status}`); }
    return res.status === 204 ? null : await res.json().catch(() => null);
  };
  const list = (json: unknown): unknown[] => (Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : Array.isArray((json as { deployments?: unknown })?.deployments) ? (json as { deployments: unknown[] }).deployments : []);
  return {
    market: async (address) => assumedMarketShape(await call({ method: "GET", path: `/markets/${encodeURIComponent(address)}` }, "/markets/<address>")),
    nosPriceUsd: async () => { try { return assumedNosPrice(await call({ method: "GET", path: "/markets/price" }, "/markets/price")); } catch { return null; } },
    listDeployments: async () => list(await call({ method: "GET", path: "/deployments" }, "/deployments")).map(assumedDeploymentShape).filter((d): d is NosanaDeployment => !!d),
    getDeployment: async (id) => assumedDeploymentShape(await call({ method: "GET", path: `/deployments/${encodeURIComponent(id)}` }, "/deployments/<id>")),
    createDeployment: async (input) => {
      const d = assumedDeploymentShape(await call({ method: "POST", path: "/deployments/create", body: input }, "/deployments/create"));
      if (!d) throw new Error("Nosana POST /deployments/create returned no deployment id");
      return d;
    },
    startDeployment: async (id) => void (await call({ method: "POST", path: `/deployments/${encodeURIComponent(id)}/start` }, "/deployments/<id>/start")),
    stopDeployment: async (id) => void (await call(assumedStopCall(id), "/deployments/<id>/stop")),
    archiveDeployment: async (id) => void (await call(assumedArchiveCall(id), "/deployments/<id>/archive")),
    updateReplicas: async (id, replicas) => void (await call(assumedReplicaCall(id, replicas), "/deployments/<id>/update-replica-count")),
  };
}

// ---- the adapter -----------------------------------------------------------------------------------------------------

/** The job a deployment runs: one vLLM container, GPU on, port 8000 exposed, weights pinned by repository and commit. */
export function nosanaJobDefinition(spec: SupplyModel, key: string): NosanaJobDefinition {
  return {
    version: "0.1",
    type: "container",
    meta: { trigger: "cli" }, // the value the documented vLLM example carries
    ops: [{ type: "container/run", id: "vllm", args: { image: spec.image, cmd: vllmArgs(spec, VLLM_PORT), gpu: true, expose: VLLM_PORT, env: { VLLM_API_KEY: key } } }],
  };
}

export type NosanaAdapterOptions = { settings: SupplySettings["nosana"]; appSecret: string; client?: NosanaClient; fetch?: typeof fetch };

export function nosanaAdapter(o: NosanaAdapterOptions): SupplyAdapter {
  const { settings } = o;
  const market = settings.market;
  if (!market) throw new Error("NOSANA_MARKET is not set.");
  const client = o.client ?? httpNosanaClient({ apiUrl: settings.apiUrl, apiKey: settings.apiKey ?? "", fetch: o.fetch });
  const probe = o.fetch ?? fetch;

  const toDeployment = (spec: SupplyModel, d: NosanaDeployment, replicas: number): SupplyDeployment => ({
    adapter: "nosana",
    externalId: d.id,
    modelId: spec.modelId,
    weightsSha256: spec.weightsSha256,
    replicas: d.replicas || replicas,
    status: assumedStatus(d.status),
    endpoints: d.endpoints,
    lane: "open",
    attestation: null,
  });

  const price = async () => {
    const m = await client.market(market);
    if (!m?.usdPerHour) throw new Error("Nosana market price is not available.");
    return m.usdPerHour;
  };

  return {
    name: "nosana",
    async listCapacity(): Promise<CapacityOffer[]> {
      const m = await client.market(market);
      return m ? [{ adapter: "nosana", sku: m.address, label: m.name, usdPerReplicaHour: m.usdPerHour, available: null }] : [];
    },
    async ensureWarm(spec, replicas, existing) {
      if (!(replicas > 0)) throw new Error("ensureWarm needs at least one replica; use tearDown to stop.");
      const name = deploymentName(spec);
      // A deployment is reused when it is this model at these weights and has neither failed nor been archived.
      const reusable = (d: NosanaDeployment) => d.name === name && assumedStatus(d.status) !== "failed" && d.status.toUpperCase() !== "ARCHIVED";
      let found = existing?.externalId ? await client.getDeployment(existing.externalId) : null;
      if (found && !reusable(found)) found = null;
      found ??= (await client.listDeployments()).find(reusable) ?? null;
      if (!found) {
        const created = await client.createDeployment({ name, market, timeout: settings.timeoutMin, replicas, strategy: settings.strategy, job_definition: nosanaJobDefinition(spec, endpointKey(o.appSecret, "nosana", spec)) });
        await client.startDeployment(created.id);
        return toDeployment(spec, (await client.getDeployment(created.id)) ?? { ...created, status: "STARTING" }, replicas);
      }
      if (found.replicas !== replicas) await client.updateReplicas(found.id, replicas);
      if (assumedStatus(found.status) === "stopped") await client.startDeployment(found.id);
      const now = (await client.getDeployment(found.id)) ?? found;
      return toDeployment(spec, { ...now, replicas }, replicas);
    },
    async tearDown(externalId) {
      await client.stopDeployment(externalId);
      // Archiving only tidies the dashboard; a deployment that is stopped no longer costs anything.
      await client.archiveDeployment(externalId).catch(() => undefined);
    },
    async quote(_spec, replicas, hours): Promise<PriceQuote> {
      const usdPerReplicaHour = await price();
      const totalUsd = usdPerReplicaHour * replicas * hours;
      const nos = await client.nosPriceUsd();
      return { adapter: "nosana", replicas, hours, usdPerReplicaHour, totalUsd, settlement: { unit: "NOS", amount: nos ? totalUsd / nos : null } };
    },
    health: (spec, deployment): Promise<SupplyHealth> => probeEndpoints(probe, spec, deployment.endpoints, endpointKey(o.appSecret, "nosana", spec)),
  };
}
