import type { Hono } from "hono";
import { anchorOnChain, anchorProofFields } from "../services/anchor.ts";
import { and, asc, desc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { agentSessions, anchors, blindNullifiers, facilitatorSettlements, generations, paywithDebts, paywithSwaps } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, inspectCose, verifyCoseWithRawKey, verifyWithRawKey, type ReceiptKey } from "../receipts/signer.ts";
import { makegoodRefunds } from "../services/makegood-schema.ts";
import { chainOf, receiptLeafV2 } from "../receipts/v2.ts";
import { bearer, resolveKey, walletAuth } from "./auth.ts";
import { nullifierOf, parsePrivateToken } from "../blind/privacy-token.ts";
import { exportCsv, exportQuery, exportRow } from "../receipts/export.ts";

/**
 * Kept Merkle trees (security review round 5, R5-21). GET /api/v1/receipts/:id needs no key, and every call used to
 * load all leaves of the receipt's hour and build the tree, twice, synchronously. A tree that was built is now kept,
 * per database, the most recently used first: at most `entries` trees holding at most `leaves` leaves between them.
 * A tree with more leaves than `leaves` is built for the call and not kept (one build per call, as before the cache,
 * but once per response: `anchorProofs`), and reading more than `entries` different hours in turn rebuilds one tree
 * per miss.
 *
 * THE INVARIANT: a kept tree is used for an anchor row only when its root is that row's root and its leaf count that
 * row's count, both read from the row in the same call (`treeOf`). A tree's paths are a function of its leaves alone,
 * and the leaves of a rooted anchor do not change while its root stands, so a path from a kept tree is byte for byte
 * the path a fresh build gives, and no path is ever served under a root other than the one its tree hashes to. When
 * the row's root or count differs (a restored database, a re-rooted hour) the entry is dropped and the tree rebuilt;
 * a tree that does not hash to its row's root is never kept. Everything else a proof says (status, transaction, the
 * line) is read from the row on every call and is not cached.
 */
export const TREE_CACHE = { entries: 16, leaves: 262_144 };
const keptTrees = new WeakMap<object, Map<number, MerkleTree>>();
const treeBuilds = new WeakMap<object, number>();
/** What the cache holds for this database, and how many trees were built for it (tests bound both). */
export const anchorTreeCacheStats = (ctx: Ctx) => {
  const kept = [...(keptTrees.get(ctx.db as object)?.values() ?? [])];
  return { entries: kept.length, leaves: kept.reduce((n, t) => n + t.leaves.length, 0), builds: treeBuilds.get(ctx.db as object) ?? 0 };
};
const sameRoot = (tree: MerkleTree, a: { root: string; count: number }) => tree.root.toLowerCase() === a.root.toLowerCase() && tree.leaves.length === a.count;

/** Rebuild an anchor's tree from the stored leaf positions (v1 leaves, and v2 leaves where a receipt has one). */
async function anchorTree(ctx: Ctx, anchorIndex: number) {
  treeBuilds.set(ctx.db as object, (treeBuilds.get(ctx.db as object) ?? 0) + 1);
  const rows = await ctx.db
    .select({ leaf: generations.receiptLeaf, leafIndex: generations.leafIndex, leafV2: generations.receiptLeafV2, leafIndexV2: generations.leafIndexV2 })
    .from(generations)
    .where(eq(generations.anchorIndex, anchorIndex))
    .orderBy(asc(generations.leafIndex));
  const leaves: Hex[] = [];
  for (const r of rows) {
    if (r.leafIndex != null) leaves[r.leafIndex] = r.leaf as Hex;
    if (r.leafIndexV2 != null && r.leafV2) leaves[r.leafIndexV2] = r.leafV2 as Hex;
  }
  // v6 F: facilitator settlement receipts rooted in the same anchor.
  const settled = await ctx.db.select({ leaf: facilitatorSettlements.receiptLeaf, leafIndex: facilitatorSettlements.leafIndex }).from(facilitatorSettlements).where(eq(facilitatorSettlements.anchorIndex, anchorIndex));
  for (const s of settled) if (s.leafIndex != null && s.leaf) leaves[s.leafIndex] = s.leaf as Hex;
  return new MerkleTree(leaves);
}

/** The tree of anchor row `a`: the kept one when it is that row's tree (see THE INVARIANT above), else a fresh build. */
async function treeOf(ctx: Ctx, a: { index: number; root: string; count: number }): Promise<MerkleTree> {
  const db = ctx.db as object;
  const kept = keptTrees.get(db) ?? (keptTrees.set(db, new Map()), keptTrees.get(db)!);
  const hit = kept.get(a.index);
  kept.delete(a.index);
  if (hit && sameRoot(hit, a)) { kept.set(a.index, hit); return hit; } // moved to the newest place
  const tree = await anchorTree(ctx, a.index);
  if (!sameRoot(tree, a) || tree.leaves.length > TREE_CACHE.leaves) return tree;
  kept.set(a.index, tree);
  let leaves = 0;
  for (const t of kept.values()) leaves += t.leaves.length;
  // The oldest go first, until both bounds hold (the tree just built fits by itself, so it stays).
  for (const [index, t] of kept) {
    if (kept.size <= TREE_CACHE.entries && leaves <= TREE_CACHE.leaves) break;
    kept.delete(index);
    leaves -= t.leaves.length;
  }
  return tree;
}

export async function anchorProof(ctx: Ctx, g: { anchorIndex: number | null; leafIndex: number | null; leafIndexV2?: number | null }, version: 1 | 2 = 1) {
  return (await anchorProofs(ctx, g, [version]))[version] ?? null;
}

/** The anchor proofs of one receipt for the leaf versions asked for, from ONE tree (R5-21: a response never builds its hour's tree twice). */
export async function anchorProofs(ctx: Ctx, g: { anchorIndex: number | null; leafIndex: number | null; leafIndexV2?: number | null }, versions: readonly (1 | 2)[] = [1, 2]) {
  const leafIndexOf = (version: 1 | 2) => (version === 2 ? (g.leafIndexV2 ?? null) : g.leafIndex);
  const wanted = versions.filter((v) => leafIndexOf(v) != null);
  if (g.anchorIndex == null || !wanted.length) return {};
  const [a] = await ctx.db.select().from(anchors).where(eq(anchors.index, g.anchorIndex));
  if (!a) return {};
  const tree = await treeOf(ctx, a);
  // How the root was posted and what a verifier compares the transaction `tx` with (src/services/anchor.ts).
  const posted = await anchorProofFields(ctx, a);
  const proofOf = (version: 1 | 2) => {
    const leafIndex = leafIndexOf(version)!;
    return {
      root: a.root,
      index: a.index,
      leaf_index: leafIndex,
      proof: tree.proof(leafIndex),
      from: a.fromTs.toISOString(),
      to: a.toTs.toISOString(),
      tx: a.txHash,
      status: a.status,
      chain: ctx.cfg.chain.id,
      contract: ctx.cfg.chain.receiptAnchor ?? null,
      network: ctx.cfg.chain.network,
      ...posted,
    };
  };
  const out: Partial<Record<1 | 2, ReturnType<typeof proofOf>>> = {};
  for (const v of wanted) out[v] = proofOf(v);
  return out;
}

export function generationSummary(g: typeof generations.$inferSelect) {
  return {
    id: g.id,
    created_at: g.ts.toISOString(),
    model: g.modelId,
    provider_name: g.providerId,
    tokens_prompt: g.tokensIn,
    tokens_completion: g.tokensOut,
    tokens_reasoning: g.reasoningTokens,
    total_cost: picoToUsd(g.cost),
    upstream_inference_cost: picoToUsd(g.upstreamCost),
    royalty: picoToUsd(g.royalty),
    margin: picoToUsd(g.margin),
    mode: g.mode,
    private: g.private,
    latency: g.latencyMs,
    quantization: g.quant,
    finish_reason: g.finishReason,
    streamed: g.streamed,
    cancelled: g.cancelled,
    paid_with: g.paidWith,
    receipt_key_id: g.receiptKeyId,
    anchored: g.anchorIndex != null,
    key_hash: g.keyHash,
  };
}

export function generationRoutes(app: Hono, ctx: Ctx) {
  // The caller's account's generations, newest first (receipt summaries; no content is ever stored).
  app.get("/api/v1/generations", async (c) => {
    const secret = bearer(c.req.header("authorization"));
    const key = secret ? await resolveKey(ctx, secret) : null;
    if (!key) fail(401, "Provide an API key as `Authorization: Bearer sk-tr-v1-...`.", "missing_key");
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const before = c.req.query("before");
    // A session key lists only its own calls, not the whole account's.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash));
    const scope = session || key.scope === "inference" ? /* ZK6: own calls only */ eq(generations.keyHash, key.keyHash) : eq(generations.accountId, key.accountId);
    const rows = await ctx.db
      .select()
      .from(generations)
      .where(and(scope, ...(before ? [lt(generations.ts, new Date(before))] : [])))
      .orderBy(desc(generations.ts))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({ data: page.map(generationSummary), next: rows.length > limit ? page[page.length - 1].ts.toISOString() : null });
  });

  // Receipt export (update 15, `receipt-export` in src/features.json): registered only while that switch is on. The
  // caller's signed receipts from `from` (inclusive) to `to` (exclusive), oldest first, as JSON or CSV. Same scope as the
  // list above: a session key or an inference-only key exports its own calls, any other key the account's. A page holds
  // at most 1,000 rows; `next` (JSON) or the x-next-cursor header (CSV) is the cursor for the page after it.
  if (ctx.cfg.updates["receipt-export"]) app.get("/api/v1/generations/export", async (c) => {
    c.header("cache-control", "no-store");
    const secret = bearer(c.req.header("authorization"));
    const key = secret ? await resolveKey(ctx, secret) : null;
    if (!key) fail(401, "Provide an API key as `Authorization: Bearer sk-tr-v1-...`.", "missing_key");
    const q = exportQuery(c.req.query());
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash));
    const scope = session || key.scope === "inference" ? eq(generations.keyHash, key.keyHash) : eq(generations.accountId, key.accountId);
    const window = and(scope, gte(generations.ts, q.from), lt(generations.ts, q.to), or(isNotNull(generations.receiptSig), isNotNull(generations.receiptCose)));
    if (q.cursor) {
      // The cursor is the last id of the previous page; it must be one of this caller's rows in this range.
      const [at] = await ctx.db.select({ id: generations.id }).from(generations).where(and(window, eq(generations.id, q.cursor)));
      if (!at) fail(400, "That cursor is not a receipt of this export. Start again without it.", "invalid_request");
    }
    // (ts, id) after the cursor's own row: compared in the database, so a microsecond timestamp loses nothing.
    const after = q.cursor ? sql`(${generations.ts}, ${generations.id}) > (select g2.ts, g2.id from generations g2 where g2.id = ${q.cursor})` : undefined;
    const rows = await ctx.db.select().from(generations).where(and(window, after)).orderBy(asc(generations.ts), asc(generations.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit).map(exportRow);
    const next = rows.length > q.limit ? page[page.length - 1].id : null;
    const range = { from: q.from.toISOString(), to: q.to.toISOString() };
    if (q.format === "json") return c.json({ data: page, next, ...range });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="trellis-receipts-${range.from.slice(0, 10)}-${range.to.slice(0, 10)}.csv"`);
    c.header("access-control-expose-headers", "x-next-cursor");
    if (next) c.header("x-next-cursor", next);
    return c.body(exportCsv(page, !q.cursor));
  });

  app.get("/api/v1/generation", async (c) => {
    const id = c.req.query("id");
    if (!id) fail(400, "Pass ?id=<generation id>.", "invalid_request");
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, id));
    if (!g) fail(404, "Generation not found.", "not_found");
    // Owner-only: the key (or any key on the same account) or the paying wallet.
    const secret = bearer(c.req.header("authorization"));
    let allowed = false;
    if (secret) {
      const key = await resolveKey(ctx, secret);
      allowed = !!key && key.accountId === g.accountId && (key.scope !== "inference" || key.keyHash === g.keyHash); // ZK6
    } else if (c.req.header("x-wallet-auth")) {
      const w = await walletAuth(ctx, c.req.header("x-wallet-auth")!, (await import("../lib/util.ts")).sha256(""), c);
      allowed = w.accountId === g.accountId;
    } else if (ctx.blind) {
      // A blind redemption has no account. Whoever holds the spent token owns its receipt: the token hashes to the
      // nullifier recorded against this generation.
      const token = parsePrivateToken(c.req.header("authorization"));
      if (token) {
        const [spent] = await ctx.db.select({ id: blindNullifiers.generationId }).from(blindNullifiers).where(eq(blindNullifiers.nullifier, nullifierOf(token)));
        allowed = !!spent && spent.id === g.id;
      }
    }
    if (!allowed) fail(404, "Generation not found.", "not_found");
    let paidWith = g.paidWith as Record<string, unknown> | null;
    if (paidWith) {
      const [d] = await ctx.db.select().from(paywithDebts).where(eq(paywithDebts.generationId, g.id));
      if (d?.swapId) {
        const [s] = await ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, d.swapId));
        paidWith = { ...paidWith, raw_units: d.rawAllocated?.toString() ?? paidWith.raw_units, fair_price: s?.fairPrice ?? paidWith.fair_price, swap_tx: s?.tx ?? null, status: s?.status === "confirmed" ? "settled" : "accrued" };
      }
    }
    return c.json({
      data: {
        id: g.id,
        model: g.modelId,
        provider_name: g.providerId,
        created_at: g.ts.toISOString(),
        generation_time: g.generationTimeMs,
        latency: g.latencyMs,
        native_tokens_prompt: g.tokensIn,
        native_tokens_completion: g.tokensOut,
        native_tokens_reasoning: g.reasoningTokens,
        native_tokens_cached: g.cachedTokens,
        tokens_prompt: g.tokensIn,
        tokens_completion: g.tokensOut,
        total_cost: picoToUsd(g.cost),
        upstream_inference_cost: picoToUsd(g.upstreamCost),
        royalty: picoToUsd(g.royalty),
        margin: picoToUsd(g.margin),
        cache_discount: picoToUsd(g.cacheDiscount),
        finish_reason: g.finishReason,
        native_finish_reason: g.nativeFinishReason,
        streamed: g.streamed,
        cancelled: g.cancelled,
        quantization: g.quant,
        data_region: g.dataRegion,
        is_byok: g.isByok,
        mode: g.mode,
        private: g.private,
        attestation_hash: g.attestationHash,
        receipt_sig: g.receiptSig,
        receipt_key_id: g.receiptKeyId,
        receipt: g.receipt,
        receipt_leaf: g.receiptLeaf,
        // v2 buckets the counts above; this owner-only view keeps them exact.
        receipt_v2: g.receiptCose ? { claims: g.receiptV2, cose: g.receiptCose, leaf: g.receiptLeafV2 } : null,
        paid_with: paidWith,
        payment_tx: g.paymentTx,
        attempts: g.attempts,
        anchor: await anchorProof(ctx, g),
      },
    });
  });
}

/**
 * Chain lookups one source may cause per minute through the unauthenticated verify route, and all sources together.
 * The total bounds the RPC work the route can cause; one source's share is a thirtieth of it (security review round
 * 5, R5-22: at 12 of 120, ten addresses used up the lookups of everyone). It still takes only `perMinute /
 * perSourcePerMinute` address buckets to use the total up for a minute; a caller past either limit is told `unknown`
 * and loses nothing else, and an answer already in the per-anchor cache costs no lookup.
 */
export const VERIFY_CHAIN_LOOKUPS = { perSourcePerMinute: 4, perMinute: 120 };

/**
 * Whether the chain holds the root of the router's anchor `index`, for the verify route (R3-29). The answer comes from
 * a per-anchor cache where there is one; a fresh lookup is a bounded number of RPC calls and is taken from a per-source
 * and a global budget. Without budget the answer is `unknown`: the caller is told the chain was not consulted, and no
 * RPC work is done on its behalf. The mode, the program and the anchorer keys are this router's configuration; nothing
 * about them is read from the request (R3-04).
 */
async function onchainRootOf(ctx: Ctx, index: number, source: string | undefined) {
  // `from.id` is the caller's address bucket (or "unknown" when a caller inside the router asks): the key holds an address.
  const from = { id: source ?? "unknown" };
  const allow = async () => (await ctx.limiter.take(`receipts-verify-chain:${from.id}`, 1, VERIFY_CHAIN_LOOKUPS.perSourcePerMinute, 60_000)).ok && (await ctx.limiter.take("receipts-verify-all", 1, VERIFY_CHAIN_LOOKUPS.perMinute, 60_000)).ok;
  return anchorOnChain(ctx, index, { allow }).catch(() => ({ status: "unknown" as const, anchor: null, reason: "the chain could not be read" }));
}

/** Tolerance when a receipt's own time is compared with the time of its signing key. */
const KEY_TIME_SKEW_MS = 300_000;

/**
 * A retired receipt key signs nothing new (security review round 4, R4-28). The router erases a retired key's private
 * half, but whoever copied it earlier can still sign with it, and can date what it signs inside the key's time: so
 * once a key is retired, a valid signature and a plausible date prove nothing about who issued the receipt. A receipt
 * under a retired key is valid here only when
 *   - it is dated inside the key's time (no later than the retirement, no earlier than the key's start), AND
 *   - this router can show that it issued it: the leaf of exactly these signed bytes is the one the router stored for
 *     that id, or the caller's inclusion proof leads to the root of one of this router's own anchors.
 * A receipt under the current key is not affected: there the key itself is the proof, as before.
 */
async function signingKeyVerdict(ctx: Ctx, key: ReceiptKey | null, r: { time: number | null; underOwnRoot: boolean; stored: () => Promise<string | null | undefined>; leaf: string }): Promise<{ status: "current" | "retired" | null; ok: boolean; reason: string | null }> {
  if (!key) return { status: null, ok: true, reason: null };
  if (!key.retiredAt) return { status: "current", ok: true, reason: null };
  const retired = key.retiredAt.toISOString();
  if (r.time !== null && (r.time > key.retiredAt.getTime() + KEY_TIME_SKEW_MS || r.time < key.validFrom.getTime() - KEY_TIME_SKEW_MS)) return { status: "retired", ok: false, reason: `the receipt is dated outside the time of its signing key, which was retired at ${retired}: a retired key signs nothing new` };
  if (r.underOwnRoot) return { status: "retired", ok: true, reason: null };
  const stored = await r.stored().catch(() => null);
  if (stored && stored.toLowerCase() === r.leaf.toLowerCase()) return { status: "retired", ok: true, reason: null };
  return { status: "retired", ok: false, reason: `the receipt is signed with a retired key (retired at ${retired}) and this router has no record of issuing it: a retired key signs nothing new, so the signature and the date alone do not show who made it. Send the receipt's anchor proof (root, proof, index) with it` };
}
/** A receipt's own time in milliseconds: `ts` (a number) or `issued` (an ISO date) of a v1 payload; null when it carries neither. */
const payloadTime = (payload: unknown): number | null => {
  const p = (payload ?? {}) as { ts?: unknown; issued?: unknown };
  if (typeof p.ts === "number" && Number.isFinite(p.ts)) return p.ts;
  const t = typeof p.issued === "string" ? Date.parse(p.issued) : NaN;
  return Number.isFinite(t) ? t : null;
};
/**
 * What an anchor proof in a verify request is worth (security review round 5, R5-22). The Merkle path only shows that
 * the leaf is under the root THE CALLER named, and any leaf is under a root of the caller's own making, so a path alone
 * is never reported as an inclusion:
 *   invalid         the path does not lead from the leaf to the root given; or the root given is not the root this
 *                   router holds for the anchor index given; or the chain holds another root for that anchor
 *   onchain_anchor  the path leads to the root of this router's anchor `index`, and the chain was found to hold it
 *   router_anchor   the path leads to the root this router holds for its anchor `index`; the chain was not found to
 *                   hold it (`onchain_status` says why: not posted, not verified, or not consulted)
 *   unchecked       the path is consistent, and no anchor of this router was named to compare the root with
 * `inclusion_valid` is true for the two anchors, false for invalid, null for unchecked and when no proof was given.
 */
type InclusionStatus = "invalid" | "onchain_anchor" | "router_anchor" | "unchecked";
async function inclusionOf(ctx: Ctx, leaf: Hex, anchor: { root: string; proof: string[]; index?: number } | undefined, source: string | undefined): Promise<{ status: InclusionStatus | null; valid: boolean | null; own: boolean; onchainRoot: string | null; onchainStatus: string | null }> {
  if (!anchor?.root || !Array.isArray(anchor.proof)) return { status: null, valid: null, own: false, onchainRoot: null, onchainStatus: null };
  const path = MerkleTree.verify(leaf, anchor.proof as Hex[], anchor.root as Hex);
  let onchainRoot: string | null = null, onchainStatus: string | null = null, own: boolean | null = null;
  if (anchor.index != null) {
    const a = await onchainRootOf(ctx, anchor.index, source);
    onchainRoot = a.anchor?.root ?? null;
    onchainStatus = a.status;
    const [row] = await ctx.db.select({ root: anchors.root }).from(anchors).where(eq(anchors.index, anchor.index));
    own = row ? row.root.toLowerCase() === anchor.root.toLowerCase() : null;
  }
  const differs = (onchainRoot !== null && onchainRoot.toLowerCase() !== anchor.root.toLowerCase()) || own === false;
  const status: InclusionStatus = !path || differs ? "invalid" : own !== true ? "unchecked" : onchainRoot !== null ? "onchain_anchor" : "router_anchor";
  return { status, valid: status === "invalid" ? false : status === "unchecked" ? null : true, own: status !== "invalid" && own === true, onchainRoot, onchainStatus };
}

/** Stateless receipt verification (signature + optional anchor inclusion). `source` is who the chain-lookup budget is counted against. */
export async function verifyReceipt(ctx: Ctx, r: { payload: unknown; sig: string; key_id: string; anchor?: { root: string; proof: string[]; index?: number } }, source?: string) {
  const key = await ctx.signer.publicKey(r.key_id);
  const onchainKey = key ? await ctx.chain.signingKeyOnChain(key.publicKeyHex).catch(() => null) : null;
  const pubHex = onchainKey ? onchainKey.publicKey.slice(2) : key?.publicKeyHex;
  const signatureValid = !!pubHex && verifyWithRawKey(r.payload, r.sig, pubHex);
  const leaf = receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64"));
  const included = await inclusionOf(ctx, leaf, r.anchor, source);
  const { valid: inclusion, onchainRoot, onchainStatus } = included;
  // R4-28: under a retired key the signature is not enough. Asked only once the signature has verified, by primary key.
  const id = (r.payload as { id?: unknown } | null)?.id;
  const verdict = signatureValid
    ? await signingKeyVerdict(ctx, key, {
        time: payloadTime(r.payload), leaf, underOwnRoot: included.own,
        stored: async () => {
          if (typeof id !== "string") return null;
          const [g] = await ctx.db.select({ leaf: generations.receiptLeaf }).from(generations).where(eq(generations.id, id));
          if (g?.leaf) return g.leaf;
          const [m] = await ctx.db.select({ leaf: makegoodRefunds.receiptLeaf }).from(makegoodRefunds).where(eq(makegoodRefunds.id, id));
          return m?.leaf ?? null;
        },
      })
    : { status: key ? (key.retiredAt ? ("retired" as const) : ("current" as const)) : null, ok: true, reason: null };
  return {
    signature_valid: signatureValid,
    key_source: onchainKey ? "chain" : key ? "router" : null,
    key_retired_at: key?.retiredAt?.toISOString() ?? null,
    // current | retired | null (unknown key). Under a retired key `valid` also needs the router to have issued the receipt.
    key_status: verdict.status,
    reason: verdict.reason,
    leaf,
    // true only for a path to the root of an anchor of this router that the request names by index; see `inclusionOf`.
    inclusion_valid: inclusion,
    inclusion_status: included.status,
    onchain_root: onchainRoot,
    // verified | unverified | not_posted | unknown; null when no anchor index was given. `valid` covers the signature and
    // the Merkle path; only "verified" means the root was found on chain.
    onchain_status: onchainStatus,
    valid: signatureValid && inclusion !== false && verdict.ok,
  };
}

/**
 * Stateless v2 verification, in the spec's order: COSE signature, then the hashes the caller supplied, then the
 * chunk chain head (when the caller supplies the streamed event data), then anchor inclusion. Stops at nothing: every
 * step is reported, and `valid` is false when any step that ran failed.
 */
export async function verifyReceiptV2(
  ctx: Ctx,
  r: { cose: string; request_sha256?: string; response_sha256?: string; chunks?: string[]; anchor?: { root: string; proof: string[]; index?: number } },
  source?: string,
) {
  const cose = Buffer.from(r.cose, "base64");
  let inspected: ReturnType<typeof inspectCose> | null = null;
  try {
    inspected = inspectCose(cose);
  } catch (e) {
    return { version: 2, valid: false, error: `not a COSE_Sign1 receipt: ${(e as Error).message}`, signature_valid: false, key_id: null, claims: null, leaf: null, hashes_valid: null, chain_valid: null, inclusion_valid: null, inclusion_status: null, onchain_root: null, onchain_status: null, key_source: null, key_status: null, reason: null };
  }
  // A payload that decodes to something other than a map of claims (null, an array, a number) is not a receipt, and
  // every check below reads claims: refused as a malformed request (R5-22: it was a 500 with a stack in the log).
  if (!inspected.claims || typeof inspected.claims !== "object" || Array.isArray(inspected.claims)) fail(400, "The COSE payload is not a map of receipt claims.", "invalid_request");
  const keyId = inspected.keyId ?? "";
  const key = keyId ? await ctx.signer.publicKey(keyId) : null;
  const onchainKey = key ? await ctx.chain.signingKeyOnChain(key.publicKeyHex).catch(() => null) : null;
  const pubHex = onchainKey ? onchainKey.publicKey.slice(2) : key?.publicKeyHex;
  const signatureValid = !!pubHex && verifyCoseWithRawKey(cose, pubHex);
  const claims = inspected.claims;
  const strip = (h: string) => h.replace(/^sha256:/, "").toLowerCase();
  let hashes: boolean | null = null;
  if (r.request_sha256 != null || r.response_sha256 != null) {
    hashes = (r.request_sha256 == null || strip(r.request_sha256) === strip(claims.req?.h ?? "")) && (r.response_sha256 == null || strip(r.response_sha256) === strip(claims.resp?.h ?? ""));
  }
  let chain: boolean | null = null;
  if (Array.isArray(r.chunks)) chain = typeof claims.resp?.chain === "string" && chainOf(claims.rid, r.chunks).head === claims.resp.chain;
  const leaf = receiptLeafV2(cose);
  const included = await inclusionOf(ctx, leaf, r.anchor, source);
  const { valid: inclusion, onchainRoot, onchainStatus } = included;
  // R4-28: the same rule as for v1 receipts. A v2 call receipt is found by its `rid`; any other kind by its anchor proof.
  const verdict = signatureValid
    ? await signingKeyVerdict(ctx, key, {
        time: typeof claims?.iat === "number" ? claims.iat * 1000 : null, leaf, underOwnRoot: included.own,
        stored: async () => {
          if (typeof claims?.rid !== "string") return null;
          const [g] = await ctx.db.select({ leaf: generations.receiptLeafV2 }).from(generations).where(eq(generations.id, claims.rid));
          return g?.leaf ?? null;
        },
      })
    : { status: key ? (key.retiredAt ? ("retired" as const) : ("current" as const)) : null, ok: true, reason: null };
  return {
    version: 2,
    signature_valid: signatureValid,
    key_id: keyId || null,
    key_source: onchainKey ? "chain" : key ? "router" : null,
    key_retired_at: key?.retiredAt?.toISOString() ?? null,
    key_status: verdict.status,
    reason: verdict.reason,
    claims,
    leaf,
    hashes_valid: hashes,
    chain_valid: chain,
    inclusion_valid: inclusion,
    inclusion_status: included.status,
    onchain_root: onchainRoot,
    onchain_status: onchainStatus,
    valid: signatureValid && claims?.v === 2 && hashes !== false && chain !== false && inclusion !== false && verdict.ok,
  };
}

export { and };
