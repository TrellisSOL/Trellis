import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import { modelsLane } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { safeEqual } from "../lib/util.ts";
import { LANE_STATUSES, VARIANTS, isRestricted, restrictedExclusion, type ModelLane } from "../router/lane.ts";
import { bearer } from "./auth.ts";
import { readJson, clientIp } from "./common.ts";
import { servedDisclosure } from "./disclosure.ts";

// The Lane: catalog variants.
//
//   PUT  /api/v1/models/{author}/{slug}/lane                 operator: declare a model's variant and provenance
//
// The day-zero pipeline (api/dayzero.ts) and creator royalty claims (api/creator-claims.ts) build on these records.

// ---- What a model's lane record looks like in the catalog ------------------------------------------------

/** The public lane fields of a model (see GET /api/v1/models). */
export function laneJson(ctx: Ctx, m: ModelRow) {
  const lane = ctx.catalog.laneOf(m);
  const row = ctx.catalog.lane.get(m.id);
  const weights = row && (row.weightsSource || row.weightsRevision || row.weightsDigest) ? { source: row.weightsSource, revision: row.weightsRevision, digest: row.weightsDigest } : null;
  return {
    variant: lane.variant,
    // declared: an operator recorded it; candidate: the model is a day-zero candidate's weights; inferred: the
    // name says the weights were modified and nobody has classified them; default: no record.
    variant_source: lane.source,
    license: row?.license ?? null,
    base_model: row?.baseModel ?? null,
    weights,
    creator_handle: row?.creatorHandle ?? null,
  };
}

/**
 * Whether a live offer may serve this model right now: a restricted variant only through an attested provider whose
 * attestation reports the classifier as enabled, and no model at all until it is approved for serving. The same
 * rule selectProviders applies to a request, so a listing never advertises an endpoint routing would refuse.
 */
export function offerEligible(ctx: Ctx, lane: ModelLane, o: Candidate): boolean {
  if (!lane.servable) return false;
  return !isRestricted(lane.variant) || restrictedExclusion(servedDisclosure(ctx, o).class, o.provider.classifierEnabled) === null;
}

// ---- Operator writes ----------------------------------------------------------------------------------------

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const text = (max: number) => z.string().trim().min(1).max(max).refine(noControl, "must not contain control characters");

/** PUT body for a model's lane record. */
export const laneInput = z
  .object({
    variant: z.enum(VARIANTS),
    // "candidate" holds a model back from every provider until it is written again as "servable".
    status: z.enum(LANE_STATUSES).default("servable"),
    base_model: text(200).nullish(),
    license: z.string().trim().min(1).max(64).regex(/^[\w.+-]+$/, "must be a license identifier such as apache-2.0").nullish(),
    weights: z
      .object({
        source: text(200).nullish(),
        revision: z.string().trim().regex(/^[0-9a-f]{7,64}$/i, "must be a commit id").nullish(),
        digest: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/i, "must be sha256:<64 hex>").nullish(),
      })
      .strict()
      .nullish(),
    creator_handle: z.string().trim().regex(/^[A-Za-z0-9][\w.-]{0,95}$/, "must be a Hugging Face handle").nullish(),
  })
  .strict();
export type LaneInput = z.infer<typeof laneInput>;

const MODEL_ID = /^[a-z0-9][\w.-]{0,95}\/[\w.:-]{1,128}$/;

/** Replace a model's lane record. The model need not be listed by any provider yet: classify it before it can be served. */
export async function writeModelLane(ctx: Ctx, rawId: string, input: LaneInput) {
  const id = rawId.toLowerCase();
  if (!MODEL_ID.test(id)) fail(400, "Model id must look like author/slug.", "invalid_request");
  if (isRestricted(input.variant) && (!input.license || !input.base_model))
    fail(400, `A ${input.variant} model needs a license and a base_model on record before it can be served.`, "invalid_request");
  const row = {
    modelId: id,
    variant: input.variant,
    status: input.status,
    baseModel: input.base_model ?? null,
    license: input.license?.toLowerCase() ?? null,
    weightsSource: input.weights?.source ?? null,
    weightsRevision: input.weights?.revision?.toLowerCase() ?? null,
    weightsDigest: input.weights?.digest?.toLowerCase() ?? null,
    creatorHandle: input.creator_handle ?? null,
    updatedAt: new Date(),
  };
  await ctx.db.insert(modelsLane).values(row).onConflictDoUpdate({ target: modelsLane.modelId, set: row });
  await ctx.catalog.refresh();
  return { model: id, variant: row.variant, status: row.status, base_model: row.baseModel, license: row.license, weights: input.weights ? { source: row.weightsSource, revision: row.weightsRevision, digest: row.weightsDigest } : null, creator_handle: row.creatorHandle };
}

/** The operator token a request carries. R5-14: in LAUNCH_SURFACE=core it is read from X-Admin-Token only, never from
 *  `Authorization: Bearer`, the header every API key travels in (and every key lookup reads). */
const operatorToken = (ctx: Ctx, c: Context) => c.req.header("x-admin-token") ?? (ctx.surface?.core ? undefined : bearer(c.req.header("authorization")));
const tokenMatches = (ctx: Ctx, c: Context) => {
  const token = operatorToken(ctx, c);
  return !!ctx.cfg.adminToken && !!token && safeEqual(token, ctx.cfg.adminToken);
};
// Round 4: the token alone is not enough on the core surface (and wherever ADMIN_ALLOWED_SOURCES is set): the caller
// must also be on a trusted loopback or at a listed source address, so a leaked token is not usable from anywhere.
const sourceChecked = (ctx: Ctx) => !!ctx.surface?.core || ctx.cfg.adminAllowedSources.length > 0;

export function requireOperator(ctx: Ctx, c: Context) {
  if (!tokenMatches(ctx, c)) fail(401, "Operator token required.", "unauthorized");
  if (sourceChecked(ctx) && !operatorSourceAllowed(ctx, c))
    fail(403, "Operator routes are answered only to an allow-listed source address (ADMIN_ALLOWED_SOURCES) or, where ADMIN_TRUST_LOOPBACK is on, to a loopback caller.", "operator_source_refused");
}

/** The same check as requireOperator, as a yes or no (for a route that shows an operator more than it shows anyone). */
export const isOperator = (ctx: Ctx, c: Context): boolean => tokenMatches(ctx, c) && (!sourceChecked(ctx) || operatorSourceAllowed(ctx, c));

const v4 = (ip: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip.split(".").reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0) : null);
/**
 * An address or IPv4 block of ADMIN_ALLOWED_SOURCES, or a trusted loopback caller. R5-14: "loopback" is a loopback socket
 * with no forwarding header, and that describes the operator only where no proxy reaches the router over loopback. Behind
 * a proxy on the same host that adds no forwarding header it describes every request, so it counts only where the
 * deployment says so (ADMIN_TRUST_LOOPBACK: off by default in production, on in the shipped compose file).
 */
export function operatorSourceAllowed(ctx: Ctx, c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-for") !== undefined || c.req.header("forwarded") !== undefined;
  const source = clientIp(c, ctx.cfg.trustProxy).toLowerCase().replace(/^::ffff:/, "");
  if (ctx.cfg.hardening.adminTrustLoopback && !forwarded && (source === "::1" || (v4(source) !== null && v4(source)! >>> 24 === 127))) return true;
  for (const entry of ctx.cfg.adminAllowedSources) {
    const [ip, bits] = entry.toLowerCase().split("/");
    if (bits === undefined) { if (ip === source) return true; continue; }
    const a = v4(source), b = v4(ip!);
    const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
    if (a !== null && b !== null && (a & mask) === (b & mask)) return true;
  }
  return false;
}

export function laneRoutes(app: Hono, ctx: Ctx) {
  app.put("/api/v1/models/:author/:slug/lane", async (c) => {
    requireOperator(ctx, c);
    const input = laneInput.parse(await readJson(c));
    return c.json({ data: await writeModelLane(ctx, `${c.req.param("author")}/${c.req.param("slug")}`, input) });
  });
}
