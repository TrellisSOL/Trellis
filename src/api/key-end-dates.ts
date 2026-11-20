import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";

// Key end dates (update 16, `key-end-dates` in src/features.json). A key's `expires_at` was already stored and enforced
// (src/api/auth.ts refuses a key past it with 401 key_expired). With this update on, an end date that is set must be a
// real one, and the refusal says when the key ended and how to give it a new end date. With it off, nothing changes.

/** The furthest an end date may be set ahead: five years. */
export const KEY_END_MAX_MS = 5 * 365.25 * 86_400_000;

export const keyEndDatesOn = (ctx: Ctx) => ctx.cfg.updates["key-end-dates"] === true;

/**
 * An `expires_at` being set (null clears it, undefined leaves it) is at most five years ahead. A new key's end date must
 * be in the future: a key created already ended is a mistake. An existing key may be given a past end date, which ends
 * it at once (the refusal then names that time).
 */
export function assertKeyEndDate(ctx: Ctx, expiresAt: string | null | undefined, { creating }: { creating: boolean }, now = Date.now()) {
  if (!keyEndDatesOn(ctx) || expiresAt == null) return;
  const at = Date.parse(expiresAt);
  if (creating && !(at > now)) fail(400, "A new key's expires_at must be in the future. Leave it out for a key with no end date.", "invalid_request");
  if (at - now > KEY_END_MAX_MS) fail(400, "expires_at can be at most five years ahead.", "invalid_request");
}

/** The refusal of a key past its end date. With the update off it is the message the router always gave. */
export function refuseEndedKey(ctx: Ctx, expiresAt: Date): never {
  if (!keyEndDatesOn(ctx)) fail(401, "This API key has expired.", "key_expired");
  fail(401, `This API key ended at ${expiresAt.toISOString()}, the end date set for it. A key that manages it can give it a later end date (PATCH /api/v1/keys/:hash with expires_at), or create a new key.`, "key_expired", { expired_at: expiresAt.toISOString() });
}
