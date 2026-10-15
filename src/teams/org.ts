import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { roleAllowed, roleOf, type KeyRow, type Role } from "../api/auth.ts";
import { decodeWalletSignature, verifyWalletSignature } from "../lib/wallet-sig.ts";
import { base58Decode } from "../solana/constants.ts";
import { withRetry } from "../solana/rpc.ts";

export type TeamRow = typeof teams.$inferSelect;

/** How a team's owner address was proven: by the key's own ed25519 signature, or (a Squads vault, another program-owned wallet) by a memo transaction it signed on chain. */
export type OwnerKind = "wallet" | "multisig";

/** SPL Memo: every account passed to it must sign the instruction, so a memo with `address` among its accounts was signed by it. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Who signed `message` for `address`: "wallet" when `signature` is the ed25519 signature of the message's UTF-8 bytes by
 * the key whose base58 public key is `address`; "multisig" when `signature` is instead the signature of a confirmed
 * transaction in which `address` signed a Memo instruction (top level or inner, as a Squads vault signs through CPI)
 * whose text is exactly `message`; null otherwise. A program-derived wallet cannot sign a message off chain, so the
 * on-chain memo is its proof: the challenge's nonce and expiry are inside the message, so the transaction is single-use.
 */
export async function verifyWalletMessage(ctx: Ctx, address: string, message: string, signature: string): Promise<OwnerKind | null> {
  if (verifyWalletSignature(address, message, signature)) return "wallet";
  if (!decodeWalletSignature(signature)) return null;
  return (await memoSignedBy(ctx, address, message, signature)) ? "multisig" : null;
}

type Compiled = { programIdIndex: number; accountKeyIndexes?: number[]; accounts?: number[]; data: Uint8Array | string };

/** Whether the confirmed transaction `signature` carries a Memo instruction with text `message` that `address` signed. */
export async function memoSignedBy(ctx: Ctx, address: string, message: string, signature: string): Promise<boolean> {
  const tx = await withRetry(() => ctx.chain.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
  if (!tx || tx.meta?.err) return false;
  const msg = tx.transaction.message as { getAccountKeys?: (o: { accountKeysFromLookups?: unknown }) => { get(i: number): PublicKey | undefined }; compiledInstructions?: Compiled[]; staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[]; instructions?: Compiled[] };
  let keyAt: (i: number) => string | undefined;
  try {
    const ks = msg.getAccountKeys?.({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
    keyAt = ks ? (i) => ks.get(i)?.toBase58() : (i) => (msg.staticAccountKeys ?? msg.accountKeys ?? [])[i]?.toBase58();
  } catch { return false; }
  const expected = Buffer.from(message, "utf8");
  const dataOf = (ix: Compiled) => (typeof ix.data === "string" ? Buffer.from(base58Decode(ix.data)) : Buffer.from(ix.data));
  const matches = (ix: Compiled) => {
    if (keyAt(ix.programIdIndex) !== MEMO_PROGRAM_ID) return false;
    let data: Buffer;
    try { data = dataOf(ix); } catch { return false; }
    if (!data.equals(expected)) return false;
    return (ix.accountKeyIndexes ?? ix.accounts ?? []).some((i) => keyAt(i) === address);
  };
  const top = (msg.compiledInstructions ?? msg.instructions ?? []) as Compiled[];
  if (top.some(matches)) return true;
  const inner = (tx.meta?.innerInstructions ?? []) as unknown as { instructions: Compiled[] }[];
  return inner.some((group) => group.instructions.some(matches));
}

/** A team key's role in that team; a management key of the owning account is owner; anything else has none. */
export async function teamRoleOf(ctx: Ctx, key: KeyRow, team: TeamRow): Promise<Role | null> {
  if (key.accountId !== team.ownerAccount) return null;
  if (key.management) return "owner";
  if (key.teamId !== team.id) return null;
  return roleOf(ctx, key);
}

/** Every org-scoped route goes through here: the team must exist for the caller, and the caller's role must be allowed. */
export async function requireTeamRole(ctx: Ctx, key: KeyRow, teamId: string, allowed: Role[]) {
  const [team] = await ctx.db.select().from(teams).where(eq(teams.id, teamId));
  const role = team ? await teamRoleOf(ctx, key, team) : null;
  if (!team || !role) fail(404, "Team not found.", "not_found");
  if (!roleAllowed(role, allowed)) fail(403, `This key's role in the team (${role}) cannot do that.`, "forbidden");
  return { team, role };
}

// Readers are every org role except agent (API-only) and the legacy member; managers are admins and the owner.
export const ORG_READ: Role[] = ["owner", "admin", "dev", "viewer"];
export const ORG_ADMIN: Role[] = ["owner", "admin"];

const activeInTeam = (teamId: string, exclude?: string) =>
  and(eq(keys.teamId, teamId), eq(keys.disabled, false), or(isNull(keys.expiresAt), gt(keys.expiresAt, new Date())), exclude ? ne(keys.keyHash, exclude) : undefined);

/** The org budget already given out: the limits of the team's enabled, unexpired keys. */
export async function allocated(db: Db | Tx, teamId: string, exclude?: string): Promise<bigint> {
  const [r] = await db.select({ n: sql<string>`coalesce(sum(${keys.budget}), 0)` }).from(keys).where(activeInTeam(teamId, exclude));
  return BigInt(r?.n ?? 0);
}

/** Keys in the team with no limit at all: an org budget cannot be set while any exist. */
export async function unlimitedKeys(db: Db | Tx, teamId: string): Promise<string[]> {
  const rows = await db.select({ h: keys.keyHash }).from(keys).where(and(activeInTeam(teamId), isNull(keys.budget)));
  return rows.map((r) => r.h);
}

/** A key in a team with an org budget needs a limit, and every limit together must fit in the budget. */
export async function assertFitsOrgBudget(db: Db | Tx, teamId: string, limit: bigint | null, exclude?: string) {
  const [team] = await db.select({ budget: teams.budget }).from(teams).where(eq(teams.id, teamId));
  if (team?.budget == null) return;
  if (limit == null) fail(409, "This team has an org budget, so every key in it needs a `limit` (USD).", "org_budget_limit_required", { budget_usd: picoToUsd(team.budget) });
  const used = await allocated(db, teamId, exclude);
  if (used + limit > team.budget)
    fail(409, `That limit does not fit in the org budget: ${picoToUsd(team.budget - used > 0n ? team.budget - used : 0n)} USD of ${picoToUsd(team.budget)} USD is left.`, "org_budget_exceeded", {
      budget_usd: picoToUsd(team.budget),
      allocated_usd: picoToUsd(used),
    });
}
