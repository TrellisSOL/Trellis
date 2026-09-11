// Verification of NVIDIA GPU attestation evidence, shared by the sidecar (boot gate and refresh) and by anything that
// re-checks a served attestation document (the router's attestor, the client SDK).
//
// This module is deliberately self-contained: no Node-only imports, no module state, only WebCrypto, TextEncoder and
// atob, so it runs unchanged under Bun, Node, a browser or a worker. Network access and the clock are injected.
//
// What is verified here is the output of the NVIDIA Remote Attestation Service (NRAS): a "detached EAT", that is one
// overall JWT plus one JWT per GPU, each signed ES384 by a key NRAS publishes as a JWKS. NRAS is the party that checked
// the GPU's SPDM attestation report against NVIDIA's device certificates and reference measurements; this code checks
// NRAS's signature and what NRAS said, and how that statement is tied to one enclave. It does not parse the raw GPU
// report itself. See "limits" in the served document and sidecar/README.md.

// ---- shared source: begin. Copied byte for byte, down to the end marker, into src/services/gpu-verify-shared.ts and
// packages/client/src/gpu.ts; test/gpu-evidence.test.ts and packages/client/test/gpu.test.ts fail when the copies differ. ----

export const NRAS_DEFAULT_URL = "https://nras.attestation.nvidia.com";
export const GPU_NONCE_DOMAIN = "trellis-gpu-nonce/v1";
export const GPU_EVIDENCE_DOMAIN = "trellis-gpu-evidence/v1";
export const GPU_EVIDENCE_TYPE = "trellis.gpu.evidence";

export type CcState = "on" | "off" | "unknown";

/** NRAS's answer: the overall token and one token per GPU, keyed "GPU-0", "GPU-1", ... (compact JWTs). */
export type GpuTokenSet = { overall: string; gpus: Record<string, string> };

/** What, besides the enclave's keys, went into the nonce the GPUs signed. Published so a verifier can rebuild it. */
export type GpuNonceInput = { issued_at: string; salt: string };

/** Facts read from the in-guest NVIDIA driver (nvidia-smi). Not signed by the GPU: see the limits. */
export type GpuLocalState = {
  source: string;
  cc_state: CcState;
  devtools_mode: "on" | "off" | "unknown";
  multi_gpu_mode: string | null;
  /** Driver UUID per GPU index, or null where it could not be read. */
  uuids: (string | null)[];
};

export type GpuDevice = {
  id: string;
  index: number;
  uuid?: string;
  /** The device identity NRAS read from the GPU's certificate. */
  ueid?: string;
  /** NRAS `hwmodel`, the chip (for example "GH100 A01 GSP BROM"), not a product name. */
  model: string;
  cc_state: CcState;
  driver_version?: string;
  vbios_version?: string;
  /** sha256 of this GPU's compact JWT. */
  token_sha256: string;
};

/** The result of one GPU attestation. */
export type GpuAttestation = { gpus: GpuDevice[]; verified_at: string; nonce: string };

export type GpuEvidenceRecord = GpuAttestation & {
  /** 0 for the attestation taken at boot (the one the quote commits to), counting up with every refresh. */
  seq: number;
  nonce_input: GpuNonceInput;
  arch: string;
  verifier: { kind: "nras"; issuer: string };
  local: GpuLocalState;
  tokens: GpuTokenSet;
  /** sha256 of canonical_json(summary); for seq 0 this is bindings.gpu_evidence_sha256. */
  summary_sha256: string;
  /** Ed25519 by the enclave's receipt key over "trellis-gpu-evidence/v1\n" || canonical_json(summary). */
  signature: { alg: "Ed25519"; sig: string };
};

/** The `gpu` member of the attestation document (null when gpu.cc_mode is off). */
export type GpuDocument = {
  v: 1;
  mode: "nras";
  nras_url: string;
  evidence_sha256: string;
  boot: GpuEvidenceRecord;
  refresh: GpuEvidenceRecord | null;
  stale: boolean;
  policy: { allowed_models: string[]; min_driver_version: string | null; min_vbios_version: string | null; refresh_seconds: number; max_age_seconds: number };
  derivation: { nonce: string; summary: string; binding: string; refresh: string };
  limits: string[];
};

export type GpuSummary = {
  v: 1;
  type: typeof GPU_EVIDENCE_TYPE;
  seq: number;
  verified_at: string;
  nonce: string;
  nonce_input: GpuNonceInput;
  arch: string;
  verifier: { kind: "nras"; issuer: string };
  local: GpuLocalState;
  token_sha256: { overall: string; gpus: Record<string, string> };
};

export type GpuFailure = { code: string; message: string };
export type GpuPolicy = { allowedModels?: string[]; minDriverVersion?: string; minVbiosVersion?: string };
export type Jwk = { kty?: string; crv?: string; kid?: string; x?: string; y?: string };

// ---- small portable helpers --------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isHex = (v: unknown, bytes?: number): v is string => typeof v === "string" && /^(?:[0-9a-f]{2})*$/.test(v) && (bytes === undefined || v.length === bytes * 2);
const buf = (b: Uint8Array) => b as unknown as BufferSource;

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromBase64(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
/** Same rule as the sidecar and the router: keys sorted recursively, no whitespace, undefined dropped. */
export const canonicalJson = (v: unknown) => JSON.stringify(canonical(v));

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes))));
}

/** "https://host/" and "https://host" name the same issuer. */
export const normalizeIssuer = (url: string) => url.trim().replace(/\/+$/, "");

// ---- the nonce and the summary -------------------------------------------------------------------------------------

export type GpuNonceKeys = { receipt_pubkey: string; tls_pubkey: string; hpke_pubkey?: string };

/**
 * The 32-byte nonce the GPUs sign and NRAS echoes as `eat_nonce`:
 *   sha256(canonical_json({v: "trellis-gpu-nonce/v1", receipt_pubkey, tls_pubkey, [hpke_pubkey], issued_at, salt}))
 * The keys are the enclave's, generated in memory at boot and committed in the quote; `salt` is 32 random bytes drawn
 * inside the enclave for this one attestation. A GPU report carrying this nonce was therefore produced after these
 * keys existed and after the salt was drawn.
 */
export async function deriveGpuNonce(keys: GpuNonceKeys, input: GpuNonceInput): Promise<string> {
  return sha256Hex(
    canonicalJson({
      v: GPU_NONCE_DOMAIN,
      receipt_pubkey: keys.receipt_pubkey,
      tls_pubkey: keys.tls_pubkey,
      ...(keys.hpke_pubkey ? { hpke_pubkey: keys.hpke_pubkey } : {}),
      issued_at: input.issued_at,
      salt: input.salt,
    }),
  );
}

const sortedIds = (gpus: Record<string, string>) =>
  Object.keys(gpus).sort((a, b) => {
    const [x, y] = [Number(a.replace(/^\D+/, "")), Number(b.replace(/^\D+/, ""))];
    return Number.isFinite(x) && Number.isFinite(y) && x !== y ? x - y : a < b ? -1 : a > b ? 1 : 0;
  });

/** The canonical summary of one attestation: everything but the tokens themselves, which enter by hash. */
export async function gpuSummary(r: Pick<GpuEvidenceRecord, "seq" | "verified_at" | "nonce" | "nonce_input" | "arch" | "verifier" | "local" | "tokens">): Promise<GpuSummary> {
  const gpus: Record<string, string> = {};
  for (const id of sortedIds(r.tokens.gpus)) gpus[id] = await sha256Hex(r.tokens.gpus[id]!);
  return {
    v: 1,
    type: GPU_EVIDENCE_TYPE,
    seq: r.seq,
    verified_at: r.verified_at,
    nonce: r.nonce,
    nonce_input: { issued_at: r.nonce_input.issued_at, salt: r.nonce_input.salt },
    arch: r.arch,
    verifier: { kind: r.verifier.kind, issuer: r.verifier.issuer },
    local: { source: r.local.source, cc_state: r.local.cc_state, devtools_mode: r.local.devtools_mode, multi_gpu_mode: r.local.multi_gpu_mode, uuids: [...r.local.uuids] },
    token_sha256: { overall: await sha256Hex(r.tokens.overall), gpus },
  };
}

/** sha256(canonical_json(summary)), lowercase hex: the value bound as bindings.gpu_evidence_sha256 for the boot record. */
export const gpuSummaryHash = async (s: GpuSummary) => sha256Hex(canonicalJson(s));

/** The exact bytes the receipt key signs for a record. The tag keeps them apart from a receipt, which starts with "{". */
export const gpuSignedBytes = (s: GpuSummary) => enc.encode(`${GPU_EVIDENCE_DOMAIN}\n${canonicalJson(s)}`);

// ---- JWKS and token signatures ---------------------------------------------------------------------------------------

/** Fetch a JWKS. The URL must be the verifier's own trust anchor, never one named by the evidence being checked. */
export async function fetchNrasJwks(fetchImpl: typeof fetch, url: string, timeoutMs = 15_000): Promise<Jwk[]> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`JWKS endpoint answered HTTP ${res.status}`);
  const body: unknown = await res.json();
  const keys = isObj(body) && Array.isArray(body.keys) ? body.keys.filter(isObj) : null;
  if (!keys || keys.length === 0) throw new Error("JWKS endpoint returned no keys");
  return keys as Jwk[];
}

type Jwt = { header: Record<string, unknown>; claims: Record<string, unknown>; signed: Uint8Array; signature: Uint8Array };

function parseJwt(token: unknown): Jwt | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const header: unknown = JSON.parse(dec.decode(fromBase64(parts[0]!)));
    const claims: unknown = JSON.parse(dec.decode(fromBase64(parts[1]!)));
    if (!isObj(header) || !isObj(claims)) return null;
    return { header, claims, signed: enc.encode(`${parts[0]}.${parts[1]}`), signature: fromBase64(parts[2]!) };
  } catch {
    return null;
  }
}

/** NRAS signs ES384 (P-384 keys in its JWKS). Nothing else is accepted, whatever the token's header asks for. */
async function checkSignature(jwt: Jwt, jwks: Jwk[]): Promise<GpuFailure | null> {
  if (jwt.header.alg !== "ES384") return { code: "unsupported_alg", message: `token is signed with ${String(jwt.header.alg)}; only ES384 is accepted` };
  const kid = typeof jwt.header.kid === "string" ? jwt.header.kid : null;
  const key = kid === null ? null : jwks.find((k) => k.kid === kid);
  if (!key) return { code: "unknown_signing_key", message: `token is signed by key ${kid ?? "(no kid)"}, which the verifier's JWKS does not list` };
  if (key.kty !== "EC" || key.crv !== "P-384" || typeof key.x !== "string" || typeof key.y !== "string") {
    return { code: "unknown_signing_key", message: `JWKS key ${kid} is not a P-384 public key` };
  }
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-384", x: key.x, y: key.y }, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, pub, buf(jwt.signature), buf(jwt.signed));
    return ok ? null : { code: "signature_invalid", message: `token signature does not verify under JWKS key ${kid}` };
  } catch {
    return { code: "signature_invalid", message: `token signature could not be checked under JWKS key ${kid}` };
  }
}

// ---- policy helpers ----------------------------------------------------------------------------------------------------

const normModel = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

/** An allow-list entry admits a `hwmodel` equal to it or starting with it followed by a space ("GH100" admits "GH100 A01 GSP BROM"). */
export function gpuModelAllowed(hwmodel: string, allowed: string[]): boolean {
  const m = normModel(hwmodel);
  return allowed.some((a) => {
    const e = normModel(a);
    return e.length > 0 && (m === e || m.startsWith(`${e} `));
  });
}

/** Compare dotted versions segment by segment in the given radix (driver versions are decimal, vBIOS versions hex). Null when either does not parse. */
export function compareDotted(a: string, b: string, radix: 10 | 16): number | null {
  const digits = radix === 10 ? /^[0-9]+$/ : /^[0-9a-fA-F]+$/;
  const parse = (s: string) => {
    const parts = s.trim().split(".");
    return parts.every((p) => digits.test(p)) ? parts.map((p) => parseInt(p, radix)) : null;
  };
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- the tokens ---------------------------------------------------------------------------------------------------------

export type VerifiedGpuToken = { id: string; model: string; ueid?: string; driverVersion?: string; vbiosVersion?: string; tokenSha256: string };

export type TokenVerification = {
  failures: GpuFailure[];
  notChecked: string[];
  gpus: VerifiedGpuToken[];
  /** Earliest `exp` across the tokens, Unix seconds, when any carries one. */
  expiresAt: number | null;
};

export type TokenCheck = {
  /** The nonce the tokens must echo (64 lowercase hex). */
  nonce: string;
  /** The issuer the verifier trusts. */
  issuer: string;
  jwks: Jwk[];
  /** Unix milliseconds; null skips the validity window (used for a boot record that has since been refreshed). */
  nowMs: number | null;
  clockSkewSeconds?: number;
  policy?: GpuPolicy;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Check a detached EAT from NRAS. Failures come in a fixed order per token (signature, issuer, validity window, nonce,
 * result, measurements, model, versions), so the first one names the most basic thing that is wrong.
 */
export async function verifyNrasTokens(tokens: GpuTokenSet, c: TokenCheck): Promise<TokenVerification> {
  const failures: GpuFailure[] = [];
  const notChecked = new Set<string>();
  const gpus: VerifiedGpuToken[] = [];
  let expiresAt: number | null = null;
  const skew = c.clockSkewSeconds ?? 60;
  const issuer = normalizeIssuer(c.issuer);
  const nonce = c.nonce.toLowerCase();
  const fail = (code: string, message: string) => void failures.push({ code, message });

  const common = async (label: string, token: unknown, requireWindow: boolean): Promise<Jwt | null> => {
    const jwt = parseJwt(token);
    if (!jwt) return fail("token_malformed", `${label}: not a compact JWT`), null;
    const sig = await checkSignature(jwt, c.jwks);
    if (sig) return fail(sig.code, `${label}: ${sig.message}`), null;
    const iss = str(jwt.claims.iss);
    if (iss === undefined ? requireWindow : normalizeIssuer(iss) !== issuer) fail("issuer_mismatch", `${label}: issued by ${iss ?? "(nobody)"}, expected ${issuer}`);
    const exp = typeof jwt.claims.exp === "number" ? jwt.claims.exp : null;
    const nbf = typeof jwt.claims.nbf === "number" ? jwt.claims.nbf : null;
    if (exp !== null) expiresAt = expiresAt === null ? exp : Math.min(expiresAt, exp);
    if (c.nowMs !== null) {
      const now = c.nowMs / 1000;
      if (exp === null && requireWindow) fail("token_expired", `${label}: carries no expiry`);
      if (exp !== null && now > exp + skew) fail("token_expired", `${label}: expired at ${new Date(exp * 1000).toISOString()}`);
      if (nbf !== null && now < nbf - skew) fail("token_not_yet_valid", `${label}: not valid before ${new Date(nbf * 1000).toISOString()}`);
    }
    if (String(jwt.claims.eat_nonce ?? "").toLowerCase() !== nonce) fail("nonce_mismatch", `${label}: eat_nonce is not the nonce this attestation asked the GPU to sign`);
    return jwt;
  };

  const ids = isObj(tokens?.gpus) ? sortedIds(tokens.gpus as Record<string, string>) : [];
  const overall = await common("overall token", tokens?.overall, true);
  if (overall) {
    const sub = overall.claims.sub;
    if (sub !== undefined && sub !== "NVIDIA-PLATFORM-ATTESTATION") fail("claim_failed", `overall token: unexpected subject ${String(sub)}`);
    if (overall.claims["x-nvidia-overall-att-result"] !== true) fail("overall_result_failed", "overall token: x-nvidia-overall-att-result is not true");
    const submods = isObj(overall.claims.submods) ? overall.claims.submods : null;
    if (!submods) fail("submods_mismatch", "overall token: no submods to tie the per-GPU tokens to it");
    else {
      const named = Object.keys(submods).sort().join(",");
      if (named !== [...ids].sort().join(",")) fail("submods_mismatch", `overall token names [${named}] but the per-GPU tokens are [${[...ids].sort().join(",")}]`);
      for (const id of ids) {
        const entry = submods[id];
        const digest = Array.isArray(entry) && entry[0] === "DIGEST" && Array.isArray(entry[1]) && /^SHA-?256$/i.test(String(entry[1][0])) ? String(entry[1][1]).toLowerCase() : null;
        const actual = typeof tokens.gpus[id] === "string" ? await sha256Hex(tokens.gpus[id]!) : "";
        if (id in submods && digest !== actual) fail("submods_mismatch", `${id}: the overall token's digest is not the SHA-256 of this GPU's token`);
      }
    }
  }
  if (ids.length === 0) fail("no_gpu_tokens", "the verifier returned no per-GPU token");

  for (const id of ids) {
    const jwt = await common(id, tokens.gpus[id], false);
    if (!jwt) continue;
    const cl = jwt.claims;
    if (cl.measres !== "success") fail("measurement_failed", `${id}: measres is ${JSON.stringify(cl.measres ?? null)}; the GPU's runtime measurements do not match NVIDIA's reference values`);
    for (const k of Object.keys(cl).sort()) if (k.startsWith("x-nvidia-gpu-") && cl[k] === false) fail("claim_failed", `${id}: ${k} is false`);
    if (cl["x-nvidia-gpu-attestation-report-nonce-match"] === undefined) notChecked.add("x-nvidia-gpu-attestation-report-nonce-match is not in the token (eat_nonce was compared instead)");
    if (cl.secboot === false) fail("secure_boot_off", `${id}: secboot is false`);
    else if (cl.secboot === undefined) notChecked.add("secboot is not in the token");
    if (cl.dbgstat !== undefined && cl.dbgstat !== "disabled") fail("debug_enabled", `${id}: dbgstat is ${JSON.stringify(cl.dbgstat)}`);
    else if (cl.dbgstat === undefined) notChecked.add("dbgstat is not in the token");

    const model = str(cl.hwmodel) ?? "unknown";
    const allowed = c.policy?.allowedModels ?? [];
    if (allowed.length === 0) notChecked.add("GPU model: no allow-list was supplied");
    else if (!gpuModelAllowed(model, allowed)) fail("model_not_allowed", `${id}: hwmodel "${model}" is not on the allow-list (${allowed.join(", ")})`);

    const driverVersion = str(cl["x-nvidia-gpu-driver-version"]);
    const vbiosVersion = str(cl["x-nvidia-gpu-vbios-version"]);
    const minimum = (what: string, code: string, have: string | undefined, min: string | undefined, radix: 10 | 16) => {
      if (!min) return;
      const cmp = have === undefined ? null : compareDotted(have, min, radix);
      if (cmp === null) fail(code, `${id}: ${what} version ${have ?? "(not in the token)"} cannot be compared with the minimum ${min}`);
      else if (cmp < 0) fail(code, `${id}: ${what} version ${have} is below the minimum ${min}`);
    };
    minimum("driver", "driver_too_old", driverVersion, c.policy?.minDriverVersion, 10);
    minimum("vBIOS", "vbios_too_old", vbiosVersion, c.policy?.minVbiosVersion, 16);

    gpus.push({ id, model, ...(str(cl.ueid) ? { ueid: str(cl.ueid) } : {}), ...(driverVersion ? { driverVersion } : {}), ...(vbiosVersion ? { vbiosVersion } : {}), tokenSha256: await sha256Hex(tokens.gpus[id]!) });
  }
  return { failures, notChecked: [...notChecked], gpus, expiresAt };
}

/** The per-GPU list of a result, from the verified tokens and the locally read driver state. */
export function describeGpus(verified: VerifiedGpuToken[], local: GpuLocalState): GpuDevice[] {
  return verified.map((g, index) => ({
    id: g.id,
    index,
    ...(local.uuids[index] ? { uuid: local.uuids[index]! } : {}),
    ...(g.ueid ? { ueid: g.ueid } : {}),
    model: g.model,
    cc_state: local.cc_state,
    ...(g.driverVersion ? { driver_version: g.driverVersion } : {}),
    ...(g.vbiosVersion ? { vbios_version: g.vbiosVersion } : {}),
    token_sha256: g.tokenSha256,
  }));
}

// ---- a served document ----------------------------------------------------------------------------------------------------

export type VerifyGpuOptions = {
  /** Used to fetch the JWKS, unless `jwks` is given. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Unix milliseconds. Default: Date.now. */
  now?: () => number;
  /** The NRAS deployment this verifier trusts. Default: NVIDIA's. The document's own `nras_url` is never used as a trust anchor. */
  issuer?: string;
  /** Default: `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Keys fetched earlier (a caller's cache); skips the fetch. */
  jwks?: Jwk[];
  /** The verifier's own policy. Without `allowedModels` the model is reported, not judged. */
  policy?: GpuPolicy;
  clockSkewSeconds?: number;
};

export type GpuVerification = {
  /** absent: the document carries no GPU evidence and its bindings commit to none. verified: every check passed. */
  status: "absent" | "verified" | "failed";
  ok: boolean;
  failures: GpuFailure[];
  /** Things this function could not or did not establish. Always includes what NRAS itself does not attest. */
  notChecked: string[];
  gpus: GpuDevice[];
  verifiedAt: string | null;
  /** When the newest tokens stop being valid: the endpoint has to have refreshed by then. */
  expiresAt: string | null;
  nonce: string | null;
  /** bindings.gpu_evidence_sha256 when it matched the published boot record. */
  evidenceSha256: string | null;
  /** True when the document says its CPU-side evidence is simulated; a caller must reject that outside development. */
  dev: boolean;
};

/** What a successful result still does not establish. Kept next to the checks so the two cannot drift apart. */
export const GPU_EVIDENCE_LIMITS: string[] = [
  "NRAS attests that a genuine NVIDIA GPU signed a report over this nonce and that its firmware and driver measurements match NVIDIA's reference values. Trust rests on NVIDIA's device keys, reference values and the NRAS signing key.",
  "Nothing hardware-enforced ties the GPU to this TD (there is no TDISP binding on these parts). The tie is the nonce, which only the measured sidecar derives from keys the TDX quote commits to, and the measured guest software that talks to the GPU.",
  "cc_state, devtools_mode and multi_gpu_mode are read from the in-guest NVIDIA driver (nvidia-smi) by the sidecar. They are committed in the evidence summary but are not signed by the GPU or by NRAS.",
  "The evidence covers the GPUs visible to the sidecar at the moment of each attestation. It does not show which GPU served a given request, nor anything between two attestations.",
  "With several GPUs in protected-PCIe mode, NVLink traffic between them is not encrypted; this evidence says nothing about the links.",
];

function parseRecord(v: unknown): GpuEvidenceRecord | null {
  if (!isObj(v) || !isObj(v.nonce_input) || !isObj(v.verifier) || !isObj(v.local) || !isObj(v.tokens) || !isObj(v.tokens.gpus) || !isObj(v.signature)) return null;
  const ok =
    Number.isInteger(v.seq) &&
    typeof v.verified_at === "string" &&
    isHex(v.nonce, 32) &&
    typeof v.nonce_input.issued_at === "string" &&
    isHex(v.nonce_input.salt) &&
    typeof v.arch === "string" &&
    v.verifier.kind === "nras" &&
    typeof v.verifier.issuer === "string" &&
    typeof v.local.source === "string" &&
    typeof v.local.cc_state === "string" &&
    typeof v.local.devtools_mode === "string" &&
    (v.local.multi_gpu_mode === null || typeof v.local.multi_gpu_mode === "string") &&
    Array.isArray(v.local.uuids) &&
    typeof v.tokens.overall === "string" &&
    Object.values(v.tokens.gpus).every((t) => typeof t === "string") &&
    typeof v.signature.sig === "string";
  return ok ? (v as unknown as GpuEvidenceRecord) : null;
}

async function receiptKeySigned(record: GpuEvidenceRecord, summary: GpuSummary, receiptPubkeyHex: string): Promise<boolean> {
  try {
    if (record.signature.alg !== "Ed25519" || !isHex(receiptPubkeyHex, 32)) return false;
    const key = await crypto.subtle.importKey("raw", buf(fromHex(receiptPubkeyHex)), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, buf(fromBase64(record.signature.sig)), buf(gpuSignedBytes(summary)));
  } catch {
    return false;
  }
}

/**
 * Re-check the GPU evidence in an attestation document (the JSON served at /.well-known/trellis-attestation or /attest).
 *
 * The caller MUST already have verified the TDX quote and that its report_data commits to `document.bindings`
 * (sha256(canonical_json(bindings)) in the first 32 bytes). Given that, this establishes:
 *   1. bindings.gpu_evidence_sha256 is the hash of the published boot record, so the quote commits to that evidence;
 *   2. each record's nonce is derived from the keys in the bindings, so the GPU report was made for this enclave;
 *   3. a refresh record is signed by the receipt key the quote commits to;
 *   4. the newest tokens are signed by the trusted NRAS, unexpired, echo the nonce, report success for every GPU and
 *      meet the caller's policy; the boot tokens are checked the same way except for expiry;
 *   5. the driver state the sidecar recorded says confidential-computing mode was on and DevTools mode was not.
 */
export async function verifyGpuEvidence(document: unknown, opts: VerifyGpuOptions = {}): Promise<GpuVerification> {
  const failures: GpuFailure[] = [];
  const notChecked: string[] = [...GPU_EVIDENCE_LIMITS];
  const fail = (code: string, message: string) => void failures.push({ code, message });
  const doc = isObj(document) ? document : {};
  const bindings = isObj(doc.bindings) ? doc.bindings : {};
  const bound = typeof bindings.gpu_evidence_sha256 === "string" ? bindings.gpu_evidence_sha256.toLowerCase() : null;
  const result = (status: GpuVerification["status"], rest: Partial<GpuVerification> = {}): GpuVerification => ({
    status,
    ok: status === "verified",
    failures,
    notChecked,
    gpus: [],
    verifiedAt: null,
    expiresAt: null,
    nonce: null,
    evidenceSha256: null,
    dev: doc.dev === true,
    ...rest,
  });

  if (doc.gpu === null || doc.gpu === undefined) {
    if (!bound) return result("absent", { notChecked: ["The document carries no GPU evidence: only the CPU side is attested."] });
    fail("evidence_missing", "the bindings commit to GPU evidence that the document does not publish");
    return result("failed");
  }
  const gpu = isObj(doc.gpu) ? doc.gpu : {};
  const boot = parseRecord(gpu.boot);
  const refresh = gpu.refresh === null || gpu.refresh === undefined ? null : parseRecord(gpu.refresh);
  if (!boot || (gpu.refresh !== null && gpu.refresh !== undefined && !refresh)) {
    fail("evidence_malformed", "the gpu member is not a GPU evidence document this verifier understands");
    return result("failed");
  }
  const latest = refresh ?? boot;
  const issuer = normalizeIssuer(opts.issuer ?? NRAS_DEFAULT_URL);
  const keys: GpuNonceKeys = {
    receipt_pubkey: String(bindings.receipt_pubkey ?? ""),
    tls_pubkey: String(bindings.tls_pubkey ?? ""),
    ...(typeof bindings.hpke_pubkey === "string" ? { hpke_pubkey: bindings.hpke_pubkey } : {}),
  };

  // 1. The quote commits to the boot record.
  const bootSummary = await gpuSummary(boot);
  const bootHash = await gpuSummaryHash(bootSummary);
  if (!bound) fail("evidence_unbound", "the bindings carry no gpu_evidence_sha256, so the quote does not commit to this GPU evidence");
  else if (bound !== bootHash) fail("evidence_unbound", "bindings.gpu_evidence_sha256 is not the hash of the published boot record");
  if (boot.seq !== 0) fail("evidence_malformed", "the boot record is not sequence 0");

  // 2 and 3. Each record was made for these keys, and a refresh is signed by the bound receipt key.
  for (const [label, rec, summary] of [["boot", boot, bootSummary], ...(refresh ? [["refresh", refresh, await gpuSummary(refresh)] as const] : [])] as const) {
    if ((await deriveGpuNonce(keys, rec.nonce_input)) !== rec.nonce) fail("nonce_derivation_mismatch", `${label}: the nonce is not derived from the keys in the bindings`);
    if (normalizeIssuer(rec.verifier.issuer) !== issuer) fail("issuer_mismatch", `${label}: verified by ${rec.verifier.issuer}, but this verifier trusts ${issuer}`);
    if (rec !== boot) {
      if (rec.seq <= 0) fail("evidence_malformed", "the refresh record has no positive sequence number");
      if (!(await receiptKeySigned(rec, summary, keys.receipt_pubkey))) fail("refresh_signature_invalid", "the refresh record is not signed by the receipt key the quote commits to");
    }
  }

  // 4. The tokens.
  let jwks = opts.jwks ?? null;
  if (!jwks) {
    try {
      jwks = await fetchNrasJwks(opts.fetch ?? fetch, opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`);
    } catch (e) {
      fail("jwks_unavailable", `could not fetch the verifier's signing keys: ${(e as Error).message}`);
    }
  }
  let described: GpuDevice[] = [];
  let expiresAt: number | null = null;
  if (jwks) {
    const nowMs = (opts.now ?? Date.now)();
    const check = { issuer, jwks, clockSkewSeconds: opts.clockSkewSeconds, policy: opts.policy };
    const now = await verifyNrasTokens(latest.tokens, { ...check, nonce: latest.nonce, nowMs });
    failures.push(...now.failures);
    for (const n of now.notChecked) if (!notChecked.includes(n)) notChecked.push(n);
    described = describeGpus(now.gpus, latest.local);
    expiresAt = now.expiresAt;
    if (refresh) {
      const then = await verifyNrasTokens(boot.tokens, { ...check, nonce: boot.nonce, nowMs: null });
      // NRAS rotates its signing keys. Once the key that signed the boot tokens has left the JWKS they can no longer be
      // checked from outside; the quote still commits to their hashes and the measured sidecar verified them at boot.
      if (then.failures.length > 0 && then.failures.every((f) => f.code === "unknown_signing_key")) {
        notChecked.push("The boot tokens are signed by an NRAS key that is no longer published; their signatures were not re-checked (the refresh tokens were).");
      } else for (const f of then.failures) fail(f.code, `boot: ${f.message}`);
    }
  }

  // 5. Driver state recorded by the sidecar.
  if (latest.local.cc_state !== "on") fail("cc_state_not_on", `the driver reported confidential-computing state "${latest.local.cc_state}"`);
  if (latest.local.devtools_mode === "on") fail("devtools_mode_on", "the driver reported DevTools mode on");
  else if (latest.local.devtools_mode !== "off") notChecked.push("DevTools mode could not be read from the driver.");

  return result(failures.length === 0 ? "verified" : "failed", {
    gpus: described,
    verifiedAt: latest.verified_at,
    expiresAt: expiresAt === null ? null : new Date(expiresAt * 1000).toISOString(),
    nonce: latest.nonce,
    evidenceSha256: bound !== null && bound === bootHash ? bound : null,
  });
}

// ---- shared source: end ----
