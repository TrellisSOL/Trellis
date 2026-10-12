import { PublicKey, Transaction } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { log } from "../lib/util.ts";
import { sendAndConfirm } from "./rpc.ts";
import { closeInstructions, postVoucherInstructions, readTab, readTabConfig, reclaimInstruction, tabProgram, type TabState, type Voucher } from "./tab.ts";
import { RECLAIM_GRACE_S, TAB_FINAL_SEQ } from "./programs/tab.ts";
import { listTabUsage, shouldClose, tabPayee, updateTabUsage, type TabUsage } from "./tab-billing.ts";

// The settlement side of tab billing (docs/Trellis_Backend.md §5.2): the job "tab-close" walks the usage records
// tab-billing.ts keeps and, for every tab whose vouched usage is near its cap (CLOSE_AT_CAP_BPS) or whose expiry is near
// (CLOSE_BEFORE_EXPIRY_S), posts the highest voucher with trellis_tab::close signed by the payee (the router signing key
// must be the tab payee). The program pays cumulative_used to the payee's USDC account and the rest of the escrow to the
// payer; a closed tab no longer exists on chain, so the usage record is marked closed and the next request on it is
// refused. A tab the payer reclaimed (after expiry + grace) is marked closed as well.
//
// The payee must always secure what was vouched (security review TR-04):
//  - close itself no longer depends on anything the payer controls: not the payer's token account (a missing, closed or
//    frozen one leaves the refund in escrow and still pays the payee), not a rulebook, not the escrow's exact balance;
//  - should a close fail anyway (an RPC fault, a payee token account that cannot receive, anything else), the job posts
//    the same voucher with post_voucher, which needs only the tab and the voucher: whoever reclaims later pays the payee
//    that amount first. The close is retried on the next run;
//  - once a voucher is posted, a close with that same voucher can never succeed (its seq is not above the posted one),
//    and before this job sent `reclaim` nobody did: the payee's share waited in escrow for someone to deliver it
//    (security re-review RR-15). The job now delivers it: after expiry + the reclaim grace it sends the permissionless
//    `reclaim`, which pays the payee what was posted and the payer the rest.

export type TabCloseResult = { checked: number; closed: number; posted: number; reclaimed: number; gone: number; failed: number; skipped?: string };

export async function runTabClose(ctx: Ctx, now = Math.floor(Date.now() / 1000)): Promise<TabCloseResult> {
  const program = tabProgram(ctx.cfg);
  const payee = tabPayee(ctx);
  const signer = ctx.chain.signer("router");
  const none = { checked: 0, closed: 0, posted: 0, reclaimed: 0, gone: 0, failed: 0 };
  if (!program || !payee) return { ...none, skipped: "tab program or payee not configured" };
  if (!signer || signer.publicKey.toBase58() !== payee) return { ...none, skipped: "the router signing key is not the tab payee; nothing can be closed from here" };
  const records = await listTabUsage(ctx);
  const out = { ...none };
  for (const { pda, usage } of records) {
    const reason = shouldClose(usage, now);
    if (!reason) continue;
    out.checked++;
    try {
      const r = await closeTab(ctx, pda, usage, reason, now);
      if (r === "gone") out.gone++;
      else if (r === "posted") out.posted++;
      else if (r === "reclaimed") out.reclaimed++;
      else out.closed++;
    } catch (e) {
      out.failed++;
      log.warn("tab close failed", { tab: pda.slice(0, 8), reason, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/**
 * Mark a tab's usage record closed without overwriting what a request served in the meantime (security review TR-15):
 * the record is changed under its row lock, starting from what is stored now, not from the snapshot this job read.
 */
const markClosed = (ctx: Ctx, pda: string, snapshot: TabUsage, closed: NonNullable<TabUsage["closed"]>) => updateTabUsage(ctx, pda, snapshot, (current) => ({ ...current, closed }));

/**
 * Post the usage record's highest voucher as a close. "gone" when the tab no longer exists on chain (closed or
 * reclaimed); "posted" when the close failed and the voucher was recorded with post_voucher instead (the close is
 * retried on a later run); "reclaimed" when the highest voucher was already posted, the tab is past expiry + grace and
 * the job delivered the escrow with `reclaim`. Throws when nothing went through.
 */
export async function closeTab(ctx: Ctx, pda: string, usage: TabUsage, reason: string, now = Math.floor(Date.now() / 1000)): Promise<"closed" | "posted" | "reclaimed" | "gone"> {
  const program = tabProgram(ctx.cfg)!;
  const signer = ctx.chain.signer("router")!;
  const tab = new PublicKey(pda);
  const onchain = await readTab(ctx.chain.connection, tab, program);
  if (!onchain) {
    await markClosed(ctx, pda, usage, { tx: "", at: new Date().toISOString(), reason: "gone" });
    return "gone";
  }
  // The payee already closed and only the payer's refund is left in escrow: nothing more to collect.
  if (onchain.postedSeq === TAB_FINAL_SEQ) {
    await markClosed(ctx, pda, usage, { tx: "", at: new Date().toISOString(), reason: "settled" });
    return "gone";
  }
  if (!usage.signature) throw new Error("no voucher to post");
  const voucher: Voucher = { tab, cumulativeUsed: BigInt(usage.cumulativeUsed), seq: BigInt(usage.seq) };
  const signature = new Uint8Array(Buffer.from(usage.signature, "base64"));
  // The highest voucher is on chain already (an earlier close fell back to post_voucher): closing with it again cannot
  // succeed. What is left is to deliver the escrow, which anyone may do once the tab is past expiry + grace.
  if (onchain.postedSeq >= voucher.seq && onchain.postedUsed >= voucher.cumulativeUsed) {
    const config = await readTabConfig(ctx.chain.connection, program).catch(() => null);
    const reclaimAt = onchain.expiry + BigInt(config ? Number(config.reclaimGrace) : RECLAIM_GRACE_S);
    if (BigInt(now) < reclaimAt) return "posted"; // secured on chain; the escrow is delivered once the tab can be reclaimed
    const tx = new Transaction({ feePayer: signer.publicKey });
    tx.add(reclaimInstruction(program, onchain, tab));
    const sent = await sendAndConfirm(ctx.chain.connection, tx, [signer], ctx.cfg.solana.commitment);
    await markClosed(ctx, pda, usage, { tx: sent.signature, at: new Date().toISOString(), reason: "reclaimed" });
    log.info("tab escrow delivered with reclaim", { tab: pda.slice(0, 8), used: onchain.postedUsed.toString(), tx: sent.signature });
    return "reclaimed";
  }
  try {
    const tx = new Transaction({ feePayer: signer.publicKey });
    tx.add(...closeInstructions(program, onchain, voucher, signature));
    const sent = await sendAndConfirm(ctx.chain.connection, tx, [signer], ctx.cfg.solana.commitment);
    await markClosed(ctx, pda, usage, { tx: sent.signature, at: new Date().toISOString(), reason });
    log.info("tab closed", { tab: pda.slice(0, 8), reason, used: usage.cumulativeUsed, tx: sent.signature });
    return "closed";
  } catch (closeError) {
    log.warn("tab close failed; posting the voucher instead", { tab: pda.slice(0, 8), reason, error: (closeError as Error).message.slice(0, 200) });
    const posted = await postVoucher(ctx, onchain, voucher, signature).catch((e) => { log.error("tab voucher could not be posted either", { tab: pda.slice(0, 8), error: (e as Error).message.slice(0, 200) }); return null; });
    if (!posted) throw closeError;
    log.info("tab voucher posted", { tab: pda.slice(0, 8), used: usage.cumulativeUsed, seq: usage.seq, tx: posted });
    return "posted";
  }
}

/**
 * trellis_tab::post_voucher for `voucher`, signed by the payee: the highest voucher is on chain from then on, and any
 * reclaim pays it to the payee. A voucher the chain already holds (same or higher seq) needs nothing sent.
 */
export async function postVoucher(ctx: Ctx, onchain: Pick<TabState, "payee" | "sessionKey" | "createdAt" | "postedSeq" | "postedUsed">, voucher: Voucher, signature: Uint8Array): Promise<string> {
  const program = tabProgram(ctx.cfg)!;
  const signer = ctx.chain.signer("router")!;
  if (onchain.postedSeq >= voucher.seq && onchain.postedUsed >= voucher.cumulativeUsed) return "already-posted";
  const tx = new Transaction({ feePayer: signer.publicKey });
  tx.add(...postVoucherInstructions(program, onchain, voucher, signature));
  return (await sendAndConfirm(ctx.chain.connection, tx, [signer], ctx.cfg.solana.commitment)).signature;
}
