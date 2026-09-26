import { z } from "zod";
import { ADDRESS_RE } from "../solana/constants.ts";
import { signerAddress } from "../solana/keys.ts";
import { agentRegistryId, knownRegistryCluster, registryNetworkOf } from "./agent-registry.ts";

// v6 I: receipt-backed identity and reputation. Both flags default to false; with them off no identity, feedback,
// reputation or liveness route answers (404), no job is registered and agent cards keep their earlier shape.
//
// Identities are registered in the Solana Agent Registry (QuantuLabs' ERC-8004 port, src/identity/agent-registry.ts).
// AGENT_REGISTRY_PROGRAM_ID names the deployment (empty: registration and on-chain feedback are off; the published ids are
// 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ on mainnet-beta and 8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C on devnet).
// Trellis does not own or operate the registry. The base collection identities are minted into is read from the program's
// RootConfig account; AGENT_REGISTRY_COLLECTION pins it instead.

const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const address = z.string().regex(ADDRESS_RE, "must be a base58 Solana address").optional().or(z.literal("").transform(() => undefined));
const secretKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,96}$/, "must be a base58 64-byte ed25519 secret key").optional().or(z.literal("").transform(() => undefined));

export const identityEnv = {
  AGENT_IDENTITY_ENABLED: flag.default(false),
  PAID_FEEDBACK_ENABLED: flag.default(false),
  // owner: the router prepares the registration transaction and the owner's wallet signs and sends it; registrar: an
  // isolated worker (job agent-identity) sends it with AGENT_IDENTITY_REGISTRAR_KEY and holds the identity asset.
  AGENT_IDENTITY_MODE: z.enum(["owner", "registrar"]).default("owner"),
  AGENT_IDENTITY_REGISTRAR_KEY: secretKey,
  AGENT_REGISTRY_PROGRAM_ID: address, // the agent_registry_8004 deployment; empty = disabled
  AGENT_REGISTRY_COLLECTION: address, // the base collection; default: read from the program's RootConfig
  PAID_FEEDBACK_HALF_LIFE_DAYS: z.coerce.number().min(1).max(3650).default(90),
  AGENT_LIVENESS_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  AGENT_LIVENESS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
};

type Env = z.infer<z.ZodObject<typeof identityEnv>> & {
  SOLANA_NETWORK: string; TRELLIS_ENV: string; RUNTIME_ROLE: string; WORKER_JOBS: string; AGENT_PROFILES_ENABLED: boolean;
  ROUTER_PRIVATE_KEY?: string; SETTLEMENT_PRIVATE_KEY?: string; ANCHORER_PRIVATE_KEY?: string; SLASHER_PRIVATE_KEY?: string;
  KEEPER_PRIVATE_KEY?: string; IPX_KEEPER_PRIVATE_KEY?: string; PAYMASTER_SIGNER_KEY?: string; IPX_ORACLE_PRIVATE_KEY?: string;
};

export type IdentitySettings = ReturnType<typeof identitySettings>;

export function identitySettings(e: Env) {
  const production = e.TRELLIS_ENV === "production";
  const jobs = e.WORKER_JOBS.split(",").map(v => v.trim()).filter(Boolean);
  if ((e.AGENT_IDENTITY_ENABLED || e.PAID_FEEDBACK_ENABLED) && !e.AGENT_PROFILES_ENABLED) throw new Error("AGENT_IDENTITY_ENABLED and PAID_FEEDBACK_ENABLED require AGENT_PROFILES_ENABLED.");
  if (jobs.includes("agent-liveness") && !e.AGENT_IDENTITY_ENABLED) throw new Error("The agent-liveness job needs AGENT_IDENTITY_ENABLED.");
  if (jobs.includes("agent-identity") && !(e.AGENT_IDENTITY_ENABLED && e.AGENT_IDENTITY_MODE === "registrar" && e.AGENT_IDENTITY_REGISTRAR_KEY)) throw new Error("The agent-identity job needs AGENT_IDENTITY_ENABLED, AGENT_IDENTITY_MODE=registrar and AGENT_IDENTITY_REGISTRAR_KEY.");
  if (e.AGENT_IDENTITY_REGISTRAR_KEY && e.AGENT_IDENTITY_MODE !== "registrar") throw new Error("AGENT_IDENTITY_REGISTRAR_KEY is only used with AGENT_IDENTITY_MODE=registrar.");
  const registrar = e.AGENT_IDENTITY_REGISTRAR_KEY ? signerAddress(e.AGENT_IDENTITY_REGISTRAR_KEY) : undefined;
  if (e.AGENT_IDENTITY_REGISTRAR_KEY && !registrar) throw new Error("AGENT_IDENTITY_REGISTRAR_KEY must be a base58 64-byte ed25519 secret key.");
  if (production && e.AGENT_IDENTITY_REGISTRAR_KEY) {
    // A funded chain signer, like the other role keys: one worker, one job, no other signing role.
    if (e.RUNTIME_ROLE !== "worker" || jobs.join(",") !== "agent-identity") throw new Error("AGENT_IDENTITY_REGISTRAR_KEY requires an isolated agent-identity worker.");
    if ([e.ROUTER_PRIVATE_KEY, e.SETTLEMENT_PRIVATE_KEY, e.ANCHORER_PRIVATE_KEY, e.SLASHER_PRIVATE_KEY, e.KEEPER_PRIVATE_KEY, e.IPX_KEEPER_PRIVATE_KEY, e.PAYMASTER_SIGNER_KEY, e.IPX_ORACLE_PRIVATE_KEY].some(Boolean)) throw new Error("AGENT_IDENTITY_REGISTRAR_KEY must be isolated from other signing roles.");
  }
  const programId = e.AGENT_REGISTRY_PROGRAM_ID;
  const cluster = knownRegistryCluster(programId);
  const registryNetwork = registryNetworkOf(programId);
  if (programId && registryNetwork && registryNetwork !== e.SOLANA_NETWORK) throw new Error(`AGENT_REGISTRY_PROGRAM_ID is the ${cluster} registry, but SOLANA_NETWORK is another cluster.`);
  return {
    enabled: e.AGENT_IDENTITY_ENABLED,
    paidFeedback: e.PAID_FEEDBACK_ENABLED,
    mode: e.AGENT_IDENTITY_MODE,
    registrarKey: e.AGENT_IDENTITY_REGISTRAR_KEY,
    /** The registrar's base58 address (it owns the identities it registers). */
    registrar: registrar ?? undefined,
    registry: {
      programId,
      collection: e.AGENT_REGISTRY_COLLECTION,
      /** `<CAIP-2 network>:<program id>`, the id registration files and cards name; null while no program is configured. */
      id: programId ? agentRegistryId(e.SOLANA_NETWORK, programId) : null,
      /** "mainnet" | "devnet" for the published deployments, null for another one. */
      known: cluster,
    },
    halfLifeDays: e.PAID_FEEDBACK_HALF_LIFE_DAYS,
    livenessIntervalMs: e.AGENT_LIVENESS_INTERVAL_MS,
    livenessTimeoutMs: e.AGENT_LIVENESS_TIMEOUT_MS,
  };
}
