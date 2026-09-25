import { eq } from "drizzle-orm";
import type { HolderTier } from "../config.ts";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { ApiError } from "../lib/errors.ts";
import { modelEarlyAccess } from "./schema.ts";

// Early access (a $TRLS holder perk): a newly listed model has a window that ends at `early_access_until`. During the
// window a caller may use the model from `until - tier.early_access_hours`: higher tiers get in earlier, a caller with
// no tier when the window ends. The window is set when the model is first listed (listed_at + the longest
// early_access_hours of any tier, at most EARLY_ACCESS_WINDOW_HOURS) and an operator can set or clear it
// (PUT / DELETE /api/v1/admin/models/:author/:slug/early-access). It decides when a model may be used, never what it
// costs: everyone pays the host's price.

export type EarlyAccessWindow = { listedAt: Date; until: Date };

/** When a caller of `tier` (null: none) may use a model whose window ends at `until`. */
export const accessAt = (until: Date, tier: Pick<HolderTier, "earlyAccessHours"> | null | undefined) => new Date(until.getTime() - Math.max(0, tier?.earlyAccessHours ?? 0) * 3_600_000);

/** The window still running for `modelId` at `now`, or null (no window, or it has ended). */
export function activeWindow(ctx: Pick<Ctx, "catalog">, modelId: string, now = Date.now()): EarlyAccessWindow | null {
  const w = ctx.catalog.earlyAccess?.get(modelId); // a catalogue stand-in without windows has none
  return w && w.until.getTime() > now ? w : null;
}

/** The `early_access` field of a model in GET /api/v1/models, for a caller of `tier`; null when no window is running. */
export function earlyAccessJson(ctx: Pick<Ctx, "catalog">, modelId: string, tier: HolderTier | null, now = Date.now()) {
  const w = activeWindow(ctx, modelId, now);
  return w ? { until: w.until.toISOString(), your_access_at: accessAt(w.until, tier).toISOString() } : null;
}

export function earlyAccessError(modelId: string, until: Date, opensAt: Date, tier: HolderTier | null): ApiError {
  return new ApiError(
    403,
    `${modelId} is in early access. ${tier ? `Your tier (${tier.name}) may use it` : "It opens to you"} from ${opensAt.toISOString()}.`,
    "early_access",
    { model: modelId, opens_at: opensAt.toISOString(), early_access_until: until.toISOString(), tier: tier?.name ?? null },
    { "retry-after": String(Math.max(1, Math.ceil((opensAt.getTime() - Date.now()) / 1000))) },
  );
}

/**
 * The models of `resolved` the caller may use now. A model still closed to the caller is dropped (so a fallback model
 * can serve the request); when that leaves nothing, the 403 `early_access` for the first one is thrown. `tierOf` is
 * only called when a requested model has a running window, so a request for any other model reads no balance.
 */
export async function gateEarlyAccess<T extends { model: { id: string } }>(ctx: Pick<Ctx, "catalog">, resolved: T[], tierOf: () => Promise<HolderTier | null> | HolderTier | null, now = Date.now()): Promise<T[]> {
  if (!ctx.catalog.earlyAccess?.size || !resolved.some((r) => activeWindow(ctx, r.model.id, now))) return resolved;
  const tier = await tierOf();
  let refusal: ApiError | null = null;
  const open = resolved.filter((r) => {
    const w = activeWindow(ctx, r.model.id, now);
    if (!w) return true;
    const at = accessAt(w.until, tier);
    if (at.getTime() <= now) return true;
    refusal ??= earlyAccessError(r.model.id, w.until, at, tier);
    return false;
  });
  if (!open.length && refusal) throw refusal;
  return open;
}

/** Open (or move) a model's window. */
export async function setEarlyAccess(db: Pick<Db, "insert">, modelId: string, until: Date, source: "listing" | "operator", listedAt = new Date()) {
  await db
    .insert(modelEarlyAccess)
    .values({ modelId, listedAt, until, source, updatedAt: new Date() })
    .onConflictDoUpdate({ target: modelEarlyAccess.modelId, set: { until, source, updatedAt: new Date() } });
}

export async function clearEarlyAccess(db: Pick<Db, "delete">, modelId: string) {
  await db.delete(modelEarlyAccess).where(eq(modelEarlyAccess.modelId, modelId));
}

/**
 * A model that was just listed for the first time: its window runs for `windowHours` from now (nothing when 0, which
 * is the case while no tier has early_access_hours). An existing row is left alone, so a model an operator cleared and
 * a provider lists again is not closed a second time.
 */
export async function openListingWindow(db: Pick<Db, "insert">, modelId: string, windowHours: number, now = new Date()) {
  if (!(windowHours > 0)) return;
  await db
    .insert(modelEarlyAccess)
    .values({ modelId, listedAt: now, until: new Date(now.getTime() + windowHours * 3_600_000), source: "listing", updatedAt: now })
    .onConflictDoNothing();
}
