import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { chainCursor, chainEvents, keys, kv, ledger } from "../db/schema.ts";
import { post } from "../ledger/ledger.ts";
import { picoToUsdc, usdcToPico } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { creditAccountSpec } from "./account-specs.ts";
import { creditClosures, indexerQuarantine } from "./credits-schema.ts";
import { creditsProgram, readCreditAccount, readDepositorShare, readRefundRequest, type CreditsProgram } from "./credits.ts";
import { closeCancelledEvents, closeRequestedEvents, creditsPdas, depositedEvents, expiredSweptEvents, refundPaidEvents, settledToHostEvents, spentRootCommittedEvents } from "./programs/credits.ts";
import { parseProgramLogs, toHex0x } from "./programs/encoding.ts";
import { nextSignatureBatch, withRetry, type RpcLike, type SignatureWalk } from "./rpc.ts";
import { verifyAccountInfo } from "./verified-account.ts";

// The credits indexer (BullMQ job "chain-indexer", every 5s). Two things credit a deposit, and neither can credit more
// than the chain holds:
//
//   EVENTS   it walks trellis_credits' transaction signatures from the last seen one, decodes the program's Anchor events
//            from each transaction's logs and records them in chain_events (one row per signature and event position:
//            the primary key makes every event idempotent). `processEvents` turns every unprocessed `Deposited` into a
//            `kind: "deposit"` ledger row on the key's account (ledger.ref = deposit:<signature>:<index>) and every
//            `CloseRequested` into a registered closure in credit_closures.
//   STATE    `reconcileKey` reads a key's CreditAccount at finalized and credits whatever its deposited_total holds
//            beyond what the ledger has (ledger.ref = deposit:state:<key>:<total reached>). It runs for a rotating batch
//            of keys every pass, when a key is first seen, before a closure refund is computed, and for every key a
//            quarantined transaction touched.
//
// What makes an event believable (security review TR-01). getSignaturesForAddress returns every transaction that names
// the program id, and any program can log bytes shaped like a trellis_credits event, so a `Program data:` line alone is
// worth nothing. Three independent checks stand between a log line and the ledger:
//   1. attribution   only lines written while the configured credits program was on top of the invocation stack are
//                    decoded (programs/encoding.ts parseProgramLogs); a truncated or inconsistent log is undecodable.
//   2. vault delta   in the same getTransaction result, the vault token account's balance change must equal
//                    sum(Deposited) - sum(RefundPaid + SettledToHost + ExpiredSwept); otherwise nothing of that
//                    transaction is recorded.
//   3. chain state   before a Deposited row credits the ledger, the key's on-chain CreditAccount.deposited_total (read
//                    at finalized through the owner- and PDA-checked reader) must cover everything this router has
//                    credited that key hash plus this deposit; otherwise the row is marked `deposit_not_on_chain`.
// `reconcileDeposits` compares the two totals for every key afterwards, for the settlement job to halt on a difference.
//
// What keeps the walk from being stalled or abused (security re-review RR-08).
//   bounded work   a pass makes at most `maxPages` signature requests and fetches at most `maxSignatures` transactions
//                  (plus a few quarantine retries), however long the backlog. The walk position is persisted with the
//                  cursor (rpc.ts nextSignatureBatch), so a backlog larger than one pass is drained over passes and
//                  there is no page limit at which the indexer gives up.
//   cheap skips    a transaction that only NAMES the program (it never invoked it and the vault did not move) is passed
//                  over with nothing written. That is what flooding the address with transactions buys.
//   quarantine     a transaction the node will not serve, or one that did touch the program but whose log cannot be
//                  decoded or does not match the vault, is written to indexer_quarantine and stepped past: one bad
//                  transaction no longer holds up every later one. The row is retried with backoff and counted until
//                  it is resolved (readiness check `credits_indexer`, warning `indexer_quarantine`).
//   no hidden deposit  stepping past a transaction can never lose a deposit, because crediting does not depend on having
//                  read it: every CreditAccount the quarantined transaction touched is reconciled from chain state, the
//                  rotating sweep reaches every key, and both paths are bounded by deposited_total under one lock per
//                  key. A deposit whose event is never decoded is credited once, by STATE; if its event turns up later it
//                  is matched against that state credit and credits nothing more.

export const CURSOR_KEY = "credits_indexer_cursor";
/** The chain_cursor row that says how far the indexer has followed the chain (a slot); read by GET /ready. */
export const FOLLOWED_CURSOR = "main";
export const STATUS_KEY = "credits_indexer_status";
export const SWEEP_KEY = "credits_state_sweep_cursor";
export const DEPOSIT_KIND = "deposit";
export const depositRef = (signature: string, index: number) => `${DEPOSIT_KIND}:${signature}:${index}`;
/** The ledger ref of a deposit credited from chain state: the key's credited deposits were brought up to `total` units. */
export const stateDepositRef = (chainKeyHash: string, total: bigint) => `${DEPOSIT_KIND}:state:${norm(chainKeyHash)}:${total}`;
export const DEPOSIT_NOT_ON_CHAIN = "deposit_not_on_chain";
/** The on-chain account is closed and its refund was paid in full before this router knew the key: nothing is credited. */
export const CLOSED_AND_REFUNDED = "closed_and_refunded";
const EVENTS = ["Deposited", "RefundPaid", "SpentRootCommitted", "CloseRequested", "CloseCancelled"] as const;
const CONTRACT = "credits";

/** A pass steps past an unserved transaction only after it has stood in the way this many passes. */
export const UNAVAILABLE_PASSES_BEFORE_SKIP = 3;
/** Quarantined transactions retried per pass. */
export const QUARANTINE_RETRY_BATCH = 10;
/** Keys reconciled from chain state per pass (the rotating sweep). */
export const STATE_SWEEP_BATCH = 20;
/** An unresolved quarantined transaction older than this fails the readiness check. */
export const QUARANTINE_ALARM_MS = 15 * 60_000;

type Cursor = { signature: string | null; slot: string | null; walk?: SignatureWalk | null };

async function readCursor(ctx: Ctx): Promise<Cursor> {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, CURSOR_KEY));
  return (row?.value as Cursor) ?? { signature: null, slot: null };
}
const setKv = (db: Db | Tx, key: string, value: unknown) => db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
const writeCursor = (ctx: Ctx, c: Cursor) => setKv(ctx.db, CURSOR_KEY, c);

export type IndexedEvent = { txHash: string; logIndex: number; event: string; blockNumber: bigint; args: Record<string, unknown> };

/**
 * The chain_events rows of one confirmed, successful credits transaction (field names as the IDL events carry them):
 * only events the credits program at `programId` itself emitted. Log lines of any other program in the transaction,
 * and everything in a truncated log, yield nothing.
 */
export function eventsOf(programId: PublicKey | string, signature: string, slot: number, logs: readonly string[]): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  let i = 0;
  for (const d of depositedEvents(programId, logs)) out.push({ txHash: signature, logIndex: i++, event: "Deposited", blockNumber: BigInt(slot), args: { keyHash: toHex0x(d.keyHash), amount: d.amount.toString(), depositor: d.depositor.toBase58(), newBalance: d.newBalance.toString(), expiresAt: d.expiresAt.toString() } });
  for (const r of refundPaidEvents(programId, logs)) out.push({ txHash: signature, logIndex: i++, event: "RefundPaid", blockNumber: BigInt(slot), args: { keyHash: toHex0x(r.keyHash), amount: r.amount.toString(), refundTo: r.refundTo.toBase58(), depositor: r.depositor.toBase58() } });
  for (const s of spentRootCommittedEvents(programId, logs)) out.push({ txHash: signature, logIndex: i++, event: "SpentRootCommitted", blockNumber: BigInt(slot), args: { hour: s.hour.toString(), root: toHex0x(s.root), spentDelta: s.spentDelta.toString(), spentTotal: s.spentTotal.toString() } });
  for (const c of closeRequestedEvents(programId, logs)) out.push({ txHash: signature, logIndex: i++, event: "CloseRequested", blockNumber: BigInt(slot), args: { keyHash: toHex0x(c.keyHash), amount: c.amount.toString(), requestedAt: c.requestedAt.toString(), payableAt: c.payableAt.toString() } });
  for (const c of closeCancelledEvents(programId, logs)) out.push({ txHash: signature, logIndex: i++, event: "CloseCancelled", blockNumber: BigInt(slot), args: { keyHash: toHex0x(c.keyHash), amount: c.amount.toString(), by: c.by.toBase58() } });
  return out;
}

// ---- On-chain effects of one transaction ---------------------------------------------------------------------------------

type TokenBalance = { accountIndex: number; mint: string; uiTokenAmount: { amount: string } };
type CompiledIx = { programIdIndex: number };
/** The parts of a getTransaction result the indexer reads. */
export type IndexedTransaction = {
  slot: number;
  meta?: { err?: unknown; logMessages?: readonly string[] | null; preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null; innerInstructions?: readonly { instructions: readonly CompiledIx[] }[] | null; loadedAddresses?: { writable?: readonly (PublicKey | string)[]; readonly?: readonly (PublicKey | string)[] } | null } | null;
  transaction: { message: unknown } | null;
};

/** Every account key of a transaction in index order: static keys, then the lookup-table writable and readonly ones. */
function accountKeys(tx: IndexedTransaction): string[] {
  const m = (tx.transaction?.message ?? {}) as { staticAccountKeys?: readonly (PublicKey | string)[]; accountKeys?: readonly (PublicKey | string)[] };
  const text = (k: PublicKey | string) => (typeof k === "string" ? k : k.toBase58());
  const loaded = tx.meta?.loadedAddresses;
  return [...(m.staticAccountKeys ?? m.accountKeys ?? []), ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map(text);
}

/**
 * How much the token account `account` (holding `mint`) gained in this transaction, from meta.pre/postTokenBalances: the
 * entry is matched by account index -> key and by mint. An account the transaction did not touch changed by 0.
 */
export function tokenBalanceDelta(tx: IndexedTransaction, account: PublicKey, mint: PublicKey): bigint {
  const keysOf = accountKeys(tx);
  const want = account.toBase58(), wantMint = mint.toBase58();
  const amount = (list: readonly TokenBalance[] | null | undefined) => {
    const hit = (list ?? []).find((b) => keysOf[b.accountIndex] === want && b.mint === wantMint);
    return hit ? BigInt(hit.uiTokenAmount.amount) : 0n;
  };
  return amount(tx.meta?.postTokenBalances) - amount(tx.meta?.preTokenBalances);
}

/**
 * Whether the transaction ran the program at all: as a top-level instruction, as an inner (CPI) instruction, or by the
 * runtime's own `Program <id> invoke` line. A transaction that merely lists the program id among its accounts did not,
 * and cannot have changed any of the program's accounts. True when the transaction's shape cannot be read (never a
 * reason to wave something through).
 */
export function invokesProgram(tx: IndexedTransaction, programId: PublicKey): boolean {
  const id = programId.toBase58();
  if ((tx.meta?.logMessages ?? []).some((l) => l.startsWith(`Program ${id} invoke`))) return true;
  const m = tx.transaction?.message as { compiledInstructions?: readonly CompiledIx[]; instructions?: readonly CompiledIx[] } | undefined;
  const top = m?.compiledInstructions ?? m?.instructions;
  if (!m || !top || tx.meta?.logMessages == null) return true; // not enough to say no
  const keysOf = accountKeys(tx);
  const index = keysOf.indexOf(id);
  if (index < 0) return false;
  if (top.some((ix) => ix.programIdIndex === index)) return true;
  return (tx.meta?.innerInstructions ?? []).some((inner) => inner.instructions.some((ix) => ix.programIdIndex === index));
}

export type TransactionReading =
  | { status: "ok"; events: IndexedEvent[] }
  /** The log is truncated, inconsistent or missing: its events cannot be read. Nothing is recorded. */
  | { status: "undecodable"; events: []; reason: "log_truncated" | "log_malformed" | "log_missing"; vaultDelta: bigint }
  /** The vault did not move by what the events say. Nothing is recorded. */
  | { status: "vault_mismatch"; events: []; vaultDelta: bigint; expected: bigint };

/**
 * Read one finalized, successful transaction: the credits program's own events, accepted only when the vault token
 * account moved by exactly what they claim (deposits in, refunds / host settlements / expiry sweeps out).
 */
export function readCreditsTransaction(program: CreditsProgram, signature: string, tx: IndexedTransaction): TransactionReading {
  const vaultDelta = tokenBalanceDelta(tx, creditsPdas(program.programId).vault, program.mint);
  const logs = tx.meta?.logMessages;
  if (!logs) return { status: "undecodable", events: [], reason: "log_missing", vaultDelta };
  const parsed = parseProgramLogs(logs);
  if (parsed.truncated || parsed.malformed) return { status: "undecodable", events: [], reason: parsed.truncated ? "log_truncated" : "log_malformed", vaultDelta };
  const id = program.programId;
  const sum = (xs: { amount: bigint }[]) => xs.reduce((a, x) => a + x.amount, 0n);
  const expected = sum(depositedEvents(id, logs)) - sum(refundPaidEvents(id, logs)) - sum(settledToHostEvents(id, logs)) - sum(expiredSweptEvents(id, logs));
  if (vaultDelta !== expected) return { status: "vault_mismatch", events: [], vaultDelta, expected };
  return { status: "ok", events: eventsOf(id, signature, tx.slot, logs) };
}

/** Insert events; returns how many were new. */
export async function recordEvents(ctx: Ctx, events: IndexedEvent[]) {
  let n = 0;
  for (const e of events) {
    const inserted = await ctx.db.insert(chainEvents).values({ txHash: e.txHash, logIndex: e.logIndex, contract: CONTRACT, event: e.event, blockNumber: e.blockNumber, args: e.args }).onConflictDoNothing().returning({ txHash: chainEvents.txHash });
    if (inserted.length) n++;
  }
  return n;
}

export type CreditsRpc = Pick<RpcLike, "getSignaturesForAddress" | "getTransaction" | "getAccountInfo"> & Partial<Pick<RpcLike, "getMultipleAccountsInfo">>;

// ---- Quarantine ----------------------------------------------------------------------------------------------------------

export type QuarantineReason = "tx_unavailable" | "log_truncated" | "log_malformed" | "log_missing" | "vault_mismatch";
const backoffMs = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7));

/** Note one more failed attempt at a transaction; returns how many there have been. Every call is logged at error level. */
export async function quarantine(ctx: Pick<Ctx, "db">, contract: string, q: { signature: string; slot: number; reason: QuarantineReason; real: boolean | null; vaultDelta?: bigint | null }, now = new Date()): Promise<number> {
  const [row] = await ctx.db
    .insert(indexerQuarantine)
    .values({ contract, signature: q.signature, slot: BigInt(q.slot), reason: q.reason, real: q.real, vaultDelta: q.vaultDelta ?? null, attempts: 1, firstSeenAt: now, lastAttemptAt: now, nextRetryAt: new Date(now.getTime() + backoffMs(1)) })
    .onConflictDoUpdate({ target: [indexerQuarantine.contract, indexerQuarantine.signature], set: { attempts: sql`${indexerQuarantine.attempts} + 1`, reason: q.reason, real: q.real, vaultDelta: q.vaultDelta ?? null, lastAttemptAt: now, nextRetryAt: sql`${now.toISOString()}::timestamptz + (least(3600, 30 * power(2, least(${indexerQuarantine.attempts} + 1, 7))) * interval '1 second')`, resolvedAt: null, resolution: null } })
    .returning({ attempts: indexerQuarantine.attempts });
  log.error(`${contract} indexer: a transaction could not be processed and is quarantined; it is retried and counted until it is resolved`, { tx: q.signature, slot: q.slot, reason: q.reason, touched_program: q.real, vault_delta: q.vaultDelta?.toString() ?? null, attempts: row?.attempts ?? 1 });
  return row?.attempts ?? 1;
}

export const resolveQuarantine = (ctx: Pick<Ctx, "db">, contract: string, signature: string, resolution: string) =>
  ctx.db.update(indexerQuarantine).set({ resolvedAt: new Date(), resolution }).where(and(eq(indexerQuarantine.contract, contract), eq(indexerQuarantine.signature, signature)));

/** Open quarantine rows of a contract: how many, how many touched the program (or may have), and the age of the oldest. */
export async function quarantineSummary(ctx: Pick<Ctx, "db">, contract: string, now = new Date()) {
  const [row] = await ctx.db
    .select({ open: sql<number>`count(*)::int`, real: sql<number>`count(*) filter (where ${indexerQuarantine.real} is distinct from false)::int`, oldest: sql<Date | string | null>`min(${indexerQuarantine.firstSeenAt})` })
    .from(indexerQuarantine)
    .where(and(eq(indexerQuarantine.contract, contract), isNull(indexerQuarantine.resolvedAt)));
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return { open: row?.open ?? 0, real: row?.real ?? 0, oldestAgeMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : 0 };
}

/** The key hashes (bare hex) of every CreditAccount among a transaction's accounts: the keys it can have changed. */
async function creditKeysTouched(rpc: CreditsRpc, program: CreditsProgram, tx: IndexedTransaction): Promise<string[]> {
  const addresses = accountKeys(tx).slice(0, 256).map((k) => new PublicKey(k));
  const spec = creditAccountSpec(program.programId);
  const out = new Set<string>();
  const infos = rpc.getMultipleAccountsInfo
    ? (await Promise.all(Array.from({ length: Math.ceil(addresses.length / 100) }, (_, i) => withRetry(() => rpc.getMultipleAccountsInfo!(addresses.slice(i * 100, i * 100 + 100), "finalized"))))).flat()
    : await Promise.all(addresses.map((a) => withRetry(() => rpc.getAccountInfo(a, "finalized"))));
  addresses.forEach((address, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(program.programId)) return;
    try { const a = verifyAccountInfo(address, info, spec); if (a) out.add(Buffer.from(a.keyHash).toString("hex")); } catch { /* another account type of the program */ }
  });
  return [...out];
}

/** Reconcile, from chain state at or after `slot`, every known key a transaction touched. False when one could not be. */
async function reconcileTouched(ctx: Ctx, rpc: CreditsRpc, program: CreditsProgram, tx: IndexedTransaction): Promise<boolean> {
  let ok = true;
  for (const chainKeyHash of await creditKeysTouched(rpc, program, tx)) {
    const [k] = await ctx.db.select({ keyHash: keys.keyHash, chainKeyHash: keys.chainKeyHash, accountId: keys.accountId, keyAddress: keys.keyAddress }).from(keys).where(eq(keys.chainKeyHash, chainKeyHash));
    if (!k) continue; // not a key of this router (yet): reconciled when it is first seen
    const r = await reconcileKey(ctx, k, rpc, { minSlot: tx.slot }).catch((e) => ({ status: "unreadable" as const, credited: 0n, error: (e as Error).message }));
    if (r.status === "unreadable") ok = false;
  }
  return ok;
}

type Outcome = "recorded" | "failed_tx" | "not_program" | "reconciled_from_state" | "unavailable" | "unreconciled";

/**
 * Process one transaction of the walk (or one quarantine retry). Returns what became of it; `events` is how many new
 * chain_events rows it produced. Nothing here throws for a property of the transaction itself.
 */
async function processTransaction(ctx: Ctx, rpc: CreditsRpc, program: CreditsProgram, signature: string, slot: number): Promise<{ outcome: Outcome; events: number; reason?: QuarantineReason; vaultDelta?: bigint; real?: boolean }> {
  const tx = (await withRetry(() => rpc.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }))) as unknown as IndexedTransaction | null;
  if (!tx) return { outcome: "unavailable", events: 0, reason: "tx_unavailable" };
  if (tx.meta?.err) return { outcome: "failed_tx", events: 0 };
  const reading = readCreditsTransaction(program, signature, tx);
  if (reading.status === "ok") return { outcome: "recorded", events: await recordEvents(ctx, reading.events) };
  // Its events cannot be believed from this log. Did it touch the program at all?
  const real = invokesProgram(tx, program.programId) || reading.vaultDelta !== 0n;
  if (!real) return { outcome: "not_program", events: 0 };
  const reason: QuarantineReason = reading.status === "undecodable" ? reading.reason : "vault_mismatch";
  // The keys it touched are settled from chain state, at a slot that includes it: nothing it deposited can stay hidden.
  const reconciled = await reconcileTouched(ctx, rpc, program, { ...tx, slot: tx.slot ?? slot }).catch(() => false);
  return { outcome: reconciled ? "reconciled_from_state" : "unreconciled", events: 0, reason, vaultDelta: reading.vaultDelta, real: true };
}

/** Retry open quarantine rows that are due. A row is resolved once its transaction has been read and settled. */
export async function retryQuarantined(ctx: Ctx, rpc: CreditsRpc, program: CreditsProgram, limit = QUARANTINE_RETRY_BATCH, now = new Date()) {
  const due = await ctx.db.select().from(indexerQuarantine).where(and(eq(indexerQuarantine.contract, CONTRACT), isNull(indexerQuarantine.resolvedAt), lte(indexerQuarantine.nextRetryAt, now))).orderBy(asc(indexerQuarantine.nextRetryAt)).limit(limit);
  let resolved = 0, recorded = 0;
  for (const q of due) {
    const r = await processTransaction(ctx, rpc, program, q.signature, Number(q.slot)).catch(() => ({ outcome: "unavailable" as Outcome, events: 0, reason: q.reason as QuarantineReason, vaultDelta: undefined as bigint | undefined, real: undefined as boolean | undefined }));
    if (r.outcome === "unavailable" || r.outcome === "unreconciled") {
      await quarantine(ctx, CONTRACT, { signature: q.signature, slot: Number(q.slot), reason: r.reason ?? (q.reason as QuarantineReason), real: r.real ?? q.real, vaultDelta: r.vaultDelta ?? q.vaultDelta }, now);
      continue;
    }
    recorded += r.events;
    resolved++;
    await resolveQuarantine(ctx, CONTRACT, q.signature, r.outcome);
  }
  return { retried: due.length, resolved, recorded };
}

/**
 * Scan new finalized transactions of the credits program and record their events, with bounded work per pass:
 * at most `maxPages` signature requests and `maxSignatures` transactions (oldest first, in order). The cursor moves past
 * a transaction only when it was recorded, had failed on chain, provably never ran the program, or was written to the
 * quarantine. A transaction the node does not serve holds the walk for `UNAVAILABLE_PASSES_BEFORE_SKIP` passes and is
 * then quarantined too. See the top of this file for why stepping past it cannot lose a deposit.
 */
export async function pollCredits(ctx: Ctx, rpc: CreditsRpc = ctx.chain.connection, maxSignatures = 500, o: { maxPages?: number; pageSize?: number; sweep?: number; retries?: number } = {}) {
  const program = creditsProgram(ctx.cfg);
  if (!program) return { skipped: "credits program not configured" };
  const cursor = await readCursor(ctx);
  // The head this pass starts from: once the pass has reached the frontier of finalized transactions, this is the slot
  // the indexer has followed the chain to (the `chain` check of GET /ready compares it with the head).
  const headAtStart = await Promise.resolve().then(() => ctx.chain.blockNumber()).catch(() => null);
  const batch = await nextSignatureBatch(rpc, program.programId, cursor.signature ?? undefined, cursor.walk ?? null, { commitment: "finalized", limit: o.pageSize, maxPages: o.maxPages });
  let recorded = 0, scanned = 0, failedTx = 0, undecodable = 0, vaultMismatch = 0, ignored = 0, quarantined = 0, held = false;
  let last: Cursor = { signature: cursor.signature, slot: cursor.slot };
  const todo = batch.signatures.slice(0, maxSignatures);
  // Signatures of this batch that an earlier pass left in the quarantine (held as unavailable).
  const waiting = new Set(todo.length ? (await ctx.db.select({ signature: indexerQuarantine.signature }).from(indexerQuarantine).where(and(eq(indexerQuarantine.contract, CONTRACT), isNull(indexerQuarantine.resolvedAt), inArray(indexerQuarantine.signature, todo.map((x) => x.signature))))).map((x) => x.signature) : []);
  for (const s of todo) {
    scanned++;
    const step = { signature: s.signature, slot: String(s.slot) };
    if (s.err) { failedTx++; last = step; if (waiting.has(s.signature)) await resolveQuarantine(ctx, CONTRACT, s.signature, "failed_tx"); continue; }
    const r = await processTransaction(ctx, rpc, program, s.signature, s.slot);
    if (r.outcome === "unavailable") {
      // Not served at finalized by this node. It stands in the way for a few passes (the usual case: the node is a
      // moment behind), then it is quarantined and the walk goes on without it.
      const attempts = await quarantine(ctx, CONTRACT, { signature: s.signature, slot: s.slot, reason: "tx_unavailable", real: null });
      if (attempts < UNAVAILABLE_PASSES_BEFORE_SKIP) { held = true; break; }
      quarantined++;
    } else if (r.outcome === "failed_tx" || r.outcome === "not_program" || r.outcome === "recorded") {
      if (r.outcome === "failed_tx") failedTx++; else if (r.outcome === "not_program") ignored++; else recorded += r.events;
      if (waiting.has(s.signature)) await resolveQuarantine(ctx, CONTRACT, s.signature, r.outcome); // it waited here as unavailable
    } else {
      if (r.reason === "vault_mismatch") vaultMismatch++; else undecodable++;
      quarantined++;
      await quarantine(ctx, CONTRACT, { signature: s.signature, slot: s.slot, reason: r.reason!, real: true, vaultDelta: r.vaultDelta });
      // Settled from state already: the row is closed at once and stays as the record of what was stepped past.
      if (r.outcome === "reconciled_from_state") await resolveQuarantine(ctx, CONTRACT, s.signature, "reconciled_from_state");
    }
    last = step;
  }
  const moved = last.signature !== cursor.signature;
  const walk = batch.walk;
  if (moved || JSON.stringify(walk ?? null) !== JSON.stringify(cursor.walk ?? null)) await writeCursor(ctx, { ...last, walk });
  const retried = await retryQuarantined(ctx, rpc, program, o.retries ?? QUARANTINE_RETRY_BATCH).catch((e) => { log.warn("credits indexer: quarantine retry failed", { error: (e as Error).message.slice(0, 160) }); return { retried: 0, resolved: 0, recorded: 0 }; });
  const applied = await processEvents(ctx, {}, rpc);
  const swept = await sweepKeysFromState(ctx, rpc, o.sweep ?? STATE_SWEEP_BATCH).catch((e) => { log.warn("credits indexer: state sweep failed", { error: (e as Error).message.slice(0, 160) }); return { swept: 0, state_credited: "0" }; });
  const pendingPages = walk ? walk.bounds.length : 0;
  const status = { at: new Date().toISOString(), walking: !!walk, discovering: batch.discovering, pending_pages: pendingPages, held, cursor: last.signature };
  await setKv(ctx.db, STATUS_KEY, status).catch(() => undefined);
  // Followed to `headAtStart`: nothing held the walk and no backlog is left for a later pass. A pass that is still
  // walking or held leaves the cursor where it was, so readiness sees the indexer fall behind.
  if (headAtStart !== null && !held && !walk && todo.length === batch.signatures.length) {
    await ctx.db.insert(chainCursor).values({ id: FOLLOWED_CURSOR, block: headAtStart }).onConflictDoUpdate({ target: chainCursor.id, set: { block: headAtStart } }).catch(() => undefined);
  }
  if (batch.discovering) log.warn("credits indexer: the backlog does not fit one pass; the walk towards the cursor continues next pass (deposits are still credited from chain state)", { pages_so_far: pendingPages });
  return { scanned, recorded: recorded + retried.recorded, failed_tx: failedTx, undecodable, vault_mismatch: vaultMismatch, ignored, quarantined, held, page_limit_hit: false, walking: !!walk, backlog: batch.signatures.length + pendingPages * (o.pageSize ?? 1000), retried: retried.retried, resolved: retried.resolved, ...applied, ...swept, cursor: last.signature };
}

/** Whether the credits indexer is keeping up, for readiness: false while an unresolved quarantined transaction that may have touched the program is older than the alarm age. */
export async function creditsIndexerHealth(ctx: Pick<Ctx, "db">, now = new Date()) {
  const q = await quarantineSummary(ctx, CONTRACT, now);
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, STATUS_KEY));
  const status = (row?.value ?? null) as { walking?: boolean; pending_pages?: number; held?: boolean } | null;
  return { ok: !(q.real > 0 && q.oldestAgeMs > QUARANTINE_ALARM_MS), quarantined: q.open, quarantinedReal: q.real, oldestAgeMs: q.oldestAgeMs, walking: !!status?.walking, pendingPages: status?.pending_pages ?? 0 };
}

const norm = (keyHash: string) => keyHash.toLowerCase().replace(/^0x/, "");
const with0x = (keyHash: string) => `0x${norm(keyHash)}`;

type KeyRef = { keyHash: string; chainKeyHash: string; accountId: string; keyAddress?: string | null };

/**
 * USDC units of every on-chain deposit the ledger has credited to a key so far: its `deposit` rows written by this
 * indexer (ref deposit:<signature>:<index> or deposit:state:...). The ledger, not the event table, is what was credited.
 */
async function creditedDeposits(db: Db | Tx, apiKeyHash: string): Promise<bigint> {
  const [row] = await db.select({ pico: sql<string | null>`sum(${ledger.amount})::text` }).from(ledger).where(and(eq(ledger.kind, DEPOSIT_KIND), eq(ledger.keyHash, apiKeyHash), sql`${ledger.ref} like ${DEPOSIT_KIND + ":%"}`));
  return picoToUsdc(BigInt(row?.pico ?? "0"), "ceil");
}

// What the ledger holds for a key beyond the Deposited events on file: deposits credited from STATE whose events were
// never read. One row per key in chain_events stands in for them: event "Credited", tx_hash "state:<key hash>", amount =
// max(0, credited - sum of the key's Deposited events on file). Everything that sums a key's on-chain funding from
// chain_events (the spent root, what a closure may refund) therefore counts max(credited, events on file): never more
// than the chain holds (both are bounded by deposited_total), never less than the ledger. The row is recomputed, under
// the key's lock, whenever the key is credited or one of its events is processed, so it shrinks by itself when a missing
// event turns up later.
export const stateCreditRow = (chainKeyHash: string) => `state:${norm(chainKeyHash)}`;
const depositEventsOf = (chainKeyHash: string) => and(eq(chainEvents.contract, CONTRACT), eq(chainEvents.event, "Deposited"), sql`${chainEvents.args}->>'keyHash' = ${with0x(chainKeyHash)}`);
async function syncStateCreditRow(db: Db | Tx, k: KeyRef) {
  const chain = norm(k.chainKeyHash);
  const credited = await creditedDeposits(db, k.keyHash);
  const [onFile] = await db.select({ units: sql<string | null>`sum((${chainEvents.args}->>'amount')::numeric)::text` }).from(chainEvents).where(and(depositEventsOf(chain), sql`${chainEvents.error} is distinct from ${DEPOSIT_NOT_ON_CHAIN}`));
  const units = credited - BigInt(onFile?.units ?? "0");
  const at = and(eq(chainEvents.txHash, stateCreditRow(chain)), eq(chainEvents.logIndex, 0));
  if (units <= 0n) { await db.delete(chainEvents).where(at); return; }
  const args = { keyHash: with0x(chain), amount: units.toString(), source: "chain_state" };
  const [latest] = await db.select({ block: sql<string | null>`max(${chainEvents.blockNumber})::text` }).from(chainEvents).where(eq(chainEvents.contract, CONTRACT));
  await db.insert(chainEvents).values({ txHash: stateCreditRow(chain), logIndex: 0, contract: CONTRACT, event: "Credited", blockNumber: BigInt(latest?.block ?? "0"), args, processed: true, processedAt: new Date() }).onConflictDoUpdate({ target: [chainEvents.txHash, chainEvents.logIndex], set: { args } });
}

/**
 * Take the per-key lock and settle what the router knows about closures of this key, inside `tx`: every crediting path
 * runs under it, so two of them can never both credit the same deposit. Closure rows registered before the key existed
 * here get the key (which freezes it). Returns true when nothing may be credited: the key's on-chain account was closed
 * and its refund computed without a ledger to bound it (security re-review RR-12).
 */
async function lockKeyForCredit(tx: Tx, k: KeyRef): Promise<{ refundedUnbound: boolean }> {
  await tx.select({ keyHash: keys.keyHash }).from(keys).where(eq(keys.keyHash, k.keyHash)).for("update");
  const closures = await tx.select().from(creditClosures).where(eq(creditClosures.chainKeyHash, norm(k.chainKeyHash))).for("update");
  for (const c of closures) if (!c.keyHash) await tx.update(creditClosures).set({ keyHash: k.keyHash, keyAddress: k.keyAddress ?? c.keyAddress }).where(eq(creditClosures.id, c.id));
  return { refundedUnbound: closures.some((c) => c.amount != null && c.ledgerBound === false) };
}

/** The closure of a key whose on-chain account is closed is on file (and so the key is frozen) before anything is credited. */
async function ensureClosureFromState(ctx: Ctx, rpc: Pick<RpcLike, "getAccountInfo">, program: CreditsProgram, chainKeyHash: string) {
  const request = await readRefundRequest(rpc, program, chainKeyHash, "finalized");
  if (!request) return;
  await registerClosure(ctx, { chainKeyHash: norm(chainKeyHash), txHash: null, payableAt: new Date(Number(request.payableAt) * 1000) });
}

/**
 * Credit a key from chain state: whatever its CreditAccount.deposited_total (finalized; not older than `minSlot` when
 * given) holds beyond the ledger's deposits for it and beyond the Deposited events already on file and waiting. Also
 * registers a closure made directly on chain, and notices one that was cancelled there. Never credits more than the
 * chain holds; never credits a closed account whose refund was paid without a ledger.
 */
export async function reconcileKey(ctx: Ctx, k: KeyRef, rpc: Pick<RpcLike, "getAccountInfo"> = ctx.chain.connection, o: { minSlot?: number } = {}): Promise<{ status: "no_program" | "no_account" | "in_step" | "credited" | "refused" | "unreadable" | "ledger_exceeds_chain"; credited: bigint }> {
  const program = creditsProgram(ctx.cfg);
  if (!program) return { status: "no_program", credited: 0n };
  const chain = norm(k.chainKeyHash);
  const onchain = await readCreditAccount(rpc, program, chain, o.minSlot ? { commitment: "finalized", minContextSlot: o.minSlot } : "finalized");
  if (!onchain) return { status: "no_account", credited: 0n };
  if (onchain.closed) await ensureClosureFromState(ctx, rpc, program, chain);
  else {
    // An open account with a registered closure on file: cancel_close took it back on chain.
    const [open] = await ctx.db.select({ id: creditClosures.id }).from(creditClosures).where(and(eq(creditClosures.chainKeyHash, chain), eq(creditClosures.status, "registered"), isNull(creditClosures.amount)));
    // Round 4 (found on a validator): a close_account that is confirmed and not yet finalized looks exactly like this at
    // finalized (account open, no request). The closure is taken for cancelled only when the request is missing from
    // the newest view too; a closure wrongly dropped here was then debited and never paid.
    if (open && !(await readRefundRequest(rpc, program, chain, "finalized")) && !(await readRefundRequest(rpc, program, chain, "confirmed"))) await markClosureCancelled(ctx, { chainKeyHash: chain, txHash: null });
  }
  return ctx.db.transaction(async (tx) => {
    const { refundedUnbound } = await lockKeyForCredit(tx, k);
    if (refundedUnbound) return { status: "refused" as const, credited: 0n };
    const already = await creditedDeposits(tx, k.keyHash);
    // Events on file and waiting are left to credit themselves (each under its own transaction's ref); the state path
    // takes what no event on file accounts for. An event credits at most what the chain still holds beyond the ledger,
    // so whichever of the two gets to a deposit first, it is credited once.
    const waiting = await tx.select({ args: chainEvents.args }).from(chainEvents).where(and(depositEventsOf(chain), eq(chainEvents.processed, false), isNull(chainEvents.error)));
    const pending = waiting.reduce((a, r) => a + BigInt((r.args as { amount: string }).amount), 0n);
    if (onchain.depositedTotal < already) return { status: "ledger_exceeds_chain" as const, credited: 0n };
    const diff = onchain.depositedTotal - already - pending;
    if (diff <= 0n) return { status: "in_step" as const, credited: 0n };
    const total = already + diff;
    const fresh = await post(tx, { accountId: k.accountId, amount: usdcToPico(diff), kind: DEPOSIT_KIND, ref: stateDepositRef(chain, total), keyHash: k.keyHash, description: "USDC deposit (read from the chain)" });
    if (!fresh) return { status: "in_step" as const, credited: 0n };
    await syncStateCreditRow(tx, k);
    log.info("credits indexer: a deposit was credited from chain state", { key: chain.slice(0, 12), units: diff.toString(), onchain_deposited_total: onchain.depositedTotal.toString() });
    return { status: "credited" as const, credited: diff };
  });
}

/** Reconcile the next `batch` keys from chain state (a rotating sweep over every key). Bounded work per pass. */
export async function sweepKeysFromState(ctx: Ctx, rpc: Pick<RpcLike, "getAccountInfo"> = ctx.chain.connection, batch = STATE_SWEEP_BATCH) {
  if (batch <= 0) return { swept: 0, state_credited: "0" };
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, SWEEP_KEY));
  const after = ((row?.value as { keyHash?: string } | undefined)?.keyHash ?? "") as string;
  const next = await ctx.db.select({ keyHash: keys.keyHash, chainKeyHash: keys.chainKeyHash, accountId: keys.accountId, keyAddress: keys.keyAddress }).from(keys).where(gt(keys.keyHash, after)).orderBy(asc(keys.keyHash)).limit(batch);
  let credited = 0n;
  for (const k of next) {
    try { credited += (await reconcileKey(ctx, k, rpc)).credited; }
    catch (e) { log.warn("credits indexer: a key could not be reconciled from chain state; the sweep comes back to it", { key: k.chainKeyHash.slice(0, 12), error: (e as Error).message.slice(0, 160) }); }
  }
  await setKv(ctx.db, SWEEP_KEY, { keyHash: next.length < batch ? "" : next[next.length - 1]!.keyHash });
  return { swept: next.length, state_credited: credited.toString() };
}

/**
 * Apply unprocessed events: Deposited credits the key's account; CloseRequested registers the closure (or records one
 * the wallet made without asking the API first); CloseCancelled takes it off again; the others are bookkeeping only.
 *
 * A Deposited row credits the ledger only when the chain itself agrees: the key's CreditAccount.deposited_total (owner-
 * and PDA-checked, at finalized, not older than the event's slot) must be at least everything already credited to that
 * key hash plus this deposit. A row the chain does not back is marked `deposit_not_on_chain` and credits nothing, unless
 * the same deposit was already credited from chain state (then the row is simply done); when the account cannot be read
 * at all the row is left for the next pass. `filter.retry` also takes rows that failed before (a key that has just been
 * registered: its earlier deposits were marked `unknown_key`).
 */
export async function processEvents(ctx: Ctx, filter: { chainKeyHash?: string; retry?: boolean } = {}, rpc: Pick<RpcLike, "getAccountInfo"> = ctx.chain.connection) {
  const where = [eq(chainEvents.contract, CONTRACT), eq(chainEvents.processed, false), inArray(chainEvents.event, [...EVENTS])];
  // The event carries the key hash 0x-prefixed; the keys table holds it bare. Compare like with like (RR-12).
  if (filter.chainKeyHash) where.push(sql`${chainEvents.args}->>'keyHash' = ${with0x(filter.chainKeyHash)}`);
  const rows = await ctx.db.select().from(chainEvents).where(and(...where)).orderBy(asc(chainEvents.blockNumber), asc(chainEvents.logIndex));
  const program = creditsProgram(ctx.cfg);
  let applied = 0, failed = 0;
  for (const r of rows) {
    const args = r.args as Record<string, string>;
    if (!filter.retry && r.error) continue;
    const at = and(eq(chainEvents.txHash, r.txHash), eq(chainEvents.logIndex, r.logIndex));
    const mark = (error: string) => ctx.db.update(chainEvents).set({ error }).where(at);
    const done = (db: Db | Tx = ctx.db) => db.update(chainEvents).set({ processed: true, processedAt: new Date(), error: null }).where(at);
    try {
      const keyHash = norm(args.keyHash ?? "");
      if (r.event === "Deposited") {
        const [k] = await ctx.db.select({ accountId: keys.accountId, keyHash: keys.keyHash, chainKeyHash: keys.chainKeyHash, keyAddress: keys.keyAddress }).from(keys).where(eq(keys.chainKeyHash, keyHash));
        if (!k) {
          // Funded before the key was created here (self-custodial keys can be funded offline): credited once it appears.
          if (r.error !== "unknown_key") await mark("unknown_key");
          failed++;
          continue;
        }
        const units = BigInt(args.amount);
        if (!program) { failed++; continue; } // nothing to check the deposit against: left unprocessed
        let onchain: Awaited<ReturnType<typeof readCreditAccount>>;
        try {
          onchain = await readCreditAccount(rpc, program, keyHash, { commitment: "finalized", minContextSlot: Number(r.blockNumber) });
          if (onchain?.closed) await ensureClosureFromState(ctx, rpc, program, keyHash);
        } catch (e) {
          // An RPC failure (or a node behind the event's slot) says nothing about the deposit: try again next pass.
          failed++;
          log.warn("credits indexer: the CreditAccount could not be read; the deposit waits", { tx: r.txHash, index: r.logIndex, error: (e as Error).message.slice(0, 160) });
          continue;
        }
        const onchainTotal = onchain?.depositedTotal ?? 0n;
        const outcome = await ctx.db.transaction(async (tx) => {
          const { refundedUnbound } = await lockKeyForCredit(tx, k);
          if (refundedUnbound) return CLOSED_AND_REFUNDED;
          const already = await creditedDeposits(tx, k.keyHash);
          // The chain must hold this deposit on top of every other deposit of the key whose event has been accepted.
          const [accepted] = await tx.select({ units: sql<string | null>`sum((${chainEvents.args}->>'amount')::numeric)::text` }).from(chainEvents).where(and(depositEventsOf(keyHash), eq(chainEvents.processed, true)));
          if (BigInt(accepted?.units ?? "0") + units > onchainTotal) return { already };
          // It credits what the chain holds beyond the ledger, and never more than its own amount. Nothing is left to
          // add when the deposit was already credited from chain state (read from the account before its event was).
          const room = onchainTotal - already;
          const credit = room <= 0n ? 0n : units < room ? units : room;
          if (credit > 0n) await post(tx, { accountId: k.accountId, amount: usdcToPico(credit), kind: DEPOSIT_KIND, ref: depositRef(r.txHash, r.logIndex), keyHash: k.keyHash, description: `USDC deposit ${r.txHash.slice(0, 8)}…` });
          await done(tx);
          await syncStateCreditRow(tx, k);
          return credit > 0n ? "credited" : "matched";
        });
        if (outcome === CLOSED_AND_REFUNDED) {
          await mark(CLOSED_AND_REFUNDED);
          failed++;
          log.error("credits indexer: a deposit to a key that was closed and refunded before it was registered here is not credited", { tx: r.txHash, index: r.logIndex, key: keyHash.slice(0, 12) });
          continue;
        }
        if (typeof outcome === "object") {
          await mark(DEPOSIT_NOT_ON_CHAIN);
          await syncStateCreditRow(ctx.db, k).catch(() => undefined);
          failed++;
          log.error("credits indexer: a Deposited event is not backed by the key's on-chain deposited_total; nothing was credited", { tx: r.txHash, index: r.logIndex, key: keyHash.slice(0, 12), event_units: units.toString(), credited_units: outcome.already.toString(), onchain_deposited_total: onchainTotal.toString() });
          continue;
        }
        applied++;
        continue;
      }
      if (r.event === "CloseRequested") await registerClosure(ctx, { chainKeyHash: keyHash, txHash: r.txHash, payableAt: new Date(Number(args.payableAt) * 1000) });
      else if (r.event === "CloseCancelled") await markClosureCancelled(ctx, { chainKeyHash: keyHash, txHash: r.txHash });
      await done();
      applied++;
    } catch (e) {
      failed++;
      await mark("apply_failed");
      log.error("credits event apply failed", { tx: r.txHash, index: r.logIndex, error: (e as Error).message });
    }
  }
  return { applied, failed };
}

export type DepositMismatch = {
  chainKeyHash: string;
  keyHash: string;
  /** USDC units of `deposit` ledger rows for the key (what the router credited). */
  ledgerUnits: string;
  /** CreditAccount.deposited_total on chain (0 when the account does not exist); null when it could not be read. */
  onchainUnits: string | null;
  /** `ledger_exceeds_chain`: balance was credited that never reached the vault. `chain_exceeds_ledger`: deposits not credited (yet). */
  kind: "ledger_exceeds_chain" | "chain_exceeds_ledger" | "unreadable";
};

/**
 * Reconciliation (TR-01 fix 3): for every key this router has credited a deposit to, compare the ledger's deposit total
 * with the key's on-chain CreditAccount.deposited_total (owner- and PDA-checked, finalized). Returns every difference;
 * `ok` is false when any key's ledger exceeds the chain or an account could not be read, which is when settlement must
 * not pay out. Read-only: it changes nothing.
 */
export async function reconcileDeposits(ctx: Ctx, rpc: Pick<RpcLike, "getAccountInfo"> = ctx.chain.connection): Promise<{ skipped?: string; ok: boolean; checked: number; mismatches: DepositMismatch[] }> {
  const program = creditsProgram(ctx.cfg);
  if (!program) return { skipped: "credits program not configured", ok: true, checked: 0, mismatches: [] };
  const totals = await ctx.db.select({ keyHash: ledger.keyHash, pico: sql<string>`sum(${ledger.amount})::text` }).from(ledger).where(and(eq(ledger.kind, DEPOSIT_KIND), sql`${ledger.ref} like ${DEPOSIT_KIND + ":%"}`)).groupBy(ledger.keyHash);
  const mismatches: DepositMismatch[] = [];
  let checked = 0;
  for (const t of totals) {
    if (!t.keyHash) continue;
    const [k] = await ctx.db.select({ chainKeyHash: keys.chainKeyHash }).from(keys).where(eq(keys.keyHash, t.keyHash));
    if (!k?.chainKeyHash) continue;
    checked++;
    const ledgerUnits = picoToUsdc(BigInt(t.pico), "ceil");
    let onchain: bigint | null = null;
    try { onchain = (await readCreditAccount(rpc, program, k.chainKeyHash, "finalized"))?.depositedTotal ?? 0n; } catch { onchain = null; }
    if (onchain === ledgerUnits) continue;
    mismatches.push({ chainKeyHash: norm(k.chainKeyHash), keyHash: t.keyHash, ledgerUnits: ledgerUnits.toString(), onchainUnits: onchain?.toString() ?? null, kind: onchain === null ? "unreadable" : ledgerUnits > onchain ? "ledger_exceeds_chain" : "chain_exceeds_ledger" });
  }
  const ok = !mismatches.some((m) => m.kind !== "chain_exceeds_ledger");
  if (!ok) log.error("credits reconciliation: ledger deposits are not backed by on-chain deposited_total", { keys: mismatches.filter((m) => m.kind !== "chain_exceeds_ledger").length });
  return { ok, checked, mismatches };
}

/**
 * A close_account landed for `chainKeyHash`: the open closure becomes `registered` with the on-chain payable time, or a
 * row is created when the key was closed without going through the API (the refund still needs the settlement job).
 * `txHash` is null when the closure was read from the chain's accounts and not from its event.
 *
 * A key can have one closure at a time on chain (the CreditAccount is closed and its RefundRequest is one PDA per key),
 * so an open closure this router already holds for the key is that same closure. The event may be indexed after the
 * settlement job has read the RefundRequest from the chain and paid it (the indexer reads at finalized, the job at the
 * configured commitment): it then only notes the transaction on the existing row and never opens a second closure for a
 * refund that is already paid. A closure that was cancelled on chain is history: a later close_account opens a new row.
 */
export async function registerClosure(ctx: Ctx, c: { chainKeyHash: string; txHash: string | null; payableAt: Date }) {
  const chain = norm(c.chainKeyHash);
  const rows = await ctx.db.select().from(creditClosures).where(eq(creditClosures.chainKeyHash, chain));
  if (c.txHash) { const same = rows.find((r) => r.registerTx === c.txHash); if (same) return same.id; }
  const open = rows.find((r) => r.status === "queued" || r.status === "registered");
  if (open) {
    if (open.status === "queued") await ctx.db.update(creditClosures).set({ status: "registered", registerTx: c.txHash ?? open.registerTx, payableAt: c.payableAt }).where(eq(creditClosures.id, open.id));
    else if (!open.registerTx && c.txHash) await ctx.db.update(creditClosures).set({ registerTx: c.txHash }).where(eq(creditClosures.id, open.id));
    return open.id;
  }
  // Already settled (paid, or refused after a screen): the same on-chain closure, whichever way it is seen again (its
  // event, or the chain's accounts with no transaction to name). Once anything was paid a closure cannot be cancelled,
  // so a settled row is the key's last closure: keep its outcome, note the transaction, never open another.
  const settled = rows.find((r) => r.status !== "cancelled");
  if (settled) {
    if (!settled.registerTx && c.txHash) await ctx.db.update(creditClosures).set({ registerTx: c.txHash }).where(eq(creditClosures.id, settled.id));
    return settled.id;
  }
  const [k] = await ctx.db.select({ keyHash: keys.keyHash, keyAddress: keys.keyAddress }).from(keys).where(eq(keys.chainKeyHash, chain));
  const id = uid("close_");
  // refund_to stays empty: the key does not choose it. The settlement job fills in the wallets that are actually paid.
  await ctx.db.insert(creditClosures).values({ id, keyHash: k?.keyHash ?? "", chainKeyHash: chain, keyAddress: k?.keyAddress ?? "", refundTo: "", status: "registered", registerTx: c.txHash, payableAt: c.payableAt }).onConflictDoNothing();
  return id;
}

/**
 * cancel_close landed (or the chain shows the account open again with no RefundRequest): the open closure of the key is
 * `cancelled`, which unfreezes the key. A closure whose refund was already planned and debited is undone as a whole
 * (cancelPlannedClosure), and only when the chain confirms that the request the plan was made for is gone: the program
 * refuses to cancel once anything was paid, so such a closure was never paid a unit.
 */
export async function markClosureCancelled(ctx: Ctx, c: { chainKeyHash: string; txHash: string | null }) {
  const chain = norm(c.chainKeyHash);
  const updated = await ctx.db.update(creditClosures).set({ status: "cancelled", cancelTx: c.txHash, reason: "cancelled_on_chain" }).where(and(eq(creditClosures.chainKeyHash, chain), inArray(creditClosures.status, ["queued", "registered"]), isNull(creditClosures.amount))).returning({ id: creditClosures.id });
  const ids = updated.map((r) => r.id);
  const program = creditsProgram(ctx.cfg);
  const planned = await ctx.db.select({ id: creditClosures.id, plan: creditClosures.plan }).from(creditClosures).where(and(eq(creditClosures.chainKeyHash, chain), inArray(creditClosures.status, ["queued", "registered"]), isNotNull(creditClosures.amount)));
  for (const row of program ? planned : []) {
    // A stale event must not undo a later closure: look at the chain as it is (finalized) before touching a debit.
    const request = await readRefundRequest(ctx.chain.connection, program!, chain, "finalized").catch(() => undefined);
    if (request === undefined) continue;
    const bound = row.plan?.find((i) => i.request)?.request ?? null;
    if (request && (!bound || bound === request.requestedAt.toString())) continue; // the planned closure is still the one on chain
    if (await cancelPlannedClosure(ctx, program!, row.id, c.txHash)) ids.push(row.id);
  }
  return ids;
}

/**
 * Undo a closure whose refund was planned and debited but whose on-chain request is gone (security review round 3,
 * R3-06): cancel_close landed between the ledger debit and pay_refund, or before the job's next run. One database
 * transaction under the closure's row lock: what was debited and not paid goes back to the account, the plan's items
 * become `reversed` and the closure `cancelled`, which unfreezes the key. A debited refund is therefore either paid or
 * reversed; it is never left debited behind a request that no longer exists.
 *
 * The CALLER establishes from the chain that the request this plan was made for is gone (no RefundRequest with an open
 * CreditAccount, or a RefundRequest with another requested_at). What each depositor received is read from the chain
 * here; cancel_close is impossible once anything was paid, so a received amount means this is not a cancelled closure,
 * and nothing is changed (null, and an error is logged).
 */
export async function cancelPlannedClosure(ctx: Ctx, program: CreditsProgram, id: string, cancelTx: string | null = null): Promise<{ reversed: bigint } | null> {
  const [row] = await ctx.db.select().from(creditClosures).where(eq(creditClosures.id, id));
  if (!row || (row.status !== "queued" && row.status !== "registered")) return null;
  for (const item of row.plan ?? []) {
    if (item.status === "refused") continue;
    const share = await readDepositorShare(ctx.chain.connection, program, row.chainKeyHash, new PublicKey(item.depositor));
    if (share && share.refunded > BigInt(item.refundedBefore)) {
      log.error("closure refund: a planned closure looks cancelled on chain but a payment of it landed; left as it is", { id });
      return null;
    }
  }
  return ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(creditClosures).where(eq(creditClosures.id, id)).for("update");
    if (!locked || (locked.status !== "queued" && locked.status !== "registered")) return null;
    let back = 0n;
    const plan = (locked.plan ?? []).map((i) => {
      if (i.status === "refused" || i.status === "reversed") return i; // a refused item's debit was put back when it was refused
      back += BigInt(i.units);
      return { ...i, status: "reversed" as const, reason: "cancelled_on_chain" };
    });
    if (back > 0n && locked.ledgerBound !== false) {
      const [key] = await tx.select({ accountId: keys.accountId, keyHash: keys.keyHash }).from(keys).where(eq(keys.chainKeyHash, locked.chainKeyHash));
      // The ref is unique per closure: a second attempt posts nothing.
      if (key) await post(tx, { accountId: key.accountId, amount: usdcToPico(back), kind: "closure_refund", ref: `closure:${id}:cancelled`, keyHash: key.keyHash, description: "Account closure cancelled on chain; refund reversed" });
    }
    await tx.update(creditClosures).set({ status: "cancelled", cancelTx: cancelTx ?? locked.cancelTx, reason: "cancelled_on_chain", plan: locked.plan ? plan : null, amount: locked.plan ? 0n : locked.amount }).where(eq(creditClosures.id, id));
    log.info("closure refund reversed: the closure was cancelled on chain after its refund had been debited", { id, reversed: back.toString() });
    return { reversed: back };
  });
}

/** Unprocessed deposits waiting for a key that does not exist yet (funded offline), newest first. */
export async function pendingUnknownDeposits(ctx: Ctx) {
  return ctx.db.select({ txHash: chainEvents.txHash, args: chainEvents.args }).from(chainEvents).where(and(eq(chainEvents.contract, CONTRACT), eq(chainEvents.event, "Deposited"), eq(chainEvents.processed, false), eq(chainEvents.error, "unknown_key")));
}

export const programKey = (ctx: Ctx) => (ctx.cfg.chain.credits ? new PublicKey(ctx.cfg.chain.credits) : null);
