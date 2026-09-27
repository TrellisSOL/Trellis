import { enforceAgentReservation, type AgentReservation } from "../agents/enforce.ts";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { accounts, holds, keys, ledger } from "../db/schema.ts";
import { creditClosures } from "../solana/credits-schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { type Pico, picoToUsd } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { applyTopup } from "./topup.ts";

// Money invariants (enforced here and by DB triggers, see drizzle/0001_invariants.sql):
// - The ledger is append-only; ledger.ref is UNIQUE, which makes every credit idempotent.
// - accounts.balance == SUM(ledger.amount); accounts.held == SUM(open holds).
// - Paid work is reserve -> settle | release, exactly once. A caller is charged its actual
//   usage and NEVER more than the hold (security review R3-02): the hold is the bound the caller
//   agreed to, so usage a provider reports above it is not the caller's cost. The difference is
//   recorded on the hold as `uncovered`, logged as an error and alarmed (services/hold-watch.ts);
//   the provider is not paid for it.
// - A hold lives as long as its request (keepHoldAlive). A hold the expiry job released while its
//   request was still running is charged when that request settles, from the available balance and
//   capped at the original hold (security review R3-25), instead of closing at zero.

export type Balance = { balance: Pico; held: Pico; available: Pico };

export async function ensureAccount(db: Db | Tx, id: string, kind = "key", wallet?: string | null) {
  await db
    .insert(accounts)
    .values({ id, kind, wallet: wallet ?? null })
    .onConflictDoNothing();
  return id;
}

export async function balanceOf(db: Db | Tx, accountId: string): Promise<Balance> {
  const [row] = await db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, accountId));
  if (!row) return { balance: 0n, held: 0n, available: 0n };
  return { balance: row.balance, held: row.held, available: row.balance - row.held };
}

/** Append a ledger row. Returns false when `ref` was already recorded (idempotent). */
export async function post(
  db: Db | Tx,
  e: { accountId: string; amount: Pico; kind: string; ref: string; keyHash?: string | null; description?: string; generationId?: string | null },
): Promise<boolean> {
  const inserted = await db
    .insert(ledger)
    .values({
      id: uid("l_"),
      accountId: e.accountId,
      keyHash: e.keyHash ?? null,
      amount: e.amount,
      kind: e.kind,
      ref: e.ref,
      description: e.description ?? "",
      generationId: e.generationId ?? null,
    })
    .onConflictDoNothing({ target: ledger.ref })
    .returning({ id: ledger.id });
  return inserted.length > 0;
}

export async function creditAccount(
  db: Db,
  e: { accountId: string; amount: Pico; kind: string; ref: string; keyHash?: string | null; description?: string },
) {
  if (e.amount <= 0n) fail(400, "Credit amount must be positive.");
  return db.transaction(async (tx) => {
    await ensureAccount(tx, e.accountId);
    return post(tx, e);
  });
}

function periodStart(reset: string | null, at: Date): Date | null {
  if (!reset) return null;
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (reset === "weekly") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (reset === "monthly") d.setUTCDate(1);
  return d;
}

export type ReserveInput = {
  agent?: AgentReservation | (() => AgentReservation);
  id: string;
  accountId: string;
  keyHash?: string | null;
  amount: Pico;
  kind?: string;
  ttlMs?: number;
  /** Allow the available balance to go negative by up to this much (pay-with sessions). */
  creditLine?: Pico;
  /** v6 T: a paid x402 tool call; the rulebook evaluates it as a paid_tool intent priced at `amount`. */
  tool?: { resource: string; seller: string; listing?: string };
};

export const reserve = (db: Db, r: ReserveInput): Promise<Pico> => enforceAgentReservation(db, r, db => reserveUnchecked(db, r));
async function reserveUnchecked(db: Db, r: ReserveInput): Promise<Pico> {
  if (r.amount < 0n) fail(400, "Invalid reservation.");
  const out = await db.transaction(async (tx): Promise<{ value: Pico } | { refusal: ApiError }> => {
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, r.accountId)).for("update");
    if (!acct) fail(402, "This key has no balance. Deposit USDC to its key hash or pay per call.", "insufficient_credits");
    const available = acct.balance - acct.held + (r.creditLine ?? 0n);
    if (available < r.amount)
      fail(
        402,
        `Insufficient balance: this request may cost up to $${picoToUsd(r.amount)} and $${picoToUsd(
          acct.balance - acct.held < 0n ? 0n : acct.balance - acct.held,
        )} is available. Deposit USDC, lower max_tokens, or pay per call.`,
        "insufficient_credits",
        { required_usd: picoToUsd(r.amount), available_usd: picoToUsd(acct.balance - acct.held) },
      );
    if (r.keyHash) {
      const [k] = await tx.select().from(keys).where(eq(keys.keyHash, r.keyHash)).for("update");
      if (!k || k.disabled) fail(401, "This key is disabled.", "key_disabled");
      // A key whose credits are being closed on chain is frozen: its refund is computed from the balance that is left,
      // so nothing new may be reserved against it until that refund is settled (security review TR-08).
      const [closing] = await tx.select({ id: creditClosures.id }).from(creditClosures).where(and(eq(creditClosures.keyHash, k.keyHash), eq(creditClosures.status, "registered"))).limit(1);
      if (closing) fail(409, "This key's credits are being closed and refunded; it cannot start new calls.", "credits_closing", { closure: closing.id });
      if (k.budget != null) {
        const start = periodStart(k.budgetReset, new Date());
        let spent = k.spent;
        if (start && (!k.periodStart || k.periodStart < start)) {
          spent = 0n;
          await tx.update(keys).set({ spent: 0n, periodStart: start }).where(eq(keys.keyHash, k.keyHash));
        }
        const [{ inflight }] = await tx
          .select({ inflight: sql<string>`coalesce(sum(${holds.amount}), 0)` })
          .from(holds)
          .where(and(eq(holds.keyHash, k.keyHash), eq(holds.status, "held")));
        let budget = k.budget;
        // Auto top-up: a key that its budget would refuse, with less than its rule's threshold left, tops up first
        // (src/ledger/topup.ts). The top-up, or the note saying why there was none, is kept even when the request is
        // still refused, so a stalled key resumes once the account or the week allows.
        const topup = spent + BigInt(inflight) + r.amount > budget ? await applyTopup(tx, { ...k, spent }, `reserve:${r.id}`) : null;
        if (topup) budget = topup.limitAfter;
        if (spent + BigInt(inflight) + r.amount > budget) {
          const refusal = new ApiError(
            402,
            `This key would exceed its budget of $${picoToUsd(budget)}${k.budgetReset ? ` per ${k.budgetReset.replace(/ly$/, "")}` : ""}.`,
            "key_budget_exceeded",
            { budget_usd: picoToUsd(budget), spent_usd: picoToUsd(spent) },
          );
          if (topup?.recorded) return { refusal };
          throw refusal;
        }
      }
    }
    const existing = await tx.select({ id: holds.id }).from(holds).where(eq(holds.id, r.id));
    if (existing.length) fail(409, "This request id was already submitted.", "duplicate_request");
    await tx.insert(holds).values({
      id: r.id,
      accountId: r.accountId,
      keyHash: r.keyHash ?? null,
      amount: r.amount,
      kind: r.kind ?? "usage",
      expiresAt: new Date(Date.now() + (r.ttlMs ?? 15 * 60_000)),
    });
    return { value: r.amount };
  });
  if ("refusal" in out) throw out.refusal;
  return out.value;
}

export type SettleResult = { charged: Pico; uncovered: Pico; alreadySettled?: boolean; /** The hold had expired and was charged from the available balance. */ late?: boolean };

/** Stable log lines for the hold alarm; the monitor's rule is on the readiness warning (services/hold-watch.ts). */
export const HOLD_EXCEEDED_LOG = "hold exceeded: usage above the hold was not charged";
export const HOLD_LATE_LOG = "hold expired before its request settled; charged from the available balance";

/**
 * Close a hold, charging `actual` and never more than the hold. Idempotent: a closed hold returns its stored result.
 * A hold that expired (expireHolds) while its request was still running is charged here all the same: from what the
 * account has available now (plus any credit line), capped at the amount that was held.
 */
export async function settle(
  db: Db,
  holdId: string,
  actual: Pico,
  meta: { description?: string; generationId?: string | null; kind?: string; creditLine?: Pico } = {},
): Promise<SettleResult> {
  if (actual < 0n) fail(502, "Usage cost could not be verified.", "invalid_cost");
  return db.transaction(async (tx) => {
    const [h] = await tx.select().from(holds).where(eq(holds.id, holdId)).for("update");
    if (!h) fail(500, "Unknown hold.", "internal");
    const stored = (h.result ?? {}) as { charged?: string; uncovered?: string; expired?: boolean };
    const late = h.status === "released" && stored.expired === true;
    if (h.status !== "held" && !late) return { charged: BigInt(stored.charged ?? 0), uncovered: BigInt(stored.uncovered ?? 0), alreadySettled: true };
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, h.accountId)).for("update");
    // The caller's charge is capped at the hold. An expired hold no longer reserves anything, so its charge is also
    // capped at what the account has available now: other holds taken since are never eaten into.
    let charged = actual > h.amount ? h.amount : actual;
    if (late) {
      const available = acct.balance - acct.held + (meta.creditLine ?? 0n);
      if (charged > available) charged = available > 0n ? available : 0n;
    }
    const uncovered = actual - charged;
    if (late) log.error(HOLD_LATE_LOG, { holdId, kind: h.kind, hold: h.amount, actual, charged, uncovered });
    else if (uncovered > 0n) log.error(HOLD_EXCEEDED_LOG, { holdId, kind: h.kind, hold: h.amount, actual, uncovered });
    await tx
      .update(holds)
      .set({ status: "settled", result: { charged: charged.toString(), uncovered: uncovered.toString(), ...(late ? { expired: true, late: true } : {}) } })
      .where(eq(holds.id, holdId));
    if (charged > 0n) {
      await post(tx, {
        accountId: h.accountId,
        keyHash: h.keyHash,
        amount: -charged,
        kind: meta.kind ?? h.kind,
        ref: `settle:${holdId}`,
        description: meta.description ?? "Model usage",
        generationId: meta.generationId ?? null,
      });
      if (h.keyHash) {
        const [k] = await tx
          .update(keys)
          .set({ spent: sql`${keys.spent} + ${charged}`, spentTotal: sql`${keys.spentTotal} + ${charged}`, lastUsed: new Date() })
          .where(eq(keys.keyHash, h.keyHash))
          .returning({ keyHash: keys.keyHash, accountId: keys.accountId, budget: keys.budget, budgetReset: keys.budgetReset, spent: keys.spent, topup: keys.topup, disabled: keys.disabled, expiresAt: keys.expiresAt, teamId: keys.teamId });
        // Auto top-up after the debit, under the same key row lock (src/ledger/topup.ts).
        if (k?.topup) await applyTopup(tx, k, `settle:${holdId}`);
      }
    }
    return { charged, uncovered, ...(late ? { late: true } : {}) };
  }).finally(() => heartbeats.get(holdId)?.());
}

/** Live heartbeats by hold id: settle() and release() stop a hold's heartbeat as they close it. */
const heartbeats = new Map<string, () => void>();

/**
 * Keep a hold alive while its request is in flight (security review R3-25): every third of `ttlMs` its expiry moves to
 * `ttlMs` from now, so a slow provider, a queue wait or a receipt fetch cannot outlive it. The heartbeat stops by
 * itself once the hold is closed (or after `maxLifetimeMs`), and when the process dies the hold expires within
 * `ttlMs`, as before. Returns a function that stops it.
 */
export function keepHoldAlive(db: Db, holdId: string, ttlMs: number, maxLifetimeMs = 2 * 3_600_000, deadlineMs?: number): () => void {
  // R4-01: `deadlineMs` is the request's own deadline (its routing budget). Renewals stop there: a request that outlives
  // it is stuck, and its hold then expires within `ttlMs` and is released by the expiry job, instead of being renewed
  // for as long as `maxLifetimeMs` (two hours).
  if (deadlineMs !== undefined) maxLifetimeMs = Math.min(maxLifetimeMs, Math.max(0, deadlineMs));
  const started = Date.now();
  const every = Math.max(1_000, Math.floor(ttlMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeats.get(holdId) === stop) heartbeats.delete(holdId);
  };
  heartbeats.get(holdId)?.();
  heartbeats.set(holdId, stop);
  const beat = async () => {
    if (stopped) return;
    if (Date.now() - started >= maxLifetimeMs) return stop();
    try {
      const rows = await db
        .update(holds)
        .set({ expiresAt: new Date(Date.now() + ttlMs) })
        .where(and(eq(holds.id, holdId), eq(holds.status, "held")))
        .returning({ id: holds.id });
      if (!rows.length) return stop(); // settled or released: nothing left to keep alive
    } catch (e) {
      log.warn("hold heartbeat failed", { holdId, error: (e as Error).message.slice(0, 160) });
    }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void beat(), every);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule();
  return stop;
}

export async function release(db: Db, holdId: string) {
  heartbeats.get(holdId)?.();
  await db
    .update(holds)
    .set({ status: "released", result: { charged: "0", uncovered: "0" } })
    .where(and(eq(holds.id, holdId), eq(holds.status, "held")));
}

/** Release holds whose owners vanished (crash mid-request). Returns count. */
export async function expireHolds(db: Db) {
  const rows = await db
    .update(holds)
    .set({ status: "released", result: { charged: "0", uncovered: "0", expired: true } })
    .where(and(eq(holds.status, "held"), sql`${holds.expiresAt} < now()`))
    .returning({ id: holds.id });
  return rows.length;
}

/** Invariant check used by tests and the admin API. */
export async function verifyInvariants(db: Db) {
  const r = await db.execute(sql`
    SELECT a.id,
           a.balance AS balance,
           coalesce((SELECT sum(amount) FROM ledger l WHERE l.account_id = a.id), 0) AS ledger_sum,
           a.held AS held,
           coalesce((SELECT sum(amount) FROM holds h WHERE h.account_id = a.id AND h.status = 'held'), 0) AS held_sum
    FROM accounts a`);
  const rows = ((r as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as Array<Record<string, unknown>>;
  const bad = rows.filter((x) => BigInt(x.balance as string) !== BigInt(x.ledger_sum as string) || BigInt(x.held as string) !== BigInt(x.held_sum as string));
  return { ok: bad.length === 0, bad };
}
