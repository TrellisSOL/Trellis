// Credits expiry notices (docs/Trellis_Backend.md §5.1): the expiry job (src/services/settlement.ts expireCredits) writes
// one marker per on-chain notice_expiry; the inbox shows it under account-wide access, like a deposit notice.
import { and, desc, gt, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { expiryNoticePrefix, type ExpiryNotice } from "../holders/credits-expiry.ts";
import { sha256 } from "../lib/util.ts";

export const creditsExpiryTitle = (n: Pick<ExpiryNotice, "sweepAfter">) => `Unused credits expire after ${n.sweepAfter.slice(0, 10)}. Add funds before then to keep them.`;

export async function creditsExpiryItems(ctx: Ctx, accountId: string, since?: string) {
  if (!ctx.cfg.holders.creditsExpiryEnabled) return [];
  const after = Math.max(Date.now() - 90 * 86_400_000, since ? Date.parse(since) : 0);
  const rows = await ctx.db
    .select({ key: kv.key, value: kv.value, at: sql<string>`to_char(${kv.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(kv)
    .where(and(like(kv.key, `${expiryNoticePrefix(ctx)}%`), sql`${kv.value}->>'accountId' = ${accountId}`, gt(kv.updatedAt, new Date(after))))
    .orderBy(desc(kv.updatedAt), desc(kv.key))
    .limit(101);
  return rows.map((row) => {
    const n = row.value as ExpiryNotice;
    // The id is a digest of the marker's key: no key hash leaves the router.
    return { id: `credits-expiry:${sha256(row.key).slice(0, 24)}`, at: row.at, kind: "credits_expiry", title: creditsExpiryTitle(n), status: "notice", amount: n.amount, expires_at: n.sweepAfter, href: "/dashboard/#payments", unread: true };
  });
}
