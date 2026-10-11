import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.ts";
import { loadHvxConfig } from "../services/hvx-config.ts";
import type { HvxPoint } from "../services/hvx.ts";
import { ChainService, type Role } from "./chain-service.ts";
import { capacityConfigSpec } from "./account-specs.ts";
import { capacityConfigPda, capacityIdl, publishHvxIx } from "./programs/capacity.ts";
import { withRetry } from "./rpc.ts";
import { verifyAccountInfo, type AccountSpec } from "./verified-account.ts";

// HVX on chain (docs/Trellis_Backend.md §5.6): trellis_capacity::publish_hvx(grade, hour, usd_per_mtoken, thin) writes one
// HvxFeed account per grade (PDA ["hvx", [grade]]), signed by the capacity config's hvx_authority. The feed holds the
// latest hour only and never goes backwards (the program refuses an hour below the one it holds); each publication also
// emits HvxPublished, so the hours published in order are on record in the transaction log. A public statistic: no
// instruction reads the feed and nothing settles against it.
//
// src/services/hvx.ts loads this module and calls publishHvx(point) for each completed hour that is not published yet.

/** Grades in the program's order: the index is the on-chain `grade: u8`. */
export const HVX_GRADES = ["G-S", "G-M", "G-L"] as const;
const HOUR_MS = 3_600_000;
const MICRO_USD = 1_000_000;

export const hvxFeedPda = (programId: PublicKey, grade: number) => PublicKey.findProgramAddressSync([Buffer.from("hvx"), Buffer.from([grade])], programId)[0];

export type HvxFeed = { grade: number; hour: bigint; usdPerMtoken: bigint; thin: boolean; updatedAt: bigint };
export function decodeHvxFeed(data: Uint8Array): HvxFeed | null {
  const r = capacityIdl.decodeAccount<{ grade: number; hour: bigint; usd_per_mtoken: bigint; thin: boolean; updated_at: bigint }>("HvxFeed", data);
  return r ? { grade: r.grade, hour: r.hour, usdPerMtoken: r.usd_per_mtoken, thin: r.thin, updatedAt: r.updated_at } : null;
}

/** A point as the feed takes it: the grade's index, the unix hour (unix seconds / 3600) and the price in micro-USD per
 *  1M output-equivalent tokens. Null for a point with no price (an hour with no qualifying receipt) or a malformed one. */
export function hvxFeedArgs(point: Pick<HvxPoint, "grade" | "hour" | "usd_per_mtoken" | "thin">): { grade: number; hour: bigint; usdPerMtoken: bigint; thin: boolean } | null {
  const grade = HVX_GRADES.indexOf(point.grade);
  const ms = Date.parse(point.hour);
  const usd = point.usd_per_mtoken;
  if (grade < 0 || !Number.isFinite(ms) || ms < 0 || ms % HOUR_MS !== 0) return null;
  if (usd === null || !Number.isFinite(usd) || usd < 0) return null;
  return { grade, hour: BigInt(ms / HOUR_MS), usdPerMtoken: BigInt(Math.round(usd * MICRO_USD)), thin: point.thin };
}

/** What publishing needs: the chain handle, the trellis_capacity program and the role whose key is its hvx_authority. */
/** The HvxFeed of a grade: owned by trellis_capacity, at ["hvx", grade]. */
export const hvxFeedSpec = (programId: PublicKey): AccountSpec<HvxFeed> => ({ name: "HvxFeed", owner: programId, decode: decodeHvxFeed, derive: (f) => hvxFeedPda(programId, f.grade) });

export type HvxPublishTarget = { chain: Pick<ChainService, "connection" | "send" | "roleAddress">; programId: PublicKey | string | undefined; role: Role; commitment?: "confirmed" | "finalized" };

// A caller without a router context (a script, the job's bare `publishHvx(point)`) publishes with the process's own
// configuration: HVX_PUBLISH_ONCHAIN must be on, and the chain handle is built once from the environment.
let own: HvxPublishTarget | null | undefined;
function ownTarget(): HvxPublishTarget | null {
  if (own !== undefined) return own;
  const hvx = loadHvxConfig();
  if (!hvx.publishOnchain) return (own = null);
  const cfg = loadConfig();
  return (own = { chain: new ChainService(cfg), programId: cfg.solana.programs.capacity, role: hvx.authorityRole, commitment: cfg.solana.commitment });
}

/**
 * Publish one completed hour's point to its grade's HvxFeed. Returns the transaction signature, or `tx: null` when nothing
 * was sent: publication is off, no capacity program or signing key is configured, the point has no price, or the feed
 * already carries a later hour (it cannot go back). The same hour may be published again; the feed then holds the newer
 * value. Throws when the capacity program is not initialised, when the role's key is not its hvx_authority, when the
 * point's hour has not started yet (the program refuses a future hour), and when the transaction is refused.
 */
export async function publishHvx(point: HvxPoint, target?: HvxPublishTarget): Promise<{ tx: string | null }> {
  const t = target ?? ownTarget();
  if (!t || !t.programId) return { tx: null };
  const args = hvxFeedArgs(point);
  if (!args) return { tx: null };
  // The program refuses an hour ahead of the chain's clock (security review round 3, R3-27: hours never go back, so a
  // future hour would shut the feed until the clock caught up with it). Only completed hours are ever published; a
  // point that claims a later one is a bug upstream and is not sent.
  if (args.hour > BigInt(Math.floor(Date.now() / 3_600_000))) throw new Error(`HVX point for ${point.hour} is ahead of the clock: not published`);
  const signer = t.chain.roleAddress(t.role);
  if (!signer) return { tx: null };
  const programId = new PublicKey(t.programId);
  const feed = hvxFeedPda(programId, args.grade);
  const [configInfo, feedInfo] = await withRetry(() => t.chain.connection.getMultipleAccountsInfo([capacityConfigPda(programId), feed], t.commitment ?? "confirmed"));
  // Both accounts must be trellis_capacity's own, at their PDAs (TR-02): the config names who may publish.
  const config = verifyAccountInfo(capacityConfigPda(programId), configInfo, capacityConfigSpec(programId));
  if (!config) throw new Error("trellis_capacity is not initialised: no config account to name the HVX authority");
  if (config.hvxAuthority.toBase58() !== signer) throw new Error(`the ${t.role} key is not trellis_capacity's hvx_authority`);
  const current = verifyAccountInfo(feed, feedInfo, hvxFeedSpec(programId));
  if (current && current.updatedAt !== 0n && current.hour > args.hour) return { tx: null };
  const ix = publishHvxIx(programId, { hvxAuthority: new PublicKey(signer), feed, grade: args.grade, hour: args.hour, usdPerMtoken: args.usdPerMtoken, thin: args.thin });
  const { hash } = await t.chain.send(t.role, [ix]);
  return { tx: hash };
}
