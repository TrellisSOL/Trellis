import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import type { Config } from "../config.ts";
import { ADDRESS_RE } from "../solana/constants.ts";
import { loadSigner } from "../solana/keys.ts";
import { bondConfigSpec } from "../solana/account-specs.ts";
import { bondPdas } from "../solana/programs/bond.ts";
import { createConnection } from "../solana/rpc.ts";
import { readVerifiedAccount } from "../solana/verified-account.ts";

// Host-bond settings: the trellis_bond program the network indexes and slashes against. HOST_BOND_ADDRESS is its
// program id (base58); it defaults to TRELLIS_BOND_PROGRAM_ID so one setting names the program for every module.
// HOST_BOND_START_BLOCK is the first slot the indexer scans.

const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
export const hostBondEnv = {
  HOST_BOND_ADDRESS: z.string().regex(ADDRESS_RE, "must be a base58 Solana program id").optional().or(z.literal("").transform(() => undefined)),
  HOST_BOND_START_BLOCK: z.coerce.bigint().min(0n).default(0n),
  NETWORK_BONDS_ENABLED: flag.default(false),
  NETWORK_SLASHING_ENABLED: flag.default(false),
  NETWORK_BOND_FULL_USDC: z.coerce.number().positive().max(1_000_000_000).default(5_000),
  NETWORK_BOND_FINALITY: z.enum(["finalized", "confirmed"]).default("finalized"), // Solana commitment levels
};
export function hostBondSettings(e: z.infer<z.ZodObject<typeof hostBondEnv>> & { SLASHER_PRIVATE_KEY?: string; TRELLIS_BOND_PROGRAM_ID?: string; WORKER_JOBS: string }) {
  const address = e.HOST_BOND_ADDRESS ?? e.TRELLIS_BOND_PROGRAM_ID;
  if (e.NETWORK_BONDS_ENABLED && !address) throw new Error("NETWORK_BONDS_ENABLED requires HOST_BOND_ADDRESS (or TRELLIS_BOND_PROGRAM_ID).");
  if (e.NETWORK_SLASHING_ENABLED && (!e.NETWORK_BONDS_ENABLED || !e.SLASHER_PRIVATE_KEY)) throw new Error("NETWORK_SLASHING_ENABLED requires NETWORK_BONDS_ENABLED and SLASHER_PRIVATE_KEY.");
  const jobs = e.WORKER_JOBS.split(",").map(v => v.trim());
  if (jobs.includes("host-bond-indexer") && !e.NETWORK_BONDS_ENABLED) throw new Error("host-bond-indexer requires NETWORK_BONDS_ENABLED.");
  if (jobs.includes("host-slasher") && !e.NETWORK_BONDS_ENABLED) throw new Error("host-slasher requires NETWORK_BONDS_ENABLED.");
  if (e.NETWORK_SLASHING_ENABLED && jobs.includes("slasher")) throw new Error("host-slasher must be isolated from the provider slasher.");
  return { enabled: e.NETWORK_BONDS_ENABLED, slashing: e.NETWORK_SLASHING_ENABLED, address, startBlock: e.HOST_BOND_START_BLOCK, fullUsdc: e.NETWORK_BOND_FULL_USDC, finality: e.NETWORK_BOND_FINALITY };
}
/** Runs before opening the database; a changed role is also checked before each signing pass. `read` returns BondConfig.slasher (base58). */
export async function guardHostSlasher(cfg: Config, read?: () => Promise<string>) {
  if (!cfg.hostBonds.slashing) return;
  const key = cfg.chain.slasherKey;
  if (!key) throw new Error("Host slasher signing key is required.");
  const slasher = await (read ?? (async () => {
    const connection = createConnection({ rpcUrl: cfg.chain.rpcUrl, rpcFallbackUrls: cfg.chain.rpcFallbackUrls, commitment: cfg.solana.commitment });
    const program = new PublicKey(cfg.hostBonds.address!);
    const c = await readVerifiedAccount(connection, bondPdas(program).config, bondConfigSpec(program));
    if (!c) throw new Error("trellis_bond is not initialised.");
    return c.slasher.toBase58();
  }))();
  if (loadSigner(key).publicKey.toBase58() !== slasher) throw new Error("SLASHER_PRIVATE_KEY address does not equal BondConfig.slasher.");
}
