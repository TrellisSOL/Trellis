// Shared pieces of the devnet walkthrough (scripts/demo/*.ts): where the gitignored env and state files live, how the
// env files are read, explorer links, and small RPC helpers that cope with the public devnet endpoint's throttling.
// Nothing here prints a secret.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Connection, Keypair, PublicKey, type Commitment, type Signer, type Transaction } from "@solana/web3.js";
import { base58Encode } from "../../src/solana/constants.ts";
import { withRetry } from "../../src/solana/rpc.ts";
import { loadKeypair } from "../devnet/lib.ts";

export { loadKeypair };

export const ROOT = join(import.meta.dir, "../..");
export const ENV_EXAMPLE = join(ROOT, "config/devnet.env.example");
/** The gitignored router environment for devnet: public values from the example file plus locally generated secrets. */
export const ENV_FILE = join(ROOT, ".env.devnet");
/**
 * The walkthrough's own files (under the gitignored .data/): its database, its state and the last summary.
 * DEMO_DATA_DIR=<dir> moves all of them, so a second process (a browser session against its own router, another run of
 * a walkthrough) never shares a pglite directory with this one: pglite is single-process.
 */
export const DEFAULT_STATE_DIR = join(ROOT, ".data/devnet-demo");
export const STATE_DIR = process.env.DEMO_DATA_DIR ? resolve(ROOT, process.env.DEMO_DATA_DIR) : DEFAULT_STATE_DIR;
export const STATE_FILE = join(STATE_DIR, "state.json");
export const SUMMARY_FILE = join(STATE_DIR, "summary.json");
const dbDir = join(STATE_DIR, "pglite");
/** Relative to the repository root when the directory is inside it (the scripts run from there), absolute otherwise. */
export const DATABASE_URL = `pglite://${isAbsolute(relative(ROOT, dbDir)) || relative(ROOT, dbDir).startsWith("..") ? dbDir : relative(ROOT, dbDir)}`;

/**
 * Another walkthrough process that has the default demo database open, as "pid N (script)", or null. Only meaningful
 * for the default directory: a run with its own DEMO_DATA_DIR holds nothing of ours.
 */
export function otherDemoProcess(): string | null {
  if (STATE_DIR !== DEFAULT_STATE_DIR) return null;
  try {
    const out = Bun.spawnSync(["ps", "-axo", "pid=,comm=,args="]).stdout.toString();
    for (const l of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      if (!m || Number(m[1]) === process.pid || !/(^|\/)bun$/.test(m[2])) continue;
      const script = /scripts\/demo\/(devnet-demo|devnet-paths|private-ai)\.ts(.*)$/.exec(m[3]);
      // A keyless private-ai run uses its own in-memory database and holds nothing.
      if (script && (script[1] !== "private-ai" || /--(call|dry-run)\b/.test(script[2]))) return `pid ${m[1]} (scripts/demo/${script[1]}.ts)`;
    }
  } catch { /* no ps: nothing to check with */ }
  return null;
}

/** The endpoint as it may be printed: a cluster's own public endpoint in full, a keyed provider URL as its host only. */
export function rpcLabel(url: string): string {
  try {
    const u = new URL(url);
    return /^api\.(devnet|testnet|mainnet-beta)\.solana\.com$/.test(u.hostname) || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? u.origin : `${u.protocol}//${u.hostname} (path and key not shown)`;
  } catch { return "(unparseable RPC URL)"; }
}

/** `KEY=value` lines; a trailing `# comment` after whitespace is dropped, as are blank and comment lines. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    value = value.replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The example file layered under .env.devnet (the latter wins), as the router would see it. */
export function loadDevnetEnv(): Record<string, string> {
  return { ...parseEnvFile(ENV_EXAMPLE), ...parseEnvFile(ENV_FILE) };
}

/** The RPC endpoint: SOLANA_RPC_URL, then DEVNET_RPC_URL, then the env files, then the public endpoint. */
export function rpcUrl(env: Record<string, string> = loadDevnetEnv()): string {
  return process.env.SOLANA_RPC_URL ?? process.env.DEVNET_RPC_URL ?? env.SOLANA_RPC_URL ?? env.SOL_RPC_URL ?? "https://api.devnet.solana.com";
}

/**
 * The RPC endpoint make-env.ts writes: the process environment, then the endpoint the existing .env.devnet already
 * carries (an operator's own, usually keyed, endpoint must survive a re-run), then the example file, then the public one.
 */
export function envFileRpcUrl(processEnv: Record<string, string | undefined>, existing: Record<string, string>, example: Record<string, string>): string {
  return processEnv.SOLANA_RPC_URL || processEnv.DEVNET_RPC_URL || existing.SOLANA_RPC_URL || existing.SOL_RPC_URL || example.SOLANA_RPC_URL || example.SOL_RPC_URL || "https://api.devnet.solana.com";
}

/**
 * Lines of an existing env file that a regenerated one must carry over: assignments of names the generator does not
 * write, and commented-out assignments (`# NAME=value`, where an operator parks a value). Section headers and other
 * prose comments are not kept; they are regenerated.
 */
export function handAddedLines(existingText: string, written: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of existingText.split("\n")) {
    const line = raw.trim();
    const parked = /^#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const set = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (parked || (set && !written.has(set[1]))) out.push(line);
  }
  return out;
}

export function writePrivateFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

export const explorer = (kind: "tx" | "address", value: string, base = "https://explorer.solana.com") => `${base.replace(/\/$/, "")}/${kind}/${value}?cluster=devnet`;

/** The 64-byte secret key in the base58 form the router's *_PRIVATE_KEY settings take. */
export const secretKeyBase58 = (kp: Keypair) => base58Encode(kp.secretKey);

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** An ed25519 seed (the first 32 bytes of a Solana secret key) as the base64 PKCS8 DER RECEIPT_SIGNING_KEY takes. */
export const pkcs8Base64FromSeed = (seed: Uint8Array) => Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed.subarray(0, 32))]).toString("base64");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Patient retries for the public devnet RPC (429s and transient network errors). */
export const rpc = <T>(fn: () => Promise<T>) => withRetry(() => fn(), { attempts: 8, baseMs: 800, maxMs: 15_000 });

export const connect = (url: string, commitment: Commitment = "confirmed") => new Connection(url, { commitment });

export async function solBalance(conn: Connection, address: PublicKey): Promise<number> {
  return (await rpc(() => conn.getBalance(address, "confirmed"))) / 1e9;
}

/** The balance of a token account in base units, 0n when the account does not exist. */
export async function tokenUnits(conn: Connection, tokenAccount: PublicKey): Promise<bigint> {
  const info = await rpc(() => conn.getTokenAccountBalance(tokenAccount, "confirmed")).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}

export type Sent = { signature: string; slot: number | null };

/** Sign, send and wait for `commitment` (finalized by default: that is what the credits indexer reads). */
export async function signSendConfirm(conn: Connection, tx: Transaction, signers: Signer[], commitment: Commitment = "finalized", timeoutMs = 180_000): Promise<Sent> {
  if (!tx.recentBlockhash) {
    const { blockhash, lastValidBlockHeight } = await rpc(() => conn.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
  }
  tx.partialSign(...signers);
  const raw = tx.serialize();
  const signature = await rpc(() => conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }));
  return { signature, slot: await waitForSignature(conn, signature, commitment, timeoutMs) };
}

/** Poll a signature's status until it reaches `commitment`; throws on an on-chain error or a timeout. */
export async function waitForSignature(conn: Connection, signature: string, commitment: Commitment = "finalized", timeoutMs = 180_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const rank = (s: string | null | undefined) => (s === "finalized" ? 3 : s === "confirmed" ? 2 : s === "processed" ? 1 : 0);
  const want = rank(commitment === "finalized" ? "finalized" : commitment === "confirmed" ? "confirmed" : "processed");
  while (Date.now() < deadline) {
    const { value } = await rpc(() => conn.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const s = value[0];
    if (s?.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(s.err)}`);
    if (s && rank(s.confirmationStatus) >= want) return s.slot;
    await sleep(2_000);
  }
  throw new Error(`transaction ${signature} did not reach ${commitment} within ${Math.round(timeoutMs / 1000)}s`);
}

export const usdcUnits = (s: string | number): bigint => {
  const [whole, frac = ""] = String(s).split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,6}$/.test(frac)) throw new RangeError(`not a USDC amount: ${s}`);
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
};
export const formatUsdc = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
