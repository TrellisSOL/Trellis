import { and, eq } from "drizzle-orm";
import { PublicKey, Transaction } from "@solana/web3.js";
import { idHash, type Hex } from "../lib/hash.ts";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import { canonicalJson, decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import type { HostPolicyBindings } from "./policy.ts";
import type { QueuedLeaf, HostBinding } from "../services/host-anchor.ts";
import { guardHostSlasher } from "./bond-config.ts";
import { base58Encode } from "../solana/constants.ts";
import { bondConfigSpec, hostBondSpec, slashProposalSpec } from "../solana/account-specs.ts";
import { bondPdas, executeSlashIx, proposeSlashIx, SLASH_REASONS, SLASH_SCHEDULE, slashAmount } from "../solana/programs/bond.ts";
import { isVerifiedAccountError, readVerifiedAccount } from "../solana/verified-account.ts";
import { hex32, toHex0x } from "../solana/programs/encoding.ts";
import { signatureOutcome, slotAndTime, withRetry } from "../solana/rpc.ts";
import { hostSlashEvidence } from "./bond-schema.ts";
import { bondFresh } from "./bonds.ts";
import { loadBondState, lockBondCursor } from "./bond-indexer.ts";
import { bondHostId, bondHostWallet, bondScope, type BondHost, type BondSlash } from "./bond-state.ts";

export type SlashBundle = {
  format: "trellis.host-slash/1"; provider_id: string; host_id: Hex;
  kind: "policy_rejection" | "invalid_receipt" | "makegood_refund"; reason: 0 | null;
  policy_version?: number; policy_sha256?: string; observed_sha256: string;
  attestation_ref: string; receipt_key?: string; rejection_sha256: string;
};
/**
 * The host id evidence about a network provider is filed under: the projection id of its host wallet (the bond on chain is
 * per wallet). A network host without a registered wallet keeps evidence for review under sha256(provider id); nothing
 * can be proposed against it until a wallet (and a bond) exists. Null for a provider that is not a network host.
 */
export async function hostIdOfProvider(ctx: Ctx, providerId: string): Promise<Hex | null> {
  const [p] = await ctx.db.select({ operator: providers.operator, network: providers.networkHost }).from(providers).where(eq(providers.id, providerId));
  if (!p?.network) return null;
  if (p.operator) { try { return bondHostId(p.operator) as Hex; } catch { /* not a wallet: fall through */ } }
  return idHash(providerId);
}
/** Single canonical leaf commitment, SHA-256 over a fixed structured bundle; no prompt, answer or raw quote is stored. */
export async function storeSlashEvidence(ctx: Ctx, bundle: SlashBundle) {
  if (!ctx.cfg.hostBonds.enabled) return;
  if (!/^[a-f0-9]{64}$/i.test(bundle.observed_sha256) || !/^[a-f0-9]{64}$/i.test(bundle.rejection_sha256) || !/^(0x)?[a-f0-9]{64}$/i.test(bundle.attestation_ref)) return;
  const hostId = await hostIdOfProvider(ctx, bundle.provider_id);
  if (!hostId || bundle.host_id !== hostId) return;
  const scope = bondScope(ctx.cfg);
  const canonical = canonicalJson(bundle);
  const root = `0x${sha256(canonical)}`;
  await ctx.db.insert(hostSlashEvidence).values({ scope, root, providerId: bundle.provider_id, hostId: bundle.host_id, canonical, reason: bundle.reason ?? -1, amount: "0", status: bundle.reason === null ? "review" : "ready" }).onConflictDoNothing();
  return root;
}
/** Only a verified quote that fails a verified published policy is evidence; outages and missing policy are not faults. */
export async function recordPolicyRejection(ctx: Ctx, providerId: string, evidence: HostPolicyBindings, checked: { policy: { version: number } | null; reasons: string[] }) {
  if (!ctx.cfg.hostBonds.enabled || !checked.policy || !checked.reasons.length || !evidence.hardware_verified || !evidence.bindings_committed || evidence.dev || evidence.simulated) return;
  const { hostPolicies } = await import("./schema.ts");
  const [policy] = await ctx.db.select().from(hostPolicies).where(eq(hostPolicies.version, checked.policy.version));
  const [p] = await ctx.db.select({ hash: providers.attestationHash }).from(providers).where(eq(providers.id, providerId));
  const hostId = await hostIdOfProvider(ctx, providerId);
  if (!policy || !p?.hash || !hostId) return;
  await storeSlashEvidence(ctx, { format: "trellis.host-slash/1", provider_id: providerId, host_id: hostId as Hex, kind: "policy_rejection", reason: 0,
    policy_version: policy.version, policy_sha256: policy.sha256, observed_sha256: sha256(canonicalJson(evidence)), attestation_ref: p.hash, rejection_sha256: sha256(canonicalJson(checked.reasons)) });
}
/** Called only on the pinned, attestation-bound host receipt feed. A caller's arbitrary receipt cannot trigger slashing. */
export async function recordInvalidHostReceipt(ctx: Ctx, providerId: string, item: QueuedLeaf, binding: HostBinding, failure: string) {
  if (!ctx.cfg.hostBonds.enabled || !["bad_signature", "unbound_key", "other_attestation", "leaf_mismatch"].includes(failure)) return;
  const hostId = await hostIdOfProvider(ctx, providerId);
  if (!hostId) return;
  await storeSlashEvidence(ctx, { format: "trellis.host-slash/1", provider_id: providerId, host_id: hostId as Hex, kind: "invalid_receipt", reason: null,
    observed_sha256: sha256(canonicalJson(item.receipt)), attestation_ref: binding.attestationRef, receipt_key: binding.receiptPublicKey, rejection_sha256: sha256(failure) });
}
/** A live proposal as the slasher reads it: 1 pending (executable once `executableAt` has passed), 2 executed, 3 rejected or missing. */
export type LiveSlash = { status: 1 | 2 | 3; disputed: boolean; executableAt: bigint; root: Hex; hostId: Hex };
export type SlashTransport = {
  guard(): Promise<void>;
  host(id: Hex): Promise<{ operator: string; bond: bigint }>;
  slash(id: string): Promise<LiveSlash>;
  /** Sign the intent; `raw` is the serialized transaction (base64), `hash` its signature. Nothing is broadcast here. */
  prepare(fn: "proposeSlash" | "executeSlash", args: readonly unknown[]): Promise<{ hash: Hex; raw: Hex }>;
  broadcast(raw: Hex, hash: Hex): Promise<void>;
  time(): Promise<bigint>;
};
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
/** trellis_bond through the slasher key: reads of HostBond / SlashProposal / BondConfig, signed propose/execute intents, plain sends. */
export function hostSlashTransport(ctx: Ctx): SlashTransport {
  const programId = () => new PublicKey(ctx.cfg.hostBonds.address!);
  const rpc = ctx.chain.connection;
  // Every account is read through the owner- and PDA-checked reader (TR-02): a proposal id comes from stored state or
  // a request, and a look-alike account must never decide what the slasher signs.
  const config = async () => { const c = await readVerifiedAccount(rpc, bondPdas(programId()).config, bondConfigSpec(programId()), "confirmed"); if (!c) throw new Error("trellis_bond is not initialised."); return c; };
  const hostBond = async (host: PublicKey) => readVerifiedAccount(rpc, bondPdas(programId(), host).bond!, hostBondSpec(programId()), "confirmed");
  const bondAt = async (bond: PublicKey) => readVerifiedAccount(rpc, bond, hostBondSpec(programId()), "confirmed");
  // An address that holds something other than one of this program's proposals is no proposal: treated as missing.
  const proposalAt = async (id: string) => readVerifiedAccount(rpc, new PublicKey(id), slashProposalSpec(programId()), "confirmed").catch((e) => { if (isVerifiedAccountError(e)) return null; throw e; });
  return {
    guard: () => guardHostSlasher(ctx.cfg, async () => (await config()).slasher.toBase58()),
    host: async id => {
      const b = await hostBond(bondHostWallet(id));
      return b ? { operator: b.host.toBase58(), bond: b.unbondAt === 0n && !b.delisted && !b.ejected ? b.amount : 0n } : { operator: "", bond: 0n };
    },
    slash: async id => {
      const [s, c] = await Promise.all([proposalAt(id), config()]);
      if (!s || s.disputeStatus === "Rejected") return { status: 3, disputed: false, executableAt: 0n, root: ZERO32, hostId: ZERO32 };
      const b = await bondAt(s.bond);
      // An open dispute blocks execution until it is resolved or dispute_block passes.
      const executableAt = s.disputeStatus === "Open" && s.disputedAt + c.disputeBlock > s.windowEnd ? s.disputedAt + c.disputeBlock : s.windowEnd;
      return { status: s.executed ? 2 : 1, disputed: s.disputeStatus === "Open", executableAt, root: toHex0x(s.evidenceHash) as Hex, hostId: (b ? bondHostId(b.host.toBase58()) : ZERO32) as Hex };
    },
    prepare: async (fn, args) => {
      const slasher = ctx.chain.wallet("slasher").keypair;
      const c = await config();
      let ix;
      if (fn === "proposeSlash") {
        const [hostId, reasonCode, bps, root, refund] = args as [string, number, number, string, bigint];
        const host = bondHostWallet(hostId);
        const b = await hostBond(host);
        if (!b) throw new Error("Host has no bond on chain.");
        ix = proposeSlashIx(programId(), { slasher: slasher.publicKey, host, proposalId: b.nextProposalId, evidenceHash: hex32(root), bps: Number(bps), reasonCode: Number(reasonCode), refundAmount: BigInt(refund) });
      } else {
        const [id] = args as [string];
        const s = await proposalAt(id);
        if (!s) throw new Error("Slash proposal not found on chain.");
        const b = await bondAt(s.bond);
        if (!b) throw new Error("Slash proposal names a missing bond.");
        ix = executeSlashIx(programId(), { cranker: slasher.publicKey, host: b.host, proposalId: s.proposalId, mint: c.usdcMint, refundPool: c.refundPool, treasury: c.treasury, capacityRefund: c.capacityRefund });
      }
      const { blockhash, lastValidBlockHeight } = await withRetry(() => rpc.getLatestBlockhash("confirmed"));
      const tx = new Transaction({ feePayer: slasher.publicKey, blockhash, lastValidBlockHeight });
      tx.add(ix);
      // Preflight before signing; signing and persistence happen before any broadcast.
      const sim = await withRetry(() => rpc.simulateTransaction(tx));
      if (sim.value.err) throw new Error("Host slash intent fails simulation.");
      tx.sign(slasher);
      return { raw: Buffer.from(tx.serialize()).toString("base64") as Hex, hash: base58Encode(new Uint8Array(tx.signature!)) as Hex };
    },
    broadcast: async (raw, hash) => {
      // A landed intent needs no rebroadcast. Missing intents reuse the exact signed bytes.
      let known: "success" | "failed" | null;
      try { known = await signatureOutcome(rpc, hash); } catch { throw new Error("Host slash receipt lookup failed."); }
      if (known) return;
      try { await withRetry(() => rpc.sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: false, maxRetries: 3 })); }
      catch { throw new Error("Host slash broadcast unresolved; signed intent retained for retry."); }
    },
    time: async () => BigInt((await slotAndTime(rpc, "confirmed")).time),
  };
}
/** The schedule bps of an evidence reason code (fixed-rate reasons only; per-unit reasons use one unit). */
export const reasonBps = (reasonCode: number) => SLASH_SCHEDULE[SLASH_REASONS[reasonCode]]?.unitBps ?? 0;
/** One durable intent at a time. Never signs a replacement on timeout/reorg; owner approval is never supplied here. */
export async function runHostSlasher(ctx: Ctx, transport = hostSlashTransport(ctx)) {
  if (!ctx.cfg.hostBonds.enabled) return { skipped: "disabled" };
  const scope = bondScope(ctx.cfg);
  if (ctx.cfg.hostBonds.slashing) await transport.guard();
  const intent = await ctx.db.transaction(async tx => {
    const cursor = await lockBondCursor(tx, scope, ctx.cfg.hostBonds.startBlock);
    if (!bondFresh(cursor.checkedAt)) return { skipped: "index stale" };
    const state = await loadBondState(tx, scope);
    const rows = await tx.select().from(hostSlashEvidence).where(eq(hostSlashEvidence.scope, scope)).orderBy(hostSlashEvidence.createdAt, hostSlashEvidence.root);
    for (const row of rows) {
      if (row.reason < 0) continue;
      const slashEntry = [...state.entries()].find(([key, s]) => key.startsWith("slash:") && (s as BondSlash).evidenceRoot === row.root);
      const indexed = slashEntry?.[1] as BondSlash | undefined;
      let fn: "proposeSlash" | "executeSlash", args: readonly unknown[], field: "proposal" | "execution";
      if (indexed) {
        if (indexed.hostId !== row.hostId) throw new Error("Host slash evidence root belongs to another host.");
        if (indexed.status !== "pending") {
          await tx.update(hostSlashEvidence).set({ status: indexed.status }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root))); continue;
        }
        if (indexed.disputeStatus === "open" || BigInt(indexed.executableAt) > await transport.time()) continue;
        if (!ctx.cfg.hostBonds.slashing) continue;
        const id = slashEntry![0].slice(6);
        const live = await transport.slash(id);
        if (live.status !== 1 || live.disputed || live.executableAt > await transport.time() || live.root.toLowerCase() !== row.root || live.hostId.toLowerCase() !== row.hostId) continue;
        fn = "executeSlash"; args = [id]; field = "execution";
      } else {
        const h = state.get(`host:${row.hostId}`) as BondHost | undefined;
        const [provider] = await tx.select({ operator: providers.operator, network: providers.networkHost }).from(providers).where(eq(providers.id, row.providerId));
        if (!h || !provider?.network || !provider.operator || h.operator !== provider.operator || BigInt(h.bond) <= 0n) continue;
        if (row.proposalRaw) return { hash: row.proposalTx as Hex, raw: decrypt(ctx.cfg.appSecret, row.proposalRaw) as Hex };
        const bps = reasonBps(row.reason);
        if (!bps) continue;
        const amount = slashAmount(BigInt(h.bond), bps);
        if (!ctx.cfg.hostBonds.slashing) {
          if (row.status !== "dry_run") {
            log.info("host slash dry run", { provider: row.providerId, evidence_root: row.root, function_name: "proposeSlash", amount_usdc: amount.toString(), bps, reason: row.reason, program: ctx.cfg.hostBonds.address, chain_id: ctx.cfg.chain.id, host_id: row.hostId });
            await tx.update(hostSlashEvidence).set({ status: "dry_run", amount: amount.toString() }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root)));
          }
          continue;
        }
        const live = await transport.host(row.hostId as Hex);
        if (live.operator !== h.operator || live.bond <= 0n) continue;
        // The program computes the slash from the bond at execution; the schedule rate is what is proposed here.
        fn = "proposeSlash"; args = [row.hostId, row.reason, bps, row.root, 0n]; field = "proposal";
      }
      const saved = field === "proposal" ? row.proposalRaw : row.executionRaw;
      if (saved) return { hash: (field === "proposal" ? row.proposalTx : row.executionTx) as Hex, raw: decrypt(ctx.cfg.appSecret, saved) as Hex };
      const prepared = await transport.prepare(fn, args);
      await tx.update(hostSlashEvidence).set(field === "proposal" ? { proposalTx: prepared.hash, proposalRaw: encrypt(ctx.cfg.appSecret, prepared.raw), status: "submitted", amount: slashAmount(BigInt((state.get(`host:${row.hostId}`) as BondHost).bond), Number(args[2])).toString() } : { executionTx: prepared.hash, executionRaw: encrypt(ctx.cfg.appSecret, prepared.raw), status: "executing" }).where(and(eq(hostSlashEvidence.scope, scope), eq(hostSlashEvidence.root, row.root)));
      return prepared;
    }
    return { skipped: ctx.cfg.hostBonds.slashing ? "nothing ready" : "dry run" };
  });
  if ("raw" in intent && ctx.cfg.hostBonds.slashing) { await transport.broadcast(intent.raw, intent.hash); return { transaction: intent.hash }; }
  return intent;
}
