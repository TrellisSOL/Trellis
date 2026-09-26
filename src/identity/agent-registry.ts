import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { canonicalJson } from "../lib/util.ts";
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from "../solana/constants.ts";
import { BorshReader, BorshWriter, decodeEvents, encodeInstruction, eventDiscriminator, eventPayloads, openAccount } from "../solana/programs/encoding.ts";

// The Solana Agent Registry: QuantuLabs' port of ERC-8004 to Solana (github.com/QuantuLabs/8004-solana, Anchor program
// `agent_registry_8004`; its IDL is idl/agent_registry_8004.json in that repository). An agent identity is a Metaplex
// Core asset in the registry's base collection; the agent id is the asset's public key and its registry record is the
// AgentAccount PDA ["agent", asset]. Reputation lives in the same program: give_feedback(value, decimals, score, ...)
// appends to the agent's SEAL hash chain. The program's validation module is archived upstream, so a track record's
// validation entry stays a signed document here (src/identity/track-record.ts).
//
// Encodings below are IDL-free (src/solana/programs/encoding.ts): Anchor derives every discriminator from the instruction,
// account or event name, and the argument and field order is the program's (programs/agent-registry-8004/src). The router
// only ever prepares transactions for the owner's or reviewer's wallet, except the opt-in registrar job.

/** Deployed program ids per cluster (declare_id! of the program; the README lists both). */
export const AGENT_REGISTRY_PROGRAM_IDS: Record<"mainnet" | "devnet", string> = {
  mainnet: "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ",
  devnet: "8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C",
};
/** Which cluster a program id is the published registry of, or null for another deployment (localnet, a fork). */
export const knownRegistryCluster = (programId: string | undefined): "mainnet" | "devnet" | null =>
  programId === AGENT_REGISTRY_PROGRAM_IDS.mainnet ? "mainnet" : programId === AGENT_REGISTRY_PROGRAM_IDS.devnet ? "devnet" : null;
/** The CAIP-2 network a known registry deployment lives on. */
export const registryNetworkOf = (programId: string | undefined): string | null => {
  const c = knownRegistryCluster(programId);
  return c === "mainnet" ? SOLANA_MAINNET_CAIP2 : c === "devnet" ? SOLANA_DEVNET_CAIP2 : null;
};

/** Metaplex Core, which mints the identity asset (register CPIs CreateV2 into the collection). */
export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/** What a registration costs its owner (AgentAccount + Core asset + metadata entry + fees), in SOL: the backend design's
 * quote, an upper bound (the registry README lists about 0.006 SOL of rent for register alone). */
export const REGISTRATION_RENT_SOL = "0.009";

export const SEEDS = {
  rootConfig: [Buffer.from("root_config")],
  registryConfig: (collection: PublicKey) => [Buffer.from("registry_config"), collection.toBuffer()],
  agent: (asset: PublicKey) => [Buffer.from("agent"), asset.toBuffer()],
  metadata: (asset: PublicKey, keyHash: Uint8Array) => [Buffer.from("agent_meta"), asset.toBuffer(), Buffer.from(keyHash)],
};
/** Program limits (programs/agent-registry-8004/src: MAX_URI_LENGTH, MAX_TAG_LENGTH, MAX_KEY_LENGTH, MAX_VALUE_LENGTH). */
export const LIMITS = { uri: 250, tag: 32, endpoint: 250, metadataKey: 32, metadataValue: 250, valueDecimals: 18 } as const;

export const rootConfigPda = (programId: PublicKey) => PublicKey.findProgramAddressSync(SEEDS.rootConfig, programId)[0];
export const registryConfigPda = (programId: PublicKey, collection: PublicKey) => PublicKey.findProgramAddressSync(SEEDS.registryConfig(collection), programId)[0];
export const agentPda = (programId: PublicKey, asset: PublicKey) => PublicKey.findProgramAddressSync(SEEDS.agent(asset), programId)[0];
export const metadataPda = (programId: PublicKey, asset: PublicKey, key: string) => PublicKey.findProgramAddressSync(SEEDS.metadata(asset, metadataKeyHash(key)), programId)[0];

/** set_metadata_pda's key_hash: the first 16 bytes of sha256(key) (the program recomputes and compares it). */
export const metadataKeyHash = (key: string): Uint8Array => new Uint8Array(createHash("sha256").update(key, "utf8").digest().subarray(0, 16));

// ---- Registry ids and documents --------------------------------------------------------------------------------------

/** ERC-8004 registration file type; the Solana registry keeps the same document format. */
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const TRACK_RECORD_TAG = "trellis-track-record";
/** On-chain metadata key carrying the URL of the router's receipt key set. */
export const RECEIPT_KEYS_METADATA = "trellis.receiptKeys";

/** The CAIP-style registry id a registration file names: `<CAIP-2 network>:<program id>`. */
export const agentRegistryId = (network: string, programId: string) => `${network}:${programId}`;
/** sha256 of the canonical JSON of a document, 0x-prefixed: what a feedback entry's feedback_file_hash commits to. */
export const documentHash = (doc: unknown): `0x${string}` => `0x${createHash("sha256").update(canonicalJson(doc)).digest("hex")}`;
export const documentHashBytes = (doc: unknown): Uint8Array => new Uint8Array(createHash("sha256").update(canonicalJson(doc)).digest());

const meta = (pubkey: PublicKey, o: { signer?: boolean; writable?: boolean } = {}): AccountMeta => ({ pubkey, isSigner: !!o.signer, isWritable: !!o.writable });
const utf8Length = (s: string) => Buffer.byteLength(s, "utf8");
const I128_MIN = -(1n << 127n), I128_MAX = (1n << 127n) - 1n;
/** Borsh i128: 16 bytes little-endian, two's complement. */
export function i128le(v: bigint): Uint8Array {
  if (v < I128_MIN || v > I128_MAX) throw new RangeError("i128 out of range");
  let n = BigInt.asUintN(128, v);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
export function readI128le(r: BorshReader): bigint {
  const b = r.fixed(16);
  let n = 0n;
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return BigInt.asIntN(128, n);
}

// ---- Instructions ----------------------------------------------------------------------------------------------------

/**
 * register(agent_uri): mints the identity asset (a fresh keypair that signs once) into the registry's base collection for
 * `owner`, who pays the rent. Accounts in the program's order: root_config, registry_config, agent_account, asset,
 * collection, owner, system_program, mpl_core_program.
 */
export function registerIx(programId: PublicKey, a: { owner: PublicKey; asset: PublicKey; collection: PublicKey; agentURI: string }): TransactionInstruction {
  if (utf8Length(a.agentURI) > LIMITS.uri) throw new RangeError(`agent URI longer than ${LIMITS.uri} bytes`);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(rootConfigPda(programId)),
      meta(registryConfigPda(programId, a.collection)),
      meta(agentPda(programId, a.asset), { writable: true }),
      meta(a.asset, { signer: true, writable: true }),
      meta(a.collection, { writable: true }),
      meta(a.owner, { signer: true, writable: true }),
      meta(SystemProgram.programId),
      meta(MPL_CORE_PROGRAM_ID),
    ],
    data: encodeInstruction("register", (w) => w.string(a.agentURI)),
  });
}

/** set_metadata_pda(key_hash, key, value, immutable): one MetadataEntryPda ["agent_meta", asset, key_hash] per key, by the owner. */
export function setMetadataIx(programId: PublicKey, a: { owner: PublicKey; asset: PublicKey; key: string; value: Uint8Array | string; immutable?: boolean }): TransactionInstruction {
  const value = typeof a.value === "string" ? new TextEncoder().encode(a.value) : a.value;
  if (utf8Length(a.key) > LIMITS.metadataKey) throw new RangeError(`metadata key longer than ${LIMITS.metadataKey} bytes`);
  if (value.length > LIMITS.metadataValue) throw new RangeError(`metadata value longer than ${LIMITS.metadataValue} bytes`);
  const keyHash = metadataKeyHash(a.key);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(metadataPda(programId, a.asset, a.key), { writable: true }),
      meta(agentPda(programId, a.asset)),
      meta(a.asset),
      meta(a.owner, { signer: true, writable: true }),
      meta(SystemProgram.programId),
    ],
    data: encodeInstruction("set_metadata_pda", (w) => w.fixed(keyHash, 16).string(a.key).bytes(value).bool(a.immutable ?? false)),
  });
}

export type FeedbackArgs = {
  /** The reviewer's wallet: the signer and fee payer; the program refuses the asset owner's own wallet. */
  client: PublicKey;
  asset: PublicKey;
  collection: PublicKey;
  /** What the reviewer paid on the receipt, in USDC base units (value_decimals 6): the paid evidence the entry is weighted by. */
  paidUsdcUnits: bigint;
  /** 0..100. */
  score: number;
  tag1: string;
  tag2: string;
  /** The public URL of the entry and sha256 of its canonical JSON (feedback_file_hash). */
  feedbackURI: string;
  feedbackHash: Uint8Array;
};
export const FEEDBACK_VALUE_DECIMALS = 6;

/**
 * give_feedback(value, value_decimals, score, feedback_file_hash, tag1, tag2, endpoint, feedback_uri) from the reviewer's
 * wallet. Accounts: client, agent_account, asset, collection, system_program; the optional ATOM engine accounts are left
 * out (Anchor `None`), so the entry is recorded without the external reputation engine.
 */
export function giveFeedbackIx(programId: PublicKey, a: FeedbackArgs): TransactionInstruction {
  if (!Number.isInteger(a.score) || a.score < 0 || a.score > 100) throw new RangeError("score must be 0..100");
  if (a.paidUsdcUnits < 0n) throw new RangeError("paid amount must not be negative");
  if (utf8Length(a.tag1) > LIMITS.tag || utf8Length(a.tag2) > LIMITS.tag) throw new RangeError(`tags longer than ${LIMITS.tag} bytes`);
  if (utf8Length(a.feedbackURI) > LIMITS.uri) throw new RangeError(`feedback URI longer than ${LIMITS.uri} bytes`);
  if (a.feedbackHash.length !== 32) throw new RangeError("feedback hash must be 32 bytes");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(a.client, { signer: true, writable: true }),
      meta(agentPda(programId, a.asset), { writable: true }),
      meta(a.asset),
      meta(a.collection),
      meta(SystemProgram.programId),
      // atom_config, atom_stats, atom_engine_program, registry_authority: trailing optional accounts, left out (None).
    ],
    data: encodeInstruction("give_feedback", (w) =>
      w.raw(i128le(a.paidUsdcUnits)).u8(FEEDBACK_VALUE_DECIMALS)
        .option(a.score, (ww, s) => ww.u8(s))
        .option(a.feedbackHash, (ww, h) => ww.fixed(h, 32))
        .string(a.tag1).string(a.tag2).string("").string(a.feedbackURI)),
  });
}

/** revoke_feedback(feedback_index, seal_hash) by the reviewer who gave it. */
export function revokeFeedbackIx(programId: PublicKey, a: { client: PublicKey; asset: PublicKey; feedbackIndex: bigint | number; sealHash: Uint8Array }): TransactionInstruction {
  if (a.sealHash.length !== 32) throw new RangeError("seal hash must be 32 bytes");
  return new TransactionInstruction({
    programId,
    keys: [meta(a.client, { signer: true, writable: true }), meta(agentPda(programId, a.asset), { writable: true }), meta(a.asset), meta(SystemProgram.programId)],
    data: encodeInstruction("revoke_feedback", (w) => w.u64(a.feedbackIndex).fixed(a.sealHash, 32)),
  });
}

/** A wallet-agnostic description of an instruction (program, accounts, base64 data) for callers that build their own transaction. */
export function describeInstruction(ix: TransactionInstruction) {
  return { program_id: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") };
}

// ---- Accounts --------------------------------------------------------------------------------------------------------

export type RootConfig = { baseCollection: PublicKey; authority: PublicKey; bump: number };
export function decodeRootConfig(data: Uint8Array): RootConfig | null {
  const r = openAccount("RootConfig", data);
  if (!r) return null;
  try { return { baseCollection: r.pubkey(), authority: r.pubkey(), bump: r.u8() }; } catch { return null; }
}

export type AgentAccount = {
  collection: PublicKey; creator: PublicKey; owner: PublicKey; asset: PublicKey; bump: number; atomEnabled: boolean; agentWallet: PublicKey | null;
  feedbackDigest: Uint8Array; feedbackCount: bigint; responseDigest: Uint8Array; responseCount: bigint; revokeDigest: Uint8Array; revokeCount: bigint;
  parentAsset: PublicKey | null; parentLocked: boolean; colLocked: boolean; agentURI: string; nftName: string; col: string;
};
export function decodeAgentAccount(data: Uint8Array): AgentAccount | null {
  const r = openAccount("AgentAccount", data);
  if (!r) return null;
  try {
    return {
      collection: r.pubkey(), creator: r.pubkey(), owner: r.pubkey(), asset: r.pubkey(), bump: r.u8(), atomEnabled: r.bool(), agentWallet: r.option((x) => x.pubkey()),
      feedbackDigest: r.fixed(32), feedbackCount: r.u64(), responseDigest: r.fixed(32), responseCount: r.u64(), revokeDigest: r.fixed(32), revokeCount: r.u64(),
      parentAsset: r.option((x) => x.pubkey()), parentLocked: r.bool(), colLocked: r.bool(), agentURI: r.string(), nftName: r.string(), col: r.string(),
    };
  } catch { return null; }
}

// ---- Events ----------------------------------------------------------------------------------------------------------
// Only lines the registry program at `programId` itself logged are decoded (src/solana/programs/encoding.ts,
// parseProgramLogs): another program can log the same bytes in a transaction that merely names the registry.

export type AgentRegisteredEvent = { asset: PublicKey; collection: PublicKey; owner: PublicKey; atomEnabled: boolean; agentURI: string };
export const agentRegisteredEvents = (programId: PublicKey | string, logs: readonly string[]): AgentRegisteredEvent[] =>
  decodeEvents("AgentRegistered", eventPayloads(logs, programId), (r) => ({ asset: r.pubkey(), collection: r.pubkey(), owner: r.pubkey(), atomEnabled: r.bool(), agentURI: r.string() }));

export type NewFeedbackEvent = { asset: PublicKey; client: PublicKey; feedbackIndex: bigint; slot: bigint; value: bigint; valueDecimals: number; score: number | null; feedbackFileHash: Uint8Array | null; sealHash: Uint8Array; tag1: string; tag2: string; endpoint: string; feedbackURI: string };
export const newFeedbackEvents = (programId: PublicKey | string, logs: readonly string[]): NewFeedbackEvent[] =>
  decodeEvents("NewFeedback", eventPayloads(logs, programId), (r) => {
    const asset = r.pubkey(), client = r.pubkey(), feedbackIndex = r.u64(), slot = r.u64(), value = readI128le(r), valueDecimals = r.u8();
    const score = r.option((x) => x.u8()), feedbackFileHash = r.option((x) => x.fixed(32)), sealHash = r.fixed(32);
    r.bool(); r.u8(); r.u16(); r.u16(); r.u8(); r.u8(); r.bool(); r.fixed(32); r.u64(); // atom_enabled .. new_feedback_count
    return { asset, client, feedbackIndex, slot, value, valueDecimals, score, feedbackFileHash, sealHash, tag1: r.string(), tag2: r.string(), endpoint: r.string(), feedbackURI: r.string() };
  });

/** Encode an AgentRegistered event payload the way the program logs it (`Program data: <base64>`); used by offline tests. */
export function encodeAgentRegisteredLog(e: AgentRegisteredEvent): string {
  const w = new BorshWriter().raw(eventDiscriminator("AgentRegistered")).pubkey(e.asset).pubkey(e.collection).pubkey(e.owner).bool(e.atomEnabled).string(e.agentURI);
  return `Program data: ${Buffer.from(w.bytesOut()).toString("base64")}`;
}
