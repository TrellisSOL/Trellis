import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { ADDRESS_RE } from "./constants.ts";
import type { RpcLike } from "./rpc.ts";

// Sponsored accounts (docs/Trellis_Backend.md §Fee payer): which program-owned accounts the fee payer sponsors, each
// pinned to a reviewed program hash. A sponsored operation is only paid for when the account's owner program is the
// reviewed build (sha256 of the program's executable bytes equals `runtimeHash`) and that program can no longer change:
// an upgradeable program with its upgrade authority removed, or a program under a non-upgradeable loader.

export const accountRuntimeSchema = z.array(z.strictObject({
  sender: z.string().regex(ADDRESS_RE, "must be a base58 address"),
  runtimeHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a 32-byte hex hash"),
})).max(256).refine(entries => new Set(entries.map(e => e.sender)).size === entries.length, "duplicate sponsored account");
export type ReviewedAccount = z.infer<typeof accountRuntimeSchema>[number];

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const NON_UPGRADEABLE_LOADERS = [new PublicKey("BPFLoader2111111111111111111111111111111111"), new PublicKey("BPFLoader1111111111111111111111111111111111")];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export type ProgramReview = { program: string; hash: string; immutable: boolean } | null;

/** The owner program of `account`, its executable bytes' sha256 and whether it can still be upgraded; null when unreadable. */
export async function programReview(reader: Pick<RpcLike, "getAccountInfo">, account: PublicKey): Promise<ProgramReview> {
  const info = await reader.getAccountInfo(account);
  if (!info) return null;
  const program = info.owner;
  const p = await reader.getAccountInfo(program);
  if (!p || !p.executable) return null;
  if (p.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    // Program account: u32 enum (2 = Program) | programdata address. ProgramData: u32 enum (3) | u64 slot | Option<Pubkey> authority | bytes.
    if (p.data.length < 36 || p.data.readUInt32LE(0) !== 2) return null;
    const programData = await reader.getAccountInfo(new PublicKey(p.data.subarray(4, 36)));
    if (!programData || programData.data.length < 45 || programData.data.readUInt32LE(0) !== 3) return null;
    const hasAuthority = programData.data[12] === 1;
    return { program: program.toBase58(), hash: hex(sha256(programData.data.subarray(45))), immutable: !hasAuthority };
  }
  if (NON_UPGRADEABLE_LOADERS.some((l) => l.equals(p.owner))) return { program: program.toBase58(), hash: hex(sha256(p.data)), immutable: true };
  return null;
}

/** Whether `sender` is a reviewed, immutable sponsored account: listed in the policy and owned by the pinned, frozen program build. */
export async function reviewedAccount(op: { sender: string }, policy: ReviewedAccount[], reader: Pick<RpcLike, "getAccountInfo">): Promise<boolean> {
  const entry = policy.find((e) => e.sender === op.sender);
  if (!entry) return false;
  try {
    const review = await programReview(reader, new PublicKey(op.sender));
    return !!review && review.immutable && review.hash === entry.runtimeHash.toLowerCase();
  } catch {
    return false;
  }
}
