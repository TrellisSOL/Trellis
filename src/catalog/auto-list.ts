import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { modelsLane } from "../db/schema.ts";
import { openListingWindow } from "../holders/early-access.ts";
import { fail } from "../lib/errors.ts";
import { log, uid } from "../lib/util.ts";
import { assertNotSanctioned } from "../network/sanctions.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { runCanaryFor } from "../services/canaries.ts";
import { recordRoyaltyRecipient, royaltyBps } from "../services/creators.ts";
import { CAPABILITY_SET } from "../services/dayzero-sets.ts";
import { catalogListings } from "./auto-list-schema.ts";
import type { Candidate } from "./catalog.ts";
import { decideListing } from "./licences.ts";

// catalog-svc auto-listing (docs/Trellis_Backend.md §2): a community fine-tune is listed within 24 hours of release
// once it passes the licence rule (licences.ts), an evaluation and the canary run, with the creator share routed to
// the uploader's claimed wallet and the holder early-access window opened.
//
// A submitted model is held back from the moment it is submitted: its models_lane row says `candidate`, which the
// router's lane rule (router/lane.ts) already refuses to serve. Listing flips that row to `servable`. Nothing here
// decides routing: a fine-tune that removes safety layers under a permissive licence is listed as the restricted
// variant `abliterated`, which routing serves only on attested hosts with the classifier, as for any such model.
//
//   submitted     the licence rule said "list"; waiting for an endpoint, the evaluation and the canaries
//   needs_review  a vendor licence: an operator must approve the licence check first
//   approved      the operator approved; evaluated like a submitted one
//   listed        servable, window opened, creator share recorded
//   blocked       unknown licence, or a safety-removed Gemma/Llama derivative: never listed, and approval is refused

export type ListingRow = typeof catalogListings.$inferSelect;
const HOUR_MS = 3_600_000;

export const candidateInput = z.strictObject({
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/, "must be a lower-case author/slug").max(200),
  base_model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an owner/repo id").max(200).optional(),
  hf_repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an owner/repo id").max(200).optional(),
  licence: z.string().trim().min(1).max(64).optional(),
  weights_sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lower-case hex characters"),
  creator_wallet: z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, "must be a wallet address").optional(),
  removes_safety_layers: z.boolean().optional(),
  released_at: z.iso.datetime({ offset: true }).optional(),
});
export type CandidateInput = z.infer<typeof candidateInput>;

export const listingJson = (r: ListingRow, now = Date.now()) => ({
  id: r.id,
  model: r.modelId,
  base_model: r.baseModel,
  hugging_face_id: r.hfRepo,
  licence: { declared: r.declaredLicence, applied: r.licence, family: r.licenceFamily, acceptable_use: r.acceptableUse },
  weights_sha256: r.weightsDigest.replace(/^sha256:/, ""),
  creator_wallet: r.creatorWallet,
  removes_safety_layers: r.removesSafety,
  decision: r.decision,
  reasons: r.reasons,
  status: r.status,
  approved_by: r.approvedBy,
  approved_at: r.approvedAt?.toISOString() ?? null,
  evaluation: r.evalScore == null && r.canaryAccuracy == null ? null : { provider: r.providerId, score: r.evalScore, canary_accuracy: r.canaryAccuracy, canary_quant_match: r.canaryQuantMatch },
  attempts: r.attempts,
  waiting_on: r.status === "listed" || r.status === "blocked" ? null : r.status === "needs_review" ? "licence_review" : (r.fault ?? "evaluation"),
  released_at: r.releasedAt.toISOString(),
  due_at: r.dueAt.toISOString(),
  listed_at: r.listedAt?.toISOString() ?? null,
  /** Whether the 24-hour target was met (listed), or can still be met (not listed yet). */
  within_target: r.listedAt ? r.listedAt.getTime() <= r.dueAt.getTime() : r.status === "blocked" ? null : now <= r.dueAt.getTime(),
});

/** Hold a model back: a models_lane row that says candidate. An existing declaration is left as an operator wrote it. */
async function holdBack(ctx: Pick<Ctx, "db">, r: Pick<ListingRow, "modelId" | "baseModel" | "licence" | "declaredLicence" | "weightsDigest" | "hfRepo" | "removesSafety">) {
  await ctx.db
    .insert(modelsLane)
    .values({ modelId: r.modelId, variant: r.removesSafety ? "abliterated" : "mainstream", status: "candidate", baseModel: r.baseModel, license: r.licence ?? r.declaredLicence, weightsSource: r.hfRepo ? `huggingface:${r.hfRepo}` : null, weightsDigest: r.weightsDigest, creatorHandle: r.hfRepo?.split("/")[0] ?? null })
    .onConflictDoNothing();
}

/** Submit a candidate: apply the licence rule, screen the creator wallet, record it and hold the model back. */
export async function submitCandidate(ctx: Ctx, input: CandidateInput, now = new Date()) {
  const d = decideListing({ model: input.model, baseModel: input.base_model ?? null, licence: input.licence ?? null, removesSafetyLayers: input.removes_safety_layers });
  // The creator share is a payout: its address is screened at registration (§8), as every payout address is.
  if (input.creator_wallet) await assertNotSanctioned(ctx, input.creator_wallet);
  const [existing] = await ctx.db.select().from(catalogListings).where(eq(catalogListings.modelId, input.model));
  if (existing?.status === "listed") fail(409, `${input.model} is already listed.`, "already_listed");
  const releasedAt = input.released_at ? new Date(input.released_at) : (existing?.releasedAt ?? now);
  if (releasedAt.getTime() > now.getTime() + 60_000) fail(400, "`released_at` is in the future.", "invalid_request");
  const values = {
    modelId: input.model,
    baseModel: input.base_model ?? null,
    hfRepo: input.hf_repo ?? null,
    declaredLicence: input.licence ?? null,
    licence: d.licence,
    licenceFamily: d.family,
    weightsDigest: `sha256:${input.weights_sha256}`,
    creatorWallet: input.creator_wallet ?? null,
    removesSafety: d.removesSafetyLayers,
    decision: d.decision,
    reasons: d.reasons,
    acceptableUse: d.acceptableUse,
    status: d.decision === "list" ? "submitted" : d.decision,
    approvedBy: null,
    approvedAt: null,
    fault: null,
    releasedAt,
    dueAt: new Date(releasedAt.getTime() + ctx.cfg.autoList.targetHours * HOUR_MS),
    updatedAt: now,
  };
  const [row] = existing
    ? await ctx.db.update(catalogListings).set(values).where(eq(catalogListings.id, existing.id)).returning()
    : await ctx.db.insert(catalogListings).values({ id: uid("cl_"), ...values }).returning();
  await holdBack(ctx, row);
  await ctx.catalog.refresh();
  return listingJson(row);
}

export async function listCandidates(ctx: Pick<Ctx, "db">, status?: string) {
  const rows = await ctx.db.select().from(catalogListings).where(status ? eq(catalogListings.status, status) : undefined).orderBy(asc(catalogListings.dueAt)).limit(500);
  return rows.map((r) => listingJson(r));
}

async function listing(ctx: Pick<Ctx, "db">, id: string) {
  const [row] = await ctx.db.select().from(catalogListings).where(eq(catalogListings.id, id));
  if (!row) fail(404, "No such listing candidate.", "not_found");
  return row;
}

/** An operator's licence check of a `needs_review` candidate. A blocked candidate cannot be approved. */
export async function approveCandidate(ctx: Ctx, id: string, by = "operator", now = new Date()) {
  const row = await listing(ctx, id);
  if (row.status === "blocked") fail(409, `This candidate is blocked and cannot be approved: ${row.reasons.join("; ") || "licence rule"}.`, "listing_blocked");
  if (row.status !== "needs_review") fail(409, `Only a candidate waiting for a licence check can be approved; this one is ${row.status}.`, "invalid_state");
  // The rule is applied again at approval, so a row written before a rule changed cannot slip through.
  const d = decideListing({ model: row.modelId, baseModel: row.baseModel, licence: row.declaredLicence, removesSafetyLayers: row.removesSafety });
  if (d.decision === "blocked") {
    await ctx.db.update(catalogListings).set({ status: "blocked", decision: "blocked", reasons: d.reasons, updatedAt: now }).where(eq(catalogListings.id, id));
    fail(409, `This candidate is blocked and cannot be approved: ${d.reasons.join("; ")}.`, "listing_blocked");
  }
  const [updated] = await ctx.db.update(catalogListings).set({ status: "approved", approvedBy: by.slice(0, 64), approvedAt: now, acceptableUse: d.acceptableUse, updatedAt: now }).where(and(eq(catalogListings.id, id), eq(catalogListings.status, "needs_review"))).returning();
  return listingJson(updated ?? row);
}

// ---- evaluation and listing -----------------------------------------------------------------------------------------

export type EvalResult = { passed: boolean; score: number | null };
export type AutoListDeps = {
  /** The evaluation of a candidate endpoint. Default: the router's exact-check capability set, scored against AUTOLIST_MIN_EVAL_SCORE. */
  evaluate?: (row: ListingRow, offer: Candidate) => Promise<EvalResult>;
  /** The canary run for the endpoint. Default: the router's own (services/canaries.ts runCanaryFor). */
  canary?: (offer: Candidate) => Promise<{ accuracy: number | null; quantMatch: boolean | null }>;
};

/** The default evaluation: the fixed exact-check prompts, sent straight to the candidate endpoint. Unanswered counts as wrong. */
export function capabilityEval(ctx: Ctx): NonNullable<AutoListDeps["evaluate"]> {
  return async (_row, offer) => {
    let correct = 0;
    for (const item of CAPABILITY_SET) {
      const r = await callUpstream({
        health: ctx.health,
        appSecret: ctx.cfg.appSecret,
        candidate: offer,
        path: "/chat/completions",
        body: upstreamBody(offer, { model: offer.modelId, messages: [{ role: "user", content: item.prompt }], temperature: 0, max_tokens: 120, seed: 7 }, false).body,
        stream: false,
        apiKey: providerKey(offer, ctx.cfg.appSecret),
        signal: AbortSignal.timeout(60_000),
        timeoutMs: 60_000,
        firstTokenTimeoutMs: 30_000,
        production: ctx.cfg.production,
      });
      const reply = r.ok && r.kind === "json" ? r.json?.choices?.[0]?.message?.content : null;
      if (typeof reply === "string" && item.check(reply)) correct++;
    }
    const score = correct / CAPABILITY_SET.length;
    return { passed: score >= ctx.cfg.autoList.minEvalScore, score };
  };
}

/** The endpoint a candidate is evaluated on: an offer for the model from a provider that is live or in shadow. */
function endpointFor(ctx: Pick<Ctx, "catalog">, modelId: string): Candidate | null {
  return ctx.catalog.offers(modelId).find((o) => ["live", "shadow"].includes(o.status) && ["live", "shadow"].includes(o.provider.status)) ?? null;
}

/**
 * Try to list one candidate: evaluation, then canaries, then (on a pass) servable, early-access window and creator
 * share. A candidate that is not ready stays where it is with `fault` saying what it waits on, and is tried again.
 */
export async function processCandidate(ctx: Ctx, id: string, deps: AutoListDeps = {}, now = new Date()) {
  const row = await listing(ctx, id);
  if (!["submitted", "approved"].includes(row.status)) fail(409, `This candidate is ${row.status}; only a submitted or approved one is evaluated.`, "invalid_state");
  await ctx.catalog.ensureFresh(0);
  const offer = endpointFor(ctx, row.modelId);
  const attempt = { attempts: row.attempts + 1, updatedAt: now };
  const wait = async (fault: string, more: Partial<ListingRow> = {}) => {
    const [r] = await ctx.db.update(catalogListings).set({ ...attempt, ...more, fault }).where(eq(catalogListings.id, id)).returning();
    return listingJson(r, now.getTime());
  };
  if (!offer) return wait("no_endpoint");

  const evaluated = await (deps.evaluate ?? capabilityEval(ctx))(row, offer);
  const scores = { providerId: offer.providerId, evalScore: evaluated.score == null ? null : Number(evaluated.score.toFixed(4)) };
  if (!evaluated.passed) return wait("eval_failed", scores);
  // The router's existing canary run: the exact-match set and, where the endpoint returns logprobs, the precision check.
  const canary = deps.canary
    ? await deps.canary(offer)
    : await runCanaryFor(ctx, offer).then((r) => ({ accuracy: r.accuracy as number | null, quantMatch: r.quantMatch as boolean | null }), () => ({ accuracy: null as number | null, quantMatch: null as boolean | null }));
  const canaryScores = { ...scores, canaryAccuracy: canary.accuracy == null ? null : Number(canary.accuracy.toFixed(4)), canaryQuantMatch: canary.quantMatch };
  if (canary.accuracy == null || canary.accuracy < ctx.cfg.autoList.minCanaryAccuracy || canary.quantMatch === false) return wait("canary_failed", canaryScores);

  // The creator share first: on chain when a royalty program is configured, then in the catalogue. A failure leaves the
  // model held back, so it is never served without its creator line.
  if (row.creatorWallet) {
    try {
      await assertNotSanctioned(ctx, row.creatorWallet);
      await recordRoyaltyRecipient(ctx, row.modelId, row.creatorWallet, royaltyBps(ctx));
    } catch (e) {
      log.warn("auto-list creator share not recorded", { model: row.modelId, reason: (e as Error).message.slice(0, 160) });
      return wait("share_failed", canaryScores);
    }
  }
  const lane = { variant: row.removesSafety ? "abliterated" : "mainstream", status: "servable", baseModel: row.baseModel, license: row.licence ?? row.declaredLicence, weightsSource: row.hfRepo ? `huggingface:${row.hfRepo}` : null, weightsDigest: row.weightsDigest, creatorHandle: row.hfRepo?.split("/")[0] ?? null, updatedAt: now };
  await ctx.db.insert(modelsLane).values({ modelId: row.modelId, ...lane }).onConflictDoUpdate({ target: modelsLane.modelId, set: lane });
  // Holders first: the window the registry opens for any newly listed model (src/holders/early-access.ts).
  await openListingWindow(ctx.db, row.modelId, ctx.cfg.holders.earlyAccessWindowHours, now);
  const [listed] = await ctx.db.update(catalogListings).set({ ...attempt, ...canaryScores, status: "listed", fault: null, listedAt: now }).where(eq(catalogListings.id, id)).returning();
  await ctx.catalog.refresh();
  log.info("model auto-listed", { model: row.modelId, within_target: now.getTime() <= row.dueAt.getTime() });
  return listingJson(listed, now.getTime());
}

/** The job: every candidate that is ready to be evaluated, soonest deadline first. */
export async function runAutoList(ctx: Ctx, deps: AutoListDeps = {}, now = new Date()) {
  const due = await ctx.db.select({ id: catalogListings.id }).from(catalogListings).where(inArray(catalogListings.status, ["submitted", "approved"])).orderBy(asc(catalogListings.dueAt)).limit(50);
  const out = { tried: 0, listed: 0, waiting: 0, failed: 0, overdue: 0 };
  for (const { id } of due) {
    out.tried++;
    try {
      const r = await processCandidate(ctx, id, deps, now);
      if (r.status === "listed") out.listed++;
      else out.waiting++;
      if (r.within_target === false) out.overdue++;
    } catch (e) {
      out.failed++;
      log.warn("auto-list attempt failed", { candidate: id, reason: (e as Error).message.slice(0, 160) });
    }
  }
  return out;
}

export function registerAutoListJob(ctx: Ctx) {
  if (!ctx.cfg.autoList.enabled) return;
  ctx.jobs.register("catalog-auto-list", ctx.cfg.autoList.intervalMs, () => runAutoList(ctx));
}
