import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { IdlProgram, programDataAddress, le64, type TrellisIdl } from "./idl.ts";
import idl from "../idl/trellis_fee_router.json";

// trellis_fee_router (docs/Trellis_Backend.md §5.7), built from src/solana/idl/trellis_fee_router.json. Protocol fees
// (USDC) collect in the fee vault PDA ["fee_vault"]; distribute(period) routes the whole vault balance per workers_bps /
// treasury_bps into the configured workers and treasury token accounts, once per strictly increasing period index. There
// is no fee split: the default and the only configuration the router applies is workers 0 / treasury 10,000, so every
// protocol fee reaches the treasury (hosts are paid their list price; relay operators and canary runners are paid flat
// service fees from the treasury, src/services/settlement.ts payServiceFees). The instruction and its sum invariant stay,
// so governance (production authority: a Squads 2-of-3) could set another split. No fee reaches token holders or stakers.
// $TRLS inference payments are burned (burn_inference_payment).
// PDA seeds: ["fee_config"], ["fee_vault"], ["trls_vault"], ["distribution", period LE].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const FEE_ROUTER_IDL = idl as unknown as TrellisIdl;
export const feeRouterIdl = new IdlProgram(FEE_ROUTER_IDL);
export const feeRouterAt = (programId: PublicKey | string) => feeRouterIdl.at(programId);

export const FEE_ROUTER_SEEDS = { config: [Buffer.from("fee_config")], feeVault: [Buffer.from("fee_vault")], trlsVault: [Buffer.from("trls_vault")], distribution: (period: bigint | number) => [Buffer.from("distribution"), le64(period)] };
/** No fee split: workers 0 bps, treasury 10,000 bps (the program's DEFAULT_WORKERS_BPS / DEFAULT_TREASURY_BPS). */
export const WORKERS_BPS = 0;
export const TREASURY_BPS = 10_000;
export const BPS_DENOMINATOR = 10_000n;
/** True when a FeeConfig routes everything to the treasury, the only split the router operates with. */
export const isTreasuryOnly = (c: { workersBps: number; treasuryBps: number }) => c.workersBps === WORKERS_BPS && c.treasuryBps === TREASURY_BPS;

export function feeRouterPdas(programId: PublicKey) {
  const [feeConfig] = PublicKey.findProgramAddressSync(FEE_ROUTER_SEEDS.config, programId);
  const [feeVault] = PublicKey.findProgramAddressSync(FEE_ROUTER_SEEDS.feeVault, programId);
  const [trlsVault] = PublicKey.findProgramAddressSync(FEE_ROUTER_SEEDS.trlsVault, programId);
  return { feeConfig, feeVault, trlsVault };
}
export const distributionPda = (programId: PublicKey, period: bigint | number) => PublicKey.findProgramAddressSync(FEE_ROUTER_SEEDS.distribution(period), programId)[0];

export type FeeConfig = { authority: PublicKey; feeMint: PublicKey; trlsMint: PublicKey; feeVault: PublicKey; trlsVault: PublicKey; workersVault: PublicKey; treasuryVault: PublicKey; workersBps: number; treasuryBps: number; lastPeriod: bigint; distributedTotal: bigint; burnedTotal: bigint };
export function decodeFeeConfig(data: Uint8Array): FeeConfig | null {
  const r = feeRouterIdl.decodeAccount<Raw>("FeeConfig", data);
  if (!r) return null;
  return { authority: r.authority, feeMint: r.fee_mint, trlsMint: r.trls_mint, feeVault: r.fee_vault, trlsVault: r.trls_vault, workersVault: r.workers_vault, treasuryVault: r.treasury_vault, workersBps: r.workers_bps, treasuryBps: r.treasury_bps, lastPeriod: r.last_period, distributedTotal: r.distributed_total, burnedTotal: r.burned_total };
}

export type Distribution = { period: bigint; total: bigint; workersAmount: bigint; treasuryAmount: bigint; distributedAt: bigint };
export function decodeDistribution(data: Uint8Array): Distribution | null {
  const r = feeRouterIdl.decodeAccount<Raw>("Distribution", data);
  if (!r) return null;
  return { period: r.period, total: r.total, workersAmount: r.workers_amount, treasuryAmount: r.treasury_amount, distributedAt: r.distributed_at };
}

export type FeesDistributedEvent = Distribution;
export const feesDistributedEvents = (programId: PublicKey | string, logs: readonly string[]): FeesDistributedEvent[] => feeRouterIdl.at(programId).eventsNamed<Raw>("FeesDistributed", logs).map((e) => ({ period: e.period, total: e.total, workersAmount: e.workers_amount, treasuryAmount: e.treasury_amount, distributedAt: e.distributed_at }));

/** The exact split the program applies: workers get floor(amount * workers_bps / 10000), the treasury the remainder (all of it at the 0/10,000 default). */
export function feeSplit(amount: bigint, workersBps = WORKERS_BPS) {
  const workers = (amount * BigInt(workersBps)) / BPS_DENOMINATOR;
  return { workers, treasury: amount - workers };
}

/** Weekly period index of a date: whole weeks since the unix epoch (Thursday-aligned), strictly increasing per week. */
export const weekPeriod = (d: Date) => Math.floor(d.getTime() / 1000 / (7 * 86_400));

/**
 * The fee vault, the workers vault and the treasury vault must be three different accounts: `distribute` writes all
 * three, and the runtime refuses the same account twice, so a config with two alike could never distribute again. The
 * program refuses such a config at init and at every proposal (`DuplicateVault`, security review round 3, R3-27); the
 * builders refuse it before anything is signed.
 */
function requireDistinctVaults(programId: PublicKey, workersVault?: PublicKey | null, treasuryVault?: PublicKey | null) {
  const feeVault = feeRouterPdas(programId).feeVault;
  const same = (a?: PublicKey | null, b?: PublicKey | null) => !!a && !!b && a.equals(b);
  if (same(workersVault, treasuryVault) || same(workersVault, feeVault) || same(treasuryVault, feeVault)) throw new RangeError("the fee vault, the workers vault and the treasury vault must be three different accounts");
}

/**
 * init_fee_config(authority, workers_bps, treasury_bps): the fee vault (USDC) and the $TRLS (Token-2022) vault are
 * created. `payer` (default: `authority`) must be the program's upgrade authority (TR-13); `authority` is the key that
 * will distribute and burn, and need not be the payer. The workers and treasury vaults must differ (R3-27).
 */
export function initFeeConfigIx(programId: PublicKey, a: { authority: PublicKey; feeMint: PublicKey; trlsMint: PublicKey; workersVault: PublicKey; treasuryVault: PublicKey; workersBps?: number; treasuryBps?: number; feeTokenProgram?: PublicKey; payer?: PublicKey }): TransactionInstruction {
  requireDistinctVaults(programId, a.workersVault, a.treasuryVault);
  return feeRouterAt(programId).instruction("init_fee_config", { authority: a.authority, workers_bps: a.workersBps ?? WORKERS_BPS, treasury_bps: a.treasuryBps ?? TREASURY_BPS }, { payer: a.payer ?? a.authority, fee_mint: a.feeMint, trls_mint: a.trlsMint, workers_vault: a.workersVault, treasury_vault: a.treasuryVault, program_data: programDataAddress(programId), fee_token_program: a.feeTokenProgram ?? TOKEN_PROGRAM_ID, token_2022_program: TOKEN_2022_PROGRAM_ID, system_program: SystemProgram.programId });
}

/**
 * update_fee_config(workers_bps?, treasury_bps?): the authority changes the split between the two configured vaults
 * (both values, summing to 10,000). The vaults themselves change only through proposeChangeIx and its 24 h timelock.
 */
export function updateFeeConfigIx(programId: PublicKey, a: { authority: PublicKey; workersBps?: number | null; treasuryBps?: number | null }): TransactionInstruction {
  return feeRouterAt(programId).instruction("update_fee_config", { workers_bps: a.workersBps ?? null, treasury_bps: a.treasuryBps ?? null }, { authority: a.authority });
}
/**
 * propose_change(new_authority?): records replacement payout vaults and / or a new authority for the timelock. The
 * program refuses a proposal that would leave two of the three vaults the same account (`DuplicateVault`); what can be
 * told without reading the config (the two replacements alike, or one of them the fee vault) is refused here.
 */
export function proposeChangeIx(programId: PublicKey, a: { authority: PublicKey; newAuthority?: PublicKey | null; newWorkersVault?: PublicKey | null; newTreasuryVault?: PublicKey | null }): TransactionInstruction {
  requireDistinctVaults(programId, a.newWorkersVault, a.newTreasuryVault);
  return feeRouterAt(programId).instruction("propose_change", { new_authority: a.newAuthority ?? null }, { authority: a.authority, new_workers_vault: a.newWorkersVault ?? null, new_treasury_vault: a.newTreasuryVault ?? null, system_program: SystemProgram.programId });
}
/** resolve_change(apply) by the authority: apply after the timelock (a new authority co-signs), or drop the proposal. */
export function resolveChangeIx(programId: PublicKey, a: { authority: PublicKey; apply: boolean; newAuthority?: PublicKey | null }): TransactionInstruction {
  return feeRouterAt(programId).instruction("resolve_change", { apply: a.apply }, { authority: a.authority, new_authority: a.newAuthority ?? null });
}

/** A USDC transfer from `sourceToken` (owned by `owner`) into the fee vault; what settlement sends before distributing. */
export function fundFeeVaultIx(programId: PublicKey, a: { owner: PublicKey; sourceToken: PublicKey; mint: PublicKey; amount: bigint; decimals?: number }): TransactionInstruction {
  return createTransferCheckedInstruction(a.sourceToken, a.mint, feeRouterPdas(programId).feeVault, a.owner, a.amount, a.decimals ?? 6);
}

/** distribute(period): the authority splits the whole fee vault balance into the configured vaults. */
export function distributeIx(programId: PublicKey, a: { authority: PublicKey; period: bigint | number; workersVault: PublicKey; treasuryVault: PublicKey; feeMint: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  const { feeVault } = feeRouterPdas(programId);
  return feeRouterAt(programId).instruction("distribute", { period: BigInt(a.period) }, { authority: a.authority, fee_vault: feeVault, workers_vault: a.workersVault, treasury_vault: a.treasuryVault, fee_mint: a.feeMint, token_program: a.tokenProgram ?? TOKEN_PROGRAM_ID, system_program: SystemProgram.programId });
}

/**
 * burn_inference_payment(amount) by the authority: burns `amount` of $TRLS (Token-2022) held in the ["trls_vault"] PDA,
 * the $TRLS a caller paid for inference, and adds it to FeeConfig.burned_total. The mint's supply falls by `amount`.
 */
export function burnInferencePaymentIx(programId: PublicKey, a: { authority: PublicKey; trlsMint: PublicKey; amount: bigint }): TransactionInstruction {
  return feeRouterAt(programId).instruction("burn_inference_payment", { amount: a.amount }, { authority: a.authority, trls_mint: a.trlsMint, trls_vault: feeRouterPdas(programId).trlsVault, token_2022_program: TOKEN_2022_PROGRAM_ID });
}

export type InferencePaymentBurnedEvent = { amount: bigint; burnedTotal: bigint };
export const inferencePaymentBurnedEvents = (programId: PublicKey | string, logs: readonly string[]): InferencePaymentBurnedEvent[] => feeRouterIdl.at(programId).eventsNamed<Raw>("InferencePaymentBurned", logs).map((e) => ({ amount: e.amount, burnedTotal: e.burned_total }));
