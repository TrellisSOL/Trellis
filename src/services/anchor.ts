import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Transaction, type Keypair } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import type { Hex } from "../lib/hash.ts";
import { anchors, facilitatorSettlements, generations, hostAnchors, kv, receiptKeys } from "../db/schema.ts";
import { idHash } from "../lib/hash.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { log } from "../lib/util.ts";
import {
  DEFAULT_MAX_LATE_SECONDS, EMPTY_ROOT, MEMO_PROGRAM_ID, anchorerIndexAt, lineStanding, memoHints, memoIx, networkNamesGenesis, networkRef, parseMemo, postRootData, readSignedTransaction, rootMemo, rootMemoV2, sameClaim, subjectKey, subjectOf,
  verifyAnchorerChain, verifyMemoLine, verifyProgramPost, verifyRootMemo, walkRootLines, type AnchorerKey, type HostRootMemo, type LineStanding, type MemoRpc, type RootMemo,
} from "../solana/anchor-memo.ts";
import { base58Encode } from "../solana/constants.ts";
import { closeRootIx, receiptRootHour, receiptRootPda, rootClosableAt, SECONDS_PER_HOUR } from "../solana/programs/anchor.ts";

// Hourly: build a merkle tree over every receipt leaf (v1, plus v2 where issued, then facilitator settlement receipts)
// since the last anchor, store the proof positions, and post the root on Solana (status "local" when no chain is
// configured, so proofs still work). With a chain configured a batch closes only on a whole hour, so every anchor maps
// to one on-chain hour (`anchorHour`); the router's running `index` stays the id receipts carry.
//
// Where the root goes is ANCHOR_MODE (src/solana/launch-config.ts):
//   program   trellis_anchor::post_root (ReceiptRoot{hour, root, count}: one account per hour, keyed by the hour that
//             closed the batch; the program refuses a second one). The account's rent comes back through close_root
//             once the hour is 400 days old (`closeExpiredRoots`), after which the root is verified from the
//             transaction that posted it.
//   memo      one SPL Memo transaction per hour signed by the anchorer key (src/solana/anchor-memo.ts): no account and
//             no rent. Nothing on chain refuses a second line, so this job keeps to one. What it believes about the
//             chain (security review round 3, R3-03 and R3-12):
//               - what it posted, it knows by SIGNATURE: every transaction is signed here, its signature is stored
//                 before it is sent, and a row is marked anchored only when that signature is read back FINALIZED
//                 with the anchorer's memo in it. No list of the anchorer's history is needed to learn that, so a
//                 flood of transactions that merely name the anchorer delays nothing;
//               - what ELSE the anchorer key signed, it learns from a bounded audit of the key's history
//                 (`auditAnchorerHistory`, a stored cursor, a few pages per pass). A candidate counts only after its
//                 transaction was read and the memo instruction carrying the line was signed by the anchorer. A
//                 stranger's transaction with the same text is not a line: it is neither adopted nor a conflict;
//               - a different root for an hour signed by the real anchorer is an incident: `anchor.memo_conflict` at
//                 error level on every pass, the row stays "conflict" and nothing is posted over it;
//               - every hour gets a line, also an hour without receipts (count 0), one hour per row, each line naming
//                 the transaction of the one before it (v2), so no past hour is left for a later signer;
//               - a line that lands later than the lateness bound is "late": alarmed (`anchor.memo_late`), served as
//                 not anchored.
//             And since security review round 4:
//               - the router applies the verifiers' rules to every line it reads (R4-13, `lineStanding`): a line
//                 that landed before its hour began, after the lateness bound, after its key was retired, or that
//                 was not signed by the key published for its hour, is neither the root of that hour nor a conflict
//                 with it. What is remembered about a line is kept per anchorer key, so nothing a retired key
//                 signed outlasts the rotation;
//               - a line is signed by the key published for ITS hour (R4-12). This process holds one key; a row
//                 whose hour belongs to another key is not posted with the wrong one, and no row is marked
//                 confirmed before `verifyMemoLine` has accepted its line under the published keys. Such a row is
//                 "unverifiable" (`anchor.memo_wrong_key`, `anchor.memo_refused`), served as not anchored;
//               - two different roots for one hour in ONE transaction are a conflict (R4-10): every memo line of a
//                 transaction is kept, and the earliest transaction decides with all its lines;
//               - the receipts of a "late" or "unverifiable" row are not left there (R4-28): the next row that is
//                 built takes them, so they are rooted one hour later under a root that verifies. After a gap,
//                 the hours too old to be anchored in time are closed in one row whose own hour still can be.
//
// Row status: pending (built; not yet final on chain) | confirmed | late | conflict | unverifiable (no line a verifier
// accepts exists for the hour) | local (no chain was configured).

type AnchorSettings = { mode: "memo" | "program"; explicit?: boolean; program: string | null; anchorer: string | null; anchorers: AnchorerKey[]; memoV2FromHour: number; maxLateSeconds: number };
/**
 * The anchor settings of this process. Unless ANCHOR_MODE was set, the mode follows the chain handle: program mode when
 * it has an anchor program, memo mode otherwise (so a context whose chain handle was swapped for another one, as tests
 * do, stays consistent with that handle). The anchorer is the published key, or the one this process signs with.
 */
export function anchorSettings(ctx: Ctx): AnchorSettings {
  const a = (ctx.cfg as { launch?: { anchor?: Partial<AnchorSettings> & { anchorers?: AnchorerKey[] } } }).launch?.anchor;
  const program = ctx.chain.address("receiptAnchor") ?? null;
  const anchorer = a?.anchorer ?? ctx.chain.roleAddress("anchorer") ?? null;
  const mode = a?.explicit ? a.mode! : program ? "program" : "memo";
  return {
    mode, explicit: !!a?.explicit, program: mode === "program" ? program : null, anchorer,
    anchorers: a?.anchorers?.length ? a.anchorers : anchorer ? [{ key: anchorer, fromHour: 0, rotationTx: null }] : [],
    memoV2FromHour: a?.memoV2FromHour ?? 0,
    maxLateSeconds: a?.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS,
  };
}
/** Whether this process can post roots: the anchorer key, and in program mode the program. */
export function anchorPostingConfigured(ctx: Ctx): boolean {
  if (!ctx.chain.roleAddress("anchorer")) return false;
  return anchorSettings(ctx).mode === "memo" ? true : !!ctx.chain.address("receiptAnchor");
}
/** The anchorer keys this router publishes, oldest first (ANCHORER_KEYS, or the one current key). */
export const publishedAnchorers = (ctx: Ctx): AnchorerKey[] => anchorSettings(ctx).anchorers;

/**
 * The `anchor` part of /.well-known/trellis-receipt-keys.json: where this router's receipt roots go, which key signs
 * them (with every earlier key and the transaction that handed over from it), from which hour root lines are linked
 * (v2), and how late a root may land. It is the router's own statement and it is NOT signed: a verifier uses it only as
 * its own configuration, fetched by itself from the router's origin, and pins the first key to rely on more than that.
 * The copy inside a proof pack is for reading; no verifier takes its settings from a pack.
 *
 * How long a copy may be relied on is said by the document it is part of (`issued_at`, `expires_at` beside `keys`:
 * src/receipts/signer.ts `jwks`), and the version of this list is the number of keys in it, which rises with every
 * rotation (R3-14, R4-12): a verifier whose copy misses a rotation accepts the retired key for hours the new key owns,
 * and without an expiry that copy was good for ever. Verifiers refuse an expired document, and a list shorter than
 * one they have seen.
 */
export function anchorKeyDocument(ctx: Ctx) {
  const a = anchorSettings(ctx);
  return {
    mode: a.mode,
    network: ctx.cfg.chain.network,
    program: a.mode === "program" ? a.program ?? ctx.chain.address("receiptAnchor") ?? null : null,
    memo_program: a.mode === "memo" ? MEMO_PROGRAM_ID.toBase58() : null,
    anchorer: a.anchorer,
    anchorers: a.anchorers.map((k) => ({ key: k.key, from_hour: k.fromHour, rotation_tx: k.rotationTx })),
    memo_v2_from_hour: a.mode === "memo" ? a.memoV2FromHour : null,
    max_late_seconds: a.mode === "memo" ? a.maxLateSeconds : null,
  };
}

async function getKv<T>(ctx: Ctx, k: string): Promise<T | null> {
  const [r] = await ctx.db.select().from(kv).where(eq(kv.key, k));
  return (r?.value as T) ?? null;
}
async function setKv(ctx: Ctx, k: string, v: unknown) {
  await ctx.db.insert(kv).values({ key: k, value: v }).onConflictDoUpdate({ target: kv.key, set: { value: v, updatedAt: new Date() } });
}

/** How one anchor was posted: kept beside the row so a proof can say which key signed which line (the key published for the line's hour). */
export type AnchorPost = { mode: "memo" | "program"; anchorer: string; memo?: string; program?: string | null };
const postKey = (index: number) => `anchor-post:${index}`;
export const anchorPost = (ctx: Ctx, index: number) => getKv<AnchorPost>(ctx, postKey(index));

/** The on-chain hour an anchor row was (or will be) posted under. */
export const anchorHour = (a: { toTs: Date }) => receiptRootHour(Math.floor(a.toTs.getTime() / 1000));

/**
 * What a proof says about where its root was posted, beside `tx`: the mode, the hour and count, the anchorer key that
 * signed and the memo line (memo mode). These fields tell a verifier WHAT to look for; which mode, program and keys to
 * trust it takes from its own configuration.
 */
export async function anchorProofFields(ctx: Ctx, a: { index: number; root: string; toTs: Date; count: number; status: string; txHash: string | null }) {
  if ((a.status !== "confirmed" && a.status !== "late") || !a.txHash) return { mode: null, hour: null, count: a.count, anchorer: null, memo: null, memo_program: null, late: false };
  const settings = anchorSettings(ctx);
  const post = (await anchorPost(ctx, a.index)) ?? { mode: settings.program ? ("program" as const) : settings.mode, anchorer: settings.anchorer ?? "" };
  const hour = anchorHour(a);
  return {
    mode: post.mode,
    hour,
    count: a.count,
    anchorer: post.anchorer || null,
    memo: post.mode === "memo" ? post.memo ?? rootMemo({ network: ctx.cfg.chain.network, hour, count: a.count, root: a.root }) : null,
    memo_program: post.mode === "memo" ? MEMO_PROGRAM_ID.toBase58() : null,
    /** The line landed after the lateness bound: it is not an anchor (the row's status says "late" too). */
    late: a.status === "late",
  };
}

// ---- What the chain holds for one of the router's anchors ---------------------------------------------------------------

export type AnchorOnChain = {
  /** verified: the chain holds this root, checked now or within the cache's lifetime. unverified: it does not, or what
   *  is there does not verify. not_posted: the row was never posted. unknown: not looked up (RPC error, or no budget). */
  status: "verified" | "unverified" | "not_posted" | "unknown";
  anchor: { hour: number; root: Hex; count: number; signer: string; postedAt: number; source: "memo" | "account" | "transaction"; conflicts: number } | null;
  reason: string | null;
};
const verifyCache = new Map<string, { until: number; value: AnchorOnChain }>();
const dbIds = new WeakMap<object, number>();
let nextDbId = 0;
const dbId = (db: object) => dbIds.get(db) ?? (dbIds.set(db, ++nextDbId), nextDbId);
/** How long an answer is reused: a verified root is final; a negative answer may change when a pending root lands. */
const VERIFY_CACHE_MS = { verified: 600_000, unverified: 30_000, not_posted: 5_000 };
/** Forget cached lookups (tests). */
export const resetAnchorVerifyCache = () => verifyCache.clear();

/**
 * The root the chain holds for the router's anchor `index`. Program mode reads the ReceiptRoot account, and once that
 * account was closed the transaction that posted it, for the configured program and under the published anchorer key.
 * Memo mode reads the row's own transaction at FINALIZED and verifies it (the anchorer's signature, the exact line, the
 * cluster, the key for that hour, lateness, the link), and takes "is it the earliest line for its hour" from what the
 * audit of the anchorer's history has read: no history walk runs here, so one lookup costs a bounded number of RPC
 * calls (R3-29). Answers are cached per anchor; `allow` is asked before any RPC work and `unknown` is the answer when
 * it says no.
 */
export async function anchorOnChain(ctx: Ctx, index: number, o: { allow?: () => boolean | Promise<boolean> } = {}): Promise<AnchorOnChain> {
  const [a] = await ctx.db.select().from(anchors).where(eq(anchors.index, index));
  if (!a) return { status: "not_posted", anchor: null, reason: "no such anchor" };
  const cacheKey = `${dbId(ctx.db as object)}:${index}:${a.status}:${a.txHash ?? ""}:${a.root}`;
  const hit = verifyCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.value;
  if (o.allow && !(await o.allow())) return { status: "unknown", anchor: null, reason: "not looked up: the budget for chain lookups is used up; try again in a minute" };
  const value = await lookupAnchorOnChain(ctx, a);
  if (value.status !== "unknown") {
    verifyCache.set(cacheKey, { until: Date.now() + VERIFY_CACHE_MS[value.status], value });
    if (verifyCache.size > 2_048) verifyCache.delete(verifyCache.keys().next().value as string);
  }
  return value;
}
async function lookupAnchorOnChain(ctx: Ctx, a: typeof anchors.$inferSelect): Promise<AnchorOnChain> {
  const no = (status: AnchorOnChain["status"], reason: string): AnchorOnChain => ({ status, anchor: null, reason });
  const hour = anchorHour(a);
  const post = await anchorPost(ctx, a.index);
  const settings = anchorSettings(ctx);
  const mode = post?.mode ?? (ctx.chain.address("receiptAnchor") ? "program" : settings.mode);
  const rpc = ctx.chain.connection as unknown as MemoRpc;
  try {
    if (mode === "memo") {
      if (a.status === "late") return no("unverified", "the root landed after the lateness bound: it is not an anchor");
      if (a.status !== "confirmed" || !a.txHash) return no("not_posted", `the root is not posted (status ${a.status})`);
      if (!settings.anchorers.length) return no("unverified", "no anchorer key is configured");
      const v = await verifyRootMemo(rpc, { signature: a.txHash, network: ctx.cfg.chain.network, hour, count: a.count, root: a.root, line: post?.memo, anchorers: settings.anchorers, skipHistory: true, maxLateSeconds: settings.maxLateSeconds, v2FromHour: settings.memoV2FromHour });
      if (!v.ok) return no(v.status === "unknown" ? "unknown" : "unverified", v.reason ?? "the memo does not verify");
      // Other lines the anchorer signed for this hour that count, as far as its history has been audited. A different
      // root in the row's own transaction is refused by the verifier above; one in the same slot is no later than ours.
      const mine = { root: a.root.replace(/^0x/, "").toLowerCase(), count: a.count };
      const others = (await anchorerLines(ctx, `root:${hour}`)).filter((l) => !claimIs(l.text, mine));
      const earlier = others.find((l) => l.slot <= (v.slot ?? 0));
      if (earlier) return no("unverified", `an earlier line of the anchorer names another root for this hour (transaction ${earlier.signature})`);
      return { status: "verified", reason: null, anchor: { hour, root: a.root.toLowerCase() as Hex, count: a.count, signer: v.anchorer!, postedAt: v.blockTime ?? 0, source: "memo", conflicts: others.length } };
    }
    const account = await ctx.chain.anchorOnChain(hour);
    if (account) return { status: "verified", reason: null, anchor: { ...account, root: account.root as Hex, source: "account", conflicts: 0 } };
    // The account is gone (closed after the retention period): the transaction that posted it still carries the root.
    const program = ctx.chain.address("receiptAnchor");
    if (!program || a.status !== "confirmed" || !a.txHash) return no("not_posted", `the root is not posted (status ${a.status})`);
    const v = await verifyProgramPost(rpc, { signature: a.txHash, programId: program, data: postRootData({ hour, root: a.root, count: a.count }), hour, anchorers: settings.anchorers });
    if (!v.ok) return no(v.status === "unknown" ? "unknown" : "unverified", v.reason ?? "the posting transaction does not verify");
    return { status: "verified", reason: null, anchor: { hour, root: a.root.toLowerCase() as Hex, count: a.count, signer: v.anchorer!, postedAt: v.blockTime ?? 0, source: "transaction", conflicts: 0 } };
  } catch (e) {
    return no("unknown", `the chain could not be read: ${(e as Error).message.slice(0, 120)}`);
  }
}
/** The verified on-chain root of anchor `index`, or null. */
export const anchorRootOnChain = async (ctx: Ctx, index: number) => (await anchorOnChain(ctx, index)).anchor;

// ---- Memo lines: posting by signature, and the audit of the anchorer's history ----------------------------------------------

/** An attempt younger than this may still land (a blockhash lives about 90 seconds): no second transaction until then. */
export const MEMO_RETRY_QUIET_MS = 180_000;
/** Timing of the memo job. `finalityWaitMs`: how long one pass waits for its own transaction to become final. */
export const memoTiming = { retryQuietMs: MEMO_RETRY_QUIET_MS, finalityWaitMs: 60_000, finalityPollMs: 2_000 };
/**
 * The audit's work: pages of the signature list and transactions read in one call, and how many calls one pass makes in
 * a row while the audit has not reached the head of the history and each call used up its budget (`auditQuietly`).
 * Since no new line is sent before the audit has reached the head (R5-20), the product is what a stranger must outrun
 * with transactions that look like lines of the key to stop anchoring: more than `callsPerPass * readsPerPass`
 * look-alikes between two passes, each of which costs a transaction fee.
 */
export const MEMO_AUDIT = { pagesPerPass: 5, readsPerPass: 200, callsPerPass: 20, indexedTrustMs: 24 * 3_600_000, horizonSeconds: 48 * 3_600 };
/** How long an audit that reached the head of the history lets this process send new lines: a pass audits first and posts right after. */
export const AUDIT_FRESH_MS = 15 * 60_000;
/** Rows `runAnchor` builds in one run in memo mode (one per hour after a gap), and rows one retry pass looks at. */
export const MEMO_ROWS_PER_RUN = 8;
const RETRY_ROWS_PER_PASS = 48;
/** Rows of the backlog one retry pass looks at beside those (`retryAnchors`), and where its cursor is kept. */
const BACKLOG_ROWS_PER_PASS = 8;
const RETRY_BACKLOG_CURSOR = "anchor-retry-backlog-cursor";
/** Stable messages: the log lines the operator alerts on. */
export const MEMO_CONFLICT = "anchor.memo_conflict: the anchorer key signed two different roots for one hour";
export const MEMO_LATE = "anchor.memo_late: a root landed later than the lateness bound and is not an anchor";
export const MEMO_AUDIT_BEHIND = "anchor.memo_audit_behind: the audit of the anchorer's history has not caught up";
export const MEMO_AUDIT_FAILED = "anchor.memo_audit_failed: the anchorer's history could not be read; no new root line is sent until it has been read to its head";
export const MEMO_NOT_AUDITED = "anchor.memo_not_audited: a root line is NOT sent, because the audit of the anchorer's history has not reached the head of that history in this pass (after a restore, a root this key already posted for the hour would get a second one)";
export const MEMO_UNEXPECTED_ROTATION = "anchor.memo_unexpected_rotation: the anchorer key signed a hand-over to a key this router does not publish";
export const MEMO_WRONG_KEY = "anchor.memo_wrong_key: this process does not hold the anchorer key published for a root's hour; the root is not posted and is not anchored";
export const MEMO_REFUSED = "anchor.memo_refused: the line on chain for a root does not verify under the published keys; the root is not anchored";
export const MEMO_STUCK = "anchor.memo_stuck: a root that was built is still not final on chain after the lateness bound; it is NOT anchored and is not marked as if it were, and later roots no longer wait for it";
export const MEMO_EARLY_LINE = "anchor.memo_early_line: the anchorer key signed a root line that does not count (for an hour that had not begun, or that the key does not hold); this router did not send it";
/** How long a root in conflict or refused, a stray line, keeps a readiness check or warning up after its hour closed. */
export const ANCHOR_INCIDENT_WINDOW_MS = 48 * 3_600_000;
/** After this long without catching up, the audit of the anchorer's history is "behind". */
export const AUDIT_BEHIND_MS = 2 * 3_600_000;

type MemoAttempt = { signature: string; lastValidBlockHeight: number; at: number };
type MemoPostRecord = { line: string; attempts: MemoAttempt[]; final?: { signature: string; slot: number; blockTime: number | null } };
export type SeenLine = { signature: string; text: string; slot: number; blockTime: number | null };
type SeenRecord = { lines: SeenLine[]; more?: boolean };
type AuditState = { cursor: string | null; walk: { head: string; before: string | null; since: number } | null; indexedAt?: number; /** When an audit last reached the head of the history, and when the first one was tried (R5-20): the age readiness reports. */ completeAt?: number; startedAt?: number };
/**
 * When the audit of the key this process signs with last reached the head of its history IN THIS PROCESS, per database
 * (R5-20). Kept in memory on purpose: what is stored comes back with a restored database, and a restored database is
 * exactly when the stored word cannot be taken for it. `postLine` sends nothing new without a fresh entry here.
 */
const auditedAt = new WeakMap<object, number>();
// What is remembered about lines is kept per anchorer key (R4-13): a key's attempts and the lines it signed say
// nothing about another key's hours. The names without a key are the ones written before that; they are still read
// (`seenLines`, `readPost`), under the rules below, and no longer written.
const memoPostKey = (signer: string, subject: string) => `anchor-memo-post:${signer}:${subject}`;
const seenKey = (signer: string, subject: string) => `anchor-memo-seen:${signer}:${subject}`;
const legacyPostKey = (subject: string) => `anchor-memo-post:${subject}`;
const legacySeenKey = (subject: string) => `anchor-memo-seen:${subject}`;
const auditKey = (anchorer: string) => `anchor-memo-audit:${anchorer}`;
const rotationKey = (anchorer: string) => `anchor-memo-rotation:${anchorer}`;
const misuseKey = (anchorer: string) => `anchor-memo-misuse:${anchorer}`;
const hourOfSubject = (subject: string) => Number(subject.slice(subject.lastIndexOf(":") + 1));
const claimOf = (text: string) => { const m = parseMemo(text); return m && (m.kind === "root" || m.kind === "hostroot") ? m : null; };
const claimIs = (text: string, claim: { root: string; count: number }) => { const m = claimOf(text); return !!m && sameClaim(m, claim); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const genesisOf = new WeakMap<object, string>();
/** The genesis hash of the cluster behind this process's RPC, which must be the one SOLANA_NETWORK names (R3-13). */
async function clusterGenesis(ctx: Ctx): Promise<string> {
  const conn = ctx.chain.connection as unknown as MemoRpc & object;
  const known = genesisOf.get(conn);
  if (known) return known;
  if (!conn.getGenesisHash) throw new Error("anchor.memo_wrong_cluster: the RPC cannot say which cluster it serves");
  const genesis = await conn.getGenesisHash();
  if (!networkNamesGenesis(networkRef(ctx.cfg.chain.network), genesis)) throw new Error(`anchor.memo_wrong_cluster: SOLANA_NETWORK is ${ctx.cfg.chain.network}, but the RPC serves the cluster with genesis hash ${genesis}; nothing is posted`);
  genesisOf.set(conn, genesis);
  return genesis;
}

/** The key published for an hour: the only key whose line for that hour counts. */
const keyForHour = (settings: AnchorSettings, hour: number): string | null => { const at = anchorerIndexAt(settings.anchorers, hour); return at < 0 ? null : settings.anchorers[at]!.key; };
/** The keypair this process holds for `key`, or null. It holds one (ANCHORER_PRIVATE_KEY): a second key beside it, for the hours of a key that is being retired, needs a setting that does not exist. */
function heldSigner(ctx: Ctx, key: string): Keypair | null {
  try {
    const kp = ctx.chain.wallet("anchorer").keypair;
    return kp.publicKey.toBase58() === key ? kp : null;
  } catch {
    return null;
  }
}
/** What a line on record is worth under the verifiers' rules (`lineStanding`), for the key that signed it. */
const standingOf = (settings: AnchorSettings, signer: string, l: SeenLine): LineStanding => {
  const c = claimOf(l.text);
  return c ? lineStanding({ hour: c.hour, landed: l.blockTime, signer, anchorers: settings.anchorers, maxLateSeconds: settings.maxLateSeconds }) : "wrong_key";
};
/** Every line on record that `signer` signed for `subject`, in slot order: that key's record, and what was stored before records were kept per key. */
async function seenLines(ctx: Ctx, signer: string, subject: string): Promise<SeenLine[]> {
  const all = [...((await getKv<SeenRecord>(ctx, seenKey(signer, subject)))?.lines ?? [])];
  for (const l of (await getKv<SeenRecord>(ctx, legacySeenKey(subject)))?.lines ?? []) if (!all.some((x) => x.signature === l.signature && x.text === l.text)) all.push(l);
  return all.sort((x, y) => x.slot - y.slot);
}
/** The post record of `signer` for `subject`. One written before records were kept per key does not say which key signed its attempts, so nothing in it is final until it has been read from the chain again. */
async function readPost(ctx: Ctx, signer: string, subject: string): Promise<MemoPostRecord | null> {
  const own = await getKv<MemoPostRecord>(ctx, memoPostKey(signer, subject));
  if (own) return own;
  const legacy = await getKv<MemoPostRecord>(ctx, legacyPostKey(subject));
  return legacy ? { line: legacy.line, attempts: legacy.attempts } : null;
}

/**
 * Remember a line `signer` signed (read from its own finalized transaction): every memo line of a transaction, not one
 * per signature (R4-10). Only lines that COUNT under the verifiers' rules can be the root of their hour or a conflict
 * with it (R4-13); a line this router did not send that cannot count (for an hour that had not begun, or one the key
 * does not hold) is evidence that the key is in other hands, and alarms. Two different claims among the lines that
 * count are an incident.
 */
async function recordSeen(ctx: Ctx, signer: string, line: SeenLine, claim: RootMemo | HostRootMemo): Promise<void> {
  const subject = subjectKey(subjectOf(claim));
  const rec = (await getKv<SeenRecord>(ctx, seenKey(signer, subject))) ?? { lines: [] };
  if (rec.lines.some((l) => l.signature === line.signature && l.text === line.text)) return;
  rec.lines.push(line);
  rec.lines.sort((x, y) => x.slot - y.slot);
  if (rec.lines.length > 16) { rec.lines.length = 16; rec.more = true; }
  await setKv(ctx, seenKey(signer, subject), rec);
  const settings = anchorSettings(ctx);
  const standing = standingOf(settings, signer, line);
  if (standing === "early" || standing === "wrong_key" || standing === "retired") {
    if ((await readPost(ctx, signer, subject))?.attempts.some((a) => a.signature === line.signature)) return;
    log.error(MEMO_EARLY_LINE, { subject, transaction: line.signature, standing, hour: claim.hour, landed: line.blockTime, signer });
    await setKv(ctx, misuseKey(signer), { transaction: line.signature, subject, standing, at: Date.now() });
    return;
  }
  if (standing !== "counts") return; // late, or without a block time: not a root, and not a conflict with one
  const lines = (await seenLines(ctx, signer, subject)).filter((l) => standingOf(settings, signer, l) === "counts");
  const first = claimOf(lines[0]!.text)!;
  const other = lines.find((l) => !claimIs(l.text, first));
  if (!other) return;
  log.error(MEMO_CONFLICT, { subject, first: lines[0]!.signature, existing: other.signature });
  // The earliest transaction decides. When it carries two different roots itself (or two transactions share its slot),
  // no root is the root of the hour.
  const undecided = lines.some((l) => l.slot === lines[0]!.slot && !claimIs(l.text, first));
  const stands = (row: { root: string; count: number }) => !undecided && claimIs(lines[0]!.text, { root: row.root.replace(/^0x/, "").toLowerCase(), count: row.count });
  // A root of ours that was marked anchored before an EARLIER line of the anchorer with another root came to light is
  // not the root of its hour: the row goes to "conflict" (and is looked at, and alarmed, on every pass from then on).
  const closes = new Date((claim.hour + SECONDS_PER_HOUR) * 1000);
  if (claim.kind === "root") {
    for (const row of await ctx.db.select().from(anchors).where(and(eq(anchors.toTs, closes), inArray(anchors.status, ["confirmed", "late"])))) {
      if (stands(row)) continue;
      await ctx.db.update(anchors).set({ status: "conflict", txHash: null }).where(eq(anchors.index, row.index));
      log.error(MEMO_CONFLICT, { index: row.index, hour: claim.hour, existing: lines[0]!.signature, note: "an earlier line of the anchorer for this hour was found after this root was posted; the row is no longer anchored" });
    }
  } else {
    const from = new Date(claim.hour * 1000);
    for (const row of await ctx.db.select().from(hostAnchors).where(and(inArray(hostAnchors.status, ["confirmed", "late"]), gt(hostAnchors.toTs, from), lte(hostAnchors.toTs, closes)))) {
      if (idHash(row.providerId).replace(/^0x/, "").toLowerCase() !== claim.providerIdHash || anchorHour(row) !== claim.hour) continue;
      if (stands(row)) continue;
      await ctx.db.update(hostAnchors).set({ status: "conflict", txHash: null }).where(eq(hostAnchors.id, row.id));
      log.error(MEMO_CONFLICT, { host_root: row.id, provider: row.providerId, hour: claim.hour, existing: lines[0]!.signature, note: "an earlier line of the anchorer for this host and hour was found after this root was posted; the row is no longer anchored" });
    }
  }
}

/** Whether a row of this router names a transaction: a root was posted before, so the posting key has a history. */
async function postedBefore(ctx: Ctx): Promise<boolean> {
  const [[a], [h]] = await Promise.all([
    ctx.db.select({ i: anchors.index }).from(anchors).where(isNotNull(anchors.txHash)).limit(1),
    ctx.db.select({ i: hostAnchors.id }).from(hostAnchors).where(isNotNull(hostAnchors.txHash)).limit(1),
  ]);
  return !!a || !!h;
}

/**
 * Read a bounded part of the anchorer's finalized history and remember every root line the anchorer itself signed.
 * A cursor in the key-value store marks how far the history has been read; a pass takes at most a few pages and reads
 * at most a few hundred transactions, so a flood of transactions naming the anchorer costs passes, not availability
 * (and `anchor.memo_audit_behind` at error level once a walk has been running for two hours).
 * The signature list's memo text only picks which transactions to read (and only while the node is known to list memo
 * text at all); what counts is the transaction itself. A candidate the node lists and does not serve stops the pass
 * where it is (R4-28): the cursor never moves over a transaction that was not read.
 */
export async function auditAnchorerHistory(ctx: Ctx, o: { pages?: number; reads?: number } = {}): Promise<{ caughtUp: boolean; pages: number; reads: number; found: number }> {
  const anchorer = ctx.chain.wallet("anchorer").keypair.publicKey;
  const key = anchorer.toBase58();
  const rpc = ctx.chain.connection as unknown as MemoRpc;
  // Until this call has reached the head, nothing new is sent on the word of an earlier one (R5-20).
  auditedAt.delete(ctx.db as object);
  const st: AuditState = (await getKv<AuditState>(ctx, auditKey(key))) ?? { cursor: null, walk: null };
  st.startedAt ??= Date.now();
  const maxPages = o.pages ?? MEMO_AUDIT.pagesPerPass, maxReads = o.reads ?? MEMO_AUDIT.readsPerPass;
  let pages = 0, reads = 0, found = 0, caughtUp = false;
  // A walk that began in an earlier call has its head from then (and after a restore, from before the backup). Its end
  // says nothing about what landed since: when it ends, this call goes on from the present head, and only a walk that
  // began in this call reaches the head (R5-20).
  let resumed = !!st.walk, emptyFromHead = false;
  const save = () => setKv(ctx, auditKey(key), st);
  try {
    const genesis = await clusterGenesis(ctx);
    const known = new Set(anchorSettings(ctx).anchorers.map((k) => k.key));
    scan: while (pages < maxPages) {
      const fromHead = !st.walk;
      const batch = await rpc.getSignaturesForAddress(anchorer, { limit: 1000, ...(st.walk?.before ? { before: st.walk.before } : {}), ...(st.cursor ? { until: st.cursor } : {}) }, "finalized");
      if (!Array.isArray(batch)) throw new Error("the RPC did not return a signature list");
      pages++;
      if (batch.length && !st.walk) st.walk = { head: batch[0]!.signature, before: null, since: Date.now() };
      if (batch.some((s) => typeof s.memo === "string")) st.indexedAt = Date.now();
      const indexed = st.indexedAt !== undefined && Date.now() - st.indexedAt < MEMO_AUDIT.indexedTrustMs;
      for (const s of batch) {
        // History from long before this walk began is not read: a line that old could only be late, which is no
        // anchor, so it changes nothing the router does. (A first audit of a key with years of lines ends here.)
        if (s.blockTime != null && s.blockTime < Math.floor(st.walk!.since / 1000) - MEMO_AUDIT.horizonSeconds) {
          st.cursor = st.walk!.head;
          st.walk = null;
          if (resumed) { resumed = false; continue scan; }
          caughtUp = true;
          break scan;
        }
        const hints = memoHints(s.memo).map(parseMemo).filter((m) => m && m.kind !== "signer");
        const read = !s.err && (typeof s.memo === "string" ? hints.length > 0 : !indexed);
        if (read) {
          if (reads >= maxReads) break scan;
          reads++;
          const r = await readSignedTransaction(rpc, s.signature, "finalized");
          if (!r.ok && (r.unavailable || r.notServed)) break scan;
          for (const m of r.ok ? r.tx.memos : []) {
            if (!m.signers.includes(key)) continue; // anyone can write the text; only the anchorer's signature makes it a line
            const claim = parseMemo(m.text);
            if (!claim || !networkNamesGenesis(claim.network, genesis)) continue;
            if (claim.kind === "root" || claim.kind === "hostroot") { found++; await recordSeen(ctx, key, { signature: s.signature, text: m.text, slot: r.ok ? r.tx.slot : s.slot, blockTime: r.ok ? r.tx.blockTime : null }, claim); }
            else if (claim.kind === "anchorer" && !known.has(claim.newAnchorer)) {
              log.error(MEMO_UNEXPECTED_ROTATION, { transaction: s.signature, to: claim.newAnchorer, from_hour: claim.fromHour });
              await setKv(ctx, rotationKey(key), { transaction: s.signature, to: claim.newAnchorer, from_hour: claim.fromHour, at: Date.now() });
            }
          }
        }
        st.walk!.before = s.signature;
      }
      if (batch.length < 1000) {
        // Reached the cursor (or the start of the history): everything up to the head of this walk has been read.
        if (st.walk) st.cursor = st.walk.head;
        st.walk = null;
        if (resumed) { resumed = false; continue; }
        emptyFromHead = fromHead && batch.length === 0;
        caughtUp = true;
        break;
      }
    }
    // A list with nothing new in it reached the head only if the head IS where the last audit stopped (R5-20). And an
    // empty answer for a key that has a history (an audit stopped somewhere before, or a row of this router names a
    // transaction) is a node that does not list this key, not an audit: after a restore it would hide every root
    // posted since the backup.
    if (caughtUp && emptyFromHead) {
      const head = await rpc.getSignaturesForAddress(anchorer, { limit: 1 }, "finalized");
      const newest = Array.isArray(head) ? head[0]?.signature ?? null : null;
      if (newest && st.cursor && newest !== st.cursor) throw new Error("the signature list shows nothing newer than the last audit, and its newest entry is not where that audit stopped");
      if (!newest && (st.cursor || (await postedBefore(ctx)))) throw new Error("the signature list of the anchorer key is empty, and this router has posted with a key before");
    }
    if (caughtUp) st.completeAt = Date.now();
  } finally {
    await save();
  }
  if (caughtUp) auditedAt.set(ctx.db as object, Date.now());
  if (!caughtUp && st.walk && Date.now() - st.walk.since > AUDIT_BEHIND_MS) log.error(MEMO_AUDIT_BEHIND, { anchorer: key, since: new Date(st.walk.since).toISOString() });
  return { caughtUp, pages, reads, found };
}
/**
 * The lines that COUNT for a subject ("root:<hour>", "hostroot:<provider id hash>:<hour>"): signed by the key published
 * for its hour, landed no earlier than the hour and inside the lateness bound, before that key was retired; final on
 * chain, earliest first, as far as they have been read.
 */
export async function anchorerLines(ctx: Ctx, subject: string): Promise<SeenLine[]> {
  const settings = anchorSettings(ctx);
  const signer = keyForHour(settings, hourOfSubject(subject));
  return signer ? (await seenLines(ctx, signer, subject)).filter((l) => standingOf(settings, signer, l) === "counts") : [];
}
/**
 * The audit as a pass runs it before it posts. It does not throw, and it is not silent (R5-20): a history that cannot
 * be read is an error in the log, no new line is sent in this pass (`postLine`), and the age of the last complete
 * audit shows in readiness (`anchorHealth`). While a call ends only because its budget ran out, the next one goes on
 * where it stopped, `MEMO_AUDIT.callsPerPass` times at most: transactions that merely name the key cost reads, and
 * they stop anchoring only when there are more of them than a pass reads.
 */
export const auditQuietly = async (ctx: Ctx): Promise<Awaited<ReturnType<typeof auditAnchorerHistory>> | null> => {
  try {
    let r = await auditAnchorerHistory(ctx);
    for (let i = 1; i < MEMO_AUDIT.callsPerPass && !r.caughtUp && (r.reads >= MEMO_AUDIT.readsPerPass || r.pages >= MEMO_AUDIT.pagesPerPass); i++) r = await auditAnchorerHistory(ctx);
    if (!r.caughtUp) log.error(MEMO_NOT_AUDITED, { pages: r.pages, reads: r.reads });
    return r;
  } catch (e) {
    log.error(MEMO_AUDIT_FAILED, { error: (e as Error).message.slice(0, 160) });
    return null;
  }
};

/**
 * What readiness reports about anchoring (R4-27): rows in conflict, rows no verifier accepts (late, unverifiable), each
 * for `ANCHOR_INCIDENT_WINDOW_MS` after their hour closed; an audit that has not caught up; a hand-over the anchorer
 * key signed to a key this router does not publish; a line of that key that this router did not send and that cannot
 * count. The last three are read from what the anchor worker stored, so an API process without the key sees them too.
 */
export async function anchorHealth(ctx: Ctx): Promise<{ conflicts: number; refused: number; auditBehind: boolean; /** Memo mode: how long ago an audit last reached the head of the key's history (or the first one was tried); null when none was. */ auditAgeMs: number | null; unexpectedRotation: boolean; keyMisuse: boolean }> {
  const since = new Date(Date.now() - ANCHOR_INCIDENT_WINDOW_MS);
  const count = async (statuses: string[]) => {
    const [[a], [h]] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(anchors).where(and(inArray(anchors.status, statuses), gt(anchors.toTs, since))),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(hostAnchors).where(and(inArray(hostAnchors.status, statuses), gt(hostAnchors.toTs, since))),
    ]);
    return (a?.n ?? 0) + (h?.n ?? 0);
  };
  const settings = anchorSettings(ctx);
  const current = settings.anchorer;
  const [conflicts, refused, audit, rotation, misuse] = await Promise.all([
    count(["conflict"]), count(["late", "unverifiable"]),
    current ? getKv<AuditState>(ctx, auditKey(current)) : null,
    current ? getKv<{ to: string; at: number }>(ctx, rotationKey(current)) : null,
    current ? getKv<{ at: number }>(ctx, misuseKey(current)) : null,
  ]);
  // R5-20: the age of the last complete audit. A walk in progress is not needed for it, so a list call that fails
  // every time raises it too. (A record from before these fields were written says nothing until the next audit.)
  const auditedLast = settings.mode === "memo" ? audit?.completeAt ?? audit?.startedAt ?? null : null;
  const auditAgeMs = auditedLast === null ? null : Math.max(0, Date.now() - auditedLast);
  // The job audits once per run, so an age below two of its intervals is not an alarm where the interval is a long one.
  const ageBound = Math.max(AUDIT_BEHIND_MS, 2 * (ctx.cfg.receipts?.anchorIntervalMs ?? 0));
  return {
    conflicts, refused, auditAgeMs,
    auditBehind: (!!audit?.walk && Date.now() - audit.walk.since > AUDIT_BEHIND_MS) || (auditAgeMs ?? 0) > ageBound,
    // Until the router publishes that key (a planned rotation whose settings arrive), or the key that signed is rotated away.
    unexpectedRotation: !!rotation && !settings.anchorers.some((k) => k.key === rotation.to),
    keyMisuse: !!misuse && Date.now() - misuse.at < ANCHOR_INCIDENT_WINDOW_MS,
  };
}

export type MemoPostOutcome =
  /** A line with this claim, signed by the anchorer, is final on chain, verifies, and is the earliest for its subject. */
  | { state: "final"; hash: string; slot: number; blockTime: number | null; line: string; conflicts: string[] }
  /** Sent and not final yet: look again on the next pass. */
  | { state: "sent"; hash: string }
  /** The anchorer's earliest line for the subject carries another root or count: nothing is sent. */
  | { state: "conflict"; existing: string };
type LineOutcome =
  | MemoPostOutcome
  /** No line that counts can be signed here: this process does not hold the key published for the subject's hour. Nothing is sent. */
  | { state: "unsigned"; key: string; reason: string }
  /** A line is final on chain and the verifier refuses it under the published keys. */
  | { state: "refused"; hash: string; reason: string };

/**
 * Post one root line, once (R3-12), signed by the key published for its hour (R4-12). The subject (an hour, or a host
 * and hour) is read from the line. The transaction is signed here and its signature stored BEFORE it is sent, so its
 * fate is later read by signature at finalized commitment, whatever the RPC answered to the send and whatever else
 * names the anchorer in the meantime. A second transaction is only sent when every earlier attempt is known dead
 * (failed, or unknown to the cluster after the quiet period). Nothing is "final" before `verifyMemoLine` has accepted
 * the line under the published keys: what a verifier would refuse is never reported as anchored. Throws when the
 * cluster could not be reached or an attempt may still land.
 */
async function postLine(ctx: Ctx, wanted: string): Promise<LineOutcome> {
  const claim = claimOf(wanted);
  if (!claim) throw new RangeError("not a root line");
  await clusterGenesis(ctx);
  const settings = anchorSettings(ctx);
  const signer = keyForHour(settings, claim.hour);
  if (!signer) throw new Error("no anchorer key is published for the hour of this line");
  const kp = heldSigner(ctx, signer);
  const subject = subjectKey(subjectOf(claim));
  const conn = ctx.chain.connection;
  const rpc = conn as unknown as MemoRpc;
  let post = await readPost(ctx, signer, subject);
  // One text per subject from this router: an earlier attempt's line stands (a retry must never carry another link).
  let line = wanted;
  const finalOf = async (signature: string, text: string) => {
    const r = await readSignedTransaction(rpc, signature, "finalized");
    if (!r.ok) return r.failedOnChain ? ("failed" as const) : null;
    return r.tx.memos.some((m) => m.text === text && m.signers.includes(signer)) ? { signature, slot: r.tx.slot, blockTime: r.tx.blockTime } : ("failed" as const);
  };
  if (post && !post.final) {
    for (const at of [...post.attempts].reverse()) {
      const f = await finalOf(at.signature, post.line);
      if (f && f !== "failed") { post.final = f; await setKv(ctx, memoPostKey(signer, subject), post); break; }
    }
  }
  if (post?.final) await recordSeen(ctx, signer, { ...post.final, text: post.line }, claimOf(post.line)!);
  /** What the chain holds for the subject, as far as it has been read: an outcome, or null when a line is still to be sent. */
  const settle = async (): Promise<LineOutcome | null> => {
    const counting = (await seenLines(ctx, signer, subject)).filter((l) => standingOf(settings, signer, l) === "counts");
    let refusal: { hash: string; reason: string } | null = null;
    if (counting.length) {
      // The earliest transaction decides, with every line in it (R4-10); a different root in the same slot is no later.
      const other = counting.find((l) => l.slot === counting[0]!.slot && !claimIs(l.text, claim));
      if (other) return { state: "conflict", existing: other.signature };
      const conflicts = counting.filter((l) => !claimIs(l.text, claim)).map((l) => l.signature);
      // The published key list must itself verify on this RPC before anything is judged by it. When it does not (a
      // rotation transaction the node no longer serves, a wrong ANCHORER_KEYS), nothing is refused on that ground: the
      // row waits, is retried, and /ready shows it pending.
      const at = anchorerIndexAt(settings.anchorers, claim.hour);
      const broken = at > 0 ? await verifyAnchorerChain(rpc, ctx.cfg.chain.network, settings.anchorers, at) : null;
      if (broken) throw new Error(`anchor.memo_key_chain: the published anchorer keys do not verify on this RPC (${broken}); the line for ${subject} is not marked anchored until they do`);
      for (const l of counting.filter((x) => claimIs(x.text, claim))) {
        // The history of the key this process signs with is audited pass by pass; another key's is walked here, for this hour.
        const v = await verifyMemoLine(rpc, { signature: l.signature, network: ctx.cfg.chain.network, line: l.text, anchorers: settings.anchorers, maxLateSeconds: settings.maxLateSeconds, v2FromHour: settings.memoV2FromHour, skipHistory: !!kp });
        if (v.status === "unknown") throw new Error(`the line on chain for ${subject} could not be verified yet: ${v.reason}`);
        if (v.ok) return { state: "final", hash: l.signature, slot: l.slot, blockTime: l.blockTime, line: l.text, conflicts };
        refusal ??= { hash: l.signature, reason: v.reason ?? "the line does not verify" };
        // Our own line, refused: there is nothing further to send for this subject.
        if (post?.final?.signature === l.signature) return { state: "refused", hash: l.signature, reason: v.reason ?? "the line does not verify" };
      }
    }
    if (post?.final) {
      const standing = standingOf(settings, signer, { ...post.final, text: post.line });
      // Late: the caller marks the row (it compares the block time with the bound). Anything else is not an anchor.
      if (standing === "late") return { state: "final", hash: post.final.signature, slot: post.final.slot, blockTime: post.final.blockTime, line: post.line, conflicts: [] };
      if (standing === "untimed") throw new Error(`the RPC gave no block time for the line of ${subject}; it is read again on the next pass`);
      return { state: "refused", hash: post.final.signature, reason: `this router's line does not count (${standing})` };
    }
    // Copies of the root that do not verify (another form of the line) and no key to sign a line that would.
    if (refusal && !kp) return { state: "refused", ...refusal };
    return null;
  };
  const settled = await settle();
  if (settled) return settled;
  if (post) {
    // Nothing final. Is an attempt still alive?
    const last = post.attempts[post.attempts.length - 1];
    if (last) {
      const status = (await conn.getSignatureStatuses([last.signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err) return { state: "sent", hash: last.signature };
      if (!status && Date.now() - last.at < memoTiming.retryQuietMs) throw new Error("an earlier attempt for this line may still land; not sending a second one yet");
    }
    if (claimIs(post.line, claim)) line = post.line;
  }
  // A line is to be sent, and only the key published for its hour makes it one (R4-12): never the key at hand instead.
  if (!kp) return { state: "unsigned", key: signer, reason: `the anchorer key published for hour ${claim.hour} is ${signer}, and this process signs with another key` };
  // And only when this process has just read that key's history to its head (R5-20): what it found there is what
  // `settle` judged by, and without it a root this key posted before a restore would get a second one. Nothing is
  // sent otherwise; the row stays pending, and the next pass audits again and goes on by itself.
  const audited = auditedAt.get(ctx.db as object);
  if (audited === undefined || Date.now() - audited > AUDIT_FRESH_MS || Date.now() < audited) throw new Error(`${MEMO_NOT_AUDITED} (${subject})`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(ctx.chain.commitment);
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(memoIx(line, [kp.publicKey]));
  tx.sign(kp);
  const signature = base58Encode(new Uint8Array(tx.signature!));
  post = { line, attempts: [...(post && post.line === line ? post.attempts : []).slice(-7), { signature, lastValidBlockHeight, at: Date.now() }] };
  await setKv(ctx, memoPostKey(signer, subject), post);
  let sendError: Error | null = null;
  try {
    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: ctx.chain.commitment, maxRetries: 3 });
  } catch (e) {
    sendError = e as Error; // the transaction may have landed all the same: its signature tells
  }
  const deadline = Date.now() + memoTiming.finalityWaitMs;
  for (;;) {
    const f = await finalOf(signature, line).catch(() => null);
    if (f && f !== "failed") {
      post.final = f;
      await setKv(ctx, memoPostKey(signer, subject), post);
      await recordSeen(ctx, signer, { ...f, text: line }, claimOf(line)!);
      const now = await settle();
      if (now) return now;
      break;
    }
    // A send the RPC refused is looked up once (it may have landed all the same) and then left to the next pass.
    if (f === "failed" || sendError || Date.now() >= deadline) break;
    await sleep(memoTiming.finalityPollMs);
  }
  if (sendError) throw new Error(`the memo transaction could not be sent: ${sendError.message.slice(0, 160)}`);
  return { state: "sent", hash: signature };
}

/**
 * `postLine` for callers that know three outcomes (the host roots of src/services/host-anchor.ts): a line that cannot
 * be signed with the key of its hour, or that the verifier refuses, is an error there, so the row is not marked
 * anchored and is looked at again.
 */
export async function postMemoLine(ctx: Ctx, wanted: string): Promise<MemoPostOutcome> {
  const r = await postLine(ctx, wanted);
  if (r.state === "unsigned") { log.error(MEMO_WRONG_KEY, { line: wanted, key: r.key }); throw new Error(`anchor.memo_wrong_key: ${r.reason}`); }
  if (r.state === "refused") { log.error(MEMO_REFUSED, { line: wanted, transaction: r.hash, reason: r.reason }); throw new Error(`anchor.memo_refused: ${r.reason}`); }
  return r;
}

class WaitForEarlierRoot extends Error {}

/**
 * The transaction of a still-pending row's line that IS on chain, or null when none of its attempts landed. Asked by
 * signature status (`searchTransactionHistory`), which a node answers also for a transaction it does not serve. An
 * attempt that landed and is not final yet is waited for.
 */
async function landedAttempt(ctx: Ctx, settings: AnchorSettings, p: typeof anchors.$inferSelect): Promise<string | null> {
  const hour = anchorHour(p);
  const signer = keyForHour(settings, hour);
  const attempts = (signer ? await readPost(ctx, signer, `root:${hour}`) : null)?.attempts ?? [];
  if (!attempts.length) return null;
  const statuses = (await ctx.chain.connection.getSignatureStatuses(attempts.map((a) => a.signature), { searchTransactionHistory: true })).value;
  let first: { signature: string; slot: number } | null = null;
  for (let i = 0; i < attempts.length; i++) {
    const s = statuses[i];
    if (!s || s.err) continue;
    if (s.confirmationStatus !== "finalized" && !(s.confirmationStatus === undefined && s.confirmations === null)) throw new WaitForEarlierRoot(`a line of anchor ${p.index} landed and is not final yet; this one links to it`);
    if (!first || s.slot < first.slot) first = { signature: attempts[i]!.signature, slot: s.slot };
  }
  return first?.signature ?? null;
}

type PostedStatus = "confirmed" | "local" | "pending" | "late" | "conflict" | "unverifiable";
/** Post one built anchor in the configured mode. Throws when it could not be sent (the row stays pending and is retried). */
async function postAnchor(ctx: Ctx, a: { index: number; root: string; fromTs: Date; toTs: Date; count: number }): Promise<{ status: PostedStatus; hash: string | null }> {
  const settings = anchorSettings(ctx);
  const anchorer = ctx.chain.roleAddress("anchorer")!;
  const toSec = Math.floor(a.toTs.getTime() / 1000);
  if (settings.mode === "program") {
    const r = await ctx.chain.anchor(a.root as Hex, Math.floor(a.fromTs.getTime() / 1000), toSec, a.count, a.index);
    await setKv(ctx, postKey(a.index), { mode: "program", anchorer, program: ctx.chain.address("receiptAnchor") ?? null } satisfies AnchorPost);
    return { status: "confirmed", hash: r.hash };
  }
  const hour = receiptRootHour(toSec);
  const network = ctx.cfg.chain.network;
  let line = rootMemo({ network, hour, count: a.count, root: a.root });
  if (hour >= settings.memoV2FromHour) {
    // The link names the ACTUAL previous root, as a verifier will find it (R4-28): the line of the newest earlier hour
    // that has one on chain. That is the transaction of the newest earlier row of ours that was posted, or, where an
    // earlier hour went to another root of the anchorer key (a row in conflict), that root's transaction. An earlier
    // row whose line is still in flight is waited for (its signature is not final yet); a row that never got a line
    // is passed over.
    let prev: string | null = null;
    let found = false;
    let chainNow: number | null = null;
    const earlier = await ctx.db.select().from(anchors).where(lt(anchors.index, a.index)).orderBy(desc(anchors.index)).limit(64);
    for (const p of earlier) {
      if ((p.status === "confirmed" || p.status === "late") && p.txHash) {
        if ((await anchorPost(ctx, p.index))?.mode === "memo") prev = p.txHash;
        found = true;
        break;
      }
      if (p.status === "conflict") {
        const [taken] = await anchorerLines(ctx, `root:${anchorHour(p)}`);
        if (taken) { prev = taken.signature; found = true; break; }
      }
      if (p.status !== "pending") continue;
      // Waiting ends when the earlier root could only be late any more: a row that never lands holds nothing back for
      // ever. Lateness is a matter of BLOCK time, so the wait is measured in chain time (R5-22): a router clock that runs
      // ahead must not end it early and let this line link past a root that then lands. No chain time, no line: the
      // error leaves this row pending.
      chainNow ??= await ctx.chain.blockTimestamp();
      if (chainNow - Math.floor(p.toTs.getTime() / 1000) <= settings.maxLateSeconds) throw new WaitForEarlierRoot(`the root of anchor ${p.index} is not final yet; this one links to it`);
      // Past the bound the row is passed over ONLY when no line of it is on chain (R5-18). A line of it that landed and
      // that this RPC does not serve (so the row could not be marked) is still the previous root for every verifier:
      // the link names it, or it would skip a root that counts.
      const landed = await landedAttempt(ctx, settings, p);
      if (landed) { prev = landed; found = true; break; }
    }
    if (!found && earlier.length === 64) {
      // Further back than the rows looked at: `0` is written only when no earlier root of ours is on chain at all.
      const [older] = await ctx.db.select().from(anchors).where(and(lt(anchors.index, earlier[63]!.index), inArray(anchors.status, ["confirmed", "late"]), isNotNull(anchors.txHash))).orderBy(desc(anchors.index)).limit(1);
      if (older && (await anchorPost(ctx, older.index))?.mode === "memo") prev = older.txHash;
    }
    line = rootMemoV2({ network, hour, count: a.count, root: a.root, prev });
  }
  const r = await postLine(ctx, line);
  if (r.state === "conflict") {
    // Never post over it: the earliest line for an hour is the root, and a second one would only be evidence against us.
    log.error(MEMO_CONFLICT, { index: a.index, hour, existing: r.existing, note: "this root is kept and NOT posted; the row stays in conflict" });
    return { status: "conflict", hash: null };
  }
  if (r.state === "sent") return { status: "pending", hash: null };
  if (r.state === "unsigned") {
    // The hour belongs to another key than the one this process signs with (the worker was given the new key before
    // the old key's last hour was on chain, or the reverse). A line signed with the key at hand would be refused by
    // every verifier for good, so none is sent, and the row says what it is. Its receipts join the next root.
    log.error(MEMO_WRONG_KEY, { index: a.index, hour, published: r.key, held: anchorer, note: "the root is NOT posted: only the key published for an hour can sign its line. The receipts of this row are rooted with the next one" });
    return { status: "unverifiable", hash: null };
  }
  if (r.state === "refused") {
    log.error(MEMO_REFUSED, { index: a.index, hour, transaction: r.hash, reason: r.reason, note: "the row is NOT anchored. The receipts of this row are rooted with the next one" });
    return { status: "unverifiable", hash: null };
  }
  // The key that signed is the one published for the hour, which is what a proof names.
  await setKv(ctx, postKey(a.index), { mode: "memo", anchorer: keyForHour(settings, hour) ?? anchorer, memo: r.line } satisfies AnchorPost);
  if (r.conflicts.length) log.error(MEMO_CONFLICT, { index: a.index, hour, existing: r.conflicts[0], note: "this router's line is the earliest; the anchorer key also signed another root for the hour later" });
  if (r.blockTime == null || r.blockTime > hour + SECONDS_PER_HOUR + settings.maxLateSeconds) {
    log.error(MEMO_LATE, { index: a.index, hour, landed: r.blockTime, bound_seconds: settings.maxLateSeconds, transaction: r.hash, note: "the receipts of this row are rooted with the next one" });
    return { status: "late", hash: r.hash };
  }
  return { status: "confirmed", hash: r.hash };
}

/**
 * The receipts of rows whose root is not an anchor and never will be ("late": the line landed after the bound;
 * "unverifiable": no line a verifier accepts) are let go, so that the row built next takes them (R4-28): batches are
 * formed by identity, not by time, and the next root is one hour away. The row itself stays as the record of what
 * happened, with its root, count and transaction. Nothing is released from a row in conflict: there the anchorer key
 * signed another root for the hour, which is an incident for an operator, not something to root around.
 */
async function releaseUnanchored(ctx: Ctx): Promise<number> {
  const stuck = ctx.db.select({ index: anchors.index }).from(anchors).where(inArray(anchors.status, ["late", "unverifiable"]));
  const moved = await ctx.db.update(generations).set({ anchorIndex: null, leafIndex: null, leafIndexV2: null }).where(inArray(generations.anchorIndex, stuck)).returning({ id: generations.id });
  const settled = await ctx.db.update(facilitatorSettlements).set({ anchorIndex: null, leafIndex: null }).where(inArray(facilitatorSettlements.anchorIndex, stuck)).returning({ id: facilitatorSettlements.id });
  const n = moved.length + settled.length;
  if (n) log.warn("anchor.rerooted: receipts of a root that is not an anchor join the next root", { receipts: n });
  return n;
}

const finality = (ctx: Ctx) => (ctx.chain.commitment === "finalized" ? "finalized" : "confirmed");
const ceilHour = (sec: number) => Math.ceil(sec / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

export async function runAnchor(ctx: Ctx, upTo?: Date) {
  // Close only whole seconds, so the exclusive endpoint is never in the future.
  // Late-completing receipts join the next batch by identity, not by timestamp membership.
  const chainConfigured = anchorPostingConfigured(ctx);
  const settings = anchorSettings(ctx);
  const memo = chainConfigured && settings.mode === "memo";
  if (memo) await auditQuietly(ctx);
  const closedSecond = Math.floor(Date.now() / 1000);
  // On chain there is one root per hour (an account or a memo line), so a posted batch closes on an hour boundary (the last whole hour).
  const target = chainConfigured ? Math.floor(Math.min(closedSecond, await ctx.chain.blockTimestamp()) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR : closedSecond;
  let result: Awaited<ReturnType<typeof buildAnchor>> = null;
  let rows = 0;
  for (let step = 0; step < (memo ? MEMO_ROWS_PER_RUN : 1); step++) {
    const [last] = await ctx.db.select().from(anchors).orderBy(desc(anchors.index)).limit(1);
    if (last && last.toTs.getTime() >= target * 1000) break;
    // Memo mode: one row per hour, so every hour gets its own line, also an empty one. Hours older than the lateness
    // bound could only get a late line, which is no anchor: they are closed together in the first row, and that row
    // closes on the oldest hour whose line still lands in time (R4-28: a row closing a full bound ago was late by
    // construction, and so were all the receipts in it). "In time" leaves this hour's passes to land it.
    let toSec = target;
    if (memo && last) toSec = Math.min(target, Math.max(ceilHour(Math.floor(last.toTs.getTime() / 1000) + 1), ceilHour(target + SECONDS_PER_HOUR - settings.maxLateSeconds)));
    const built = await buildAnchor(ctx, last, new Date(toSec * 1000), upTo, chainConfigured, memo);
    if (!built) break;
    result = built;
    rows++;
  }
  return result ? { ...result, rows } : { anchored: 0 };
}

/** Build one anchor row closing at `toTs` and post it. Null when there is nothing to root (never in memo mode). */
async function buildAnchor(ctx: Ctx, last: typeof anchors.$inferSelect | undefined, toTs: Date, upTo: Date | undefined, chainConfigured: boolean, memo: boolean) {
  if (memo) await releaseUnanchored(ctx);
  const pending = await ctx.db
    .select({ id: generations.id, leaf: generations.receiptLeaf, leafV2: generations.receiptLeafV2, ts: generations.ts })
    .from(generations)
    .where(and(isNull(generations.anchorIndex), lt(generations.ts, toTs), ...(upTo ? [lte(generations.ts, upTo)] : []), sql`${generations.receiptLeaf} IS NOT NULL`))
    .orderBy(asc(generations.ts), asc(generations.id))
    .limit(200_000);
  // v6 F: facilitator settlement receipts (kind facilitator.settle) join the same root, after the generations.
  const settled = await ctx.db
    .select({ id: facilitatorSettlements.id, leaf: facilitatorSettlements.receiptLeaf, ts: facilitatorSettlements.settledAt })
    .from(facilitatorSettlements)
    .where(and(isNull(facilitatorSettlements.anchorIndex), lt(facilitatorSettlements.settledAt, toTs), ...(upTo ? [lte(facilitatorSettlements.settledAt, upTo)] : []), sql`${facilitatorSettlements.receiptLeaf} IS NOT NULL`))
    .orderBy(asc(facilitatorSettlements.settledAt), asc(facilitatorSettlements.id))
    .limit(200_000);
  const empty = !pending.length && !settled.length;
  // An hour without receipts posts nothing in program mode; in memo mode it gets a count-0 line (R3-14).
  if (empty && !memo) return null;
  const index = last ? last.index + 1 : 0;
  // Leaves in receipt order; a receipt with a v2 encoding contributes its v1 leaf and then its v2 leaf.
  const leaves: Hex[] = [];
  const positions = pending.map((p) => {
    const v1 = leaves.push(p.leaf as Hex) - 1;
    const v2 = p.leafV2 ? leaves.push(p.leafV2 as Hex) - 1 : null;
    return { id: p.id, v1, v2 };
  });
  const settledPositions = settled.map((s) => ({ id: s.id, at: leaves.push(s.leaf as Hex) - 1 }));
  const root = empty ? (`0x${EMPTY_ROOT}` as Hex) : new MerkleTree(leaves).root;
  const first = Math.min(...[pending[0]?.ts, settled[0]?.ts].filter((d): d is Date => !!d).map((d) => d.getTime()));
  const fromTs = last ? last.toTs : empty ? new Date(toTs.getTime() - SECONDS_PER_HOUR * 1000) : new Date(Math.floor(first / 1000) * 1000);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(anchors).values({ index, root, fromTs, toTs, count: leaves.length, status: "pending" });
    for (const pos of positions) await tx.update(generations).set({ anchorIndex: index, leafIndex: pos.v1, leafIndexV2: pos.v2 }).where(eq(generations.id, pos.id));
    for (const pos of settledPositions) await tx.update(facilitatorSettlements).set({ anchorIndex: index, leafIndex: pos.at }).where(eq(facilitatorSettlements.id, pos.id));
  });
  let status: string = "local";
  let txHash: string | null = null;
  if (chainConfigured) {
    try {
      const r = await postAnchor(ctx, { index, root, fromTs, toTs, count: leaves.length });
      status = r.status;
      txHash = r.hash;
    } catch (e) {
      status = "pending";
      if (!(e instanceof WaitForEarlierRoot)) log.error("anchor submission failed; will retry", { index, error: (e as Error).message });
    }
  }
  await ctx.db.update(anchors).set({ status, txHash }).where(eq(anchors.index, index));
  return { anchored: pending.length, settlements: settled.length, index, hour: anchorHour({ toTs }), root, status, tx: txHash };
}

/**
 * Retry anchors that are built and not on chain. Program mode: `pending` rows, in order, stopping at the first that
 * fails (the program wants them in order). Memo mode (R3-12, and security review round 5, R5-18), what a pass looks at:
 *   - first the NEWEST `RETRY_ROWS_PER_PASS` rows that are built and not final (`pending`, and `local` rows that close
 *     on an hour), oldest of them first. A row that cannot be posted does not hold the later ones back, except that a
 *     row which waits for an earlier root ends this part of the pass (every later row links to the same one);
 *   - then a backlog of its own: rows in `conflict` (looked at again so that they alarm again, R3-03, and leave that
 *     state should the chain say otherwise) and unresolved rows older than the newest ones, `BACKLOG_ROWS_PER_PASS` a
 *     pass after a stored cursor that wraps.
 * The invariant: whatever is stored, the newest unresolved rows are looked at in every pass, and every other row of
 * the backlog within ceil(backlog / BACKLOG_ROWS_PER_PASS) + 1 passes; no set of rows that never changes state keeps
 * another row from being looked at. A `local` row that does not close on an hour maps to no line and is in no pass.
 * A `late` or `unverifiable` row is not looked at again: its receipts are rooted with the next row
 * (`releaseUnanchored`). A row that is still unresolved after the lateness bound alarms (`anchor.memo_stuck`) and
 * stays what it is: nothing here marks a row confirmed that `postAnchor` did not find final and verified on chain.
 * Returns how many rows reached the chain in this pass.
 */
export async function retryAnchors(ctx: Ctx) {
  if (!anchorPostingConfigured(ctx)) return { retried: 0 };
  const settings = anchorSettings(ctx);
  const memo = settings.mode === "memo";
  if (memo) await auditQuietly(ctx);
  let rows: (typeof anchors.$inferSelect)[], backlog: (typeof anchors.$inferSelect)[] = [];
  if (memo) {
    // A row built while no chain was configured closes on any second; only a row that closes an hour maps to a line.
    const open = or(eq(anchors.status, "pending"), and(eq(anchors.status, "local"), sql`extract(epoch from ${anchors.toTs})::bigint % 3600 = 0`))!;
    rows = (await ctx.db.select().from(anchors).where(open).orderBy(desc(anchors.index)).limit(RETRY_ROWS_PER_PASS)).reverse();
    const older = rows.length === RETRY_ROWS_PER_PASS ? and(open, lt(anchors.index, rows[0]!.index)) : undefined;
    const cursor = (await getKv<{ index: number }>(ctx, RETRY_BACKLOG_CURSOR))?.index ?? -1;
    backlog = await ctx.db.select().from(anchors).where(and(older ? or(eq(anchors.status, "conflict"), older) : eq(anchors.status, "conflict"), gt(anchors.index, cursor))).orderBy(asc(anchors.index)).limit(BACKLOG_ROWS_PER_PASS);
    const next = backlog.length < BACKLOG_ROWS_PER_PASS ? -1 : backlog[backlog.length - 1]!.index;
    if (next !== cursor) await setKv(ctx, RETRY_BACKLOG_CURSOR, { index: next });
  } else rows = await ctx.db.select().from(anchors).where(eq(anchors.status, "pending")).orderBy(asc(anchors.index)).limit(10_000);
  let n = 0;
  /** Look at one row again. False when the rows after it in the same list need not be looked at in this pass. */
  const look = async (a: typeof anchors.$inferSelect): Promise<boolean> => {
    let status: string = a.status;
    try {
      const r = await postAnchor(ctx, a);
      status = r.status;
      if (r.status !== a.status || r.hash !== a.txHash) await ctx.db.update(anchors).set({ status: r.status === "pending" && a.status === "local" ? "pending" : r.status, txHash: r.hash }).where(eq(anchors.index, a.index));
      if (r.status === "confirmed" || r.status === "late") n++;
    } catch (e) {
      if (e instanceof WaitForEarlierRoot) return false; // every later row links to the same unfinished one
      log.warn("anchor retry failed", { index: a.index, error: (e as Error).message });
      if (!memo) return false; // the program takes anchors in order
    }
    if (memo && (status === "pending" || status === "local") && Date.now() - a.toTs.getTime() > settings.maxLateSeconds * 1000) log.error(MEMO_STUCK, { index: a.index, hour: anchorHour(a), status });
    return true;
  };
  for (const a of rows) if (!(await look(a))) break;
  for (const a of backlog) await look(a);
  return { retried: n };
}

/** What `compareAnchorsWithChain` found. Every list is about the key this process signs with and the hours since `sinceHour`. */
export type AnchorChainComparison = {
  anchorer: string;
  sinceHour: number;
  /** False when the key's history could not be read back to `sinceHour` (`why` says how far short): the lists are then what was seen, not all there is. */
  complete: boolean;
  why: string | null;
  /** Hours for which the chain holds a root line of the key that counts, and the anchors table has no row. */
  onChainWithoutRow: { hour: number; root: string; count: number; signature: string; blockTime: number | null }[];
  /** Hours whose earliest counting line on chain names another root or count than the row for that hour. */
  onChainOtherRoot: { hour: number; index: number; rowStatus: string; rowRoot: string; rowCount: number; root: string; count: number; signature: string }[];
  /** Rows marked confirmed or late whose transaction is not, as far as this RPC shows, a line of the key with the row's hour, root and count. */
  confirmedNotOnChain: { index: number; hour: number; txHash: string | null; reason: string }[];
};
/**
 * Compare the anchors table with what the chain holds for the anchorer key of this process, hour by hour, since
 * `sinceHour` (default: the audit's horizon, 48 hours back). READ-ONLY: it sends no transaction and writes no row and
 * no stored value, so the restore procedure (R5-20, scripts/restore-reconcile.ts) can run it against a database that
 * has just been restored, before the anchor job runs. Memo mode only. The lines are read from the key's own finalized
 * transactions (`walkRootLines`); a line counts under the same rules the job and the verifiers apply (`lineStanding`),
 * and the earliest transaction for an hour decides.
 */
export async function compareAnchorsWithChain(ctx: Ctx, o: { sinceHour?: number; maxPages?: number; maxReads?: number } = {}): Promise<AnchorChainComparison> {
  const settings = anchorSettings(ctx);
  if (settings.mode !== "memo") throw new Error("compareAnchorsWithChain reads memo lines: this router posts its roots to the anchor program");
  const anchorer = ctx.chain.wallet("anchorer").keypair.publicKey;
  const key = anchorer.toBase58();
  const rpc = ctx.chain.connection as unknown as MemoRpc;
  const genesis = await clusterGenesis(ctx);
  const sinceHour = o.sinceHour ?? Math.floor(((await ctx.chain.blockTimestamp()) - MEMO_AUDIT.horizonSeconds) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  const out: AnchorChainComparison = { anchorer: key, sinceHour, complete: false, why: null, onChainWithoutRow: [], onChainOtherRoot: [], confirmedNotOnChain: [] };
  const rows = await ctx.db.select().from(anchors).where(gt(anchors.toTs, new Date(sinceHour * 1000))).orderBy(asc(anchors.index));
  const walk = await walkRootLines(rpc, anchorer, { genesis, floor: sinceHour, maxPages: o.maxPages, maxReads: o.maxReads }).catch((e) => ({ found: [], complete: false, why: `the anchorer's history could not be read (${(e as Error).message.slice(0, 120)})`, more: false }));
  out.complete = walk.complete;
  out.why = walk.why;
  // The earliest line that counts for each hour (the walk lists oldest first).
  const first = new Map<number, (typeof walk.found)[number]>();
  for (const l of walk.found) {
    if (l.claim.hour < sinceHour || first.has(l.claim.hour)) continue;
    if (lineStanding({ hour: l.claim.hour, landed: l.blockTime, signer: key, anchorers: settings.anchorers, maxLateSeconds: settings.maxLateSeconds }) === "counts") first.set(l.claim.hour, l);
  }
  for (const [hour, l] of [...first].sort((x, y) => x[0] - y[0])) {
    const forHour = rows.filter((r) => r.toTs.getTime() % (SECONDS_PER_HOUR * 1000) === 0 && anchorHour(r) === hour);
    if (!forHour.length) out.onChainWithoutRow.push({ hour, root: l.claim.root, count: l.claim.count, signature: l.signature, blockTime: l.blockTime });
    for (const r of forHour) if (!sameClaim(l.claim, { root: r.root.replace(/^0x/, "").toLowerCase(), count: r.count })) out.onChainOtherRoot.push({ hour, index: r.index, rowStatus: r.status, rowRoot: r.root, rowCount: r.count, root: l.claim.root, count: l.claim.count, signature: l.signature });
  }
  for (const r of rows) {
    if (r.status !== "confirmed" && r.status !== "late") continue;
    const hour = anchorHour(r);
    if ((await anchorPost(ctx, r.index))?.mode === "program") continue;
    const signer = keyForHour(settings, hour);
    const mine = { root: r.root.replace(/^0x/, "").toLowerCase(), count: r.count };
    const t = r.txHash ? await readSignedTransaction(rpc, r.txHash, "finalized") : null;
    if (!t) out.confirmedNotOnChain.push({ index: r.index, hour, txHash: null, reason: "the row names no transaction" });
    else if (!t.ok) out.confirmedNotOnChain.push({ index: r.index, hour, txHash: r.txHash, reason: t.reason });
    else if (!t.tx.memos.some((m) => { const c = parseMemo(m.text); return !!c && c.kind === "root" && c.hour === hour && sameClaim(c, mine) && !!signer && m.signers.includes(signer) && networkNamesGenesis(c.network, genesis); })) out.confirmedNotOnChain.push({ index: r.index, hour, txHash: r.txHash, reason: "the transaction carries no root line of the anchorer key for this row's hour, root and count" });
  }
  return out;
}

/**
 * Program mode: return the rent of roots whose hour is older than the program's 400-day retention (close_root), oldest
 * first, a few per run. A cursor in the key-value store remembers how far it got. The closed roots stay verifiable from
 * the transactions that posted them (`anchorRootOnChain`). Memo mode has no accounts and nothing to close.
 */
export const ROOT_CLOSE_BATCH = 6;
const CLOSE_CURSOR = "anchor-closed-through";
export async function closeExpiredRoots(ctx: Ctx) {
  if (anchorSettings(ctx).mode !== "program" || !anchorPostingConfigured(ctx)) return { closed: 0 };
  const programId = ctx.chain.programId("receiptAnchor");
  const authority = ctx.chain.wallet("anchorer").keypair.publicKey;
  const cursor = (await getKv<{ index: number }>(ctx, CLOSE_CURSOR))?.index ?? -1;
  const now = await ctx.chain.blockTimestamp();
  const rows = await ctx.db.select().from(anchors).where(and(gt(anchors.index, cursor), eq(anchors.status, "confirmed"))).orderBy(asc(anchors.index)).limit(ROOT_CLOSE_BATCH);
  const due = [];
  for (const a of rows) {
    if (rootClosableAt(anchorHour(a)) > now) break; // rows are in hour order: the rest are younger
    due.push(a);
  }
  if (!due.length) return { closed: 0 };
  // Only accounts that still exist are closed (an earlier run may have landed without its cursor being written).
  const open = [];
  for (const a of due) if (await ctx.chain.connection.getAccountInfo(receiptRootPda(programId, anchorHour(a)), finality(ctx))) open.push(a);
  let tx: string | null = null;
  if (open.length) tx = (await ctx.chain.send("anchorer", open.map((a) => closeRootIx(programId, { authority, hour: anchorHour(a) })))).hash;
  await setKv(ctx, CLOSE_CURSOR, { index: due[due.length - 1]!.index });
  return { closed: open.length, through: due[due.length - 1]!.index, tx };
}

/**
 * Weekly signing-key rotation, and publication of the newest key. Program mode: as trellis_anchor's current signer
 * (rotate_signer keeps the outgoing one as previous_signer); a key the SignerSet already names is recorded as published
 * without a transaction. Memo mode publishes nothing on chain: the `trellis:signer:v1` lines this job used to write were
 * verified by nobody (R3-14), so they gave a verifier nothing and are no longer written. The receipt keys are the JWKS
 * at /.well-known/trellis-receipt-keys.json, which a verifier fetches from the router's origin or pins.
 */
export const SIGNER_SET_CURRENT = "signer_set:current";
export async function runKeyRotation(ctx: Ctx) {
  const r = await ctx.signer.rotateIfDue();
  let published = 0;
  if (anchorPostingConfigured(ctx) && anchorSettings(ctx).mode === "program") {
    const unpublished = await ctx.db.select().from(receiptKeys).where(isNull(receiptKeys.onchainTx)).orderBy(asc(receiptKeys.validFrom));
    for (const k of unpublished) {
      try {
        const { hash } = await ctx.chain.registerSigningKey(k.publicKey);
        await ctx.db.update(receiptKeys).set({ onchainTx: hash ?? SIGNER_SET_CURRENT }).where(eq(receiptKeys.id, k.id));
        published++;
      } catch (e) {
        log.warn("signing key publication failed", { key: k.id, error: (e as Error).message });
      }
    }
  }
  return { rotated: r.rotated, key: r.key.id, published };
}
