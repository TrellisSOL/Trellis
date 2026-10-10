import { Keypair, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";
import { notPorted } from "./constants.ts";
import { loadSigner } from "./keys.ts";
import { createConnection, sendAndConfirm, slotAndTime, withRetry, type RpcLike } from "./rpc.ts";
import { buildFloor } from "./build-profile.ts";
import { bondConfigSpec, creditsConfigSpec, hostBondSpec, hostRootSpec, pendingSignerSpec, receiptRootSpec, signerSetSpec, slashLedgerSpec, slashProposalSpec, spentRootSpec } from "./account-specs.ts";
import { commitSpentRootIx, creditsPdas, settleToHostIx, spentRootPda, SECONDS_PER_HOUR as CREDITS_HOUR, type CreditsConfig } from "./programs/credits.ts";
import { anchorIdl, anchorPdas, hostRootPda, postHostRootIx, postRootIx, PROPOSAL_TTL_SECONDS, proposeSignerIx, receiptRootHour, receiptRootPda, resolveSignerIx, revokeSignerIx } from "./programs/anchor.ts";
import { bondIdl, bondPdas, executeSlashIx, MAX_SLASH_BPS_PER_PROPOSAL, proposeSlashIx, proposalPda, SLASH_REASONS, SLASH_SCHEDULE, slashLedgerPda, slashWouldBeCut, type SlashProposal } from "./programs/bond.ts";
import { readVerifiedAccount, type AccountSpec } from "./verified-account.ts";
import { hex32, toHex0x } from "./programs/encoding.ts";

// The router's single handle on the chain. Every "contract" below is a Trellis Anchor program and every address a
// base58 public key; amounts are bigint base units; "blocks" are slots. Reads go through `connection` (or an injected
// RpcLike in tests); writes sign with the role Keypairs loaded from config and send plainly through the RPC. Methods the
// EVM-era services still call keep their names; the ones that have no Solana program yet (royalties, the IPX feed) throw
// `not ported to Solana yet`. Escrow receipts, pay-with-stock sessions, x402 authorization lookups and the faucet deposit
// live in their own modules (src/solana/escrow.ts, paywith.ts, src/tools/x402.ts, faucet.ts), not on this class.
// The instruction shapes come from the generated IDLs (src/solana/programs/*.ts), never from this file.

export type ContractName = "credits" | "callPay" | "payWithStock" | "providerBond" | "receiptAnchor" | "royalty";
export const CONTRACT_NAMES: readonly ContractName[] = ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty"];

export type DecodedLog = { contract: ContractName; event: string; args: Record<string, unknown>; txHash: string; logIndex: number; blockNumber: bigint };
export type EscrowTransfer = { token: string; from: string; value: bigint; txHash: string; logIndex: number; blockNumber: bigint; blockHash: string };
export type UsdcTransfer = { from: string; to: string; value: bigint; txHash: string; logIndex: number; blockNumber: bigint; blockTime: number; authorized: boolean; txFrom: string | null };
/** Head and finality point of the chain: `head` is the latest confirmed slot and `final` the last finalized slot. */
export type EscrowFinality = { head: bigint; headTime: number; final: bigint; finalHash: string; finalTime: number };
export type FeedReading = { answer: bigint; decimals: number; updatedAt: number };
export type CallPayment = { nonce: string; payer: string; amount: bigint; blockNumber: bigint; confirmations: number; logIndex: number };
export type ChargeAuthorization = { keyHash: string; token: string; usdcAmount: bigint; maxRaw: bigint; usageCommitment: string; nonce: bigint; epoch: bigint; deadline: bigint; router: string };
export type AllowanceAuthorization = { keyHash: string; token: string; maxRawTotal: bigint; maxRawPerCharge: bigint; validUntil: bigint; nonce: bigint; epoch: bigint; router: string };
export type OnchainAllowance = { maxRawTotal: bigint; maxRawPerCharge: bigint; spentRaw: bigint; nonce: bigint; validUntil: bigint; epoch: bigint; router: string; nextNonce: bigint };

/** The latest committed spend root as trellis_credits holds it: config.{latest_hour, spent_total} and that hour's SpentRoot. */
export type LatestSpentRoot = { hour: bigint; root: string; totalSpent: bigint; committedAt: number };
export type OnchainSignerSet = { authority: string; currentSigner: string; previousSigner: string; rotatedAt: bigint; rotationCount: bigint };
export type OnchainReceiptRoot = { hour: number; root: string; count: number; signer: string; postedAt: number };
export type OnchainHostRoot = { providerIdHash: string; hour: number; root: string; count: number; signer: string; postedAt: number };

/** A receipt signer proposed to trellis_anchor and not yet installed: `effectiveAt` is when resolve_signer will accept it. */
export type OnchainPendingSigner = { newSigner: string; proposedAt: bigint; effectiveAt: bigint };
/**
 * A receipt signing key is on its way to the SignerSet but is not the current signer yet: trellis_anchor installs a new
 * signer no sooner than 24 h after it was proposed (security review round 3). `registerSigningKey` throws this for as
 * long as that is so; calling it again once `effectiveAt` has passed installs the key.
 */
export class SignerProposalPending extends Error {
  constructor(readonly publicKey: string, readonly effectiveAt: number, readonly proposedNow: boolean, readonly hash: string | null = null) {
    super(`the receipt signer ${publicKey} is ${proposedNow ? "now proposed" : "proposed"} to trellis_anchor and can be installed from ${new Date(effectiveAt * 1000).toISOString()} (24 h timelock); it is not the current signer yet`);
    this.name = "SignerProposalPending";
  }
}

export type Role = "router" | "settlement" | "anchorer" | "slasher" | "keeper" | "ipx" | "faucet" | "facilitator";

/** Legacy EVM-style client handle: `getChainId` answers from config; any other method rejects with `not ported`. */
export type RpcClient = Record<string, (...args: any[]) => Promise<any>>;
/** A chain role: its address and Keypair. Methods of the old EVM wallet shape reject. */
export type RoleSigner = { account: { address: string }; keypair: Keypair } & Record<string, any>;

const rejecting = <T extends object>(prefix: string, base: T) =>
  new Proxy(base as T & Record<string, any>, {
    get(target, prop) {
      if (prop in target || typeof prop !== "string") return (target as Record<PropertyKey, unknown>)[prop];
      return async () => { throw notPorted(`${prefix}.${prop}`); };
    },
  });

const ROLE_KEYS: Record<Role, (c: Config) => string | undefined> = {
  router: (c) => c.chain.routerKey,
  settlement: (c) => c.chain.settlementKey,
  anchorer: (c) => c.chain.anchorerKey,
  slasher: (c) => c.chain.slasherKey,
  keeper: (c) => c.chain.keeperKey,
  ipx: (c) => c.chain.ipxKeeperKey,
  faucet: (c) => c.chain.faucetKey,
  facilitator: (c) => c.facilitator.relayKey,
};

const ZERO_ROOT = `0x${"00".repeat(32)}`;

export class ChainService {
  /** No viem chain definition on Solana; callers that still pass it along accept `undefined`. */
  readonly chain: undefined = undefined;
  readonly client: RpcClient;
  /** The RPC connection (a fake in tests). */
  connection: RpcLike;
  private signers = new Map<Role, RoleSigner>();

  constructor(private cfg: Config, connection?: RpcLike) {
    this.connection = connection ?? (createConnection({ rpcUrl: cfg.chain.rpcUrl, rpcFallbackUrls: cfg.chain.rpcFallbackUrls, commitment: cfg.solana.commitment }) as Connection);
    this.client = rejecting("rpc", { getChainId: async () => cfg.chain.id, getSlot: async () => this.blockNumber() }) as RpcClient;
    for (const role of Object.keys(ROLE_KEYS) as Role[]) {
      const secret = ROLE_KEYS[role](cfg);
      if (!secret) continue;
      const keypair = loadSigner(secret); // throws without echoing the secret
      this.signers.set(role, rejecting(`signer.${role}`, { account: { address: keypair.publicKey.toBase58() }, keypair }) as RoleSigner);
    }
  }

  get commitment() { return this.cfg.solana.commitment; }
  get usdcMint() { return new PublicKey(this.cfg.chain.usdc); }

  address(name: ContractName): string | undefined {
    const a = (this.cfg.chain as Record<string, unknown>)[name];
    return typeof a === "string" && a ? a : undefined;
  }

  require(name: ContractName): string {
    const a = this.address(name);
    if (!a) fail(503, `The ${name} program is not configured on this router.`, "chain_unconfigured");
    return a;
  }

  programId(name: ContractName): PublicKey { return new PublicKey(this.require(name)); }

  wallet(role: Role): RoleSigner {
    const w = this.signers.get(role);
    if (!w) fail(503, `No ${role} signing key is configured.`, "chain_unconfigured");
    return w;
  }

  /** The Keypair of a role, or null. Never logged. */
  signer(role: Role): Keypair | null { return this.signers.get(role)?.keypair ?? null; }

  roleAddress(role: Role): string | undefined {
    return this.signers.get(role)?.account.address;
  }

  configured() {
    return CONTRACT_NAMES.some((n) => this.address(n));
  }

  status() {
    const contracts = Object.fromEntries(CONTRACT_NAMES.map((n) => [n, this.address(n) ?? null]));
    return {
      chain_id: this.cfg.chain.id,
      network: this.cfg.chain.network,
      commitment: this.cfg.solana.commitment,
      public_rpc: this.cfg.chain.publicRpcUrl,
      explorer: this.cfg.chain.explorerUrl,
      usdc: this.cfg.chain.usdc,
      contracts,
      programs: Object.fromEntries(Object.entries(this.cfg.solana.programs).map(([k, v]) => [k, v ?? null])),
      signers: Object.fromEntries([...this.signers.entries()].filter(([r]) => r !== "faucet").map(([r, w]) => [r, w.account.address])),
    };
  }

  /** Sign `ixs` with `role` as fee payer and send; returns the signature. */
  async send(role: Role, ixs: TransactionInstruction[], extraSigners: Keypair[] = []): Promise<{ hash: string; slot: number | null }> {
    const kp = this.wallet(role).keypair;
    const tx = new Transaction({ feePayer: kp.publicKey });
    tx.add(...ixs);
    const r = await sendAndConfirm(this.connection, tx, [kp, ...extraSigners], this.cfg.solana.commitment);
    return { hash: r.signature, slot: r.slot };
  }

  /**
   * Read a program account the router is going to believe: owned by the expected program and at the PDA its own fields
   * derive (src/solana/verified-account.ts, security review TR-02). Null when it does not exist; throws
   * VerifiedAccountError when something else sits at the address.
   */
  private verified<T>(pubkey: PublicKey, spec: AccountSpec<T>) {
    return readVerifiedAccount(this.connection, pubkey, spec, this.cfg.solana.commitment);
  }

  // ---- Reads -----------------------------------------------------------------------------------------------------------

  async blockNumber(): Promise<bigint> { return BigInt(await withRetry(() => this.connection.getSlot(this.cfg.solana.commitment))); }
  decode(_contract: ContractName, _logEntry: unknown): DecodedLog | null { return null; }
  async logs(_from: bigint, _to: bigint): Promise<DecodedLog[]> { return []; }
  async escrowTransfers(_tokens: string[], _escrow: string, _from: bigint, _to: bigint): Promise<EscrowTransfer[]> { return []; }
  async usdcTransfers(_from: bigint, _to: bigint): Promise<UsdcTransfer[]> { return []; }

  async escrowFinality(_tag: "finalized" | "confirmed"): Promise<EscrowFinality> {
    const [head, final] = await Promise.all([slotAndTime(this.connection, "confirmed"), slotAndTime(this.connection, "finalized")]);
    const finalHash = (await this.blockHashAt(BigInt(final.slot))) ?? "";
    return { head: BigInt(head.slot), headTime: head.time, final: BigInt(final.slot), finalHash, finalTime: final.time };
  }

  /** The blockhash of a slot, or null when the slot was skipped. */
  async blockHashAt(n: bigint): Promise<string | null> {
    try {
      const block = await withRetry(() => this.connection.getBlock(Number(n), { maxSupportedTransactionVersion: 0, transactionDetails: "none", rewards: false }));
      return block?.blockhash ?? null;
    } catch (e) {
      if (/skipped|not available|Slot .* was skipped|missing/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  /**
   * The decimals of an SPL mint (Token or Token-2022): USDC answers 6 without a read; any other mint is read from its
   * account (the byte after the 36-byte mint authority option and the 8-byte supply). Throws for an address that is
   * not a mint.
   */
  async tokenDecimals(token: string): Promise<number> {
    if (token === this.cfg.chain.usdc) return 6;
    const info = await withRetry(() => this.connection.getAccountInfo(new PublicKey(token), this.cfg.solana.commitment));
    if (!info) throw new Error("token mint not found");
    if (!(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) || info.data.length < MINT_SIZE) throw new Error("not an SPL token mint");
    return info.data[44];
  }
  async readFeed(_feed: string): Promise<FeedReading> { throw notPorted("readFeed"); }
  async blockTimestamp(): Promise<number> { return (await slotAndTime(this.connection, this.cfg.solana.commitment)).time; }
  async latestBlockTime(): Promise<number> { return this.blockTimestamp(); }

  /** The ReceiptRoot posted for `hour` (unix seconds on an hour boundary; `receiptRootHour(toTs)` for a batch), or null. */
  async anchorOnChain(hour: number): Promise<OnchainReceiptRoot | null> {
    if (!this.address("receiptAnchor")) return null;
    const programId = this.programId("receiptAnchor");
    const r = await this.verified(receiptRootPda(programId, hour), receiptRootSpec(programId));
    return r ? { hour: Number(r.hour), root: toHex0x(r.root), count: Number(r.count), signer: r.signer.toBase58(), postedAt: Number(r.postedAt) } : null;
  }

  /** The HostRoot trellis_anchor holds for one host (sha256 of its provider id, 0x-hex) and hour, or null. */
  async hostRootOnChain(providerIdHash: string, hour: number | bigint): Promise<OnchainHostRoot | null> {
    if (!this.address("receiptAnchor")) return null;
    const programId = this.programId("receiptAnchor");
    const r = await this.verified(hostRootPda(programId, hex32(providerIdHash), hour), hostRootSpec(programId));
    return r ? { providerIdHash: toHex0x(r.providerIdHash), hour: Number(r.hour), root: toHex0x(r.root), count: Number(r.count), signer: r.signer.toBase58(), postedAt: Number(r.postedAt) } : null;
  }

  /** The current and previous receipt signing keys (raw 32-byte hex) trellis_anchor's SignerSet names, or null. */
  async signerSetOnChain(): Promise<OnchainSignerSet | null> {
    if (!this.address("receiptAnchor")) return null;
    const programId = this.programId("receiptAnchor");
    const s = await this.verified(anchorPdas(programId).signerSet, signerSetSpec(programId));
    return s ? { authority: s.authority.toBase58(), currentSigner: toHex0x(s.currentSigner.toBytes()), previousSigner: toHex0x(s.previousSigner.toBytes()), rotatedAt: s.rotatedAt, rotationCount: s.rotationCount } : null;
  }

  /** Whether a receipt signing key (raw hex) is the SignerSet's current or previous signer. */
  async signingKeyOnChain(publicKeyHex: string): Promise<{ publicKey: string; current: boolean } | null> {
    const set = await this.signerSetOnChain();
    if (!set) return null;
    const want = toHex0x(hex32(publicKeyHex));
    if (set.currentSigner === want) return { publicKey: want, current: true };
    if (set.previousSigner === want) return { publicKey: want, current: false };
    return null;
  }

  /** trellis_credits' CreditsConfig (spent_total, settled_total, latest_hour, ...), or null when not initialised. */
  async creditsConfigOnChain(): Promise<CreditsConfig | null> {
    if (!this.address("credits")) return null;
    const programId = this.programId("credits");
    return this.verified(creditsPdas(programId).config, creditsConfigSpec(programId));
  }

  /** config.{latest_hour, spent_total} plus that hour's SpentRoot; zeros before the first commit. */
  async latestSpentRoot(): Promise<LatestSpentRoot> {
    const programId = this.programId("credits");
    const c = await this.verified(creditsPdas(programId).config, creditsConfigSpec(programId));
    if (!c || c.latestHour <= 0n) return { hour: 0n, root: ZERO_ROOT, totalSpent: c?.spentTotal ?? 0n, committedAt: 0 };
    const s = await this.verified(spentRootPda(programId, c.latestHour), spentRootSpec(programId));
    return { hour: c.latestHour, root: s ? toHex0x(s.root) : ZERO_ROOT, totalSpent: c.spentTotal, committedAt: s ? Number(s.committedAt) : 0 };
  }

  /** The credits program is live, deposits are not paused, and it names this router's settlement authority. */
  async custodyControlsReady(): Promise<boolean> {
    if (!this.address("credits")) return false;
    const programId = this.programId("credits");
    const c = await this.verified(creditsPdas(programId).config, creditsConfigSpec(programId)).catch(() => null);
    const settlement = this.roleAddress("settlement");
    return !!c && !c.depositsPaused && (!settlement || c.settlementAuthority.toBase58() === settlement);
  }

  /** Spent roots are committed by the settlement authority itself (Squads governs the authority), so no separate approval. */
  async isSpentRootApproved(_root: string, _hour: number | bigint, _spentDelta: bigint): Promise<boolean> { return !!this.roleAddress("settlement"); }
  spentRootApproval(epoch: number, root: string, hour: number | bigint, spentDelta: bigint) {
    return { to: this.address("credits") ?? null, instruction: "commit_spent_root", args: { epoch, hour: BigInt(hour).toString(), root, spentDelta: spentDelta.toString() } };
  }

  /** The HostBond of a host wallet, or null when it has none. */
  async hostBond(host: string | PublicKey) {
    if (!this.address("providerBond")) return null;
    const programId = this.programId("providerBond");
    return this.verified(bondPdas(programId, new PublicKey(host)).bond!, hostBondSpec(programId));
  }

  /** The active bond of a host wallet (zero while unbonding, delisted or ejected), or null when it has none. */
  async bondOf(host: string | PublicKey): Promise<bigint | null> {
    const b = await this.hostBond(host);
    if (!b) return null;
    return b.unbondAt === 0n && !b.delisted && !b.ejected ? b.amount : 0n;
  }

  async bondConfig() {
    const programId = this.programId("providerBond");
    return this.verified(bondPdas(programId).config, bondConfigSpec(programId));
  }

  /**
   * A SlashProposal by its address (the id the router stores), or null. The address may come from a stored id or a
   * request, so it is a proposal only when trellis_bond owns it at the PDA of its own (bond, proposal_id).
   */
  async slashOnChain(proposal: string | PublicKey): Promise<SlashProposal | null> {
    return this.verified(new PublicKey(proposal), slashProposalSpec(this.programId("providerBond")));
  }

  get devFaucet() {
    return this.signers.has("faucet");
  }

  // ---- Writes ----------------------------------------------------------------------------------------------------------

  async postIpxFeed(_feed: string, _u: { answer: bigint; receiptRoot: string; volumeUsdc: bigint }): Promise<{ hash: string }> { throw notPorted("postIpxFeed"); }

  /**
   * trellis_anchor::post_root for the hour that closed the batch (`receiptRootHour(toTs)`), signed by the anchorer (the
   * SignerSet authority). The router's `index` is not on chain; it comes back unchanged beside the hour.
   */
  async anchor(root: string, _fromTs: number, toTs: number, count: number, index?: number): Promise<{ hash: string; index: bigint | null; hour: number }> {
    const programId = this.programId("receiptAnchor");
    const anchorer = this.wallet("anchorer").keypair;
    const hour = receiptRootHour(toTs);
    const ix = postRootIx(programId, { authority: anchorer.publicKey, hour, root: hex32(root), count });
    const r = await this.send("anchorer", [ix]);
    return { hash: r.hash, index: index === undefined ? null : BigInt(index), hour };
  }

  /**
   * trellis_anchor::post_host_root for one attested host: `providerIdHash` is sha256 of the provider id (0x-hex), `hour`
   * the on-chain hour of the root's window (`receiptRootHour(toTs)`). Signed by the anchorer (the SignerSet authority).
   * One HostRoot per (host, hour): a second post for the same pair is refused by the program.
   */
  async postHostRoot(providerIdHash: string, hour: number | bigint, root: string, count: number): Promise<{ hash: string; slot: number | null; hour: number }> {
    const programId = this.programId("receiptAnchor");
    const anchorer = this.wallet("anchorer").keypair;
    const ix = postHostRootIx(programId, { authority: anchorer.publicKey, providerIdHash: hex32(providerIdHash), hour, root: hex32(root), count });
    const r = await this.send("anchorer", [ix]);
    return { hash: r.hash, slot: r.slot, hour: Number(hour) };
  }

  /** The receipt signer proposed to trellis_anchor and not installed yet (raw 32-byte hex), or null. */
  async pendingSignerOnChain(): Promise<OnchainPendingSigner | null> {
    if (!this.address("receiptAnchor")) return null;
    const programId = this.programId("receiptAnchor");
    const p = await this.verified(anchorPdas(programId).pendingSigner, pendingSignerSpec(programId));
    return p ? { newSigner: toHex0x(p.newSigner.toBytes()), proposedAt: p.proposedAt, effectiveAt: p.effectiveAt } : null;
  }

  /**
   * Publish a receipt signing key as trellis_anchor's current signer. Returns `hash: null` when the key already is.
   *
   * The program installs a new signer no sooner than 24 h after it was proposed (security review round 3), so this takes
   * two calls a day apart: the first sends propose_signer, one made after the timelock sends resolve_signer(true) and
   * returns its signature. In between (and right after proposing) it throws `SignerProposalPending`: a caller that
   * records "published" when this returns records it only once the key IS the current signer. A proposal that expired
   * (7 days after it became applicable) is cleared and made again; while another key's proposal is pending this one
   * waits its turn (one proposal at a time).
   */
  async registerSigningKey(publicKeyHex: string): Promise<{ hash: string | null }> {
    const programId = this.programId("receiptAnchor");
    const anchorer = this.wallet("anchorer").keypair;
    const newSigner = new PublicKey(hex32(publicKeyHex));
    const wanted = toHex0x(newSigner.toBytes());
    const set = await this.signerSetOnChain();
    if (set && set.currentSigner === wanted) return { hash: null };
    const pending = await this.pendingSignerOnChain();
    if (pending) {
      const now = BigInt(await this.blockTimestamp());
      // How long a proposal stays applicable is compiled into the program (7 days; minutes on a devnet build).
      const ttl = await buildFloor(this.connection, anchorIdl.at(programId), anchorer.publicKey, "proposalTtl", PROPOSAL_TTL_SECONDS, this.cfg.solana.commitment);
      const expired = now > pending.effectiveAt + BigInt(ttl);
      if (!expired) {
        if (pending.newSigner !== wanted) throw new Error(`another receipt signer (${pending.newSigner}) is proposed to trellis_anchor until ${new Date(Number(pending.effectiveAt) * 1000).toISOString()}; one proposal at a time`);
        if (now < pending.effectiveAt) throw new SignerProposalPending(wanted, Number(pending.effectiveAt), false);
        return this.send("anchorer", [resolveSignerIx(programId, { signer: anchorer.publicKey, authority: anchorer.publicKey, apply: true })]);
      }
      await this.send("anchorer", [resolveSignerIx(programId, { signer: anchorer.publicKey, authority: anchorer.publicKey, apply: false })]);
    }
    const proposed = await this.send("anchorer", [proposeSignerIx(programId, { authority: anchorer.publicKey, newSigner })]);
    const posted = await this.pendingSignerOnChain().catch(() => null);
    throw new SignerProposalPending(wanted, Number(posted?.effectiveAt ?? BigInt(await this.blockTimestamp()) + 86_400n), true, proposed.hash);
  }

  /**
   * trellis_anchor::revoke_signer: removes a receipt signing key (the SignerSet's current or previous signer) at once,
   * for a key that leaked. Returns `hash: null` when the set does not name the key. A revoked current signer leaves the
   * set with no current signer until its replacement, proposed with `registerSigningKey`, is installed a day later; roots
   * keep being posted meanwhile (they are signed by the anchorer, not by the receipt key).
   */
  async revokeSigningKey(publicKeyHex: string): Promise<{ hash: string | null }> {
    const programId = this.programId("receiptAnchor");
    const anchorer = this.wallet("anchorer").keypair;
    const signer = new PublicKey(hex32(publicKeyHex));
    if (!(await this.signingKeyOnChain(publicKeyHex))) return { hash: null };
    return this.send("anchorer", [revokeSignerIx(programId, { authority: anchorer.publicKey, signer })]);
  }

  /** trellis_credits::commit_spent_root(hour, root, spent_delta) by the settlement authority. */
  async postSpentRoot(root: string, hour: number | bigint, spentDelta: bigint): Promise<{ hash: string }> {
    const settlement = this.wallet("settlement").keypair;
    const h = BigInt(hour);
    if (h % CREDITS_HOUR !== 0n) throw new Error("spent root hour must be on an hour boundary");
    const ix = commitSpentRootIx(this.programId("credits"), { settlement: settlement.publicKey, hour: h, root: hex32(root), spentDelta });
    return this.send("settlement", [ix]);
  }

  /**
   * The instructions of trellis_credits::settle_to_host(amount, hour_root_ref) paying `tokenAccount` (a USDC token
   * account) from the credits vault; `hourRef` must be a committed SpentRoot hour. The program refuses the transfer when
   * settled_total + amount would exceed spent_total, so host payouts can never outrun committed spend (§5.1).
   */
  settleToHostInstructions(tokenAccount: PublicKey, amount: bigint, hourRef: bigint | number, createAtaFor?: PublicKey): TransactionInstruction[] {
    if (amount <= 0n) throw new Error("settlement amount must be above 0");
    const settlement = this.wallet("settlement").keypair.publicKey;
    const ix = settleToHostIx(this.programId("credits"), { settlement, hour: BigInt(hourRef), amount, hostToken: tokenAccount, mint: this.usdcMint });
    return createAtaFor ? [createAssociatedTokenAccountIdempotentInstruction(settlement, tokenAccount, createAtaFor, this.usdcMint), ix] : [ix];
  }

  /** settle_to_host to a host wallet's USDC associated token account (created if missing), signed by the settlement authority. */
  async settleToHost(host: string, amount: bigint, hourRef: bigint | number): Promise<{ hash: string }> {
    const owner = new PublicKey(host);
    const ata = getAssociatedTokenAddressSync(this.usdcMint, owner, true);
    return this.send("settlement", this.settleToHostInstructions(ata, amount, hourRef, owner));
  }

  /** settle_to_host straight to an existing USDC token account (the fee router's vault, for the network fee share). */
  async settleToTokenAccount(tokenAccount: string | PublicKey, amount: bigint, hourRef: bigint | number): Promise<{ hash: string }> {
    return this.send("settlement", this.settleToHostInstructions(new PublicKey(tokenAccount), amount, hourRef));
  }

  /** The instructions of a USDC transfer from `role`'s associated token account to `to`'s (created if missing). */
  usdcTransferInstructions(role: Role, to: string, amount: bigint): TransactionInstruction[] {
    const from = this.wallet(role).keypair.publicKey;
    const mint = this.usdcMint;
    const dest = new PublicKey(to);
    const destAta = getAssociatedTokenAddressSync(mint, dest, true);
    return [
      createAssociatedTokenAccountIdempotentInstruction(from, destAta, dest, mint),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, from, true), mint, destAta, from, amount, 6),
    ];
  }

  async transferUsdc(role: Role, to: string, amount: bigint): Promise<{ hash: string }> {
    if (amount <= 0n) throw new Error("transfer amount must be above 0");
    return this.send(role, this.usdcTransferInstructions(role, to, amount));
  }

  async streamRoyalty(_modelIdHash: string, _usdc: bigint): Promise<{ hash: string }> { throw notPorted("streamRoyalty"); }
  async registerRoyalty(_modelIdHash: string, _creator: string, _bps: number): Promise<{ hash: string }> { throw notPorted("registerRoyalty"); }

  /**
   * trellis_bond::propose_slash by the slasher role against a host wallet's bond: `reasonCode` and `bps` must follow the
   * program's schedule (SLASH_SCHEDULE); `refundAmount` (<= the slash) goes to the refund pool first. The proposal id is
   * the bond's next id; the returned `slashId` is the proposal's address, which identifies it from then on.
   */
  async proposeSlash(host: string | PublicKey, reasonCode: number, bps: number, evidenceRoot: string, refundAmount: bigint): Promise<{ hash: string; slashId: string; proposalId: bigint; submitted: boolean; windowEnd: bigint | null }> {
    const programId = this.programId("providerBond");
    const slasher = this.wallet("slasher").keypair;
    const hostKey = new PublicKey(host);
    const bond = await this.hostBond(hostKey);
    if (!bond) throw new Error("the host has no bond on chain");
    const reason = SLASH_REASONS[reasonCode];
    if (!reason || !SLASH_SCHEDULE[reason]) throw new Error("unknown or fixed-amount slash reason");
    const proposalId = bond.nextProposalId;
    // One proposal carries at most 50% of a bond on chain (MAX_SLASH_BPS_PER_PROPOSAL): a per-day or per-incident count
    // that would go past it is proposed at the largest multiple the program accepts.
    const unit = SLASH_SCHEDULE[reason]!.unitBps;
    if (bps > MAX_SLASH_BPS_PER_PROPOSAL) bps = Math.floor(MAX_SLASH_BPS_PER_PROPOSAL / unit) * unit;
    const ix = proposeSlashIx(programId, { slasher: slasher.publicKey, host: hostKey, proposalId, evidenceHash: hex32(evidenceRoot), bps, reasonCode, refundAmount });
    const r = await this.send("slasher", [ix]);
    const slashId = proposalPda(programId, bondPdas(programId, hostKey).bond!, proposalId).toBase58();
    // The program sets window_end = now + config.dispute_window; the router's executable_at follows the chain's clock.
    const posted = await this.slashOnChain(slashId).catch(() => null);
    return { hash: r.hash, slashId, proposalId, submitted: true, windowEnd: posted?.windowEnd ?? null };
  }

  /**
   * When a proposal may be executed, by the chain's rules: its window end, pushed to the proposal's unblock_at (fixed at
   * dispute time) while a dispute is open; null when the proposal is gone or already executed; "rejected" when the authority threw it out.
   */
  async slashExecutableAt(proposal: string | PublicKey): Promise<bigint | null | "rejected"> {
    const s = await this.slashOnChain(proposal);
    if (!s || s.executed) return null;
    if (s.disputeStatus === "Rejected") return "rejected";
    if (s.disputeStatus !== "Open") return s.windowEnd;
    // The end of the block was fixed when the host disputed (security re-review RR-10): a later change of the config's
    // dispute block does not move it. Only a proposal from before that field existed falls back to the config.
    const blockedUntil = s.unblockAt > 0n ? s.unblockAt : s.disputedAt + ((await this.bondConfig())?.disputeBlock ?? 0n);
    return blockedUntil > s.windowEnd ? blockedUntil : s.windowEnd;
  }

  /**
   * The period trellis_bond states its cumulative slash cap over (SLASH_WINDOW), as the deployed binary reports it through
   * build_profile: 30 days on the mainnet build, shorter on a `devnet` build; 30 days when the program does not answer.
   */
  async bondSlashWindow(): Promise<number> {
    return buildFloor(this.connection, bondIdl.at(this.programId("providerBond")), this.roleAddress("slasher"), "slashWindow", 30 * 86_400, this.cfg.solana.commitment);
  }

  /**
   * trellis_bond::execute_slash: after the window and any dispute block (the program enforces both); cranked by the
   * slasher, which is the only key the program lets execute a slash the cumulative cap would cut (R3-26).
   *
   * A rate-based slash that the cap would cut to ZERO today is not sent (`submitted: false, heldForCap: true`): executed
   * now it would take nothing, be forgone and leave the host listed. It is held until the earlier slashes have aged out
   * of the cap (60 days at most), when it executes in full; the authority can void it sooner. A slash the cap only
   * reduces is executed for what the cap leaves.
   */
  async executeSlash(proposal: string | PublicKey): Promise<{ hash: string; submitted: boolean; heldForCap?: boolean }> {
    const programId = this.programId("providerBond");
    const cranker = this.wallet("slasher").keypair;
    const s = await this.slashOnChain(proposal);
    if (!s) throw new Error("slash proposal not found on chain");
    const bond = await this.verified(s.bond, hostBondSpec(programId));
    if (!bond) throw new Error("the proposal's bond is missing on chain");
    const cfg = await this.bondConfig();
    if (!cfg) throw new Error("trellis_bond is not initialised");
    if (s.reason !== "CapacityShortfall" && s.bps > 0 && bond.amount > 0n) {
      const ledger = await this.verified(slashLedgerPda(programId, s.bond), slashLedgerSpec(programId));
      const cut = slashWouldBeCut(bond.amount, s.bps, ledger, await this.blockTimestamp(), await this.bondSlashWindow());
      if (cut.cut && cut.amount === 0n) return { hash: "", submitted: false, heldForCap: true };
    }
    const ix = executeSlashIx(programId, { cranker: cranker.publicKey, host: bond.host, proposalId: s.proposalId, mint: cfg.usdcMint, refundPool: cfg.refundPool, treasury: cfg.treasury, capacityRefund: cfg.capacityRefund });
    const r = await this.send("slasher", [ix]);
    return { hash: r.hash, submitted: true };
  }
}
