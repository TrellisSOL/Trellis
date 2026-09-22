import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { KeyRow } from "../api/auth.ts";
import type { Ctx } from "../context.ts";
import { health, providers } from "../db/schema.ts";
import { bushelPurchaseOrder, type BushelPurchaseRequest } from "../holders/priority.ts";
import { creditAccount, release, reserve, settle } from "../ledger/ledger.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { usdcToPico } from "../lib/money.ts";
import { canonicalJson, log, sha256, uid } from "../lib/util.ts";
import { GRADES, gradeOf, outputEquivalentTokens, parameterCountB, type Grade } from "../services/hvx.ts";
import { loadHvxConfig } from "../services/hvx-config.ts";
import { chainKeyHashBytes } from "../solana/keys.ts";
import { holderTier, walletOfAccount } from "../solana/tiers.ts";
import { capacityChain, type OnchainCommitment } from "./chain.ts";
import { bushelAllowances, bushelLots, bushelShortfalls } from "./schema.ts";

// Bushels (docs/Trellis_Backend.md §5.6, Overview §7): prepaid capacity. A buyer pays the fixed USDC price of a grade
// from its prepaid balance for output-equivalent tokens inside a bonded host's capacity commitment; the purchase is a
// lot bound to the buyer's key (trellis_capacity::buy_lot). Redeeming a lot (redeem_lot) turns it into an allowance
// that only reduces the cost of calls on models of that grade. There is no transfer, no cash-out and no resale: the only
// ways a lot ends are being used, lapsing with its window, being honoured on another host of the same grade, or the
// purchase price of the unserved part coming back from the host's bond. Grades are the model size classes G-S, G-M and
// G-L; the price is the per-grade figure in the program's config as it stood when the host made the commitment (the
// program fixes it on the commitment, security review round 3, R3-16), or today's figure when that is lower. Nothing here
// reads the public price index.

type Lot = typeof bushelLots.$inferSelect;
export const TOKENS_PER_BUSHEL = 1_000_000n;
const gradeName = (index: number): Grade | null => GRADES[index] ?? null;
const unix = (d: bigint) => new Date(Number(d) * 1000);
const usd = (units: bigint) => (Number(units) / 1e6).toFixed(6);

/** Price of `tokens` at a grade's fixed price per Bushel (1M tokens), in USDC base units, rounded down. */
export const listPrice = (tokens: bigint, pricePerBushel: bigint) => (tokens * pricePerBushel) / TOKENS_PER_BUSHEL;
/**
 * The price per Bushel a lot of this commitment sells at: the grade price fixed on the commitment when the host made it,
 * or today's grade price when that is lower. The program bounds what a lot may record as paid by both, so a price raised
 * after the commitment was made raises nothing here. 0 for a commitment from before prices were fixed on commitments:
 * the program sells nothing more against it.
 */
export function commitmentPrice(c: { grade: number; pricePerBushel: bigint }, config: { gradePrices: bigint[] }): bigint {
  const today = config.gradePrices[c.grade] ?? 0n;
  return c.pricePerBushel < today ? c.pricePerBushel : today;
}
/** amount x unserved / committed, rounded down: the program's own share rule for a lot of a commitment with a shortfall. */
export const proRata = (amount: bigint, unserved: bigint, committed: bigint) => (committed > 0n ? (amount * unserved) / committed : 0n);

/** The grade (model size class) of a catalogue model, or null when the catalogue does not state its size. */
export function modelGrade(ctx: Pick<Ctx, "catalog">, modelId: string): Grade | null {
  const m = ctx.catalog.models.get(modelId);
  return m ? gradeOf(parameterCountB(m), (gradeBounds ??= loadHvxConfig())) : null;
}
/** The size-class boundaries (HVX_GRADE_SMALL_MAX_B, HVX_GRADE_MEDIUM_MAX_B), read once: this runs when a call is billed. */
let gradeBounds: ReturnType<typeof loadHvxConfig> | undefined;

const disabled = () => new ApiError(503, "Prepaid capacity is not offered on this router.", "prepaid_capacity_disabled");

async function providerOf(ctx: Pick<Ctx, "db">, operator: string): Promise<string | null> {
  const [p] = await ctx.db.select({ id: providers.id }).from(providers).where(or(eq(providers.operator, operator), eq(providers.payoutAddress, operator))).limit(1);
  return p?.id ?? null;
}

// ---- open commitments -----------------------------------------------------------------------------------------------

const OUTSTANDING = ["pending", "sold", "redeemed", "claim_filed"];
/** Purchase price of every lot that has not ended yet, in USDC base units: what the issuance cap is measured against. */
export async function outstandingUnits(db: Pick<Ctx["db"], "select">, now = new Date()): Promise<bigint> {
  const [row] = await db
    .select({ v: sql<string>`coalesce(sum(${bushelLots.pricePaidUsdc}), 0)` })
    .from(bushelLots)
    .where(or(inArray(bushelLots.status, OUTSTANDING), and(eq(bushelLots.status, "rehomed"), gt(bushelLots.windowEnd, now))));
  return BigInt(row?.v ?? "0");
}

const commitmentJson = (c: OnchainCommitment, pricePerBushel: bigint, provider: string | null) => {
  const available = c.tokens - c.soldTokens;
  return {
    commitment: c.address,
    operator: c.host.toBase58(),
    provider,
    grade: gradeName(c.grade),
    tokens_committed: c.tokens.toString(),
    tokens_available: available.toString(),
    window_start: unix(c.windowStart).toISOString(),
    window_end: unix(c.windowEnd).toISOString(),
    price_usdc_per_million_tokens: usd(pricePerBushel),
  };
};

/** GET /api/v1/bushels/commitments: the commitments prepaid capacity can be bought against now. */
export async function listOpenCommitments(ctx: Ctx, now = Date.now()) {
  const cap = { cap_usd: usd(ctx.cfg.bushels.issuanceCapUnits), outstanding_usd: usd(await outstandingUnits(ctx.db, new Date(now))) };
  if (!ctx.cfg.bushels.enabled) return { enabled: false, unit: "1 Bushel = 1,000,000 output-equivalent tokens", terms: TERMS, prepaid_capacity: cap, data: [] };
  const chain = capacityChain(ctx);
  const config = await chain.config();
  const open = config && !config.paused ? (await chain.commitments()).filter((c) => c.status === "Open" && Number(c.windowEnd) * 1000 > now && c.tokens > c.soldTokens && gradeName(c.grade) && commitmentPrice(c, config) > 0n) : [];
  const data = [];
  for (const c of open.sort((a, b) => Number(a.windowEnd - b.windowEnd))) data.push(commitmentJson(c, commitmentPrice(c, config!), await providerOf(ctx, c.host.toBase58())));
  return { enabled: true, unit: "1 Bushel = 1,000,000 output-equivalent tokens", terms: TERMS, prepaid_capacity: cap, data };
}

const TERMS = "Prepaid capacity for inference. Bound to the buying key, not transferable, redeemable only for inference on models of the committed grade. If the host under-delivers, the unserved part is served by another host of the same grade or its purchase price is returned from the host's bond.";

// ---- buying ---------------------------------------------------------------------------------------------------------

export type PurchaseInput = { commitment: string; tokens: bigint };
type Pending = BushelPurchaseRequest & { key: KeyRow; input: PurchaseInput; resolve: (lot: ReturnType<typeof lotJson>) => void; reject: (e: unknown) => void };
type SaleState = { windows: Map<string, Pending[]>; tail: Promise<void> };
const sales = new WeakMap<object, SaleState>();
const saleState = (ctx: Pick<Ctx, "cfg">) => {
  let s = sales.get(ctx.cfg);
  if (!s) sales.set(ctx.cfg, (s = { windows: new Map(), tail: Promise.resolve() }));
  return s;
};

/**
 * A purchase request. Requests for one commitment that arrive inside the same sale window (BUSHEL_SALE_WINDOW_MS) are
 * served together in `bushelPurchaseOrder`: the buyer's tier priority first, then arrival, then id. Priority decides who
 * is served first when a commitment cannot serve everyone; it never changes the price or the size a buyer may ask for.
 */
export async function requestPurchase(ctx: Ctx, key: KeyRow, input: PurchaseInput, deps: { priorityOf?: (key: KeyRow) => Promise<number> } = {}): Promise<ReturnType<typeof lotJson>> {
  if (!ctx.cfg.bushels.enabled) throw disabled();
  if (input.tokens < ctx.cfg.bushels.minTokens) fail(400, `A prepaid capacity purchase is at least ${ctx.cfg.bushels.minTokens} tokens.`, "invalid_request");
  const at = new Date(); // arrival, before the tier is read
  let priority = 0;
  try { priority = deps.priorityOf ? await deps.priorityOf(key) : ((await holderTier(ctx, walletOfAccount(key.accountId)))?.sealedPriority ?? 0); } catch { /* no tier */ }
  const state = saleState(ctx);
  return new Promise((resolve, reject) => {
    const req: Pending = { id: uid("lot_"), priority, at, key, input, resolve, reject };
    const waiting = state.windows.get(input.commitment);
    if (waiting) return void waiting.push(req);
    state.windows.set(input.commitment, [req]);
    const close = () => {
      const batch = state.windows.get(input.commitment) ?? [];
      state.windows.delete(input.commitment);
      // One purchase at a time across the router: each needs the commitment's next lot id and the issuance total.
      state.tail = state.tail.then(async () => {
        for (const r of bushelPurchaseOrder(batch)) await executePurchase(ctx, r).then(r.resolve, r.reject);
      });
    };
    if (ctx.cfg.bushels.saleWindowMs > 0) setTimeout(close, ctx.cfg.bushels.saleWindowMs);
    else queueMicrotask(close);
  });
}

async function executePurchase(ctx: Ctx, req: Pending) {
  const { key, input } = req;
  const chain = capacityChain(ctx);
  const config = await chain.config();
  if (!config || config.paused) fail(503, "Prepaid capacity sales are paused.", "prepaid_capacity_paused");
  const seller = chain.saleSigner();
  if (!seller || config.saleAuthority.toBase58() !== seller) fail(503, "This router cannot record prepaid capacity sales.", "prepaid_capacity_unavailable");
  if (ctx.cfg.bushels.commitments.length && !ctx.cfg.bushels.commitments.includes(input.commitment)) fail(404, "That capacity commitment is not on offer.", "commitment_not_found");
  const c = await chain.commitment(input.commitment);
  const grade = c ? gradeName(c.grade) : null;
  if (!c || !grade) fail(404, "That capacity commitment is not on offer.", "commitment_not_found");
  const now = new Date();
  if (c.status !== "Open" || Number(c.windowEnd) * 1000 <= now.getTime()) fail(409, "That capacity commitment is closed: its window has ended.", "commitment_closed");
  const available = c.tokens - c.soldTokens;
  if (input.tokens > available) fail(409, `Only ${available} tokens of prepaid capacity are left in this commitment.`, "prepaid_capacity_sold_out", { tokens_available: available.toString() });
  // The commitment's own price (fixed when the host made it), never above today's grade price: what the program accepts.
  const perBushel = commitmentPrice(c, config);
  if (perBushel <= 0n) fail(409, "That capacity commitment is closed: nothing more is sold against it.", "commitment_closed");
  const price = listPrice(input.tokens, perBushel);
  if (price <= 0n) fail(400, "That amount of prepaid capacity costs less than the smallest USDC unit.", "invalid_request");
  // All lots of a commitment together are worth at most what the host locked for it (the program refuses more).
  if (c.paidTotal + price > c.value) fail(409, "This commitment has no value left to sell against.", "prepaid_capacity_sold_out", { tokens_available: "0" });
  if (!key.chainKeyHash) fail(400, "This key cannot hold prepaid capacity.", "invalid_request");

  // 1. Hold the price on the buyer's prepaid balance (402 when it is not there; a key budget and rulebook apply as usual).
  await reserve(ctx.db, { id: req.id, accountId: key.accountId, keyHash: key.keyHash, amount: usdcToPico(price), kind: "bushel_purchase", ttlMs: 10 * 60_000 });
  const lotAccount = chain.lotAddress(c.address, c.lotsSold);
  const operator = c.host.toBase58();
  try {
    // 2. Under one lock: the issuance cap, then the pending row that claims the commitment's next lot id.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('trellis:bushel-issuance'))`);
      const outstanding = await outstandingUnits(tx, now);
      if (outstanding + price > ctx.cfg.bushels.issuanceCapUnits)
        fail(409, "The cap on prepaid capacity outstanding has been reached. Capacity frees up as windows end.", "prepaid_capacity_cap_reached", { cap_usd: usd(ctx.cfg.bushels.issuanceCapUnits), outstanding_usd: usd(outstanding) });
      await tx.insert(bushelLots).values({
        id: req.id, commitment: c.address, lotSeq: c.lotsSold, lotAccount, operator, providerId: await providerOf({ db: tx as never }, operator),
        keyHash: key.keyHash, chainKeyHash: key.chainKeyHash, accountId: key.accountId, grade, tokens: input.tokens,
        windowStart: unix(c.windowStart), windowEnd: unix(c.windowEnd), pricePaidUsdc: price, priority: req.priority ?? 0, requestedAt: req.at as Date, status: "pending",
      });
    });
  } catch (e) {
    await release(ctx.db, req.id);
    if (e instanceof ApiError) throw e;
    fail(409, "Another purchase of this prepaid capacity is in progress. Try again.", "prepaid_capacity_busy");
  }
  // 3. Record the lot on chain, bound to the buyer's key hash. Nothing was charged if this fails.
  let tx: string;
  try {
    ({ tx } = await chain.buyLot({ commitment: c.address, lotId: c.lotsSold, keyHash: chainKeyHashBytes(key.chainKeyHash), tokens: input.tokens, pricePaid: price }));
  } catch (e) {
    await release(ctx.db, req.id);
    await ctx.db.update(bushelLots).set({ status: "failed", updatedAt: new Date() }).where(eq(bushelLots.id, req.id));
    log.warn("prepaid capacity sale not recorded", { lot: lotAccount.slice(0, 8), reason: (e as Error).message.slice(0, 160) });
    fail(502, "The prepaid capacity purchase could not be recorded. Nothing was charged.", "prepaid_capacity_not_recorded");
  }
  // 4. Charge the hold and mark the lot sold.
  await settle(ctx.db, req.id, usdcToPico(price), { description: "Prepaid capacity purchase", kind: "bushel_purchase" });
  const [lot] = await ctx.db.update(bushelLots).set({ status: "sold", buyTx: tx, updatedAt: new Date() }).where(eq(bushelLots.id, req.id)).returning();
  return lotJson(lot, null);
}

export const lotJson = (l: Lot, a: typeof bushelAllowances.$inferSelect | null) => ({
  lot: l.id,
  commitment: l.commitment,
  operator: l.operator,
  provider: l.providerId,
  grade: l.grade,
  tokens: l.tokens.toString(),
  window_start: l.windowStart.toISOString(),
  window_end: l.windowEnd.toISOString(),
  price_paid_usdc: usd(l.pricePaidUsdc),
  status: l.status,
  bound_to_key: l.keyHash,
  transferable: false as const,
  redeemed_at: l.redeemedAt?.toISOString() ?? null,
  allowance: a ? { grade: a.grade, tokens_left: a.tokensLeft.toString(), usable_from: a.usableFrom.toISOString(), usable_until: a.usableUntil.toISOString(), provider: a.providerId } : null,
  shortfall: l.unservedTokens > 0n || l.refundUsdc > 0n ? { unserved_tokens: l.unservedTokens.toString(), rehomed_to: l.rehomedTo, refund_usdc: usd(l.refundUsdc), refunded: l.status === "refunded" } : null,
  buy_tx: l.buyTx,
  redeem_tx: l.redeemTx,
});

/** The lots of a key with their allowances, newest first. */
export async function listLots(ctx: Pick<Ctx, "db">, keyHash: string) {
  const rows = await ctx.db.select({ lot: bushelLots, allowance: bushelAllowances }).from(bushelLots).leftJoin(bushelAllowances, eq(bushelAllowances.lotId, bushelLots.id)).where(and(eq(bushelLots.keyHash, keyHash), sql`${bushelLots.status} <> 'failed'`)).orderBy(sql`${bushelLots.createdAt} desc`).limit(500);
  return rows.map((r) => lotJson(r.lot, r.allowance));
}

// ---- redeeming ------------------------------------------------------------------------------------------------------

/**
 * Redeem a lot: the only exit. The lot must belong to the calling key; redeem_lot is recorded on chain and the lot
 * becomes an allowance of its grade for that key, usable on the committed host inside the window. Redeeming twice
 * answers the allowance that already exists.
 */
export async function redeemLot(ctx: Ctx, key: KeyRow, lotId: string) {
  if (!ctx.cfg.bushels.enabled) throw disabled();
  const [lot] = await ctx.db.select().from(bushelLots).where(and(eq(bushelLots.id, lotId), eq(bushelLots.keyHash, key.keyHash)));
  // A lot of another key is not found: prepaid capacity is bound to the key that bought it.
  if (!lot) fail(404, "No such prepaid capacity lot for this key.", "lot_not_found");
  const [existing] = await ctx.db.select().from(bushelAllowances).where(eq(bushelAllowances.lotId, lot.id));
  if (lot.redeemedAt) return lotJson(lot, existing ?? null);
  if (!["sold", "rehomed"].includes(lot.status)) fail(409, `This prepaid capacity lot cannot be redeemed (status ${lot.status}).`, "lot_not_redeemable");
  let tx: string;
  try {
    ({ tx } = await capacityChain(ctx).redeemLot({ lot: lot.lotAccount }));
  } catch (e) {
    log.warn("prepaid capacity redemption not recorded", { lot: lot.id, reason: (e as Error).message.slice(0, 160) });
    fail(502, "The redemption could not be recorded. Try again.", "prepaid_capacity_not_recorded");
  }
  const now = new Date();
  // A rehomed lot is worth its unserved part, on the host and inside the window it was rehomed to.
  const granted = lot.status === "rehomed" ? lot.unservedTokens : lot.tokens;
  return ctx.db.transaction(async (db) => {
    const [updated] = await db.update(bushelLots).set({ status: lot.status === "rehomed" ? "rehomed" : "redeemed", redeemTx: tx, redeemedAt: now, updatedAt: now }).where(eq(bushelLots.id, lot.id)).returning();
    const [allowance] = await db.insert(bushelAllowances).values({ lotId: lot.id, keyHash: lot.keyHash, grade: lot.grade, providerId: lot.providerId, tokensGranted: granted, tokensLeft: granted, usableFrom: lot.windowStart, usableUntil: lot.windowEnd }).onConflictDoNothing().returning();
    return lotJson(updated, allowance ?? existing ?? null);
  });
}

// ---- the allowance at billing time ----------------------------------------------------------------------------------

export type BushelAllowance = { grade: Grade; tokens: bigint; providers: string[] };

async function usableAllowances(ctx: Pick<Ctx, "db" | "catalog">, keyHash: string, modelId: string, now: Date) {
  const grade = modelGrade(ctx, modelId);
  if (!grade) return { grade: null, rows: [] };
  const rows = await ctx.db
    .select()
    .from(bushelAllowances)
    .where(and(eq(bushelAllowances.keyHash, keyHash), eq(bushelAllowances.grade, grade), gt(bushelAllowances.tokensLeft, 0n), lte(bushelAllowances.usableFrom, now), gt(bushelAllowances.usableUntil, now)))
    .orderBy(bushelAllowances.usableUntil);
  return { grade, rows };
}

/**
 * The prepaid capacity `keyHash` can use for `modelId` now: output-equivalent tokens of the model's grade from its
 * redeemed lots, and the providers that honour them (empty: any host of the grade). Null when the key has none for the
 * model's grade. An allowance never applies to a model of another grade.
 */
export async function bushelAllowanceFor(ctx: Pick<Ctx, "db" | "catalog">, keyHash: string, modelId: string, now = new Date()): Promise<BushelAllowance | null> {
  const { grade, rows } = await usableAllowances(ctx, keyHash, modelId, now);
  if (!grade || !rows.length) return null;
  return { grade, tokens: rows.reduce((a, r) => a + r.tokensLeft, 0n), providers: [...new Set(rows.map((r) => r.providerId).filter((p): p is string => !!p))] };
}

export type BushelUsage = { tokensIn: number; tokensOut: number; reasoningTokens: number; cachedTokens: number };

/**
 * Spend the key's allowance on one served call and answer what is left to charge. The call's output-equivalent tokens
 * (output and reasoning 1, input 0.25, cached input 0.05) are taken from the allowances that the serving provider
 * honours, soonest to end first; the covered share of `cost` is not charged. Returns the cost unchanged when the key
 * has no allowance for the model's grade on that provider.
 */
export async function applyBushelAllowance(ctx: Pick<Ctx, "db" | "catalog">, a: { keyHash: string; modelId: string; providerId: string; usage: BushelUsage; cost: bigint; now?: Date }): Promise<{ charge: bigint; coveredTokens: bigint; lots: string[] }> {
  const need = BigInt(Math.ceil(outputEquivalentTokens(a.usage)));
  const nothing = { charge: a.cost, coveredTokens: 0n, lots: [] as string[] };
  if (need <= 0n) return nothing;
  const now = a.now ?? new Date();
  const { rows } = await usableAllowances(ctx, a.keyHash, a.modelId, now);
  let covered = 0n;
  const lots: string[] = [];
  for (const r of rows) {
    if (covered >= need) break;
    if (r.providerId && r.providerId !== a.providerId) continue;
    const take = r.tokensLeft < need - covered ? r.tokensLeft : need - covered;
    // Guarded on the remaining amount, so two calls finishing together cannot spend the same tokens twice.
    const done = await ctx.db.update(bushelAllowances).set({ tokensLeft: sql`${bushelAllowances.tokensLeft} - ${take}`, updatedAt: now }).where(and(eq(bushelAllowances.lotId, r.lotId), sql`${bushelAllowances.tokensLeft} >= ${take}`)).returning({ lotId: bushelAllowances.lotId });
    if (!done.length) continue;
    covered += take;
    lots.push(r.lotId);
  }
  if (covered <= 0n) return nothing;
  return { charge: a.cost - (a.cost * covered) / need, coveredTokens: covered, lots };
}

// ---- after window_end: shortfalls -----------------------------------------------------------------------------------

export type Delivery = { okRate: number | null; samples: number; providerId: string | null; providerLive: boolean };

/**
 * How a host did inside a commitment's window, from the router's own health samples of that host (traffic, probes and
 * canaries; src/services/health.ts): the share of samples that succeeded.
 */
export async function measureDelivery(ctx: Pick<Ctx, "db">, c: Pick<OnchainCommitment, "host" | "windowStart" | "windowEnd">): Promise<Delivery> {
  const operator = c.host.toBase58();
  const [p] = await ctx.db.select({ id: providers.id, status: providers.status }).from(providers).where(or(eq(providers.operator, operator), eq(providers.payoutAddress, operator))).limit(1);
  if (!p) return { okRate: null, samples: 0, providerId: null, providerLive: false };
  const [row] = await ctx.db
    .select({ n: sql<string>`count(*)`, ok: sql<string>`count(*) filter (where ${health.ok})` })
    .from(health)
    .where(and(eq(health.providerId, p.id), sql`${health.ts} >= ${unix(c.windowStart)}`, sql`${health.ts} < ${unix(c.windowEnd)}`));
  const samples = Number(row?.n ?? 0);
  return { okRate: samples ? Number(row?.ok ?? 0) / samples : null, samples, providerId: p.id, providerLive: p.status === "live" };
}

/**
 * The share of its committed capacity a host failed to serve, in [0, 1]. This is the one place the under-delivery
 * rule lives:
 *   - a host with no registry entry, or one that is not live and left no health sample in the window, served nothing: 1;
 *   - a host whose share of successful samples is at least BUSHEL_MIN_UPTIME (95%, the bond schedule's uptime line)
 *     delivered: 0. Capacity a buyer did not use on a host that was up is not a shortfall;
 *   - otherwise the failed share of the samples.
 */
export function shortfallFraction(d: Delivery, minUptime: number): number {
  if (!d.providerId) return 1;
  if (d.okRate == null) return d.providerLive ? 0 : 1;
  return d.okRate >= minUptime ? 0 : Math.min(1, Math.max(0, 1 - d.okRate));
}

export type ShortfallDeps = { measure?: (c: OnchainCommitment) => Promise<Delivery> };
export type ShortfallResult = { skipped?: string; examined: number; reported: number; rehomed: number; claims_filed: number; claims_executed: number; refunded: number; closed: number; /** Reported commitments settled with release_commitment after the claim period (their bond lock is freed). */ released: number; waiting_for_authority: number; failed: number; /** The execute_slash transactions this run sent for filed claims. */ executed?: { lot: string; claim: string; tx: string }[] };

/**
 * The job. For every commitment whose window has ended: measure the host, report the unserved tokens on chain
 * (report_shortfall; 0 settles the commitment and frees the host's bond headroom), then for each lot's unserved share
 * rehome it to another open commitment of the same grade on a different host (rehome_lot) or, when there is none, file
 * the claim for `price_paid x unserved / committed` against the host's bond (claim_lot_shortfall). A filed claim is
 * executed by this job once the bond program allows it (execute_slash, after the dispute window; anyone may send it and
 * nothing else does), and the buyer's prepaid balance is credited that amount once the claim has executed. The amount
 * is always a share of what the buyer paid.
 */
export async function runBushelShortfalls(ctx: Ctx, deps: ShortfallDeps = {}, nowMs = Date.now()): Promise<ShortfallResult> {
  const out: ShortfallResult = { examined: 0, reported: 0, rehomed: 0, claims_filed: 0, claims_executed: 0, refunded: 0, closed: 0, released: 0, waiting_for_authority: 0, failed: 0 };
  if (!ctx.cfg.bushels.enabled) return { ...out, skipped: "disabled" };
  const chain = capacityChain(ctx);
  const config = await chain.config();
  if (!config) return { ...out, skipped: "capacity program not initialised" };
  const now = new Date(nowMs);
  const mayReport = !!chain.authoritySigner() && chain.authoritySigner() === config.authority.toBase58();
  const measure = deps.measure ?? ((c: OnchainCommitment) => measureDelivery(ctx, c));

  // Claims whose dispute window has passed and that the bond paid: the purchase price of the unserved part goes back to the buyer.
  for (const lot of await ctx.db.select().from(bushelLots).where(eq(bushelLots.status, "claim_filed"))) {
    try {
      if (!lot.claimRef) continue;
      let claim = await chain.claimState(lot.claimRef);
      if (claim === "open" && chain.authoritySigner()) {
        // Past its dispute window the claim only needs someone to send execute_slash: this job is that someone.
        const executed = await chain.executeClaim(lot.claimRef);
        if (executed) {
          claim = "executed";
          out.claims_executed++;
          (out.executed ??= []).push({ lot: lot.id, claim: lot.claimRef, tx: executed.tx });
          log.info("prepaid capacity claim executed", { lot: lot.id, claim: lot.claimRef.slice(0, 8), tx: executed.tx });
        }
      }
      if (claim !== "executed") continue;
      // The buyer is credited what the bond actually paid for this claim, never more (security review TR-11): a bond
      // that had less left than the claim pays less, and a refund nobody paid would come out of other keys' deposits.
      const paid = (await chain.claimExecutedAmount?.(lot.claimRef)) ?? lot.refundUsdc;
      const refund = paid < lot.refundUsdc ? paid : lot.refundUsdc;
      if (refund < lot.refundUsdc) log.warn("prepaid capacity claim paid less than was claimed", { lot: lot.id, claimed: lot.refundUsdc.toString(), paid: refund.toString() });
      if (refund > 0n) await creditAccount(ctx.db, { accountId: lot.accountId, amount: usdcToPico(refund), kind: "bushel_refund", ref: `bushel:refund:${lot.id}`, keyHash: lot.keyHash, description: "Prepaid capacity not served: purchase price returned" });
      await ctx.db.update(bushelLots).set({ status: "refunded", updatedAt: now }).where(eq(bushelLots.id, lot.id));
      out.refunded++;
    } catch (e) {
      out.failed++;
      log.warn("prepaid capacity refund failed", { lot: lot.id, reason: (e as Error).message.slice(0, 160) });
    }
  }

  // Commitments to examine: those with unsettled lots whose window ended, and offered ones that ended without a sale.
  const dueLots = await ctx.db.select().from(bushelLots).where(and(inArray(bushelLots.status, ["sold", "redeemed"]), lte(bushelLots.windowEnd, now)));
  const addresses = new Set(dueLots.map((l) => l.commitment));
  const offered = await chain.commitments();
  for (const c of offered) if (c.status === "Open" && Number(c.windowEnd) * 1000 <= nowMs) addresses.add(c.address);

  for (const address of addresses) {
    try {
      let c = await chain.commitment(address);
      if (!c) continue;
      const grade = gradeName(c.grade);
      if (!grade) continue;
      out.examined++;
      if (c.status === "Open") {
        if (!mayReport) { out.waiting_for_authority++; continue; }
        const d = await measure(c);
        const fraction = c.soldTokens > 0n ? shortfallFraction(d, ctx.cfg.bushels.minUptime) : 0;
        const unserved = fraction >= 1 ? c.tokens : (c.tokens * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
        const evidence = { format: "trellis.capacity-shortfall/1", commitment: address, operator: c.host.toBase58(), provider: d.providerId, grade, window_start: Number(c.windowStart), window_end: Number(c.windowEnd), tokens: c.tokens.toString(), sold_tokens: c.soldTokens.toString(), samples: d.samples, ok_rate: d.okRate, min_uptime: ctx.cfg.bushels.minUptime, unserved_tokens: unserved.toString() };
        const { tx } = await chain.reportShortfall({ commitment: c, unservedTokens: unserved });
        const values = { operator: c.host.toBase58(), providerId: d.providerId, grade, tokens: c.tokens, soldTokens: c.soldTokens, unservedTokens: unserved, okRate: d.okRate, samples: d.samples, evidenceDigest: sha256(canonicalJson(evidence)), reportTx: tx, status: unserved > 0n ? "reported" : "served", updatedAt: now };
        await ctx.db.insert(bushelShortfalls).values({ commitment: address, ...values }).onConflictDoUpdate({ target: bushelShortfalls.commitment, set: values });
        out.reported++;
        c = { ...c, status: unserved > 0n ? "ShortfallReported" : "Settled", unservedTokens: unserved };
      }
      const lots = dueLots.filter((l) => l.commitment === address);
      if (c.status === "Settled") {
        // The host delivered: an allowance ends with its window, and a lot nobody redeemed has lapsed.
        if (lots.length) await ctx.db.update(bushelLots).set({ status: "closed", updatedAt: now }).where(inArray(bushelLots.id, lots.map((l) => l.id)));
        out.closed += lots.length;
        await ctx.db.update(bushelShortfalls).set({ status: c.unservedTokens > 0n ? "settled" : "served", updatedAt: now }).where(eq(bushelShortfalls.commitment, address));
        continue;
      }
      if (!mayReport) { out.waiting_for_authority++; continue; }
      const [record] = await ctx.db.select().from(bushelShortfalls).where(eq(bushelShortfalls.commitment, address));
      let left = 0;
      for (const lot of lots) {
        try {
          const unserved = proRata(lot.tokens, c.unservedTokens, c.tokens);
          if (unserved <= 0n) {
            await ctx.db.update(bushelLots).set({ status: "closed", updatedAt: now }).where(eq(bushelLots.id, lot.id));
            out.closed++;
            continue;
          }
          const [allowance] = await ctx.db.select().from(bushelAllowances).where(eq(bushelAllowances.lotId, lot.id));
          // Another host of the same grade with room for the unserved part, whose window is still open.
          const replacement = (await chain.commitments())
            .filter((r) => r.address !== address && !r.host.equals(c!.host) && r.grade === c!.grade && r.status === "Open" && Number(r.windowEnd) * 1000 > nowMs && r.tokens - r.soldTokens >= unserved)
            .sort((a, b) => Number(b.tokens - b.soldTokens - (a.tokens - a.soldTokens)))[0];
          if (replacement) {
            const { tx } = await chain.rehomeLot({ commitment: address, lot: lot.lotAccount, replacement: replacement.address });
            const operator = replacement.host.toBase58();
            const providerId = await providerOf(ctx, operator);
            const window = { windowStart: unix(replacement.windowStart), windowEnd: unix(replacement.windowEnd) };
            await ctx.db.update(bushelLots).set({ status: "rehomed", unservedTokens: unserved, rehomedTo: replacement.address, shortfallTx: tx, operator, providerId, ...window, updatedAt: now }).where(eq(bushelLots.id, lot.id));
            // A redeemed lot keeps what the buyer had not used, up to the unserved part, on the new host and window.
            if (allowance) await ctx.db.update(bushelAllowances).set({ tokensLeft: allowance.tokensLeft < unserved ? allowance.tokensLeft : unserved, providerId, usableFrom: window.windowStart, usableUntil: window.windowEnd, updatedAt: now }).where(eq(bushelAllowances.lotId, lot.id));
            out.rehomed++;
          } else {
            const evidenceHash = new Uint8Array(Buffer.from(record?.evidenceDigest ?? sha256(canonicalJson({ commitment: address, unserved_tokens: c.unservedTokens.toString() })), "hex"));
            const { tx, claim } = await chain.claimLotShortfall({ commitment: c, lot: lot.lotAccount, evidenceHash });
            // The program's figure: price_paid x unserved / committed. Never anything but a share of the price paid.
            await ctx.db.update(bushelLots).set({ status: "claim_filed", unservedTokens: unserved, refundUsdc: proRata(lot.pricePaidUsdc, c.unservedTokens, c.tokens), shortfallTx: tx, claimRef: claim, updatedAt: now }).where(eq(bushelLots.id, lot.id));
            out.claims_filed++;
          }
        } catch (e) {
          left++;
          out.failed++;
          log.warn("prepaid capacity shortfall step failed", { lot: lot.id, reason: (e as Error).message.slice(0, 160) });
        }
      }
      if (!left) await ctx.db.update(bushelShortfalls).set({ status: "settled", updatedAt: now }).where(eq(bushelShortfalls.commitment, address));
    } catch (e) {
      out.failed++;
      log.warn("prepaid capacity shortfall check failed", { commitment: address.slice(0, 8), reason: (e as Error).message.slice(0, 160) });
    }
  }
  // Release pass (security review TR-11, TR-25): a commitment with a reported shortfall keeps its value locked in the
  // host's bond so buyers' claims can be paid. Once the program's claim period has passed and every lot of it has been
  // handled here (rehomed, claimed or closed), the lock is released; the program refuses anything earlier. Claims already
  // filed are proposals on the bond and still block a withdrawal until they execute.
  if (chain.releaseCommitment) {
    for (const c of await chain.commitments()) {
      if (c.status !== "ShortfallReported" || nowMs < (Number(c.windowEnd) + ctx.cfg.bushels.claimPeriodS) * 1000) continue;
      try {
        const [unhandled] = await ctx.db.select({ id: bushelLots.id }).from(bushelLots).where(and(eq(bushelLots.commitment, c.address), inArray(bushelLots.status, ["sold", "redeemed"]))).limit(1);
        if (unhandled) continue;
        if (await chain.releaseCommitment({ commitment: c })) out.released++;
      } catch (e) {
        out.failed++;
        log.warn("prepaid capacity release failed", { commitment: c.address.slice(0, 8), reason: (e as Error).message.slice(0, 160) });
      }
    }
  }
  out.failed += await reconcilePending(ctx, nowMs);
  return out;
}

/**
 * Purchases left `pending` by a crash between the hold and the chain: when the lot account exists with this key and
 * size the sale happened, so it is charged and marked sold; otherwise the row is marked failed (its hold has expired).
 */
export async function reconcilePending(ctx: Ctx, nowMs = Date.now()): Promise<number> {
  const stale = await ctx.db.select().from(bushelLots).where(and(eq(bushelLots.status, "pending"), lte(bushelLots.createdAt, new Date(nowMs - 15 * 60_000))));
  let failed = 0;
  for (const lot of stale) {
    try {
      const onchain = await capacityChain(ctx).lot(lot.lotAccount);
      const ours = onchain && Buffer.from(onchain.keyHash).toString("hex") === lot.chainKeyHash.replace(/^0x/, "") && onchain.tokens === lot.tokens;
      if (ours) {
        await creditOrDebit(ctx, lot);
        await ctx.db.update(bushelLots).set({ status: "sold", updatedAt: new Date(nowMs) }).where(eq(bushelLots.id, lot.id));
      } else await ctx.db.update(bushelLots).set({ status: "failed", updatedAt: new Date(nowMs) }).where(eq(bushelLots.id, lot.id));
    } catch (e) {
      failed++;
      log.warn("prepaid capacity reconcile failed", { lot: lot.id, reason: (e as Error).message.slice(0, 160) });
    }
  }
  return failed;
}

/** Charge a recorded sale whose hold was never settled: settle the hold when it is still open, else a fresh hold for the same lot. */
async function creditOrDebit(ctx: Ctx, lot: Lot) {
  const amount = usdcToPico(lot.pricePaidUsdc);
  const r = await settle(ctx.db, lot.id, amount, { description: "Prepaid capacity purchase", kind: "bushel_purchase" });
  if (r.charged >= amount) return;
  // The first hold expired. settle() still charges an expired hold from what the account has available (security review
  // R3-25), so only the part it could not charge is left to collect. A balance that can no longer cover that part
  // leaves the lot pending for an operator.
  const rest = amount - r.charged;
  const retry = `${lot.id}:late`;
  await reserve(ctx.db, { id: retry, accountId: lot.accountId, keyHash: lot.keyHash, amount: rest, kind: "bushel_purchase" }).catch((e) => { if (!(e instanceof ApiError) || e.type !== "duplicate_request") throw e; });
  await settle(ctx.db, retry, rest, { description: "Prepaid capacity purchase", kind: "bushel_purchase" });
}

export function registerBushelJob(ctx: Ctx) {
  if (!ctx.cfg.bushels.enabled) return;
  ctx.jobs.register("bushel-shortfalls", ctx.cfg.bushels.shortfallIntervalMs, () => runBushelShortfalls(ctx));
}

/** The issuance figures an operator sees (GET /api/v1/admin/bushels). */
export async function bushelStatus(ctx: Ctx) {
  const outstanding = await outstandingUnits(ctx.db);
  const byStatus = await ctx.db.select({ status: bushelLots.status, n: sql<string>`count(*)`, usdc: sql<string>`coalesce(sum(${bushelLots.pricePaidUsdc}), 0)` }).from(bushelLots).groupBy(bushelLots.status);
  return {
    enabled: ctx.cfg.bushels.enabled,
    prepaid_capacity: { cap_usd: usd(ctx.cfg.bushels.issuanceCapUnits), outstanding_usd: usd(outstanding) },
    lots: Object.fromEntries(byStatus.map((r) => [r.status, { count: Number(r.n), price_paid_usdc: usd(BigInt(r.usdc)) }])),
    shortfalls: (await ctx.db.select().from(bushelShortfalls).orderBy(sql`${bushelShortfalls.examinedAt} desc`).limit(100)).map((s) => ({ commitment: s.commitment, operator: s.operator, provider: s.providerId, grade: s.grade, tokens: s.tokens.toString(), sold_tokens: s.soldTokens.toString(), unserved_tokens: s.unservedTokens.toString(), ok_rate: s.okRate, samples: s.samples, evidence_digest: s.evidenceDigest, report_tx: s.reportTx, status: s.status })),
  };
}
