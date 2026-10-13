import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { IdlProgram, le64, programDataAddress, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_rules.json";

// trellis_rules (docs/Trellis_Backend.md §5.5), built from src/solana/idl/trellis_rules.json. A Rulebook{per_call_max,
// daily_max, allowlist roots, ask_first_above, expiry, killed} owned by an agent's wallet. trellis_tab::open_tab and
// top_up CPI into record_commitment (signed by the tab program's ["enforcer"] PDA, which RulesConfig.enforcer must
// name): the escrowed amount counts against daily_max and a killed or expired rulebook refuses it. per_call_max is the
// payee's check per request. Settlement (close, reclaim) never consults the rulebook. A killed rulebook cannot be closed.
// PDA seeds: ["config"], ["rulebook", owner, rulebook_id LE], ["pending_config"].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const RULES_IDL = idl as unknown as TrellisIdl;
export const rulesIdl = new IdlProgram(RULES_IDL);
export const rulesAt = (programId: PublicKey | string) => rulesIdl.at(programId);

export const RULES_SEEDS = { config: [Buffer.from("config")], rulebook: (owner: PublicKey, id: bigint | number) => [Buffer.from("rulebook"), owner.toBuffer(), le64(id)] };
export const rulesConfigPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(RULES_SEEDS.config, programId)[0];
export const rulebookPda = (programId: PublicKey, owner: PublicKey, id: bigint | number) => PublicKey.findProgramAddressSync(RULES_SEEDS.rulebook(owner, id), programId)[0];

export type RulebookParams = { perCallMax: bigint; dailyMax: bigint; payeeAllowlistRoot: Uint8Array; modelAllowlistRoot: Uint8Array; askFirstAbove: bigint; expiry: bigint };
export type Rulebook = RulebookParams & { owner: PublicKey; rulebookId: bigint; killed: boolean; spentDay: bigint; spentToday: bigint };
export function decodeRulebook(data: Uint8Array): Rulebook | null {
  const r = rulesIdl.decodeAccount<Raw>("Rulebook", data);
  if (!r) return null;
  return { owner: r.owner, rulebookId: r.rulebook_id, perCallMax: r.per_call_max, dailyMax: r.daily_max, payeeAllowlistRoot: r.payee_allowlist_root, modelAllowlistRoot: r.model_allowlist_root, askFirstAbove: r.ask_first_above, expiry: r.expiry, killed: r.killed, spentDay: r.spent_day, spentToday: r.spent_today };
}
export type RulesConfig = { authority: PublicKey; guardian: PublicKey; enforcer: PublicKey; newRulebooksPaused: boolean; pausedUntil: bigint; guardianPauseReadyAt: bigint };
export function decodeRulesConfig(data: Uint8Array): RulesConfig | null {
  const r = rulesIdl.decodeAccount<Raw>("RulesConfig", data);
  if (!r) return null;
  return { authority: r.authority, guardian: r.guardian, enforcer: r.enforcer, newRulebooksPaused: r.new_rulebooks_paused, pausedUntil: r.paused_until, guardianPauseReadyAt: r.guardian_pause_ready_at };
}

const params = (p: RulebookParams) => ({ per_call_max: p.perCallMax, daily_max: p.dailyMax, payee_allowlist_root: p.payeeAllowlistRoot, model_allowlist_root: p.modelAllowlistRoot, ask_first_above: p.askFirstAbove, expiry: p.expiry });

/** init_config(guardian, enforcer) by the admin authority, which must be the program's upgrade authority (TR-13). */
export function initConfigIx(programId: PublicKey, a: { authority: PublicKey; guardian: PublicKey; enforcer: PublicKey }): TransactionInstruction {
  return rulesAt(programId).instruction("init_config", { guardian: a.guardian, enforcer: a.enforcer }, { authority: a.authority, program_data: programDataAddress(programId), system_program: SystemProgram.programId });
}
/** propose_config(new_authority?, guardian?, enforcer?): every change of a role waits the 24 h timelock. */
export function proposeConfigIx(programId: PublicKey, a: { authority: PublicKey; newAuthority?: PublicKey | null; guardian?: PublicKey | null; enforcer?: PublicKey | null }): TransactionInstruction {
  return rulesAt(programId).instruction("propose_config", { new_authority: a.newAuthority ?? null, guardian: a.guardian ?? null, enforcer: a.enforcer ?? null }, { authority: a.authority, system_program: SystemProgram.programId });
}
/** resolve_config(apply): the authority applies after the timelock and within 7 days of it (a new authority co-signs); only the authority cancels (anyone may clear an expired proposal). */
export function resolveConfigIx(programId: PublicKey, a: { signer: PublicKey; authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return rulesAt(programId).instruction("resolve_config", { apply: a.apply }, { signer: a.signer, authority: a.authority, new_authority: a.newAuthority ?? null });
}
export function createRulebookIx(programId: PublicKey, a: { owner: PublicKey; rulebookId: bigint; params: RulebookParams }): TransactionInstruction {
  return rulesAt(programId).instruction("create_rulebook", { rulebook_id: a.rulebookId, params: params(a.params) }, { owner: a.owner, system_program: SystemProgram.programId });
}
export function updateRulebookIx(programId: PublicKey, a: { owner: PublicKey; rulebookId: bigint; params: RulebookParams }): TransactionInstruction {
  return rulesAt(programId).instruction("update_rulebook", { params: params(a.params) }, { owner: a.owner, rulebook: rulebookPda(programId, a.owner, a.rulebookId) });
}
export const killRulebookIx = (programId: PublicKey, a: { owner: PublicKey; rulebookId: bigint }) => rulesAt(programId).instruction("kill_rulebook", {}, { owner: a.owner, rulebook: rulebookPda(programId, a.owner, a.rulebookId) });
export const closeRulebookIx = (programId: PublicKey, a: { owner: PublicKey; rulebookId: bigint }) => rulesAt(programId).instruction("close_rulebook", {}, { owner: a.owner, rulebook: rulebookPda(programId, a.owner, a.rulebookId) });
