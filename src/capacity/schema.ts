import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Bushels (docs/Trellis_Backend.md §5.6): the router's side of trellis_capacity. A lot is prepaid capacity bound to the
// buyer's key; there is no column, route or instruction that moves a lot to another key. Amounts named *_usdc are USDC
// base units (1e-6); tokens are output-equivalent tokens.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const u64 = (name: string) => bigint(name, { mode: "bigint" });

/** One row per purchase: the off-chain mirror of a BushelLot account, plus what the router did about it. */
export const bushelLots = pgTable(
  "bushel_lots",
  {
    id: text("id").primaryKey(),
    commitment: text("commitment").notNull(), // CapacityCommitment account
    lotSeq: integer("lot_seq").notNull(), // the lot id inside the commitment (BushelLot.lot_id)
    lotAccount: text("lot_account").notNull(), // BushelLot account
    operator: text("operator").notNull(), // the committing host's wallet
    providerId: text("provider_id"), // that host's registry id, when the wallet is a registered operator
    keyHash: text("key_hash").notNull(), // the buyer's API key hash; the lot never leaves it
    chainKeyHash: text("chain_key_hash").notNull(), // the 32-byte key hash written into the BushelLot account, hex
    accountId: text("account_id").notNull(),
    grade: text("grade").notNull(), // G-S | G-M | G-L
    tokens: u64("tokens").notNull(),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    pricePaidUsdc: u64("price_paid_usdc").notNull(), // the only figure a refund can reference
    priority: integer("priority").notNull().default(0), // the buyer's tier sealed_priority when the purchase was requested
    requestedAt: ts("requested_at").notNull(),
    status: text("status").notNull(), // pending | sold | redeemed | rehomed | claim_filed | refunded | closed | failed
    buyTx: text("buy_tx"),
    redeemTx: text("redeem_tx"),
    redeemedAt: ts("redeemed_at"),
    unservedTokens: u64("unserved_tokens").notNull().default(sql`0`), // the lot's share of the host's reported shortfall
    rehomedTo: text("rehomed_to"), // the commitment on another host of the same grade that honours the unserved part
    shortfallTx: text("shortfall_tx"), // rehome_lot or claim_lot_shortfall
    claimRef: text("claim_ref"), // the trellis_bond proposal account of a filed claim
    refundUsdc: u64("refund_usdc").notNull().default(sql`0`), // price_paid x unserved / committed, credited once the claim executed
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  // A failed purchase never reached the chain, so its lot id is free for the next one.
  (t) => [uniqueIndex("bushel_lots_commitment_seq_uq").on(t.commitment, t.lotSeq).where(sql`${t.status} <> 'failed'`), index("bushel_lots_key_idx").on(t.keyHash, t.createdAt), index("bushel_lots_status_idx").on(t.status, t.windowEnd)],
);

/**
 * What a redeemed lot is worth at billing time: tokens of one grade for one key, on the committed host (or the host a
 * lot was rehomed to), inside the window. It is not money and not a balance: it only reduces what calls on that grade cost.
 */
export const bushelAllowances = pgTable(
  "bushel_allowances",
  {
    lotId: text("lot_id").primaryKey().references(() => bushelLots.id),
    keyHash: text("key_hash").notNull(),
    grade: text("grade").notNull(),
    providerId: text("provider_id"), // the host that honours it; null when the host has no registry entry yet
    tokensGranted: u64("tokens_granted").notNull(),
    tokensLeft: u64("tokens_left").notNull(),
    usableFrom: ts("usable_from").notNull(),
    usableUntil: ts("usable_until").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("bushel_allowances_key_grade_idx").on(t.keyHash, t.grade)],
);

/** One row per commitment the shortfall job examined after its window ended: what was measured and what was reported. */
export const bushelShortfalls = pgTable("bushel_shortfalls", {
  commitment: text("commitment").primaryKey(),
  operator: text("operator").notNull(),
  providerId: text("provider_id"),
  grade: text("grade").notNull(),
  tokens: u64("tokens").notNull(), // committed
  soldTokens: u64("sold_tokens").notNull(),
  unservedTokens: u64("unserved_tokens").notNull(), // reported with report_shortfall
  okRate: real("ok_rate"), // share of the host's health samples inside the window that succeeded; null without samples
  samples: integer("samples").notNull().default(0),
  evidenceDigest: text("evidence_digest").notNull(), // sha256 of the canonical measurement, the evidence_hash of any claim
  reportTx: text("report_tx"),
  status: text("status").notNull(), // served (nothing unserved) | reported (lots being rehomed or claimed) | settled
  examinedAt: ts("examined_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
