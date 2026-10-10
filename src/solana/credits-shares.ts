import { and, desc, eq, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { chainEvents } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { depositorShareSpec } from "./account-specs.ts";
import { base58Encode } from "./constants.ts";
import { readDepositorShare, type CreditsProgram } from "./credits.ts";
import { chainKeyHashBytes } from "./keys.ts";
import { creditsIdl, type DepositorShare } from "./programs/credits.ts";
import { verifyAccountInfo } from "./verified-account.ts";

// Who funded a key, and how a closure refund is split over them (security re-review RR-05). A refund goes back to the
// wallets that deposited to the key, never to an address the key names: the program pays only to a DepositorShare's
// refund_to and at most what that share put in. This module reads those shares and decides the split.

export type Lot = { depositor: string; units: bigint };

/**
 * The key's depositors and what each put in, newest deposit first. Shares come from the chain (each DepositorShare is
 * owner- and PDA-checked); which wallets to look at comes from the Deposited events on file and, where the RPC offers it,
 * from the program's accounts for this key hash. Lots are the deposits on file; what a share holds beyond them (a deposit
 * whose event was never decoded) counts as that depositor's newest lot.
 */
export async function sharesAndLots(ctx: Ctx, program: CreditsProgram, chainKeyHash: string): Promise<{ shares: Map<string, DepositorShare>; lots: Lot[] }> {
  const rpc = ctx.chain.connection;
  const keyHash = chainKeyHashBytes(chainKeyHash);
  const events = await ctx.db.select({ args: chainEvents.args }).from(chainEvents).where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Deposited"), sql`${chainEvents.args}->>'keyHash' = ${"0x" + chainKeyHash.toLowerCase().replace(/^0x/, "")}`)).orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex));
  const lots: Lot[] = events.map((e) => ({ depositor: (e.args as { depositor: string }).depositor, units: BigInt((e.args as { amount: string }).amount) }));
  const shares = new Map<string, DepositorShare>();
  for (const depositor of new Set(lots.map((l) => l.depositor))) {
    const share = await readDepositorShare(rpc, program, chainKeyHash, new PublicKey(depositor));
    if (share) shares.set(depositor, share);
  }
  const scan = (rpc as unknown as { getProgramAccounts?: (id: PublicKey, o: unknown) => Promise<readonly { pubkey: PublicKey; account: { owner: PublicKey; data: Buffer } }[]> }).getProgramAccounts;
  if (typeof scan === "function") {
    try {
      const found = await scan.call(rpc, program.programId, { filters: [{ memcmp: { offset: 0, bytes: base58Encode(creditsIdl.accountDiscriminator("DepositorShare")) } }, { memcmp: { offset: 8, bytes: base58Encode(keyHash) } }] });
      for (const f of found) {
        try { const share = verifyAccountInfo(f.pubkey, f.account, depositorShareSpec(program.programId)); if (share) shares.set(share.depositor.toBase58(), share); } catch { /* not a share of this program */ }
      }
    } catch (e) { log.warn("closure refund: the program's accounts could not be listed; depositors come from the events on file", { error: (e as Error).message.slice(0, 120) }); }
  }
  // What a share holds beyond its lots on file: newest first.
  const known = new Map<string, bigint>();
  for (const l of lots) known.set(l.depositor, (known.get(l.depositor) ?? 0n) + l.units);
  const extra = [...shares.entries()].filter(([d, sh]) => sh.deposited > (known.get(d) ?? 0n)).sort((a, b) => (a[1].lastDepositAt === b[1].lastDepositAt ? 0 : a[1].lastDepositAt > b[1].lastDepositAt ? -1 : 1)).map(([d, sh]) => ({ depositor: d, units: sh.deposited - (known.get(d) ?? 0n) }));
  return { shares, lots: [...extra, ...lots] };
}

/**
 * The depositors that can still be refunded, LARGEST remaining share first (ties: the more recent deposit first).
 *
 * Round 2 split a refund newest deposit first. Anyone may deposit to any key, so a stranger could put any number of
 * small, recent shares in front of the key's owner: each had to be screened, read and paid before the owner saw a unit
 * (security review round 3, R3-22). Largest first, the wallets that funded the key are served first and a small share
 * is reached only when the refund really extends to it. `room` is what the chain can still refund each depositor
 * (deposited minus refunded).
 */
export function refundOrder(shares: ReadonlyMap<string, Pick<DepositorShare, "deposited" | "refunded" | "lastDepositAt">>): { depositor: string; room: bigint }[] {
  return [...shares.entries()]
    .map(([depositor, sh]) => ({ depositor, room: sh.deposited > sh.refunded ? sh.deposited - sh.refunded : 0n, at: sh.lastDepositAt }))
    .filter((x) => x.room > 0n)
    .sort((a, b) => (a.room === b.room ? (a.at === b.at ? (a.depositor < b.depositor ? -1 : 1) : a.at > b.at ? -1 : 1) : a.room > b.room ? -1 : 1))
    .map(({ depositor, room }) => ({ depositor, room }));
}

/**
 * Split `refund` over `order` (see refundOrder), each depositor capped at its room. `accept` is asked once per
 * depositor, in order, and only while something is left to place: it is where the destination is read and screened, so
 * the work a closure costs is bounded by the shares the refund actually reaches, not by how many shares exist.
 */
export async function allocateRefund(refund: bigint, order: readonly { depositor: string; room: bigint }[], accept: (depositor: string) => Promise<boolean> | boolean = () => true): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  let left = refund;
  for (const { depositor, room } of order) {
    if (left <= 0n) break;
    if (room <= 0n || !(await accept(depositor))) continue;
    const give = left < room ? left : room;
    out.set(depositor, give);
    left -= give;
  }
  return out;
}
