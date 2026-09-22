import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Ctx } from "../context.ts";
import { bondConfigSpec, capacityCommitmentSpec, capacityConfigSpec, hostBondSpec, slashProposalSpec } from "../solana/account-specs.ts";
import { bondPdas, executeSlashIx, proposalPda, slashLedgerPda } from "../solana/programs/bond.ts";
import { bondLockAccounts, capacityAt, capacityConfigPda, capacityIdl, hostCapacityPda, releaseCommitmentIx, type CapacityCommitment, type CapacityConfig } from "../solana/programs/capacity.ts";
import { readVerifiedAccount, verifyAccountInfo, type AccountSpec } from "../solana/verified-account.ts";
import type { Role } from "../solana/chain-service.ts";
import { withRetry } from "../solana/rpc.ts";

// The router's handle on trellis_capacity (docs/Trellis_Backend.md §5.6), built on the generated IDL client
// (src/solana/programs/capacity.ts) without changing it. `CapacityChain` is everything the Bushel service asks of the
// chain; `solanaCapacityChain` answers through the router's RPC connection and role keys, and a fake stands in offline.
//
// Who signs: buy_lot and redeem_lot are signed by the sale authority (the settlement key); report_shortfall, rehome_lot
// and claim_lot_shortfall by the program authority (BUSHEL_AUTHORITY_ROLE while one operator key holds every authority,
// §10; once the multisig holds it, those three are prepared by the multisig and the job only reports what is due).
// A filed claim is a trellis_bond proposal: after its dispute window anyone may crank execute_slash, and nothing else in
// the router does that for capacity claims, so the job cranks it itself (executeClaim) with the same role key. Until
// then the buyer's refund would wait on a transaction nobody sends.

export type OnchainCommitment = CapacityCommitment & { address: string };
export type OnchainLot = { address: string; commitment: string; lotId: number; keyHash: Uint8Array; grade: number; tokens: bigint; windowStart: bigint; windowEnd: bigint; pricePaid: bigint; redeemed: boolean; shortfallClaimed: boolean; refundAmount: bigint; rehomedTo: string | null };
export type ClaimState = "open" | "executed" | "gone";

export interface CapacityChain {
  /** Address of the key that may sign sales and redemptions on this router, or null. */
  saleSigner(): string | null;
  /** Address of the key that may sign shortfall reports, rehomes and claims on this router, or null. */
  authoritySigner(): string | null;
  config(): Promise<CapacityConfig | null>;
  /** The commitments on offer: the configured list, or every commitment account of the program. */
  commitments(): Promise<OnchainCommitment[]>;
  commitment(address: string): Promise<OnchainCommitment | null>;
  lot(address: string): Promise<OnchainLot | null>;
  lotAddress(commitment: string, lotId: number): string;
  buyLot(a: { commitment: string; lotId: number; keyHash: Uint8Array; tokens: bigint; pricePaid: bigint }): Promise<{ tx: string }>;
  redeemLot(a: { lot: string }): Promise<{ tx: string }>;
  reportShortfall(a: { commitment: OnchainCommitment; unservedTokens: bigint }): Promise<{ tx: string }>;
  rehomeLot(a: { commitment: string; lot: string; replacement: string }): Promise<{ tx: string }>;
  claimLotShortfall(a: { commitment: OnchainCommitment; lot: string; evidenceHash: Uint8Array }): Promise<{ tx: string; claim: string }>;
  /** Whether a filed bond claim has been executed (the dispute window passed and the bond paid). */
  claimState(claim: string): Promise<ClaimState>;
  /**
   * What an executed claim actually paid out of the bond (SlashProposal.executed_amount): the bond pays at most what it
   * still holds, so this can be less than the claim. Null when the claim is not executed (or is gone).
   */
  claimExecutedAmount?(claim: string): Promise<bigint | null>;
  /**
   * Crank trellis_bond::execute_slash for a filed claim: the program pays the claim from the host's bond into the
   * capacity refund account. Null while the chain would refuse it (the dispute window is open, a dispute blocks it, the
   * authority rejected it) or when it is already executed or gone.
   */
  executeClaim(claim: string): Promise<{ tx: string } | null>;
  /**
   * trellis_capacity::release_commitment: anyone, once window_end + the program's claim period has passed. Settles the
   * commitment and frees the part of the host's bond it locked (security review TR-11). Null while the chain would
   * refuse it or when the commitment is already settled.
   */
  releaseCommitment?(a: { commitment: OnchainCommitment }): Promise<{ tx: string } | null>;
}

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
/** PDA of a lot: ["lot", commitment, lot_id LE (u32)]. */
export const lotPda = (programId: PublicKey, commitment: PublicKey, lotId: number) => PublicKey.findProgramAddressSync([Buffer.from("lot"), commitment.toBuffer(), u32le(lotId)], programId)[0];

/** A BushelLot: owned by trellis_capacity, at ["lot", commitment, lot_id LE (u32)]. */
export const bushelLotSpec = (programId: PublicKey): AccountSpec<OnchainLot> => ({
  name: "BushelLot",
  owner: programId,
  decode: (data) => { const l = decodeBushelLot("", data); return l ? { ...l, address: lotPda(programId, new PublicKey(l.commitment), l.lotId).toBase58() } : null; },
  derive: (l) => new PublicKey(l.address),
});

export function decodeBushelLot(address: string, data: Uint8Array): OnchainLot | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = capacityIdl.decodeAccount<Record<string, any>>("BushelLot", data);
  if (!r) return null;
  return { address, commitment: r.commitment.toBase58(), lotId: Number(r.lot_id), keyHash: new Uint8Array(r.key_hash), grade: r.grade, tokens: r.tokens, windowStart: r.window_start, windowEnd: r.window_end, pricePaid: r.price_paid, redeemed: r.redeemed, shortfallClaimed: r.shortfall_claimed, refundAmount: r.refund_amount, rehomedTo: r.rehomed_to ? r.rehomed_to.toBase58() : null };
}

// ---- instructions (pure; the offline suite checks their accounts and data against the IDL) --------------------------

export function buyLotIx(programId: PublicKey, a: { saleAuthority: PublicKey; commitment: PublicKey; lotId: number; keyHash: Uint8Array; tokens: bigint; pricePaid: bigint }): TransactionInstruction {
  return capacityAt(programId).instruction("buy_lot", { args: { lot_id: a.lotId, key_hash: a.keyHash, tokens: a.tokens, price_paid: a.pricePaid } }, { sale_authority: a.saleAuthority, commitment: a.commitment, lot: lotPda(programId, a.commitment, a.lotId), system_program: SystemProgram.programId });
}

export function redeemLotIx(programId: PublicKey, a: { saleAuthority: PublicKey; lot: PublicKey }): TransactionInstruction {
  return capacityAt(programId).instruction("redeem_lot", {}, { sale_authority: a.saleAuthority, lot: a.lot });
}

export function reportShortfallIx(programId: PublicKey, bondProgramId: PublicKey, a: { authority: PublicKey; commitment: PublicKey; host: PublicKey; hostBond: PublicKey; unservedTokens: bigint }): TransactionInstruction {
  // The bond accounts are there for the unlock: a commitment reported fully served releases its bond lock at once.
  return capacityAt(programId).instruction("report_shortfall", { unserved_tokens: a.unservedTokens }, { authority: a.authority, commitment: a.commitment, host_capacity: hostCapacityPda(programId, a.host), ...bondLockAccounts(bondProgramId, a.hostBond) });
}

export function rehomeLotIx(programId: PublicKey, a: { authority: PublicKey; commitment: PublicKey; lot: PublicKey; replacement: PublicKey }): TransactionInstruction {
  return capacityAt(programId).instruction("rehome_lot", {}, { authority: a.authority, commitment: a.commitment, lot: a.lot, replacement: a.replacement });
}

export function claimLotShortfallIx(programId: PublicKey, bondProgramId: PublicKey, a: { authority: PublicKey; commitment: PublicKey; lot: PublicKey; hostBond: PublicKey; proposalId: bigint; evidenceHash: Uint8Array }): TransactionInstruction {
  return capacityAt(programId).instruction(
    "claim_lot_shortfall",
    { proposal_id: a.proposalId, evidence_hash: a.evidenceHash },
    // bond_lock: trellis_bond takes the claim out of the commitment's lock and refuses one larger than what is locked (R3-16).
    { authority: a.authority, commitment: a.commitment, lot: a.lot, ...bondLockAccounts(bondProgramId, a.hostBond), bond_config: bondPdas(bondProgramId).config, proposal: proposalPda(bondProgramId, a.hostBond, a.proposalId), slash_ledger: slashLedgerPda(bondProgramId, a.hostBond), system_program: SystemProgram.programId },
  );
}

// ---- the Solana implementation --------------------------------------------------------------------------------------

export function solanaCapacityChain(ctx: Pick<Ctx, "cfg" | "chain">): CapacityChain {
  const cfg = ctx.cfg;
  const programId = () => {
    const id = cfg.solana.programs.capacity;
    if (!id) throw new Error("TRELLIS_CAPACITY_PROGRAM_ID is not set.");
    return new PublicKey(id);
  };
  const bondProgramId = () => {
    const id = cfg.solana.programs.bond;
    if (!id) throw new Error("TRELLIS_BOND_PROGRAM_ID is not set.");
    return new PublicKey(id);
  };
  const authorityRole = cfg.bushels.authorityRole as Role;
  // Every account is believed only when its program owns it at the PDA of its own fields (security review TR-02):
  // commitment and lot addresses reach this module from configuration, stored rows and requests.
  const verified = <T>(address: PublicKey, spec: AccountSpec<T>) => readVerifiedAccount(ctx.chain.connection, address, spec, cfg.solana.commitment);
  const commitment = async (address: string): Promise<OnchainCommitment | null> => {
    const c = await verified(new PublicKey(address), capacityCommitmentSpec(programId()));
    return c ? { ...c, address } : null;
  };
  const signerOf = (role: Role) => {
    const kp = ctx.chain.signer(role);
    if (!kp) throw new Error(`No ${role} signing key is configured.`);
    return kp.publicKey;
  };

  return {
    saleSigner: () => ctx.chain.roleAddress("settlement") ?? null,
    authoritySigner: () => ctx.chain.roleAddress(authorityRole) ?? null,
    async config() {
      return verified(capacityConfigPda(programId()), capacityConfigSpec(programId()));
    },
    async commitments() {
      if (cfg.bushels.commitments.length) return (await Promise.all(cfg.bushels.commitments.map(commitment))).filter((c): c is OnchainCommitment => !!c);
      // No list configured: ask the RPC for the program's commitment accounts (a full node answers; a restricted transport may not).
      const conn = ctx.chain.connection as Partial<Pick<Connection, "getProgramAccounts">>;
      if (!conn.getProgramAccounts) return [];
      const disc = Buffer.from(capacityIdl.accountDiscriminator("CapacityCommitment"));
      const found = await withRetry(() => conn.getProgramAccounts!(programId(), { commitment: cfg.solana.commitment, filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }] }));
      // getProgramAccounts answers with what the node says the program owns: each account is still checked (owner, PDA).
      const spec = capacityCommitmentSpec(programId());
      const checked = (f: (typeof found)[number]) => { try { return verifyAccountInfo(f.pubkey, f.account, spec); } catch { return null; } };
      return found.map((f) => ({ c: checked(f), address: f.pubkey.toBase58() })).filter((x) => !!x.c).map((x) => ({ ...x.c!, address: x.address }));
    },
    commitment,
    async lot(address) {
      return verified(new PublicKey(address), bushelLotSpec(programId()));
    },
    lotAddress: (c, lotId) => lotPda(programId(), new PublicKey(c), lotId).toBase58(),
    async buyLot(a) {
      const r = await ctx.chain.send("settlement", [buyLotIx(programId(), { saleAuthority: signerOf("settlement"), commitment: new PublicKey(a.commitment), lotId: a.lotId, keyHash: a.keyHash, tokens: a.tokens, pricePaid: a.pricePaid })]);
      return { tx: r.hash };
    },
    async redeemLot(a) {
      const r = await ctx.chain.send("settlement", [redeemLotIx(programId(), { saleAuthority: signerOf("settlement"), lot: new PublicKey(a.lot) })]);
      return { tx: r.hash };
    },
    async reportShortfall(a) {
      const r = await ctx.chain.send(authorityRole, [reportShortfallIx(programId(), bondProgramId(), { authority: signerOf(authorityRole), commitment: new PublicKey(a.commitment.address), host: a.commitment.host, hostBond: a.commitment.hostBond, unservedTokens: a.unservedTokens })]);
      return { tx: r.hash };
    },
    async rehomeLot(a) {
      const r = await ctx.chain.send(authorityRole, [rehomeLotIx(programId(), { authority: signerOf(authorityRole), commitment: new PublicKey(a.commitment), lot: new PublicKey(a.lot), replacement: new PublicKey(a.replacement) })]);
      return { tx: r.hash };
    },
    async claimLotShortfall(a) {
      const bond = await verified(a.commitment.hostBond, hostBondSpec(bondProgramId()));
      if (!bond) throw new Error("The host's bond account was not found.");
      const proposal = proposalPda(bondProgramId(), a.commitment.hostBond, bond.nextProposalId);
      const ix = claimLotShortfallIx(programId(), bondProgramId(), { authority: signerOf(authorityRole), commitment: new PublicKey(a.commitment.address), lot: new PublicKey(a.lot), hostBond: a.commitment.hostBond, proposalId: bond.nextProposalId, evidenceHash: a.evidenceHash });
      const r = await ctx.chain.send(authorityRole, [ix]);
      return { tx: r.hash, claim: proposal.toBase58() };
    },
    async claimState(claim) {
      const p = await verified(new PublicKey(claim), slashProposalSpec(bondProgramId()));
      if (!p) return "gone";
      return p.executed ? "executed" : "open";
    },
    async claimExecutedAmount(claim) {
      const p = await verified(new PublicKey(claim), slashProposalSpec(bondProgramId()));
      return p && p.executed ? p.executedAmount : null;
    },
    async executeClaim(claim) {
      // The chain's own rule for when a proposal may execute: its window end, pushed back while a dispute is open.
      const at = await ctx.chain.slashExecutableAt(claim);
      if (at === null || at === "rejected" || at > BigInt(await ctx.chain.blockTimestamp())) return null;
      const proposal = await verified(new PublicKey(claim), slashProposalSpec(bondProgramId()));
      if (!proposal || proposal.executed) return null;
      const bond = await verified(proposal.bond, hostBondSpec(bondProgramId()));
      const bondConfig = await verified(bondPdas(bondProgramId()).config, bondConfigSpec(bondProgramId()));
      if (!bond || !bondConfig) throw new Error("The claim's bond or the bond config was not found.");
      const ix = executeSlashIx(bondProgramId(), { cranker: signerOf(authorityRole), host: bond.host, proposalId: proposal.proposalId, mint: bondConfig.usdcMint, refundPool: bondConfig.refundPool, treasury: bondConfig.treasury, capacityRefund: bondConfig.capacityRefund });
      const r = await ctx.chain.send(authorityRole, [ix]);
      return { tx: r.hash };
    },
    async releaseCommitment(a) {
      const current = await commitment(a.commitment.address);
      if (!current || current.status === "Settled") return null;
      // Permissionless on chain; the authority role's wallet only pays the fee.
      const r = await ctx.chain.send(authorityRole, [releaseCommitmentIx(programId(), bondProgramId(), { commitment: new PublicKey(current.address), host: current.host, hostBond: current.hostBond })]);
      return { tx: r.hash };
    },
  };
}

const overrides = new WeakMap<object, CapacityChain>();
/** Replace a router's capacity chain (an offline fake). */
export const setCapacityChain = (ctx: Pick<Ctx, "cfg">, chain: CapacityChain) => void overrides.set(ctx.cfg, chain);
export const capacityChain = (ctx: Pick<Ctx, "cfg" | "chain">): CapacityChain => overrides.get(ctx.cfg) ?? solanaCapacityChain(ctx);
