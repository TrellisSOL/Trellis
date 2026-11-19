import { and, eq, gt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { blindKeys, holds, ledger } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsdString, type Pico } from "../lib/money.ts";
import { log, sha256 } from "../lib/util.ts";
import type { KeyRow } from "../api/auth.ts";
import { post, release, reserve, settle } from "../ledger/ledger.ts";
import { keyValue } from "./issuer.ts";
import { BLIND_POOL, ensurePool } from "./redeem.ts";
import { isValidBlindedMsg } from "./rsa.ts";
import { hex } from "./privacy-token.ts";

// Buying tokens: the caller's credits pay for N blind signatures on one denomination.
//
// What is recorded: the ledger debit on the caller's account (an amount, no tokens), the pool credit, and a
// per-key issued count. What is not: the blinded messages, the signatures, or anything derived from a token.
// The blind signature means the issuer could not connect a token it later sees to any purchase even if it
// kept them; it does not keep them.
//
// A purchase is idempotent: its hold id is derived from the account, the key and the blinded messages, so
// sending the same request again after a lost response signs again without charging again. (RSA signing is
// deterministic, so the replayed signatures are the same ones.) A different set of messages is a new purchase.

const DAY_MS = 86_400_000;

export type Purchase = { key: typeof blindKeys.$inferSelect; count: number; cost: Pico; signatures: Uint8Array[]; replayed: boolean };

/** What a closed hold charged, from its stored result. */
const chargedBy = (result: unknown): Pico => BigInt((result as { charged?: string } | null)?.charged ?? 0);

/**
 * Charge a purchase's hold: all of `cost`, or nothing. settle() charges a hold that expired before it was settled from
 * what the account has left, which can be less than the hold. A purchase that was not paid in full is not a purchase:
 * what was charged goes back, nothing is signed, and the hold does not count as paid when the request is sent again.
 */
export async function chargePurchase(ctx: Ctx, hold: { id: string; accountId: string; keyHash: string | null }, cost: Pico, description: string): Promise<void> {
  let charged: Pico;
  try {
    charged = (await settle(ctx.db, hold.id, cost, { description, kind: "blind_purchase" })).charged;
  } catch (e) {
    await release(ctx.db, hold.id).catch(() => undefined);
    throw e;
  }
  if (charged === cost) return;
  if (charged > 0n) await post(ctx.db, { accountId: hold.accountId, amount: charged, kind: "blind_purchase", ref: `blind:short:${hold.id}`, keyHash: hold.keyHash, description: `${description}: not paid in full, returned` });
  log.error("blind purchase was not charged in full; nothing was signed", { hold: hold.id, cost, charged });
  fail(402, "This purchase could not be charged in full, so no token was signed and what was charged has been returned. Check the balance and send it again.", "insufficient_credits");
}

export async function purchaseTokens(ctx: Ctx, caller: KeyRow, input: { tokenKeyId: string; blinded: Uint8Array[] }): Promise<Purchase> {
  const issuer = ctx.blind!;
  const cfg = ctx.cfg.blind;
  const count = input.blinded.length;
  if (count < 1 || count > cfg.maxBatch) fail(400, `Ask for between 1 and ${cfg.maxBatch} tokens per purchase.`, "invalid_request", { max_batch: cfg.maxBatch });
  const key = await issuer.issuingKey(input.tokenKeyId);
  const modulus = issuer.modulus(key);
  const seen = new Set<string>();
  for (const [i, b] of input.blinded.entries()) {
    if (!isValidBlindedMsg(b, modulus)) fail(400, `blinded_msgs[${i}] is not a valid blinded message for this key (256 bytes, below the modulus).`, "invalid_blinded_message");
    const h = hex(b);
    if (seen.has(h)) fail(400, `blinded_msgs[${i}] repeats an earlier message in this batch.`, "invalid_blinded_message");
    seen.add(h);
  }

  const rl = await ctx.limiter.take(`blind:buy:${caller.keyHash}`, 1, cfg.purchaseRpm, 60_000);
  if (!rl.ok)
    fail(429, `Rate limit exceeded (${cfg.purchaseRpm} purchases/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: rl.retryAfterMs }, { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const cost = BigInt(count) * keyValue(key);
  const dayCap = BigInt(Math.round(cfg.maxUsdPerDay * 1e6)) * 1_000_000n; // pico-USD
  if (cost > dayCap) fail(400, `A purchase may not exceed the daily cap of $${cfg.maxUsdPerDay}.`, "purchase_cap", { cost_usd: picoToUsdString(cost), daily_cap_usd: cfg.maxUsdPerDay });

  // Identity of this purchase for idempotency: account, key and the exact set of blinded messages.
  const ref = sha256([caller.accountId, key.keyId, ...input.blinded.map(hex)].join("|"));
  let holdId = "";
  let replayed = false;
  for (let attempt = 0; attempt < 3 && !holdId; attempt++) {
    const id = `blind-${ref.slice(0, 40)}-${attempt}`;
    const [h] = await ctx.db.select({ status: holds.status, result: holds.result }).from(holds).where(eq(holds.id, id));
    if (!h) holdId = id;
    else if (h.status === "settled") {
      // Paid means charged in full: a hold that closed short was returned (chargePurchase) and signs nothing.
      if (chargedBy(h.result) !== cost) continue;
      holdId = id;
      replayed = true;
    } else if (h.status === "held") fail(409, "This purchase is already being processed.", "purchase_in_progress");
    // released: the earlier attempt never charged; try the next id
  }
  if (!holdId) fail(409, "This purchase could not be started; change the blinded messages and try again.", "purchase_in_progress");

  const description = `Blind tokens: ${count} x ${key.denomination} units (epoch ${key.epoch})`;
  if (!replayed) {
    await reserve(ctx.db, { id: holdId, accountId: caller.accountId, keyHash: caller.keyHash, amount: cost, kind: "blind_purchase", ttlMs: 60_000 });
    // Rolling-day cap on what one account converts into tokens. Open purchase holds count (this one included),
    // so concurrent purchases can only make the check stricter, never let the total through.
    const since = new Date(Date.now() - DAY_MS);
    const [settledRow] = await ctx.db
      .select({ v: sql<string>`coalesce(sum(-${ledger.amount}), 0)` })
      .from(ledger)
      .where(and(eq(ledger.accountId, caller.accountId), eq(ledger.kind, "blind_purchase"), gt(ledger.createdAt, since)));
    const [heldRow] = await ctx.db
      .select({ v: sql<string>`coalesce(sum(${holds.amount}), 0)` })
      .from(holds)
      .where(and(eq(holds.accountId, caller.accountId), eq(holds.kind, "blind_purchase"), eq(holds.status, "held")));
    if (BigInt(settledRow.v) + BigInt(heldRow.v) > dayCap) {
      await release(ctx.db, holdId);
      fail(429, `Daily purchase cap of $${cfg.maxUsdPerDay} reached for this account.`, "purchase_cap", { daily_cap_usd: cfg.maxUsdPerDay });
    }
    await chargePurchase(ctx, { id: holdId, accountId: caller.accountId, keyHash: caller.keyHash }, cost, description);
    await ctx.db.update(blindKeys).set({ issued: sql`${blindKeys.issued} + ${count}` }).where(eq(blindKeys.keyId, key.keyId));
  }
  // The pool is funded from the purchase, idempotently by hold id; a replay repairs a credit a crash skipped.
  await ensurePool(ctx);
  await post(ctx.db, { accountId: BLIND_POOL, amount: cost, kind: "blind_purchase", ref: `blind:pool:${holdId}`, description });

  let signatures: Uint8Array[];
  try {
    const signer = await issuer.signer(key);
    signatures = input.blinded.map((b) => signer.blindSign(b));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    log.error("blind signing failed after charge; the same request can be replayed", { error: (e as Error).message, key: key.keyId });
    fail(500, "Signing failed after the purchase was charged. Send the same request again to receive the signatures without being charged twice.", "internal");
  }
  return { key, count, cost, signatures, replayed };
}
