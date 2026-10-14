import { and, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, facilitatorSettlements, generations, providers } from "../db/schema.ts";
import { picoToUsd, usdToPico, usdcToPico, type Pico } from "../lib/money.ts";
import { washFilter, type HvxReceipt, type Identities } from "../services/hvx.ts";
import { addressKey } from "../solana/constants.ts";
import type { HonestLedgerSettings } from "./config.ts";
import { honestLedgerDays } from "./schema.ts";

// Honest Ledger (docs/Trellis_Backend.md §9): public daily statistics of economic x402 volume through Trellis. The same
// wash filter as the HVX index (src/services/hvx.ts washFilter, reused as it is) removes self-dealing and payments that
// circle back within two hops; payments under a minimum size are left out; what remains is counted with its distinct
// payers. The filter and its parameters are part of every answer, and the gross figures and what each rule removed are
// published next to the counted ones, so the result can be reproduced and the size of the filter judged.
//
// What counts as an x402 payment through Trellis:
//   - an inference call paid per call (x402 `exact`) or on a tab (x402 `tab`): generations.mode per_call | tab;
//   - a payment the hosted facilitator settled for an outside seller: facilitator_settlements, kind payment, settled.
// Prepaid-balance calls, blind tokens and pay-with swaps are not x402 payments and are not in this ledger.

export const HONEST_LEDGER_FORMAT = "trellis.honest-ledger/1";
export const FILTER_VERSION = "trellis.honest-ledger-filter/1";
export const CIRCULAR_HOPS = 2;
const DAY_MS = 86_400_000;

export type X402Payment = { id: string; source: "inference" | "facilitator"; payer: string; payee: string; amount: Pico };

export const dayOf = (t: number | Date) => new Date(Math.floor((typeof t === "number" ? t : t.getTime()) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);

export type DaySummary = { payments: number; volume: Pico; uniquePayers: number; grossPayments: number; grossVolume: Pico; excluded: { self_dealing: number; circular: number; below_minimum: number }; excludedVolume: Pico };

/**
 * One day's payments through the wash filter. `payer` and `payee` are the identity keys the filter unifies through
 * `ids` (an account with its wallet, a host with its operator and payout address), so a wallet paying the host it runs
 * is self-dealing whichever name it used. Pure.
 */
export function summarizeDay(payments: X402Payment[], ids: Identities, minPayment: Pico): DaySummary {
  // The filter was written for index receipts and drops a receipt without a grade; a payment has no grade, so each is
  // given the same one and the filter's three money rules are all that act.
  const receipts: HvxReceipt[] = payments.map((p) => ({ id: p.id, accountId: p.payer, providerId: p.payee, grade: "G-S", cost: p.amount, tokensIn: 0, tokensOut: 0, reasoningTokens: 0, cachedTokens: 0 }));
  const washed = washFilter(receipts, ids, minPayment);
  const byId = new Map(payments.map((p) => [p.id, p]));
  const payerIdentity = (p: X402Payment) => (ids.accounts.get(p.payer) ?? [p.payer]).at(-1)!;
  const excluded = { self_dealing: 0, circular: 0, below_minimum: 0 };
  let excludedVolume = 0n;
  for (const e of washed.excluded) {
    if (e.reason === "no_grade") continue;
    excluded[e.reason]++;
    excludedVolume += byId.get(e.id)?.amount ?? 0n;
  }
  return {
    payments: washed.kept.length,
    volume: washed.kept.reduce((a, r) => a + r.cost, 0n),
    uniquePayers: new Set(washed.kept.map((r) => payerIdentity(byId.get(r.id)!))).size,
    grossPayments: payments.length,
    grossVolume: payments.reduce((a, p) => a + p.amount, 0n),
    excluded,
    excludedVolume,
  };
}

/** The day's x402 payments and the identities the filter needs. */
export async function loadDay(ctx: Pick<Ctx, "db">, day: string): Promise<{ payments: X402Payment[]; ids: Identities }> {
  const from = dayStart(day);
  const to = new Date(from.getTime() + DAY_MS);
  const [gens, settled, acc, hosts] = await Promise.all([
    ctx.db
      .select({ id: generations.id, accountId: generations.accountId, providerId: generations.providerId, cost: generations.cost })
      .from(generations)
      .where(and(gte(generations.ts, from), lt(generations.ts, to), gt(generations.cost, 0n), eq(generations.cancelled, false), inArray(generations.mode, ["per_call", "tab"]), sql`${generations.finishReason} IS DISTINCT FROM 'error'`)),
    ctx.db
      .select({ id: facilitatorSettlements.id, payer: facilitatorSettlements.payer, payTo: facilitatorSettlements.payTo, value: facilitatorSettlements.value })
      .from(facilitatorSettlements)
      .where(and(eq(facilitatorSettlements.status, "settled"), eq(facilitatorSettlements.kind, "payment"), gte(facilitatorSettlements.settledAt, from), lt(facilitatorSettlements.settledAt, to))),
    ctx.db.select({ id: accounts.id, wallet: accounts.wallet }).from(accounts),
    ctx.db.select({ id: providers.id, operator: providers.operator, payout: providers.payoutAddress }).from(providers),
  ]);
  // Addresses are compared by addressKey: base58 exactly (case is significant), 0x hex without regard to case.
  // Aliases end with the most specific public identity (the wallet), which is also what a distinct payer is counted by.
  const ids: Identities = {
    accounts: new Map(acc.map((a) => [a.id, [a.id, ...(a.wallet ? [addressKey(a.wallet)] : [])]])),
    hosts: new Map(hosts.map((h) => [h.id, [h.id, ...(h.operator ? [addressKey(h.operator)] : []), ...(h.payout ? [addressKey(h.payout)] : [])]])),
  };
  const payments: X402Payment[] = gens.filter((g) => g.accountId).map((g) => ({ id: g.id, source: "inference", payer: g.accountId!, payee: g.providerId, amount: g.cost }));
  for (const s of settled) {
    // A facilitator payment names two wallets. Each joins the identity graph under its address, so a wallet that is
    // also an account's wallet or a host's operator is recognised as that party.
    const payer = `x402-payer:${s.payer}`;
    const payee = `x402-payee:${s.payTo}`;
    ids.accounts.set(payer, [addressKey(s.payer)]);
    ids.hosts.set(payee, [addressKey(s.payTo)]);
    payments.push({ id: s.id, source: "facilitator", payer, payee, amount: usdcToPico(s.value) });
  }
  return { payments, ids };
}

type DayRow = typeof honestLedgerDays.$inferSelect;

/** Compute one UTC day and store it (upsert on the day). */
export async function computeDay(ctx: Pick<Ctx, "db">, cfg: HonestLedgerSettings, day: string): Promise<DayRow> {
  const { payments, ids } = await loadDay(ctx, day);
  const minPayment = usdToPico(cfg.minPaymentUsd);
  const s = summarizeDay(payments, ids, minPayment);
  const values = { payments: s.payments, volume: s.volume, uniquePayers: s.uniquePayers, grossPayments: s.grossPayments, grossVolume: s.grossVolume, excludedSelfDealing: s.excluded.self_dealing, excludedCircular: s.excluded.circular, excludedBelowMinimum: s.excluded.below_minimum, excludedVolume: s.excludedVolume, minPayment, filterVersion: FILTER_VERSION, computedAt: new Date() };
  const [row] = await ctx.db.insert(honestLedgerDays).values({ day, ...values }).onConflictDoUpdate({ target: honestLedgerDays.day, set: values }).returning();
  return row;
}

/** The daily job: the last HONEST_LEDGER_LOOKBACK_DAYS completed days, oldest first. Today is never written: it is not over. */
export async function runHonestLedger(ctx: Pick<Ctx, "db" | "cfg">, now = Date.now()) {
  const cfg = ctx.cfg.honestLedger;
  if (!cfg.enabled) return { skipped: "disabled" as const };
  const days: string[] = [];
  for (let i = cfg.lookbackDays; i >= 1; i--) days.push(dayOf(now - i * DAY_MS));
  for (const day of days) await computeDay(ctx, cfg, day);
  return { days };
}

export function registerHonestLedgerJob(ctx: Ctx) {
  if (!ctx.cfg.honestLedger.enabled) return;
  ctx.jobs.register("honest-ledger", ctx.cfg.honestLedger.intervalMs, () => runHonestLedger(ctx), { atStart: true });
}

const usd = (p: Pico) => picoToUsd(p).toFixed(6);

/** The filter as published with every answer. */
export const publishedFilter = (cfg: Pick<HonestLedgerSettings, "minPaymentUsd">) => ({
  version: FILTER_VERSION,
  counted: ["inference paid per call (x402 exact)", "inference paid on a tab (x402 tab)", "payments settled by the hosted facilitator"],
  not_counted: ["calls paid from a prepaid balance", "blind tokens", "pay-with swaps", "failed or cancelled calls"],
  window: "UTC day",
  self_dealing: "excluded: the payer and the payee are the same party (same account, wallet, host operator or payout address)",
  circular: `excluded: the payee, or a party it paid, paid the payer back within the same day (${CIRCULAR_HOPS} hops)`,
  circular_hops: CIRCULAR_HOPS,
  min_payment_usd: cfg.minPaymentUsd,
  unique_payers: "distinct payer wallets (or accounts without a wallet) among the counted payments",
  source: "src/services/hvx.ts washFilter, src/stats/honest-ledger.ts",
});

const dayJson = (r: DayRow) => ({
  day: r.day,
  payments: r.payments,
  volume_usd: usd(r.volume),
  unique_payers: r.uniquePayers,
  gross: { payments: r.grossPayments, volume_usd: usd(r.grossVolume) },
  excluded: { self_dealing: r.excludedSelfDealing, circular: r.excludedCircular, below_minimum: r.excludedBelowMinimum, volume_usd: usd(r.excludedVolume) },
  min_payment_usd: picoToUsd(r.minPayment),
  filter_version: r.filterVersion,
  computed_at: r.computedAt.toISOString(),
});

/** GET /api/v1/ledger/honest: the last `days` computed days, newest first, the filter, and totals over those days. */
export async function honestLedgerView(ctx: Pick<Ctx, "db" | "cfg">, days = 30) {
  const rows = await ctx.db.select().from(honestLedgerDays).orderBy(desc(honestLedgerDays.day)).limit(Math.min(366, Math.max(1, days)));
  const sum = (pick: (r: DayRow) => bigint | number) => rows.reduce((a, r) => a + BigInt(pick(r)), 0n);
  return {
    format: HONEST_LEDGER_FORMAT,
    enabled: ctx.cfg.honestLedger.enabled,
    unit: "usd",
    filter: publishedFilter(ctx.cfg.honestLedger),
    totals: {
      days: rows.length,
      payments: Number(sum((r) => r.payments)),
      volume_usd: usd(sum((r) => r.volume)),
      gross_payments: Number(sum((r) => r.grossPayments)),
      gross_volume_usd: usd(sum((r) => r.grossVolume)),
      // Payers are distinct within a day; a payer active on two days is counted on both, so no total is given.
      unique_payers: null,
    },
    days: rows.map(dayJson),
  };
}
