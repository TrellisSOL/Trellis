import { and, eq, isNull, sql } from "drizzle-orm";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { base58Encode } from "../solana/constants.ts";
import { confirmSignature, signatureOutcome, withRetry } from "../solana/rpc.ts";
import type { Ctx } from "../context.ts";
import { payouts, providers, settlements } from "../db/schema.ts";
import { decrypt, encrypt, log, uid } from "../lib/util.ts";
import { networkFeeLedger, networkPayoutDispatch } from "./payout-schema.ts";

// Weekly USDC payouts to network hosts (docs/Trellis_Backend.md §5.7 "host settlement, paid weekly"):
// trellis_credits::settle_to_host(amount, hour_root_ref) from the credits vault to the host's payout address (its
// associated token account, created if missing), referencing the latest committed SpentRoot; the program bounds every
// payout by spent_total - settled_total. The transaction is signed once, persisted, then broadcast. Recovery
// rebroadcasts the identical bytes while the blockhash lives and otherwise leaves the payout pending for operator
// reconciliation: a claimed invoice is never transferred again with a fresh transaction. A payout the committed spend
// does not cover yet is not signed at all; it stays pending for the next run. The payout address was screened against
// the sanctions list by the caller.

/** The settlement job's chain surface, so tests can run without a cluster. */
export type PayoutTransport = {
  /** Sign the transfer; returns the serialized transaction and its signature (the transaction id). */
  prepare(to: string, units: bigint): Promise<{ raw: string; hash: string; lastValidBlockHeight: number; blockhash: string }>;
  /** Whether the cluster knows the signature; null when it does not. */
  outcome(hash: string): Promise<"success" | "failed" | null>;
  broadcast(raw: string): Promise<void>;
  confirm(hash: string, strategy: { blockhash: string; lastValidBlockHeight: number }): Promise<void>;
};

export function payoutTransport(ctx: Ctx): PayoutTransport {
  const rpc = ctx.chain.connection;
  return {
    prepare: async (to, units) => {
      const settlement = ctx.chain.wallet("settlement").keypair;
      const c = await ctx.chain.creditsConfigOnChain();
      if (!c || c.latestHour <= 0n) throw new Error("Network payout waits for the first committed spent root.");
      const available = c.spentTotal > c.settledTotal ? c.spentTotal - c.settledTotal : 0n;
      if (units > available) throw new Error("Network payout exceeds committed spend; it stays pending for the next spent root.");
      const { blockhash, lastValidBlockHeight } = await withRetry(() => rpc.getLatestBlockhash(ctx.cfg.solana.commitment));
      const tx = new Transaction({ feePayer: settlement.publicKey, blockhash, lastValidBlockHeight });
      const owner = new PublicKey(to);
      tx.add(...ctx.chain.settleToHostInstructions(getAssociatedTokenAddressSync(ctx.chain.usdcMint, owner, true), units, c.latestHour, owner));
      tx.sign(settlement);
      const sig = tx.signature;
      if (!sig) throw new Error("payout transaction was not signed");
      return { raw: Buffer.from(tx.serialize()).toString("base64"), hash: base58Encode(new Uint8Array(sig)), lastValidBlockHeight, blockhash };
    },
    outcome: (hash) => signatureOutcome(rpc, hash),
    broadcast: async (raw) => { await withRetry(() => rpc.sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: false, maxRetries: 3 })); },
    confirm: async (hash, strategy) => { await confirmSignature(rpc, hash, strategy, ctx.cfg.solana.commitment); },
  };
}

/** Intercept network hosts only. Persist the signed transfer before broadcasting; recovery rebroadcasts identical bytes. */
export async function networkPayout(ctx: Ctx, p: typeof providers.$inferSelect, cutoff: string, out: unknown[], transport: PayoutTransport = payoutTransport(ctx)) {
  if (!p.networkHost) return false;
  if (!ctx.cfg.networkPayouts.enabled || p.payoutMode !== "usdc" || !p.payoutAddress || !ctx.chain.roleAddress("settlement")) return true;
  let row = await ctx.db.transaction(async tx => {
    await tx.select({ id: providers.id }).from(providers).where(eq(providers.id, p.id)).for("update");
    const [pending] = await tx.select().from(payouts).where(and(eq(payouts.providerId, p.id), eq(payouts.status, "pending"))).limit(1);
    if (pending) return pending;
    // Only invoices created by anchored network accrual are eligible.
    const due = await tx.select().from(settlements).where(and(eq(settlements.providerId, p.id), isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`, sql`exists (select 1 from ${networkFeeLedger} f where f.provider_id = ${p.id} and f.period = ${settlements.period} and f.gross_pico = ${settlements.upstream} and f.fee_pico = ${settlements.fee})`));
    const amount = due.reduce((n, e) => n + e.usdcOwed, 0n);
    if (amount <= 0n) return;
    const [pay] = await tx.insert(payouts).values({ id: uid("pay_"), providerId: p.id, usdc: amount, to: p.payoutAddress, status: "pending" }).returning();
    for (const e of due) await tx.update(settlements).set({ payoutId: pay.id }).where(and(eq(settlements.providerId, p.id), eq(settlements.period, e.period)));
    return pay;
  });
  if (!row) return true;
  const claimed = await ctx.db.select({ invoice: settlements, fee: networkFeeLedger }).from(settlements).leftJoin(networkFeeLedger, and(eq(networkFeeLedger.providerId, settlements.providerId), eq(networkFeeLedger.period, settlements.period))).where(eq(settlements.payoutId, row.id));
  if (!claimed.length || claimed.some(e => e.invoice.providerId !== p.id || !e.fee || e.fee.grossPico !== e.invoice.upstream || e.fee.feePico !== e.invoice.fee || e.invoice.usdcOwed !== (e.invoice.upstream - e.invoice.fee) / 1_000_000n) || claimed.reduce((n, e) => n + e.invoice.usdcOwed, 0n) !== row.usdc) throw new Error("Pending network payout does not reconcile with anchored invoices.");
  // Destination changes require manual reconciliation; screening must apply to the actual transfer. Base58 compares byte for byte.
  if (row.to !== p.payoutAddress) throw new Error("Network payout destination changed; reconcile the pending transfer.");
  let [dispatch] = await ctx.db.select().from(networkPayoutDispatch).where(eq(networkPayoutDispatch.payoutId, row.id));
  let strategy: { blockhash: string; lastValidBlockHeight: number } | null = null;
  if (!dispatch) {
    let prepared: Awaited<ReturnType<PayoutTransport["prepare"]>>;
    try {
      prepared = await transport.prepare(row.to, row.usdc);
    } catch (e) {
      // Not signed, nothing to reconcile: the payout stays pending and is retried next run.
      log.warn("network payout held", { provider: p.id, reason: (e as Error).message });
      out.push({ provider: p.id, usdc: row.usdc.toString(), status: "pending", reason: (e as Error).message });
      return true;
    }
    strategy = { blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight };
    await ctx.db.insert(networkPayoutDispatch).values({ payoutId: row.id, signedTxEnc: encrypt(ctx.cfg.appSecret, JSON.stringify({ raw: prepared.raw, ...strategy })), txHash: prepared.hash }).onConflictDoNothing();
    [dispatch] = await ctx.db.select().from(networkPayoutDispatch).where(eq(networkPayoutDispatch.payoutId, row.id));
  }
  const hash = dispatch.txHash;
  let outcome = await transport.outcome(hash);
  if (!outcome) {
    const stored = JSON.parse(decrypt(ctx.cfg.appSecret, dispatch.signedTxEnc)) as { raw: string; blockhash: string; lastValidBlockHeight: number };
    strategy ??= { blockhash: stored.blockhash, lastValidBlockHeight: stored.lastValidBlockHeight };
    try {
      await transport.broadcast(stored.raw);
      await transport.confirm(hash, strategy);
      outcome = "success";
    } catch {
      // Expired blockhash or an unreachable cluster: the payout stays pending with its signed bytes for the operator.
      outcome = await transport.outcome(hash);
      if (!outcome) throw new Error("Network payout broadcast unresolved; signed transfer retained for reconciliation.");
    }
  }
  if (outcome !== "success") throw new Error("Network payout transfer failed on chain; reconcile before retrying.");
  await ctx.db.transaction(async tx => {
    await tx.update(payouts).set({ status: "paid", tx: hash }).where(eq(payouts.id, row!.id));
    await tx.update(settlements).set({ paidTx: hash }).where(eq(settlements.payoutId, row!.id));
  });
  out.push({ provider: p.id, usdc: row.usdc.toString(), tx: hash });
  return true;
}

export async function addPendingNetworkPayouts(ctx: Ctx, due: { providerId: string; owed: string }[]) {
  if (!ctx.cfg.networkPayouts.enabled) return;
  const pending = await ctx.db.select({ providerId: payouts.providerId }).from(payouts).innerJoin(providers, eq(providers.id, payouts.providerId)).where(and(eq(providers.networkHost, true), eq(payouts.status, "pending")));
  for (const p of pending) if (!due.some(d => d.providerId === p.providerId)) due.push({ providerId: p.providerId, owed: "0" });
}
