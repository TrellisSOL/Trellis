import { guardedFetch } from "../lib/deadline.ts";
import { X509Certificate, constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { boundedJson } from "../providers/network.ts";
import type { Config } from "../config.ts";
import { fetchNrasJwks, verifyGpuEvidence, type GpuFailure, type GpuVerification, type Jwk as NrasJwk } from "./gpu-verify-shared.ts";

// Pluggable quote verifiers for the attestor. Which ones run is ATTESTATION_VERIFIERS (default: dcap, the
// generic DCAP verification service the router has always used). Every configured verifier must accept a
// quote; each one only ever ADDS a requirement, so enabling another can make attestation stricter, never looser.
//
//   dcap      POST {quote} to TDX_VERIFIER_URL; accepts verified=true or an acceptable TCB status.
//   intel-ta  Intel Trust Authority: POST the quote, receive a signed JWT, verify its signature against the
//             service's published JWKS, then read the appraisal claims.
//   dstack    A dstack verifier service (POST {quote, event_log, vm_config}); also yields the compose hash the
//             verified event log recorded, which the attestor compares with the compose hash the report claims.
//   tee-cloud     the TEE cloud's public quote verifier (POST {hex} to TEE_CLOUD_VERIFIER_URL). It checks the quote's
//             signature and certificate chain; its answer names the registers and report_data it verified, which
//             must be this quote's. On dstack the quote's MRCONFIGID is 0x01 || compose hash, which is returned as
//             the compose hash. It reports no TCB status, so list dcap or intel-ta as well to enforce one.
//
// Security review round 5 (R5-02, R5-11). Every verifier refuses input that is not a TDX quote (`dcap` used to forward
// whatever it was handed). A TCB status an answer reports must be an accepted one in every verifier, not only in
// `dcap`. `dstack` and `tee-cloud` report none today, so where a status is required (production) the attestor refuses
// a verifier list without `dcap` or `intel-ta` (services/attestor.ts `verifyQuote`), and a production router on the
// core surface does not start with one (src/config.ts). Version 4 is the only quote layout read here: see `verifyWithAll`.
//
// Every verifier also cross-checks any measurements it reports against the registers parsed locally from the
// quote, so a verifier cannot vouch for a different quote than the one presented. None of them can prove the
// digests a provider claims; that binding is checked by the attestor against the quote's report_data.

export type VerifierName = "dcap" | "intel-ta" | "dstack" | "tee-cloud";
export type FetchFn = typeof fetch;
/** The whole exchange with a quote verifier, body included (R4-01). Above the per-call AbortSignal timeouts below. */
export const VERIFIER_DEADLINE_MS = 35_000;

export type QuoteRegisters = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

export type VerifierInput = {
  kind: "tdx" | "snp";
  /** Hex of the quote or SEV-SNP report, no 0x prefix. */
  quoteHex: string;
  /** Registers parsed locally from a TDX quote (null for SNP). */
  registers: QuoteRegisters | null;
  /** dstack event log (a JSON string) and VM config, when the report carries them. */
  eventLog?: string | null;
  vmConfig?: string | null;
};

export type VerifierResult = {
  ok: boolean;
  reason?: string;
  /** TCB status or similar, as the verifier reported it. */
  status?: string;
  /** Compose hash (lowercase hex, no prefix) recovered from evidence the verifier itself validated. */
  composeHash?: string;
};

export interface QuoteVerifier {
  readonly name: VerifierName;
  verify(input: VerifierInput): Promise<VerifierResult>;
}

export type AttestationVerifierConfig = Pick<Config["attestation"], "verifiers" | "tdxVerifierUrl" | "tdxVerifierKey" | "intelTa" | "dstackVerifierUrl" | "dstackVerifierKey"> & { teeCloudVerifierUrl?: string; /** R4-14: an answer without a TCB status is refused (production). */ requireTcbStatus?: boolean };

/**
 * R4-14: whether a TDX quote's TD runs in debug mode: bit 0 of TDATTRIBUTES (8 bytes at offset 120 of the TD report
 * body, which follows the 48-byte header). A debuggable TD's memory can be read by its host, and the attribute is in
 * neither MRTD nor the RTMRs, so no measurement allow-list catches it. Checked here, locally, for every verifier.
 */
export function tdDebug(quoteHex: string): boolean {
  const b = Buffer.from(quoteHex.replace(/^0x/, "").slice(0, 2 * (48 + 128)), "hex");
  return b.length >= 48 + 121 && (b[48 + 120]! & 1) === 1;
}

const ACCEPTED_TCB = new Set(["UpToDate", "SWHardeningNeeded"]);
const REGISTER_KEYS = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"] as const;
const strip0x = (s: string) => s.replace(/^0x/i, "").toLowerCase();

/**
 * R5-11: the refusal for a TCB status an answer reports that is not an accepted one, else null. Each argument is a
 * place the answer may report it; absent (undefined or null) is "not reported", anything else must be an accepted status.
 */
function refusedTcb(...reported: unknown[]): VerifierResult | null {
  for (const s of reported) {
    if (s === undefined || s === null) continue;
    if (typeof s !== "string" || !ACCEPTED_TCB.has(s)) return { ok: false, reason: `quote not accepted: TCB status ${typeof s === "string" ? s.slice(0, 40) : "is not text"}` };
  }
  return null;
}

/** The version field of a quote (its first two bytes, little endian); -1 when there are none. */
export function quoteVersion(quoteHex: string): number {
  const b = Buffer.from(quoteHex.replace(/^0x/, "").slice(0, 4), "hex");
  return b.length === 2 ? b.readUInt16LE(0) : -1;
}

/** Compare registers a verifier reported with those parsed from the quote; returns the first mismatch. */
function registerMismatch(reported: Record<string, unknown> | undefined, local: QuoteRegisters | null): string | null {
  if (!reported || !local) return null;
  for (const k of REGISTER_KEYS) {
    const v = reported[k] ?? reported[`tdx_${k}`];
    if (typeof v === "string" && v && strip0x(v) !== local[k]) return `${k} reported by the verifier does not match the quote`;
  }
  return null;
}

class DcapVerifier implements QuoteVerifier {
  readonly name = "dcap" as const;
  constructor(private cfg: AttestationVerifierConfig, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    // R5-02: this verifier forwarded whatever it was handed, so a TDX quote of any guest, passed as an "SNP report",
    // attested a provider with no nonce, register or debug check. It verifies TDX quotes and nothing else.
    if (input.kind !== "tdx") return { ok: false, reason: "dcap verifies TDX quotes only" };
    if (!this.cfg.tdxVerifierUrl) return { ok: false, reason: "no DCAP verifier configured (TDX_VERIFIER_URL)" };
    const res = await this.fetchImpl(this.cfg.tdxVerifierUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(this.cfg.tdxVerifierKey ? { authorization: `Bearer ${this.cfg.tdxVerifierKey}` } : {}) },
      body: JSON.stringify({ quote: input.quoteHex.replace(/^0x/, "") }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: `verifier HTTP ${res.status}` };
    const j = (await boundedJson(res)) as { verified?: boolean; status?: string; tcb_status?: string } & Record<string, unknown>;
    const status = typeof j.tcb_status === "string" ? j.tcb_status : typeof j.status === "string" ? j.status : undefined;
    // R4-14. The answer must say the quote verified; a TCB status it reports must be an accepted one (a revoked or
    // out-of-date platform is not attested whatever else the answer says); where one is required (production) it must
    // be reported; and registers the answer echoes must be the quote's own.
    // (A verifier that reports only a TCB status reports the verdict of the quote verification library: accepted as before.)
    if (j.verified === false || (j.verified !== true && status === undefined)) return { ok: false, reason: `quote not verified (${status ?? "no verdict"})`, status };
    if (status !== undefined && !ACCEPTED_TCB.has(status)) return { ok: false, reason: `quote not accepted: TCB status ${status.slice(0, 40)}`, status };
    if (status === undefined && this.cfg.requireTcbStatus) return { ok: false, reason: "the verifier reported no TCB status" };
    const reported = (j.registers && typeof j.registers === "object" ? j.registers : j) as Record<string, unknown>;
    const mismatch = registerMismatch(reported, input.registers);
    if (mismatch) return { ok: false, reason: mismatch, status };
    return { ok: true, status };
  }
}

// ---- Intel Trust Authority ---------------------------------------------------------------------------

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; alg?: string; x5c?: string[] };
const JWT_ALGS: Record<string, { hash: string; pss: boolean }> = {
  RS256: { hash: "sha256", pss: false },
  RS384: { hash: "sha384", pss: false },
  RS512: { hash: "sha512", pss: false },
  PS256: { hash: "sha256", pss: true },
  PS384: { hash: "sha384", pss: true },
  PS512: { hash: "sha512", pss: true },
};

function keyOf(k: Jwk): KeyObject | null {
  try {
    if (k.n && k.e) return createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" });
    if (k.x5c?.[0]) return new X509Certificate(Buffer.from(k.x5c[0], "base64")).publicKey;
  } catch {
    /* unusable key */
  }
  return null;
}

/** Verify an RSA-signed (RS or PS family) JWT against a JWKS and its time claims. Never accepts "none" or an HMAC algorithm. */
export function verifyJwt(token: string, jwks: { keys?: Jwk[] }, nowMs = Date.now()): { ok: true; claims: Record<string, any> } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed token" };
  let header: { alg?: string; kid?: string };
  let claims: Record<string, any>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed token" };
  }
  const alg = header.alg ? JWT_ALGS[header.alg] : undefined;
  if (!alg) return { ok: false, reason: `unsupported token algorithm (${String(header.alg)})` };
  const candidates = (jwks.keys ?? []).filter((k) => (header.kid ? k.kid === header.kid : true) && (!k.kty || k.kty === "RSA"));
  if (!candidates.length) return { ok: false, reason: "no matching signing key in the JWKS" };
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  let signed = false;
  for (const k of candidates) {
    const key = keyOf(k);
    if (!key) continue;
    try {
      const opts = alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key;
      if (cryptoVerify(alg.hash, data, opts as never, sig)) {
        signed = true;
        break;
      }
    } catch {
      /* try the next key */
    }
  }
  if (!signed) return { ok: false, reason: "token signature does not verify" };
  const now = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "token expired or has no expiry" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return { ok: false, reason: "token not yet valid" };
  return { ok: true, claims };
}

class IntelTrustAuthorityVerifier implements QuoteVerifier {
  readonly name = "intel-ta" as const;
  constructor(private cfg: AttestationVerifierConfig["intelTa"], private fetchImpl: FetchFn, private nowMs: () => number) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "intel-ta verifies TDX quotes only" };
    if (!this.cfg.apiKey) return { ok: false, reason: "no Intel Trust Authority key configured (INTEL_TA_API_KEY)" };
    const res = await this.fetchImpl(this.cfg.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": this.cfg.apiKey },
      body: JSON.stringify({ tdx: { quote: Buffer.from(input.quoteHex.replace(/^0x/, ""), "hex").toString("base64") } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: `Intel Trust Authority HTTP ${res.status}` };
    const token = ((await boundedJson(res)) as { token?: unknown }).token;
    if (typeof token !== "string") return { ok: false, reason: "Intel Trust Authority returned no token" };
    const keysRes = await this.fetchImpl(this.cfg.jwksUrl, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!keysRes.ok) return { ok: false, reason: `Intel Trust Authority key set HTTP ${keysRes.status}` };
    const jwt = verifyJwt(token, (await boundedJson(keysRes)) as { keys?: Jwk[] }, this.nowMs());
    if (!jwt.ok) return { ok: false, reason: `Intel Trust Authority token rejected: ${jwt.reason}` };
    // Appraisal claims sit at the top level of the token or under a "tdx" object, depending on the API version.
    const c = { ...jwt.claims, ...(jwt.claims.tdx && typeof jwt.claims.tdx === "object" ? jwt.claims.tdx : {}) } as Record<string, any>;
    if (c.attester_type && String(c.attester_type).toUpperCase() !== "TDX") return { ok: false, reason: "token appraises a non-TDX attester" };
    const status = String(c.attester_tcb_status ?? "");
    if (!ACCEPTED_TCB.has(status)) return { ok: false, reason: `quote not verified (${status || "no TCB status"})` };
    if (c.tdx_is_debuggable === true) return { ok: false, reason: "TD is debuggable" };
    const mismatch = registerMismatch(c, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    if (typeof c.tdx_report_data === "string" && input.registers) {
      const rd = /^(?:0x)?[0-9a-fA-F]{128}$/.test(c.tdx_report_data) ? strip0x(c.tdx_report_data) : Buffer.from(c.tdx_report_data, "base64").toString("hex");
      if (rd !== input.registers.reportData) return { ok: false, reason: "report_data reported by the verifier does not match the quote" };
    }
    return { ok: true, status };
  }
}

// ---- dstack ------------------------------------------------------------------------------------------

/** The compose hash a dstack event log recorded into RTMR3 (event "compose-hash"), lowercase hex. */
export function composeHashFromEventLog(eventLog: string | null | undefined): string | undefined {
  if (!eventLog) return undefined;
  try {
    const events = JSON.parse(eventLog) as { imr?: number; event?: string; event_payload?: string }[];
    const hit = Array.isArray(events) ? events.find((ev) => ev?.imr === 3 && ev.event === "compose-hash" && typeof ev.event_payload === "string") : undefined;
    return hit && /^[0-9a-fA-F]{64}$/.test(hit.event_payload!) ? hit.event_payload!.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

class DstackVerifier implements QuoteVerifier {
  readonly name = "dstack" as const;
  constructor(private url: string | undefined, private key: string | undefined, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "dstack verifies TDX quotes only" };
    if (!this.url) return { ok: false, reason: "no dstack verifier configured (DSTACK_VERIFIER_URL)" };
    if (!input.eventLog) return { ok: false, reason: "report carries no dstack event log" };
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ quote: input.quoteHex.replace(/^0x/, ""), event_log: input.eventLog, ...(input.vmConfig ? { vm_config: input.vmConfig } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: `dstack verifier HTTP ${res.status}` };
    const j = (await boundedJson(res)) as { is_valid?: boolean; reason?: string; details?: Record<string, any> };
    const d = j.details ?? {};
    if (j.is_valid !== true) return { ok: false, reason: `quote not verified (${String(j.reason ?? "invalid").slice(0, 120)})` };
    if (d.quote_verified === false || d.event_log_verified === false) return { ok: false, reason: "quote or event log not verified by the dstack verifier" };
    const tcb = (d.tcb_info && typeof d.tcb_info === "object" ? d.tcb_info : {}) as Record<string, any>;
    const badTcb = refusedTcb(d.tcb_status, tcb.tcb_status); // R5-11
    if (badTcb) return badTcb;
    const mismatch = registerMismatch(tcb, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    const reported = tcb.compose_hash ?? d.app_info?.compose_hash ?? d.compose_hash;
    const composeHash = typeof reported === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(reported) ? strip0x(reported) : d.event_log_verified === true ? composeHashFromEventLog(input.eventLog) : undefined;
    return { ok: true, status: "verified", composeHash };
  }
}

// ---- TEE cloud public verifier ------------------------------------------------------------------------

/** TD report body fields read straight from the quote bytes (the header is 48 bytes). */
function tdBodyField(quoteHex: string, offset: number, length: number): Buffer | null {
  const b = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  return b.length >= 48 + offset + length ? b.subarray(48 + offset, 48 + offset + length) : null;
}

/** The compose hash a dstack host puts in MRCONFIGID (0x01 || sha256 || zero padding), lowercase hex. */
export function composeHashFromMrConfigId(mrConfigIdHex: string | null | undefined): string | undefined {
  const m = /^01([0-9a-f]{64})0{30}$/.exec(strip0x(mrConfigIdHex ?? ""));
  return m ? m[1] : undefined;
}

class TeeCloudPublicVerifier implements QuoteVerifier {
  readonly name = "tee-cloud" as const;
  constructor(private url: string | undefined, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "tee-cloud verifies TDX quotes only" };
    if (!this.url) return { ok: false, reason: "no TEE cloud verifier configured (TEE_CLOUD_VERIFIER_URL)" };
    const quoteHex = input.quoteHex.replace(/^0x/, "").toLowerCase();
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ hex: quoteHex }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: `TEE cloud verifier HTTP ${res.status}` };
    const j = (await boundedJson(res, 4 * 1024 * 1024)) as { tcb_status?: unknown; quote?: { verified?: unknown; tcb_status?: unknown; header?: Record<string, unknown>; body?: Record<string, unknown> } } | null;
    const q = (j && typeof j === "object" ? j.quote : null) ?? {};
    if (q.verified !== true) return { ok: false, reason: "quote not verified (TEE cloud verifier)" };
    // R5-11: this verifier reports no TCB status today. Should its answer carry one (`tcb_status`, at the top level, on
    // the quote or in its body), a revoked or out-of-date platform is refused here as it is under dcap.
    const badTcb = refusedTcb(j?.tcb_status, q.tcb_status, q.body && typeof q.body === "object" ? q.body.tcb_status : undefined);
    if (badTcb) return badTcb;
    if (q.header?.tee_type !== undefined && q.header.tee_type !== "TEE_TDX") return { ok: false, reason: "TEE cloud verifier did not appraise a TDX quote" };
    const body = (q.body ?? {}) as Record<string, unknown>;
    // The answer must describe this quote: every register it reports, and its report_data, must match.
    if (!input.registers || typeof body.mrtd !== "string" || typeof body.reportdata !== "string") return { ok: false, reason: "TEE cloud verifier did not report the quote's registers" };
    const mismatch = registerMismatch(body, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    if (strip0x(body.reportdata) !== input.registers.reportData) return { ok: false, reason: "report_data reported by the verifier does not match the quote" };
    // TDATTRIBUTES bit 0 is DEBUG; a debuggable TD's memory is readable by the host.
    const attributes = tdBodyField(quoteHex, 120, 8);
    if (!attributes || (attributes[0] & 1) === 1) return { ok: false, reason: "TD is debuggable" };
    const mrConfigId = tdBodyField(quoteHex, 184, 48)?.toString("hex");
    const reported = typeof body.mr_config_id === "string" ? strip0x(body.mr_config_id) : undefined;
    if (reported !== undefined && reported !== mrConfigId) return { ok: false, reason: "mr_config_id reported by the verifier does not match the quote" };
    return { ok: true, status: "verified", composeHash: composeHashFromMrConfigId(mrConfigId) };
  }
}

export function createVerifiers(cfg: AttestationVerifierConfig, rawFetch: FetchFn = fetch, nowMs: () => number = Date.now): QuoteVerifier[] {
  // R4-01: every verifier call is raced against an explicit timer, body included; a stalled verifier cannot hold the attestor.
  const fetchImpl = guardedFetch(rawFetch, "The attestation verifier", VERIFIER_DEADLINE_MS);
  return cfg.verifiers.map((name) => {
    if (name === "intel-ta") return new IntelTrustAuthorityVerifier(cfg.intelTa, fetchImpl, nowMs);
    if (name === "dstack") return new DstackVerifier(cfg.dstackVerifierUrl, cfg.dstackVerifierKey, fetchImpl);
    if (name === "tee-cloud") return new TeeCloudPublicVerifier(cfg.teeCloudVerifierUrl, fetchImpl);
    return new DcapVerifier(cfg, fetchImpl);
  });
}

/** True when every configured verifier has the endpoint it needs (readiness check). */
export function verifiersConfigured(cfg: AttestationVerifierConfig): boolean {
  const http = (v: string | undefined) => {
    if (!v) return false;
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  };
  return cfg.verifiers.every((n) => (n === "dcap" ? http(cfg.tdxVerifierUrl) : n === "dstack" ? http(cfg.dstackVerifierUrl) : n === "tee-cloud" ? http(cfg.teeCloudVerifierUrl) : !!cfg.intelTa.apiKey && http(cfg.intelTa.url) && http(cfg.intelTa.jwksUrl)));
}

export type VerifyOutcome = { ok: boolean; reason?: string; status?: string; verifiers: string[]; composeHash?: string };

/** Run every verifier; the first rejection wins. A compose hash two verifiers disagree on rejects the quote.
 *  Network failures propagate (the attestor job logs them and the provider's attestation ages out). */
export async function verifyWithAll(verifiers: QuoteVerifier[], input: VerifierInput): Promise<VerifyOutcome> {
  let status: string | undefined;
  let composeHash: string | undefined;
  const names: string[] = [];
  // R5-11: the debug bit below, MRCONFIGID and every register an answer is compared with are read at the offsets of a
  // version-4 quote. A version-5 quote puts six more bytes before the TD report, so the same reads would land on other
  // fields (a debug TD read as a production one). Refused before any verifier is asked; parseTdxQuote refuses it too.
  if (input.kind === "tdx" && quoteVersion(input.quoteHex) !== 4) return { ok: false, reason: `quote not verified: TDX quote version ${quoteVersion(input.quoteHex)} is not supported (only version 4 is read)`, verifiers: names };
  // R4-14: a debuggable TD is refused before any verifier is asked.
  if (input.kind === "tdx" && tdDebug(input.quoteHex)) return { ok: false, reason: "the TD runs in debug mode (TDATTRIBUTES.DEBUG)", verifiers: names };
  for (const v of verifiers) {
    // A verifier that cannot be reached throws, as the single DCAP verifier always has; the attestor job logs it.
    const r = await v.verify(input);
    if (!r.ok) return { ok: false, reason: r.reason ?? `${v.name} rejected the quote`, status: r.status, verifiers: names };
    names.push(v.name);
    status ??= r.status;
    if (r.composeHash) {
      if (composeHash && composeHash !== r.composeHash) return { ok: false, reason: "verifiers disagree on the compose hash", verifiers: names };
      composeHash = r.composeHash;
    }
  }
  return { ok: true, status, verifiers: names, composeHash };
}

// ---- NVIDIA GPU evidence in a sidecar attestation document -------------------------------------------------------
//
// A sidecar that runs with gpu.cc_mode "on" publishes, in the `gpu` member of its attestation document, the tokens the
// NVIDIA Remote Attestation Service (NRAS) signed for its GPUs, and commits their hash in its bindings
// (gpu_evidence_sha256). The checks themselves are gpu-verify-shared.ts, the same source the sidecar and the client
// SDK run. This wrapper supplies the router's own trust anchors (NRAS_ISSUER, NRAS_JWKS_URL: never the `nras_url` the
// document names, which a host can point anywhere), caches the signing keys, and decides whether the provider made a
// GPU claim at all. The attestor calls it only after the quote verified and its report_data committed to the bindings.

export type GpuEvidenceConfig = Pick<Config["attestation"], "nrasIssuer" | "nrasJwksUrl">;

export type GpuEvidenceOutcome = {
  /** The provider says its GPUs run in confidential-computing mode: its bindings, its document or its registration. */
  claimed: boolean;
  status: GpuVerification["status"];
  /** Every check passed for evidence a verified quote commits to. False for "absent". */
  verified: boolean;
  /** The first failure, for the attestation record. */
  reason?: string;
  failures: GpuFailure[];
  /** NRAS `hwmodel` of each GPU (the chip, for example "GH100 A01 GSP BROM"), one entry per distinct model. */
  models: string[];
  gpus: number;
  /** When the endpoint's newest evidence was taken, and when its tokens stop being valid. */
  evidenceAt: string | null;
  expiresAt: string | null;
  evidenceSha256: string | null;
  issuer: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Whether a report claims GPU confidential computing. Any one of these is a claim, and a claim that does not verify
 * fails the attestation: the bindings commit to GPU evidence, the document publishes a `gpu` member (the sidecar sets
 * it only with gpu.cc_mode "on"; an explicit cc_mode "off" there is not a claim), or the document's unbound summary
 * says cc_mode "on".
 */
export function gpuCcClaimed(report: Record<string, unknown> | null | undefined): boolean {
  if (!isRecord(report)) return false;
  const bindings = isRecord(report.sidecar_bindings) ? report.sidecar_bindings : isRecord(report.bindings) ? report.bindings : {};
  if (bindings.gpu_evidence_sha256 !== undefined && bindings.gpu_evidence_sha256 !== null) return true;
  if (report.gpu !== undefined && report.gpu !== null && !(isRecord(report.gpu) && report.gpu.cc_mode === "off")) return true;
  const policyGpu = isRecord(report.policy) ? report.policy.gpu : null;
  return isRecord(policyGpu) && (policyGpu.cc_mode === "on" || policyGpu.cc_mode === true);
}

const JWKS_TTL_MS = 3_600_000;
/** After a forced re-fetch (a token signed by a key the cache does not list), wait this long before forcing another. */
const JWKS_REFETCH_MS = 60_000;

export class GpuEvidenceVerifier {
  private keys: NrasJwk[] | null = null;
  private fetchedAt = 0;

  constructor(private cfg: GpuEvidenceConfig, private fetchImpl: FetchFn = ((...a: Parameters<FetchFn>) => fetch(...a)) as FetchFn, private nowMs: () => number = Date.now) {}

  private async jwks(force: boolean): Promise<NrasJwk[]> {
    const age = this.nowMs() - this.fetchedAt;
    if (this.keys && (force ? age < JWKS_REFETCH_MS : age < JWKS_TTL_MS)) return this.keys;
    this.keys = await fetchNrasJwks(guardedFetch(this.fetchImpl, "The NRAS key set", 20_000), this.cfg.nrasJwksUrl); // R4-01: raced against an explicit timer, body included
    this.fetchedAt = this.nowMs();
    return this.keys;
  }

  /**
   * Check the GPU evidence of a report whose quote verified and whose report_data commits to `bindings`.
   * `committed` is false when that did not hold (no bindings, or no hardware quote): evidence is then never accepted.
   */
  async verify(report: Record<string, unknown>, o: { bindings: unknown; committed: boolean; declared?: boolean }): Promise<GpuEvidenceOutcome> {
    const issuer = this.cfg.nrasIssuer;
    const claimed = gpuCcClaimed(report) || o.declared === true;
    const base = { claimed, issuer, models: [] as string[], gpus: 0, evidenceAt: null, expiresAt: null, evidenceSha256: null };
    const failed = (code: string, message: string): GpuEvidenceOutcome => ({ ...base, status: "failed", verified: false, reason: message, failures: [{ code, message }] });
    if (!claimed) return { ...base, status: "absent", verified: false, failures: [] };
    if (!o.committed) return failed("evidence_unbound", "GPU evidence counts only when a verified hardware quote commits to the sidecar bindings that name it");
    const document = { bindings: o.bindings, gpu: report.gpu ?? null, dev: false };
    let jwks: NrasJwk[];
    try {
      jwks = await this.jwks(false);
    } catch (e) {
      return failed("jwks_unavailable", `could not fetch the GPU attestation service's signing keys: ${(e as Error).message}`);
    }
    const run = (keys: NrasJwk[]) => verifyGpuEvidence(document, { jwks: keys, issuer, now: this.nowMs });
    let v = await run(jwks);
    // NRAS rotates its signing keys: a token signed by a key the cache does not list forces one re-fetch.
    if (v.failures.some((f) => f.code === "unknown_signing_key")) {
      try {
        const again = await this.jwks(true);
        if (again !== jwks) v = await run(again);
      } catch {
        /* the failure already recorded stands */
      }
    }
    const out = {
      ...base,
      models: [...new Set(v.gpus.map((g) => g.model))],
      gpus: v.gpus.length,
      evidenceAt: v.verifiedAt,
      expiresAt: v.expiresAt,
      evidenceSha256: v.evidenceSha256,
      failures: v.failures,
    };
    if (v.status === "verified") return { ...out, status: "verified", verified: true };
    // "absent" here means a claim (the provider's registration, or an unbound field) with no evidence behind it.
    if (v.status === "absent") return failed("evidence_missing", "the provider claims GPU confidential computing but its attestation document carries no GPU evidence");
    return { ...out, status: "failed", verified: false, reason: v.failures[0]?.message ?? "GPU evidence did not verify" };
  }
}

const gpuVerifiers = new Map<string, GpuEvidenceVerifier>();
/** One verifier, and so one signing-key cache, per configured NRAS. */
export function gpuEvidenceVerifier(cfg: GpuEvidenceConfig): GpuEvidenceVerifier {
  const key = `${cfg.nrasIssuer} ${cfg.nrasJwksUrl}`;
  let v = gpuVerifiers.get(key);
  if (!v) gpuVerifiers.set(key, (v = new GpuEvidenceVerifier(cfg)));
  return v;
}
