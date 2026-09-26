import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Tx } from "../db/client.ts";
import { generations, ledger, providers } from "../db/schema.ts";
import { toolCalls, toolListings } from "../tools/schema.ts";
import { walletAccountId } from "../api/auth.ts";
import { usdcToPico } from "../lib/money.ts";
import { isWalletAddress } from "../lib/wallet-sig.ts";

// Paid receipts that can back feedback. A source turns a receipt id of its kind into who paid, who was paid or served,
// how much and when. Feedback is accepted only when the reviewer's account is the payer and the subject agent is a
// payee or the agent served. Other features register their own kinds (for example tool calls or job releases) with
// registerReceiptSource; an unknown kind is refused, never guessed.

export type PaidReceipt = {
  kind: string;
  id: string;
  /** The paying account; null when the receipt names no linkable payer (blind tokens, the unlinkable lane). */
  payerAccountId: string | null;
  /** Accounts and keys that were paid or served under this receipt. */
  payee: { accountIds: string[]; keyHashes: string[] };
  /** What the payer paid, net of refunds recorded against this receipt. */
  paidPico: bigint;
  at: Date;
  /**
   * The receipt's hash, 0x-hex: its anchored Merkle leaf (v2 leaf when signed as v2). It is the paid evidence an on-chain
   * feedback entry commits to, together with the amount; null while the receipt is not signed yet.
   */
  hash: `0x${string}` | null;
  /**
   * The network host or tool listing this receipt paid, when it paid one: what feedback about a host or a tool is
   * checked against (src/identity/subject-feedback.ts). Absent for receipts that paid neither.
   */
  subject?: { kind: "host" | "tool"; ref: string } | null;
};

export type ReceiptSource = { kind: string; resolve(ctx: Ctx, id: string): Promise<PaidReceipt | null> };

const sources = new Map<string, ReceiptSource>();
export function registerReceiptSource(source: ReceiptSource) {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(source.kind)) throw new Error(`Receipt kind ${source.kind} must look like "noun.verb".`);
  sources.set(source.kind, source);
}
export const receiptKinds = () => [...sources.keys()].sort();

/** The receipt of that kind, or (without a kind) the first registered kind that knows the id. */
export async function resolvePaidReceipt(ctx: Ctx, id: string, kind?: string): Promise<PaidReceipt | null> {
  if (kind) {
    const source = sources.get(kind);
    return source ? source.resolve(ctx, id) : null;
  }
  for (const name of receiptKinds()) {
    const found = await sources.get(name)!.resolve(ctx, id);
    if (found) return found;
  }
  return null;
}
export const knownReceiptKind = (kind: string) => sources.has(kind);

/**
 * One receipt backs one feedback entry, whether the entry is about an agent (agent_feedback) or about a host or a tool
 * (a kv row under this key). Both writers hold this lock while they look at the other store and insert their own.
 */
export const subjectFeedbackReceiptKey = (kind: string, id: string) => `identity:subject-feedback:${kind}:${id}`;
export const lockReceipt = (tx: Tx, kind: string, id: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-receipt:${kind}:${id}`}, 0))`);

/** A stored leaf (hex, with or without 0x) as 0x-hex; null when absent or malformed. */
export function hex0x(leaf: string | null | undefined): `0x${string}` | null {
  const h = leaf?.replace(/^0x/i, "").toLowerCase();
  return h && /^[0-9a-f]{64}$/.test(h) ? `0x${h}` : null;
}

/** Refunds the ledger records against one generation (positive amounts credited back to the payer). */
async function refundedPico(ctx: Ctx, generationId: string) {
  const [row] = await ctx.db.select({ n: sql<string>`coalesce(sum(${ledger.amount}), 0)` }).from(ledger).where(and(eq(ledger.generationId, generationId), eq(ledger.kind, "refund")));
  const n = BigInt(row?.n ?? 0);
  return n > 0n ? n : 0n;
}

// A model call through the router: the calling account paid; the payee is the operator of the network host that
// served it. Calls answered by the router's own upstream providers have no agent payee and back no feedback.
registerReceiptSource({
  kind: "model.call",
  async resolve(ctx, id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const [g] = await ctx.db.select({ id: generations.id, accountId: generations.accountId, cost: generations.cost, ts: generations.ts, providerId: generations.providerId, mode: generations.mode, receiptId: generations.receiptId, leaf: generations.receiptLeaf, leafV2: generations.receiptLeafV2 })
      .from(generations).where(eq(generations.id, id));
    if (!g || !g.receiptId) return null;
    const [host] = await ctx.db.select({ operator: providers.operator, networkHost: providers.networkHost }).from(providers).where(eq(providers.id, g.providerId));
    const operator = host?.networkHost && isWalletAddress(host.operator) ? host.operator : null; // the operator's base58 wallet
    const paid = g.cost - await refundedPico(ctx, g.id);
    return { kind: "model.call", id: g.id, payerAccountId: g.mode === "blind" ? null : g.accountId, payee: { accountIds: operator ? [walletAccountId(operator)] : [], keyHashes: [] }, paidPico: paid > 0n ? paid : 0n, at: g.ts, hash: hex0x(g.leafV2 ?? g.leaf), subject: operator ? { kind: "host", ref: g.providerId } : null };
  },
});

// A paid tool call (src/tools/call.ts) that delivered its answer: the calling account paid the seller's price; the payee
// is the account that listed the tool. A call to an unlisted resource has no payee here and backs no feedback. The hash
// is the leaf of the signed tool.call receipt.
registerReceiptSource({
  kind: "tool.call",
  async resolve(ctx, id) {
    if (!/^tc_[0-9a-f]{24}$/.test(id)) return null;
    const [t] = await ctx.db.select({ id: toolCalls.id, accountId: toolCalls.accountId, sellerId: toolCalls.sellerId, price: toolCalls.price, receipt: toolCalls.receipt, createdAt: toolCalls.createdAt, closedAt: toolCalls.closedAt })
      .from(toolCalls).where(and(eq(toolCalls.id, id), eq(toolCalls.status, "ok")));
    if (!t) return null;
    const [listing] = t.sellerId ? await ctx.db.select({ id: toolListings.id, accountId: toolListings.accountId }).from(toolListings).where(eq(toolListings.id, t.sellerId)) : [];
    const leaf = t.receipt?.leaf;
    return { kind: "tool.call", id: t.id, payerAccountId: t.accountId, payee: { accountIds: listing ? [listing.accountId] : [], keyHashes: [] }, paidPico: t.price > 0n ? t.price : 0n, at: t.closedAt ?? t.createdAt, hash: hex0x(typeof leaf === "string" ? leaf : null), subject: listing ? { kind: "tool", ref: listing.id } : null };
  },
});

