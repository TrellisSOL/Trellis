import type { Context, Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { requireKey, requireRole } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { TOOL_CONTENT_TYPES } from "./config.ts";
import { callPaidTool, isTraceId, toolCallJson, type ChatFn } from "./call.ts";
import { createListing, facilitatorListings, listingDetail, listingJson, removeListing, searchTools } from "./catalog.ts";
import { toolCalls, toolListings } from "./schema.ts";
import { feedbackBody } from "../identity/feedback.ts";
import { giveSubjectFeedback } from "../identity/subject-feedback.ts";
import { confirmSubjectRegistration, requestSubjectRegistration, subjectIdentityJson, subjectState, toolConfirmBody, toolRegisterBody, toolSubject } from "../identity/subjects.ts";

// v6 T routes (all 404 unless TOOLS_MARKET_ENABLED):
//   POST   /api/v1/tools/call                 key: { resource, method?, body?, max_price, then? } -> pay an x402 tool from the balance
//   GET    /api/v1/tools                      public catalog: tool listings with canary state (?include_delisted=true), then facilitator sellers
//   GET    /api/v1/tools/search               ?q=&limit=&public=true: listings, facilitator sellers and the public catalog
//   GET    /api/v1/tools/calls                key: this key's paid tool calls, newest first, with receipts
//   GET    /api/v1/tools/calls/:id            key: one call
//   POST   /api/v1/tools/listings             owner/admin key: list an x402 resource with a known-answer canary
//   DELETE /api/v1/tools/listings/:id         the listing account: remove it
//   GET    /api/v1/tools/:id                  one listing and its last ten canary runs
// A listing's identity in the Solana Agent Registry (src/identity/subjects.ts; 404 unless AGENT_IDENTITY_ENABLED):
//   GET    /api/v1/tools/listings/:id/identity            public: registration status, registry, agent id, registration URL
//   POST   /api/v1/tools/listings/:id/identity/register   owner/admin key of the listing account: { owner_wallet? } -> the
//                                                         registration transaction for the owner's wallet; registrar mode: queue
//   POST   /api/v1/tools/listings/:id/identity/confirm    owner/admin key of the listing account: { tx_hash }
//   POST   /api/v1/tools/listings/:id/feedback            key (PAID_FEEDBACK_ENABLED): needs a tool.call receipt the reviewer paid to this listing

const LISTING_ID = /^tl_[0-9a-f]{24}$/;
const CALL_ID = /^tc_[0-9a-f]{24}$/;

/** The /api/v1/status section: whether the market is on and whether a paid call can actually be made. */
export function toolsStatus(ctx: Ctx) {
  const t = ctx.cfg.tools;
  return {
    enabled: t.enabled,
    buyer_configured: !!t.buyer,
    ready: t.enabled && !!t.buyer,
    take_bps: t.takeBps,
    max_price_usd: t.maxPriceUsd,
    daily_limit_usd: t.dailyLimitUsd,
    max_response_bytes: t.maxResponseBytes,
    content_types: [...TOOL_CONTENT_TYPES, "application/*+json"],
    x402_versions: [1, 2],
    pays: { scheme: "exact", asset: "USDC", networks: [...new Set([ctx.cfg.x402.network, ctx.cfg.chain.network])] },
    public_catalog: !!t.publicCatalogUrl,
    canary_interval_ms: t.canaryIntervalMs,
  };
}

export function toolsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.tools.enabled) return;
  // The optional model step reuses the router's own chat route in-process with the caller's key: same billing, rulebook and receipt.
  const chatWith = (authorization: string): ChatFn => async (body, headers = {}) => {
    const res = await app.request("/api/v1/chat/completions", { method: "POST", headers: { authorization, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  app.post("/api/v1/tools/call", async (c) => {
    const authorization = c.req.header("authorization");
    const key = await requireKey(ctx, authorization);
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    // A caller's W3C traceparent names the trace both receipts join; otherwise the call makes one.
    const parent = c.req.header("traceparent")?.split("-")[1];
    const data = await callPaidTool(ctx, key, await readJson(c), { chat: chatWith(authorization!), ...(isTraceId(parent) ? { traceId: parent } : {}) });
    c.header("x-trellis-tool-call", data.id);
    c.header("x-trellis-trace-id", data.trace_id);
    c.header("cache-control", "no-store");
    return c.json({ data });
  });

  app.get("/api/v1/tools", async (c) => {
    const all = c.req.query("include_delisted") === "true";
    const rows = await ctx.db.select().from(toolListings).orderBy(desc(toolListings.createdAt)).limit(500);
    const local = rows.filter((r) => r.status === "listed" || (all && r.status === "delisted")).map(listingJson);
    // Sellers listed through the facilitator (join point in catalog.ts), unless the same address is a tool listing.
    const known = new Set(rows.map((r) => r.resource));
    const data = [...local, ...(await facilitatorListings(ctx)).filter((f) => !known.has(f.resource))];
    c.header("cache-control", "public, max-age=30");
    return c.json({ data, call: "/api/v1/tools/call", status: toolsStatus(ctx) });
  });

  app.get("/api/v1/tools/search", async (c) => {
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 25)) || 25));
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    c.header("cache-control", "public, max-age=30");
    return c.json(await searchTools(ctx, q, limit, c.req.query("public") !== "false"));
  });

  app.get("/api/v1/tools/calls", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rows = await ctx.db.select().from(toolCalls).where(eq(toolCalls.keyHash, key.keyHash)).orderBy(desc(toolCalls.createdAt)).limit(50);
    c.header("cache-control", "no-store");
    return c.json({ data: rows.map(toolCallJson) });
  });

  app.get("/api/v1/tools/calls/:id", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const id = c.req.param("id");
    if (!CALL_ID.test(id)) fail(404, "No such tool call.", "not_found");
    const [row] = await ctx.db.select().from(toolCalls).where(and(eq(toolCalls.id, id), eq(toolCalls.keyHash, key.keyHash)));
    if (!row) fail(404, "No such tool call.", "not_found");
    c.header("cache-control", "no-store");
    return c.json({ data: toolCallJson(row!) });
  });

  app.post("/api/v1/tools/listings", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin"]);
    if (!(await ctx.limiter.take(`tools-list:${key.accountId}`, 1, 20, 3_600_000)).ok) fail(429, "Too many tool listings from this account. Try again within the hour.", "rate_limited");
    const row = await createListing(ctx, key, await readJson(c));
    return c.json({ data: listingJson(row) }, 201);
  });

  app.delete("/api/v1/tools/listings/:id", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin"]);
    const id = c.req.param("id");
    if (!LISTING_ID.test(id)) fail(404, "No such tool listing.", "not_found");
    const row = await removeListing(ctx, key, id);
    return c.json({ data: { id: row.id, status: row.status } });
  });

  // ---- a listing's registry identity and paid feedback about it --------------------------------------------------
  const identityOn = () => { if (!ctx.cfg.identity.enabled) fail(404, "Not found.", "not_found"); };
  const listingSubject = async (id: string) => {
    const subject = await toolSubject(ctx, id);
    if (!subject) fail(404, "No such tool listing.", "not_found");
    return subject;
  };
  // The same checks as removing a listing: an owner or admin key of the account that listed it.
  const ownListing = async (c: Context) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin"]);
    const subject = await listingSubject(c.req.param("id")!);
    if (subject.accountId !== key.accountId) fail(403, "Only the account that listed this tool can manage its identity.", "forbidden");
    // Counted with the account's listing requests: twenty an hour.
    if (!(await ctx.limiter.take(`tools-list:${key.accountId}`, 1, 20, 3_600_000)).ok) fail(429, "Too many tool listing requests from this account. Try again within the hour.", "rate_limited");
    return subject;
  };

  app.get("/api/v1/tools/listings/:id/identity", async (c) => {
    identityOn();
    const subject = await listingSubject(c.req.param("id"));
    c.header("cache-control", "no-store");
    return c.json({ data: subjectIdentityJson(ctx, subject, await subjectState(ctx.db, "tool", subject.ref)) });
  });

  app.post("/api/v1/tools/listings/:id/identity/register", async (c) => {
    identityOn();
    c.header("cache-control", "no-store");
    const subject = await ownListing(c);
    const { owner_wallet } = toolRegisterBody.parse(await readJson(c));
    return c.json({ data: await requestSubjectRegistration(ctx, subject, owner_wallet) });
  });

  app.post("/api/v1/tools/listings/:id/identity/confirm", async (c) => {
    identityOn();
    c.header("cache-control", "no-store");
    const subject = await ownListing(c);
    const { tx_hash } = toolConfirmBody.parse(await readJson(c));
    return c.json({ data: await confirmSubjectRegistration(ctx, subject, tx_hash) });
  });

  app.post("/api/v1/tools/listings/:id/feedback", async (c) => {
    if (!ctx.cfg.identity.paidFeedback) fail(404, "Not found.", "not_found");
    c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const limit = await ctx.limiter.take(`agent-feedback:${reviewer.accountId}`, 1, 30, 60_000);
    if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many feedback requests.", "rate_limited"); }
    const subject = await listingSubject(c.req.param("id"));
    return c.json({ data: await giveSubjectFeedback(ctx, reviewer, subject, feedbackBody.parse(await readJson(c))) }, 201);
  });

  app.get("/api/v1/tools/:id", async (c) => {
    const id = c.req.param("id");
    if (!LISTING_ID.test(id)) fail(404, "No such tool listing.", "not_found");
    c.header("cache-control", "public, max-age=30");
    return c.json({ data: await listingDetail(ctx, id) });
  });
}
