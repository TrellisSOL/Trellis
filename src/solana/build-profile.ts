import { PublicKey, TransactionMessage, VersionedTransaction, type Commitment } from "@solana/web3.js";
import type { BuildProfile, IdlProgram } from "./programs/idl.ts";
import { withRetry, type RpcLike } from "./rpc.ts";

// What a deployed Trellis program says about the build it is: every program answers build_profile with the floors
// compiled into the binary (24 h timelock, 7-day proposal expiry, 30-day slash window, ... on the mainnet build; a few
// seconds or minutes on a `devnet` build). The router needs a few of them to predict what a program will accept (when a
// proposal has expired, which window the slash cap is counted over). They are read by simulating the instruction, which
// changes nothing and costs nothing, once per connection and program; a caller falls back to the mainnet value when the
// program does not answer.

const cache = new WeakMap<object, Map<string, BuildProfile>>();

/**
 * The build profile of `program` (at its own id), or null when it could not be read: no funded `payer` to simulate
 * with, an RPC that does not simulate, a program that is not deployed. A profile that was read is remembered for the
 * connection (the floors of a deployed binary change only with a program upgrade and a restart picks that up).
 */
export async function readBuildProfile(connection: RpcLike, program: IdlProgram, payer: PublicKey | string | null | undefined, commitment: Commitment = "confirmed"): Promise<BuildProfile | null> {
  const id = program.programId.toBase58();
  let perConnection = cache.get(connection);
  if (!perConnection) cache.set(connection, (perConnection = new Map()));
  const hit = perConnection.get(id);
  if (hit) return hit;
  if (!payer) return null;
  try {
    const { blockhash } = await withRetry(() => connection.getLatestBlockhash(commitment));
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [program.buildProfileInstruction()] }).compileToV0Message());
    const r = await withRetry(() => connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment }));
    const data = r.value.returnData?.data?.[0];
    const profile = !r.value.err && data ? program.decodeBuildProfile(Buffer.from(data, "base64")) : null;
    if (profile) perConnection.set(id, profile);
    return profile;
  } catch {
    return null;
  }
}

/** One floor of a program's build (seconds), or `fallback` (the mainnet value) when the program does not answer. */
export async function buildFloor(connection: RpcLike, program: IdlProgram, payer: PublicKey | string | null | undefined, floor: string, fallback: number, commitment: Commitment = "confirmed"): Promise<number> {
  const profile = await readBuildProfile(connection, program, payer, commitment);
  const v = profile ? Number(profile.floors[floor] ?? 0n) : 0;
  return v > 0 ? v : fallback;
}
