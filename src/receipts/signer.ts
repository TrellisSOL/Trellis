import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { receiptKeys } from "../db/schema.ts";
import { canonicalJson, decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import { keyPublished } from "../tlog/hooks.ts";
import { coseSign1, decodeCoseSign1, decodeClaims, encodeClaims, receiptLeafV2, COSE_ALG_EDDSA, type ClaimsV2, type KindClaims } from "./v2.ts";

// Ed25519 receipt signing with weekly rotation. Every key ever used stays in receipt_keys
// (public half forever) so old receipts keep verifying; the public keys are also registered
// on-chain in ReceiptAnchor so verification never has to trust this server.
//
// A retired key's private half is erased (security review round 3, R3-29). Verification needs the public half only, so:
//   - the rotation that retires a key clears its `private_key_enc` in the same transaction, and every start and every
//     rotation check clears any retired row that still carries one (rows written before this rule);
//   - a retired row is never decrypted into memory, whatever it still stores;
//   - the process that rotated drops its own copy at once. Another router process (an API replica next to the worker
//     that runs the rotation job) still holds the outgoing key in memory and may sign with it: that is the only
//     overlap. Each process re-reads the current key every `syncMs` (RECEIPT_KEY_SYNC_MS, default one minute) and drops
//     the outgoing one then, so the overlap is bounded by that interval.
// "Erased from memory" means no reference is kept: a KeyObject cannot be overwritten in place, the runtime frees it.

/**
 * How long a copy of the key document (/.well-known/trellis-receipt-keys.json) may be relied on: a day. A verifier
 * that holds an older copy fetches it again, so a copy that misses a key rotation is wrong for a day at most (security
 * review round 3, R3-14, and round 4, R4-12: without an expiry it was wrong for ever).
 */
export const KEY_DOCUMENT_TTL_MS = 24 * 3_600_000;
/**
 * `issued_at` and `expires_at` of the key document. `issued_at` is the start of the current hour, so two copies read
 * in the same hour are the same document (a proof pack carries one beside the route's); a copy is good for the rest of
 * a day from there.
 */
export function keyDocumentWindow(now = Date.now()): { issued_at: string; expires_at: string } {
  const issued = Math.floor(now / 3_600_000) * 3_600_000;
  return { issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + KEY_DOCUMENT_TTL_MS).toISOString() };
}

export type ReceiptKey = { id: string; publicKeyHex: string; privateKey?: KeyObject; publicKey: KeyObject; validFrom: Date; retiredAt: Date | null };

const rawPublic = (pub: KeyObject) => Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
const keyIdOf = (pub: KeyObject) => sha256(rawPublic(pub)).slice(0, 16);
const publicFromRaw = (hex: string) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });

export const canonicalBytes = (payload: unknown) => Buffer.from(canonicalJson(payload));

export class ReceiptSigner {
  private active: ReceiptKey | null = null;
  private cache = new Map<string, ReceiptKey>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Db,
    private secret: string,
    private rotationDays: number,
    private pinnedKey?: string, // base64 PKCS8 DER; disables rotation
    /** How often this process re-reads the current key, which bounds how long it can hold a retired one. 0: never (a caller that rotates itself). */
    private syncMs = 0,
  ) {}

  async init() {
    if (this.pinnedKey) {
      const priv = createPrivateKey({ key: Buffer.from(this.pinnedKey, "base64"), format: "der", type: "pkcs8" });
      if (priv.asymmetricKeyType !== "ed25519") throw new Error("RECEIPT_SIGNING_KEY must be an Ed25519 PKCS8 key.");
      const pub = createPublicKey(priv);
      const id = keyIdOf(pub);
      const publicKeyHex = rawPublic(pub).toString("hex");
      await this.db
        .insert(receiptKeys)
        .values({ id, publicKey: publicKeyHex, validFrom: new Date() })
        .onConflictDoNothing();
      const [row] = await this.db.select().from(receiptKeys).where(eq(receiptKeys.id, id));
      this.active = { id, publicKeyHex, privateKey: priv, publicKey: pub, validFrom: row.validFrom, retiredAt: null };
      await this.eraseRetired();
      return;
    }
    await this.rotateIfDue();
    if (this.syncMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.sync().catch((e) => log.warn("receipt key sync failed", { error: (e as Error).message })), this.syncMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the periodic key sync (the router's shutdown). */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Clear the stored private half of every retired key. Nothing reads it: a retired key only verifies. */
  private async eraseRetired() {
    await this.db.update(receiptKeys).set({ privateKeyEnc: null }).where(and(isNotNull(receiptKeys.retiredAt), isNotNull(receiptKeys.privateKeyEnc)));
  }

  /** Drop every private half this process holds other than the one it signs with; the public half is read again on demand. */
  private forgetPrivate() {
    for (const [id, k] of this.cache) if (k.privateKey && id !== this.active?.id) this.cache.delete(id);
  }

  /**
   * Follow a rotation another process made: sign with the current key and drop the outgoing one. Never creates or
   * retires a key (that stays with `rotateIfDue`), so replicas on their own timers cannot race each other into one.
   */
  async sync(): Promise<{ changed: boolean }> {
    if (this.pinnedKey) return { changed: false };
    const [current] = await this.db.select().from(receiptKeys).where(and(isNull(receiptKeys.retiredAt), isNotNull(receiptKeys.privateKeyEnc))).orderBy(desc(receiptKeys.validFrom)).limit(1);
    if (!current || current.id === this.active?.id) return { changed: false };
    this.active = this.load(current, true);
    this.forgetPrivate();
    return { changed: true };
  }

  /** Create a new key when none is active or the active one is older than the rotation period. */
  async rotateIfDue(force = false): Promise<{ rotated: boolean; key: ReceiptKey }> {
    if (this.pinnedKey && this.active) return { rotated: false, key: this.active };
    const [current] = await this.db
      .select()
      .from(receiptKeys)
      .where(isNull(receiptKeys.retiredAt))
      .orderBy(desc(receiptKeys.validFrom))
      .limit(1);
    const due = !current || !current.privateKeyEnc || force || Date.now() - current.validFrom.getTime() >= this.rotationDays * 86_400_000;
    if (!due) {
      this.active = this.load(current, true);
      this.forgetPrivate();
      await this.eraseRetired();
      return { rotated: false, key: this.active };
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const id = keyIdOf(publicKey);
    const publicKeyHex = rawPublic(publicKey).toString("hex");
    const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const validFrom = new Date();
    await this.db.transaction(async (tx) => {
      // Retired and erased in one step: the outgoing key's row keeps its public half and its window, nothing else. Every
      // key still marked current is retired, not only the newest, so none is left behind with a private half.
      await tx.update(receiptKeys).set({ retiredAt: validFrom, privateKeyEnc: null }).where(isNull(receiptKeys.retiredAt));
      await tx.update(receiptKeys).set({ privateKeyEnc: null }).where(and(isNotNull(receiptKeys.retiredAt), isNotNull(receiptKeys.privateKeyEnc)));
      await tx.insert(receiptKeys).values({ id, publicKey: publicKeyHex, privateKeyEnc: encrypt(this.secret, der), validFrom });
    });
    keyPublished(this.db, "receipt_key"); // transparency log (a no-op unless TLOG_ENABLED)
    this.active = { id, publicKeyHex, privateKey, publicKey, validFrom, retiredAt: null };
    this.cache.set(id, this.active);
    this.forgetPrivate();
    return { rotated: true, key: this.active };
  }

  /** A key from its row. The private half is decrypted only for the key this process is about to sign with (`signing`), and never for a retired row, whatever it still stores. */
  private load(row: typeof receiptKeys.$inferSelect, signing = false): ReceiptKey {
    const cached = this.cache.get(row.id);
    if (cached && cached.retiredAt?.getTime() === row.retiredAt?.getTime() && (!signing || cached.privateKey)) return cached;
    const publicKey = publicFromRaw(row.publicKey);
    const privateKey = signing && row.privateKeyEnc && !row.retiredAt
      ? createPrivateKey({ key: Buffer.from(decrypt(this.secret, row.privateKeyEnc), "base64"), format: "der", type: "pkcs8" })
      : undefined;
    const k = { id: row.id, publicKeyHex: row.publicKey, publicKey, privateKey, validFrom: row.validFrom, retiredAt: row.retiredAt };
    this.cache.set(row.id, k);
    return k;
  }

  get keyId() {
    if (!this.active) throw new Error("receipt signer not initialized");
    return this.active.id;
  }

  sign(payload: unknown): { keyId: string; sig: string; bytes: Buffer; sigBytes: Buffer } {
    if (!this.active?.privateKey) throw new Error("receipt signer not initialized");
    const bytes = canonicalBytes(payload);
    const sigBytes = edSign(null, bytes, this.active.privateKey);
    return { keyId: this.active.id, sig: sigBytes.toString("base64"), bytes, sigBytes };
  }

  /** Receipt v2: COSE_Sign1 over the CBOR claims, EdDSA with the same active key; kid is the key id's 8 bytes. */
  signCose(claims: ClaimsV2 | KindClaims): { keyId: string; cose: Buffer; leaf: `0x${string}` } {
    if (!this.active?.privateKey) throw new Error("receipt signer not initialized");
    const key = this.active.privateKey;
    const cose = Buffer.from(coseSign1(encodeClaims(claims), Buffer.from(this.active.id, "hex"), (tbs) => edSign(null, tbs, key)));
    return { keyId: this.active.id, cose, leaf: receiptLeafV2(cose) };
  }

  async publicKey(keyId: string): Promise<ReceiptKey | null> {
    const cached = this.cache.get(keyId);
    // A copy that still carries a private half is only trusted for the key this process signs with: any other is
    // read again, so a key another process retired is seen as retired (and its private half dropped) on first use.
    if (cached && (!cached.privateKey || keyId === this.active?.id)) return cached;
    const [row] = await this.db.select().from(receiptKeys).where(eq(receiptKeys.id, keyId));
    return row ? this.load(row) : null;
  }

  async verify(payload: unknown, sigB64: string, keyId: string): Promise<boolean> {
    const k = await this.publicKey(keyId);
    if (!k) return false;
    try {
      return edVerify(null, canonicalBytes(payload), k.publicKey, Buffer.from(sigB64, "base64"));
    } catch {
      return false;
    }
  }

  /**
   * The published key set. `version` counts the keys ever published (none is ever removed), so it rises with every
   * rotation and a verifier can refuse a copy older than one it has seen; `expires_at` bounds how long a copy that
   * misses a rotation can be relied on (`keyDocumentWindow`). Verifiers honour both.
   */
  async jwks() {
    const rows = await this.db.select().from(receiptKeys).orderBy(desc(receiptKeys.validFrom));
    return {
      version: rows.length,
      ...keyDocumentWindow(),
      keys: rows.map((r) => ({
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(r.publicKey, "hex").toString("base64url"),
        kid: r.id,
        use: "sig",
        alg: "EdDSA",
        valid_from: r.validFrom.toISOString(),
        retired_at: r.retiredAt?.toISOString() ?? null,
        onchain_tx: r.onchainTx ?? null,
      })),
    };
  }
}

export function verifyWithRawKey(payload: unknown, sigB64: string, publicKeyHex: string) {
  try {
    return edVerify(null, canonicalBytes(payload), publicFromRaw(publicKeyHex), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** The key id (16 hex) and claims a v2 receipt names, without checking anything. Throws on malformed bytes. */
export function inspectCose(cose: Uint8Array): { keyId: string | null; alg: number | null; claims: ClaimsV2 } {
  const d = decodeCoseSign1(cose);
  return { keyId: d.kid ? Buffer.from(d.kid).toString("hex") : null, alg: d.alg, claims: decodeClaims(d.payload) };
}

/** Check a v2 receipt's COSE_Sign1 (alg EdDSA) against a raw Ed25519 public key in hex. */
export function verifyCoseWithRawKey(cose: Uint8Array, publicKeyHex: string): boolean {
  try {
    const d = decodeCoseSign1(cose);
    if (d.alg !== COSE_ALG_EDDSA) return false;
    return edVerify(null, d.toBeSigned, publicFromRaw(publicKeyHex), d.signature);
  } catch {
    return false;
  }
}
