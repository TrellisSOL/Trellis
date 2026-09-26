import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { loadSigner } from "../solana/keys.ts";
import { sendAndConfirm, withRetry, type RpcLike } from "../solana/rpc.ts";
import { readVerifiedAccount } from "../solana/verified-account.ts";
import { agentRegisteredEvents, decodeRootConfig, describeInstruction, giveFeedbackIx, RECEIPT_KEYS_METADATA, registerIx, rootConfigPda, setMetadataIx, type FeedbackArgs } from "./agent-registry.ts";

// The chain access identity needs, over the router's RPC connection (a fake in tests): the registry's base collection,
// a registration transaction prepared for the owner's wallet (owner mode), registrations sent by the registrar key
// (registrar mode), reading a registration back from its signature, and feedback transactions for a reviewer's wallet.

export type Registration =
  | { status: "pending" }
  | { status: "failed"; reason: "reverted" | "no_registration" }
  | { status: "ok"; agentId: string; owner: string; agentURI: string; slot: number };

export type PreparedRegistration = {
  /** Unsigned by the owner, already signed by the asset keypair; base64. The owner's wallet signs and sends it. */
  transaction: string;
  /** The identity asset = the agent id the transaction registers. */
  asset: string;
  feePayer: string;
  expiresAtBlockHeight: number;
  instructions: ReturnType<typeof describeInstruction>[];
};

export type IdentityChain = {
  /** The collection identities are minted into: AGENT_REGISTRY_COLLECTION, else the program's RootConfig.base_collection. */
  collection(): Promise<PublicKey>;
  /** Owner mode: register(agentURI) + set_metadata_pda(trellis.receiptKeys) for `owner` to sign; the asset keypair signs here and is forgotten. */
  prepareRegistration(owner: string, agentURI: string, receiptKeysUrl: string): Promise<PreparedRegistration>;
  /** Registrar mode: the registrar key registers (and pays for) the identity; resolves with the signature and the asset. */
  register(agentURI: string, receiptKeysUrl: string): Promise<{ signature: string; asset: string }>;
  /** What a registration transaction did, once the cluster has it at the configured commitment. */
  registration(signature: string): Promise<Registration>;
  /** give_feedback for the reviewer's wallet: an unsigned base64 transaction (null when the chain is unreachable) and the instruction. */
  feedbackTransaction(a: FeedbackArgs): Promise<{ transaction: string | null; expiresAtBlockHeight: number | null; instruction: ReturnType<typeof describeInstruction> }>;
};

const injected = new WeakMap<Ctx, IdentityChain>();
export const setIdentityChain = (ctx: Ctx, chain: IdentityChain) => void injected.set(ctx, chain);

/** Program id from configuration, as a PublicKey; throws when identity registration is not configured. */
export function registryProgramId(ctx: Ctx): PublicKey {
  const id = ctx.cfg.identity.registry.programId;
  if (!id) throw new Error("AGENT_REGISTRY_PROGRAM_ID is not configured");
  return new PublicKey(id);
}

const collections = new WeakMap<Ctx, { programId: string; collection: PublicKey }>();

/** Account keys of a fetched transaction (legacy or v0 message), base58. */
function accountKeysOf(tx: { transaction: { message: unknown }; meta?: { loadedAddresses?: unknown } | null }): string[] {
  const m = tx.transaction.message as { getAccountKeys?: (o: { accountKeysFromLookups?: unknown }) => { staticAccountKeys: PublicKey[] }; staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] };
  if (typeof m.getAccountKeys === "function") {
    try { return m.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined }).staticAccountKeys.map((k) => k.toBase58()); } catch { /* fall through */ }
  }
  return (m.staticAccountKeys ?? m.accountKeys ?? []).map((k) => (k instanceof PublicKey ? k.toBase58() : String(k)));
}

export function identityChain(ctx: Ctx): IdentityChain {
  const found = injected.get(ctx);
  if (found) return found;
  const rpc = (): RpcLike => ctx.chain.connection;
  const commitment = () => ctx.cfg.solana.commitment;
  const unsigned = async (feePayer: PublicKey, ixs: TransactionInstruction[], partialSigners: Keypair[] = []) => {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => rpc().getLatestBlockhash(commitment()));
    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
    tx.add(...ixs);
    if (partialSigners.length) tx.partialSign(...partialSigners);
    return { transaction: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), expiresAtBlockHeight: lastValidBlockHeight };
  };
  const chain: IdentityChain = {
    async collection() {
      const programId = registryProgramId(ctx);
      const pinned = ctx.cfg.identity.registry.collection;
      if (pinned) return new PublicKey(pinned);
      const cached = collections.get(ctx);
      if (cached && cached.programId === programId.toBase58()) return cached.collection;
      // The registry's own RootConfig: owned by the registry program, at its ["root_config"] PDA (TR-02).
      const root = await readVerifiedAccount(rpc(), rootConfigPda(programId), { name: "RootConfig", owner: programId, decode: decodeRootConfig, derive: rootConfigPda(programId) }, commitment());
      if (!root) throw new Error("the agent registry's RootConfig account was not found; set AGENT_REGISTRY_COLLECTION or check AGENT_REGISTRY_PROGRAM_ID");
      collections.set(ctx, { programId: programId.toBase58(), collection: root.baseCollection });
      return root.baseCollection;
    },
    async prepareRegistration(owner, agentURI, receiptKeysUrl) {
      const programId = registryProgramId(ctx);
      const ownerKey = new PublicKey(owner), collection = await chain.collection(), asset = Keypair.generate();
      const ixs = [registerIx(programId, { owner: ownerKey, asset: asset.publicKey, collection, agentURI }), setMetadataIx(programId, { owner: ownerKey, asset: asset.publicKey, key: RECEIPT_KEYS_METADATA, value: receiptKeysUrl })];
      const u = await unsigned(ownerKey, ixs, [asset]);
      return { ...u, asset: asset.publicKey.toBase58(), feePayer: owner, instructions: ixs.map(describeInstruction) };
    },
    async register(agentURI, receiptKeysUrl) {
      const key = ctx.cfg.identity.registrarKey;
      if (!key) throw new Error("registrar key not configured");
      const programId = registryProgramId(ctx);
      const registrar = loadSigner(key), collection = await chain.collection(), asset = Keypair.generate();
      const tx = new Transaction({ feePayer: registrar.publicKey });
      tx.add(registerIx(programId, { owner: registrar.publicKey, asset: asset.publicKey, collection, agentURI }), setMetadataIx(programId, { owner: registrar.publicKey, asset: asset.publicKey, key: RECEIPT_KEYS_METADATA, value: receiptKeysUrl }));
      const r = await sendAndConfirm(rpc(), tx, [registrar, asset], commitment());
      return { signature: r.signature, asset: asset.publicKey.toBase58() };
    },
    async registration(signature) {
      const programId = registryProgramId(ctx).toBase58();
      const { value } = await withRetry(() => rpc().getSignatureStatuses([signature], { searchTransactionHistory: true }));
      const status = value[0];
      if (!status) return { status: "pending" };
      if (status.err) return { status: "failed", reason: "reverted" };
      if (commitment() === "finalized" && status.confirmationStatus !== "finalized") return { status: "pending" };
      const tx = await withRetry(() => rpc().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
      if (!tx) return { status: "pending" };
      if (tx.meta?.err) return { status: "failed", reason: "reverted" };
      if (!accountKeysOf(tx).includes(programId)) return { status: "failed", reason: "no_registration" };
      const [event] = agentRegisteredEvents(programId, tx.meta?.logMessages ?? []);
      if (!event) return { status: "failed", reason: "no_registration" };
      return { status: "ok", agentId: event.asset.toBase58(), owner: event.owner.toBase58(), agentURI: event.agentURI, slot: tx.slot };
    },
    async feedbackTransaction(a) {
      const ix = giveFeedbackIx(registryProgramId(ctx), a);
      try {
        const u = await unsigned(a.client, [ix]);
        return { ...u, instruction: describeInstruction(ix) };
      } catch {
        return { transaction: null, expiresAtBlockHeight: null, instruction: describeInstruction(ix) };
      }
    },
  };
  return chain;
}
