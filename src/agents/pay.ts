import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, keys, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { usdToPico, usdcToPico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { isWalletAddress, isWalletSignature } from "../lib/wallet-sig.ts";
import { SIGNATURE_RE } from "../solana/constants.ts";
import { formatUsdc } from "../solana/credits.ts";
import { withRetry } from "../solana/rpc.ts";
import { guardUsd } from "./guard-input.ts";
import { agentProfiles } from "./profile-schema.ts";
import { profileSlug } from "./profiles.ts";
import { agentPayments, type AgentPaymentStatus } from "./pay-schema.ts";
import { lockAccount } from "./store.ts";

// Pay another agent. Trellis never holds, routes or custodies the money: the paying agent's own wallet sends USDC on
// Solana straight to the recipient's wallet. The router only (a) decides with the payer's rulebook through Agent Guard
// (action pay.agent), (b) hands back an unsigned transaction for the payer's wallet to sign (one SPL TransferChecked of
// USDC to the recipient's associated token account, with the decision id as a Memo), (c) finds the transfer on chain
// afterwards by its base58 signature and (d) signs a receipt that links the decision to that transfer.
//
// Verification reads the transaction through the RPC: a successful transaction with a USDC transfer to the recipient's
// token account from one of the account's linked wallets, for at least the decided amount. A transfer the cluster has
// confirmed is "seen"; once finalized it is "final" (Solana has no reorganization past finality, so a final payment is
// never re-checked). A seen transaction that disappears before finality (dropped fork) becomes "reversed". Columns kept
// from the EVM-era schema: tx_hash = the signature, log_index = the instruction index, block_number = the slot,
// block_hash = the slot's blockhash.

export const PAY_ACTION = "pay.agent";
export const USDC_DECIMALS = 6;
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RECHECK_AFTER_MS = 60_000;
/** A seen transaction the cluster no longer knows after this long is treated as dropped. */
const DROPPED_AFTER_MS = 10 * 60_000;

export const payInput = z.strictObject({
  to: z.string().min(1).max(64),
  amount_usd: guardUsd.refine(v => usdToPico(v, "ceil") > 0n, "amount_usd must be more than zero"),
  memo_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  approval_id: z.string().min(1).max(64).optional(),
});
export const confirmInput = z.strictObject({ tx_hash: z.string().regex(SIGNATURE_RE, "tx_hash must be a base58 transaction signature").refine(isWalletSignature, "tx_hash must be a base58 64-byte transaction signature") });

type Row = typeof agentPayments.$inferSelect;
export type Recipient = { target: string; wallet: string; profile: string | null; keyHash: string | null };

const usdcMint = (ctx: Ctx) => new PublicKey(ctx.cfg.chain.usdc);
/** USD amounts here carry at most 6 decimals, so they map exactly onto USDC base units. */
export const usdToUnits = (usd: string) => usdToPico(usd, "ceil") / 10n ** 6n;
export const unitsToUsd = (units: bigint) => formatUsdc(units);
export const payReference = (decisionId: string) => `pay-${decisionId.slice(0, 8)}`;
/** The Memo a payment carries: the decision id itself, so the transfer names what it pays. */
export const payMemo = (decisionId: string) => `trellis:pay:${decisionId}`;
const live = and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`);

/** A public profile id with a published payout wallet, or a base58 wallet (linked to an agent when exactly one live profile publishes it). */
export async function resolveRecipient(ctx: Ctx, to: string): Promise<Recipient> {
  if (isWalletAddress(to)) {
    const wallet = to;
    if (wallet === ctx.cfg.chain.usdc) fail(400, "The recipient cannot be the USDC mint.", "invalid_request");
    if (/^1{32,44}$/.test(wallet)) fail(400, "The recipient wallet cannot be the system program.", "invalid_request");
    const agents = ctx.cfg.agentProfilesEnabled ? await ctx.db.select({ slug: agentProfiles.slug, keyHash: agentProfiles.keyHash }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash))
      .where(and(live, sql`${agentProfiles.settings}->>'payout_wallet' = ${wallet}`)).limit(2) : [];
    const agent = agents.length === 1 ? agents[0]! : null;
    return { target: wallet, wallet, profile: agent?.slug ?? null, keyHash: agent?.keyHash ?? null };
  }
  if (!profileSlug.safeParse(to).success) fail(400, "Pay a public profile id or a base58 Solana wallet address.", "invalid_request");
  if (!ctx.cfg.agentProfilesEnabled) fail(404, "Public profiles are not switched on at this router. Pay a base58 wallet address instead.", "not_found");
  const [row] = await ctx.db.select({ profile: agentProfiles }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash)).where(and(eq(agentProfiles.slug, to), live));
  if (!row) fail(404, "Profile not found.", "not_found");
  const wallet = row.profile.settings.payout_wallet; // a base58 wallet (src/agents/profiles.ts); rows from before the port may hold a 0x address
  if (!wallet || !isWalletAddress(wallet)) fail(409, "This agent has not published a Solana payout wallet.", "pay_no_payout_wallet");
  return { target: to, wallet, profile: to, keyHash: row.profile.keyHash };
}

/** Wallets linked to an account: its wallet sign-in wallet, and the signature-verified owner wallet of each organisation it owns. */
export async function linkedWallets(db: Db | Tx, accountId: string): Promise<string[]> {
  const [account] = await db.select({ wallet: accounts.wallet }).from(accounts).where(eq(accounts.id, accountId));
  const owned = await db.select({ wallet: teams.ownerAddress }).from(teams).where(and(eq(teams.ownerAccount, accountId), isNotNull(teams.ownerAddress), isNotNull(teams.ownerVerifiedAt)));
  return [...new Set([account?.wallet, ...owned.map(o => o.wallet)].filter((w): w is string => isWalletAddress(w)))].sort();
}

export const NOT_LINKED = "No wallet is linked to this account. Pay from the wallet you signed in with (wallet sign-in creates the account), or from the verified owner wallet of an organisation this account owns.";

/** The instructions of the payment: create the recipient's USDC account if missing, transfer, memo the decision id. */
export function payInstructionList(ctx: Ctx, payer: PublicKey, recipient: PublicKey, amountUnits: bigint, decisionId: string): TransactionInstruction[] {
  const mint = usdcMint(ctx);
  const to = getAssociatedTokenAddressSync(mint, recipient, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, to, recipient, mint),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, payer, true), mint, to, payer, amountUnits, USDC_DECIMALS),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: payer, isSigner: true, isWritable: false }], data: Buffer.from(payMemo(decisionId), "utf8") }),
  ];
}

/**
 * What the paying wallet sends: an unsigned base64 transaction (USDC TransferChecked to the recipient's associated token
 * account, the decision id as a Memo) with the account's linked wallet as fee payer and signer. The router never signs or
 * sends it. Without a linked wallet (or a reachable RPC for the blockhash) the instructions are described and
 * `transaction` is null.
 */
export async function payInstructions(ctx: Ctx, row: Pick<Row, "decisionId" | "recipientWallet" | "recipientProfile" | "amountUnits">, from: string[]) {
  const mint = usdcMint(ctx);
  const recipient = new PublicKey(row.recipientWallet);
  const payer = from[0] ? new PublicKey(from[0]) : null;
  let transaction: string | null = null;
  let expiresAtBlockHeight: number | null = null;
  let note: string | undefined;
  if (payer) {
    try {
      const { blockhash, lastValidBlockHeight } = await withRetry(() => ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment));
      const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
      tx.add(...payInstructionList(ctx, payer, recipient, row.amountUnits, row.decisionId));
      transaction = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
      expiresAtBlockHeight = lastValidBlockHeight;
    } catch (e) {
      note = "The chain was not reachable to build the transaction; build it from `transfer` with your wallet.";
      log.warn("agent pay instructions: blockhash unavailable", { error: (e as Error).message.slice(0, 120) });
    }
  }
  return {
    chain_id: ctx.cfg.chain.id, chain_name: "Solana", network: ctx.cfg.chain.network, rpc_url: ctx.cfg.chain.publicRpcUrl, explorer_url: ctx.cfg.chain.explorerUrl,
    token: { symbol: "USDC", address: mint.toBase58(), decimals: USDC_DECIMALS },
    to: row.recipientWallet, recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile, token_account: getAssociatedTokenAddressSync(mint, recipient, true).toBase58() },
    amount: unitsToUsd(row.amountUnits), amount_units: row.amountUnits.toString(), reference: payReference(row.decisionId), memo: payMemo(row.decisionId),
    from, ...(from.length ? {} : { warning: NOT_LINKED }),
    /** Unsigned, base64: sign with the `from` wallet and send; then confirm with the base58 signature. */
    transaction, fee_payer: payer?.toBase58() ?? null, expires_at_block_height: expiresAtBlockHeight,
    transfer: { program: "spl-token", instruction: "TransferChecked", mint: mint.toBase58(), amount_units: row.amountUnits.toString(), decimals: USDC_DECIMALS, memo_program: MEMO_PROGRAM_ID.toBase58() },
    ...(note ? { note } : {}),
    confirm: `/api/v1/agents/pay/${row.decisionId}/confirm`,
    custody: "Trellis never holds the money. Send it from your own wallet straight to the recipient, then confirm with the transaction signature.",
  };
}

const STATUS_TEXT: Record<AgentPaymentStatus, string> = {
  awaiting_transfer: "Waiting for the transfer from your wallet",
  seen: "Confirmed, waiting for finality",
  final: "Final",
  reversed: "Reversed: the transaction was dropped before finality",
};
export const payStatusText = (status: AgentPaymentStatus) => STATUS_TEXT[status];

/** The signed statement: this decision, under this rulebook, is linked to this on-chain transfer. */
export function receiptPayload(ctx: Ctx, row: Row) {
  return {
    type: "trellis.agent.payment.v1", status: row.status, decision_id: row.decisionId, policy_sha256: row.policySha256,
    payer: { account_id: row.accountId, key_hash: row.keyHash, wallet: row.payerWallet },
    recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile },
    amount: { token: "USDC", token_address: ctx.cfg.chain.usdc, decimals: USDC_DECIMALS, allowed_units: row.amountUnits.toString(), paid_units: row.paidUnits?.toString() ?? null, allowed_usd: unitsToUsd(row.amountUnits), paid_usd: row.paidUnits === null ? null : unitsToUsd(row.paidUnits) },
    memo_sha256: row.memoSha256, chain_id: ctx.cfg.chain.id, network: ctx.cfg.chain.network, tx_hash: row.txHash, instruction_index: row.logIndex,
    slot: row.blockNumber?.toString() ?? null, block_hash: row.blockHash,
    verified_at: row.verifiedAt?.toISOString() ?? null, status_at: row.statusAt.toISOString(), ...(row.reason ? { reason: row.reason } : {}),
    custody: "none: sent wallet to wallet; Trellis never held the money",
  };
}
function signed(ctx: Ctx, row: Row) {
  const payload = receiptPayload(ctx, row);
  const s = ctx.signer.sign(payload);
  return { receipt: payload, receiptSig: s.sig, receiptKeyId: s.keyId };
}

export async function paymentJson(ctx: Ctx, row: Row, from: string[] = []) {
  return {
    decision_id: row.decisionId, status: row.status, status_text: payStatusText(row.status), status_at: row.statusAt.toISOString(),
    recipient: { wallet: row.recipientWallet, profile_id: row.recipientProfile }, amount: unitsToUsd(row.amountUnits), amount_units: row.amountUnits.toString(),
    paid: row.paidUnits === null ? null : unitsToUsd(row.paidUnits), tx_hash: row.txHash, slot: row.blockNumber?.toString() ?? null,
    payer_wallet: row.payerWallet, verified_at: row.verifiedAt?.toISOString() ?? null, ...(row.reason ? { reason: row.reason } : {}),
    ...(row.status === "awaiting_transfer" ? { instructions: await payInstructions(ctx, row, from) } : {}),
    receipt: row.receiptSig ? { payload: row.receipt, alg: "Ed25519", key_id: row.receiptKeyId, sig: row.receiptSig, verify: "/api/v1/receipts/verify" } : null,
  };
}

// ---- Chain reads --------------------------------------------------------------------------------------------------------

const TRANSFER = 3, TRANSFER_CHECKED = 12;
type Found = { slot: bigint; blockHash: string; index: number; from: string; value: bigint; finalized: boolean };

/** Whether the cluster has finalized `signature` (null when it does not know it at all). */
async function finality(ctx: Ctx, signature: string): Promise<{ known: boolean; finalized: boolean; err: unknown }> {
  const { value } = await withRetry(() => ctx.chain.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const s = value[0];
  if (!s) return { known: false, finalized: false, err: null };
  return { known: true, finalized: s.confirmationStatus === "finalized", err: s.err };
}

/**
 * The USDC transfer in `signature` that pays this decision: sent to the recipient's USDC account, from one of `wallets`,
 * for at least the decided amount, in a successful transaction. Fails with the specific reason otherwise.
 */
async function findTransfer(ctx: Ctx, row: Row, signature: string, wallets: string[], used: Set<number>): Promise<Found> {
  const status = await finality(ctx, signature).catch(() => null);
  if (!status) fail(503, "The router could not reach Solana. Nothing was verified; confirm again shortly.", "pay_chain_unavailable");
  const tx = await withRetry(() => ctx.chain.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
  if (!tx) {
    if (status!.known && status!.err) fail(422, "That transaction failed on chain, so no USDC moved.", "pay_tx_failed");
    fail(409, "That transaction is not on the chain yet. Wait until it is confirmed, then confirm again.", "pay_tx_not_found");
  }
  if (tx!.meta?.err) fail(422, "That transaction failed on chain, so no USDC moved.", "pay_tx_failed");
  const mint = usdcMint(ctx);
  const recipientAta = getAssociatedTokenAddressSync(mint, new PublicKey(row.recipientWallet), true);
  const msg = tx!.transaction.message;
  const keysOf = msg.getAccountKeys({ accountKeysFromLookups: tx!.meta?.loadedAddresses ?? undefined });
  const transfers: { index: number; from: string; value: bigint }[] = [];
  msg.compiledInstructions.forEach((ix, index) => {
    const program = keysOf.get(ix.programIdIndex);
    if (!program || (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID))) return;
    const data = ix.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let dest: PublicKey | undefined, owner: PublicKey | undefined, mintOk = true, value: bigint;
    if (data.length === 10 && data[0] === TRANSFER_CHECKED) {
      [, , dest, owner] = ix.accountKeyIndexes.map((i) => keysOf.get(i));
      mintOk = !!keysOf.get(ix.accountKeyIndexes[1])?.equals(mint);
      value = view.getBigUint64(1, true);
    } else if (data.length === 9 && data[0] === TRANSFER) {
      [, dest, owner] = ix.accountKeyIndexes.map((i) => keysOf.get(i));
      value = view.getBigUint64(1, true);
    } else return;
    if (!mintOk || !dest?.equals(recipientAta) || !owner) return;
    transfers.push({ index, from: owner.toBase58(), value });
  });
  if (!transfers.length) fail(422, `That transaction has no USDC transfer to ${row.recipientWallet}.`, "pay_transfer_not_found");
  const linked = transfers.filter(t => wallets.includes(t.from));
  if (!linked.length) fail(403, `The USDC was sent from ${transfers[0]!.from}, which is not linked to this account. ${NOT_LINKED}`, "pay_wallet_not_linked");
  const enough = linked.filter(t => t.value >= row.amountUnits);
  if (!enough.length) fail(422, `The transfer is less than the ${unitsToUsd(row.amountUnits)} USDC this payment was allowed for.`, "pay_amount_short");
  const t = enough.filter(t => !used.has(t.index)).sort((a, b) => a.index - b.index)[0];
  if (!t) fail(409, "That transfer already confirms another payment.", "pay_transfer_used");
  const blockHash = (await ctx.chain.blockHashAt(BigInt(tx!.slot)).catch(() => null)) ?? msg.recentBlockhash;
  return { slot: BigInt(tx!.slot), blockHash, index: t.index, from: t.from, value: t.value, finalized: status!.finalized };
}

/** Confirm an allowed payment with its transaction signature. The caller has checked ownership. */
export async function confirmPayment(ctx: Ctx, row: Row, signature: string, recordOutcome: (tx: Tx, paidPico: bigint, now: Date) => Promise<void>) {
  if (!isWalletSignature(signature)) fail(400, "tx_hash must be a base58 transaction signature.", "invalid_request");
  if (row.txHash) {
    if (row.txHash !== signature) fail(409, "This payment is already confirmed by another transaction.", "pay_already_confirmed");
    return refreshPayment(ctx, row);
  }
  const wallets = await linkedWallets(ctx.db, row.accountId);
  if (!wallets.length) fail(403, NOT_LINKED, "pay_wallet_not_linked");
  const used = new Set((await ctx.db.select({ logIndex: agentPayments.logIndex }).from(agentPayments).where(eq(agentPayments.txHash, signature))).map(r => r.logIndex!));
  const found = await findTransfer(ctx, row, signature, wallets, used);
  const status: AgentPaymentStatus = found.finalized ? "final" : "seen";
  const now = new Date();
  try {
    return await ctx.db.transaction(async tx => {
      await lockAccount(tx, row.accountId);
      const [current] = await tx.select().from(agentPayments).where(eq(agentPayments.decisionId, row.decisionId)).for("update");
      if (!current || current.status !== "awaiting_transfer") fail(409, "This payment was confirmed in the meantime. Read it again.", "pay_already_confirmed");
      const next: Row = { ...current, status, statusAt: now, txHash: signature, logIndex: found.index, blockNumber: found.slot, blockHash: found.blockHash, payerWallet: found.from, paidUnits: found.value, verifiedAt: now, checkedAt: now, reason: null };
      await recordOutcome(tx, usdcToPico(found.value), now);
      const [saved] = await tx.update(agentPayments).set({ ...pick(next), ...signed(ctx, next) }).where(eq(agentPayments.decisionId, row.decisionId)).returning();
      return saved!;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505" || /agent_payments_transfer_uq/.test(String((e as Error).message))) fail(409, "That transfer already confirms another payment.", "pay_transfer_used");
    throw e;
  }
}
const pick = (r: Row) => ({ status: r.status, statusAt: r.statusAt, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockHash: r.blockHash, payerWallet: r.payerWallet, paidUnits: r.paidUnits, verifiedAt: r.verifiedAt, checkedAt: r.checkedAt, reason: r.reason });

type Recheck = { status: AgentPaymentStatus; reason: string | null } | { unknown: string };
/** Where a seen transaction stands now: finalized, still confirmed, or gone (dropped before finality). */
async function recheck(ctx: Ctx, row: Row): Promise<Recheck> {
  const s = await finality(ctx, row.txHash!).catch(() => null);
  if (!s) return { unknown: "the chain was not reachable" };
  if (s.known && s.err) return { status: "reversed", reason: "the transaction failed on chain" };
  if (s.finalized) return { status: "final", reason: null };
  if (s.known) return { status: "seen", reason: null };
  // Not known any more: a confirmed transaction on a dropped fork. Give the cluster a few minutes before concluding.
  if (Date.now() - row.statusAt.getTime() < DROPPED_AFTER_MS) return { unknown: "the cluster does not report the transaction yet" };
  return { status: "reversed", reason: "the transaction was dropped before finality" };
}

/** Lazy re-verification on read: every seen payment; final ones never change (Solana has no reorganization past finality). */
export async function refreshPayment(ctx: Ctx, row: Row, opts: { force?: boolean } = {}): Promise<Row> {
  if (row.status !== "seen") return row;
  if (!opts.force && row.checkedAt && row.checkedAt.getTime() > Date.now() - 5_000) return row;
  const v = await recheck(ctx, row);
  if ("unknown" in v) {
    log.warn("agent payment could not be re-verified yet", { id: row.decisionId, reason: v.unknown });
    return row;
  }
  const now = new Date(), changed = v.status !== row.status;
  const next: Row = { ...row, checkedAt: now, ...(changed ? { status: v.status, statusAt: now, reason: v.reason } : {}) };
  const set = changed ? { ...pick(next), ...signed(ctx, next) } : { checkedAt: now };
  const [saved] = await ctx.db.update(agentPayments).set(set).where(and(eq(agentPayments.decisionId, row.decisionId), eq(agentPayments.status, row.status), eq(agentPayments.txHash, row.txHash!))).returning();
  if (saved && v.status === "reversed") log.error("agent payment reversed: its transaction was dropped", { id: row.decisionId, tx: row.txHash, reason: v.reason });
  return saved ?? row;
}

/** The agent-pay-verify job: settle seen payments (final once the cluster finalizes them, reversed when dropped). */
export async function runAgentPayVerify(ctx: Ctx, limit = 100) {
  const p = agentPayments;
  const due = or(isNull(p.checkedAt), lt(p.checkedAt, new Date(Date.now() - RECHECK_AFTER_MS)));
  const rows = await ctx.db.select().from(p).where(and(eq(p.status, "seen"), due)).orderBy(sql`${p.checkedAt} asc nulls first`, asc(p.blockNumber)).limit(limit);
  const out = { checked: rows.length, final: 0, reversed: 0, unknown: 0 };
  for (const row of rows) {
    try {
      const next = await refreshPayment(ctx, row, { force: true });
      if (next.status === "final") out.final++;
      else if (next.status === "reversed") out.reversed++;
      else if (next === row) out.unknown++;
    } catch (err) {
      out.unknown++;
      log.warn("agent payment re-verification failed", { id: row.decisionId, reason: (err as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** The decision id a payment's Memo names, when the transaction carries one. */
export function memoDecisionId(data: Uint8Array): string | null {
  const text = Buffer.from(data).toString("utf8");
  const m = /^trellis:pay:([A-Za-z0-9_-]{1,64})$/.exec(text);
  return m ? m[1] : null;
}
