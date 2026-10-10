import { createPublicKey, verify as edVerify } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { RpcLike } from "./rpc.ts";

// Receipt roots as memo transactions (ANCHOR_MODE=memo).
//
// Instead of one rent-paying account per hour in trellis_anchor, the anchorer key signs one transaction per hour whose
// only content is an SPL Memo v2 instruction carrying a short ASCII line. No program of ours is involved and nothing is
// stored in an account, so the cost is the 5,000-lamport signature fee and nothing else.
//
//   trellis:root:v2:<network>:<hour>:<count>:<root>:<previous>             the router's receipt root of one hour, linked to the one before
//   trellis:root:v1:<network>:<hour>:<count>:<root>                        the same without the link: hours before the switch to v2
//   trellis:hostroot:v1:<network>:<provider id hash>:<hour>:<count>:<root> one attested host's receipt root of one hour
//   trellis:anchorer:v1:<network>:<from hour>:<new anchorer>               the anchorer key hands over to a new key
//   trellis:signer:v1:<network>:<valid from>:<receipt public key>          no longer written (nobody verified it); still parsed
//
// <network> is the CAIP-2 reference of the cluster (the first 32 characters of its genesis hash), so a line posted on
// devnet says nothing about mainnet: a verifier compares it with the genesis hash of the RPC it is talking to. <hour> is
// unix seconds on an hour boundary: the hour containing the last second of the batch, the same hour trellis_anchor keys
// a ReceiptRoot by. An hour without receipts gets a line with count 0 and a root of 64 zeros, so that no past hour is
// left open. Hashes are 64 lowercase hex characters, keys base58. <previous> is the transaction signature of the
// router's previous root line (or 0 for the first): the lines form a chain that anyone can walk backwards by signature,
// without listing the anchorer's history, and a fork (two lines for one hour) leaves one of them off the chain that later
// lines extend. The Memo program checks that every account passed to it signed the transaction, so a memo that names the
// anchorer as its account was signed by the anchorer.
//
// What a verifier checks (`verifyMemoLine` here; scripts/verify-proof-pack.mjs and packages/client carry their own copies
// on purpose). Everything it trusts comes from ITS OWN configuration, never from the proof:
//   - the RPC serves the cluster the line names (getGenesisHash);
//   - the transaction named in the proof is FINALIZED, succeeded, and was read; its first signature is the one asked for;
//   - the anchorer's Ed25519 signature over the message bytes verifies; a Memo v2 instruction with the anchorer among its
//     accounts carries exactly the expected line. Memo text in a signature list is never believed: a transaction that
//     merely names the anchorer, with any text, is not the anchorer's line;
//   - the anchorer was the published key for that hour (each rotation signed by the key before it and by the new key),
//     and the line landed before that key was retired (a retired key signs nothing afterwards);
//   - a key's EARLIEST finalized hand-over line is its only one (security review round 5, R5-19): the rotation a key
//     list names must be the first hand-over the key before it ever signed on this cluster. When that key signed
//     another hand-over earlier (to another key, or to the same key from another hour), or the rotation transaction
//     itself carries a second, different one, the rotation FAILS; when the previous key's history cannot be read to
//     its beginning the answer is UNKNOWN. A hand-over signed later changes nothing. This needs the previous key's
//     whole history, so a node that does not keep its ledger back to the beginning gives UNKNOWN for every hour after
//     a rotation;
//   - the line landed no earlier than its hour and no later than the lateness bound after the hour closed (a later line
//     is "late": not an anchor unless the caller explicitly allows it);
//   - a v2 line names the ACTUAL previous root (security review round 4, R4-28): the transaction it names is read, is
//     a root line of the anchorer for an earlier hour that landed before this one, and the anchorer signed no root that
//     counts for an hour between the two; `0` (no previous root) passes only when the anchorer's history shows none.
//     A link that cannot be followed is UNKNOWN;
//   - no earlier finalized line of that anchorer names another root for the same hour, and the transaction itself
//     carries no second, different line for it (R4-10: two roots for one hour in one transaction are a conflict). This
//     needs the anchorer's history from the line back to before the hour began. There is no default limit on that
//     walk (R4-09); when it errors, is cut short by a limit the caller set, meets a transaction the node lists and does
//     not serve (R4-28), or ends at a node that does not keep the ledger that far back, the answer is UNKNOWN
//     (`ok: false`, `earliest: null`), never a pass.
//
// What this does NOT give, compared with the program (state it wherever memo mode is described):
//   - no on-chain uniqueness: nothing on chain stops the anchorer key from signing a second, different line for an
//     hour. The rule is "the earliest finalized line for an hour is the root"; a verifier has to look for an earlier
//     one, and a second one is evidence against the router rather than something the chain prevents;
//   - no account to read: a verifier needs an RPC that still serves the transaction and the anchorer's signature list.
//     Old history is pruned by many RPC providers, so a proof may need an archival endpoint;
//   - anyone can write a line that looks the same. Only the anchorer's signature makes it a root, so the anchorer key
//     the verifier pins carries all the weight;
//   - a verifier whose key list is out of date (it misses a rotation) accepts the retired key for hours the new key owns.

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_PREFIX = "trellis";
export const MEMO_VERSION = "v1";
export const ROOT_MEMO_VERSION_2 = "v2";
/**
 * How long after its hour closed a root may still land and count: six hours. The chain monitor alarms when the last root
 * is three hours old (MONITOR_ANCHOR_MAX_LAG_HOURS), so an operator has as long again to bring the anchor worker back
 * before a root is refused; and a stolen or retired key can fill in a missing hour only inside that window.
 */
export const DEFAULT_MAX_LATE_SECONDS = 6 * 3600;
/** The root of an hour without receipts. */
export const EMPTY_ROOT = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const B58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const NETWORK_REF = /^[A-Za-z0-9-]{1,44}$/;
const HOUR = 3600;

/** The cluster name inside a memo line: the reference of a CAIP-2 id ("solana:<ref>"), or the whole name when it has no namespace. */
export function networkRef(network: string): string {
  const ref = network.includes(":") ? network.slice(network.indexOf(":") + 1) : network;
  if (!NETWORK_REF.test(ref)) throw new RangeError("the network name cannot be written into a memo line (expected a CAIP-2 id such as solana:<32 characters of the genesis hash>)");
  return ref;
}

/** Genesis hashes of the public clusters, for network names that are not a CAIP-2 reference. */
export const KNOWN_GENESIS: Readonly<Record<string, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
/**
 * Whether the network name inside a line (`ref`) names the cluster whose genesis hash is `genesis`: a CAIP-2 reference is
 * the first 32 characters of the genesis hash; mainnet-beta, devnet and testnet are known; any other name (a local or
 * rehearsal cluster) only when the caller configured its genesis hash.
 */
export function networkNamesGenesis(ref: string, genesis: string, configured?: { network: string; genesisHash: string } | null): boolean {
  if (!genesis) return false;
  if (configured && networkRefOrNull(configured.network) === ref) return configured.genesisHash === genesis;
  if (KNOWN_GENESIS[ref]) return KNOWN_GENESIS[ref] === genesis;
  return /^[1-9A-HJ-NP-Za-km-z]{32}$/.test(ref) && genesis.startsWith(ref);
}
const networkRefOrNull = (network: string) => { try { return networkRef(network); } catch { return null; } };

const hex64 = (v: string, what: string) => {
  const h = v.replace(/^0x/, "").toLowerCase();
  if (!HEX64.test(h)) throw new RangeError(`${what} must be 32 bytes of hex`);
  return h;
};
const hourOf = (v: number | bigint, what = "hour") => {
  const h = Number(v);
  if (!Number.isSafeInteger(h) || h < 0 || h % HOUR !== 0) throw new RangeError(`${what} must be unix seconds on an hour boundary`);
  return h;
};
const countOf = (v: number | bigint) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("count must be a non-negative integer");
  return n;
};

export const rootMemo = (a: { network: string; hour: number | bigint; count: number | bigint; root: string }) =>
  `${MEMO_PREFIX}:root:${MEMO_VERSION}:${networkRef(a.network)}:${hourOf(a.hour)}:${countOf(a.count)}:${hex64(a.root, "root")}`;
/** The v2 root line: the v1 fields and the transaction signature of the previous root line (`null`: there is none). */
export const rootMemoV2 = (a: { network: string; hour: number | bigint; count: number | bigint; root: string; prev: string | null }) => {
  if (a.prev !== null && !B58_SIGNATURE.test(a.prev)) throw new RangeError("the previous root must be a base58 transaction signature, or null");
  return `${MEMO_PREFIX}:root:${ROOT_MEMO_VERSION_2}:${networkRef(a.network)}:${hourOf(a.hour)}:${countOf(a.count)}:${hex64(a.root, "root")}:${a.prev ?? "0"}`;
};
export const hostRootMemo = (a: { network: string; providerIdHash: string; hour: number | bigint; count: number | bigint; root: string }) =>
  `${MEMO_PREFIX}:hostroot:${MEMO_VERSION}:${networkRef(a.network)}:${hex64(a.providerIdHash, "provider id hash")}:${hourOf(a.hour)}:${countOf(a.count)}:${hex64(a.root, "root")}`;
/** Parsed for old lines only: the router no longer writes signer lines (nothing verified them; receipt keys are in the key document). */
export const signerMemo = (a: { network: string; validFrom: number; publicKeyHex: string }) =>
  `${MEMO_PREFIX}:signer:${MEMO_VERSION}:${networkRef(a.network)}:${countOf(a.validFrom)}:${hex64(a.publicKeyHex, "receipt public key")}`;
export const anchorerMemo = (a: { network: string; fromHour: number | bigint; newAnchorer: string }) => {
  if (!B58_KEY.test(a.newAnchorer)) throw new RangeError("the new anchorer must be a base58 public key");
  return `${MEMO_PREFIX}:anchorer:${MEMO_VERSION}:${networkRef(a.network)}:${hourOf(a.fromHour, "from hour")}:${a.newAnchorer}`;
};
/** Everything of a v1 root line up to and including the hour. */
export const rootMemoPrefix = (network: string, hour: number | bigint) => `${MEMO_PREFIX}:root:${MEMO_VERSION}:${networkRef(network)}:${hourOf(hour)}:`;
export const hostRootMemoPrefix = (network: string, providerIdHash: string, hour: number | bigint) => `${MEMO_PREFIX}:hostroot:${MEMO_VERSION}:${networkRef(network)}:${hex64(providerIdHash, "provider id hash")}:${hourOf(hour)}:`;

export type RootMemo = { kind: "root"; version: 1 | 2; network: string; hour: number; count: number; root: string; /** v2: the previous root line's transaction, or null for the first. */ prev?: string | null };
export type HostRootMemo = { kind: "hostroot"; version: 1; network: string; providerIdHash: string; hour: number; count: number; root: string };
export type ParsedMemo =
  | RootMemo
  | HostRootMemo
  | { kind: "signer"; network: string; validFrom: number; publicKeyHex: string }
  | { kind: "anchorer"; network: string; fromHour: number; newAnchorer: string };
/** A Trellis memo line, or null for anything else. Strict: a line that parses is exactly what the builders above write. */
export function parseMemo(text: string): ParsedMemo | null {
  const p = text.split(":");
  if (p[0] !== MEMO_PREFIX || !NETWORK_REF.test(p[3] ?? "")) return null;
  const int = (s: string | undefined) => (s !== undefined && /^(0|[1-9]\d{0,15})$/.test(s) ? Number(s) : null);
  if (p[2] === ROOT_MEMO_VERSION_2) {
    if (p[1] !== "root" || p.length !== 8) return null;
    const hour = int(p[4]), count = int(p[5]);
    if (hour === null || count === null || hour % HOUR !== 0 || !HEX64.test(p[6]!) || !(p[7] === "0" || B58_SIGNATURE.test(p[7]!))) return null;
    return { kind: "root", version: 2, network: p[3]!, hour, count, root: p[6]!, prev: p[7] === "0" ? null : p[7]! };
  }
  if (p[2] !== MEMO_VERSION) return null;
  if (p[1] === "root" && p.length === 7) {
    const hour = int(p[4]), count = int(p[5]);
    if (hour === null || count === null || hour % HOUR !== 0 || !HEX64.test(p[6]!)) return null;
    return { kind: "root", version: 1, network: p[3]!, hour, count, root: p[6]! };
  }
  if (p[1] === "hostroot" && p.length === 8) {
    const hour = int(p[5]), count = int(p[6]);
    if (hour === null || count === null || hour % HOUR !== 0 || !HEX64.test(p[4]!) || !HEX64.test(p[7]!)) return null;
    return { kind: "hostroot", version: 1, network: p[3]!, providerIdHash: p[4]!, hour, count, root: p[7]! };
  }
  if (p[1] === "signer" && p.length === 6) {
    const validFrom = int(p[4]);
    if (validFrom === null || !HEX64.test(p[5]!)) return null;
    return { kind: "signer", network: p[3]!, validFrom, publicKeyHex: p[5]! };
  }
  if (p[1] === "anchorer" && p.length === 6) {
    const fromHour = int(p[4]);
    if (fromHour === null || fromHour % HOUR !== 0 || !B58_KEY.test(p[5]!)) return null;
    return { kind: "anchorer", network: p[3]!, fromHour, newAnchorer: p[5]! };
  }
  return null;
}

/** What a root line is about: the router's hour, or one host's hour. Two lines about the same subject compete. */
export type MemoSubject = { kind: "root"; hour: number } | { kind: "hostroot"; providerIdHash: string; hour: number };
export const subjectOf = (m: RootMemo | HostRootMemo): MemoSubject => (m.kind === "root" ? { kind: "root", hour: m.hour } : { kind: "hostroot", providerIdHash: m.providerIdHash, hour: m.hour });
export const subjectKey = (s: MemoSubject) => (s.kind === "root" ? `root:${s.hour}` : `hostroot:${s.providerIdHash}:${s.hour}`);
const aboutSubject = (m: ParsedMemo | null, s: MemoSubject): m is RootMemo | HostRootMemo => !!m && (m.kind === "root" || m.kind === "hostroot") && subjectKey(subjectOf(m)) === subjectKey(s);
/** Two lines about one subject say the same thing when root and count agree (a v1 and a v2 copy of one root are not a conflict). */
export const sameClaim = (a: { root: string; count: number }, b: { root: string; count: number }) => a.root === b.root && a.count === b.count;

/** An SPL Memo v2 instruction carrying `text`; every key in `signers` must sign the transaction (the Memo program checks it). */
export function memoIx(text: string, signers: PublicKey[]): TransactionInstruction {
  if (!/^[\x20-\x7e]{1,500}$/.test(text)) throw new RangeError("a memo line is 1 to 500 printable ASCII characters");
  if (!signers.length) throw new RangeError("a memo line needs at least one signer");
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.from(text, "ascii") });
}

// ---- The anchorer key over time ------------------------------------------------------------------------------------------

/**
 * The anchorer keys, oldest first. The first entry is the key the deployment started with (`fromHour` 0, no rotation
 * transaction). Every later entry took over at `fromHour` and names the transaction in which the PREVIOUS key (and the
 * new one) signed `trellis:anchorer:v1:<network>:<from hour>:<new key>`. A root of hour H must be signed by the entry
 * with the largest `fromHour` <= H, so roots posted before a rotation stay valid under the key that was current then.
 */
export type AnchorerKey = { key: string; fromHour: number; rotationTx: string | null };

/** Why a list of anchorer keys is not usable, or null. */
export function anchorerKeysProblem(keys: readonly AnchorerKey[]): string | null {
  if (!keys.length) return "no anchorer key is published";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!B58_KEY.test(k.key)) return `anchorer key ${i} is not a base58 public key`;
    if (!Number.isSafeInteger(k.fromHour) || k.fromHour < 0 || k.fromHour % HOUR !== 0) return `anchorer key ${i} does not start on an hour boundary`;
    if (i === 0 && (k.fromHour !== 0 || k.rotationTx)) return "the first anchorer key starts at hour 0 and has no rotation transaction";
    if (i > 0 && (!k.rotationTx || k.fromHour <= keys[i - 1]!.fromHour)) return `anchorer key ${i} needs a rotation transaction and a later start than the key before it`;
    if (i > 0 && k.key === keys[i - 1]!.key) return `anchorer key ${i} repeats the key before it`;
  }
  return null;
}
/** The index of the anchorer key that was current for `hour`, or -1. */
export function anchorerIndexAt(keys: readonly AnchorerKey[], hour: number): number {
  let at = -1;
  for (let i = 0; i < keys.length; i++) if (keys[i]!.fromHour <= hour) at = i;
  return at;
}

// ---- Reading a transaction ---------------------------------------------------------------------------------------------

/**
 * What verification asks of an RPC. `getGenesisHash` binds a line's network to the cluster; `getFirstAvailableBlock` and
 * `getBlockTime` say how far back the node keeps its ledger. An RPC without them cannot give a pass where they are needed.
 */
export type MemoRpc = Pick<RpcLike, "getTransaction" | "getSignaturesForAddress"> & {
  getGenesisHash?: () => Promise<string>;
  getFirstAvailableBlock?: () => Promise<number>;
  getBlockTime?: (slot: number) => Promise<number | null>;
};
type Finality = "confirmed" | "finalized";
export type SignedInstruction = { programId: string; data: Uint8Array; accounts: string[] };
export type SignedTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Keys whose Ed25519 signature over the message this module verified itself. */
  signers: string[];
  instructions: SignedInstruction[];
  /** The text of every Memo v2 instruction, with the accounts (signers) it was given. */
  memos: { text: string; signers: string[] }[];
};

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
function ed25519Verifies(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return edVerify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKey)]), format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]!);
    if (carry < 0) throw new Error("not base58");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j]! * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/**
 * A transaction as the cluster holds it at `commitment`, with every required signature checked here against the message
 * bytes. `{ ok: false }` when the RPC does not serve it at that commitment, it failed, or a signature does not verify.
 */
export async function readSignedTransaction(rpc: Pick<MemoRpc, "getTransaction">, signature: string, commitment: Finality = "finalized"): Promise<{ ok: true; tx: SignedTransaction } | { ok: false; reason: string; /** The RPC could not be asked: nothing is known about the transaction. */ unavailable?: boolean; /** The RPC answered, and does not serve the transaction at this commitment. */ notServed?: boolean; /** The transaction landed and failed. */ failedOnChain?: boolean }> {
  let t: Awaited<ReturnType<RpcLike["getTransaction"]>>;
  try {
    t = await rpc.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
  } catch (e) {
    return { ok: false, unavailable: true, reason: `the RPC could not be asked for the transaction: ${(e as Error).message.slice(0, 120)}` };
  }
  if (!t) return { ok: false, notServed: true, reason: `the RPC does not serve this transaction at ${commitment} commitment: it is not ${commitment} yet, or the endpoint no longer keeps that part of the history` };
  if (t.meta?.err) return { ok: false, failedOnChain: true, reason: "the transaction failed on chain" };
  const message = t.transaction.message;
  const signatures = t.transaction.signatures;
  if (signatures[0] !== signature) return { ok: false, reason: "the RPC answered with a different transaction" };
  const keys = message.staticAccountKeys;
  const required = message.header.numRequiredSignatures;
  if (signatures.length !== required || keys.length < required) return { ok: false, reason: "the transaction's signature count does not match its message" };
  const bytes = message.serialize();
  const signers: string[] = [];
  for (let i = 0; i < required; i++) {
    let sig: Uint8Array;
    try { sig = b58decode(signatures[i]!); } catch { return { ok: false, reason: "a signature is not base58" }; }
    if (sig.length !== 64 || !ed25519Verifies(keys[i]!.toBytes(), bytes, sig)) return { ok: false, reason: `signature ${i} does not verify over the transaction message` };
    signers.push(keys[i]!.toBase58());
  }
  const instructions: SignedInstruction[] = [];
  for (const ix of message.compiledInstructions) {
    // An instruction that reaches for an account loaded from a lookup table is not one this module reasons about.
    if (ix.programIdIndex >= keys.length || ix.accountKeyIndexes.some((i) => i >= keys.length)) continue;
    instructions.push({ programId: keys[ix.programIdIndex]!.toBase58(), data: Uint8Array.from(ix.data), accounts: ix.accountKeyIndexes.map((i) => keys[i]!.toBase58()) });
  }
  const memo = MEMO_PROGRAM_ID.toBase58();
  const memos = instructions.filter((ix) => ix.programId === memo).map((ix) => ({ text: Buffer.from(ix.data).toString("utf8"), signers: ix.accounts.filter((a) => signers.includes(a)) }));
  return { ok: true, tx: { signature, slot: t.slot, blockTime: t.blockTime ?? null, signers, instructions, memos } };
}

// ---- Whether a line counts ---------------------------------------------------------------------------------------------

/**
 * What a root line is worth by when it landed and who signed it. The router applies exactly the rules a verifier
 * applies (security review round 4, R4-13): a line it would not accept as a verifier is neither the root of its hour
 * nor a conflict with one.
 *   counts     signed by the key published for the hour, landed no earlier than the hour and inside the lateness
 *              bound, before that key was retired
 *   early      landed before the hour it names began (nobody can know that hour's root yet)
 *   late       landed after the lateness bound
 *   retired    landed after the signing key's hand-over took effect
 *   wrong_key  not signed by the key published for the hour
 *   untimed    the RPC gave no block time
 */
export type LineStanding = "counts" | "early" | "late" | "retired" | "wrong_key" | "untimed";
export function lineStanding(a: { hour: number; landed: number | null; signer: string; anchorers: readonly AnchorerKey[]; maxLateSeconds?: number }): LineStanding {
  const at = anchorerIndexAt(a.anchorers, a.hour);
  if (at < 0 || a.anchorers[at]!.key !== a.signer) return "wrong_key";
  if (a.landed == null) return "untimed";
  if (a.landed < a.hour) return "early";
  const next = a.anchorers[at + 1];
  if (next && a.landed >= next.fromHour + HOUR) return "retired";
  if (a.landed > a.hour + HOUR + (a.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS)) return "late";
  return "counts";
}

// ---- Finding lines of one anchorer ------------------------------------------------------------------------------------

/** A line read from its own finalized transaction, in a memo instruction the anchorer signed. */
export type FoundMemo = { signature: string; slot: number; blockTime: number | null; text: string };
export const MEMO_LINE = /trellis:[a-z]+:v[12]:[A-Za-z0-9:-]+/g;
/** The Trellis lines a signature list's `memo` field shows. Only a hint for which transactions to read: never believed. */
export const memoHints = (memo: unknown): string[] => (typeof memo === "string" ? memo.match(MEMO_LINE) ?? [] : []);

/** Transactions a history walk reads at once: what bounds its memory and its load on the RPC, whatever the history holds. */
export const WALK_READ_BATCH = 16;
/** Lines one walk keeps (the earliest ones it saw). An anchorer that signed more for one range has `more` set. */
export const WALK_KEEP_LINES = 64;
/** The walk FORWARD from a line (later lines are only reported, never decide a verdict) keeps a budget of its own. */
const LATER_WALK = { maxPages: 20, maxReads: 2_000 };

type LineWalk<T> = {
  /** The lines the walk was asked for, in memo instructions the anchorer signed, oldest first. */
  found: (FoundMemo & { claim: T })[];
  /** True only when the walk covered the whole range it was asked for and read every candidate in it. */
  complete: boolean;
  /** Why not, when incomplete. */
  why: string | null;
  /** More lines than `WALK_KEEP_LINES` were found; the newest of them were dropped. */
  more: boolean;
};
export type SubjectWalk = LineWalk<RootMemo | HostRootMemo>;

/** Whether the node behind `rpc` keeps its ledger back to before `time` (or to the cluster's first block). */
async function ledgerReachesBefore(rpc: MemoRpc, time: number): Promise<boolean> {
  if (!rpc.getFirstAvailableBlock) return false;
  try {
    const slot = await rpc.getFirstAvailableBlock();
    if (slot === 0) return true;
    const t = rpc.getBlockTime ? await rpc.getBlockTime(slot) : null;
    return typeof t === "number" && t < time;
  } catch {
    return false;
  }
}

type WalkOptions = { genesis: string; configured?: { network: string; genesisHash: string } | null; before?: string; until?: string; floor: number; commitment?: Finality; maxPages?: number; maxReads?: number; indexed?: boolean; /** Lines kept instead of `WALK_KEEP_LINES`. */ keep?: number };

/**
 * The lines `anchorer` signed that `wanted` picks, each read from its own transaction at `commitment` and kept only
 * when the memo instruction carrying it was signed by `anchorer` and names the cluster with `genesis`.
 *
 * `until` walks from the newest signature back to that one and is complete when the list ends. Otherwise the walk goes
 * back (from `before`, or from the newest signature) to the first entry whose block time is before `floor`; it is
 * complete when it reaches one, or when the list ends at a node that keeps its ledger back that far.
 *
 * There is no default limit on pages or reads (R4-09): a limit turns an honest proof into "unknown" for the price of a
 * few thousand transactions that merely name the anchorer. The list is read a page at a time and the candidates of a
 * page `WALK_READ_BATCH` at a time, so memory does not grow with the history. `maxPages` and `maxReads` are the
 * caller's own choice; a walk they cut short is NOT complete.
 *
 * A candidate that cannot be read (the node lists it and does not serve it, serves other bytes, or bytes that do not
 * verify) makes the walk incomplete (R4-28): it is never skipped as if it held nothing. The walk goes on past it, so a
 * conflicting line that CAN be read is still found.
 */
async function walkLines<T extends ParsedMemo>(rpc: MemoRpc, anchorer: PublicKey, wanted: (m: ParsedMemo | null) => m is T, o: WalkOptions): Promise<LineWalk<T>> {
  const commitment = o.commitment ?? "finalized";
  const key = anchorer.toBase58();
  const found: LineWalk<T>["found"] = [];
  const keep = o.keep ?? WALK_KEEP_LINES;
  let more = false, unread: string | null = null;
  const done = (complete: boolean, why: string | null = null): LineWalk<T> => ({ found: found.reverse(), complete: complete && !unread, why: why ?? unread, more });
  const maxPages = o.maxPages === undefined ? Infinity : Math.max(1, o.maxPages), maxReads = o.maxReads === undefined ? Infinity : Math.max(1, o.maxReads);
  const toFloor = !o.until;
  let before = o.before;
  let reads = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc.getSignaturesForAddress(anchorer, { limit: 1000, ...(before ? { before } : {}), ...(o.until ? { until: o.until } : {}) }, commitment);
    if (!Array.isArray(batch)) return done(false, "the RPC did not return a signature list");
    // The candidates of this page, newest first, up to the first entry from before the floor.
    const candidates: string[] = [];
    let reachedFloor = false;
    for (const s of batch) {
      if (toFloor && s.blockTime != null && s.blockTime < o.floor) { reachedFloor = true; break; }
      if (s.err) continue;
      // The memo field picks candidates only where the node is known to index memos; otherwise every transaction is read.
      if (o.indexed && typeof s.memo !== "string") continue;
      if (typeof s.memo === "string" && !memoHints(s.memo).some((t) => wanted(parseMemo(t)))) continue;
      candidates.push(s.signature);
    }
    for (let i = 0; i < candidates.length; i += WALK_READ_BATCH) {
      const chunk = candidates.slice(i, i + WALK_READ_BATCH);
      if (reads + chunk.length > maxReads) return done(false, `more than ${maxReads} transactions would have to be read`);
      reads += chunk.length;
      const read = await Promise.all(chunk.map((signature) => readSignedTransaction(rpc, signature, commitment)));
      for (let j = 0; j < chunk.length; j++) {
        const r = read[j]!;
        if (!r.ok) {
          // The RPC cannot be asked at all: nothing further would be learned from it either.
          if (r.unavailable) return done(false, r.reason);
          // A transaction that landed and failed carries no line. Anything else was not read: the walk says so.
          if (!r.failedOnChain) unread ??= `transaction ${chunk[j]} is in the anchorer's history and could not be read (${r.reason})`;
          continue;
        }
        for (const m of r.tx.memos) {
          const claim = parseMemo(m.text);
          if (!wanted(claim) || !m.signers.includes(key) || !networkNamesGenesis(claim.network, o.genesis, o.configured)) continue;
          found.push({ signature: chunk[j]!, slot: r.tx.slot, blockTime: r.tx.blockTime, text: m.text, claim });
          // The walk runs from new to old and the earliest lines decide: when there are too many, the newest go.
          if (found.length > keep) { found.shift(); more = true; }
        }
      }
    }
    if (reachedFloor) return done(true);
    if (batch.length < 1000) {
      if (!toFloor) return done(true);
      // The list ended before a block time from before the floor was seen: complete only if the node keeps that history.
      return (await ledgerReachesBefore(rpc, o.floor)) ? done(true) : done(false, "the signature list ended before the range began, and the RPC does not keep its ledger back that far");
    }
    before = batch[batch.length - 1]!.signature;
  }
  return done(false, `the anchorer's history is longer than ${maxPages} pages for this range`);
}

/**
 * The anchorer's lines about `subject` (see `walkLines` for the range, the limits and what "complete" means). `before`
 * walks back from that signature to the start of the hour (`floor`); `until` walks from the newest signature back to
 * that one.
 */
export function walkSubjectLines(rpc: MemoRpc, anchorer: PublicKey, subject: MemoSubject, o: WalkOptions): Promise<SubjectWalk> {
  return walkLines(rpc, anchorer, (m): m is RootMemo | HostRootMemo => aboutSubject(m, subject), o);
}
/**
 * Every router root line `anchorer` signed from the newest back to `floor` (block time), oldest first: for comparing
 * what the chain holds with what a database says (src/services/anchor.ts `compareAnchorsWithChain`). Nothing is
 * dropped unless the caller sets `keep`; see `walkLines` for what "complete" means.
 */
export function walkRootLines(rpc: MemoRpc, anchorer: PublicKey, o: WalkOptions): Promise<LineWalk<RootMemo>> {
  return walkLines(rpc, anchorer, (m): m is RootMemo => !!m && m.kind === "root", { keep: Infinity, ...o });
}

/**
 * Whether the node lists memo text for this address: asked about a transaction that is known to carry a memo (the one
 * being verified), through the list entry of that very transaction. False when it cannot be shown.
 */
async function nodeIndexesMemos(rpc: MemoRpc, anchorer: PublicKey, signature: string, commitment: Finality): Promise<boolean> {
  try {
    const newer = await rpc.getSignaturesForAddress(anchorer, { limit: 1000, until: signature }, commitment);
    if (!Array.isArray(newer) || newer.length >= 1000) return false;
    const [entry] = await rpc.getSignaturesForAddress(anchorer, { limit: 1, ...(newer.length ? { before: newer[newer.length - 1]!.signature } : {}) }, commitment);
    return entry?.signature === signature && typeof entry.memo === "string";
  } catch {
    return false;
  }
}

/**
 * Whether `key` was ever handed the anchorer role: a finalized `trellis:anchorer:v1:<network>:<from hour>:<key>` line
 * that names it and that it signed itself (a hand-over is signed by the new key too, so it is in that key's own
 * history). scripts/mainnet/anchorer-rotate.ts asks this about the first key of a history before it prints one: a
 * history that starts at a key which was itself handed the role drops every key before it (R4-29). `found` is the
 * transaction; `complete` is false when the list could not be read to its end, which is not a "no". (A node that has
 * pruned the key's early history ends the list early: use an endpoint that keeps it.)
 */
export async function findHandOverTo(rpc: MemoRpc, key: PublicKey, o: { network: string; commitment?: Finality; maxPages?: number; maxReads?: number }): Promise<{ found: string | null; complete: boolean; why: string | null }> {
  const commitment = o.commitment ?? "finalized";
  const me = key.toBase58();
  const ref = networkRefOrNull(o.network);
  const maxPages = o.maxPages ?? 50, maxReads = o.maxReads ?? 5_000;
  let before: string | undefined;
  let reads = 0, listed = 0, withMemo = 0;
  const unhinted: string[] = [];
  const carries = async (signature: string): Promise<boolean | null> => {
    if (++reads > maxReads) return null;
    const r = await readSignedTransaction(rpc, signature, commitment);
    if (!r.ok) return r.failedOnChain ? false : null;
    return r.tx.memos.some((m) => { const c = parseMemo(m.text); return !!c && c.kind === "anchorer" && c.newAnchorer === me && (!ref || c.network === ref) && m.signers.includes(me); });
  };
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc.getSignaturesForAddress(key, { limit: 1000, ...(before ? { before } : {}) }, commitment);
    if (!Array.isArray(batch)) return { found: null, complete: false, why: "the RPC did not return a signature list" };
    for (const s of batch) {
      listed++;
      if (s.err) continue;
      if (typeof s.memo !== "string") { unhinted.push(s.signature); continue; }
      withMemo++;
      if (!memoHints(s.memo).some((t) => { const c = parseMemo(t); return !!c && c.kind === "anchorer" && c.newAnchorer === me; })) continue;
      const yes = await carries(s.signature);
      if (yes) return { found: s.signature, complete: true, why: null };
      if (yes === null) return { found: null, complete: false, why: `transaction ${s.signature} names a hand-over to this key and could not be read` };
    }
    if (batch.length < 1000) {
      // A node that lists no memo text at all shows nothing by its silence: read what it listed without one.
      if (listed > 0 && withMemo === 0) {
        for (const signature of unhinted) {
          const yes = await carries(signature);
          if (yes) return { found: signature, complete: true, why: null };
          if (yes === null) return { found: null, complete: false, why: "this RPC lists no memo text for the key's history, and its transactions could not all be read" };
        }
      }
      return { found: null, complete: true, why: null };
    }
    before = batch[batch.length - 1]!.signature;
  }
  return { found: null, complete: false, why: `the key's history is longer than ${maxPages} pages` };
}

// ---- Verification ----------------------------------------------------------------------------------------------------------

export type MemoVerification = {
  /** True only when every check passed. An answer that could not be established is NOT ok. */
  ok: boolean;
  /** "verified", "failed" (a check refuted the proof) or "unknown" (the RPC could not show what is needed). */
  status: "verified" | "failed" | "unknown";
  /** Why not, in words; null when ok. */
  reason: string | null;
  anchorer: string | null;
  slot: number | null;
  blockTime: number | null;
  /** True when no earlier finalized line of this anchorer exists for the same subject; null when that is not known. */
  earliest: boolean | null;
  /** The line landed later than the lateness bound after its hour closed. */
  late: boolean;
  /**
   * v2 root lines: "verified" when the line names the actual previous root of the anchorer (or rightly says there is
   * none), "not_checked" when that could not be established; null for a line without a link.
   */
  link: "verified" | "not_checked" | null;
  /** Other finalized lines of the anchorer for the same subject that carry a different root or count (evidence of a double post). */
  conflicts: FoundMemo[];
  /** Things this run could not establish. */
  notChecked: string[];
};
const failed = (reason: string, over: Partial<MemoVerification> = {}): MemoVerification => ({ ok: false, status: "failed", reason, anchorer: null, slot: null, blockTime: null, earliest: null, late: false, link: null, conflicts: [], notChecked: [], ...over });
const unknown = (reason: string, over: Partial<MemoVerification> = {}): MemoVerification => failed(reason, { status: "unknown", ...over });

/**
 * Check each rotation up to `upTo`: the previous key and the new key both signed
 * `trellis:anchorer:v1:<network>:<from hour>:<new key>`, in a transaction that landed before the end of the hour it starts in.
 */
export async function verifyAnchorerChain(rpc: Pick<MemoRpc, "getTransaction">, network: string, keys: readonly AnchorerKey[], upTo: number, commitment: Finality = "finalized"): Promise<string | null> {
  return (await anchorerChainProblem(rpc, network, keys, upTo, commitment))?.why ?? null;
}
type AnchorerMemo = Extract<ParsedMemo, { kind: "anchorer" }>;
/**
 * `verifyAnchorerChain`, saying also whether the problem is that something could not be read (`unread`: nothing is
 * known then, which is not a refutation). With `history` (an RPC that lists signatures, and the cluster's genesis
 * hash) it also holds each rotation to the rule that a key's earliest finalized hand-over is its only one (R5-19),
 * by walking the previous key's history from the rotation back to its beginning. Without it only the rotation
 * transaction itself is looked at (no second, different hand-over beside the one named): the router's own bounded
 * lookups, which publish the list themselves and are not the party a forked hand-over deceives.
 */
async function anchorerChainProblem(rpc: Pick<MemoRpc, "getTransaction">, network: string, keys: readonly AnchorerKey[], upTo: number, commitment: Finality, history?: { rpc: MemoRpc; genesis: string; configured?: { network: string; genesisHash: string } | null; maxPages?: number; maxReads?: number }): Promise<{ why: string; unread: boolean } | null> {
  const no = (why: string, unread = false) => ({ why, unread });
  const problem = anchorerKeysProblem(keys);
  if (problem) return no(problem);
  const ref = networkRefOrNull(network);
  const onCluster = (c: AnchorerMemo) => (history ? networkNamesGenesis(c.network, history.genesis, history.configured) : c.network === ref);
  for (let i = 1; i <= upTo; i++) {
    const k = keys[i]!, prev = keys[i - 1]!;
    const r = await readSignedTransaction(rpc, k.rotationTx!, commitment);
    if (!r.ok) return no(`the rotation to anchorer key ${i} could not be verified: ${r.reason}`, !!r.unavailable);
    const line = anchorerMemo({ network, fromHour: k.fromHour, newAnchorer: k.key });
    const memo = r.tx.memos.find((m) => m.text === line);
    if (!memo) return no(`the rotation transaction of anchorer key ${i} does not carry the line ${line}`);
    if (!memo.signers.includes(prev.key)) return no(`the rotation to anchorer key ${i} was not signed by the key before it`);
    if (!memo.signers.includes(k.key)) return no(`the rotation to anchorer key ${i} was not signed by the new key itself`);
    if (r.tx.blockTime == null) return no(`the rotation to anchorer key ${i} has no block time, so it cannot be shown to have been announced in time`);
    if (r.tx.blockTime > k.fromHour + HOUR) return no(`the rotation to anchorer key ${i} was announced after the hour it starts in`);
    // R5-19: the earliest finalized hand-over of the previous key is its only one.
    const same = (c: AnchorerMemo) => c.newAnchorer === k.key && c.fromHour === k.fromHour;
    const isHandOver = (m: ParsedMemo | null): m is AnchorerMemo => !!m && m.kind === "anchorer";
    if (r.tx.memos.some((m) => { const c = parseMemo(m.text); return isHandOver(c) && m.signers.includes(prev.key) && onCluster(c) && !same(c); })) return no(`the rotation transaction of anchorer key ${i} carries a second, different hand-over signed by the key before it: neither is a hand-over`);
    if (!history) continue;
    let walk: LineWalk<AnchorerMemo>;
    try {
      const before = new PublicKey(prev.key);
      walk = await walkLines(history.rpc, before, isHandOver, { genesis: history.genesis, configured: history.configured, before: k.rotationTx!, floor: 0, commitment, maxPages: history.maxPages, maxReads: history.maxReads, indexed: await nodeIndexesMemos(history.rpc, before, k.rotationTx!, commitment) });
    } catch (e) {
      return no(`whether the key before anchorer key ${i} handed over earlier is not known: its history could not be read (${(e as Error).message.slice(0, 100)})`, true);
    }
    const earlier = walk.found.find((m) => m.signature !== k.rotationTx && !same(m.claim));
    if (earlier) return no(`the key before anchorer key ${i} signed an earlier hand-over, to ${earlier.claim.newAnchorer} from hour ${earlier.claim.fromHour} (transaction ${earlier.signature}): a key's earliest hand-over is its only one, so the rotation in this list is none`);
    if (!walk.complete) return no(`whether the key before anchorer key ${i} handed over earlier is not known: its history was not read to its beginning (${walk.why ?? "the walk was cut short"})`, true);
  }
  return null;
}

export type VerifyMemoLineArgs = {
  signature: string;
  /** The network the VERIFIER expects (its own configuration). The line must name it, and the RPC must serve it. */
  network: string;
  /** The exact line expected in the transaction. */
  line: string;
  /** The anchorer keys the VERIFIER trusts, oldest first. */
  anchorers: readonly AnchorerKey[];
  commitment?: Finality;
  /** Skip the walk through the anchorer's history: `earliest` is then null, the link is only half checked, and the result says so. */
  skipHistory?: boolean;
  /** How long after the hour closed a line may land (default DEFAULT_MAX_LATE_SECONDS). */
  maxLateSeconds?: number;
  /** Accept a late line (it is still reported as late). */
  allowLate?: boolean;
  /** Root lines of this hour and later must be v2 lines. Unset: either version is accepted for any hour. */
  v2FromHour?: number | null;
  /** The genesis hash of a network whose name is neither a CAIP-2 reference nor a public cluster's name. */
  genesisHash?: string;
  /** Limits of the caller's own choosing on the walk back through the anchorer's history. Unset: none; a walk they cut short answers "unknown". */
  maxPages?: number;
  maxReads?: number;
  /** Accepted and ignored: the hour and the prefix are read from the line itself. */
  hour?: number;
  prefix?: string;
};

/**
 * Verify that `signature` is the anchorer's memo for exactly this line, on the cluster the verifier expects, under the
 * anchorer key published for its hour, in time, and that it is the earliest finalized line for its subject.
 */
export async function verifyMemoLine(rpc: MemoRpc, a: VerifyMemoLineArgs): Promise<MemoVerification> {
  const commitment = a.commitment ?? "finalized";
  const claim = parseMemo(a.line);
  if (!claim || (claim.kind !== "root" && claim.kind !== "hostroot")) return failed("the expected line is not a root line");
  const hour = claim.hour;
  const ref = networkRefOrNull(a.network);
  if (!ref || claim.network !== ref) return failed(`the line names network ${claim.network}, not the network this verifier expects (${ref ?? a.network})`);
  const problem = anchorerKeysProblem(a.anchorers);
  const at = anchorerIndexAt(a.anchorers, hour);
  if (problem || at < 0) return failed(problem ?? "no anchorer key is published for that hour");
  // The cluster: the same line on another cluster, or under another cluster's name, says nothing here.
  const configured = a.genesisHash ? { network: a.network, genesisHash: a.genesisHash } : null;
  let genesis: string;
  try {
    if (!rpc.getGenesisHash) return unknown("the RPC cannot say which cluster it serves (no getGenesisHash), so the line's network cannot be bound to it");
    genesis = await rpc.getGenesisHash();
  } catch (e) {
    return unknown(`the RPC could not be asked which cluster it serves: ${(e as Error).message.slice(0, 100)}`);
  }
  if (!networkNamesGenesis(ref, genesis, configured)) return failed(`the RPC serves the cluster with genesis hash ${genesis}, which is not the cluster the line's network (${ref}) names`);
  const chain = await anchorerChainProblem(rpc, a.network, a.anchorers, at, commitment, a.skipHistory ? undefined : { rpc, genesis, configured, maxPages: a.maxPages, maxReads: a.maxReads });
  if (chain) return chain.unread ? unknown(chain.why) : failed(chain.why);
  const anchorer = a.anchorers[at]!.key;
  const r = await readSignedTransaction(rpc, a.signature, commitment);
  if (!r.ok) return r.unavailable ? unknown(r.reason, { anchorer }) : failed(r.reason, { anchorer });
  const base = { anchorer, slot: r.tx.slot, blockTime: r.tx.blockTime };
  const memo = r.tx.memos.find((m) => m.text === a.line);
  if (!memo) return failed("the transaction carries no memo with exactly the expected line (another root, count, hour or network)", base);
  if (!memo.signers.includes(anchorer)) return failed(`the memo was not signed by the anchorer key published for that hour (${anchorer})`, base);
  // Every memo line of this very transaction (R4-10): a second line the anchorer signed in it for the same subject with
  // another root or count is a conflict, and there is no "earlier" between two lines of one transaction.
  const subject = subjectOf(claim);
  const ownCluster = (c: { network: string }) => networkNamesGenesis(c.network, genesis, configured);
  const beside = r.tx.memos.filter((m) => { const c = parseMemo(m.text); return m.signers.includes(anchorer) && aboutSubject(c, subject) && ownCluster(c) && !sameClaim(c, claim); });
  if (beside.length) return failed("the transaction itself carries two different roots for this hour, both signed by the anchorer: a conflict, and neither line is the root of the hour", { ...base, earliest: false, conflicts: beside.map((m) => ({ signature: a.signature, slot: r.tx.slot, blockTime: r.tx.blockTime, text: m.text })) });
  const landed = r.tx.blockTime;
  if (landed == null) return unknown("the RPC gave no block time for the transaction, so neither its hour nor its lateness can be checked", base);
  if (landed < hour) return failed("the memo was posted before the hour it claims to cover", base);
  const next = a.anchorers[at + 1];
  if (next && landed >= next.fromHour + HOUR) return failed(`the memo was signed by a retired key: ${anchorer} handed over at hour ${next.fromHour}, and this line landed after that hand-over took effect`, base);
  if (claim.kind === "root" && claim.version !== 2 && a.v2FromHour != null && hour >= a.v2FromHour) return failed(`the line is a v1 line for an hour at or after the switch to linked (v2) lines (hour ${a.v2FromHour})`, base);
  const maxLate = a.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS;
  const late = landed > hour + HOUR + maxLate;
  if (late && !a.allowLate) return failed(`the memo landed ${landed - hour - HOUR} seconds after its hour closed, later than the bound of ${maxLate} seconds: a late line is not an anchor`, { ...base, late });
  const notChecked: string[] = [];
  // The link of a v2 line (R4-28): the transaction it names must be read, must be a root line of the anchorer for an
  // EARLIER hour that landed BEFORE this one, and must be the actual previous root: the anchorer signed no root that
  // counts for an hour between the two. `0` says there is no previous root at all, and is checked in the same way.
  let link: MemoVerification["link"] = null;
  let linkUnknown: string | null = null;
  /** The first hour a root would have to exist for, for the link to be wrong; null when the line carries no link. */
  let between: number | null = null;
  const named = claim.kind === "root" ? claim.prev ?? null : null;
  if (claim.kind === "root" && claim.version === 2) {
    if (claim.prev) {
      const p = await readSignedTransaction(rpc, claim.prev, commitment);
      if (!p.ok) {
        if (p.failedOnChain) return failed("the line's link does not hold: the transaction it names as the previous root failed on chain", { ...base, late });
        linkUnknown = `the transaction the line names as the previous root could not be read (${p.reason})`;
      } else {
        let previous = -1;
        for (const m of p.tx.memos) {
          const c = parseMemo(m.text);
          if (!c || c.kind !== "root" || c.hour >= hour || !ownCluster(c)) continue;
          const i = anchorerIndexAt(a.anchorers, c.hour);
          if (i >= 0 && i <= at && m.signers.includes(a.anchorers[i]!.key) && p.tx.slot < r.tx.slot) previous = Math.max(previous, c.hour);
        }
        if (previous < 0) return failed("the line's link does not hold: the transaction it names as the previous root is not an earlier root line of the anchorer", { ...base, late });
        between = previous + HOUR;
      }
    } else between = 0;
  }
  const sofar = { ...base, late, link };
  if (a.skipHistory) {
    if (linkUnknown) return unknown(`whether the line's link holds is not known: ${linkUnknown}`, { ...sofar, link: "not_checked" });
    if (between !== null) notChecked.push(named ? "Whether the root the line links to is the one directly before it (the anchorer's history was not walked)." : "Whether the line is rightly the first root (the anchorer's history was not walked).");
    if (at > 0) notChecked.push("Whether an earlier anchorer key signed another hand-over before the rotation in the key list (its history was not walked).");
    return { ok: true, status: "verified", reason: null, ...sofar, link: between === null ? null : named ? "verified" : "not_checked", earliest: null, conflicts: [], notChecked: [...notChecked, "Whether an earlier line exists for the same hour (the anchorer's history was not walked)."] };
  }
  // The earliest finalized line for the hour is the root. Look back from this one to before the hour began, and forward
  // from it to now for a later line that contradicts it. A walk that does not cover the range gives no answer. The same
  // walk back looks for a root the link passed over, and goes back as far as that takes (in the ordinary case, where
  // the line names the root of the hour before, no further than the hour itself).
  const key = new PublicKey(anchorer);
  const mine = a.anchorers[at]!;
  const from = linkUnknown || between === null ? hour : Math.min(hour, Math.max(between, mine.fromHour));
  const passedOver = (m: ParsedMemo | null): m is RootMemo => !!m && m.kind === "root" && m.hour >= from && m.hour < hour;
  let back: SubjectWalk, later: SubjectWalk;
  const walk: WalkOptions = { genesis, configured, floor: from, commitment, maxPages: a.maxPages, maxReads: a.maxReads, indexed: false };
  const none: SubjectWalk = { found: [], complete: false, why: null, more: false };
  try {
    walk.indexed = await nodeIndexesMemos(rpc, key, a.signature, commitment);
    back = await walkLines(rpc, key, (m): m is RootMemo | HostRootMemo => aboutSubject(m, subject) || passedOver(m), { ...walk, before: a.signature });
    later = back.complete ? await walkSubjectLines(rpc, key, subject, { ...walk, floor: hour, maxPages: a.maxPages ?? LATER_WALK.maxPages, maxReads: a.maxReads ?? LATER_WALK.maxReads, until: a.signature }).catch((e) => ({ ...none, why: (e as Error).message.slice(0, 100) })) : none;
  } catch (e) {
    return unknown(`whether this is the earliest line for its hour is not known: the anchorer's history could not be read (${(e as Error).message.slice(0, 100)})`, sofar);
  }
  // A line that landed before the hour began is no line for it (the walk reaches back that far only for the link).
  const before = back.found.filter((m) => m.signature !== a.signature && aboutSubject(m.claim, subject) && !(m.blockTime != null && m.blockTime < hour));
  const conflictsOf = (list: SubjectWalk["found"]) => list.filter((m) => m.signature !== a.signature && !sameClaim(m.claim, claim)).map(({ claim: _claim, ...m }) => m);
  // The earliest TRANSACTION decides, with every line in it (R4-10): one that carries another root, alone or beside a
  // copy of this one, refutes the proof.
  const first = before.filter((m) => m.signature === before[0]!.signature).find((m) => !sameClaim(m.claim, claim));
  if (first) return failed(`an earlier finalized line of the anchorer names another root for this hour (transaction ${first.signature}): the earliest line is the root`, { ...sofar, earliest: false, conflicts: conflictsOf([...before, ...later.found]), notChecked });
  // The link, second half: a root of the anchorer that counts, for an hour between the one the line names and its own.
  const counts = (m: SubjectWalk["found"][number], signer: string) => m.signature !== a.signature && m.signature !== named && m.slot < r.tx.slot && lineStanding({ hour: m.claim.hour, landed: m.blockTime, signer, anchorers: a.anchorers, maxLateSeconds: maxLate }) === "counts";
  const linkBroken = (m: SubjectWalk["found"][number]) => failed(`the line's link does not hold: it ${named ? "names an older transaction as the previous root" : "says there is no previous root"}, but the anchorer signed a root for hour ${m.claim.hour} before this line (transaction ${m.signature})`, { ...sofar, notChecked });
  const skipped = back.found.find((m) => passedOver(m.claim) && counts(m, anchorer));
  if (skipped) return linkBroken(skipped);
  if (!back.complete) return unknown(`whether this is the earliest line for its hour is not known: the anchorer's history was not read back to before the hour began (${back.why ?? "the walk was cut short"})`, { ...sofar, notChecked });
  if (linkUnknown) return unknown(`whether the line's link holds is not known: ${linkUnknown}`, { ...sofar, link: "not_checked", notChecked });
  if (between !== null) {
    // Hours between the two that an EARLIER key owned are looked for in that key's own history.
    for (let i = at - 1; i >= 0 && between < a.anchorers[i + 1]!.fromHour; i--) {
      const lo = Math.max(between, a.anchorers[i]!.fromHour), hi = Math.min(hour, a.anchorers[i + 1]!.fromHour);
      if (lo >= hi) continue;
      let w: SubjectWalk;
      try {
        w = await walkLines(rpc, new PublicKey(a.anchorers[i]!.key), (m): m is RootMemo | HostRootMemo => !!m && m.kind === "root" && m.hour >= lo && m.hour < hi, { ...walk, floor: lo, indexed: false });
      } catch (e) {
        w = { ...none, why: (e as Error).message.slice(0, 100) };
      }
      const found = w.found.find((m) => counts(m, a.anchorers[i]!.key));
      if (found) return linkBroken(found);
      if (!w.complete) return unknown(`whether the line's link names the actual previous root is not known: the history of an earlier anchorer key was not read (${w.why ?? "the walk was cut short"})`, { ...sofar, link: "not_checked", notChecked });
    }
    link = "verified";
  }
  if (back.more || later.more) notChecked.push(`The anchorer signed more than ${WALK_KEEP_LINES} lines for this range; only the earliest are listed.`);
  if (!later.complete) notChecked.push(`Whether the anchorer signed a different line for this hour later: the history after this line was not read to its end${later.why ? ` (${later.why})` : ""}.`);
  return { ok: true, status: "verified", reason: null, ...sofar, link, earliest: before.length === 0, conflicts: conflictsOf([...before, ...later.found]), notChecked };
}

type RootArgs = Omit<VerifyMemoLineArgs, "line"> & { hour: number; count: number; root: string; /** The line as posted (a v2 line carries a link this function cannot rebuild); it must say this hour, count and root. */ line?: string };
export function verifyRootMemo(rpc: MemoRpc, a: RootArgs): Promise<MemoVerification> {
  let line: string;
  try {
    line = rootMemo(a);
  } catch (e) {
    return Promise.resolve(failed((e as Error).message));
  }
  if (a.line !== undefined) {
    const given = parseMemo(a.line), built = parseMemo(line) as RootMemo;
    if (!given || given.kind !== "root" || given.network !== built.network || given.hour !== built.hour || !sameClaim(given, built)) return Promise.resolve(failed("the line given is not a root line for this network, hour, count and root"));
    line = a.line;
  }
  return verifyMemoLine(rpc, { ...a, line });
}
export function verifyHostRootMemo(rpc: MemoRpc, a: Omit<VerifyMemoLineArgs, "line"> & { providerIdHash: string; hour: number; count: number; root: string }): Promise<MemoVerification> {
  let line: string;
  try {
    line = hostRootMemo(a);
  } catch (e) {
    return Promise.resolve(failed((e as Error).message));
  }
  return verifyMemoLine(rpc, { ...a, line });
}

// ---- Program mode through the same path: a root whose account was closed -----------------------------------------------

const le64 = (v: number | bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
/** Anchor instruction discriminators of trellis_anchor (sha256("global:<name>")[0..8]); src/solana/idl/trellis_anchor.json carries the same bytes. */
export const POST_ROOT_DISCRIMINATOR = Buffer.from([154, 210, 156, 158, 199, 27, 174, 35]);
export const POST_HOST_ROOT_DISCRIMINATOR = Buffer.from([25, 195, 127, 184, 90, 53, 223, 102]);
export const postRootData = (a: { hour: number | bigint; root: string; count: number | bigint }) => Buffer.concat([POST_ROOT_DISCRIMINATOR, le64(hourOf(a.hour)), Buffer.from(hex64(a.root, "root"), "hex"), le64(countOf(a.count))]);
export const postHostRootData = (a: { providerIdHash: string; hour: number | bigint; root: string; count: number | bigint }) =>
  Buffer.concat([POST_HOST_ROOT_DISCRIMINATOR, Buffer.from(hex64(a.providerIdHash, "provider id hash"), "hex"), le64(hourOf(a.hour)), Buffer.from(hex64(a.root, "root"), "hex"), le64(countOf(a.count))]);

/**
 * A root posted to trellis_anchor, checked from the transaction that posted it instead of from its account (which
 * close_root removes after 400 days): the transaction is finalized and succeeded, it carries post_root / post_host_root
 * with exactly these arguments for this program (the id the CALLER pins), and its authority signed and is the anchorer
 * key the caller publishes for that hour. The program itself refused a second root for the hour when this one landed,
 * so there is no history to walk.
 */
export async function verifyProgramPost(rpc: Pick<MemoRpc, "getTransaction">, a: { signature: string; programId: string; data: Uint8Array; anchorers: readonly AnchorerKey[]; hour: number; commitment?: Finality }): Promise<MemoVerification> {
  // The program id and the keys are the caller's own configuration. Without a key to compare the authority with, any
  // program that accepts these bytes from anyone would pass.
  const problem = anchorerKeysProblem(a.anchorers ?? []);
  const at = problem ? -1 : anchorerIndexAt(a.anchorers, a.hour);
  if (problem || at < 0) return failed(`no anchorer key is published to compare the posting authority with${problem ? ` (${problem})` : ""}`);
  const r = await readSignedTransaction(rpc, a.signature, a.commitment ?? "finalized");
  if (!r.ok) return r.unavailable ? unknown(r.reason) : failed(r.reason);
  const ix = r.tx.instructions.find((i) => i.programId === a.programId && Buffer.from(i.data).equals(Buffer.from(a.data)));
  const base = { slot: r.tx.slot, blockTime: r.tx.blockTime };
  if (!ix) return failed("the transaction carries no post_root instruction with exactly these arguments for the anchor program", base);
  const authority = ix.accounts[0] ?? null;
  if (!authority || !r.tx.signers.includes(authority)) return failed("the instruction's authority did not sign the transaction", base);
  if (a.anchorers[at]!.key !== authority) return failed(`the root was posted by ${authority}, not by the anchorer key published for that hour`, { ...base, anchorer: authority });
  return { ok: true, status: "verified", reason: null, anchorer: authority, ...base, earliest: true, late: false, link: null, conflicts: [], notChecked: [] };
}
