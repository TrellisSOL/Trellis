import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { Ed25519Program, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Config } from "../config.ts";
import { base58Decode, base58Encode } from "./constants.ts";
import { rulebookSpec, tabConfigSpec, tabSpec } from "./account-specs.ts";
import type { RpcLike } from "./rpc.ts";
import { withRetry } from "./rpc.ts";
import { rulesConfigPda, type Rulebook } from "./programs/rules.ts";
import { closeIx, openTabIx, parseVoucherBytes, postVoucherIx, reclaimIx, RECLAIM_GRACE_S, tabConfigPda, tabEscrow, tabPdas, topUpIx, VOUCHER_DOMAIN, VOUCHER_MSG_LEN, voucherBytes, voucherScope, voucherSignatureIx, type RulebookAccounts, type TabAccount, type TabConfig, type Voucher, type VoucherScope } from "./programs/tab.ts";
import { readVerifiedAccount, verifyTokenAccountInfo } from "./verified-account.ts";

// Tabs (docs/Trellis_Backend.md §5.2): a payer authorizes a ceiling (cap) into escrow and pays exactly what it used.
// Off chain, every request carries a voucher {tab, cumulative_used, seq} signed by the payer's session key; on close the
// payee posts the highest voucher and the program pays cumulative_used, refunding the rest. The signed bytes are domain-
// separated and bound to the tab program and to the opening of the tab (`VoucherScope`, security review TR-19). This module is the voucher
// codec and signer/verifier, the seller-exposure rule, the account reader, the instruction builders and the inspector
// of a payee-signed close transaction (what the facilitator relays and pays the fee for).

export type { Voucher, VoucherScope, TabAccount, TabConfig };
export { isVerifiedAccountError, VerifiedAccountError } from "./verified-account.ts";
export { parseVoucherBytes, voucherBytes, voucherScope, RECLAIM_GRACE_S, VOUCHER_DOMAIN, VOUCHER_MSG_LEN };

export type TabProgram = { programId: PublicKey; mint: PublicKey };
/** The tab program this process was last configured with: what a `readTab` call that names no program checks against. */
let configuredTabProgram: TabProgram | null = null;
export function tabProgram(cfg: Config): TabProgram | null {
  const id = cfg.solana.programs.tab;
  const p = id ? { programId: new PublicKey(id), mint: new PublicKey(cfg.chain.usdc) } : null;
  if (p) configuredTabProgram = p;
  return p;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A session signer: a Keypair, or its 32-byte seed / 64-byte secret key. */
export type SessionSigner = Keypair | Uint8Array;
const seedOf = (s: SessionSigner) => (s instanceof Keypair ? s.secretKey.subarray(0, 32) : s.length === 64 ? s.subarray(0, 32) : s);
export const sessionPublicKey = (s: SessionSigner): PublicKey => (s instanceof Keypair ? s.publicKey : Keypair.fromSeed(seedOf(s)).publicKey);

/** Sign a voucher with the payer's session key: detached ed25519 over the 110 canonical bytes. Returns 64 raw bytes. */
export function signVoucher(signer: SessionSigner, v: Voucher, scope: VoucherScope): Uint8Array {
  const seed = seedOf(signer);
  if (seed.length !== 32) throw new RangeError("session key must be a 32-byte seed or 64-byte secret key");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return new Uint8Array(edSign(null, voucherBytes(v, scope), key));
}
export const signVoucherBase58 = (signer: SessionSigner, v: Voucher, scope: VoucherScope) => base58Encode(signVoucher(signer, v, scope));

/**
 * Verify a voucher signature against the tab's session key, for the program and the opening of the tab in `scope`
 * (both from the chain). Never throws.
 */
export function verifyVoucher(v: Voucher, signature: Uint8Array | string, sessionKey: PublicKey | string, scope: VoucherScope): boolean {
  try {
    const sig = typeof signature === "string" ? base58Decode(signature) : signature;
    if (sig.length !== 64) return false;
    const pub = (sessionKey instanceof PublicKey ? sessionKey : new PublicKey(sessionKey)).toBytes();
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
    return edVerify(null, voucherBytes(v, scope), key, sig);
  } catch {
    return false;
  }
}

/** A voucher as the facilitator and the router exchange it on the wire. */
export type WireVoucher = { tab: string; cumulative_used: string; seq: string; signature: string; session_key?: string };
export function parseWireVoucher(j: unknown): { voucher: Voucher; signature: Uint8Array; sessionKey: PublicKey | null } | null {
  const o = j as Partial<WireVoucher> | null;
  if (!o || typeof o !== "object") return null;
  try {
    if (typeof o.tab !== "string" || typeof o.cumulative_used !== "string" || typeof o.seq !== "string" || typeof o.signature !== "string") return null;
    if (!/^\d{1,20}$/.test(o.cumulative_used) || !/^\d{1,20}$/.test(o.seq)) return null;
    const sig = base58Decode(o.signature);
    if (sig.length !== 64) return null;
    return { voucher: { tab: new PublicKey(o.tab), cumulativeUsed: BigInt(o.cumulative_used), seq: BigInt(o.seq) }, signature: sig, sessionKey: typeof o.session_key === "string" ? new PublicKey(o.session_key) : null };
  } catch {
    return null;
  }
}
export const wireVoucher = (v: Voucher, signature: Uint8Array, sessionKey?: PublicKey): WireVoucher => ({ tab: v.tab.toBase58(), cumulative_used: v.cumulativeUsed.toString(), seq: v.seq.toString(), signature: base58Encode(signature), ...(sessionKey ? { session_key: sessionKey.toBase58() } : {}) });

// ---- Seller exposure --------------------------------------------------------------------------------------------------

export const MIN_UNVOUCHED_UNITS = 50_000n; // $0.05
/** `max_unvouched = max(0.25 x last request cost, $0.05)`: how much the payee may serve beyond the latest voucher. */
export const maxUnvouched = (lastRequestCostUnits: bigint) => { const q = lastRequestCostUnits / 4n; return q > MIN_UNVOUCHED_UNITS ? q : MIN_UNVOUCHED_UNITS; };

export type Exposure = { cap: bigint; vouched: bigint; served: bigint; lastRequestCost: bigint };
/** Whether the payee may serve one more request of `nextCost`: within the cap, and within the unvouched allowance. */
export function mayServe(x: Exposure, nextCost: bigint): { ok: true } | { ok: false; reason: "cap_exceeded" | "voucher_required"; maxUnvouched: bigint } {
  const limit = maxUnvouched(x.lastRequestCost > nextCost ? x.lastRequestCost : nextCost);
  if (x.served + nextCost > x.cap) return { ok: false, reason: "cap_exceeded", maxUnvouched: limit };
  if (x.served + nextCost - x.vouched > limit) return { ok: false, reason: "voucher_required", maxUnvouched: limit };
  return { ok: true };
}

/** Whether `next` supersedes `current`: strictly increasing seq and non-decreasing cumulative_used on the same tab. */
export function supersedes(current: Voucher | null, next: Voucher) {
  if (!current) return true;
  return current.tab.equals(next.tab) && next.seq > current.seq && next.cumulativeUsed >= current.cumulativeUsed;
}

// ---- Chain reads -----------------------------------------------------------------------------------------------------

/**
 * A Tab as the router may believe it: the account's fields plus the USDC actually sitting in its escrow. `escrowAmount`
 * is 0 when the escrow token account does not exist.
 */
export type TabState = TabAccount & { escrow: PublicKey; escrowAmount: bigint };

/**
 * The Tab account, or null when it does not exist (never opened, or already closed / reclaimed: both close the account).
 *
 * Any account can carry the Tab discriminator and any fields its author likes (security review TR-02), so the read
 * proves what a real tab is: the account is owned by the tab program `p`, its address is the program's PDA of its own
 * `(payer, payee, tab_id)`, and its escrow, the PDA `["escrow", tab]`, is an SPL token account holding the tab's mint
 * under the tab's own authority. Anything else throws VerifiedAccountError (`account_owner_mismatch`,
 * `account_address_mismatch`, `account_type_mismatch`). The escrow balance comes back with it: a caller that is about to
 * serve against the tab or vouch for it must require `escrowAmount >= cap` (`tabEscrowProblem`).
 *
 * `p` is the configured tab program. A call without it (src/solana/tab-close.ts) is checked against the program this
 * process was configured with (`tabProgram(cfg)`), and throws when there is none: there is no unverified read.
 */
export async function readTab(rpc: Pick<RpcLike, "getAccountInfo">, tab: PublicKey, p?: TabProgram): Promise<TabState | null> {
  const program = p ?? configuredTabProgram;
  if (!program) throw new Error("tab: no tab program is configured to verify the account against");
  const escrow = tabEscrow(program.programId, tab);
  const [t, escrowInfo] = await Promise.all([readVerifiedAccount(rpc, tab, tabSpec(program.programId)), withRetry(() => rpc.getAccountInfo(escrow))]);
  if (!t) return null;
  const held = verifyTokenAccountInfo(escrow, escrowInfo, { mint: t.mint, authority: tab, name: "tab escrow" });
  return { ...t, escrow, escrowAmount: held?.amount ?? 0n };
}

/** Why a tab's escrow does not back it: the escrow must hold at least the cap the payee is asked to rely on. */
export const tabEscrowProblem = (t: Pick<TabState, "cap" | "escrowAmount">): "tab_escrow_underfunded" | null => (t.escrowAmount < t.cap ? "tab_escrow_underfunded" : null);

export async function readTabConfig(rpc: Pick<RpcLike, "getAccountInfo">, p: TabProgram): Promise<TabConfig | null> {
  return readVerifiedAccount(rpc, tabConfigPda(p.programId), tabConfigSpec(p.programId));
}

/**
 * Check a voucher against the tab it names: same payee and mint, not past its reclaim point, signed by the tab's
 * session key for this program (`expected.programId`) and this opening of the tab (`t.createdAt`), within the cap, and
 * newer than what the payee already posted (the program's own rules).
 */
export function checkVoucherAgainstTab(t: TabAccount, v: Voucher, signature: Uint8Array, expected: { programId: PublicKey; payee: PublicKey; mint: PublicKey; now: number; reclaimGrace?: number }): string | null {
  if (!t.payee.equals(expected.payee)) return "tab_payee_mismatch";
  if (!t.mint.equals(expected.mint)) return "tab_asset_mismatch";
  if (BigInt(expected.now) > t.expiry + BigInt(expected.reclaimGrace ?? RECLAIM_GRACE_S)) return "tab_expired";
  if (v.cumulativeUsed > t.cap) return "voucher_exceeds_cap";
  if (v.seq <= t.postedSeq || v.cumulativeUsed < t.postedUsed) return "voucher_stale";
  if (!verifyVoucher(v, signature, t.sessionKey, voucherScope(expected.programId, t))) return "invalid_voucher_signature";
  return null;
}

// ---- Rulebooks (docs §5.5) ---------------------------------------------------------------------------------------------
// A tab may be bound to a trellis_rules Rulebook (the payer's own) when it is opened. What the rulebook binds, as the
// programs enforce it (security/REVIEW-2026-10.md, TR-04 / TR-10):
//   - on chain, when USDC is committed: open_tab and top_up record the escrowed amount against daily_max and refuse a
//     killed or expired rulebook, or one that is not the payer's;
//   - off chain, per call: the payee refuses a request while the rulebook is killed or expired, or when the request's
//     worst-case cost is above per_call_max (`rulebookRefusal`);
//   - never at settlement: close and reclaim do not consult the rulebook, so nothing its owner does after being served
//     (kill, tighten, close, let it expire) can keep the payee from collecting what was vouched.

export type { Rulebook, RulebookAccounts };
export const SECONDS_PER_DAY = 86_400;

/**
 * The Rulebook a tab is bound to, or null when the account is gone (closed by its owner). The account must be owned by
 * the rules program `rulesProgram` and sit at that program's PDA of its own `(owner, rulebook_id)`; anything else throws
 * VerifiedAccountError (TR-02).
 */
export async function readRulebook(rpc: Pick<RpcLike, "getAccountInfo">, rulebook: PublicKey, rulesProgram: PublicKey): Promise<Rulebook | null> {
  return readVerifiedAccount(rpc, rulebook, rulebookSpec(rulesProgram));
}

export type RulebookRefusal = "rulebook_killed" | "rulebook_expired" | "rulebook_per_call_max";

/**
 * Whether the payee may serve one more request of at most `callCost` (USDC units) on a rulebook-bound tab at `now`
 * (unix seconds). Null when it may; otherwise why not. The daily limit is not checked here: the program counted the
 * tab's whole escrow against it when the tab was opened.
 */
export function rulebookRefusal(rb: Pick<Rulebook, "killed" | "expiry" | "perCallMax">, callCost: bigint, now: number): RulebookRefusal | null {
  if (rb.killed) return "rulebook_killed";
  if (BigInt(now) > rb.expiry) return "rulebook_expired";
  if (callCost > rb.perCallMax) return "rulebook_per_call_max";
  return null;
}

/** The accounts open_tab and top_up take for a rulebook-bound tab: the rulebook, trellis_rules' config and the program itself. */
export const rulebookAccounts = (rulesProgram: PublicKey, rulebook: PublicKey): RulebookAccounts => ({ rulebook, rulesConfig: rulesConfigPda(rulesProgram), rulesProgram });

// ---- Instruction builders ---------------------------------------------------------------------------------------------

export type OpenTab = { payer: PublicKey; payee: PublicKey; tabId: bigint; cap: bigint; expiry: bigint; sessionKey: PublicKey; rulebook?: PublicKey | null; rulesProgram?: PublicKey | null; capUnits: bigint };

/**
 * open_tab, refusing a cap above the pre-audit limit (§10). A `rulebook` (the payer's own) needs `rulesProgram`, the
 * trellis_rules program the tab program's config names.
 */
export function openTabInstruction(p: TabProgram, o: OpenTab): { ix: TransactionInstruction; tab: PublicKey } {
  if (o.cap <= 0n) throw new RangeError("tab cap must be above 0");
  if (o.cap > o.capUnits) throw new RangeError("tab cap exceeds the pre-audit cap");
  if (o.rulebook && !o.rulesProgram) throw new Error("a rulebook-bound tab needs the rules program id");
  const { tab } = tabPdas(p.programId, o.payer, o.payee, o.tabId);
  const ix = openTabIx(p.programId, { payer: o.payer, payerToken: getAssociatedTokenAddressSync(p.mint, o.payer, true), payee: o.payee, mint: p.mint, tabId: o.tabId, cap: o.cap, expiry: o.expiry, sessionKey: o.sessionKey, rules: o.rulebook ? rulebookAccounts(o.rulesProgram!, o.rulebook) : null });
  return { ix, tab };
}

/** top_up. A rulebook-bound tab passes `rules`: the top-up is a new commitment under the rulebook. */
export function topUpInstruction(p: TabProgram, a: { payer: PublicKey; tab: PublicKey; amount: bigint; rules?: RulebookAccounts | null }) {
  if (a.amount <= 0n) throw new RangeError("top-up must be above 0");
  return topUpIx(p.programId, { payer: a.payer, payerToken: getAssociatedTokenAddressSync(p.mint, a.payer, true), tab: a.tab, mint: p.mint, amount: a.amount, rules: a.rules ?? null });
}

/**
 * The two instructions that close a tab: the Ed25519 verification of the voucher, then close. Order matters. Only the
 * tab's payee can sign close; the payee's USDC associated token account receives the payment and the payer's the rest of
 * the escrow. The payer's account does not have to exist: the close then pays the payee and leaves the refund in escrow
 * (anyone delivers it later with reclaim). A rulebook plays no part, whatever the tab was opened with.
 */
export function closeInstructions(p: TabProgram, t: Pick<TabAccount, "payer" | "payee" | "sessionKey" | "createdAt">, v: Voucher, signature: Uint8Array): TransactionInstruction[] {
  return [
    voucherSignatureIx(t.sessionKey, v, signature, voucherScope(p.programId, t)),
    closeIx(p.programId, { tab: v.tab, payer: t.payer, payee: t.payee, payeeToken: getAssociatedTokenAddressSync(p.mint, t.payee, true), payerToken: getAssociatedTokenAddressSync(p.mint, t.payer, true), mint: p.mint, cumulativeUsed: v.cumulativeUsed, seq: v.seq }),
  ];
}

/**
 * The two instructions that record a voucher on the tab without closing it. post_voucher needs nothing but the tab and
 * the voucher, so it is the payee's fallback whenever a close cannot go through: what is posted is paid to the payee by
 * any later reclaim.
 */
export function postVoucherInstructions(p: TabProgram, t: Pick<TabAccount, "payee" | "sessionKey" | "createdAt">, v: Voucher, signature: Uint8Array): TransactionInstruction[] {
  return [voucherSignatureIx(t.sessionKey, v, signature, voucherScope(p.programId, t)), postVoucherIx(p.programId, { tab: v.tab, payee: t.payee, cumulativeUsed: v.cumulativeUsed, seq: v.seq })];
}

export function reclaimInstruction(p: TabProgram, t: Pick<TabAccount, "payer" | "payee">, tab: PublicKey) {
  return reclaimIx(p.programId, { tab, payer: t.payer, payerToken: getAssociatedTokenAddressSync(p.mint, t.payer, true), payeeToken: getAssociatedTokenAddressSync(p.mint, t.payee, true), mint: p.mint });
}

/** An unsigned transaction around `ixs` for `feePayer` to sign (wallet flows), base64. */
export function unsignedTransaction(ixs: TransactionInstruction[], feePayer: PublicKey, recentBlockhash: string) {
  const tx = new Transaction({ feePayer, recentBlockhash });
  tx.add(...ixs);
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}

/** The tab address for a payer/payee/tab_id triple. */
export const tabAddress = (p: TabProgram, payer: PublicKey, payee: PublicKey, tabId: bigint) => tabPdas(p.programId, payer, payee, tabId).tab;

// ---- Payee-signed close, relayed by the facilitator ----------------------------------------------------------------------
// trellis_tab::close accepts only the tab's payee as signer. The hosted facilitator's /settle for the `tab` scheme is
// therefore a relay: the seller (payee) builds `[Ed25519(voucher), close]` with the facilitator's relay key as fee payer,
// signs it as payee and sends it base64 as `payload.transaction` beside the voucher; the facilitator checks the voucher
// against the Tab, checks the transaction is exactly that close, co-signs as fee payer and submits. Funds move escrow ->
// payee / payer; the relay only pays the fee.

/**
 * The close transaction a seller signs: `[Ed25519(voucher), close]` with `feePayer` (the facilitator relay) first. The
 * payee signs it (partialSign) and sends the base64 to /facilitator/settle.
 */
export function buildCloseTransaction(p: TabProgram, t: Pick<TabAccount, "payer" | "payee" | "sessionKey" | "createdAt">, v: Voucher, signature: Uint8Array, o: { feePayer: PublicKey; recentBlockhash: string; lastValidBlockHeight?: number }) {
  const tx = o.lastValidBlockHeight !== undefined ? new Transaction({ feePayer: o.feePayer, blockhash: o.recentBlockhash, lastValidBlockHeight: o.lastValidBlockHeight }) : new Transaction({ feePayer: o.feePayer, recentBlockhash: o.recentBlockhash });
  tx.add(...closeInstructions(p, t, v, signature));
  return tx;
}

export type CloseReason = "invalid_tab_close_transaction" | "invalid_tab_close_fee_payer" | "invalid_tab_close_fee_payer_in_instruction" | "invalid_tab_close_signatures" | "invalid_tab_close_instructions" | "invalid_tab_close_voucher_mismatch" | "invalid_tab_close_payee_signature";
export type InspectedClose = { tx: Transaction; voucher: Voucher; sessionKey: PublicKey; payee: PublicKey; payer: PublicKey; recentBlockhash: string };

/**
 * Decode a payee-signed close and check, without the network, that it is exactly `[Ed25519(voucher by session key),
 * trellis_tab::close(cumulative_used, seq)]` for `expect.tab` (payee, payer, mint and token accounts as the Tab says),
 * with `expect.feePayer` as fee payer and the payee's signature present and valid.
 */
export function inspectCloseTransaction(base64: string, p: TabProgram, t: TabAccount, expect: { tab: PublicKey; feePayer: PublicKey; voucher: Voucher }): { ok: true; close: InspectedClose } | { ok: false; reason: CloseReason } {
  let tx: Transaction;
  try { tx = Transaction.from(Buffer.from(base64, "base64")); } catch { return { ok: false, reason: "invalid_tab_close_transaction" }; }
  if (!tx.feePayer || !tx.feePayer.equals(expect.feePayer) || !tx.recentBlockhash) return { ok: false, reason: "invalid_tab_close_fee_payer" };
  if (tx.instructions.length !== 2) return { ok: false, reason: "invalid_tab_close_instructions" };
  const [verify, close] = tx.instructions;
  // What the relay pays is bounded (security review TR-06): exactly these two instructions (so no compute-budget price),
  // exactly two signatures (the relay and the payee), and the relay's key in the fee payer slot only: no instruction may
  // name it as an account (not as the tab's payer) or as a program.
  if (tx.instructions.some((ix) => ix.programId.equals(expect.feePayer) || ix.keys.some((k) => k.pubkey.equals(expect.feePayer)))) return { ok: false, reason: "invalid_tab_close_fee_payer_in_instruction" };
  let required: number;
  try { required = tx.compileMessage().header.numRequiredSignatures; } catch { return { ok: false, reason: "invalid_tab_close_transaction" }; }
  if (required !== 2) return { ok: false, reason: "invalid_tab_close_signatures" };
  // The Ed25519 instruction must be the one we would build for this voucher and session key (same bytes).
  const scope = voucherScope(p.programId, t);
  const sig = Ed25519Program.createInstructionWithPublicKey({ publicKey: t.sessionKey.toBytes(), message: voucherBytes(expect.voucher, scope), signature: verify.data.subarray(16 + 32, 16 + 32 + 64) });
  if (!verify.programId.equals(Ed25519Program.programId) || verify.keys.length !== 0 || !Buffer.from(verify.data).equals(Buffer.from(sig.data))) return { ok: false, reason: "invalid_tab_close_voucher_mismatch" };
  if (!verifyVoucher(expect.voucher, new Uint8Array(verify.data.subarray(16 + 32, 16 + 32 + 64)), t.sessionKey, scope)) return { ok: false, reason: "invalid_tab_close_voucher_mismatch" };
  // The close instruction must equal the one built from the Tab for this voucher (accounts, flags and data).
  const want = closeIx(p.programId, { tab: expect.tab, payer: t.payer, payee: t.payee, payeeToken: getAssociatedTokenAddressSync(p.mint, t.payee, true), payerToken: getAssociatedTokenAddressSync(p.mint, t.payer, true), mint: p.mint, cumulativeUsed: expect.voucher.cumulativeUsed, seq: expect.voucher.seq });
  const same = close.programId.equals(want.programId) && Buffer.from(close.data).equals(Buffer.from(want.data)) && close.keys.length === want.keys.length && close.keys.every((k, i) => k.pubkey.equals(want.keys[i].pubkey) && k.isSigner === want.keys[i].isSigner && k.isWritable === want.keys[i].isWritable);
  if (!same) return { ok: false, reason: "invalid_tab_close_instructions" };
  // The payee has signed the message as it stands; the fee payer slot may still be empty.
  const payeeSig = tx.signatures.find((s) => s.publicKey.equals(t.payee));
  if (!payeeSig?.signature) return { ok: false, reason: "invalid_tab_close_payee_signature" };
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, t.payee.toBuffer()]), format: "der", type: "spki" });
    if (!edVerify(null, tx.serializeMessage(), key, payeeSig.signature)) return { ok: false, reason: "invalid_tab_close_payee_signature" };
  } catch { return { ok: false, reason: "invalid_tab_close_payee_signature" }; }
  return { ok: true, close: { tx, voucher: expect.voucher, sessionKey: t.sessionKey, payee: t.payee, payer: t.payer, recentBlockhash: tx.recentBlockhash } };
}
