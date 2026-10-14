import { z } from "zod";

// Honest Ledger (docs/Trellis_Backend.md §9). The daily job is off unless HONEST_LEDGER_ENABLED; the public route always
// answers with the days that were computed and the filter that produced them.
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const honestLedgerEnv = {
  HONEST_LEDGER_ENABLED: bool.default(false),
  /** Payments below this (USD) are left out: heartbeat-sized payments inflate a count without being economic volume. */
  HONEST_LEDGER_MIN_PAYMENT_USD: z.coerce.number().min(0).max(1_000).default(0.001),
  /** How many whole days each run recomputes (yesterday first), so late rows are caught. */
  HONEST_LEDGER_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(31).default(2),
  HONEST_LEDGER_INTERVAL_MS: z.coerce.number().int().min(600_000).max(86_400_000).default(86_400_000),
};

const honestLedgerEnvShape = z.object(honestLedgerEnv);
type HonestLedgerEnv = z.infer<typeof honestLedgerEnvShape>;
export const honestLedgerSettings = (e: HonestLedgerEnv) => ({ enabled: e.HONEST_LEDGER_ENABLED, minPaymentUsd: e.HONEST_LEDGER_MIN_PAYMENT_USD, lookbackDays: e.HONEST_LEDGER_LOOKBACK_DAYS, intervalMs: e.HONEST_LEDGER_INTERVAL_MS });
export type HonestLedgerSettings = ReturnType<typeof honestLedgerSettings>;
