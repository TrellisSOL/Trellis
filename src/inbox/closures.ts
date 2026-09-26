// Account-closure notices (docs/Trellis_Backend.md §5.1; security re-review RR-05): whoever holds a key can ask for its
// credits to be closed, so the account is told when that happens. The refund can only return to the wallets that funded
// the key; the notice says so, and says what to do when the closure was not the owner's (revoke the key: its closure is
// then held until an owner releases it).
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { sha256 } from "../lib/util.ts";
import { creditClosures } from "../solana/credits-schema.ts";

export const closureTitle = (c: { status: string; reason: string | null; payableAt: Date; held: boolean }) =>
  c.held ? "A closure of a key's credits is on hold because the key is disabled. Release it to refund the wallets that funded the key, or leave the balance in the account."
  : c.status === "cancelled" ? "A closure of a key's credits was cancelled; the key and its balance are back."
  : c.status === "paid" ? "A key's credits were closed and refunded to the wallets that funded it."
  : `A key's credits are being closed. After ${c.payableAt.toISOString().slice(0, 10)} what is left is refunded to the wallets that funded the key. Not you? Disable the key: its closure is then held.`;

export async function closureItems(ctx: Ctx, accountId: string, since?: string) {
  const after = Math.max(Date.now() - 90 * 86_400_000, since ? Date.parse(since) : 0);
  const rows = await ctx.db
    .select({ id: creditClosures.id, status: creditClosures.status, reason: creditClosures.reason, payableAt: creditClosures.payableAt, requestedAt: creditClosures.requestedAt, releasedAt: creditClosures.releasedAt, disabled: keys.disabled, label: keys.name })
    .from(creditClosures)
    .innerJoin(keys, eq(keys.keyHash, creditClosures.keyHash))
    .where(and(eq(keys.accountId, accountId), inArray(creditClosures.status, ["registered", "paid", "cancelled"]), gt(creditClosures.requestedAt, new Date(after))))
    .orderBy(desc(creditClosures.requestedAt), desc(creditClosures.id))
    .limit(101);
  return rows.map((r) => {
    const held = r.status === "registered" && r.disabled && !r.releasedAt;
    // The id is a digest: no closure id or key hash leaves the router in an inbox item.
    return { id: `closure:${sha256(r.id).slice(0, 24)}`, at: r.requestedAt.toISOString(), kind: "credits_closure", title: closureTitle({ status: r.status, reason: r.reason, payableAt: r.payableAt, held }), status: held ? "held" : r.status, key_label: r.label, expires_at: r.payableAt.toISOString(), href: "/dashboard/#payments", unread: true };
  });
}
