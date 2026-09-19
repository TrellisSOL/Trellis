import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { agentSessions } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { accountDeposits, watchDeposit } from "../solana/deposit-progress.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";
import { isWalletSignature, WALLET_SIGNATURE_RE } from "../lib/wallet-sig.ts";

// `tx_hash` is the base58 Solana transaction signature (64 bytes), kept exactly as given: base58 is case-sensitive.
const watchBody = z.strictObject({ tx_hash: z.string().regex(WALLET_SIGNATURE_RE).refine(isWalletSignature, "expected a base58 transaction signature (64 bytes)"), lane: z.enum(["escrow", "usdc"]) });
export const DEPOSIT_READS_PER_MIN = 30;
export function depositRoutes(app: Hono, ctx: Ctx) {
  const account = async (authorization: string | undefined) => {
    const key = await requireKey(ctx, authorization);
    if ((await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length) fail(403, "Session keys cannot read account deposits.", "forbidden");
    await requireRole(ctx, key, ["owner", "admin", "member", "viewer"]);
    return key.accountId;
  };
  app.get("/api/v1/credits/deposits", async c => {
    const id = await account(c.req.header("authorization"));
    // R4-19: the dashboard polls every 5 s (12 a minute); an account may read 30 times a minute.
    const lim = await ctx.limiter.take(`deposits-read:${id}`, 1, DEPOSIT_READS_PER_MIN, 60_000);
    if (!lim.ok) fail(429, "Too many deposit status reads. The dashboard polls every 5 seconds; slow down.", "rate_limited", undefined, { "retry-after": String(Math.max(1, Math.ceil(lim.retryAfterMs / 1000))) });
    c.header("Cache-Control", "no-store");
    // The dashboard (web/lib/deposit-progress.js) reads data.deposits; the stages are those of src/solana/deposit-progress.ts.
    return c.json({ data: { deposits: await accountDeposits(ctx, id) } });
  });
  app.post("/api/v1/credits/deposits", async c => {
    const id = await account(c.req.header("authorization"));
    const body = watchBody.parse(await readJson(c));
    if (!await watchDeposit(ctx, id, body.tx_hash, body.lane)) fail(429, "Already watching 20 submitted transactions. Check those before sending again.", "rate_limit");
    return c.json({ data: { tx_hash: body.tx_hash, stage: "submitted" } }, 202);
  });
}
