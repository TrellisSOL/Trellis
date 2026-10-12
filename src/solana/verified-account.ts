import { PublicKey, SystemProgram, type AccountInfo, type Commitment, type GetAccountInfoConfig } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { withRetry, type RpcLike } from "./rpc.ts";

// The one way the router reads an account it is going to believe. Account data is just bytes: any program can create an
// account whose first eight bytes are another program's discriminator and whose fields say whatever its author likes.
// What makes an account a Tab (or a CreditAccount, a HostBond, ...) is that the program owns it and that it lives at the
// address the program derives for those fields. Both are checked here, for every read:
//   owner    info.owner must be the expected program                       -> account_owner_mismatch
//   type     the data must decode as the expected account type             -> account_type_mismatch
//   address  the address must be the PDA re-derived from the decoded seeds -> account_address_mismatch
// A missing account is null (so is a system-owned address with no data: lamports sent to a closed account's address).

export type VerifiedAccountErrorCode = "account_owner_mismatch" | "account_type_mismatch" | "account_address_mismatch";

export class VerifiedAccountError extends Error {
  readonly code: VerifiedAccountErrorCode;
  readonly address: string;
  readonly account: string;
  constructor(code: VerifiedAccountErrorCode, account: string, address: PublicKey, detail: string) {
    super(`${account} ${address.toBase58()}: ${detail} (${code})`);
    this.name = "VerifiedAccountError";
    this.code = code;
    this.account = account;
    this.address = address.toBase58();
  }
}
export const isVerifiedAccountError = (e: unknown): e is VerifiedAccountError => e instanceof VerifiedAccountError;

export type AccountSpec<T> = {
  /** The account type, for error messages ("Tab", "CreditAccount"). */
  name: string;
  /** The program that must own the account. */
  owner: PublicKey;
  /** Decode the data; null when it is not this account type. */
  decode: (data: Uint8Array) => T | null;
  /** The address the account must live at: the PDA of its decoded seed fields, or a fixed address (a config PDA). */
  derive: PublicKey | ((decoded: T) => PublicKey);
};

type Info = Pick<AccountInfo<Buffer | Uint8Array>, "owner" | "data">;
/** A commitment, or the RPC's own read config (`minContextSlot` makes a node that is behind refuse instead of answering stale). */
export type ReadAt = Commitment | GetAccountInfoConfig;

const absent = (info: Info | null | undefined): info is null | undefined => !info || (info.data.length === 0 && info.owner.equals(SystemProgram.programId));

/** Check account bytes already fetched (getMultipleAccountsInfo, getProgramAccounts) the same way. Null when absent. */
export function verifyAccountInfo<T>(address: PublicKey, info: Info | null | undefined, spec: AccountSpec<T>): T | null {
  if (absent(info)) return null;
  if (!info.owner.equals(spec.owner)) throw new VerifiedAccountError("account_owner_mismatch", spec.name, address, `owned by ${info.owner.toBase58()}, not by ${spec.owner.toBase58()}`);
  let decoded: T | null;
  try { decoded = spec.decode(new Uint8Array(info.data)); } catch { decoded = null; }
  if (decoded === null) throw new VerifiedAccountError("account_type_mismatch", spec.name, address, `the data is not a ${spec.name}`);
  let expected: PublicKey;
  try { expected = typeof spec.derive === "function" ? spec.derive(decoded) : spec.derive; } catch { throw new VerifiedAccountError("account_address_mismatch", spec.name, address, "its fields derive no address"); }
  if (!expected.equals(address)) throw new VerifiedAccountError("account_address_mismatch", spec.name, address, `its fields derive ${expected.toBase58()}`);
  return decoded;
}

/**
 * Fetch `address` and return its decoded contents only when the expected program owns it and it sits at the address its
 * own fields derive. Null when the account does not exist; throws VerifiedAccountError otherwise.
 */
export async function readVerifiedAccount<T>(rpc: Pick<RpcLike, "getAccountInfo">, address: PublicKey, spec: AccountSpec<T>, commitment?: ReadAt): Promise<T | null> {
  const info = await withRetry(() => (commitment ? rpc.getAccountInfo(address, commitment) : rpc.getAccountInfo(address)));
  return verifyAccountInfo(address, info, spec);
}

/** Several accounts in one getMultipleAccountsInfo call, each checked against its own spec. */
export async function readVerifiedAccounts<T>(rpc: Pick<RpcLike, "getMultipleAccountsInfo">, items: readonly { address: PublicKey; spec: AccountSpec<T> }[], commitment?: Commitment): Promise<(T | null)[]> {
  if (!items.length) return [];
  const keys = items.map((i) => i.address);
  const infos = await withRetry(() => (commitment ? rpc.getMultipleAccountsInfo(keys, commitment) : rpc.getMultipleAccountsInfo(keys)));
  return items.map((it, i) => verifyAccountInfo(it.address, infos[i], it.spec));
}

// ---- SPL token accounts ------------------------------------------------------------------------------------------------

export type VerifiedTokenAccount = { address: PublicKey; mint: PublicKey; authority: PublicKey; amount: bigint; tokenProgram: PublicKey };

/** Check a fetched token account: owned by a token program, and holding `mint` under `authority`. Null when absent. */
export function verifyTokenAccountInfo(address: PublicKey, info: Info | null | undefined, expect: { mint: PublicKey; authority: PublicKey; tokenProgram?: PublicKey; name?: string }): VerifiedTokenAccount | null {
  const name = expect.name ?? "token account";
  if (absent(info)) return null;
  const programs = expect.tokenProgram ? [expect.tokenProgram] : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  if (!programs.some((p) => info.owner.equals(p))) throw new VerifiedAccountError("account_owner_mismatch", name, address, `owned by ${info.owner.toBase58()}, not by the token program`);
  if (info.data.length < ACCOUNT_SIZE) throw new VerifiedAccountError("account_type_mismatch", name, address, "the data is not a token account");
  const a = AccountLayout.decode(new Uint8Array(info.data).subarray(0, ACCOUNT_SIZE));
  if (a.state === 0) throw new VerifiedAccountError("account_type_mismatch", name, address, "the token account is not initialised");
  if (!a.mint.equals(expect.mint)) throw new VerifiedAccountError("account_address_mismatch", name, address, `it holds mint ${a.mint.toBase58()}, not ${expect.mint.toBase58()}`);
  if (!a.owner.equals(expect.authority)) throw new VerifiedAccountError("account_address_mismatch", name, address, `its authority is ${a.owner.toBase58()}, not ${expect.authority.toBase58()}`);
  return { address, mint: a.mint, authority: a.owner, amount: a.amount, tokenProgram: info.owner };
}

/** Fetch a token account that must hold `mint` under `authority` (a program's vault or escrow). Null when absent. */
export async function readVerifiedTokenAccount(rpc: Pick<RpcLike, "getAccountInfo">, address: PublicKey, expect: { mint: PublicKey; authority: PublicKey; tokenProgram?: PublicKey; name?: string }, commitment?: ReadAt): Promise<VerifiedTokenAccount | null> {
  const info = await withRetry(() => (commitment ? rpc.getAccountInfo(address, commitment) : rpc.getAccountInfo(address)));
  return verifyTokenAccountInfo(address, info, expect);
}
