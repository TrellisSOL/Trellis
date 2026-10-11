import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { SOLANA_MAINNET_CAIP2 } from "./constants.ts";
import { buildDepositTransaction, creditsProgram, readCreditAccount } from "./credits.ts";
import { sendAndConfirm, withRetry } from "./rpc.ts";

// The test USDC faucet (localnet and devnet only; FAUCET_ENABLED, or the older loopback-only DEV_FAUCET): mints test USDC
// to the faucet wallet's token account and deposits it to a key's credit account through trellis_credits::deposit, so
// the site can be tried without a wallet. The faucet key (DEV_FAUCET_PRIVATE_KEY) must be the test mint's mint
// authority; the deposit goes through the same builder wallets use (credits.ts buildDepositTransaction), so the per-key
// cap and the first-depositor-is-authority rule are exactly those of a real deposit. Never on mainnet-beta.

export function faucetEnabled(ctx: Ctx): boolean {
  if (ctx.cfg.chain.network === SOLANA_MAINNET_CAIP2 || ctx.cfg.production) return false;
  if (!ctx.cfg.faucet.enabled && !ctx.cfg.chain.faucetKey) return false;
  return !!ctx.chain.signer("faucet");
}

export type FaucetResult = { hash: string; units: bigint; depositor: string; credit: string };

/** Mint `units` of test USDC to the faucet wallet and deposit them to the key's credit account in one transaction. */
export async function faucetDeposit(ctx: Ctx, chainKeyHash: string, units: bigint): Promise<FaucetResult> {
  if (!faucetEnabled(ctx)) fail(404, "The test USDC faucet is only available on localnet and devnet.", "not_found");
  const program = creditsProgram(ctx.cfg);
  if (!program) fail(503, "The credits program is not configured on this router.", "chain_unconfigured");
  const faucet = ctx.chain.signer("faucet")!;
  const depositorToken = getAssociatedTokenAddressSync(program!.mint, faucet.publicKey, true);
  const current = (await readCreditAccount(ctx.chain.connection, program!, chainKeyHash))?.balance ?? 0n;
  const { blockhash, lastValidBlockHeight } = await withRetry(() => ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment));
  let built: ReturnType<typeof buildDepositTransaction>;
  try {
    built = buildDepositTransaction(program!, { depositor: faucet.publicKey, chainKeyHash, amount: units, currentBalance: current, capUnits: ctx.cfg.solana.caps.creditsUnits, recentBlockhash: blockhash, lastValidBlockHeight });
  } catch (e) {
    return fail(400, (e as Error).message, "invalid_request");
  }
  const deposit = Transaction.from(Buffer.from(built.transaction, "base64"));
  const tx = new Transaction({ feePayer: faucet.publicKey, blockhash, lastValidBlockHeight });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, depositorToken, faucet.publicKey, program!.mint),
    createMintToInstruction(program!.mint, depositorToken, faucet.publicKey, units),
    ...deposit.instructions,
  );
  const sent = await sendAndConfirm(ctx.chain.connection, tx, [faucet], ctx.cfg.solana.commitment);
  return { hash: sent.signature, units, depositor: faucet.publicKey.toBase58(), credit: built.accounts.credit };
}

/** What /api/v1/status says about the faucet. */
export const faucetStatus = (ctx: Ctx) => ({ enabled: faucetEnabled(ctx), network: ctx.cfg.chain.network, route: faucetEnabled(ctx) ? "/api/v1/dev/faucet" : null, mint: faucetEnabled(ctx) ? ctx.cfg.chain.usdc : null, authority: faucetEnabled(ctx) ? (ctx.chain.roleAddress("faucet") ?? null) : null });

export const faucetMint = (ctx: Ctx) => new PublicKey(ctx.cfg.chain.usdc);
