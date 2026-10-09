import { validSidecarBindingVersion } from "../network/sidecar-binding-version.ts";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { hash256, idHash, type Hex } from "../lib/hash.ts";
import type { Ctx } from "../context.ts";
import { measurementBundles, measurements } from "../db/schema.ts";
import type { Role } from "../solana/chain-service.ts";
import { hex32, toHex0x } from "../solana/programs/encoding.ts";
import { measurementSpec, pendingMeasurementSpec, registrySpec } from "../solana/account-specs.ts";
import { MAX_LABEL_BYTES, MEASUREMENT_KINDS, MEASUREMENT_PROPOSAL_TTL_SECONDS, REVOKE_REASONS, cancelMeasurementProposalIx, kindCode, measurementPda, measurementsIdl, pendingMeasurementPda, proposeMeasurementIx, proposeReinstateIx, registerIx, registryPda, reinstateIx, revokeIx, type Measurement, type MeasurementKind, type PendingMeasurement, type RevokeReason } from "../solana/programs/measurements.ts";
import { withRetry } from "../solana/rpc.ts";
import { buildFloor } from "../solana/build-profile.ts";
import { isVerifiedAccountError, readVerifiedAccount, verifyAccountInfo } from "../solana/verified-account.ts";
import { canonicalJson, log, sha256 } from "../lib/util.ts";
import { boundedJson } from "../providers/network.ts";

// Measurements: the image, compose and model digests a provider's confidential endpoint runs.
//
//   1. The attestor records a row only from a hardware quote a configured verifier accepted whose report_data
//      commits to the digests (recordMeasurement). No simulated or unverified attestation creates a row.
//   2. The Rekor watcher looks the image digest up in the Sigstore transparency log and checks the entry's
//      Merkle inclusion proof (and, when REKOR_PUBLIC_KEY is set, the log's signed checkpoint). It does not check
//      who signed the entry.
//   3. The keeper prepares trellis_measurements instructions (programs/trellis_measurements, the MeasurementRegistry of
//      docs/Trellis_Backend.md §3.2) for rows that are both attested and logged: one entry per digest the quote
//      committed to. Registering takes two steps a day apart (security review round 3): propose_measurement announces
//      an entry, register puts it on the allow-list once the program's 24 h timelock has run. The registry's authority
//      signs both (a Squads 2-of-3 in production); the keeper sends them itself only with MEASUREMENTS_ONCHAIN_SUBMIT
//      and a role key that is that authority.
//
// A measurement is identified by (provider, image digest, compose hash). A provider has at most one current row, the
// one its latest verified quote committed to; when a verified quote commits to other digests (a redeploy with a new
// compose file, say), that becomes a new row and the previous one is superseded, never rewritten or deleted, so its
// history and its log entry stay as they were. Superseded rows are history: they are not looked up, not given
// calldata, and never presented as what a provider runs now.
//
// Status: observed -> ready -> registered (only once the registry itself reports it attested) -> revoked.

export type FetchFn = typeof fetch;
export type Digests = { imageDigest: Hex; composeHash: Hex; modelDigest: Hex };

export const providerIdHash = (id: string): Hex => idHash(id);
const sha256Bytes = (v: Uint8Array | string) => createHash("sha256").update(v).digest();

/** "sha256:<64 hex>", "0x<64 hex>" or bare hex to 0x-prefixed lowercase bytes32; null when it is none of those. */
export function normalizeDigest(v: unknown): Hex | null {
  if (typeof v !== "string") return null;
  const m = /^(?:sha256:|0x)?([0-9a-fA-F]{64})$/.exec(v.trim());
  return m ? (`0x${m[1].toLowerCase()}` as Hex) : null;
}

// ---- Sidecar bindings -----------------------------------------------------------------------------------

/** Read the three digests out of a sidecar bindings object; null when any is missing or malformed. */
export function digestsFromBindings(bindings: unknown): Digests | null {
  if (!bindings || typeof bindings !== "object") return null;
  const b = bindings as Record<string, unknown>;
  const imageDigest = normalizeDigest(b.image_digest);
  const composeHash = normalizeDigest(b.compose_hash);
  const modelDigest = normalizeDigest(b.model_digest);
  return imageDigest && composeHash && modelDigest ? { imageDigest, composeHash, modelDigest } : null;
}

/** The sidecar puts sha256(canonical_json(bindings)) in the first 32 bytes of the quote's report_data. */
export function bindingsCommittedIn(reportDataHex: string, bindings: unknown): boolean {
  if (!validSidecarBindingVersion(bindings)) return false;
  return reportDataHex.toLowerCase().startsWith(sha256(canonicalJson(bindings)));
}

// ---- Rows ------------------------------------------------------------------------------------------------

export type RecordInput = {
  providerId: string;
  digests: Digests;
  verifiers: string[];
  teeKind: string | null;
  quoteHex: string;
  reportHash: string;
};

export type RecordResult = {
  /** created: a new row; seen: an existing row, now current; conflict: nothing recorded (see below). */
  status: "created" | "seen" | "conflict";
  id: number;
  /** Rows of this provider that stopped being current because of this quote. */
  superseded: number[];
};

/**
 * Record (or refresh) a measurement seen in a verified attestation, and make it the provider's current one.
 *
 * The same image digest and compose hash refresh the existing row (and make it current again if it had been
 * superseded, as after a rollback to an earlier compose file). Any other image digest or compose hash is a new row,
 * and the provider's previous current row is marked superseded by it. A change of the digests a provider runs is
 * logged as a warning; the attestation history records it as a measurement change as well.
 *
 * A different model digest under an image digest and compose hash that already have a row is a conflict: that row is
 * not rewritten and nothing is recorded, and since no recorded measurement describes the quote, the provider is left
 * with no current measurement until a verified quote matches one again.
 */
export async function recordMeasurement(ctx: Ctx, input: RecordInput): Promise<RecordResult> {
  const quote = input.quoteHex.replace(/^0x/, "").toLowerCase();
  const d = input.digests;
  const now = new Date();
  const result = await ctx.db.transaction(async (tx) => {
    // The provider's rows, locked, so two attestor runs cannot both decide which one is current.
    const rows = await tx.select().from(measurements).where(eq(measurements.providerId, input.providerId)).orderBy(asc(measurements.id)).for("update");
    const current = rows.filter((r) => !r.supersededAt).map((r) => r.id);
    const supersede = async (ids: number[], by: number | null) => {
      if (ids.length) await tx.update(measurements).set({ supersededAt: now, supersededBy: by, updatedAt: now }).where(and(inArray(measurements.id, ids), isNull(measurements.supersededAt)));
      return ids;
    };
    const same = rows.find((r) => r.imageDigest === d.imageDigest && r.composeHash === d.composeHash);
    if (same && same.modelDigest !== d.modelDigest) return { status: "conflict" as const, id: same.id, superseded: await supersede(current, null) };
    let id: number;
    let status: "created" | "seen";
    if (same) {
      await tx.update(measurements).set({ lastSeenAt: now, supersededAt: null, supersededBy: null, updatedAt: now }).where(eq(measurements.id, same.id));
      [id, status] = [same.id, "seen"];
    } else {
      const [created] = await tx
        .insert(measurements)
        .values({
          providerId: input.providerId,
          imageDigest: d.imageDigest,
          composeHash: d.composeHash,
          modelDigest: d.modelDigest,
          verifier: input.verifiers.join(","),
          teeKind: input.teeKind,
          quote,
          quoteProofHash: hash256(`0x${quote}`),
          reportHash: input.reportHash,
          attestedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: measurements.id });
      if (created) [id, status] = [created.id, "created"];
      else {
        const [raced] = await tx.select({ id: measurements.id }).from(measurements).where(and(eq(measurements.providerId, input.providerId), eq(measurements.imageDigest, d.imageDigest), eq(measurements.composeHash, d.composeHash)));
        [id, status] = [raced!.id, "seen"];
      }
    }
    return { status, id, superseded: await supersede(current.filter((c) => c !== id), id) };
  });
  const where = { provider: input.providerId, image: d.imageDigest, compose: d.composeHash, model: d.modelDigest };
  if (result.status === "conflict") log.warn("provider reports a different model digest under an image and compose hash it already has a measurement for; nothing recorded, and it has no current measurement", { ...where, superseded: result.superseded });
  else if (result.superseded.length) log.warn("provider's verified quote commits to digests other than its current measurement; recorded as its current measurement, the previous one kept as history", { ...where, id: result.id, superseded: result.superseded });
  return result;
}

// ---- Rekor -----------------------------------------------------------------------------------------------

export type RekorEntry = {
  uuid: string;
  body: string; // base64 canonical entry
  kind: string | null;
  logIndex: number | null;
  integratedTime: number | null;
  inclusionProof: { logIndex: number; treeSize: number; rootHash: string; hashes: string[]; checkpoint?: string } | null;
  /** The log's identifier and its signed entry timestamp, when the entry carries them. */
  logId?: string | null;
  signedEntryTimestamp?: string | null;
};

const HEX = /^[0-9a-fA-F]+$/;

/** RFC 6962/9162 Merkle audit path check. */
export function verifyInclusionProof(leafHash: Buffer, leafIndex: bigint, treeSize: bigint, hashes: Buffer[], rootHash: Buffer): boolean {
  if (leafIndex < 0n || leafIndex >= treeSize) return false;
  let fn = leafIndex;
  let sn = treeSize - 1n;
  let r = leafHash;
  for (const p of hashes) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = sha256Bytes(Buffer.concat([Buffer.from([1]), p, r]));
      if ((fn & 1n) === 0n) while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = sha256Bytes(Buffer.concat([Buffer.from([1]), r, p]));
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(rootHash);
}

/** True when the entry's body is included in the tree its own inclusion proof describes. */
export function entryIncluded(e: RekorEntry): boolean {
  const p = e.inclusionProof;
  if (!p || !HEX.test(p.rootHash) || p.hashes.some((h) => !HEX.test(h)) || !Number.isSafeInteger(p.logIndex) || !Number.isSafeInteger(p.treeSize)) return false;
  const leaf = sha256Bytes(Buffer.concat([Buffer.from([0]), Buffer.from(e.body, "base64")]));
  return verifyInclusionProof(leaf, BigInt(p.logIndex), BigInt(p.treeSize), p.hashes.map((h) => Buffer.from(h, "hex")), Buffer.from(p.rootHash, "hex"));
}

/** Verify the signed checkpoint ("signed note") of an entry's inclusion proof against a known log key, and that it
 *  commits to the same tree size and root as the proof. ECDSA P-256 / SHA-256, as Rekor signs. */
export function checkpointSigned(e: RekorEntry, publicKeyPem: string): boolean {
  const p = e.inclusionProof;
  if (!p?.checkpoint) return false;
  const split = p.checkpoint.indexOf("\n\n");
  if (split < 0) return false;
  const note = p.checkpoint.slice(0, split + 1);
  const lines = note.split("\n");
  if (Number(lines[1]) !== p.treeSize || Buffer.from(lines[2] ?? "", "base64").toString("hex") !== p.rootHash.toLowerCase()) return false;
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  for (const line of p.checkpoint.slice(split + 2).split("\n")) {
    if (!line.startsWith("— ")) continue;
    const raw = Buffer.from(line.split(" ")[2] ?? "", "base64");
    if (raw.length <= 4) continue;
    try {
      if (cryptoVerify("sha256", Buffer.from(note), key, raw.subarray(4))) return true;
    } catch {
      /* next signature line */
    }
  }
  return false;
}

/** Verify an entry's signed entry timestamp (SET) against the log's key: an ECDSA P-256 / SHA-256 signature over the
 *  canonical JSON of { body, integratedTime, logID, logIndex }, as Rekor v1 issues when it accepts an entry. */
export function setSigned(e: RekorEntry, publicKeyPem: string): boolean {
  if (!e.signedEntryTimestamp || !e.logId || e.integratedTime == null || e.logIndex == null) return false;
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  const payload = canonicalJson({ body: e.body, integratedTime: e.integratedTime, logID: e.logId, logIndex: e.logIndex });
  try {
    return cryptoVerify("sha256", Buffer.from(payload), key, Buffer.from(e.signedEntryTimestamp, "base64"));
  } catch {
    return false;
  }
}

async function rekorJson(f: FetchFn, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Rekor HTTP ${res.status}`);
  return boundedJson(res, 4 * 1024 * 1024);
}

/** Entry UUIDs Rekor has indexed under this image digest. */
export async function rekorSearch(f: FetchFn, baseUrl: string, imageDigest: Hex): Promise<string[]> {
  const r = await rekorJson(f, `${baseUrl}/api/v1/index/retrieve`, { method: "POST", body: JSON.stringify({ hash: `sha256:${imageDigest.slice(2)}` }) });
  return Array.isArray(r) ? r.filter((u): u is string => typeof u === "string" && /^[0-9a-f]{64,80}$/i.test(u)) : [];
}

/** The entry exactly as the log returned it, keyed by nothing: `{ body, integratedTime, logID, logIndex, verification }`. */
export type RawRekorEntry = Record<string, any>;

export async function rekorEntryRaw(f: FetchFn, baseUrl: string, uuid: string): Promise<RawRekorEntry | null> {
  const r = (await rekorJson(f, `${baseUrl}/api/v1/log/entries/${uuid}`)) as Record<string, any> | null;
  const raw = r && typeof r === "object" ? Object.values(r)[0] : null;
  return raw && typeof raw === "object" && typeof (raw as RawRekorEntry).body === "string" ? (raw as RawRekorEntry) : null;
}

export function parseRekorEntry(uuid: string, raw: RawRekorEntry): RekorEntry {
  let kind: string | null = null;
  try {
    kind = String(JSON.parse(Buffer.from(raw.body, "base64").toString("utf8")).kind ?? "") || null;
  } catch {
    /* body is opaque to us */
  }
  const ip = raw.verification?.inclusionProof;
  return {
    uuid,
    body: raw.body,
    kind,
    logIndex: Number.isSafeInteger(raw.logIndex) ? raw.logIndex : null,
    integratedTime: Number.isSafeInteger(raw.integratedTime) ? raw.integratedTime : null,
    inclusionProof: ip && typeof ip.rootHash === "string" && Array.isArray(ip.hashes) ? { logIndex: Number(ip.logIndex), treeSize: Number(ip.treeSize), rootHash: ip.rootHash, hashes: ip.hashes.map(String), checkpoint: typeof ip.checkpoint === "string" ? ip.checkpoint : undefined } : null,
    logId: typeof raw.logID === "string" ? raw.logID : null,
    signedEntryTimestamp: typeof raw.verification?.signedEntryTimestamp === "string" ? raw.verification.signedEntryTimestamp : null,
  };
}

export async function rekorEntry(f: FetchFn, baseUrl: string, uuid: string): Promise<RekorEntry | null> {
  const raw = await rekorEntryRaw(f, baseUrl, uuid);
  return raw ? parseRekorEntry(uuid, raw) : null;
}

const MAX_ENTRIES_PER_DIGEST = 5;

/** Look up the image digest of every observed current row in Rekor. A row becomes ready with the earliest entry whose
 *  inclusion proof verifies. Errors are recorded per row and never move a row backwards. Superseded rows are history
 *  and are not looked up. */
export async function watchRekor(ctx: Ctx, opts: { fetchImpl?: FetchFn; limit?: number } = {}) {
  const f = opts.fetchImpl ?? fetch;
  const { rekorUrl, rekorPublicKey } = ctx.cfg.measurements;
  const rows = await ctx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.status, "observed"), isNull(measurements.revokedAt), isNull(measurements.supersededAt)))
    .orderBy(sql`${measurements.rekorCheckedAt} asc nulls first`, asc(measurements.id))
    .limit(opts.limit ?? 25);
  let ready = 0;
  let missing = 0;
  let failed = 0;
  for (const row of rows) {
    const now = new Date();
    try {
      const uuids = (await rekorSearch(f, rekorUrl, row.imageDigest as Hex)).slice(0, MAX_ENTRIES_PER_DIGEST);
      const entries: RekorEntry[] = [];
      let unverifiable = 0;
      for (const uuid of uuids) {
        const e = await rekorEntry(f, rekorUrl, uuid);
        if (e && entryIncluded(e)) entries.push(e);
        else unverifiable++;
      }
      entries.sort((a, b) => (a.integratedTime ?? Infinity) - (b.integratedTime ?? Infinity) || (a.logIndex ?? Infinity) - (b.logIndex ?? Infinity));
      const hit = entries[0];
      if (!hit) {
        missing++;
        await ctx.db.update(measurements).set({ rekorCheckedAt: now, rekorError: uuids.length ? `no entry with a verifiable inclusion proof (${unverifiable} unverifiable)` : null, updatedAt: now }).where(eq(measurements.id, row.id));
        continue;
      }
      await ctx.db
        .update(measurements)
        .set({
          status: "ready",
          rekorUuid: hit.uuid,
          rekorEntry: `0x${hit.uuid.slice(-64).toLowerCase()}`,
          rekorLogIndex: hit.logIndex,
          rekorKind: hit.kind,
          rekorIntegratedAt: hit.integratedTime != null ? new Date(hit.integratedTime * 1000) : null,
          rekorInclusionVerified: true,
          rekorCheckpointVerified: rekorPublicKey ? checkpointSigned(hit, rekorPublicKey) : false,
          rekorCheckedAt: now,
          rekorError: null,
          updatedAt: now,
        })
        .where(and(eq(measurements.id, row.id), eq(measurements.status, "observed")));
      ready++;
    } catch (e) {
      failed++;
      log.warn("rekor lookup failed", { provider: row.providerId, error: (e as Error).message });
      await ctx.db.update(measurements).set({ rekorCheckedAt: now, rekorError: (e as Error).message.slice(0, 200), updatedAt: now }).where(eq(measurements.id, row.id));
    }
  }
  return { checked: rows.length, ready, missing, failed };
}

// ---- Registry (trellis_measurements) ---------------------------------------------------------------------

type Row = typeof measurements.$inferSelect;

/** One allow-list entry: a kind and a 0x-prefixed 32-byte digest. */
export type RegistryRef = { kind: MeasurementKind; digest: Hex };
/** An entry as the registry holds it; live while `revokedAt` is null. Times are unix seconds. */
export type RegistryEntry = RegistryRef & { address: string; label: string; policyVersion: number; registeredAt: number; revokedAt: number | null };

function registryProgram(ctx: Ctx): PublicKey {
  const id = ctx.cfg.measurements.registry;
  if (!id) throw new Error("no measurement registry is configured (TRELLIS_MEASUREMENTS_PROGRAM_ID)");
  return new PublicKey(id);
}

function refOf(r: RegistryRef): RegistryRef {
  const digest = normalizeDigest(r.digest);
  if (!digest) throw new Error("not a sha256 digest");
  kindCode(r.kind);
  return { kind: r.kind, digest };
}

// Entries as last read from chain, kept per connection for MEASUREMENT_REGISTRY_CACHE_MS so that a caller asking about
// the same digests in a burst costs one read. A missing entry is remembered as missing for the same time. The router's
// own writes drop the entries they touch; the measurement job always reads fresh.
const entryCache = new WeakMap<object, Map<string, { at: number; entry: RegistryEntry | null }>>();
const cacheOf = (ctx: Ctx) => {
  let m = entryCache.get(ctx.chain.connection);
  if (!m) entryCache.set(ctx.chain.connection, (m = new Map()));
  return m;
};
const cacheKey = (programId: PublicKey, r: RegistryRef) => `${programId.toBase58()}:${r.kind}:${r.digest}`;

/** Drop what is remembered of these entries (all of them without `refs`), so the next read asks the chain. */
export function forgetRegistryEntries(ctx: Ctx, refs?: RegistryRef[]) {
  const cache = cacheOf(ctx);
  if (!refs) return cache.clear();
  const programId = registryProgram(ctx);
  for (const r of refs) cache.delete(cacheKey(programId, refOf(r)));
}

/** The registry's entries for `refs`, in order; null where the registry has no such entry. Each is read by its PDA
 *  (["measurement", [kind], digest]); an account that is not the program's, or does not hold that kind and digest, counts
 *  as missing. `fresh` skips what is remembered. Throws when the chain cannot be read. */
export async function readRegistryEntries(ctx: Ctx, refs: RegistryRef[], o: { fresh?: boolean } = {}): Promise<(RegistryEntry | null)[]> {
  const programId = registryProgram(ctx);
  const cache = cacheOf(ctx);
  const ttl = ctx.cfg.measurements.registryCacheMs;
  const wanted = refs.map(refOf);
  const out: (RegistryEntry | null)[] = new Array(wanted.length).fill(null);
  const need: number[] = [];
  const now = Date.now();
  wanted.forEach((r, i) => {
    const hit = o.fresh ? undefined : cache.get(cacheKey(programId, r));
    if (hit && now - hit.at < ttl) out[i] = hit.entry;
    else need.push(i);
  });
  for (let at = 0; at < need.length; at += 100) {
    const batch = need.slice(at, at + 100);
    const keys = batch.map((i) => measurementPda(programId, wanted[i]!.kind, hex32(wanted[i]!.digest)));
    const infos = await withRetry(() => ctx.chain.connection.getMultipleAccountsInfo(keys, ctx.cfg.solana.commitment));
    batch.forEach((i, n) => {
      const ref = wanted[i]!;
      const info = infos[n];
      // An entry counts only when the registry program owns it at the PDA of its own (kind, digest) (TR-02).
      let m: Measurement | null = null;
      try { m = verifyAccountInfo(keys[n]!, info, measurementSpec(programId)); } catch { m = null; }
      const entry: RegistryEntry | null =
        m && m.kind === ref.kind && toHex0x(m.digest) === ref.digest
          ? { kind: m.kind, digest: ref.digest, address: keys[n]!.toBase58(), label: m.label, policyVersion: m.policyVersion, registeredAt: Number(m.registeredAt), revokedAt: m.revokedAt === null ? null : Number(m.revokedAt) }
          : null;
      cache.set(cacheKey(programId, ref), { at: Date.now(), entry });
      out[i] = entry;
    });
  }
  return out;
}

export const registryEntry = async (ctx: Ctx, kind: MeasurementKind, digest: Hex, o: { fresh?: boolean } = {}) => (await readRegistryEntries(ctx, [{ kind, digest }], o))[0] ?? null;

/** A registration or reinstatement the authority proposed and has not applied yet. Times are unix seconds. */
export type RegistryProposal = RegistryRef & { address: string; label: string; policyVersion: number; reinstate: boolean; proposedAt: number; effectiveAt: number; expiresAt: number };

/**
 * The pending proposals for `refs`, in order; null where there is none. Read from the chain every time (a proposal is
 * short-lived and what the keeper does next depends on it); an account that is not the program's, or is not the
 * proposal of that kind and digest, counts as none. Throws when the chain cannot be read.
 */
export async function readRegistryProposals(ctx: Ctx, refs: RegistryRef[]): Promise<(RegistryProposal | null)[]> {
  const programId = registryProgram(ctx);
  const wanted = refs.map(refOf);
  // How long a proposal stays applicable is compiled into the program (7 days; minutes on a devnet build).
  const payer = (["keeper", "router", "settlement", "anchorer"] as Role[]).map((r) => ctx.chain.roleAddress(r)).find(Boolean);
  const ttl = wanted.length ? await buildFloor(ctx.chain.connection, measurementsIdl.at(programId), payer, "proposalTtl", MEASUREMENT_PROPOSAL_TTL_SECONDS, ctx.cfg.solana.commitment) : MEASUREMENT_PROPOSAL_TTL_SECONDS;
  const out: (RegistryProposal | null)[] = [];
  for (let at = 0; at < wanted.length; at += 100) {
    const batch = wanted.slice(at, at + 100);
    const keys = batch.map((r) => pendingMeasurementPda(programId, r.kind, hex32(r.digest)));
    const infos = await withRetry(() => ctx.chain.connection.getMultipleAccountsInfo(keys, ctx.cfg.solana.commitment));
    batch.forEach((ref, n) => {
      let p: PendingMeasurement | null = null;
      try { p = verifyAccountInfo(keys[n]!, infos[n], pendingMeasurementSpec(programId)); } catch { p = null; }
      out.push(p && p.kind === ref.kind && toHex0x(p.digest) === ref.digest
        ? { kind: p.kind, digest: ref.digest, address: keys[n]!.toBase58(), label: p.label, policyVersion: p.policyVersion, reinstate: p.reinstate, proposedAt: Number(p.proposedAt), effectiveAt: Number(p.effectiveAt), expiresAt: Number(p.effectiveAt) + ttl }
        : null);
    });
  }
  return out;
}

/** The Registry account: its authority and counters, or null when the program is not initialised. */
export async function readRegistry(ctx: Ctx): Promise<{ address: string; authority: string; registered: bigint; revoked: bigint } | null> {
  const programId = registryProgram(ctx);
  const address = registryPda(programId);
  const r = await readVerifiedAccount(ctx.chain.connection, address, registrySpec(programId), ctx.cfg.solana.commitment).catch((e) => { if (isVerifiedAccountError(e)) return null; throw e; });
  return r ? { address: address.toBase58(), authority: r.authority.toBase58(), registered: r.registered, revoked: r.revoked } : null;
}

/**
 * Whether the registry allows these digests, by the rule a Graft host starts under (docs/Trellis_Backend.md §3.2): the
 * model digest and the compose hash are both registered and neither is revoked. The compose file pins every image by
 * digest, so the image needs no entry of its own; when the registry does hold one for it (kind os_image), a revoked one
 * refuses the measurement as well. Entries are global: the registry does not know providers.
 */
export async function isAttested(ctx: Ctx, d: { modelDigest: Hex; composeHash: Hex; imageDigest?: Hex | null }, o: { fresh?: boolean } = {}): Promise<boolean> {
  const refs: RegistryRef[] = [{ kind: "model_digest", digest: d.modelDigest }, { kind: "compose_hash", digest: d.composeHash }];
  if (d.imageDigest) refs.push({ kind: "os_image", digest: d.imageDigest });
  const [model, compose, image] = await readRegistryEntries(ctx, refs, o);
  const live = (e: RegistryEntry | null | undefined) => !!e && e.revokedAt === null;
  return live(model) && live(compose) && !(image && image.revokedAt !== null);
}

// ---- Registry instructions -------------------------------------------------------------------------------

/** An instruction in a form any signer can rebuild: the program, the accounts in order and the data (base64). */
export type PreparedInstruction = { program_id: string; accounts: { pubkey: string; is_signer: boolean; is_writable: boolean }[]; data: string };
const prepared = (ix: TransactionInstruction): PreparedInstruction => ({
  program_id: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), is_signer: k.isSigner, is_writable: k.isWritable })),
  data: Buffer.from(ix.data).toString("base64"),
});

export type RegistrationEntry = RegistryRef & { label: string; policyVersion: number };
/**
 * Where an entry stands on its way into the registry, and so what the authority signs for it now:
 *   propose   nothing is on chain: propose_measurement
 *   wait      proposed, the 24 h timelock is still running: nothing to sign until `effectiveAt`
 *   register  proposed and the timelock has run: register
 *   expired   proposed, never registered, past its 7 days: cancel_measurement_proposal (then it is proposed again)
 */
export type RegistrationStep = "propose" | "wait" | "register" | "expired";
export type RegistrationPlan = RegistrationEntry & { step: RegistrationStep; effectiveAt?: number };
export const REGISTER_FORMAT = "trellis.measurements.register/2";

/**
 * The registry entries a measurement stands for: the model digest, the compose hash and the image digest its quote
 * committed to and, when its transparency-log entry is a signed measurement bundle, the sidecar source tarball that
 * bundle pins. Each entry's label is the hash of the measurement's transparency-log entry (64 hex), which is how an
 * entry on chain points back at the public record it was published in.
 */
export function registryEntriesFor(row: Pick<Row, "imageDigest" | "composeHash" | "modelDigest" | "rekorEntry">, o: { policyVersion?: number; sidecarSource?: Hex | null } = {}): RegistrationEntry[] {
  if (!row.rekorEntry) throw new Error("measurement has no transparency-log entry");
  const label = row.rekorEntry.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(label) || Buffer.byteLength(label) > MAX_LABEL_BYTES) throw new Error("the measurement's transparency-log entry is not a 32-byte hash");
  const policyVersion = o.policyVersion ?? 1;
  const refs: RegistryRef[] = [
    { kind: "model_digest", digest: row.modelDigest as Hex },
    { kind: "compose_hash", digest: row.composeHash as Hex },
    { kind: "os_image", digest: row.imageDigest as Hex },
    ...(o.sidecarSource ? [{ kind: "sidecar_source" as const, digest: o.sidecarSource }] : []),
  ];
  return refs.map((r) => {
    const ref = refOf(r);
    if (/^0x0{64}$/.test(ref.digest)) throw new Error(`the measurement's ${ref.kind} is all zeros, which the registry refuses`);
    return { ...ref, label, policyVersion };
  });
}

/** propose_measurement for each entry: step 1, which changes nothing on the allow-list. */
export function buildProposeInstructions(programId: PublicKey, authority: PublicKey, entries: RegistrationEntry[]): TransactionInstruction[] {
  return entries.map((e) => proposeMeasurementIx(programId, { authority, kind: e.kind, digest: hex32(e.digest), label: e.label, policyVersion: e.policyVersion }));
}
/** register for each entry: step 2, which the program accepts once the entry's proposal has waited out its timelock. */
export function buildRegisterInstructions(programId: PublicKey, authority: PublicKey, entries: RegistryRef[]): TransactionInstruction[] {
  return entries.map((e) => registerIx(programId, { authority, kind: e.kind, digest: hex32(e.digest) }));
}
/** What the authority signs now for a plan: a proposal, a registration, the clearing of an expired proposal, or nothing yet. */
export function buildPlanInstructions(programId: PublicKey, authority: PublicKey, plan: RegistrationPlan[]): TransactionInstruction[] {
  return plan.flatMap((e) => e.step === "propose" ? buildProposeInstructions(programId, authority, [e])
    : e.step === "register" ? buildRegisterInstructions(programId, authority, [e])
    : e.step === "expired" ? [cancelMeasurementProposalIx(programId, { signer: authority, authority, kind: e.kind, digest: hex32(e.digest) })]
    : []);
}

const registerDocument = (programId: PublicKey, authority: PublicKey, plan: RegistrationPlan[], ixs: TransactionInstruction[]) =>
  canonicalJson({
    format: REGISTER_FORMAT,
    program: programId.toBase58(),
    authority: authority.toBase58(),
    entries: plan.map((e) => ({
      kind: e.kind, digest: e.digest, label: e.label, policy_version: e.policyVersion, step: e.step, effective_at: e.effectiveAt ?? null,
      address: measurementPda(programId, e.kind, hex32(e.digest)).toBase58(), proposal: pendingMeasurementPda(programId, e.kind, hex32(e.digest)).toBase58(),
    })),
    instructions: ixs.map(prepared),
  });

export type RegisterTarget = {
  /** The trellis_measurements program. */
  programId: PublicKey | string;
  /** The registry's authority: the signer every instruction names. */
  authority: PublicKey | string;
  policyVersion?: number;
  sidecarSource?: Hex | null;
  /** Build for these entries only (the ones the registry does not hold yet). Default: every entry of the row. */
  only?: RegistryRef[];
  /** Where entries stand (from the chain's pending proposals). Default: nothing is proposed yet, so every entry is at `propose`. */
  steps?: (RegistryRef & { step: RegistrationStep; effectiveAt?: number })[];
};

/**
 * The prepared registration of a measurement, as the keeper stores it in `calldata`: a JSON document naming the program,
 * the authority that must sign, the entries with the step each is at, and the instructions the authority signs NOW:
 * propose_measurement for an entry nothing is proposed for, register for one whose proposal has waited out the 24 h
 * timelock, nothing for one still waiting (accounts in order, data in base64). The keeper rebuilds the document as the
 * entries move from one step to the next. Nothing in it is signed and it carries no blockhash: the authority (a Squads
 * 2-of-3 in production) puts the instructions in a transaction of its own. decodeRegisterCalldata reads it back.
 */
export function buildRegisterCalldata(row: Pick<Row, "imageDigest" | "composeHash" | "modelDigest" | "rekorEntry">, o: RegisterTarget): string {
  let entries = registryEntriesFor(row, o);
  if (o.only) {
    const keep = new Set(o.only.map((r) => `${r.kind}:${refOf(r).digest}`));
    entries = entries.filter((e) => keep.has(`${e.kind}:${e.digest}`));
  }
  const steps = new Map((o.steps ?? []).map((x) => [`${x.kind}:${refOf(x).digest}`, x]));
  const plan: RegistrationPlan[] = entries.map((e) => { const at = steps.get(`${e.kind}:${e.digest}`); return { ...e, step: at?.step ?? "propose", effectiveAt: at?.effectiveAt }; });
  const programId = new PublicKey(o.programId);
  const authority = new PublicKey(o.authority);
  return registerDocument(programId, authority, plan, buildPlanInstructions(programId, authority, plan));
}

/**
 * Read a prepared registration back. `entries` are the ones the document carries an instruction for, read from the
 * instruction data itself through the program's IDL, not from the document's own summary: kind, digest, label and
 * policy version for a proposal; kind and digest for a registration or a cancellation (their label and policy version
 * are the ones announced in the proposal on chain; the document's summary of them is given for reference). `waiting`
 * are the entries the document says are still inside their timelock, for which there is nothing to sign.
 */
export function decodeRegisterCalldata(text: string): { program: string; authority: string; entries: (RegistrationEntry & { step: RegistrationStep })[]; waiting: (RegistrationEntry & { effectiveAt: number | null })[]; instructions: TransactionInstruction[] } {
  type Summary = { kind: MeasurementKind; digest: Hex; label: string; policy_version: number; step: RegistrationStep; effective_at: number | null };
  const doc = JSON.parse(text) as { format?: string; program: string; authority: string; entries?: Summary[]; instructions: PreparedInstruction[] };
  if (doc.format !== REGISTER_FORMAT || !Array.isArray(doc.instructions)) throw new Error("not a prepared measurement registration");
  const summary = new Map((doc.entries ?? []).map((e) => [`${e.kind}:${e.digest}`, e]));
  const instructions = doc.instructions.map((i) => ({ programId: new PublicKey(i.program_id), keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.is_signer, isWritable: a.is_writable })), data: Buffer.from(i.data, "base64") }) as TransactionInstruction);
  const STEP: Record<string, RegistrationStep> = { propose_measurement: "propose", register: "register", cancel_measurement_proposal: "expired" };
  const entries = instructions.map((ix) => {
    const decoded = measurementsIdl.coder.instruction.decode(ix.data);
    const step = decoded ? STEP[decoded.name] : undefined;
    if (!decoded || !step) throw new Error("a prepared instruction is not a trellis_measurements registration step");
    const a = decoded.data as { kind: number; digest: number[]; label?: string; policy_version?: number };
    const kind = MEASUREMENT_KINDS[a.kind];
    if (!kind) throw new Error("a prepared instruction names an unknown measurement kind");
    const digest = toHex0x(Uint8Array.from(a.digest));
    const said = summary.get(`${kind}:${digest}`);
    return { kind, digest, label: a.label ?? said?.label ?? "", policyVersion: a.policy_version ?? said?.policy_version ?? 0, step };
  });
  const waiting = (doc.entries ?? []).filter((e) => e.step === "wait").map((e) => ({ kind: e.kind, digest: e.digest, label: e.label, policyVersion: e.policy_version, effectiveAt: e.effective_at }));
  return { program: doc.program, authority: doc.authority, entries, waiting, instructions };
}

/**
 * Whether a prepared registration says its entries are already proposed on chain (waiting out the registry's 24 h
 * timelock, or past it and ready to be registered). Nothing is on the allow-list yet in either case. False for a
 * document that is not a prepared registration.
 */
export function registrationProposed(calldata: string): boolean {
  try {
    const doc = JSON.parse(calldata) as { format?: string; entries?: { step?: string }[] };
    return doc.format === REGISTER_FORMAT && Array.isArray(doc.entries) && doc.entries.some((e) => e.step === "wait" || e.step === "register");
  } catch {
    return false;
  }
}

/** The configured role, when its key is the registry's authority (one operator key holds every authority until the
 *  Squads multisig takes over; from then on no router key matches and nothing below signs). */
function authorityRole(ctx: Ctx, authority: string): Role | null {
  const role = ctx.cfg.measurements.authorityRole as Role;
  return ctx.chain.roleAddress(role) === authority ? role : null;
}

export type RegistryActionResult =
  | { submitted: true; hash: string; address: string }
  /** No key of this router is the registry's authority: the instruction for that authority to sign. */
  | { submitted: false; address: string; authority: string; instruction: PreparedInstruction };

async function registryAction(ctx: Ctx, ref: RegistryRef, build: (programId: PublicKey, authority: PublicKey, ref: RegistryRef) => TransactionInstruction): Promise<RegistryActionResult> {
  const programId = registryProgram(ctx);
  const entry = refOf(ref);
  const registry = await readRegistry(ctx);
  if (!registry) throw new Error("the measurement registry is not initialised");
  const ix = build(programId, new PublicKey(registry.authority), entry);
  const address = measurementPda(programId, entry.kind, hex32(entry.digest)).toBase58();
  const role = authorityRole(ctx, registry.authority);
  if (!role) return { submitted: false, address, authority: registry.authority, instruction: prepared(ix) };
  const { hash } = await ctx.chain.send(role, [ix]);
  forgetRegistryEntries(ctx, [entry]);
  return { submitted: true, hash, address };
}

/** trellis_measurements::propose_measurement for one entry: step 1 of a registration. Sent when this router holds the
 *  registry's authority key, else returned as an instruction for the authority. The program refuses an entry that
 *  exists, live or revoked, and a second proposal while one is pending. Nothing is on the allow-list yet. */
export const proposeMeasurement = (ctx: Ctx, e: RegistryRef & { label: string; policyVersion?: number }) =>
  registryAction(ctx, e, (programId, authority, ref) => proposeMeasurementIx(programId, { authority, kind: ref.kind, digest: hex32(ref.digest), label: e.label, policyVersion: e.policyVersion ?? ctx.cfg.measurements.policyVersion }));

/** trellis_measurements::register for one entry: step 2, which the program accepts once the entry's proposal has waited
 *  out the 24 h timelock (and for 7 days after that). The entry goes on the allow-list as it was announced. */
export const registerMeasurement = (ctx: Ctx, e: RegistryRef) =>
  registryAction(ctx, e, (programId, authority, ref) => registerIx(programId, { authority, kind: ref.kind, digest: hex32(ref.digest) }));

/** trellis_measurements::revoke, at once: the entry stays on chain, stamped revoked, and every measurement that needs it
 *  stops counting as attested at the next read-back. */
export const revokeMeasurement = (ctx: Ctx, e: RegistryRef & { reason?: RevokeReason | number }) =>
  registryAction(ctx, e, (programId, authority, ref) => {
    const reasonCode = typeof e.reason === "number" ? e.reason : REVOKE_REASONS.indexOf(e.reason ?? "unspecified");
    return revokeIx(programId, { authority, kind: ref.kind, digest: hex32(ref.digest), reasonCode });
  });

/** trellis_measurements::propose_reinstate: step 1 of bringing a revoked entry back; it stays revoked for now. */
export const proposeReinstateMeasurement = (ctx: Ctx, e: RegistryRef) =>
  registryAction(ctx, e, (programId, authority, ref) => proposeReinstateIx(programId, { authority, kind: ref.kind, digest: hex32(ref.digest) }));

/** trellis_measurements::reinstate: step 2, after the timelock of its proposal; the only way a revoked entry is accepted again. */
export const reinstateMeasurement = (ctx: Ctx, e: RegistryRef) =>
  registryAction(ctx, e, (programId, authority, ref) => reinstateIx(programId, { authority, kind: ref.kind, digest: hex32(ref.digest) }));

/** trellis_measurements::cancel_measurement_proposal: the authority drops a pending registration or reinstatement. */
export const cancelMeasurementProposal = (ctx: Ctx, e: RegistryRef) =>
  registryAction(ctx, e, (programId, authority, ref) => cancelMeasurementProposalIx(programId, { signer: authority, authority, kind: ref.kind, digest: hex32(ref.digest) }));

// ---- Keeper ----------------------------------------------------------------------------------------------

/** The sidecar source tarball hash pinned by the verified bundle whose log entry is the row's, when there is one. */
async function sidecarSourceOf(ctx: Ctx, row: Row): Promise<Hex | null> {
  if (!row.rekorUuid) return null;
  const [b] = await ctx.db
    .select({ bundle: measurementBundles.bundle })
    .from(measurementBundles)
    .where(and(eq(measurementBundles.providerId, row.providerId), eq(measurementBundles.composeHash, row.composeHash), eq(measurementBundles.status, "verified"), eq(measurementBundles.rekorUuid, row.rekorUuid)));
  const digest = normalizeDigest((b?.bundle as { source?: { tarball_sha256?: unknown } } | undefined)?.source?.tarball_sha256);
  // An unpublished build pins an all-zero placeholder, which names no source.
  return digest && !/^0x0{64}$/.test(digest) ? digest : null;
}

/** `proposed`: rows a proposal transaction was sent for; `submitted`: rows whose last registration was sent (its
 *  signature is recorded); `waiting`: rows with an entry still inside the 24 h timelock and nothing to sign. */
export type KeeperResult = { built: number; skippedStale: number; proposed: number; waiting: number; submitted: number; target: string | null; reason?: "registry_unreachable" | "registry_not_initialised" };

/**
 * Publish ready measurements to the registry. For every ready current row that is still being attested and has no
 * transaction recorded, the keeper works out which of its entries the registry does not hold yet and where each stands:
 * nothing proposed (propose_measurement), proposed and waiting out the program's 24 h timelock (nothing to sign),
 * proposed and applicable (register), or proposed and expired (cancel, then propose again on the next run). It prepares
 * the instructions the authority signs now (`calldata`; rebuilt whenever that changes, since entries are shared between
 * providers and move from one step to the next). A row whose entries are all on chain needs nothing: the read-back
 * marks it registered. A row with a revoked entry is left alone: a revoked digest comes back only through reinstate.
 *
 * Nothing is sent unless MEASUREMENTS_ONCHAIN_SUBMIT is on and MEASUREMENT_AUTHORITY_ROLE's key is the registry's
 * authority; then the instructions go out in one transaction per row and run. The signature recorded on the row is the
 * one of the transaction that registered its last missing entry: a proposal alone registers nothing.
 */
export async function runKeeper(ctx: Ctx): Promise<KeeperResult> {
  const target = ctx.cfg.measurements.registry;
  const staleBefore = new Date(Date.now() - ctx.cfg.attestation.intervalMs * 3);
  const rows = await ctx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.status, "ready"), isNull(measurements.txHash), isNull(measurements.revokedAt), isNull(measurements.supersededAt)))
    .orderBy(asc(measurements.id));
  const current = rows.filter((r) => r.lastSeenAt >= staleBefore);
  const out: KeeperResult = { built: 0, skippedStale: rows.length - current.length, proposed: 0, waiting: 0, submitted: 0, target };
  if (!current.length || !target) return out;

  const programId = new PublicKey(target);
  const plans: { row: Row; entries: RegistrationEntry[] }[] = [];
  for (const row of current) {
    try {
      plans.push({ row, entries: registryEntriesFor(row, { policyVersion: ctx.cfg.measurements.policyVersion, sidecarSource: await sidecarSourceOf(ctx, row) }) });
    } catch (e) {
      log.warn("measurement cannot be registered", { provider: row.providerId, id: row.id, error: (e as Error).message });
    }
  }
  let registry: Awaited<ReturnType<typeof readRegistry>>;
  try {
    registry = await readRegistry(ctx);
    if (registry) await readRegistryEntries(ctx, plans.flatMap((p) => p.entries), { fresh: true });
  } catch (e) {
    log.warn("registry read failed", { error: (e as Error).message });
    return { ...out, reason: "registry_unreachable" };
  }
  if (!registry) return { ...out, reason: "registry_not_initialised" };
  const authority = new PublicKey(registry.authority);
  const signer = ctx.cfg.measurements.onchainSubmit ? authorityRole(ctx, registry.authority) : null;

  for (const { row, entries } of plans) {
    let held: (RegistryEntry | null)[];
    try {
      held = await readRegistryEntries(ctx, entries);
    } catch (e) {
      log.warn("registry read failed", { provider: row.providerId, error: (e as Error).message });
      continue;
    }
    const revoked = entries.filter((_, i) => held[i] && held[i]!.revokedAt !== null);
    if (revoked.length) {
      log.warn("a digest of this measurement is revoked in the registry; it is not registered again without reinstate", { provider: row.providerId, id: row.id, kinds: revoked.map((e) => e.kind) });
      continue;
    }
    const missing = entries.filter((_, i) => !held[i]);
    if (!missing.length) continue;
    // Where each missing entry stands: the chain's pending proposals, read now, against the chain's clock.
    let plan: RegistrationPlan[];
    try {
      const pending = await readRegistryProposals(ctx, missing);
      const chainNow = pending.some(Boolean) ? await ctx.chain.blockTimestamp() : 0;
      plan = missing.map((e, i): RegistrationPlan => {
        const p = pending[i];
        if (!p) return { ...e, step: "propose" };
        // What will be registered is what was announced: the proposal's label and policy version, whoever proposed it.
        const announced = { ...e, label: p.label, policyVersion: p.policyVersion, effectiveAt: p.effectiveAt };
        return { ...announced, step: chainNow > p.expiresAt ? "expired" : chainNow >= p.effectiveAt ? "register" : "wait" };
      });
    } catch (e) {
      log.warn("registry read failed", { provider: row.providerId, error: (e as Error).message });
      continue;
    }
    const ixs = buildPlanInstructions(programId, authority, plan);
    const calldata = registerDocument(programId, authority, plan, ixs);
    if (calldata !== row.calldata) {
      const now = new Date();
      await ctx.db.update(measurements).set({ calldata, calldataTarget: target, calldataBuiltAt: now, updatedAt: now }).where(eq(measurements.id, row.id));
      out.built++;
    }
    if (plan.some((e) => e.step === "wait")) out.waiting++;
    if (!signer || !ixs.length) continue;
    try {
      const { hash } = await ctx.chain.send(signer, ixs);
      forgetRegistryEntries(ctx, missing);
      if (plan.some((e) => e.step === "propose")) out.proposed++;
      // Only the transaction that registers the row's last missing entry is its registration.
      if (plan.every((e) => e.step === "register")) {
        await ctx.db.update(measurements).set({ txHash: hash, updatedAt: new Date() }).where(and(eq(measurements.id, row.id), eq(measurements.status, "ready"), isNull(measurements.txHash)));
        out.submitted++;
      }
    } catch (e) {
      // The prepared instructions stay; the next run reads the registry again and tries again.
      forgetRegistryEntries(ctx, missing);
      log.warn("measurement registry step was not accepted", { provider: row.providerId, id: row.id, steps: [...new Set(plan.map((p) => p.step))], error: (e as Error).message });
    }
  }
  return out;
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** Record the transaction the registry authority sent with a row's instructions. The row stays "ready" until the
 *  registry itself reports it attested (reconcileRegistry); an operator's word alone never makes a measurement "registered". */
export async function recordSubmission(ctx: Ctx, id: number, txHash: string) {
  if (!SIGNATURE.test(txHash)) throw new Error("txHash must be a base58 transaction signature");
  const done = await ctx.db
    .update(measurements)
    .set({ txHash, updatedAt: new Date() })
    .where(and(eq(measurements.id, id), eq(measurements.status, "ready")))
    .returning({ id: measurements.id });
  if (!done.length) throw new Error("only a ready measurement can have a submission recorded");
}

/** Whether the registry allows a provider's measurement: the image, with this model digest and compose hash. */
export type IsAttestedReader = (providerIdHash: Hex, imageDigest: Hex, modelDigest: Hex, composeHash: Hex) => Promise<boolean>;

/** Read the registry back: a ready row it reports attested becomes registered; a registered row it no longer
 *  reports attested (an entry was revoked) becomes revoked. The default reader is the program itself (isAttested,
 *  read fresh); entries are per digest, so a row counts as registered only when its own model digest and compose hash
 *  are live there. A read that fails leaves the row alone. Skipped without a configured registry. */
export async function reconcileRegistry(ctx: Ctx, read?: IsAttestedReader) {
  const registry = ctx.cfg.measurements.registry;
  if (!registry) return { skipped: "no MEASUREMENT_REGISTRY_ADDRESS" };
  const rows = await ctx.db.select().from(measurements).where(inArray(measurements.status, ["ready", "registered"]));
  let reader = read;
  if (!reader && rows.length) {
    // One batched read of every entry the rows need; the per-row answers below then come from what was just read
    // (or, with the cache off, from a read of their own).
    const refs = rows.flatMap((r): RegistryRef[] => [{ kind: "model_digest", digest: r.modelDigest as Hex }, { kind: "compose_hash", digest: r.composeHash as Hex }, { kind: "os_image", digest: r.imageDigest as Hex }]);
    const prefetched = await readRegistryEntries(ctx, refs, { fresh: true }).then(() => true, (e) => (log.warn("registry read failed", { error: (e as Error).message }), false));
    if (!prefetched) return { registered: 0, revoked: 0 };
    reader = (_provider, imageDigest, modelDigest, composeHash) => isAttested(ctx, { imageDigest, modelDigest, composeHash });
  }
  let registered = 0;
  let revoked = 0;
  for (const row of rows) {
    let attested: boolean;
    try {
      attested = await reader!(providerIdHash(row.providerId), row.imageDigest as Hex, row.modelDigest as Hex, row.composeHash as Hex);
    } catch (e) {
      log.warn("registry read failed", { provider: row.providerId, error: (e as Error).message });
      continue;
    }
    const now = new Date();
    if (row.status === "ready" && attested) {
      await ctx.db.update(measurements).set({ status: "registered", registeredAt: now, updatedAt: now }).where(and(eq(measurements.id, row.id), eq(measurements.status, "ready")));
      registered++;
    } else if (row.status === "registered" && !attested) {
      await ctx.db.update(measurements).set({ status: "revoked", revokedAt: now, updatedAt: now }).where(and(eq(measurements.id, row.id), eq(measurements.status, "registered")));
      revoked++;
    }
  }
  return { registered, revoked };
}

/** The measurement job: Rekor lookups, then the register instructions, then (with a registry configured) the read-back. */
export async function runMeasurements(ctx: Ctx, opts: { fetchImpl?: FetchFn; read?: IsAttestedReader } = {}) {
  if (!ctx.cfg.measurements.enabled) return { skipped: "MEASUREMENTS_ENABLED is false" };
  const rekor = await watchRekor(ctx, { fetchImpl: opts.fetchImpl });
  const keeper = await runKeeper(ctx);
  const registry = await reconcileRegistry(ctx, opts.read);
  return { rekor, keeper, registry };
}

// ---- Public view -----------------------------------------------------------------------------------------

/** The row that describes what a provider is running now: the one its latest verified quote committed to (not
 *  superseded), unless revoked. Rows recorded before rows could be superseded are ordered by when they were last seen. */
export async function currentMeasurement(ctx: Ctx, providerId: string): Promise<Row | null> {
  const rows = await ctx.db.select().from(measurements).where(and(eq(measurements.providerId, providerId), isNull(measurements.supersededAt)));
  const live = rows.filter((r) => r.status !== "revoked").sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || b.id - a.id);
  return live[0] ?? null;
}

/** A provider's superseded measurements, most recently superseded first: history, never what it runs now. */
export async function measurementHistory(ctx: Ctx, providerId: string, limit = 10): Promise<Row[]> {
  return ctx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.providerId, providerId), isNotNull(measurements.supersededAt)))
    .orderBy(desc(measurements.supersededAt), desc(measurements.id))
    .limit(limit);
}
