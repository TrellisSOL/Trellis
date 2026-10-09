import { desc, eq, isNull } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv, receiptKeys, spentRoots } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { reconcileDeposits } from "../solana/credits-indexer.ts";
import { PAYMENT_NOT_BEFORE_KEY } from "../solana/percall.ts";
import { computeSpentLeaves, RESTORE_STATE_KEY, restoreState, spentRootHour, type RestoreState } from "./settlement.ts";

// What scripts/restore-reconcile.ts does after a database restore (security review R5-08, R5-20). A restored database
// is behind the chain; src/services/settlement.ts freezes every vault outflow while it is (kv `restore_state`). This
// rebuilds what the chain can rebuild, says what it cannot, and lifts the freeze only when what is left has been
// acknowledged by the operator. Without `apply` it changes nothing.
//
// What it REBUILDS (with `apply`):
//   spent root        the root the chain holds and this database does not know is imported as a confirmed row (its
//                     leaves are not on chain and stay unknown), so the next root continues from the chain's total and
//                     never from a stale one;
//   receipt keys      given the last published key document, keys the database no longer has are put back as retired,
//                     verify-only keys (receipts they signed verify again, and the document's version does not go
//                     back), and a key the document shows as retired is retired here too (a restore brings its private
//                     half back; the router must not sign with it again);
//   x402              a watermark: no payment that landed before now can be redeemed (the ledger rows that recorded the
//                     redeemed ones are gone, so each could have been redeemed a second time).
// What the INDEXER rebuilds by itself once workers start: deposits, closures and refunds of the gap (from chain state).
// What CANNOT be rebuilt, and is reported:
//   usage of the gap  the debits made after the backup. The chain's spent total says how much had been committed as
//                     spent at the last root; which key spent it is not on chain. That amount stays with the keys'
//                     balances (to spend again or to be refunded): the operator's loss, to be acknowledged in USDC
//                     units (`acknowledgeGapUsdc`) before the freeze is lifted. Usage after the last root is not even
//                     counted on chain: compare the providers' invoices for the gap.
//   receipt keys      without a saved key document, keys made since the backup are lost for good.
//
// Invariants: it never lowers a spent total; it never unfreezes while a key is credited more than the chain backs, while
// the chain's root is not in the database, or while an unacknowledged gap is left; running it twice changes nothing more.

export type RestoreReport = {
  apply: boolean;
  frozen_before: RestoreState | null;
  spent_root: { state: "not_configured" | "in_step" | "database_behind" | "database_ahead"; chain: { hour: string; root: string; total_spent: string } | null; database: { epoch: number; hour: string; total_spent: string; status: string } | null; imported: boolean };
  /** USDC units the chain has committed as spent that this ledger no longer records. */
  usage_gap_usdc: string;
  deposits: { checked: number; ledger_exceeds_chain: number; chain_exceeds_ledger: number; unreadable: number };
  receipt_keys: { checked: boolean; missing: string[]; resurrected: string[]; repaired: boolean };
  anchors: unknown;
  x402_not_before: number | null;
  unrecovered: string[];
  unfrozen: boolean;
  still_frozen_because: string[];
};

type KeyDocument = { keys?: { kid?: unknown; x?: unknown; valid_from?: unknown; retired_at?: unknown }[] };

export async function restoreReconcile(ctx: Ctx, o: { apply?: boolean; acknowledgeGapUsdc?: bigint | null; keyDocument?: unknown; now?: Date; /** Read-only audit of the anchors table against the chain (services/anchor.ts), when the caller has one. */ auditAnchors?: () => Promise<unknown> } = {}): Promise<RestoreReport> {
  const apply = o.apply === true;
  const now = o.now ?? new Date();
  const unrecovered: string[] = [];
  const blockers: string[] = [];
  const frozenBefore = await restoreState(ctx);

  // ---- 1. The spent root ------------------------------------------------------------------------------------------
  const onChain = !!(ctx.chain.address("credits") && ctx.chain.roleAddress("settlement"));
  let [last] = await ctx.db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1);
  let state: RestoreReport["spent_root"]["state"] = "not_configured";
  let chain: RestoreReport["spent_root"]["chain"] = null;
  let imported = false;
  let chainTotal = 0n;
  if (onChain) {
    const landed = await ctx.chain.latestSpentRoot(); // a read failure ends the run: nothing is decided on a chain that cannot be read
    chain = { hour: landed.hour.toString(), root: landed.root, total_spent: landed.totalSpent.toString() };
    chainTotal = landed.totalSpent;
    const lastHour = last ? spentRootHour(last.asOf) : 0n;
    const same = !!last && landed.hour === lastHour && landed.root === last.root && landed.totalSpent === last.totalSpentUsdc;
    if (same || (!last && landed.hour === 0n)) state = "in_step";
    else if (landed.hour > lastHour || landed.totalSpent > (last?.totalSpentUsdc ?? 0n)) {
      state = "database_behind";
      if (apply) {
        // A candidate this database was still proposing is older than what the chain holds: it can never land.
        if (last && ["pending", "awaiting_approval"].includes(last.status)) await ctx.db.update(spentRoots).set({ status: "superseded" }).where(eq(spentRoots.epoch, last.epoch));
        const epoch = (last?.epoch ?? 0) + 1;
        await ctx.db.insert(spentRoots).values({ epoch, root: landed.root, asOf: new Date(Number(landed.hour) * 1000), totalSpentUsdc: landed.totalSpent, leaves: [], status: "confirmed" });
        await setKv(ctx, `spent_root_imported:${epoch}`, { at: now.toISOString(), hour: landed.hour.toString(), root: landed.root, total_spent: landed.totalSpent.toString() });
        [last] = await ctx.db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1);
        imported = true;
        state = "in_step";
        log.warn("restore: imported the chain's spent root; its leaves are unknown", { epoch, hour: landed.hour.toString() });
      } else blockers.push("the chain's spent root is not in this database (run with --apply to import it)");
    } else state = "database_ahead"; // a candidate of this database that has not landed yet: the settlement job's own business
  }

  // ---- 2. Usage the chain has committed and this ledger no longer records -------------------------------------------
  const { leaves } = await computeSpentLeaves(ctx);
  const ledgerTotal = leaves.reduce((a, [, s]) => a + s, 0n);
  const gap = chainTotal > ledgerTotal ? chainTotal - ledgerTotal : 0n;
  if (gap > 0n) {
    unrecovered.push(`${gap} USDC units of usage are committed as spent on chain and are no longer in this ledger; which keys spent them is not on chain. They stay in those keys' balances. Usage after the last root is not counted here: compare the providers' invoices for the gap.`);
    if (o.acknowledgeGapUsdc !== gap) blockers.push(`the usage gap of ${gap} USDC units is not acknowledged (--acknowledge-gap-usdc ${gap})`);
  }

  // ---- 3. Deposits --------------------------------------------------------------------------------------------------
  const dep = await reconcileDeposits(ctx);
  const count = (kind: string) => dep.mismatches.filter((m) => m.kind === kind).length;
  const deposits = { checked: dep.checked, ledger_exceeds_chain: count("ledger_exceeds_chain"), chain_exceeds_ledger: count("chain_exceeds_ledger"), unreadable: count("unreadable") };
  if (deposits.ledger_exceeds_chain) blockers.push(`${deposits.ledger_exceeds_chain} key(s) are credited more than their on-chain deposits back (scripts/reconcile.ts lists them)`);
  if (deposits.unreadable) blockers.push(`${deposits.unreadable} key(s) could not be read from the chain; run again`);

  // ---- 4. Receipt keys ----------------------------------------------------------------------------------------------
  const rk = { checked: false, missing: [] as string[], resurrected: [] as string[], repaired: false };
  const doc = o.keyDocument as KeyDocument | undefined;
  if (doc && Array.isArray(doc.keys)) {
    rk.checked = true;
    const rows = await ctx.db.select().from(receiptKeys);
    const have = new Map(rows.map((r) => [r.id, r]));
    for (const k of doc.keys) {
      if (typeof k.kid !== "string" || !/^[0-9a-f]{16}$/.test(k.kid) || typeof k.x !== "string") continue;
      const publicKey = Buffer.from(k.x, "base64url");
      if (publicKey.length !== 32) continue;
      const validFrom = typeof k.valid_from === "string" && !Number.isNaN(Date.parse(k.valid_from)) ? new Date(k.valid_from) : now;
      const retiredAt = typeof k.retired_at === "string" && !Number.isNaN(Date.parse(k.retired_at)) ? new Date(k.retired_at) : null;
      const row = have.get(k.kid);
      if (!row) {
        rk.missing.push(k.kid);
        // Put back verify-only: its private half is gone, so it is retired whatever the document said of it.
        if (apply) await ctx.db.insert(receiptKeys).values({ id: k.kid, publicKey: publicKey.toString("hex"), privateKeyEnc: null, validFrom, retiredAt: retiredAt ?? now }).onConflictDoNothing();
      } else if (retiredAt && !row.retiredAt) {
        rk.resurrected.push(k.kid);
        if (apply) await ctx.db.update(receiptKeys).set({ retiredAt, privateKeyEnc: null }).where(eq(receiptKeys.id, k.kid));
      }
    }
    rk.repaired = apply && (rk.missing.length > 0 || rk.resurrected.length > 0);
    if (!apply && (rk.missing.length || rk.resurrected.length)) blockers.push("receipt keys differ from the saved key document (run with --apply to repair them)");
  } else {
    const [current] = await ctx.db.select({ id: receiptKeys.id }).from(receiptKeys).where(isNull(receiptKeys.retiredAt)).limit(1);
    unrecovered.push(`Receipt keys were not checked (no saved key document given with --key-document). Keys made since the backup are lost without it: receipts they signed will not verify, and this database may sign with a key that had been retired${current ? ` (${current.id})` : ""}.`);
  }

  // ---- 5. Anchors (read-only; the anchor job reconciles its own rows with the chain before it posts) ----------------
  let anchors: unknown = { skipped: "no audit given" };
  if (o.auditAnchors) anchors = await o.auditAnchors().catch((e) => ({ error: (e as Error).message.slice(0, 200) }));

  // ---- 6. x402: nothing that landed before now is redeemable --------------------------------------------------------
  let notBefore: number | null = null;
  if (apply) {
    notBefore = Math.floor(now.getTime() / 1000);
    const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, PAYMENT_NOT_BEFORE_KEY));
    const existing = typeof row?.value === "number" ? row.value : 0;
    if (notBefore > existing) await setKv(ctx, PAYMENT_NOT_BEFORE_KEY, notBefore);
    else notBefore = existing;
  }

  // ---- 7. The freeze ------------------------------------------------------------------------------------------------
  let unfrozen = false;
  const frozenNow = await restoreState(ctx);
  if (apply && !blockers.length && frozenNow?.frozen) {
    await setKv(ctx, RESTORE_STATE_KEY, { ...frozenNow, frozen: false, cleared_at: now.toISOString(), acknowledged_gap_usdc: gap.toString() });
    unfrozen = true;
    log.warn("restore: reconciled; vault outflows are no longer frozen", { acknowledged_gap_usdc: gap.toString(), imported_root: imported });
  }
  const stillFrozen = !unfrozen && (await restoreState(ctx))?.frozen === true;
  return {
    apply,
    frozen_before: frozenBefore,
    spent_root: { state, chain, database: last ? { epoch: last.epoch, hour: spentRootHour(last.asOf).toString(), total_spent: last.totalSpentUsdc.toString(), status: last.status } : null, imported },
    usage_gap_usdc: gap.toString(),
    deposits,
    receipt_keys: rk,
    anchors,
    x402_not_before: notBefore,
    unrecovered,
    unfrozen,
    still_frozen_because: stillFrozen ? (blockers.length ? blockers : ["not applied (dry run)"]) : [],
  };
}

async function setKv(ctx: Ctx, key: string, value: unknown) {
  await ctx.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
