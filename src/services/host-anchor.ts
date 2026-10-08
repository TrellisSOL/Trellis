import { recordInvalidHostReceipt } from "../network/slashing.ts";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { idHash, type Hex } from "../lib/hash.ts";
import type { Ctx } from "../context.ts";
import { hostAnchorLeaves, hostAnchors, kv, providers } from "../db/schema.ts";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { loadTlsPins, type TlsPin } from "../providers/tls-pin.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, verifyWithRawKey } from "../receipts/signer.ts";
import { log, sha256 } from "../lib/util.ts";
import { MEMO_PROGRAM_ID, hostRootMemo, parseMemo } from "../solana/anchor-memo.ts";
import { hostRootPda, receiptRootHour } from "../solana/programs/anchor.ts";
import { MEMO_CONFLICT, MEMO_LATE, anchorPostingConfigured, anchorSettings, anchorerLines, auditQuietly, postMemoLine, type MemoPostOutcome } from "./anchor.ts";
import { hex32 } from "../solana/programs/encoding.ts";
import { normalizeSidecarReport, parseTdxQuote } from "./attestor.ts";
import { bindingsCommittedIn } from "./measurements.ts";

// Per-host anchoring of enclave receipts (spec 0004 Section 5.2). Off unless HOST_ANCHOR_ENABLED.
//
// Every interval, for each attested host (a provider whose sidecar the attestor proved and pinned: its certificate
// names the SHA-256 of a boot quote that verified, and that quote binds the certificate's key), the job:
//   1. reads the host's boot /attest document over the pinned connection and takes the receipt key from its bindings,
//      but only if SHA-256 of the quote it serves is the attestation reference the router verified and the quote's
//      report_data commits to those bindings. That key is the receipt key bound in the router-verified attestation;
//   2. pulls the sidecar's queued receipt leaves (GET /anchor/leaves, the host's anchor token) and keeps a leaf only
//      if its receipt verifies under that key, names that attestation reference, is not marked simulated, and its
//      leaf recomputes from the signed bytes. Every other leaf is discarded and counted;
//   3. builds one Merkle tree (the router anchor's tree: sorted-pair sha256) over the
//      new leaves, in the order the sidecar queued them, and stores the root with the attestation reference and key;
//   4. acknowledges what it pulled (POST /anchor/ack), so the sidecar drops it;
//   5. posts the root as trellis_anchor::post_host_root(sha256(provider id), hour, root, count) where the anchor
//      program and the anchorer key are configured (one HostRoot account per host and hour, keyed like the router's
//      own ReceiptRoot by the hour that closed the window). Otherwise the root is kept off chain with status "local",
//      exactly like the router's own hourly roots, and proofs say anchored: false. With ANCHOR_MODE=memo the root is
//      posted as one memo line signed by the anchorer instead (`trellis:hostroot:v1:...`, src/solana/anchor-memo.ts):
//      no account, no rent, and the job itself keeps it to one line per host and hour. A memo root is "confirmed"
//      only once its transaction is finalized, "late" when it landed after the lateness bound, "conflict" when the
//      anchorer key already signed another root for the host and hour.
// A root covers the leaves collected from one host, under one attestation, in [from_ts, to_ts): from the previous
// root's end to the moment this one was built. With a chain configured a host gets at most one root per hour (the
// program holds one account per (host, hour)); leaves that arrive after the hour's root was built wait for the next
// hour in the sidecar's queue. Like any anchor it proves inclusion, not a receipt's time or that it is unique, and
// leaves a host withholds from its feed are not covered.

export const HOST_ANCHOR_PAGE = 1000; // the sidecar's largest page
const MAX_PAGES = 200; // at most 200 000 leaves per host per run; the rest wait for the next run
const RID = /^rcpt_[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type SidecarReceipt = { payload: Record<string, unknown>; sig: string; key_id: string; alg: string; leaf: string };
export type QueuedLeaf = { seq: number; leaf: string; id: string; ts: number; receipt: SidecarReceipt };
/** The receipt key bound in a host's router-verified attestation. */
export type HostBinding = { attestationRef: string; receiptPublicKey: string; receiptKeyId: string };

/** A host's sidecar, as the job talks to it. The default goes over the provider's pinned connection. */
export type LeafFeed = {
  /** The boot attestation document (GET /attest, no nonce). */
  attest(): Promise<unknown>;
  pull(afterSeq: number, limit: number): Promise<{ leaves: QueuedLeaf[]; head: number }>;
  ack(throughSeq: number): Promise<void>;
};

/** Where roots are posted. The default calls trellis_anchor::post_host_root with the anchorer key. */
export type AttestedAnchorChain = {
  configured(): boolean;
  /** post_host_root(provider_id_hash, hour, root, count); rejects when the program already holds that (host, hour). */
  postHostRoot(providerIdHash: Hex, hour: number, root: Hex, count: number): Promise<{ hash: string; slot: number | null }>;
  /** The HostRoot already on chain for (host, hour), with the signature that created it when known, or null. */
  hostRoot(providerIdHash: Hex, hour: number): Promise<{ root: Hex; count: number; tx: string | null } | null>;
  /** Set by the memo implementation: the key whose signature makes a line a root. Recorded beside each posted root. */
  memoAnchorer?: () => string;
  /**
   * Set by the memo implementation: post the line by signature and say what became of it (final, sent and not final
   * yet, or in conflict with another line of the anchorer), and how late a line may land.
   */
  memoPost?: (providerIdHash: Hex, hour: number, root: Hex, count: number) => Promise<MemoPostOutcome>;
  memoMaxLateSeconds?: () => number;
  /** Set by the memo implementation: read a bounded part of the anchorer's history before posting. */
  audit?: () => Promise<unknown>;
};

/** The on-chain hour a host root is posted under: the hour containing the last second of its window (`receiptRootHour`). */
export const hostAnchorHour = (a: { toTs: Date }) => receiptRootHour(Math.floor(a.toTs.getTime() / 1000));

export type HostAnchorOptions = {
  chain?: AttestedAnchorChain;
  feed?: (provider: typeof providers.$inferSelect, pin: TlsPin, token: string) => LeafFeed;
};

/** The sidecar's key id: the first 16 hex characters of SHA-256 of the raw public key. */
export const sidecarKeyId = (publicKeyHex: string) => sha256(Buffer.from(publicKeyHex, "hex")).slice(0, 16);

/** The on-chain provider id: sha256 of the provider id's bytes, as the other programs use it. */
export const providerIdHash = (providerId: string) => idHash(providerId);

/**
 * The receipt key a host's boot document binds, accepted only if the document's quote is the one the router verified
 * (its SHA-256 is the pinned attestation reference) and that quote's report_data commits to the bindings.
 */
export function bindingFromBootDocument(verifiedRef: string, document: unknown): { ok: true; binding: HostBinding } | { ok: false; reason: string } {
  if (!HEX64.test(verifiedRef)) return { ok: false, reason: "the router holds no verified attestation reference for this host" };
  if (!document || typeof document !== "object") return { ok: false, reason: "the attestation document is not an object" };
  const r = normalizeSidecarReport(document as Record<string, any>);
  if (r.type !== "trellis.sidecar.attestation") return { ok: false, reason: "not a sidecar attestation document" };
  if (r.kind === "dev" || typeof r.intel_quote !== "string") return { ok: false, reason: "the document carries no hardware quote" };
  const quote = r.intel_quote.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(quote) || sha256(Buffer.from(quote, "hex")) !== verifiedRef) return { ok: false, reason: "the quote served is not the one the router verified" };
  let reportData: string;
  try {
    reportData = parseTdxQuote(quote).reportData;
  } catch (e) {
    return { ok: false, reason: `unparseable quote: ${(e as Error).message}` };
  }
  if (!bindingsCommittedIn(reportData, r.sidecar_bindings)) return { ok: false, reason: "the bindings are not committed in the verified quote" };
  const key = String((r.sidecar_bindings as Record<string, unknown>).receipt_pubkey ?? "").toLowerCase();
  if (!HEX64.test(key)) return { ok: false, reason: "the bindings carry no receipt key" };
  return { ok: true, binding: { attestationRef: verifiedRef, receiptPublicKey: key, receiptKeyId: sidecarKeyId(key) } };
}

/** Why a queued leaf is discarded, or null when it verifies under the host's bound receipt key. */
export function checkLeaf(item: unknown, b: HostBinding): string | null {
  const q = item as Partial<QueuedLeaf> | null;
  const env = q?.receipt as Partial<SidecarReceipt> | undefined;
  if (!env || typeof env !== "object" || typeof env.sig !== "string" || !env.payload || typeof env.payload !== "object") return "malformed";
  const p = env.payload;
  if (p.type !== "trellis.sidecar.receipt" || typeof p.id !== "string" || !RID.test(p.id) || typeof p.ts !== "number" || !(p.ts > 0 && p.ts < 8.64e15)) return "malformed";
  if (env.alg !== "Ed25519" || env.key_id !== b.receiptKeyId) return "unbound_key";
  if (!verifyWithRawKey(p, env.sig, b.receiptPublicKey)) return "bad_signature";
  const leaf = receiptLeaf(canonicalBytes(p), Buffer.from(env.sig, "base64")).toLowerCase();
  if (leaf !== String(env.leaf ?? "").toLowerCase() || leaf !== String(q?.leaf ?? "").toLowerCase()) return "leaf_mismatch";
  if (p.attestation_ref !== b.attestationRef) return "other_attestation";
  if (p.dev !== false) return "simulated";
  return null;
}

/** The sidecar endpoint next to its /attest path (so a path prefix in front of the sidecar is kept). */
function sidecarUrl(attestationUrl: string, path: string) {
  const u = new URL(attestationUrl);
  u.search = "";
  u.pathname = u.pathname.endsWith("/attest") ? u.pathname.slice(0, -"/attest".length) + path : path;
  return u;
}

/** The provider's sidecar over the connection its attested certificate is pinned to. */
export function pinnedLeafFeed(ctx: Ctx, p: typeof providers.$inferSelect, pin: TlsPin, token: string): LeafFeed {
  const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production, tlsPin: { certPem: pin.certPem, spkiSha256: pin.spkiSha256 } };
  const auth = { authorization: `Bearer ${token}`, accept: "application/json" };
  const call = async (url: URL, init: RequestInit = {}, maxBytes?: number) => {
    const res = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init }, policy);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${url.pathname} answered HTTP ${res.status}`);
    }
    return boundedJson(res, maxBytes);
  };
  return {
    attest: () => {
      const boot = new URL(p.attestationUrl!);
      boot.searchParams.delete("nonce");
      return call(boot, { headers: { accept: "application/json" } });
    },
    pull: async (after, limit) => {
      const url = sidecarUrl(p.attestationUrl!, "/anchor/leaves");
      url.searchParams.set("after", String(after));
      url.searchParams.set("limit", String(limit));
      const page = (await call(url, { headers: auth }, 16 * 1024 * 1024)) as { leaves?: unknown; head?: unknown };
      if (!Array.isArray(page?.leaves) || typeof page.head !== "number") throw new Error("the leaf feed answered with an unexpected shape");
      return { leaves: page.leaves as QueuedLeaf[], head: page.head };
    },
    ack: async (through) => {
      await call(sidecarUrl(p.attestationUrl!, "/anchor/ack"), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ through_seq: through }) });
    },
  };
}

/**
 * Host roots as memo lines (ANCHOR_MODE=memo): `trellis:hostroot:v1:<network>:<provider id hash>:<hour>:<count>:<root>`
 * signed by the anchorer key, posted and followed by signature exactly like the router's own roots (`postMemoLine`,
 * src/services/anchor.ts). The line on chain for a (host, hour) is the earliest one the ANCHORER signed, read from its
 * own finalized transaction: memo text in the anchorer's signature list is never believed, so a stranger's transaction
 * with the same text is neither this host's root nor a conflict with it (security review round 3, R3-03).
 */
export function memoAnchorChain(ctx: Ctx): AttestedAnchorChain {
  const network = ctx.cfg.chain.network;
  const lineOf = (providerId: Hex, hour: number, root: Hex, count: number) => hostRootMemo({ network, providerIdHash: providerId, hour: Number(hour), count, root });
  return {
    configured: () => anchorPostingConfigured(ctx),
    memoAnchorer: () => ctx.chain.wallet("anchorer").keypair.publicKey.toBase58(),
    memoPost: (providerId, hour, root, count) => postMemoLine(ctx, lineOf(providerId, hour, root, count)),
    memoMaxLateSeconds: () => anchorSettings(ctx).maxLateSeconds,
    audit: () => auditQuietly(ctx),
    postHostRoot: async (providerId, hour, root, count) => {
      const r = await postMemoLine(ctx, lineOf(providerId, hour, root, count));
      if (r.state === "conflict") throw new Error("the anchorer already posted a different root for this host and hour");
      if (r.state === "sent") throw new Error("the host root was sent and is not final yet");
      return { hash: r.hash, slot: r.slot };
    },
    hostRoot: async (providerId, hour) => {
      const [first] = await anchorerLines(ctx, `hostroot:${providerId.replace(/^0x/, "").toLowerCase()}:${Number(hour)}`);
      const line = first ? parseMemo(first.text) : null;
      return first && line?.kind === "hostroot" ? { root: `0x${line.root}` as Hex, count: line.count, tx: first.signature } : null;
    },
  };
}

/**
 * Host roots on chain: trellis_anchor's HostRoot accounts (src/solana/programs/anchor.ts), one per (sha256 of the
 * provider id, hour), posted by the anchorer key. Configured when the anchor program and that key are. In memo mode
 * the roots go out as memo lines instead (`memoAnchorChain`).
 */
export function receiptAnchorChain(ctx: Ctx): AttestedAnchorChain {
  if (anchorSettings(ctx).mode === "memo") return memoAnchorChain(ctx);
  return {
    configured: () => !!(ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")),
    postHostRoot: (providerId, hour, root, count) => ctx.chain.postHostRoot(providerId, hour, root, count),
    hostRoot: async (providerId, hour) => {
      const r = await ctx.chain.hostRootOnChain(providerId, hour);
      if (!r) return null;
      let tx: string | null = null;
      try {
        const sigs = await ctx.chain.connection.getSignaturesForAddress(hostRootPda(ctx.chain.programId("receiptAnchor"), hex32(providerId), hour), { limit: 1 }, ctx.chain.commitment);
        tx = sigs[0]?.signature ?? null;
      } catch { /* the root is on chain; its signature is a nicety */ }
      return { root: r.root as Hex, count: r.count, tx };
    },
  };
}

/** A root posted as a memo line is remembered as such, with the key that signed it: its proof names both. */
const hostPostKey = (id: number) => `host-anchor-post:${id}`;
async function recordPost(ctx: Ctx, chain: AttestedAnchorChain, id: number) {
  if (!chain.memoAnchorer) return;
  const value = { mode: "memo", anchorer: chain.memoAnchorer() };
  await ctx.db.insert(kv).values({ key: hostPostKey(id), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

/**
 * Post one root. Program mode: an hour the program already holds for this host is read back: the same root means an
 * earlier post landed (the row is confirmed); a different one can never be posted (the row stays "local", proofs still
 * verify against the router) and is reported. Memo mode: the line is posted and followed by signature; the row is
 * confirmed only once that transaction is finalized, "late" when it landed after the lateness bound, and "conflict"
 * (alarmed on every pass, never posted over) when the anchorer's earliest line for the host and hour is another root.
 */
async function post(ctx: Ctx, chain: AttestedAnchorChain, a: { id: number; providerId: string; root: string; count: number; toTs: Date }) {
  const hour = hostAnchorHour(a);
  const pid = providerIdHash(a.providerId);
  try {
    if (chain.memoPost) {
      const r = await chain.memoPost(pid, hour, a.root as Hex, a.count);
      if (r.state === "sent") return { status: "pending" as const, tx: null, block: null, anchor_index: null, hour };
      if (r.state === "conflict") {
        log.error(MEMO_CONFLICT, { host_root: a.id, provider: a.providerId, hour, existing: r.existing, note: "this host root is kept and NOT posted; the row stays in conflict" });
        await ctx.db.update(hostAnchors).set({ status: "conflict" }).where(eq(hostAnchors.id, a.id));
        return { status: "conflict" as const, tx: null, block: null, anchor_index: null, hour };
      }
      await recordPost(ctx, chain, a.id);
      if (r.conflicts.length) log.error(MEMO_CONFLICT, { host_root: a.id, provider: a.providerId, hour, existing: r.conflicts[0], note: "this router's line is the earliest; the anchorer key also signed another root for the host and hour later" });
      const late = r.blockTime == null || r.blockTime > hour + 3_600 + (chain.memoMaxLateSeconds?.() ?? 0);
      if (late) log.error(MEMO_LATE, { host_root: a.id, provider: a.providerId, hour, landed: r.blockTime, transaction: r.hash });
      const status = late ? ("late" as const) : ("confirmed" as const);
      await ctx.db.update(hostAnchors).set({ status, txHash: r.hash, blockNumber: r.slot, chainIndex: null }).where(eq(hostAnchors.id, a.id));
      return { status, tx: r.hash, block: r.slot, anchor_index: null, hour };
    }
    const existing = await chain.hostRoot(pid, hour);
    if (existing) {
      if (existing.root.toLowerCase().replace(/^0x/, "") === a.root.toLowerCase().replace(/^0x/, "")) {
        await recordPost(ctx, chain, a.id);
        await ctx.db.update(hostAnchors).set({ status: "confirmed", txHash: existing.tx, blockNumber: null, chainIndex: null }).where(eq(hostAnchors.id, a.id));
        return { status: "confirmed" as const, tx: existing.tx, block: null, anchor_index: null, hour };
      }
      log.warn("host root hour already taken on chain by another root; the root is kept locally", { root: a.id, provider: a.providerId, hour });
      await ctx.db.update(hostAnchors).set({ status: "local" }).where(eq(hostAnchors.id, a.id));
      return { status: "local" as const, tx: null, block: null, anchor_index: null, hour };
    }
    const r = await chain.postHostRoot(pid, hour, a.root as Hex, a.count);
    await recordPost(ctx, chain, a.id);
    await ctx.db.update(hostAnchors).set({ status: "confirmed", txHash: r.hash, blockNumber: r.slot, chainIndex: null }).where(eq(hostAnchors.id, a.id));
    return { status: "confirmed" as const, tx: r.hash, block: r.slot, anchor_index: null, hour };
  } catch (e) {
    log.error("host anchor submission failed; will retry", { root: a.id, provider: a.providerId, error: (e as Error).message });
    return { status: "pending" as const, tx: null, block: null, anchor_index: null, hour };
  }
}

/** Collect, verify, root and (where configured) post one host's leaves. */
export async function anchorHost(ctx: Ctx, p: typeof providers.$inferSelect, pin: TlsPin, feed: LeafFeed, chain: AttestedAnchorChain) {
  let document: unknown;
  try {
    document = await feed.attest();
  } catch (e) {
    return { skipped: `attestation document unreachable: ${(e as Error).message}` };
  }
  const bound = bindingFromBootDocument(pin.attestationRef, document);
  if (!bound.ok) return { skipped: bound.reason };
  const b = bound.binding;

  const collectedFrom = new Date();
  if (chain.configured()) {
    // One HostRoot per (host, hour) on chain: a second root in the hour of the host's latest one waits for the next hour.
    const [latest] = await ctx.db.select({ toTs: hostAnchors.toTs }).from(hostAnchors).where(eq(hostAnchors.providerId, p.id)).orderBy(desc(hostAnchors.toTs)).limit(1);
    if (latest && hostAnchorHour(latest) === hostAnchorHour({ toTs: collectedFrom })) return { skipped: "this hour's root is already built; leaves wait for the next hour", hour: hostAnchorHour(latest) };
  }
  const kept: { leaf: string; id: string; ts: number }[] = [];
  const discarded: Record<string, number> = {};
  const seen = new Set<string>();
  let after = 0;
  let pulled = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await feed.pull(after, HOST_ANCHOR_PAGE);
    let advanced = false;
    for (const item of r.leaves) {
      const seq = Number((item as Partial<QueuedLeaf>)?.seq);
      if (!Number.isSafeInteger(seq) || seq <= after) continue; // never move the cursor backwards
      after = seq;
      advanced = true;
      pulled++;
      const reason = checkLeaf(item, b);
      if (reason) {
        await recordInvalidHostReceipt(ctx, p.id, item, b, reason);
        discarded[reason] = (discarded[reason] ?? 0) + 1;
        continue;
      }
      const leaf = item.leaf.toLowerCase();
      if (seen.has(leaf)) continue;
      seen.add(leaf);
      kept.push({ leaf, id: item.receipt.payload.id as string, ts: item.receipt.payload.ts as number });
    }
    if (!advanced || r.leaves.length < HOST_ANCHOR_PAGE || after >= r.head) break;
  }
  if (Object.keys(discarded).length) log.warn("host anchor discarded leaves", { provider: p.id, discarded });

  // A leaf already rooted (an earlier acknowledgement did not reach the sidecar) is not rooted twice.
  const known = new Set<string>();
  for (let i = 0; i < kept.length; i += 1000) {
    const rows = await ctx.db
      .select({ leaf: hostAnchorLeaves.leaf })
      .from(hostAnchorLeaves)
      .where(and(eq(hostAnchorLeaves.providerId, p.id), inArray(hostAnchorLeaves.leaf, kept.slice(i, i + 1000).map((k) => k.leaf))));
    for (const r of rows) known.add(r.leaf);
  }
  const fresh = kept.filter((k) => !known.has(k.leaf));

  let root: { id: number; root: string; count: number; toTs: Date; window: { from: string; to: string } } | null = null;
  if (fresh.length) {
    const tree = new MerkleTree(fresh.map((k) => k.leaf as Hex));
    const [last] = await ctx.db.select({ toTs: hostAnchors.toTs }).from(hostAnchors).where(eq(hostAnchors.providerId, p.id)).orderBy(desc(hostAnchors.toTs)).limit(1);
    // Half-open and non-overlapping: this root starts where the host's last one ended, and every leaf in it was
    // collected at or after that and before its end.
    const fromTs = last?.toTs ?? collectedFrom;
    const collectedAt = new Date(Math.max(collectedFrom.getTime(), fromTs.getTime()));
    const toTs = new Date(Math.max(Date.now(), collectedAt.getTime() + 1));
    const id = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(hostAnchors)
        .values({ providerId: p.id, attestationRef: b.attestationRef, receiptKeyId: b.receiptKeyId, receiptPublicKey: b.receiptPublicKey, root: tree.root, fromTs, toTs, count: fresh.length, status: chain.configured() ? "pending" : "local" })
        .returning({ id: hostAnchors.id });
      for (let i = 0; i < fresh.length; i += 1000)
        await tx.insert(hostAnchorLeaves).values(fresh.slice(i, i + 1000).map((k, j) => ({ providerId: p.id, leaf: k.leaf, anchorId: row.id, leafIndex: i + j, receiptId: k.id, receiptTs: new Date(k.ts), collectedAt })));
      return row.id;
    });
    root = { id, root: tree.root, count: fresh.length, toTs, window: { from: fromTs.toISOString(), to: toTs.toISOString() } };
  }

  // Everything pulled is now either rooted or discarded, so the sidecar may drop it.
  let acked = false;
  if (pulled) {
    try {
      await feed.ack(after);
      acked = true;
    } catch (e) {
      log.warn("host anchor acknowledgement failed; the leaves are pulled again next time", { provider: p.id, error: (e as Error).message });
    }
  }

  const base = { attestation_ref: b.attestationRef, receipt_key_id: b.receiptKeyId, pulled, rooted: fresh.length, discarded, acked };
  if (!root) return { ...base, root: null };
  const { toTs: _toTs, ...reported } = root;
  const onchain = chain.configured() ? await post(ctx, chain, { id: root.id, providerId: p.id, root: root.root, count: root.count, toTs: root.toTs }) : null;
  return { ...base, root: { ...reported, ...(onchain ?? { status: "local", tx: null, block: null, anchor_index: null, hour: null }) } };
}

/**
 * Roots built and not on chain. Attested anchors have no ordering rule, so each is retried alone. Program mode retries
 * `pending` rows. Memo mode also looks again at rows in `conflict` (and alarms again), and at `local` rows whose host
 * and hour have no other root of this router, so a row that an unverified look-alike line once pushed aside is posted.
 */
export async function retryHostAnchors(ctx: Ctx, chain: AttestedAnchorChain = receiptAnchorChain(ctx)) {
  if (!chain.configured()) return { retried: 0 };
  const memo = !!chain.memoPost;
  const rows = await ctx.db.select().from(hostAnchors).where(memo ? inArray(hostAnchors.status, ["pending", "conflict", "local"]) : eq(hostAnchors.status, "pending")).orderBy(hostAnchors.id).limit(100);
  let retried = 0;
  for (const a of rows) {
    if (a.status === "local") {
      // One line per host and hour: a root kept off chain beside another root of the same hour stays where it is.
      const siblings = await ctx.db.select({ id: hostAnchors.id, toTs: hostAnchors.toTs }).from(hostAnchors).where(eq(hostAnchors.providerId, a.providerId));
      if (siblings.some((s) => s.id !== a.id && hostAnchorHour(s) === hostAnchorHour(a))) continue;
    }
    const status = (await post(ctx, chain, a)).status;
    if (status === "confirmed" || status === "late") retried++;
  }
  return { retried };
}

/** The `host-anchor` job: every attested host with a pinned certificate and an anchor token, then retries. */
export async function runHostAnchor(ctx: Ctx, opts: HostAnchorOptions = {}) {
  const chain = opts.chain ?? receiptAnchorChain(ctx);
  const makeFeed = opts.feed ?? ((p, pin, token) => pinnedLeafFeed(ctx, p, pin, token));
  if (chain.configured()) await chain.audit?.();
  const retry = await retryHostAnchors(ctx, chain);
  const pins = await loadTlsPins(ctx.db);
  const rows = await ctx.db.select().from(providers).where(and(inArray(providers.status, ["shadow", "live"]), isNotNull(providers.attestationUrl))).orderBy(providers.id);
  const hosts: Record<string, unknown> = {};
  for (const p of rows) {
    const pin = pins.get(p.id);
    // Only a sidecar the attestor proved has a certificate pin (an attested gateway's key-only pin is not one).
    if (!pin || !pin.certPem || pin.spkiOnly) continue;
    const token = ctx.cfg.hostAnchor.tokens[p.id];
    if (!p.attested) hosts[p.id] = { skipped: "not attested now" };
    // The pin only binds an https connection; the anchor token never goes anywhere else.
    else if (!p.attestationUrl!.startsWith("https://")) hosts[p.id] = { skipped: "the attestation endpoint is not https" };
    else if (!token) hosts[p.id] = { skipped: "no anchor token configured for this host" };
    else {
      try {
        hosts[p.id] = await anchorHost(ctx, p, pin, makeFeed(p, pin, token), chain);
      } catch (e) {
        log.error("host anchor failed", { provider: p.id, error: (e as Error).message });
        hosts[p.id] = { error: (e as Error).message };
      }
    }
  }
  return { hosts, ...retry };
}

// ---- Proofs ------------------------------------------------------------------------------------------------

const trees = new Map<string, MerkleTree>();

async function hostTree(ctx: Ctx, anchor: { id: number; root: string }) {
  const key = `${anchor.id}:${anchor.root}`;
  const hit = trees.get(key);
  if (hit) return hit;
  const rows = await ctx.db.select({ leaf: hostAnchorLeaves.leaf, leafIndex: hostAnchorLeaves.leafIndex }).from(hostAnchorLeaves).where(eq(hostAnchorLeaves.anchorId, anchor.id)).orderBy(hostAnchorLeaves.leafIndex);
  const tree = new MerkleTree(rows.map((r) => r.leaf as Hex));
  if (tree.root.toLowerCase() !== anchor.root.toLowerCase()) throw new Error(`host anchor ${anchor.id} does not rebuild to its stored root`);
  trees.set(key, tree);
  if (trees.size > 32) trees.delete(trees.keys().next().value as string);
  return tree;
}

/** The leaf of a sidecar receipt envelope, or null when the envelope is malformed. */
export function leafOfReceipt(receipt: unknown): string | null {
  const r = receipt as Partial<SidecarReceipt> | null;
  if (!r || typeof r !== "object" || !r.payload || typeof r.payload !== "object" || typeof r.sig !== "string") return null;
  return receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64")).toLowerCase();
}

/** Everything a verifier needs for one collected leaf, or null when no host root holds it. */
export async function hostAnchorProof(ctx: Ctx, leaf: string) {
  const [l] = await ctx.db.select().from(hostAnchorLeaves).where(eq(hostAnchorLeaves.leaf, leaf.toLowerCase())).limit(1);
  if (!l) return null;
  const [a] = await ctx.db.select().from(hostAnchors).where(eq(hostAnchors.id, l.anchorId));
  if (!a) return null;
  const tree = await hostTree(ctx, a);
  return {
    rid: l.receiptId,
    leaf: l.leaf,
    rooted: true,
    anchored: a.status === "confirmed" && !!a.txHash,
    status: a.status,
    provider: a.providerId,
    provider_id_hash: providerIdHash(a.providerId),
    attestation_ref: a.attestationRef,
    receipt_key: { key_id: a.receiptKeyId, public_key: a.receiptPublicKey },
    root_id: a.id,
    root: a.root,
    leaf_index: l.leafIndex,
    proof: tree.proof(l.leafIndex),
    count: a.count,
    window: { from: a.fromTs.toISOString(), to: a.toTs.toISOString() },
    anchor_index: a.chainIndex,
    anchor_hour: a.status === "confirmed" || a.status === "late" ? hostAnchorHour(a) : null,
    tx: a.txHash,
    block: a.blockNumber,
    chain: ctx.cfg.chain.id,
    contract: ctx.cfg.chain.receiptAnchor ?? null,
    ...(await hostPostFields(ctx, a)),
  };
}

/**
 * How a posted host root can be checked without the router: the mode it was posted in and, for a memo line, the line
 * and the key that signed it (remembered when it was posted; the line itself is a function of the row).
 */
async function hostPostFields(ctx: Ctx, a: typeof hostAnchors.$inferSelect) {
  const posted = (a.status === "confirmed" || a.status === "late") && !!a.txHash;
  const [post] = posted ? await ctx.db.select().from(kv).where(eq(kv.key, hostPostKey(a.id))) : [];
  const memo = (post?.value as { mode?: string; anchorer?: string } | undefined)?.mode === "memo";
  return {
    mode: !posted ? null : memo ? ("memo" as const) : ("program" as const),
    anchorer: memo ? (post!.value as { anchorer: string }).anchorer : null,
    memo: memo ? hostRootMemo({ network: ctx.cfg.chain.network, providerIdHash: providerIdHash(a.providerId), hour: hostAnchorHour(a), count: a.count, root: a.root }) : null,
    memo_program: memo ? MEMO_PROGRAM_ID.toBase58() : null,
    network: ctx.cfg.chain.network,
  };
}
