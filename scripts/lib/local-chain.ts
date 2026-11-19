// The local chain of `bun run launch`: a solana-test-validator on this machine with the Trellis programs loaded, a test
// USDC mint, trellis_credits initialised, and the keys a router needs to run the launch configuration against it
// (prepaid credits, x402 per call, memo-anchored receipt roots) plus the test faucet, so the paid flow can be clicked
// through in the dashboard without a wallet or a public cluster.
//
// The programs are the DEVNET flavour (target/deploy-devnet, scripts/devnet/build.sh), as in scripts/test-chain.sh: the
// same code with short floors, so a closure refund can be watched in seconds instead of 72 hours. Never a mainnet build.
// Everything lives under .data/launch-chain (gitignored): the ledger and the keys (mode 0600). The ledger starts empty
// on every launch. All of it is test material: the keys hold only what the local validator's airdrop gives them.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotent, createMint, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { base58Encode } from "../../src/solana/constants.ts";
import { creditsIdl, creditsPdas, decodeCreditsConfig, initConfigIx as creditsInitConfigIx } from "../../src/solana/programs/credits.ts";

export const LOCAL_PROGRAMS = ["credits", "anchor", "rules", "fee_router", "tab", "bond", "capacity", "measurements"] as const;
const ROLES = ["admin", "settlement", "anchorer", "router", "faucet", "payer"] as const;
type Role = (typeof ROLES)[number];

/** Where the Solana tools usually are; the launcher may be started from a shell that has not loaded the profile. */
export function toolPath(): string {
  const extra = [resolve(homedir(), ".local/share/solana/install/active_release/bin"), resolve(homedir(), ".cargo/bin"), resolve(homedir(), ".bun/bin")];
  return [...extra, process.env.PATH ?? ""].join(":");
}

export type LocalChainPlan = { ok: true; dir: string; rpc: string; port: number; validatorArgs: string[] } | { ok: false; why: string };

/** What it takes to start the validator, or why it cannot be started here. Sends nothing. */
export function planLocalChain(root: string, dataDir: string, port: number): LocalChainPlan {
  const validator = Bun.which("solana-test-validator", { PATH: toolPath() });
  if (!validator) return { ok: false, why: "solana-test-validator is not installed (the Solana CLI)" };
  const missing = LOCAL_PROGRAMS.filter((p) => !existsSync(resolve(root, `target/deploy-devnet/trellis_${p}.so`)));
  if (missing.length) return { ok: false, why: `the devnet-flavour programs are not built (${missing.map((p) => `trellis_${p}`).join(", ")}): run scripts/devnet/build.sh` };
  const dir = resolve(dataDir, "launch-chain");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = loadKeys(dir);
  const anchorToml = readFileSync(resolve(root, "Anchor.toml"), "utf8");
  // --reset: an empty ledger every time. A test validator restarted on an old ledger keeps the accounts but no longer
  // serves earlier transactions, which the router's indexer needs to find its place.
  const args = [validator, "--quiet", "--reset", "--rpc-port", String(port), "--ledger", resolve(dir, "ledger")];
  {
    // Every init instruction accepts only the program's upgrade authority, so the programs are loaded as upgradeable
    // with the local admin key (scripts/test-chain.sh does the same).
    for (const p of LOCAL_PROGRAMS) {
      const id = anchorToml.match(new RegExp(`^trellis_${p} = "([^"]+)"`, "m"))?.[1];
      if (!id) return { ok: false, why: `Anchor.toml names no id for trellis_${p}` };
      args.push("--upgradeable-program", id, resolve(root, `target/deploy-devnet/trellis_${p}.so`), keys.admin.publicKey.toBase58());
    }
  }
  return { ok: true, dir, rpc: `http://127.0.0.1:${port}`, port, validatorArgs: args };
}

function loadKeys(dir: string): Record<Role, Keypair> {
  const file = resolve(dir, "keys.json");
  const stored: Partial<Record<Role, number[]>> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const keys = Object.fromEntries(ROLES.map((r) => [r, stored[r] ? Keypair.fromSecretKey(Uint8Array.from(stored[r]!)) : Keypair.generate()])) as Record<Role, Keypair>;
  writeFileSync(file, JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, Array.from(keys[r].secretKey)]))), { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

async function fund(conn: Connection, key: PublicKey, sol: number) {
  if ((await conn.getBalance(key, "confirmed")) >= (sol * LAMPORTS_PER_SOL) / 2) return;
  const signature = await conn.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction({ signature, ...(await conn.getLatestBlockhash()) }, "confirmed");
}

export type LocalTier = "credits" | "minimal";
export type LocalChain = { env: Record<string, string>; tier: LocalTier; network: string; usdcMint: string; creditsProgram: string; faucet: string; payer: string };

/** The local keys as they are on disk (scripts/demo/local-x402.ts pays with the `payer` key). */
export const localKeys = (dir: string) => loadKeys(dir);

/**
 * With the validator answering at `rpc`: fund the local keys, make the test USDC mint (its mint authority is the faucet
 * key), initialise trellis_credits when it has no config yet, and return the settings a router needs. Idempotent: a
 * second run against the same ledger changes nothing.
 */
export async function prepareLocalChain(dir: string, rpc: string, tier: LocalTier = "credits"): Promise<LocalChain> {
  // A validator that has just started (above all one restarted on an existing ledger) answers getHealth a moment before
  // its newest blockhash is accepted: a transaction sent in that moment fails with "Blockhash not found". Every step
  // below is idempotent, so the whole preparation is simply tried again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await prepareOnce(dir, rpc, tier);
    } catch (e) {
      if (attempt >= 6 || !/Blockhash not found|block height exceeded/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

async function prepareOnce(dir: string, rpc: string, tier: LocalTier): Promise<LocalChain> {
  const conn = new Connection(rpc, "confirmed");
  const keys = loadKeys(dir);
  await fund(conn, keys.admin.publicKey, 20);
  for (const r of ["settlement", "anchorer", "router", "faucet"] as const) await fund(conn, keys[r].publicKey, 5);

  const programId = creditsIdl.programId;
  const pdas = creditsPdas(programId);
  let info = await conn.getAccountInfo(pdas.config);
  if (!info) {
    const mint = await createMint(conn, keys.admin, keys.faucet.publicKey, null, 6);
    const treasury = await createAssociatedTokenAccountIdempotent(conn, keys.admin, mint, keys.admin.publicKey);
    // refundDelay 3 s: only the devnet flavour accepts a delay this short; the mainnet build's floor is 72 hours.
    const ix = creditsInitConfigIx(programId, { authority: keys.admin.publicKey, usdcMint: mint, treasuryTokenAccount: treasury, settlementAuthority: keys.settlement.publicKey, guardian: keys.admin.publicKey, refundDelay: 3n });
    await sendAndConfirmTransaction(conn, new Transaction().add(ix), [keys.admin], { commitment: "confirmed" });
    info = await conn.getAccountInfo(pdas.config);
  }
  const config = decodeCreditsConfig(new Uint8Array(info!.data));
  if (!config) throw new Error("the credits config on the local chain could not be read");
  if (!config.settlementAuthority.equals(keys.settlement.publicKey)) throw new Error("the local chain was initialised with other keys than .data/launch-chain/keys.json holds: run `bun run launch --fresh`");
  const usdcMint = config.usdcMint;
  // Where x402 payments land. Nothing is sent when it is already there (a second run changes nothing).
  if (!(await conn.getAccountInfo(getAssociatedTokenAddressSync(usdcMint, keys.router.publicKey, true)))) await createAssociatedTokenAccountIdempotent(conn, keys.admin, usdcMint, keys.router.publicKey);

  // A wallet that holds test USDC and no SOL, for per-call (x402) payments: the router sponsors the network fee.
  const payerToken = getAssociatedTokenAddressSync(usdcMint, keys.payer.publicKey, true);
  if (!(await conn.getAccountInfo(payerToken))) await createAssociatedTokenAccountIdempotent(conn, keys.admin, usdcMint, keys.payer.publicKey);
  if ((await getAccount(conn, payerToken, "confirmed")).amount < 10_000_000n) await mintTo(conn, keys.admin, usdcMint, payerToken, keys.faucet, 100_000_000n);

  const network = `solana:${(await conn.getGenesisHash()).slice(0, 32)}`;
  const secret = (kp: Keypair) => base58Encode(kp.secretKey);
  const shared = {
    SOLANA_RPC_URL: rpc,
    SOL_RPC_URL: rpc,
    SOLANA_COMMITMENT: "confirmed",
    SOLANA_NETWORK: network,
    X402_NETWORK: network,
    USDC_ADDRESS: usdcMint.toBase58(),
    ANCHORER_PRIVATE_KEY: secret(keys.anchorer),
    ROUTER_PRIVATE_KEY: secret(keys.router),
    X402_PAY_TO: keys.router.publicKey.toBase58(),
  };
  // Tier minimal is the launch configuration without a program: pay per call only, receipt roots as memos. No credits
  // program id, no settlement key and no faucet (the faucet deposits through trellis_credits).
  const credits = {
    LAUNCH_TIER: "credits",
    TRELLIS_CREDITS_PROGRAM_ID: programId.toBase58(),
    SETTLEMENT_PRIVATE_KEY: secret(keys.settlement),
    CREDITS_REFUND_DELAY_H: "0",
    FAUCET_ENABLED: "true",
    DEV_FAUCET_PRIVATE_KEY: secret(keys.faucet),
  };
  return {
    tier,
    network,
    usdcMint: usdcMint.toBase58(),
    creditsProgram: programId.toBase58(),
    faucet: keys.faucet.publicKey.toBase58(),
    payer: keys.payer.publicKey.toBase58(),
    env: tier === "minimal" ? { ...shared, LAUNCH_TIER: "minimal" } : { ...shared, ...credits },
  };
}
