import { withHostStatus } from "../webhooks/hosts.ts"; // V86: atomic host status notices.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { hash256, type Hex } from "../lib/hash.ts";
import type { Ctx } from "../context.ts";
import { generations, health, offers, providers, slashes } from "../db/schema.ts";
import { post } from "../ledger/ledger.ts";
import { allocate, mulBps, picoToUsdc, usdcToPico } from "../lib/money.ts";
import { canonicalJson, log, uid } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { SLASH_KIND, SLASH_REASONS, SLASH_SCHEDULE } from "../solana/programs/bond.ts";
import { latestCanaries } from "./canaries.ts";
import { slashEvidence } from "./evidence-schema.ts";
import { makegoodRefunds } from "./makegood-schema.ts";

// Evidence -> proposal -> dispute window -> execute; refunds affected callers from the slash first (docs §5.3).
// Evidence comes from two places: this job's own reads of the health, canary and make-good tables (empty-200 > 2% over
// 24h -> 1%; quantization fraud, 3/3 canaries -> 25% + delist; uptime < 95% over 30d -> 0.5% per day; SEALED served
// without fresh attestation -> 5% per incident) and the `slash_evidence` queue the shadow and canary-evidence jobs fill
// (shadow_mismatch -> 50% + ejection, quantization_swap -> 25% + delist). Each proposal is filed on chain as
// trellis_bond::propose_slash(reason code, schedule bps, evidence root, refund share) against the host wallet's bond,
// with the callers' owed amount earmarked for the refund pool; the program's dispute window (72h in production, the
// configurable `dispute_window` elsewhere) sets executable_at. execute_slash is cranked once the chain says the window
// has passed and no dispute blocks it; the seized amount then refunds the affected callers on the ledger, the provider
// is delisted where the schedule says so. Disputes never block routing; a dispute unresolved for more than 72h past its
// window auto-refunds the affected callers from margin.
//
// Refunds come from a seizure the chain reports, and from nothing else (security review round 3, R3-28). A bond is what
// trellis_bond holds for the host wallet: the router's own `providers.bond_usdc` column is never used as one, so without
// a bond program (or for a provider with no host wallet) a proposal carries no amount. At execution the callers' pool
// is the proposal's `executed_amount` as read from the chain; when that cannot be read (no bond program, the proposal
// account gone, the RPC failing) nobody is credited, and a line is logged.

/** The router's slash kinds on the program's reason codes (Borsh variant order); kinds absent here stay off chain. */
export const KIND_CODE: Record<string, number> = { ...SLASH_KIND, quantization_swap: SLASH_KIND.quant_fraud };
/** Kinds that describe the same fault, so one open proposal covers evidence of either. */
const SAME_FAULT: Record<string, string[]> = { quant_fraud: ["quant_fraud", "quantization_swap"], quantization_swap: ["quant_fraud", "quantization_swap"] };
const sameFault = (kind: string) => SAME_FAULT[kind] ?? [kind];
/** Kinds that accrue per day or per incident: at most one proposal a day, never "one open at a time". */
const DAILY_KINDS = new Set(["uptime", "sealed_no_attestation"]);
const DAY = 86_400_000;
const WINDOW_MS = 72 * 3_600_000;

type Evidence = { kind: string; modelId: string | null; bps: number; delist: boolean; items: unknown[]; window: { from: string; to: string }; root?: Hex; extra?: Record<string, unknown> };

export function evidenceRoot(items: unknown[]): Hex {
  const leaves = (items.length ? items : [{ empty: true }]).map((i) => hash256(hash256(canonicalJson(i))));
  return new MerkleTree(leaves).root;
}

/** The bps the program accepts for a kind: exact for fixed-rate reasons, a positive multiple of the unit otherwise. */
export function scheduledBps(kind: string, requested: number): number | null {
  const code = KIND_CODE[kind];
  const schedule = code === undefined ? null : SLASH_SCHEDULE[SLASH_REASONS[code]];
  if (!schedule) return requested > 0 ? requested : null;
  if (!schedule.perUnit) return schedule.unitBps;
  const units = Math.max(1, Math.floor(requested / schedule.unitBps));
  return Math.min(10_000, units * schedule.unitBps);
}

export async function gatherEvidence(ctx: Ctx, providerId: string, now = Date.now()): Promise<Evidence[]> {
  const out: Evidence[] = [];
  const since24 = new Date(now - DAY);
  // Empty-200 rate over 24h (traffic only), minimum sample 50.
  const e = await ctx.db
    .select({ modelId: health.modelId, n: sql<number>`count(*)::int`, empty: sql<number>`count(*) FILTER (WHERE ${health.empty200})::int`, callers: sql<number>`count(DISTINCT ${health.caller}) FILTER (WHERE ${health.empty200})::int` })
    .from(health)
    .where(and(eq(health.providerId, providerId), eq(health.source, "traffic"), gte(health.ts, since24)))
    .groupBy(health.modelId);
  const total = e.reduce((a, r) => a + r.n, 0);
  const empty = e.reduce((a, r) => a + r.empty, 0);
  // Evidence must come from several independent callers so one account can't get a provider slashed.
  const callers = e.reduce((a, r) => Math.max(a, r.callers), 0);
  if (total >= 50 && empty / total > ctx.cfg.routing.empty200SlashThreshold && callers >= 5)
    out.push({ kind: "empty200", modelId: null, bps: 100, delist: false, items: e.map((r) => ({ model: r.modelId, requests: r.n, empty200: r.empty })), window: { from: since24.toISOString(), to: new Date(now).toISOString() } });

  // Quantization fraud: the three most recent canaries all mismatch.
  const modelIds = (await ctx.db.select({ m: offers.modelId }).from(offers).where(eq(offers.providerId, providerId))).map((r) => r.m);
  const latest = await latestCanaries(ctx, providerId, modelIds, 3);
  for (const [modelId, list] of latest) {
    if (list.length === 3 && list.every((c) => c.quantMatch === false))
      out.push({
        kind: "quant_fraud",
        modelId,
        bps: 2500,
        delist: true,
        items: list.map((c) => ({ model: modelId, ts: c.ts.toISOString(), guess: c.quantGuess, distance: c.distance, detail: c.detail })),
        window: { from: list[2].ts.toISOString(), to: list[0].ts.toISOString() },
      });
  }

  // Uptime over 30 days, minimum sample 1000 events.
  const since30 = new Date(now - 30 * DAY);
  const [u] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, ok: sql<number>`count(*) FILTER (WHERE ${health.ok})::int` })
    .from(health)
    .where(and(eq(health.providerId, providerId), gte(health.ts, since30), sql`(${health.ok} OR (${health.errorKind} IS DISTINCT FROM 'rejected' AND ${health.errorKind} IS DISTINCT FROM 'rate_limited'))`));
  if (u && u.n >= 1000 && u.ok / u.n < ctx.cfg.routing.uptimeSlashThreshold)
    out.push({ kind: "uptime", modelId: null, bps: 50, delist: false, items: [{ events: u.n, ok: u.ok, uptime: u.ok / u.n }], window: { from: since30.toISOString(), to: new Date(now).toISOString() } });

  // SEALED served without fresh attestation: every make-good refund the `unattested_lane` rule issued in the last 24h
  // is one incident (5% each). The refund rows carry ids and amounts only; the proposal's items are their ids.
  const unattested = await ctx.db
    .select({ id: makegoodRefunds.id, issuedAt: makegoodRefunds.issuedAt })
    .from(makegoodRefunds)
    .where(and(eq(makegoodRefunds.providerId, providerId), eq(makegoodRefunds.rule, "unattested_lane"), eq(makegoodRefunds.status, "issued"), gte(makegoodRefunds.issuedAt, since24)))
    .orderBy(asc(makegoodRefunds.issuedAt));
  if (unattested.length)
    out.push({ kind: "sealed_no_attestation", modelId: null, bps: Math.min(10_000, 500 * unattested.length), delist: false, items: unattested.map((r) => ({ refund: r.id, issued_at: r.issuedAt?.toISOString() ?? null })), window: { from: since24.toISOString(), to: new Date(now).toISOString() } });
  return out;
}

/** An open proposal (or today's, for daily kinds) for this provider, fault and model, if any. */
async function openProposal(ctx: Ctx, providerId: string, kind: string, modelId: string | null, now: number) {
  const [open] = await ctx.db
    .select({ id: slashes.id })
    .from(slashes)
    .where(
      and(
        eq(slashes.providerId, providerId),
        inArray(slashes.kind, sameFault(kind)),
        ...(modelId ? [eq(slashes.modelId, modelId)] : []),
        DAILY_KINDS.has(kind) ? gte(slashes.proposedAt, new Date(now - DAY)) : inArray(slashes.status, ["proposed", "disputed"]),
      ),
    );
  return open ?? null;
}

/** Record a proposal, pull traffic where the schedule delists, file it on chain. Returns the proposal's report line. */
async function propose(ctx: Ctx, p: typeof providers.$inferSelect, bond: bigint, ev: Evidence, now: number) {
  const bps = scheduledBps(ev.kind, ev.bps) ?? ev.bps;
  const amount = (bond * BigInt(bps)) / 10_000n;
  const root = ev.root ?? evidenceRoot(ev.items);
  const id = uid("slash_");
  const evidence = { ...(ev.extra ?? {}), items: ev.items, window: ev.window, bond: bond.toString(), bps };
  // What the affected callers paid, capped by the slash: the share the proposal earmarks for the refund pool.
  const owed = (await affectedCallers(ctx, { providerId: p.id, modelId: ev.modelId, kind: ev.kind, evidence })).reduce((a, c) => a + BigInt(c.cost), 0n);
  const owedUsdc = picoToUsdc(owed, "ceil");
  const refundShare = owedUsdc < amount ? owedUsdc : amount;
  await ctx.db.insert(slashes).values({ id, providerId: p.id, modelId: ev.modelId, kind: ev.kind, amountUsdc: amount, delist: ev.delist, evidenceRoot: root, evidence, executableAt: new Date(now + WINDOW_MS) });
  // A delisting fault stops real traffic to that model on this provider right away (it stays in shadow, still
  // canaried). The provider is delisted only when the slash executes.
  if (ev.delist && ev.modelId) {
    await ctx.db.update(offers).set({ status: "shadow", updatedAt: new Date() }).where(and(eq(offers.providerId, p.id), eq(offers.modelId, ev.modelId)));
    await ctx.catalog.refresh();
  }
  let chain: unknown = null;
  const code = KIND_CODE[ev.kind];
  if (amount > 0n && code !== undefined && ctx.chain.address("providerBond") && p.operator) {
    try {
      chain = await ctx.chain.proposeSlash(p.operator, code, bps, root, refundShare);
      const r = chain as { submitted: boolean; slashId?: string | null; hash?: string; windowEnd?: bigint | null };
      if (r.submitted) {
        // The chain's window (config.dispute_window from the proposal's clock) is what execute_slash will enforce.
        const executableAt = r.windowEnd ? new Date(Number(r.windowEnd) * 1000) : new Date(now + WINDOW_MS);
        await ctx.db.update(slashes).set({ onchainId: r.slashId ?? null, txHash: r.hash ?? null, executableAt }).where(eq(slashes.id, id));
      }
    } catch (e) {
      log.error("slash proposal failed on-chain", { provider: p.id, error: (e as Error).message });
    }
  }
  log.warn("slash proposed", { provider: p.id, kind: ev.kind, amount: amount.toString() });
  return { id, provider: p.id, kind: ev.kind, amount_usdc: amount.toString(), bps, refund_share_usdc: refundShare.toString(), evidence_root: root, chain };
}

/**
 * The slash_evidence queue for one provider: every pending row becomes a proposal under the schedule its reason
 * carries, or joins the proposal already open for the same fault and model. Rows are marked proposed with the
 * proposal's id; a row whose reason the schedule does not know is dismissed.
 */
async function consumeEvidence(ctx: Ctx, p: typeof providers.$inferSelect, bond: bigint, now: number, proposed: unknown[]) {
  const rows = await ctx.db.select().from(slashEvidence).where(and(eq(slashEvidence.providerId, p.id), eq(slashEvidence.status, "pending"))).orderBy(asc(slashEvidence.createdAt), asc(slashEvidence.id));
  const picked = new Date(now);
  for (const row of rows) {
    if (KIND_CODE[row.reason] === undefined) {
      await ctx.db.update(slashEvidence).set({ status: "dismissed", pickedUpAt: picked }).where(eq(slashEvidence.id, row.id));
      log.warn("slash evidence dismissed: unknown reason", { provider: p.id, reason: row.reason });
      continue;
    }
    const open = await openProposal(ctx, p.id, row.reason, row.modelId, now);
    if (open) {
      await ctx.db.update(slashEvidence).set({ status: "proposed", slashId: open.id, pickedUpAt: picked }).where(eq(slashEvidence.id, row.id));
      continue;
    }
    const ev = row.evidence as { items?: unknown[]; window?: { from: string; to: string } } & Record<string, unknown>;
    const { items: _i, window: _w, ...extra } = ev;
    const r = await propose(ctx, p, bond, { kind: row.reason, modelId: row.modelId, bps: row.bps, delist: row.delist, items: Array.isArray(ev.items) ? ev.items : [], window: ev.window ?? { from: row.windowFrom.toISOString(), to: row.windowTo.toISOString() }, root: row.evidenceRoot as Hex, extra: { ...extra, evidence_id: row.id } }, now);
    await ctx.db.update(slashEvidence).set({ status: "proposed", slashId: r.id, pickedUpAt: picked }).where(eq(slashEvidence.id, row.id));
    proposed.push({ ...r, evidence_id: row.id });
  }
}

/** Create proposals (at most one open per provider x fault x model; daily kinds once a day), then crank the ready ones. */
export async function runSlasher(ctx: Ctx, now = Date.now()) {
  // Execute matured proposals first so a delisted provider is not re-proposed.
  const executed = await executeReady(ctx, now);
  const autoRefunded = await autoRefundStaleDisputes(ctx, now);
  const live = await ctx.db.select().from(providers).where(inArray(providers.status, ["live", "shadow"]));
  const proposed: unknown[] = [];
  const onChain = !!ctx.chain.address("providerBond");
  for (const p of live) {
    // The bond is the chain's figure or nothing: no bond program, no host wallet or no bond account all mean zero.
    let bond = 0n;
    if (onChain && p.operator) {
      try {
        bond = (await ctx.chain.bondOf(p.operator)) ?? 0n;
      } catch (e) {
        // Unreadable now: leave this provider's evidence for the next run instead of proposing against a guess.
        log.warn("slasher skipped a provider: its bond could not be read from the chain", { provider: p.id, error: (e as Error).message });
        continue;
      }
    }
    await consumeEvidence(ctx, p, bond, now, proposed);
    for (const ev of await gatherEvidence(ctx, p.id, now)) {
      if (await openProposal(ctx, p.id, ev.kind, ev.modelId, now)) continue;
      proposed.push(await propose(ctx, p, bond, ev, now));
    }
  }
  // Evidence against a provider that is no longer live or shadow (delisted, suspended, gone) has nothing to slash.
  const liveIds = live.map((p) => p.id);
  const dismissed = await ctx.db
    .update(slashEvidence)
    .set({ status: "dismissed", pickedUpAt: new Date(now) })
    .where(and(eq(slashEvidence.status, "pending"), ...(liveIds.length ? [sql`${slashEvidence.providerId} NOT IN (${sql.join(liveIds.map((id) => sql`${id}`), sql`, `)})`] : [])))
    .returning({ id: slashEvidence.id });
  return { proposed, executed, autoRefunded, dismissed: dismissed.map((d) => d.id) };
}

type SlashLike = { providerId: string; modelId: string | null; kind: string; evidence: unknown };

/** Callers who paid for affected generations: those named by the evidence (shadow) or served in the window (quantization). */
async function affectedCallers(ctx: Ctx, s: SlashLike) {
  const ev = s.evidence as { window?: { from: string; to: string }; items?: { generation_id?: unknown }[] };
  if (s.kind === "shadow_mismatch") {
    const ids = (ev.items ?? []).map((i) => i.generation_id).filter((g): g is string => typeof g === "string");
    if (!ids.length) return [];
    return ctx.db
      .select({ accountId: generations.accountId, cost: sql<string>`sum(${generations.cost})` })
      .from(generations)
      .where(and(eq(generations.providerId, s.providerId), inArray(generations.id, ids)))
      .groupBy(generations.accountId);
  }
  const w = ev.window;
  if (!w || !sameFault("quant_fraud").includes(s.kind)) return [];
  return ctx.db
    .select({ accountId: generations.accountId, cost: sql<string>`sum(${generations.cost})` })
    .from(generations)
    .where(and(eq(generations.providerId, s.providerId), ...(s.modelId ? [eq(generations.modelId, s.modelId)] : []), gte(generations.ts, new Date(w.from)), lte(generations.ts, new Date(w.to))))
    .groupBy(generations.accountId);
}

async function refund(ctx: Ctx, s: typeof slashes.$inferSelect, pool: bigint, tag: string) {
  const callers = (await affectedCallers(ctx, s)).filter((c) => c.accountId);
  if (!callers.length || pool <= 0n) return 0n;
  const owed = callers.map((c) => BigInt(c.cost));
  const totalOwed = owed.reduce((a, b) => a + b, 0n);
  const budget = pool < totalOwed ? pool : totalOwed;
  const parts = allocate(budget, owed);
  let paid = 0n;
  for (let i = 0; i < callers.length; i++) {
    if (parts[i] <= 0n) continue;
    const ok = await post(ctx.db, { accountId: callers[i].accountId!, amount: parts[i], kind: "refund", ref: `${tag}:${s.id}:${callers[i].accountId}`, description: `Refund: ${s.kind} by ${s.providerId}` });
    if (ok) paid += parts[i];
  }
  return paid;
}

async function executeReady(ctx: Ctx, now: number) {
  const ready = await ctx.db.select().from(slashes).where(and(inArray(slashes.status, ["proposed", "disputed", "auto_refunded"]), lte(slashes.executableAt, new Date(now))));
  const out: unknown[] = [];
  const onChain = !!ctx.chain.address("providerBond");
  let chainTime: number | null = null;
  for (const s of ready) {
    let chain: unknown = null;
    if (onChain) {
      // No confirmed proposal means no seized funds to refund or final delisting.
      if (!s.onchainId) continue;
      try {
        // The program decides: the window must have passed on the chain's clock and no open dispute may block it.
        const at = await ctx.chain.slashExecutableAt(s.onchainId);
        if (at === "rejected") {
          await ctx.db.update(slashes).set({ status: "cancelled" }).where(eq(slashes.id, s.id));
          out.push({ id: s.id, cancelled: "dispute upheld" });
          continue;
        }
        if (at !== null) {
          chainTime ??= await ctx.chain.blockTimestamp();
          if (at > BigInt(chainTime)) {
            const executableAt = new Date(Number(at) * 1000);
            if (executableAt.getTime() !== s.executableAt.getTime()) await ctx.db.update(slashes).set({ executableAt }).where(eq(slashes.id, s.id));
            continue;
          }
          chain = await ctx.chain.executeSlash(s.onchainId);
          if (!(chain as { submitted: boolean }).submitted) continue;
        } else chain = { submitted: true, hash: null, already: true }; // executed on chain (or closed after execution) before this run
      } catch (e) {
        log.error("slash execution failed", { id: s.id, error: (e as Error).message });
        continue;
      }
    }
    // What the callers share is what the chain seized, not what the proposal estimated: the program cuts a rate-based
    // slash to the bond's cumulative cap (at most half of a bond per 30 days, whatever the number of proposals), so an
    // execution can take less than `amountUsdc`, or nothing. Fail closed: with no seizure read from the chain there is
    // no figure to refund from, so nobody is credited. The estimate is never a substitute.
    let seized: bigint | null = null;
    let unread = "no bond program is configured";
    if (onChain && s.onchainId) {
      let after: Awaited<ReturnType<typeof ctx.chain.slashOnChain>>;
      try {
        after = await ctx.chain.slashOnChain(s.onchainId);
      } catch (e) {
        // The execution may have landed; what it took is unknown. Not finalised: the next run reads it again.
        log.warn("slash refund withheld: no seizure could be read from the chain; retrying next run", { id: s.id, error: (e as Error).message });
        continue;
      }
      if (after && !after.executed) {
        log.warn("slash refund withheld: no seizure is recorded on the chain yet; retrying next run", { id: s.id });
        continue;
      }
      if (after) seized = after.executedAmount < s.amountUsdc ? after.executedAmount : s.amountUsdc;
      else unread = "the proposal account is gone";
    }
    if (seized === null) log.warn("slash refund withheld: no seizure read from the chain, so nothing is refunded", { id: s.id, provider: s.providerId, reason: unread });
    const refunded = s.refunded > 0n ? s.refunded : seized === null ? 0n : await refund(ctx, s, usdcToPico(seized), "slashrefund");
    await ctx.db.update(slashes).set({ status: "executed", executedAt: new Date(now), refunded }).where(eq(slashes.id, s.id));
    if (s.delist) {
      await withHostStatus(ctx, s.providerId, db => db.update(providers).set({ status: "delisted", updatedAt: new Date() }).where(eq(providers.id, s.providerId)));
      await ctx.db.update(offers).set({ status: "disabled" }).where(eq(offers.providerId, s.providerId));
    }
    out.push({ id: s.id, refunded: refunded.toString(), ...(seized === null ? { seized_usdc: null, unread } : seized !== s.amountUsdc ? { seized_usdc: seized.toString(), capped: true } : {}), chain });
  }
  if (out.length) await ctx.catalog.refresh();
  return out;
}

async function autoRefundStaleDisputes(ctx: Ctx, now: number) {
  const stale = await ctx.db.select().from(slashes).where(and(eq(slashes.status, "disputed"), lte(slashes.executableAt, new Date(now - WINDOW_MS))));
  const out: unknown[] = [];
  for (const s of stale) {
    // Refund from margin: the router eats it; the dispute continues but callers are made whole.
    const callers = await affectedCallers(ctx, s);
    const total = callers.reduce((a, c) => a + BigInt(c.cost), 0n);
    const refunded = await refund(ctx, s, total, "disputerefund");
    await ctx.db.update(slashes).set({ status: "auto_refunded", refunded }).where(eq(slashes.id, s.id));
    out.push({ id: s.id, refunded: refunded.toString() });
  }
  return out;
}

export { mulBps };
