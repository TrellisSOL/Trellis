import { sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Honest Ledger (src/stats/honest-ledger.ts): one row per UTC day of x402 volume through Trellis after the wash filter.
// Counts and sums only; no payer, payee or payment is stored. Money is pico-USD.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const pico = (name: string) => bigint(name, { mode: "bigint" }).notNull().default(sql`0`);

export const honestLedgerDays = pgTable("honest_ledger_days", {
  day: text("day").primaryKey(), // YYYY-MM-DD, UTC
  payments: integer("payments").notNull().default(0), // payments that passed the filter
  volume: pico("volume"), // pico-USD of those payments
  uniquePayers: integer("unique_payers").notNull().default(0), // distinct payers among them
  grossPayments: integer("gross_payments").notNull().default(0), // every x402 payment of the day, before the filter
  grossVolume: pico("gross_volume"),
  excludedSelfDealing: integer("excluded_self_dealing").notNull().default(0),
  excludedCircular: integer("excluded_circular").notNull().default(0),
  excludedBelowMinimum: integer("excluded_below_minimum").notNull().default(0),
  excludedVolume: pico("excluded_volume"),
  minPayment: pico("min_payment"), // the minimum payment size the day was filtered with
  filterVersion: text("filter_version").notNull(), // the published filter the row was computed with
  computedAt: ts("computed_at").notNull().defaultNow(),
});
