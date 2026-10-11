import type { Ctx } from "../context.ts";
import { sha256 } from "../lib/util.ts";
import { pollCredits, processEvents as processCreditEvents, recordEvents as recordCreditEvents, type IndexedEvent } from "./credits-indexer.ts";

// The program-event indexer the worker schedules as "chain-indexer": trellis_credits deposits into chain_events and the
// ledger (src/solana/credits-indexer.ts). Other programs are read by their own jobs (host bonds: network/bond-indexer.ts).

/** A stable 32-byte id for a string (hex, no prefix); the on-chain programs hash the same way (sha256 of UTF-8). */
export const idHash = (id: string) => sha256(id);

export const recordEvents = (ctx: Ctx, events: IndexedEvent[]) => recordCreditEvents(ctx, events);

export async function pollChain(ctx: Ctx, _maxRange = 2_000n) {
  return pollCredits(ctx);
}

export const processEvents = (ctx: Ctx, filter: { chainKeyHash?: string; retry?: boolean } = {}) => processCreditEvents(ctx, filter);

/**
 * Compare every key's ledger deposits with its on-chain CreditAccount.deposited_total (security review TR-01, fix 3).
 * `ok: false` means credited balance is not backed by the chain (or could not be checked): settlement must not pay out.
 */
export { reconcileDeposits, type DepositMismatch } from "./credits-indexer.ts";
