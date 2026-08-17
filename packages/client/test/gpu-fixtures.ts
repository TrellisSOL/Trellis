import { createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { deriveGpuNonce, gpuSignedBytes, gpuSummary, gpuSummaryHash, sha256Hex, type GpuDevice, type GpuDocument, type GpuEvidenceRecord, type GpuLocalState, type GpuTokenSet } from "../src/gpu.js";

// Synthetic NVIDIA GPU attestation, for tests: a copy of the repository's test/support/gpu-fixtures.ts that imports this
// package's own module, so the package's tests do not reach outside it. A test P-384 key plays the NVIDIA Remote
// Attestation Service (NRAS) and signs the tokens it would return; a test Ed25519 key plays the enclave's receipt key.
// Nothing here touches the network, a GPU or an NVIDIA tool.

const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export type TokenKnobs = {
  /** Echo this instead of the nonce the evidence was collected for. */
  nonce?: string;
  measres?: string;
  hwmodel?: string;
  overall?: boolean;
  /** Sign with a key that is not in the JWKS. */
  forge?: boolean;
  dbgstat?: string;
  /** Seconds the tokens stay valid from their issue time (NRAS: 3600). */
  lifetime?: number;
};

/** A stand-in for NRAS: its JWKS and tokens in the detached-EAT layout (one overall JWT, one per GPU, ES384). */
export function syntheticNras(issuer: string, kid = "test-nras-key-1") {
  const real = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const other = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const sign = (claims: Record<string, unknown>, key: KeyObject) => {
    const input = `${b64u(JSON.stringify({ alg: "ES384", typ: "JWT", kid }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${createSign("SHA384").update(input).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  return {
    issuer,
    jwks: { keys: [{ ...real.publicKey.export({ format: "jwk" }), kid }] },
    async tokens(nonce: string, nowMs: number, count = 1, k: TokenKnobs = {}): Promise<GpuTokenSet> {
      const key = k.forge ? other.privateKey : real.privateKey;
      const iat = Math.floor(nowMs / 1000);
      const time = { iss: issuer, iat, nbf: iat, exp: iat + (k.lifetime ?? 3600), "x-nvidia-ver": "3.0" };
      const eat_nonce = k.nonce ?? nonce;
      const gpus: Record<string, string> = {};
      const submods: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const jwt = sign(
          {
            ...time,
            eat_nonce,
            measres: k.measres ?? "success",
            hwmodel: k.hwmodel ?? "GH100 A01 GSP BROM",
            ueid: `5376052640193595877411242255314912761526227532${80 + i}`,
            oemid: "5703",
            secboot: true,
            dbgstat: k.dbgstat ?? "disabled",
            "x-nvidia-gpu-driver-version": "575.28",
            "x-nvidia-gpu-vbios-version": "96.00.AF.00.01",
            "x-nvidia-gpu-arch-check": true,
            "x-nvidia-gpu-attestation-report-nonce-match": true,
            "x-nvidia-gpu-attestation-report-signature-verified": true,
          },
          key,
        );
        gpus[`GPU-${i}`] = jwt;
        submods[`GPU-${i}`] = ["DIGEST", ["SHA-256", await sha256Hex(jwt)]];
      }
      const overall = sign({ ...time, sub: "NVIDIA-PLATFORM-ATTESTATION", "x-nvidia-overall-att-result": k.overall ?? true, submods, eat_nonce, jti: "00000000-0000-4000-8000-000000000000" }, key);
      return { overall, gpus };
    },
  };
}
export type SyntheticNras = ReturnType<typeof syntheticNras>;

/** The enclave's keys as they appear in the bindings, and its receipt key's signature (base64) over given bytes. */
export function syntheticEnclave() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receipt_pubkey = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  return {
    keys: { receipt_pubkey, tls_pubkey: "04" + "ab".repeat(64) },
    sign: (bytes: Uint8Array) => cryptoSign(null, bytes, privateKey).toString("base64"),
  };
}
export type SyntheticEnclave = ReturnType<typeof syntheticEnclave>;

export type RecordOptions = { seq: number; nowMs: number; count?: number; knobs?: TokenKnobs; local?: Partial<GpuLocalState>; salt?: string };

/** One attestation record, as the sidecar's GpuAttestor assembles it after NRAS answered. */
export async function gpuRecord(nras: SyntheticNras, enclave: SyntheticEnclave, o: RecordOptions): Promise<GpuEvidenceRecord> {
  const count = o.count ?? 1;
  const nonce_input = { issued_at: new Date(o.nowMs).toISOString(), salt: o.salt ?? `${o.seq}`.padStart(2, "0").repeat(32).slice(0, 64) };
  const nonce = await deriveGpuNonce(enclave.keys, nonce_input);
  const tokens = await nras.tokens(nonce, o.nowMs, count, o.knobs);
  const local: GpuLocalState = { source: "test", cc_state: "on", devtools_mode: "off", multi_gpu_mode: count > 1 ? "Protected PCIe" : "None", uuids: Array.from({ length: count }, (_, i) => `GPU-0000000${i}-aaaa-bbbb-cccc-000000000000`), ...o.local };
  const base = { seq: o.seq, verified_at: new Date(o.nowMs).toISOString(), nonce, nonce_input, arch: "HOPPER", verifier: { kind: "nras" as const, issuer: nras.issuer }, local, tokens };
  const summary = await gpuSummary(base);
  const gpus: GpuDevice[] = await Promise.all(
    Object.keys(tokens.gpus).map(async (id, index) => ({ id, index, uuid: local.uuids[index] ?? undefined, model: o.knobs?.hwmodel ?? "GH100 A01 GSP BROM", cc_state: local.cc_state, driver_version: "575.28", vbios_version: "96.00.AF.00.01", token_sha256: await sha256Hex(tokens.gpus[id]!) })),
  );
  return { ...base, gpus, summary_sha256: await gpuSummaryHash(summary), signature: { alg: "Ed25519", sig: enclave.sign(gpuSignedBytes(summary)) } };
}

/**
 * The `gpu` member of an attestation document and the hash its bindings must carry (gpu_evidence_sha256). `refresh`
 * adds a later record, as the sidecar publishes once its refresh timer has run.
 */
export async function gpuEvidence(nras: SyntheticNras, enclave: SyntheticEnclave, boot: Omit<RecordOptions, "seq">, refresh?: Omit<RecordOptions, "seq">): Promise<{ gpu: GpuDocument; evidenceSha256: string }> {
  const bootRecord = await gpuRecord(nras, enclave, { ...boot, seq: 0 });
  const refreshRecord = refresh ? await gpuRecord(nras, enclave, { ...refresh, seq: 1 }) : null;
  const gpu: GpuDocument = {
    v: 1,
    mode: "nras",
    nras_url: nras.issuer,
    evidence_sha256: bootRecord.summary_sha256,
    boot: bootRecord,
    refresh: refreshRecord,
    stale: false,
    policy: { allowed_models: ["GH100"], min_driver_version: null, min_vbios_version: null, refresh_seconds: 1800, max_age_seconds: 3600 },
    derivation: { nonce: "see sidecar/src/attestation/gpu.ts", summary: "", binding: "", refresh: "" },
    limits: [],
  };
  return { gpu, evidenceSha256: bootRecord.summary_sha256 };
}
