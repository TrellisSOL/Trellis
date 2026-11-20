import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { explorerTx } from "../solana/deposit-progress.ts";
import { formatRaw } from "../solana/escrow.ts";
import { BURN_HISTORY, burnState } from "../solana/trls-burn.ts";
import { NOT_ENABLED } from "../surface/surface.ts";

// The $TRLS burn tracker (update 18, `burn-tracker` in src/features.json): what the trls-burn job has burned, read from
// its own record (src/solana/trls-burn.ts: the total, the burn in flight and a line per finalized burn), so anyone can
// follow the claim "$TRLS paid for inference is burned" to the transactions that did it.
//
//   GET /api/v1/trls/burns[?limit=1..500]   public: the total, the recent burns newest first with an explorer link,
//                                           and the burned total at the end of each UTC day that had a burn
//
// The record keeps a line for the last BURN_HISTORY burns; the total covers every burn. When older lines have been
// dropped, the series starts from what had been burned before the first line kept, and `history.complete` is false.

export const burnTrackerEnabled = (ctx: Ctx) => ctx.cfg.updates["burn-tracker"] === true;
const DEFAULT_LIMIT = 50;

type Line = { signature: string; amount: string; at: number };

/** The burned total at the end of each UTC day with a burn, oldest first, starting from `before` (raw units). */
export function burnSeries(lines: readonly Line[], before: bigint) {
  const days = new Map<string, bigint>();
  for (const l of [...lines].sort((a, b) => a.at - b.at)) {
    const day = new Date(l.at * 1000).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0n) + BigInt(l.amount));
  }
  let total = before;
  return [...days].map(([day, amount]) => { total += amount; return { day, amount, cumulative: total }; });
}

export async function burnTracker(ctx: Ctx, limit = DEFAULT_LIMIT) {
  const trls = ctx.cfg.trlsEscrow;
  if (!trls) return { enabled: false as const, note: "This router does not accept $TRLS, so nothing is burned here." };
  const state = await burnState(ctx, trls.address);
  const lines = state.txs.filter((l) => /^\d+$/.test(String(l.amount)) && typeof l.signature === "string" && Number.isFinite(l.at));
  const total = BigInt(state.burned);
  const kept = lines.reduce((sum, l) => sum + BigInt(l.amount), 0n);
  const before = total > kept ? total - kept : 0n;
  const fmt = (raw: bigint) => formatRaw(raw, trls.decimals);
  return {
    enabled: true as const,
    token: { address: trls.address, symbol: trls.symbol, decimals: trls.decimals },
    total_burned: fmt(total),
    total_burned_raw: total.toString(),
    burns_recorded: lines.length,
    pending: state.pending ? { tx: state.pending.signature, amount: fmt(BigInt(state.pending.amount)), explorer_url: explorerTx(ctx, state.pending.signature) } : null,
    burns: [...lines].sort((a, b) => b.at - a.at).slice(0, limit).map((l) => ({
      tx: l.signature, amount: fmt(BigInt(l.amount)), amount_raw: l.amount, at: l.at, time: new Date(l.at * 1000).toISOString(), explorer_url: explorerTx(ctx, l.signature),
    })),
    series: burnSeries(lines, before).map((p) => ({ day: p.day, amount: fmt(p.amount), cumulative: fmt(p.cumulative) })),
    history: { kept: BURN_HISTORY, complete: before === 0n },
    note: "Each burn is a token-program burn from the escrow wallet's own token account, written down when it is finalized. The total covers every burn; a line is kept for the most recent ones.",
  };
}

export function burnTrackerRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/trls/burns", async (c) => {
    if (!burnTrackerEnabled(ctx)) fail(404, "The $TRLS burn tracker is not enabled on this router.", NOT_ENABLED);
    const raw = c.req.query("limit");
    const limit = raw === undefined ? DEFAULT_LIMIT : Number(raw);
    if (!/^\d{1,4}$/.test(raw ?? "1") || !Number.isInteger(limit) || limit < 1 || limit > BURN_HISTORY) fail(400, `\`limit\` must be a whole number from 1 to ${BURN_HISTORY}.`, "invalid_request");
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: await burnTracker(ctx, limit) });
  });
}
