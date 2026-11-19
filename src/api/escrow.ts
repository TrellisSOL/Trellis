import { withDepositCountdown } from "../solana/deposit-countdown.ts"; // B123
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { trlsPriceInfo, escrowDepositsFor, escrowEnabled, escrowInfo } from "../solana/escrow.ts";
import { requireKey } from "./auth.ts";

export function escrowRoutes(app: Hono, ctx: Ctx) {
  // Where to send Stock Tokens, which ones count, what one token is credited at right now, and how
  // long crediting takes (the chain's finality mode and how far that point trails the head).
  app.get("/api/v1/escrow", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: await escrowInfo(ctx) });
  });

  // What one $TRLS is credited at right now: the lowest of the router's own readings over its window, or the reason
  // there is no price at the moment (deposits then wait as `pending`, stage `awaiting_price`).
  app.get("/api/v1/escrow/trls/price", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: await trlsPriceInfo(ctx) });
  });

  // Deposits for the wallet behind this key. Only wallet sign-in keys have one. Status is one of
  // pending_finality | pending | credited | orphaned | reversed (see escrow_deposits in src/db/schema.ts); `stage`
  // says where it is on the way to a credit: confirming | awaiting_price | crediting | credited | orphaned | reversed.
  app.get("/api/v1/escrow/deposits", async (c) => {
    c.header("Cache-Control", "no-store"); // B123
    const key = await requireKey(ctx, c.req.header("authorization"));
    const wallet = key.accountId.startsWith("w_") ? key.accountId.slice(2) : null; // w_ + the base58 wallet (src/api/auth.ts)
    return c.json({
      data: {
        enabled: escrowEnabled(ctx),
        wallet,
        deposits: wallet ? await withDepositCountdown(ctx, await escrowDepositsFor(ctx, key.accountId)) : [],
        ...(wallet ? {} : { hint: "Stock deposits are credited to the sending wallet. Sign in with that wallet to use them." }),
      },
    });
  });
}
