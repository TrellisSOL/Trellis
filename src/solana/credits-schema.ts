import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// trellis_credits bookkeeping the router keeps beside chain_events (docs/Trellis_Backend.md §5.1).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });

/**
 * One planned payment of a closure refund: back to one wallet that deposited to the key, to the token account that
 * wallet named on chain (DepositorShare.refund_to). `refundedBefore` is the share's `refunded` when the plan was made,
 * so what this closure has already paid that depositor is always readable from the chain.
 */
export type RefundPlanItem = { depositor: string; refundTo: string; owner: string | null; units: string; refundedBefore: string; status: "planned" | "paid" | "refused" | "reversed"; reason?: string | null; tx?: string | null; /** RefundRequest.requested_at (unix seconds) of the on-chain closure this plan was made for: a plan is never paid against another request (security review round 3, R3-06). */ request?: string };

/**
 * Account-closure refund queue. The key itself signs trellis_credits::close_account (it names no destination), which
 * zeroes the balance and writes a RefundRequest; the settlement job pays it with pay_refund after the request's
 * payable_at (the open-dispute window), back to the wallets that deposited to the key, each after a sanctions check of
 * the account actually paid. Never an on-demand path. `queued` = the close transaction was handed out; `registered` =
 * close_account landed (seen by the indexer or read from the chain); `paid` = every planned payment was sent;
 * `cancelled` = cancel_close took the closure back before anything was paid (the key is open again); when the refund
 * had already been planned and debited, the debit is reversed in the same database transaction (plan items `reversed`).
 */
export const creditClosures = pgTable(
  "credit_closures",
  {
    id: text("id").primaryKey(),
    keyHash: text("key_hash").notNull(), // sha256(secret): the API key row
    chainKeyHash: text("chain_key_hash").notNull(), // the CreditAccount seed
    keyAddress: text("key_address").notNull(), // the API key's ed25519 address (identity of the requester)
    refundTo: text("refund_to").notNull(), // the wallets paid (comma-separated owners), for display; "" until planned. The key does not choose it.
    signature: text("signature"), // unused since closures are signed on chain by the key's authority wallet
    authority: text("authority"), // the wallet that paid the close_account fee, when the API built the transaction
    plan: jsonb("plan").$type<RefundPlanItem[]>(), // who is paid how much; written with the ledger debit, never recomputed
    ledgerBound: boolean("ledger_bound"), // whether the amount was bounded by a router ledger (false: the key was unknown here)
    cancelTx: text("cancel_tx"), // cancel_close signature, when the indexer saw it
    releasedAt: ts("released_at"), // an owner of the account released a closure held because its key was disabled
    amount: units("amount"), // unspent balance at payment time (USDC units); null until paid
    status: text("status").notNull().default("queued"), // queued | registered | paid | refused | failed | cancelled
    reason: text("reason"), // a fixed code when refused/failed, never free text
    registerTx: text("register_tx"), // close_account signature
    payTx: text("pay_tx"), // pay_refund signature
    requestedAt: ts("requested_at").notNull().defaultNow(),
    payableAt: ts("payable_at").notNull(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    uniqueIndex("credit_closures_key_open_uq").on(t.chainKeyHash).where(sql`${t.status} IN ('queued','registered')`),
    index("credit_closures_due_idx").on(t.status, t.payableAt),
    check("credit_closures_status", sql`${t.status} IN ('queued','registered','paid','refused','failed','cancelled')`),
  ],
);

/**
 * Transactions an indexer could not process and stepped past (security re-review RR-08, RR-14). The cursor moves on,
 * so one transaction a node will not serve, or one whose log cannot be decoded, never stalls every later deposit; the
 * row stays until the transaction has been read in full (`resolved_at`), is retried with backoff, and is what the
 * monitor alarms on. `real` says whether the transaction is known to have touched the program's state (it invoked the
 * program or moved the vault): such a row also marks the keys it touched for reconciliation from chain state, which is
 * what guarantees a quarantined deposit is still credited.
 */
export const indexerQuarantine = pgTable(
  "indexer_quarantine",
  {
    contract: text("contract").notNull(), // credits | bond
    signature: text("signature").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(), // tx_unavailable | log_truncated | log_malformed | log_missing | vault_mismatch
    real: boolean("real"), // true: invoked the program or moved the vault; false: proven not to; null: not known yet
    vaultDelta: numeric("vault_delta", { precision: 78, scale: 0, mode: "bigint" }),
    attempts: integer("attempts").notNull().default(1),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastAttemptAt: ts("last_attempt_at").notNull().defaultNow(),
    nextRetryAt: ts("next_retry_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    resolution: text("resolution"), // recorded | not_program | failed_tx | reconciled_from_state
  },
  (t) => [primaryKey({ columns: [t.contract, t.signature] }), index("indexer_quarantine_open_idx").on(t.contract, t.resolvedAt, t.nextRetryAt)],
);

/** Weekly fee distributions through trellis_fee_router::distribute (§5.7; no fee split: 100% to the treasury). */
export const feeDistributions = pgTable("fee_distributions", {
  id: text("id").primaryKey(),
  period: text("period").notNull(), // ISO week, e.g. 2026-W41
  amount: units("amount").notNull(), // USDC units sent to distribute()
  workers: units("workers").notNull(), // 0 under the treasury-only split; kept for the program's exact accounting
  treasury: units("treasury").notNull(),
  tx: text("tx"),
  status: text("status").notNull().default("pending"), // pending | sent | failed
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("fee_distributions_period_uq").on(t.period)]);

/**
 * Flat weekly service fees (relay operators, canary runners: SERVICE_FEE_RECIPIENTS) paid in USDC from the treasury
 * settlement wallet by the weekly settlement run after a sanctions screen. One row per ISO week per recipient, so a
 * crash or a retry never pays a week twice. `refused` rows (sanctions) are never retried; `failed` rows are, next run.
 */
export const serviceFees = pgTable(
  "service_fees",
  {
    id: text("id").primaryKey(),
    period: text("period").notNull(), // ISO week, e.g. 2026-W41
    role: text("role").notNull(), // the operator role paid (relay, canary, ...)
    address: text("address").notNull(), // base58 wallet; its USDC ATA receives the fee; screened before payment
    usdc: units("usdc").notNull(), // USDC units for the week
    tx: text("tx"),
    status: text("status").notNull().default("pending"), // pending | paid | refused | failed
    reason: text("reason"), // a fixed code when refused/failed, never free text
    createdAt: ts("created_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    uniqueIndex("service_fees_period_recipient_uq").on(t.period, t.role, t.address),
    index("service_fees_status_idx").on(t.status),
    check("service_fees_status", sql`${t.status} IN ('pending','paid','refused','failed')`),
  ],
);
