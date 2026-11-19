import type { Context, Hono } from "hono";
import { z } from "zod";
import { formatUnits, parseUnits } from "viem";
import type { Ctx } from "../context.ts";
import { MAX_PRESETS_PER_ACCOUNT } from "../routing/presets.ts";
import { MAX_ROUTES_PER_ACCOUNT } from "../routing/saved-routes.ts";
import { holdersStatus, lookupHolder, raisedLimit, scaleLimit, tierJson, walletOfAccount } from "../solana/tiers.ts";
import { clearEarlyAccess, setEarlyAccess } from "../holders/early-access.ts";
import { castVote, closePoll, createPoll, getPoll, listPolls, pollCreateSchema, pollJson, voteSchema } from "../holders/polls.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { fail } from "../lib/errors.ts";
import { requireKey, walletAuth } from "./auth.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";

// $TRLS holder perks: membership tiers that give access and priority, never money.
//   GET  /api/v1/holders/tiers                 public: the tier table
//   GET  /api/v1/holders/me                    key: the tier of the wallet behind this key, its perks, the next tier
//   GET  /api/v1/holders/polls[?status=]       public: advisory polls and their tallies
//   GET  /api/v1/holders/polls/:id             public: one poll's results
//   POST /api/v1/holders/polls/:id/vote        X-Wallet-Auth: one vote per wallet, weighted by the tier's vote_weight
//   POST /api/v1/admin/holders/polls           operator: open a poll
//   POST /api/v1/admin/holders/polls/:id/close operator: re-check balances and publish the final tally
//   PUT / DELETE /api/v1/admin/models/:author/:slug/early-access   operator: set or clear a model's early-access window
// Only wallet sign-in keys have a wallet; any other key gets the same /holders/me shape with a hint.

/** The limits a key of `tier` (null: none) runs under, as /holders/me shows them. 0 = no cap; null = unset. */
export function holderLimits(ctx: Ctx, key: { rpm: number | null; tpm: number | null }, tier: Parameters<typeof scaleLimit>[1]) {
  return {
    rpm: scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier),
    tpm: scaleLimit(key.tpm ?? null, tier, "tpm"),
    agent_keys: raisedLimit(ctx.cfg.holders.agentKeysMaxActive, tier?.maxAgentKeys),
    saved_routes: raisedLimit(MAX_ROUTES_PER_ACCOUNT, tier?.maxSavedRoutes),
    presets: raisedLimit(MAX_PRESETS_PER_ACCOUNT, tier?.maxSavedRoutes),
    batch_rows: raisedLimit(ctx.cfg.batch.maxLines, tier?.maxBatchRows),
  };
}

export function holdersRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/holders/tiers", (c) => {
    const s = holdersStatus(ctx);
    return c.json({ data: { enabled: s.enabled, token: s.token, tiers: s.tiers, cache_s: s.cache_s } });
  });

  const me = async (c: Context) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const h = ctx.cfg.holders;
    const wallet = walletOfAccount(key.accountId);
    const perksOf = (tier: Parameters<typeof scaleLimit>[1]) => ({
      limits: holderLimits(ctx, key, tier),
      sealed_priority: tier?.sealedPriority ?? 0,
      early_access_hours: tier?.earlyAccessHours ?? 0,
      vote_weight: tier?.voteWeight ?? 0,
      credits_never_expire: tier?.creditsNeverExpire ?? false,
      badge: tier?.badge ?? false,
    });
    const data = {
      enabled: h.enabled,
      token: h.token ? { address: h.token.address, symbol: h.token.symbol } : null,
      wallet,
      balance: null as string | null,
      balance_error: false,
      tier: null as ReturnType<typeof tierJson> | null,
      next_tier: null as { name: string; min: string; remaining: string } | null,
      perks: perksOf(null),
      ...(wallet ? {} : { hint: `Holder perks follow a wallet. Sign in with the wallet that holds $${h.token?.symbol ?? "TRLS"}.` }),
    };
    if (!wallet || !h.token) return c.json({ data });

    const look = await lookupHolder(ctx, wallet);
    if (look.error || look.balance == null || look.decimals == null) return c.json({ data: { ...data, balance_error: true } });
    const { balance, decimals, tier } = look;
    data.balance = formatUnits(balance, decimals);
    const next = h.enabled ? h.tiers.find((t) => parseUnits(t.min, decimals) > balance) : undefined;
    if (next) data.next_tier = { name: next.name, min: next.min, remaining: formatUnits(parseUnits(next.min, decimals) - balance, decimals) };
    if (tier) {
      data.tier = tierJson(tier);
      data.perks = perksOf(tier);
    }
    return c.json({ data });
  };
  // On a core router a wallet's own tier exists only with the holder-tiers update released (src/surface/updates.ts);
  // until then the path is answered like every other route that is not served there, 404 `not_enabled`.
  if (!ctx.surface?.core || ctx.cfg.updates?.holders === true) app.get("/api/v1/holders/me", me);
  app.get("/api/v1/holder", me); // the earlier path of the same document

  // ---- Advisory polls ---------------------------------------------------------------------------------------------
  app.get("/api/v1/holders/polls", async (c) => {
    const status = z.enum(["open", "closed"]).optional().parse(c.req.query("status"));
    const rows = await listPolls(ctx, status);
    return c.json({ data: await Promise.all(rows.map((p) => pollJson(ctx, p))) });
  });
  app.get("/api/v1/holders/polls/:id", async (c) => c.json({ data: await pollJson(ctx, await getPoll(ctx, c.req.param("id"))) }));

  app.post("/api/v1/holders/polls/:id/vote", async (c) => {
    c.header("Cache-Control", "no-store");
    const header = c.req.header("x-wallet-auth");
    if (!header) fail(401, "X-Wallet-Auth is required to vote.", "invalid_wallet_auth");
    const body = await readJson(c);
    // Body {poll_id, option}; the signature covers sha256 of its canonical JSON, as on the other wallet-signed routes.
    const v = voteSchema.parse(body);
    const pollId = c.req.param("id");
    if (v.poll_id !== pollId) fail(400, "`poll_id` must be the poll in the path.", "invalid_request");
    const auth = await walletAuth(ctx, header, sha256(canonicalJson(body)), c);
    const limit = await ctx.limiter.take(`holder-vote:${auth.wallet}`, 1, 10, 60_000);
    if (!limit.ok) fail(429, "Too many votes from this wallet. Try again within a minute.", "rate_limited");
    return c.json({ data: await castVote(ctx, pollId, auth.wallet, v.option) }, 201);
  });

  app.post("/api/v1/admin/holders/polls", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await pollJson(ctx, await createPoll(ctx, pollCreateSchema.parse(await readJson(c)))) }, 201);
  });
  app.post("/api/v1/admin/holders/polls/:id/close", async (c) => {
    requireOperator(ctx, c);
    return c.json({ data: await pollJson(ctx, await closePoll(ctx, c.req.param("id"))) });
  });

  // ---- Early access windows ---------------------------------------------------------------------------------------
  const modelOf = async (c: Context) => {
    await ctx.catalog.ensureFresh();
    const id = `${c.req.param("author")}/${c.req.param("slug")}`;
    const model = ctx.catalog.models.get(id);
    if (!model) fail(404, `Model ${id.slice(0, 200)} not found.`, "model_not_found");
    return model;
  };
  app.put("/api/v1/admin/models/:author/:slug/early-access", async (c) => {
    requireOperator(ctx, c);
    const model = await modelOf(c);
    const v = z.strictObject({ until: z.iso.datetime({ offset: true }) }).parse(await readJson(c));
    const until = new Date(v.until);
    if (until.getTime() <= Date.now()) fail(400, "`until` must be in the future. DELETE clears the window.", "invalid_request");
    if (until.getTime() - Date.now() > 720 * 3_600_000) fail(400, "`until` may be at most 30 days ahead.", "invalid_request");
    await setEarlyAccess(ctx.db, model.id, until, "operator");
    await ctx.catalog.refresh();
    return c.json({ data: { model: model.id, early_access_until: until.toISOString() } });
  });
  app.delete("/api/v1/admin/models/:author/:slug/early-access", async (c) => {
    requireOperator(ctx, c);
    const model = await modelOf(c);
    await clearEarlyAccess(ctx.db, model.id);
    await ctx.catalog.refresh();
    return c.json({ data: { model: model.id, early_access_until: null } });
  });
}
