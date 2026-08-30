// Shared bits of the devnet scripts: the deployments record (deployments/devnet.json), the gitignored secrets file,
// the deployer keypair and the devnet constants. Nothing here prints a secret.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SOLANA_DEVNET_CAIP2 } from "../../src/solana/constants.ts";

export const ROOT = join(import.meta.dir, "../..");
export const DEPLOYMENTS_FILE = join(ROOT, "deployments/devnet.json");
export const SECRETS_FILE = join(ROOT, "deployments/devnet.secrets.json"); // gitignored; the only place a secret key goes
export const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
export const DEVNET_CAIP2 = SOLANA_DEVNET_CAIP2;
/** Circle's USDC mint on devnet (6 decimals). */
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const PROGRAMS = ["trellis_credits", "trellis_anchor", "trellis_rules", "trellis_tab", "trellis_bond", "trellis_fee_router", "trellis_capacity", "trellis_measurements"] as const;
export type ProgramName = (typeof PROGRAMS)[number];

export type ProgramRecord = { programId: string; status?: "deployed" | "pending"; deploySignature?: string; deployedAt?: string; upgradeSignature?: string; upgradedAt?: string; /** Which build is on chain: "devnet" = cargo feature `devnet` (short floors). */ build?: string; soBytes?: number; upgradeAuthority?: string; neededSol?: number; idl?: { status: string; at?: string } };
export type ConfigRecord = { address: string; signature?: string; initialisedAt?: string; status: "initialised" | "exists" | "updated"; updateSignature?: string; updatedAt?: string; note?: string };
export type Deployments = {
  cluster: "devnet";
  rpc: string;
  network: string;
  deployer?: string;
  updatedAt?: string;
  programs: Partial<Record<ProgramName, ProgramRecord>>;
  mints?: { usdc?: string; usdcSource?: string; trls?: string; trlsSignature?: string; trlsDecimals?: number };
  accounts?: Record<string, string>;
  authorities?: Record<string, string>;
  parameters?: Record<string, string | number>;
  configs?: Partial<Record<ProgramName, ConfigRecord>>;
  /** Which parameter set the configs carry (scripts/devnet/profile.ts): "mainnet" = the spec values, "devnet" = the short devnet-only ones. */
  profile?: "devnet" | "mainnet";
  /** In-place program upgrades and what each needed from existing state (written by hand beside scripts/devnet/deploy.sh --upgrade). */
  upgrades?: Record<string, unknown>[];
  /** Present while the devnet profile is applied: the values that differ from the spec, the spec values, and the update_config transactions. */
  devnetOverrides?: { note: string; values: Record<string, number>; specDefaults: Record<string, number>; transactions: Record<string, string>; appliedAt: string };
};

export function loadDeployments(): Deployments {
  if (!existsSync(DEPLOYMENTS_FILE)) return { cluster: "devnet", rpc: RPC, network: DEVNET_CAIP2, programs: {} };
  return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) as Deployments;
}
export function saveDeployments(d: Deployments): void {
  d.updatedAt = new Date().toISOString();
  mkdirSync(dirname(DEPLOYMENTS_FILE), { recursive: true });
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2) + "\n");
}

export type Secrets = { receiptSigner?: { publicKey: string; secretKey: number[] } };
export function loadSecrets(): Secrets {
  if (!existsSync(SECRETS_FILE)) return {};
  return JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as Secrets;
}
export function saveSecrets(s: Secrets): void {
  mkdirSync(dirname(SECRETS_FILE), { recursive: true });
  writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}

/** The deployer / upgrade-authority keypair (SOLANA_KEYPAIR, else the CLI default). Never logged. */
export function loadKeypair(path = process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json")): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * fetch with backoff for the public devnet RPC, which answers 429 (and the odd 5xx) under load: up to 8 attempts, waiting
 * 1 s, 2 s, 4 s ... (capped at 20 s, or the server's Retry-After). JSON-RPC requests are safe to repeat: a resent
 * transaction carries the same signature.
 */
export async function retryingFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try { res = await fetch(input, init); } catch (e) { if (attempt >= 7) throw e; }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (attempt >= 7) return res!;
    const after = Number(res?.headers.get("retry-after"));
    await Bun.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : Math.min(1000 * 2 ** attempt, 20_000));
  }
}

/** The endpoint as it may be printed: a cluster's own public endpoint in full, anything else (a keyed provider URL) as its host only. */
export function rpcLabel(url: string = RPC): string {
  try {
    const u = new URL(url);
    return /^api\.(devnet|testnet|mainnet-beta)\.solana\.com$/.test(u.hostname) || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? u.origin : `${u.protocol}//${u.hostname} (path and key not shown)`;
  } catch { return "(unparseable RPC URL)"; }
}

export const connection = () => new Connection(RPC, { commitment: "confirmed", fetch: retryingFetch as typeof fetch, disableRetryOnRateLimit: true });

/** True when `id` is an executable account on the cluster (a deployed program). */
export async function isDeployed(conn: Connection, id: PublicKey | string): Promise<boolean> {
  const info = await conn.getAccountInfo(new PublicKey(id), "confirmed");
  return !!info?.executable;
}

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const programDataAddress = (programId: PublicKey) => PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER)[0];

/** Program ids by name, from deployments/devnet.json when recorded, else the IDL's address (identical on every cluster). */
export function programIds(d: Deployments, idlIds: Record<ProgramName, PublicKey>): Record<ProgramName, PublicKey> {
  const out = {} as Record<ProgramName, PublicKey>;
  for (const p of PROGRAMS) out[p] = d.programs[p]?.programId ? new PublicKey(d.programs[p]!.programId) : idlIds[p];
  return out;
}

export const short = (k: PublicKey | string) => k.toString();
export const explorer = (kind: "address" | "tx", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;
