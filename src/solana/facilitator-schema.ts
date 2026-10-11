import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// The hosted x402 facilitator's tables. Amounts are USDC base units (1e-6) as numeric(78,0); addresses are base58.
// Settlement receipts join the hourly receipt anchor (services/anchor.ts). Column names kept from the EVM router where
// the meaning survived: `tx_hash` holds a base58 transaction signature, `gas_debit` the SOL fee recovered in USDC
// (sponsorship, §5.2) and `seller_gas_floats` the fee floats; renaming them in SQL would need a hand-written migration.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });

/** Sellers who opted in to discovery, each listing signed by its payTo key. */
export const facilitatorSellers = pgTable(
  "facilitator_sellers",
  {
    id: text("id").primaryKey(),
    payTo: text("pay_to").notNull(),
    resource: text("resource").notNull(), // the paid URL, unique: first signer owns it
    priceHint: units("price_hint"),
    outputSchema: jsonb("result_schema"), // x402 calls it outputSchema; named result_schema here so no column name suggests request content
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    listed: boolean("listed").notNull().default(true),
    signature: text("signature").notNull(),
    signedAt: ts("signed_at").notNull(), // issuedAt of the signed listing; a later signature replaces it
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("facilitator_sellers_resource_uq").on(t.resource), index("facilitator_sellers_pay_to_idx").on(t.payTo)],
);

/** One row per settle attempt that passed verification; (payer, nonce) is the durable claim on a payment. */
export const facilitatorSettlements = pgTable(
  "facilitator_settlements",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("payment"), // payment | gas_float (a seller topping up its fee float)
    scheme: text("scheme").notNull().default("exact"), // exact | tab
    payer: text("payer").notNull(),
    payTo: text("pay_to").notNull(),
    value: units("value").notNull(),
    nonce: text("nonce").notNull(), // the payer's signature over the transaction (exact) or the voucher (tab), unique per payer
    txHash: text("tx_hash"), // base58 transaction signature once settled
    status: text("status").notNull(), // verified (claimed, submission in flight) | settled | failed
    error: text("error"), // a fixed code, never chain or request text
    sellerId: text("seller_id"),
    x402Version: smallint("x402_version").notNull(),
    feeValue: units("fee_value"),
    feeTxHash: text("fee_tx_hash"),
    gasDebit: units("gas_debit"), // USDC units recovered for the transaction fee (fee sponsorship) or debited from the seller's float
    feeLamports: units("fee_lamports"), // lamports the fee payer was charged for this transaction (per-call x402: what gas_debit recovers; on a row that failed on chain: what was lost)
    settledAt: ts("settled_at"),
    receiptCose: text("receipt_cose"), // base64 COSE_Sign1, kind facilitator.settle
    receiptLeaf: text("receipt_leaf"),
    receiptKeyId: text("receipt_key_id"),
    anchorIndex: integer("anchor_index"),
    leafIndex: integer("leaf_index"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("facilitator_settlements_payer_nonce_uq").on(t.payer, t.nonce),
    index("facilitator_settlements_anchor_idx").on(t.anchorIndex),
    index("facilitator_settlements_pay_to_idx").on(t.payTo),
    check("facilitator_settlements_status", sql`${t.status} IN ('verified','settled','failed')`),
    check("facilitator_settlements_kind", sql`${t.kind} IN ('payment','gas_float')`),
  ],
);

/** USDC a seller prepaid so the facilitator settles its payments below the minimum; debited at the measured fee x a buffer. */
export const sellerGasFloats = pgTable(
  "seller_gas_floats",
  {
    sellerId: text("seller_id").primaryKey().references(() => facilitatorSellers.id),
    balance: units("balance").notNull().default(sql`0`),
    funded: units("funded").notNull().default(sql`0`),
    debited: units("debited").notNull().default(sql`0`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("seller_gas_floats_balance", sql`${t.balance} >= 0`)],
);
