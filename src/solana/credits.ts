import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Config } from "../config.ts";
import { chainKeyHashBytes } from "./keys.ts";
import type { RpcLike } from "./rpc.ts";
import { creditAccountSpec, creditsConfigSpec, depositorShareSpec, refundRequestSpec, settleLimiterSpec, spentRootSpec } from "./account-specs.ts";
import { cancelCloseIx, closeAccountByOwnerIx, closeAccountIx, closeGuardPda, creditsPdas, decodeCloseGuard, depositIx, MIN_DEPOSIT_UNITS, payRefundIx, SEEDS, setKeyAuthorityIx, setRefundDestinationIx, sharePda, spentRootPda, type CreditAccount, type CreditsConfig, type DepositorShare, type RefundRequest, type SettleLimiter } from "./programs/credits.ts";
import { readVerifiedAccount, type ReadAt } from "./verified-account.ts";

// Credits (docs/Trellis_Backend.md §5.1): the per-key USDC balance on trellis_credits. This module derives the program's
// accounts, builds the transactions a wallet signs (deposit, the account closure that queues a refund, its
// cancellation, a depositor's change of refund destination), reads balances, shares and refund requests, and builds
// the settlement authority's pay_refund. Spent amounts are settled off
// chain and committed hourly as SpentRoot{hour, root, spent_delta}; credits are spend-only, so nothing here withdraws.

export { SEEDS };
export const CREDIT_EXPIRY_S = 365 * 86_400; // 12 months from the latest deposit; a deposit extends the whole balance
export const GRACE_NOTICE_S = 30 * 86_400; // expired balances move to treasury 30 days after the notice
export const REFUND_DELAY_S = 72 * 3_600; // the program's default refund_delay: closure refunds wait 72h

export type CreditsProgram = { programId: PublicKey; mint: PublicKey };

export function creditsProgram(cfg: Config): CreditsProgram | null {
  const id = cfg.chain.credits;
  if (!id) return null;
  return { programId: new PublicKey(id), mint: new PublicKey(cfg.chain.usdc) };
}

/** The CreditAccount address of a key (its chainKeyHash as the PDA seed). */
export function creditAccountAddress(p: CreditsProgram, chainKeyHash: string) {
  return creditsPdas(p.programId, chainKeyHashBytes(chainKeyHash)).credit!;
}
/** The RefundRequest address of a key (written by close_account). */
export const refundRequestAddress = (p: CreditsProgram, chainKeyHash: string) => creditsPdas(p.programId, chainKeyHashBytes(chainKeyHash)).refundRequest!;

/** Program-level accounts: config and vault (the USDC token account holding every deposit). */
export const creditsAccounts = (p: CreditsProgram) => creditsPdas(p.programId);

// Every read below goes through readVerifiedAccount (TR-02): the account must be owned by the configured credits program
// and sit at the PDA its own fields derive, or the read throws a VerifiedAccountError instead of returning its contents.

/** The on-chain balance of a key, or null when the account does not exist yet (nothing deposited). */
export async function readCreditAccount(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, chainKeyHash: string, commitment?: ReadAt): Promise<CreditAccount | null> {
  return readVerifiedAccount(rpc, creditAccountAddress(p, chainKeyHash), creditAccountSpec(p.programId), commitment);
}

export async function readCreditsConfig(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, commitment?: ReadAt): Promise<CreditsConfig | null> {
  return readVerifiedAccount(rpc, creditsPdas(p.programId).config, creditsConfigSpec(p.programId), commitment);
}

/** The SpentRoot committed for `hour` (unix seconds on an hour boundary), or null. */
export async function readSpentRoot(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, hour: bigint | number, commitment?: ReadAt) {
  return readVerifiedAccount(rpc, spentRootPda(p.programId, hour), spentRootSpec(p.programId), commitment);
}

/** The queued closure refund of a key, or null when close_account has not been signed for it. */
export async function readRefundRequest(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, chainKeyHash: string, commitment?: ReadAt): Promise<RefundRequest | null> {
  return readVerifiedAccount(rpc, refundRequestAddress(p, chainKeyHash), refundRequestSpec(p.programId), commitment);
}

/** What `depositor` put into a key and where its refunds go, or null when that wallet never deposited to it. */
export async function readDepositorShare(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, chainKeyHash: string, depositor: PublicKey, commitment?: ReadAt): Promise<DepositorShare | null> {
  return readVerifiedAccount(rpc, sharePda(p.programId, chainKeyHashBytes(chainKeyHash), depositor), depositorShareSpec(p.programId), commitment);
}

/** The outflow limiter (allowances, rate, settlement pause), or null on a program initialised before it existed. */
export async function readSettleLimiter(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, commitment?: ReadAt): Promise<SettleLimiter | null> {
  return readVerifiedAccount(rpc, creditsPdas(p.programId).limiter, settleLimiterSpec(p.programId), commitment);
}

/** A decimal USDC string ("12.5") as base units; refuses more than 6 decimals or a non-positive amount. */
export function parseUsdcAmount(s: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new RangeError("amount must be a USDC amount with at most 6 decimals");
  const units = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (units <= 0n) throw new RangeError("amount must be above 0");
  return units;
}

export const formatUsdc = (units: bigint) => {
  const s = units.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

export type DepositRequest = {
  /** The wallet that pays: signer and fee payer of the returned transaction. */
  depositor: PublicKey;
  chainKeyHash: string;
  amount: bigint;
  /** The on-chain balance before this deposit (0 for a new account), for the per-key cap. */
  currentBalance: bigint;
  capUnits: bigint;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  /**
   * Security review R4-25: also register `depositor` as the key's owner wallet, in the same transaction
   * (set_key_authority after the deposit, signed by the key with `signAsKey`). For a key that has no owner yet: the
   * first registration wins, so the wallet that funds a key takes it before anyone holding a leaked key can.
   */
  registerOwner?: { key: PublicKey; signAsKey: (message: Uint8Array) => Uint8Array };
};

const unsigned = (feePayer: PublicKey, recentBlockhash: string, lastValidBlockHeight?: number) =>
  lastValidBlockHeight !== undefined ? new Transaction({ feePayer, blockhash: recentBlockhash, lastValidBlockHeight }) : new Transaction({ feePayer, recentBlockhash });
const serializeUnsigned = (tx: Transaction) => Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");

/**
 * The unsigned deposit transaction: the depositor's USDC ATA -> vault through trellis_credits::deposit. Serialized
 * without signatures (requireAllSignatures false) so a wallet or a Solana Pay client signs it. Refuses a deposit that
 * would take the key past the per-key cap (§10). Anyone may deposit to a key; a depositor gains nothing over it.
 */
export function buildDepositTransaction(p: CreditsProgram, r: DepositRequest) {
  if (r.amount <= 0n) throw new RangeError("deposit amount must be above 0");
  // The program refuses less (MIN_DEPOSIT, security review round 3 R3-22): say so before a wallet signs and pays a fee.
  if (r.amount < MIN_DEPOSIT_UNITS) throw new RangeError(`the smallest deposit is ${formatUsdc(MIN_DEPOSIT_UNITS)} USDC`);
  if (r.currentBalance + r.amount > r.capUnits) throw new RangeError(`deposit would exceed the per-key cap of ${formatUsdc(r.capUnits)} USDC`);
  const keyHash = chainKeyHashBytes(r.chainKeyHash);
  const depositorToken = getAssociatedTokenAddressSync(p.mint, r.depositor, true);
  const tx = unsigned(r.depositor, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(depositIx(p.programId, { depositor: r.depositor, depositorToken, mint: p.mint, keyHash, amount: r.amount }));
  if (r.registerOwner) {
    tx.add(setKeyAuthorityIx(p.programId, { signer: r.registerOwner.key, keyHash, newAuthority: r.depositor }));
    tx.addSignature(r.registerOwner.key, Buffer.from(r.registerOwner.signAsKey(tx.serializeMessage())));
  }
  return {
    transaction: serializeUnsigned(tx),
    registersOwner: !!r.registerOwner,
    /** Solana Pay transaction-request `message`. */
    message: `Trellis credits: deposit ${formatUsdc(r.amount)} USDC to key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}…`,
    accounts: { credit: creditAccountAddress(p, r.chainKeyHash).toBase58(), vault: creditsPdas(p.programId).vault.toBase58(), depositorToken: depositorToken.toBase58(), share: sharePda(p.programId, keyHash, r.depositor).toBase58() },
    /** Where a closure refund of this deposit returns by default: the token account it is paid from (the depositor can change it). */
    refundTo: depositorToken.toBase58(),
  };
}

// ---- Account closure (the only customer-initiated outflow; never on demand) -------------------------------------------
// trellis_credits::close_account is signed by the KEY ITSELF: the ed25519 keypair derived from the API key, whose public
// key hashes to the credit account's key_hash. Nobody else can close a key, whoever deposited to it first (security
// review TR-05). It zeroes the balance, marks the key closed and writes a RefundRequest{amount, payable_at}. It names NO
// destination (security re-review RR-05): the refund is paid back to the wallets that deposited to the key, each at most
// what it put in, to the token account that wallet named (DepositorShare.refund_to, by default the account it paid
// from). Holding the API key is therefore not enough to move a balance anywhere new. The settlement authority pays with
// pay_refund after the request's payable_at (72h), the open-dispute check and a sanctions screen of the account that is
// actually paid. The key's keypair holds no SOL, so any wallet pays the fee and the RefundRequest rent (`payer`).

export type CloseRequest = {
  /** The API key's ed25519 address (base58 of the derived public key). */
  key: PublicKey;
  /** The wallet that pays the fee and the rent; it signs last and submits. */
  payer: PublicKey;
  chainKeyHash: string;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  /** Signs the transaction message as the key (deriveKey(secret).account.signBytes). Without it the transaction is returned unsigned for a client that holds the key. */
  signAsKey?: (message: Uint8Array) => Uint8Array;
};

/**
 * The close_account transaction. With `signAsKey` the key's signature is already in place and only `payer` still has to
 * sign; the blockhash bounds how long that is valid (about a minute). It carries no destination.
 */
export function buildCloseAccountTransaction(p: CreditsProgram, r: CloseRequest) {
  const keyHash = chainKeyHashBytes(r.chainKeyHash);
  const tx = unsigned(r.payer, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(closeAccountIx(p.programId, { key: r.key, payer: r.payer, keyHash }));
  if (r.signAsKey) tx.addSignature(r.key, Buffer.from(r.signAsKey(tx.serializeMessage())));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: close key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}… and queue its refund to the wallets that funded it`, accounts: { refundRequest: refundRequestAddress(p, r.chainKeyHash).toBase58() }, signedByKey: !!r.signAsKey };
}

/**
 * The cancel_close transaction, signed by the key: takes a queued closure back while nothing has been paid. `rentPayer`
 * is RefundRequest.rentPayer (it gets the rent back). `payer` pays the fee (and, the first time the key cancels, the
 * rent of its CloseGuard) and signs last. The program allows this to the key only for a closure the key itself asked
 * for, and only once per KEY_CANCEL_COOLDOWN (security review round 3, R3-06).
 */
export function buildCancelCloseTransaction(p: CreditsProgram, r: CloseRequest & { rentPayer: PublicKey }) {
  const tx = unsigned(r.payer, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(cancelCloseIx(p.programId, { signer: r.key, payer: r.payer, keyHash: chainKeyHashBytes(r.chainKeyHash), rentPayer: r.rentPayer }));
  if (r.signAsKey) tx.addSignature(r.key, Buffer.from(r.signAsKey(tx.serializeMessage())));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: take back the closure of key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}…`, accounts: { refundRequest: refundRequestAddress(p, r.chainKeyHash).toBase58() }, signedByKey: !!r.signAsKey };
}

// ---- The key's owner wallet (security review round 3, R3-06 and R3-23) ------------------------------------------------
// A key can register ONE owner wallet on chain (CreditAccount.authority): set_key_authority signed by the key and by the
// wallet. From then on the key alone cannot change it. The owner can ask for a closure without the key and cancel any
// closure of the key; a closure the owner asked for cannot be cancelled with the key. So an owner whose API key has
// leaked still gets the balance back to the wallets that funded it, whatever the other holder of the key does.

/**
 * The set_key_authority transaction that registers `owner` as the key's owner wallet: already signed by the key (with
 * `signAsKey`); `owner` signs as the new owner and as fee payer, and sends it.
 */
export function buildRegisterOwnerTransaction(p: CreditsProgram, r: { key: PublicKey; owner: PublicKey; chainKeyHash: string; recentBlockhash: string; lastValidBlockHeight?: number; signAsKey?: (message: Uint8Array) => Uint8Array }) {
  const tx = unsigned(r.owner, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(setKeyAuthorityIx(p.programId, { signer: r.key, keyHash: chainKeyHashBytes(r.chainKeyHash), newAuthority: r.owner }));
  if (r.signAsKey) tx.addSignature(r.key, Buffer.from(r.signAsKey(tx.serializeMessage())));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: register ${r.owner.toBase58().slice(0, 6)}… as the owner wallet of key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}…`, accounts: { credit: creditAccountAddress(p, r.chainKeyHash).toBase58() }, signedByKey: !!r.signAsKey };
}

/** The unsigned close_account_by_owner transaction: the registered owner wallet signs (and pays), no key needed. */
export function buildCloseByOwnerTransaction(p: CreditsProgram, r: { owner: PublicKey; chainKeyHash: string; recentBlockhash: string; lastValidBlockHeight?: number }) {
  const tx = unsigned(r.owner, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(closeAccountByOwnerIx(p.programId, { owner: r.owner, payer: r.owner, keyHash: chainKeyHashBytes(r.chainKeyHash) }));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: close key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}… as its owner wallet and queue its refund to the wallets that funded it`, accounts: { refundRequest: refundRequestAddress(p, r.chainKeyHash).toBase58() }, signedByKey: false };
}

/** The unsigned cancel_close transaction for the registered owner wallet (not bound by the key's cooldown). */
export function buildCancelCloseByOwnerTransaction(p: CreditsProgram, r: { owner: PublicKey; rentPayer: PublicKey; chainKeyHash: string; recentBlockhash: string; lastValidBlockHeight?: number }) {
  const tx = unsigned(r.owner, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(cancelCloseIx(p.programId, { signer: r.owner, payer: r.owner, keyHash: chainKeyHashBytes(r.chainKeyHash), rentPayer: r.rentPayer }));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: take back the closure of key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}… as its owner wallet`, accounts: { refundRequest: refundRequestAddress(p, r.chainKeyHash).toBase58() }, signedByKey: false };
}

/** When the key itself may next cancel a closure (unix seconds); 0 when it has never cancelled. */
export async function readKeyCancelBlockedUntil(rpc: Pick<RpcLike, "getAccountInfo">, p: CreditsProgram, chainKeyHash: string): Promise<bigint> {
  const info = await rpc.getAccountInfo(closeGuardPda(p.programId, chainKeyHashBytes(chainKeyHash)));
  if (!info || !info.owner.equals(p.programId)) return 0n;
  return decodeCloseGuard(new Uint8Array(info.data))?.keyCancelBlockedUntil ?? 0n;
}

/**
 * The unsigned set_refund_destination transaction for a DEPOSITOR's wallet: its refunds from this key go to `refundTo`'s
 * USDC associated token account from now on (created idempotently, paid by the depositor). Only that wallet's signature
 * does this; the API key cannot.
 */
export function buildSetRefundDestinationTransaction(p: CreditsProgram, r: { depositor: PublicKey; refundTo: PublicKey; chainKeyHash: string; recentBlockhash: string; lastValidBlockHeight?: number }) {
  const keyHash = chainKeyHashBytes(r.chainKeyHash);
  const refundToToken = getAssociatedTokenAddressSync(p.mint, r.refundTo, true);
  const tx = unsigned(r.depositor, r.recentBlockhash, r.lastValidBlockHeight);
  tx.add(createAssociatedTokenAccountIdempotentInstruction(r.depositor, refundToToken, r.refundTo, p.mint), setRefundDestinationIx(p.programId, { depositor: r.depositor, keyHash, refundToToken }));
  return { transaction: serializeUnsigned(tx), message: `Trellis credits: send my refunds from key ${r.chainKeyHash.replace(/^0x/, "").slice(0, 8)}… to ${r.refundTo.toBase58().slice(0, 6)}…`, accounts: { share: sharePda(p.programId, keyHash, r.depositor).toBase58(), refundToToken: refundToToken.toBase58() } };
}

/** close_account as a bare instruction (callers that assemble their own transaction, such as tests). */
export const closeAccountInstruction = (p: CreditsProgram, a: { key: PublicKey; payer: PublicKey; chainKeyHash: string }): TransactionInstruction => closeAccountIx(p.programId, { key: a.key, payer: a.payer, keyHash: chainKeyHashBytes(a.chainKeyHash) });

/** pay_refund(amount) to one depositor's refund account, signed by the settlement authority. */
export function buildPayRefundInstructions(p: CreditsProgram, a: { settlement: PublicKey; chainKeyHash: string; depositor: PublicKey; refundToToken: PublicKey; amount: bigint }): TransactionInstruction[] {
  return [payRefundIx(p.programId, { settlement: a.settlement, keyHash: chainKeyHashBytes(a.chainKeyHash), depositor: a.depositor, amount: a.amount, refundToToken: a.refundToToken, mint: p.mint })];
}

/** When a queued closure may be paid: after the open-dispute window (72h by default, §5.1). */
export const closurePayableAt = (requestedAt: Date, delayMs: number) => new Date(requestedAt.getTime() + delayMs);
