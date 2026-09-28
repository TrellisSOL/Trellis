import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import type { Hex } from "../lib/hash.ts";
import { canonical, log } from "../lib/util.ts";
import { hostBondSpec } from "../solana/account-specs.ts";
import { bondEvents, bondPdas, type BondEventRecord, type HostBond } from "../solana/programs/bond.ts";
import { parseProgramLogs } from "../solana/programs/encoding.ts";
import { isSignaturePageLimit, pageSignatures, withRetry, type RpcLike } from "../solana/rpc.ts";
import { isVerifiedAccountError, readVerifiedAccount } from "../solana/verified-account.ts";
import { hostBondCursor, hostBondEvents, hostBondProjection } from "./bond-schema.ts";
import { quarantine, resolveQuarantine } from "../solana/credits-indexer.ts";
import { indexerQuarantine } from "../solana/credits-schema.ts";
import { applyBondEvent, bondScope, type BondState } from "./bond-state.ts";
/** One trellis_bond event: `txHash` is the transaction signature, `block` the slot, `blockHash` the slot's blockhash. */
export type IndexedBondLog = { event: string; args: Record<string, unknown>; txHash: string; logIndex: number; block: bigint; blockHash: string };
export type BondIndexChain = {
  tip(): Promise<{ head: bigint; final: bigint }>;
  hash(block: bigint): Promise<string | null>;
  logs(from: bigint, to: bigint): Promise<IndexedBondLog[]>;
  /** Transactions the last `logs` calls could not read (and what became of them), handed over once. */
  takeUnread?(): BondUnread[];
};
/** A bond transaction that could not be read: not served by the node (the pass fails), or its log undecodable (stepped past). */
export type BondUnread = { signature: string; slot: number; reason: "tx_unavailable" | "log_truncated" | "log_malformed"; read?: boolean };

/**
 * A finalized trellis_bond signature whose transaction the RPC node does not serve. Passing over it would lose whatever
 * it did (an `Unbonded`, a `SlashExecuted`) for good, because the scan range moves on (security re-review RR-14). The
 * pass fails instead: the cursor stays where it is and the next pass asks again.
 */
export class BondTransactionUnavailableError extends Error {
  readonly code = "bond_transaction_unavailable";
  constructor(readonly signature: string, readonly slot: number) {
    super(`trellis_bond transaction ${signature} (slot ${slot}) is not served by the RPC node yet`);
    this.name = "BondTransactionUnavailableError";
  }
}
/**
 * The trellis_bond program's events between two slots, read through getSignaturesForAddress (newest first, paged until a
 * signature older than `from`) and each transaction's log messages. Failed transactions emit nothing.
 *
 * Only events the configured bond program itself emitted are read (security review TR-01): a `Program data:` line
 * another program logged in a transaction that merely names trellis_bond is not a bond event. A truncated or
 * inconsistent log is reported at error level and yields nothing. An event that names a `bond` address is dropped unless
 * that address is the program's HostBond PDA for the host it names, and the events that change what the router believes
 * about a host (`Bonded`, `Unbonded`, `SlashExecuted`) are also checked against the on-chain HostBond account (owner- and
 * PDA-checked, at finalized). When the signature walk cannot reach `from` within its page limit the pass fails
 * (SignaturePageLimitError): the cursor never moves past signatures that were not read (TR-16). A transaction the node
 * does not serve fails the pass too (BondTransactionUnavailableError, RR-14); one whose log cannot be decoded is stepped
 * past and reported (`takeUnread`), so a single unreadable transaction cannot hold the indexer for ever, and it is
 * written to indexer_quarantine where the monitor sees it.
 */
export function bondIndexChain(ctx: Ctx, o: { maxPages?: number; pageSize?: number } = {}): BondIndexChain {
  const rpc = ctx.chain.connection;
  const program = ctx.cfg.hostBonds.address ? new PublicKey(ctx.cfg.hostBonds.address) : null;
  let unread: BondUnread[] = [];
  return {
    takeUnread: () => { const out = unread; unread = []; return out; },
    tip: () => ctx.chain.escrowFinality(ctx.cfg.hostBonds.finality),
    hash: block => ctx.chain.blockHashAt(block),
    logs: async (fromSlot, toSlot) => {
      if (!program) return [];
      const sigs: { signature: string; slot: number }[] = [];
      outer: for await (const page of pageSignatures(rpc, program, { commitment: "finalized", maxPages: o.maxPages, limit: o.pageSize })) {
        for (const s of page) {
          if (BigInt(s.slot) < fromSlot) break outer;
          if (BigInt(s.slot) <= toSlot && !s.err) sigs.push({ signature: s.signature, slot: s.slot });
        }
      }
      const out: IndexedBondLog[] = [];
      const bonds = new Map<string, HostBond | null>();
      for (const s of sigs.reverse()) {
        const tx = await withRetry(() => rpc.getTransaction(s.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
        if (!tx) { unread.push({ signature: s.signature, slot: s.slot, reason: "tx_unavailable" }); throw new BondTransactionUnavailableError(s.signature, s.slot); }
        unread.push({ signature: s.signature, slot: s.slot, reason: "tx_unavailable", read: true }); // read now, if it ever waited
        if (tx.meta?.err) continue;
        const logs = tx.meta?.logMessages ?? [];
        const parsed = parseProgramLogs(logs);
        if (parsed.truncated || parsed.malformed) {
          log.error("host bond indexer: a transaction's log cannot be decoded; none of its events were recorded", { tx: s.signature, slot: tx.slot, reason: parsed.truncated ? "log_truncated" : "log_malformed" });
          unread.push({ signature: s.signature, slot: s.slot, reason: parsed.truncated ? "log_truncated" : "log_malformed" });
          continue;
        }
        const blockHash = (await ctx.chain.blockHashAt(BigInt(tx.slot))) ?? "";
        let i = 0;
        for (const e of bondEvents(program, logs)) {
          const logIndex = i++; // the position among the program's events, kept whether or not the event is accepted
          const problem = await bondEventProblem(rpc, program, e, bonds);
          if (problem) { log.error("host bond indexer: an event does not match the chain and was dropped", { tx: s.signature, slot: tx.slot, event: e.event, problem }); continue; }
          out.push({ event: e.event, args: canonical(e.args) as Record<string, unknown>, txHash: s.signature, logIndex, block: BigInt(tx.slot), blockHash });
        }
      }
      return out;
    },
  };
}

/** Events that change the router's view of a host's bond: these are checked against the on-chain HostBond account. */
const CONFIRMED_ON_CHAIN = new Set(["Bonded", "Unbonded", "SlashExecuted"]);

/**
 * Why a decoded bond event must not be believed, or null. `bond` must be the configured program's ["bond", host] PDA for
 * the host the event names; for the events in CONFIRMED_ON_CHAIN the HostBond account must exist at that address, be
 * owned by the program and derive that address from its own `host` (and name the same host as the event).
 */
export async function bondEventProblem(rpc: Pick<RpcLike, "getAccountInfo">, program: PublicKey, e: BondEventRecord, cache: Map<string, HostBond | null> = new Map()): Promise<string | null> {
  const a = e.args as { bond?: string; hostId?: string };
  if (typeof a.bond !== "string") return null; // program-level events (config, pause) name no bond
  let host: PublicKey | null = null;
  if (typeof a.hostId === "string") {
    try { host = new PublicKey(Buffer.from(a.hostId.replace(/^0x/, ""), "hex")); } catch { return "host_id_invalid"; }
    if (bondPdas(program, host).bond!.toBase58() !== a.bond) return "bond_address_mismatch";
  }
  if (!CONFIRMED_ON_CHAIN.has(e.event)) return null;
  let onchain = cache.get(a.bond);
  if (onchain === undefined) {
    try { onchain = await readVerifiedAccount(rpc, new PublicKey(a.bond), hostBondSpec(program), "finalized"); }
    catch (err) { if (isVerifiedAccountError(err)) return err.code; throw err; } // an RPC failure fails the pass: nothing is guessed
    cache.set(a.bond, onchain);
  }
  if (!onchain) return "bond_account_missing";
  if (host && !onchain.host.equals(host)) return "bond_host_mismatch";
  return null;
}
export type { Hex };
export async function loadBondState(db: Db | Tx, scope: string): Promise<BondState> {
  const rows = await db.select().from(hostBondProjection).where(eq(hostBondProjection.scope, scope));
  return new Map(rows.map(r => [`${r.kind}:${r.id}`, r.data as BondState extends Map<string, infer V> ? V : never]));
}
async function saveProjection(tx: Tx, scope: string, state: BondState, keys: Set<string>) {
  for (const key of keys) {
    const [kind, id] = key.split(":");
    const data = canonical(state.get(key));
    await tx.insert(hostBondProjection).values({ scope, kind, id, data }).onConflictDoUpdate({ target: [hostBondProjection.scope, hostBondProjection.kind, hostBondProjection.id], set: { data } });
  }
}
/** Same lock serializes index passes and slash intents across replicas; persisted cursor resumes after restart. */
export async function lockBondCursor(tx: Tx, scope: string, start: bigint) {
  await tx.insert(hostBondCursor).values({ scope, block: start - 1n, checkpoints: [] }).onConflictDoNothing();
  const [cursor] = await tx.select().from(hostBondCursor).where(eq(hostBondCursor.scope, scope)).for("update");
  return cursor;
}
export async function pollHostBonds(ctx: Ctx, chain = bondIndexChain(ctx), maxRange = 2_000n, maxBatches = 10) {
  if (!ctx.cfg.hostBonds.enabled) return { skipped: "disabled" };
  if (maxRange < 1n) throw new Error("HostBond scan range must be positive.");
  // What `logs` could not read is written down after the scan's transaction has ended (never inside it): unserved
  // transactions and undecodable ones go to indexer_quarantine; one that has been read since is cleared.
  const noteUnread = async () => {
    const list = chain.takeUnread?.() ?? [];
    const readNow = list.filter((u) => u.read);
    if (readNow.length) {
      const open = new Set((await ctx.db.select({ signature: indexerQuarantine.signature }).from(indexerQuarantine).where(and(eq(indexerQuarantine.contract, "bond"), eq(indexerQuarantine.reason, "tx_unavailable"), isNull(indexerQuarantine.resolvedAt))).catch(() => [])).map((r) => r.signature));
      for (const u of readNow) if (open.has(u.signature)) await resolveQuarantine(ctx, "bond", u.signature, "recorded").catch(() => undefined);
    }
    for (const u of list.filter((x) => !x.read)) await quarantine(ctx, "bond", { signature: u.signature, slot: u.slot, reason: u.reason, real: u.reason === "tx_unavailable" ? null : true }).catch(() => undefined);
  };
  try {
    const result = await scanHostBonds(ctx, chain, maxRange, maxBatches);
    await noteUnread();
    return result;
  } catch (e) {
    await noteUnread();
    if (e instanceof BondTransactionUnavailableError) {
      log.error("host bond indexer: a finalized transaction is not served by the RPC node; nothing was recorded and the cursor did not move", { tx: e.signature, slot: e.slot });
      return { recorded: 0, reorg: false, block: null, caught_up: false, tx_unavailable: true };
    }
    // The signature walk could not reach the start of the range: the pass rolled back, so the cursor did not move.
    if (!isSignaturePageLimit(e)) throw e;
    log.error("host bond indexer: signature paging hit its page limit before reaching the scan range; nothing was recorded and the cursor did not move", { pages: e.pages, signatures_read: e.read });
    return { recorded: 0, reorg: false, block: null, caught_up: false, page_limit_hit: true };
  }
}
async function scanHostBonds(ctx: Ctx, chain: BondIndexChain, maxRange: bigint, maxBatches: number) {
  const scope = bondScope(ctx.cfg), start = ctx.cfg.hostBonds.startBlock;
  return ctx.db.transaction(async tx => {
    const cursor = await lockBondCursor(tx, scope, start);
    const tip = await chain.tip();
    const confirmed = tip.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
    const safe = tip.final < confirmed ? tip.final : confirmed;
    let block = cursor.block;
    let points = cursor.checkpoints as { block: string; hash: string }[];
    let state = await loadBondState(tx, scope);
    const changed = new Set<string>();
    let reorg = false;
    // Blockhashes are base58 and compared exactly: case is significant.
    if (block >= start && (!cursor.blockHash || (await chain.hash(block)) !== cursor.blockHash)) {
      reorg = true;
      block = start - 1n;
      for (const point of [...points].reverse()) if ((await chain.hash(BigInt(point.block))) === point.hash) { block = BigInt(point.block); break; }
      points = points.filter(p => BigInt(p.block) <= block);
      await tx.delete(hostBondEvents).where(and(eq(hostBondEvents.scope, scope), gt(hostBondEvents.block, block)));
      await tx.delete(hostBondProjection).where(eq(hostBondProjection.scope, scope));
      state = new Map();
      const retained = await tx.select().from(hostBondEvents).where(eq(hostBondEvents.scope, scope)).orderBy(asc(hostBondEvents.block), asc(hostBondEvents.logIndex));
      for (const e of retained) for (const key of applyBondEvent(state, { ...e, args: e.args as Record<string, unknown> })) changed.add(key);
    }
    if (block > safe) {
      await saveProjection(tx, scope, state, changed);
      await tx.update(hostBondCursor).set({ block, blockHash: block >= start ? await chain.hash(block) : null, checkpoints: points, checkedAt: new Date(0) }).where(eq(hostBondCursor.scope, scope));
      return { recorded: 0, reorg, block: block.toString(), caught_up: false };
    }
    let recorded = 0;
    let hash = block >= start ? await chain.hash(block) : null;
    for (let batch = 0; block < safe && batch < maxBatches; batch++) {
      const from = block + 1n;
      const to = block + maxRange < safe ? block + maxRange : safe;
      const before = await chain.hash(to);
      if (!before) throw new Error("HostBond scan block is unavailable.");
      const logs = (await chain.logs(from, to)).sort((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
      const blockHashes = new Map<bigint, string>();
      for (const e of logs) {
        if (e.block < from || e.block > to) throw new Error("HostBond RPC returned a log outside the scan range.");
        if (!blockHashes.has(e.block)) blockHashes.set(e.block, (await chain.hash(e.block)) ?? "");
        if (blockHashes.get(e.block) !== e.blockHash) throw new Error("HostBond RPC returned a noncanonical log.");
        const inserted = await tx.insert(hostBondEvents).values({ ...e, scope }).onConflictDoNothing().returning();
        if (inserted.length) { recorded++; for (const key of applyBondEvent(state, e)) changed.add(key); }
      }
      if ((await chain.hash(to)) !== before) throw new Error("HostBond chain changed during scan; retry.");
      block = to; hash = before; points.push({ block: block.toString(), hash }); points = points.slice(-128);
    }
    await saveProjection(tx, scope, state, changed);
    // Never give old/backfilling data a fresh timestamp. A reorg and its replacement projection commit together.
    await tx.update(hostBondCursor).set({ block, blockHash: hash, checkpoints: points, checkedAt: block >= safe ? new Date() : new Date(0) }).where(eq(hostBondCursor.scope, scope));
    return { recorded, reorg, block: block.toString(), caught_up: block >= safe };
  });
}
