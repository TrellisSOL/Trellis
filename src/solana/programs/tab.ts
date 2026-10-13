import { Ed25519Program, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { IdlProgram, le64, programDataAddress, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_tab.json";

// trellis_tab (docs/Trellis_Backend.md §5.2), built from src/solana/idl/trellis_tab.json: the tab x402 scheme.
//   open_tab(args{tab_id, cap, expiry, session_key}, rulebook?)   payer moves `cap` USDC into the tab's escrow; expiry at
//                                                                 most 30 days out. With a rulebook (the payer's own),
//                                                                 the cap is recorded against its daily limit
//   top_up(amount)                                                payer adds to the escrow (and the cap)
//   post_voucher(cumulative_used, seq)                            payee records the highest voucher it holds
//   close(cumulative_used, seq)                                   payee only; pays cumulative_used to the payee's USDC
//                                                                 account and the REST OF THE ESCROW (whatever it holds)
//                                                                 to the payer's; closes the escrow and the tab. A payer
//                                                                 account that cannot receive (missing, closed, frozen)
//                                                                 does not block it: the refund waits in escrow
//   reclaim()                                                     anyone, after expiry + reclaim_grace (or at any time
//                                                                 once the payee has closed): delivers the escrow to the
//                                                                 stored payer and payee
// Vouchers are verified through an Ed25519 program instruction placed directly before close / post_voucher, over the
// 110-byte message `"trellis:tab:voucher:v1" || program id (32) || tab (32) || created_at i64 LE || cumulative_used u64 LE
// || seq u64 LE` signed by the tab's session key (security review TR-19: domain-separated, bound to this deployment and
// to this opening of the tab). A rulebook is consulted only when USDC is committed (open_tab, top_up), never at settlement.
// PDA seeds: ["config"], ["tab", payer, payee, tab_id LE], ["escrow", tab], ["enforcer"] (CPI signer into trellis_rules),
// ["pending_config"].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const TAB_IDL = idl as unknown as TrellisIdl;
export const tabIdl = new IdlProgram(TAB_IDL);
export const tabAt = (programId: PublicKey | string) => tabIdl.at(programId);

/**
 * The most a tab's cap can be while the programs are unaudited: 500 USDC. Compiled into the program (`MAX_CAP_LIMIT`):
 * no key sets `max_cap` above it, at init, at once or through the timelock, and open_tab / top_up hold a config to it.
 */
export const MAX_CAP_LIMIT = 500_000_000n;

export const TAB_SEEDS = {
  config: [Buffer.from("config")],
  tab: (payer: PublicKey, payee: PublicKey, tabId: bigint) => [Buffer.from("tab"), payer.toBuffer(), payee.toBuffer(), le64(tabId)],
  escrow: (tab: PublicKey) => [Buffer.from("escrow"), tab.toBuffer()],
  enforcer: [Buffer.from("enforcer")],
};

/** Default grace after expiry before the payer may reclaim (TabConfig.reclaim_grace default). */
export const RECLAIM_GRACE_S = 24 * 3600;
/** The domain separator every voucher message starts with (22 ASCII bytes). A new signed layout takes a new version. */
export const VOUCHER_DOMAIN = "trellis:tab:voucher:v1";
/** 22 (domain) + 32 (program id) + 32 (tab) + 8 (created_at) + 8 (cumulative_used) + 8 (seq). */
export const VOUCHER_MSG_LEN = 110;
/** `posted_seq` of a tab whose settlement has started (the payee closed while one side could not be paid): no more vouchers. */
export const TAB_FINAL_SEQ = (1n << 64n) - 1n;
/** A tab's expiry is at most this far from the moment it is opened (the program refuses more). */
export const MAX_TAB_LIFETIME_S = 30 * 86_400;

export function tabPdas(programId: PublicKey, payer: PublicKey, payee: PublicKey, tabId: bigint) {
  const [config] = PublicKey.findProgramAddressSync(TAB_SEEDS.config, programId);
  const [tab] = PublicKey.findProgramAddressSync(TAB_SEEDS.tab(payer, payee, tabId), programId);
  const [escrow] = PublicKey.findProgramAddressSync(TAB_SEEDS.escrow(tab), programId);
  return { config, tab, escrow };
}
export const tabConfigPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(TAB_SEEDS.config, programId)[0];
export const tabEscrow = (programId: PublicKey, tab: PublicKey) => PublicKey.findProgramAddressSync(TAB_SEEDS.escrow(tab), programId)[0];
export const enforcerPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(TAB_SEEDS.enforcer, programId)[0];

// ---- Accounts --------------------------------------------------------------------------------------------------------

export type TabConfig = { authority: PublicKey; guardian: PublicKey; usdcMint: PublicKey; rulesProgram: PublicKey; maxCap: bigint; reclaimGrace: bigint; paused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint };
export function decodeTabConfig(data: Uint8Array): TabConfig | null {
  const r = tabIdl.decodeAccount<Raw>("TabConfig", data);
  if (!r) return null;
  return { authority: r.authority, guardian: r.guardian, usdcMint: r.usdc_mint, rulesProgram: r.rules_program, maxCap: r.max_cap, reclaimGrace: r.reclaim_grace, paused: r.paused, pausedUntil: r.paused_until, guardianPauseReadyAt: r.guardian_pause_ready_at };
}

/** Tab: who, how much, until when, and the highest voucher posted. */
export type TabAccount = { payer: PublicKey; payee: PublicKey; sessionKey: PublicKey; mint: PublicKey; tabId: bigint; cap: bigint; postedUsed: bigint; postedSeq: bigint; expiry: bigint; createdAt: bigint; rulebook: PublicKey | null };
export function decodeTabAccount(data: Uint8Array): TabAccount | null {
  const r = tabIdl.decodeAccount<Raw>("Tab", data);
  if (!r) return null;
  return { payer: r.payer, payee: r.payee, sessionKey: r.session_key, mint: r.mint, tabId: r.tab_id, cap: r.cap, postedUsed: r.posted_used, postedSeq: r.posted_seq, expiry: r.expiry, createdAt: r.created_at, rulebook: r.rulebook ?? null };
}
/** A Tab account as the program stores it (tests, fixtures). */
export const encodeTabAccount = (t: TabAccount & { bump?: number; escrowBump?: number }) => tabIdl.encodeAccount("Tab", { payer: t.payer, payee: t.payee, session_key: t.sessionKey, mint: t.mint, tab_id: t.tabId, cap: t.cap, posted_used: t.postedUsed, posted_seq: t.postedSeq, expiry: t.expiry, created_at: t.createdAt, rulebook: t.rulebook, bump: t.bump ?? 255, escrow_bump: t.escrowBump ?? 255 });

// ---- Vouchers --------------------------------------------------------------------------------------------------------

export type Voucher = { tab: PublicKey; cumulativeUsed: bigint; seq: bigint };

/**
 * What a voucher is bound to besides its tab (security review TR-19): the tab program it is for, and the opening of the
 * tab (`Tab.created_at`). The program id differs per cluster, so a devnet voucher is nothing on mainnet; `created_at`
 * differs each time a tab address is opened, so a voucher for a closed tab is nothing against a tab reopened at the
 * same address with the same session key. A verifier takes both from the chain (the configured program and the Tab
 * account it read), never from whoever presents the voucher.
 */
export type VoucherScope = { programId: PublicKey; createdAt: bigint };
export const voucherScope = (programId: PublicKey, tab: { createdAt: bigint }): VoucherScope => ({ programId, createdAt: tab.createdAt });

const le64i = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };

/**
 * The exact bytes the program checks in the Ed25519 instruction:
 * "trellis:tab:voucher:v1" || program id (32) || tab (32) || created_at i64 LE || cumulative_used u64 LE || seq u64 LE.
 */
export function voucherBytes(v: Voucher, scope: VoucherScope): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(VOUCHER_DOMAIN, "ascii"), scope.programId.toBuffer(), v.tab.toBuffer(), le64i(scope.createdAt), le64(v.cumulativeUsed), le64(v.seq)]));
}

/** Read voucher bytes back into their fields; null when they are not a v1 voucher message (length or domain). */
export function parseVoucherBytes(message: Uint8Array): { voucher: Voucher; scope: VoucherScope } | null {
  const b = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  const d = VOUCHER_DOMAIN.length;
  if (b.length !== VOUCHER_MSG_LEN || b.subarray(0, d).toString("latin1") !== VOUCHER_DOMAIN) return null;
  return {
    voucher: { tab: new PublicKey(b.subarray(d + 32, d + 64)), cumulativeUsed: b.readBigUInt64LE(d + 72), seq: b.readBigUInt64LE(d + 80) },
    scope: { programId: new PublicKey(b.subarray(d, d + 32)), createdAt: b.readBigInt64LE(d + 64) },
  };
}

/** The Ed25519 program instruction carrying the voucher signature; must directly precede `close` / `post_voucher`. */
export function voucherSignatureIx(sessionKey: PublicKey, voucher: Voucher, signature: Uint8Array, scope: VoucherScope): TransactionInstruction {
  if (signature.length !== 64) throw new RangeError("voucher signature must be 64 bytes");
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: sessionKey.toBytes(), message: voucherBytes(voucher, scope), signature });
}

// ---- Events ----------------------------------------------------------------------------------------------------------

export type TabOpenedEvent = { tab: PublicKey; payer: PublicKey; payee: PublicKey; sessionKey: PublicKey; mint: PublicKey; tabId: bigint; cap: bigint; expiry: bigint; rulebook: PublicKey | null };
export const tabOpenedEvents = (programId: PublicKey | string, logs: readonly string[]): TabOpenedEvent[] => tabIdl.at(programId).eventsNamed<Raw>("TabOpened", logs).map((e) => ({ tab: e.tab, payer: e.payer, payee: e.payee, sessionKey: e.session_key, mint: e.mint, tabId: e.tab_id, cap: e.cap, expiry: e.expiry, rulebook: e.rulebook ?? null }));
export type TabClosedEvent = { tab: PublicKey; payer: PublicKey; payee: PublicKey; used: bigint; refunded: bigint; seq: bigint };
export const tabClosedEvents = (programId: PublicKey | string, logs: readonly string[]): TabClosedEvent[] => tabIdl.at(programId).eventsNamed<Raw>("TabClosed", logs).map((e) => ({ tab: e.tab, payer: e.payer, payee: e.payee, used: e.used, refunded: e.refunded, seq: e.seq }));
export type VoucherPostedEvent = { tab: PublicKey; cumulativeUsed: bigint; seq: bigint };
export const voucherPostedEvents = (programId: PublicKey | string, logs: readonly string[]): VoucherPostedEvent[] => tabIdl.at(programId).eventsNamed<Raw>("VoucherPosted", logs).map((e) => ({ tab: e.tab, cumulativeUsed: e.cumulative_used, seq: e.seq }));

// ---- Instructions ----------------------------------------------------------------------------------------------------

/** initialize_config(args) by the admin authority, which must be the program's upgrade authority (TR-13). `reclaimGrace` within [24 h, 7 d]. */
export function initializeConfigIx(programId: PublicKey, a: { authority: PublicKey; usdcMint: PublicKey; guardian: PublicKey; rulesProgram: PublicKey; maxCap?: bigint | null; reclaimGrace?: bigint | null }): TransactionInstruction {
  return tabAt(programId).instruction("initialize_config", { args: { guardian: a.guardian, rules_program: a.rulesProgram, max_cap: a.maxCap ?? null, reclaim_grace: a.reclaimGrace ?? null } }, { authority: a.authority, usdc_mint: a.usdcMint, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}

export type TabConfigChange = { newAuthority?: PublicKey | null; guardian?: PublicKey | null; rulesProgram?: PublicKey | null; maxCap?: bigint | null; reclaimGrace?: bigint | null };
const configArgs = (a: TabConfigChange) => ({ new_authority: a.newAuthority ?? null, guardian: a.guardian ?? null, rules_program: a.rulesProgram ?? null, max_cap: a.maxCap ?? null, reclaim_grace: a.reclaimGrace ?? null });
/** update_config(args): tightening only (a lower max_cap), effective at once; anything else needs proposeConfigIx + the 24 h timelock. */
export function updateConfigIx(programId: PublicKey, a: { authority: PublicKey } & TabConfigChange): TransactionInstruction {
  return tabAt(programId).instruction("update_config", { args: configArgs(a) }, { authority: a.authority });
}
/** propose_config(args): records any config change (or an authority hand-over) for the timelock. */
export function proposeConfigIx(programId: PublicKey, a: { authority: PublicKey } & TabConfigChange): TransactionInstruction {
  return tabAt(programId).instruction("propose_config", { args: configArgs(a) }, { authority: a.authority, system_program: SystemProgram.programId });
}
/** resolve_config(apply): the authority applies after the timelock and within 7 days of it (a new authority co-signs); only the authority cancels (anyone may clear an expired proposal). */
export function resolveConfigIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return tabAt(programId).instruction("resolve_config", { apply: a.apply }, { signer: a.signer, authority: a.authority, new_authority: a.newAuthority ?? null });
}

/**
 * The rulebook group open_tab / top_up take for a rulebook-bound tab: the payer's Rulebook, trellis_rules' config and
 * program. (trellis_tab's own ["enforcer"] PDA signs the CPI and is derived here.)
 */
export type RulebookAccounts = { rulebook: PublicKey; rulesConfig: PublicKey; rulesProgram: PublicKey };

/**
 * open_tab(args{tab_id, cap, expiry, session_key}, rulebook?): the payer signs and funds the escrow. With `rules`, the
 * rulebook must be the payer's own, alive and unexpired, and the cap is counted against its daily limit.
 */
export function openTabIx(programId: PublicKey, a: { payer: PublicKey; payerToken: PublicKey; payee: PublicKey; mint: PublicKey; tabId: bigint; cap: bigint; expiry: bigint; sessionKey: PublicKey; rules?: RulebookAccounts | null }): TransactionInstruction {
  return tabAt(programId).instruction("open_tab", { args: { tab_id: a.tabId, cap: a.cap, expiry: a.expiry, session_key: a.sessionKey } }, {
    payer: a.payer, payee: a.payee, mint: a.mint, payer_token: a.payerToken, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    rulebook: a.rules?.rulebook ?? null, rules_config: a.rules?.rulesConfig ?? null, rules_program: a.rules?.rulesProgram ?? null,
  });
}

/** top_up(amount) by the payer. A rulebook-bound tab passes its rulebook group: the top-up is a new commitment under it. */
export function topUpIx(programId: PublicKey, a: { payer: PublicKey; payerToken: PublicKey; tab: PublicKey; mint: PublicKey; amount: bigint; rules?: RulebookAccounts | null }): TransactionInstruction {
  return tabAt(programId).instruction("top_up", { amount: a.amount }, {
    payer: a.payer, tab: a.tab, mint: a.mint, escrow: tabEscrow(programId, a.tab), payer_token: a.payerToken, token_program: TOKEN_PROGRAM_ID,
    rulebook: a.rules?.rulebook ?? null, rules_config: a.rules?.rulesConfig ?? null, rules_program: a.rules?.rulesProgram ?? null,
  });
}

/**
 * close(cumulative_used, seq): the payee signs; pays `cumulative_used` from the escrow to the payee's USDC account and
 * the rest of the escrow to the payer's. `payerToken` should be the payer's associated token account: when it cannot
 * receive (missing, closed, frozen) the close still pays the payee and leaves the refund in escrow for `reclaim`. No
 * rulebook account is involved, whatever the tab was opened with.
 */
export function closeIx(programId: PublicKey, a: { tab: PublicKey; payer: PublicKey; payee: PublicKey; payeeToken: PublicKey; payerToken: PublicKey; mint: PublicKey; cumulativeUsed: bigint; seq: bigint }): TransactionInstruction {
  return tabAt(programId).instruction("close", { cumulative_used: a.cumulativeUsed, seq: a.seq }, {
    payee: a.payee, payer: a.payer, tab: a.tab, mint: a.mint, escrow: tabEscrow(programId, a.tab), payer_token: a.payerToken, payee_token: a.payeeToken, instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY, token_program: TOKEN_PROGRAM_ID,
  });
}

/** post_voucher(cumulative_used, seq): the payee records the highest voucher it holds (bounds a later reclaim). */
export function postVoucherIx(programId: PublicKey, a: { tab: PublicKey; payee: PublicKey; cumulativeUsed: bigint; seq: bigint }): TransactionInstruction {
  return tabAt(programId).instruction("post_voucher", { cumulative_used: a.cumulativeUsed, seq: a.seq }, { payee: a.payee, tab: a.tab, instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY });
}

/**
 * reclaim(): no signature of the payer or payee is needed (`payer` is only the wallet that gets the rent back). After
 * expiry + reclaim_grace, or at any time once the payee has closed, anyone delivers the escrow: the payee's posted
 * voucher to `payeeToken`, the rest to `payerToken`. A side whose token account cannot receive keeps its share in escrow.
 */
export function reclaimIx(programId: PublicKey, a: { tab: PublicKey; payer: PublicKey; payerToken: PublicKey; payeeToken: PublicKey; mint: PublicKey }): TransactionInstruction {
  return tabAt(programId).instruction("reclaim", {}, { payer: a.payer, tab: a.tab, mint: a.mint, escrow: tabEscrow(programId, a.tab), payer_token: a.payerToken, payee_token: a.payeeToken, token_program: TOKEN_PROGRAM_ID });
}
