import { execFile } from "node:child_process";
import { randomHex, SidecarError, type Logger } from "../util.ts";
import {
  GPU_EVIDENCE_LIMITS,
  deriveGpuNonce,
  describeGpus,
  fetchNrasJwks,
  gpuSignedBytes,
  gpuSummary,
  gpuSummaryHash,
  normalizeIssuer,
  verifyNrasTokens,
  type CcState,
  type GpuDocument,
  type GpuEvidenceRecord,
  type GpuLocalState,
  type GpuNonceKeys,
  type GpuTokenSet,
  type Jwk,
  type TokenVerification,
} from "./gpu-verify.ts";

// NVIDIA GPU attestation inside the confidential VM.
//
//   collect   `nvattest collect-evidence --device gpu --nonce <hex> --format json` (NVIDIA Attestation SDK CLI) asks
//             each GPU, through the in-guest driver (NVML), for its SPDM attestation report over our nonce and its
//             certificate chain. `nvidia-smi conf-compute` is read for the confidential-computing state.
//   verify    the evidence goes to the NVIDIA Remote Attestation Service, POST <nras>/v3/attest/gpu, which checks the
//             certificates, the report signature and the measurements against NVIDIA's reference values and answers
//             with signed tokens. The tokens are checked here (gpu-verify.ts) against NRAS's published keys.
//   bind      sha256 of the canonical summary (nonce + token hashes + driver state) goes into the sidecar's bindings
//             as gpu_evidence_sha256, so the TDX quote commits to it; the nonce itself is derived from the enclave's
//             keys, so the GPU report commits to the enclave.
//   refresh   the same again on a timer, with a new salt. A refresh record is signed by the receipt key (which the
//             quote commits to) because the bindings, and so the quote, do not change while the process lives.
//
// Everything that touches the outside world (process execution, HTTP, the clock) is injected, so the tests run offline.

export type GpuConfig = {
  ccMode: "on" | "off";
  /** `hwmodel` prefixes NRAS may report, for example "GH100". Required (non-empty) when ccMode is on. */
  allowedModels: string[];
  nrasUrl: string;
  /** Name of the environment variable holding an NRAS service key, sent as a bearer token when set. */
  nrasApiKeyEnv: string;
  minDriverVersion?: string;
  minVbiosVersion?: string;
  refreshSeconds: number;
  maxAgeSeconds: number;
  timeoutMs: number;
  nvattestPath: string;
  nvidiaSmiPath: string;
};

// ---- process execution -----------------------------------------------------------------------------------------

export type ExecResult = { code: number; stdout: string; stderr: string };
/** Run a program with arguments (no shell). Must resolve, with a non-zero code, rather than reject when the program fails. */
export type Exec = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 127) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: err && !stderr ? err.message : (stderr ?? "") });
    });
  });

// ---- collection ---------------------------------------------------------------------------------------------------

export type GpuDeviceEvidence = {
  /** Base64 of the SPDM measurement request and response, exactly as the collector returned it. */
  evidence: string;
  /** Base64 of the GPU's PEM certificate chain, exactly as the collector returned it. */
  certificate: string;
};

export type CollectedGpuEvidence = { arch: string; devices: GpuDeviceEvidence[]; local: GpuLocalState };

/** Source of GPU evidence for a nonce. The shipped implementation shells out to NVIDIA's tools; tests inject one. */
export interface GpuEvidenceCollector {
  readonly kind: string;
  collect(nonceHex: string): Promise<CollectedGpuEvidence>;
}

const field = (text: string, label: RegExp): string | null => {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && label.test(m[1]!)) return m[2]!;
  }
  return null;
};

/** Read `nvidia-smi conf-compute -q` (and `-d`): "CC State: ON", "Multi-GPU Mode: None", "DevTools Mode: OFF". */
export function parseConfCompute(query: string, devtools = ""): Pick<GpuLocalState, "cc_state" | "devtools_mode" | "multi_gpu_mode"> {
  const cc = (field(query, /^CC (State|status)$/i) ?? "").toUpperCase();
  const dt = (field(devtools, /^DevTools Mode$/i) ?? field(query, /^DevTools Mode$/i) ?? "").toUpperCase();
  const multi = field(query, /^Multi-?GPU Mode$/i);
  const cc_state: CcState = cc === "ON" ? "on" : cc === "OFF" ? "off" : "unknown";
  return { cc_state, devtools_mode: dt === "ON" ? "on" : dt === "OFF" ? "off" : "unknown", multi_gpu_mode: multi };
}

export class NvattestCollector implements GpuEvidenceCollector {
  readonly kind = "nvattest";
  constructor(private o: { exec?: Exec; nvattestPath?: string; nvidiaSmiPath?: string; timeoutMs?: number } = {}) {}

  private run(cmd: string, args: string[]) {
    return (this.o.exec ?? nodeExec)(cmd, args, { timeoutMs: this.o.timeoutMs ?? 60_000 });
  }

  /** Driver state. Never throws: what cannot be read is "unknown", and the gate refuses an unknown state. */
  async localState(count: number): Promise<GpuLocalState> {
    const smi = this.o.nvidiaSmiPath ?? "nvidia-smi";
    const safe = async (args: string[]) => {
      try {
        const r = await this.run(smi, args);
        return r.code === 0 ? r.stdout : "";
      } catch {
        return "";
      }
    };
    const [query, devtools, list] = [await safe(["conf-compute", "-q"]), await safe(["conf-compute", "-d"]), await safe(["--query-gpu=index,uuid", "--format=csv,noheader"])];
    const uuids: (string | null)[] = Array.from({ length: count }, () => null);
    for (const line of list.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s*,\s*(GPU-[0-9A-Fa-f-]+)\s*$/.exec(line);
      if (m && Number(m[1]) < count) uuids[Number(m[1])] = m[2]!;
    }
    return { source: "nvidia-smi", ...parseConfCompute(query, devtools), uuids };
  }

  async collect(nonceHex: string): Promise<CollectedGpuEvidence> {
    const cmd = this.o.nvattestPath ?? "nvattest";
    let r: ExecResult;
    try {
      r = await this.run(cmd, ["collect-evidence", "--device", "gpu", "--nonce", nonceHex, "--format", "json"]);
    } catch (e) {
      throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `could not run ${cmd}: ${(e as Error).message}`);
    }
    if (r.code !== 0) throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence exited ${r.code}: ${r.stderr.trim().slice(0, 300) || "no output"}`);
    let out: Record<string, unknown>;
    try {
      // The JSON document is the output; anything a wrapper printed before or after it is ignored.
      out = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1));
    } catch {
      throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence did not print JSON`);
    }
    if (typeof out.result_code === "number" && out.result_code !== 0) {
      throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence reported result ${out.result_code}: ${String(out.result_message ?? "")}`.trim());
    }
    const list = Array.isArray(out.evidences) ? (out.evidences as Record<string, unknown>[]) : [];
    if (list.length === 0) throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence returned no GPU evidence (no GPU is visible to this container)`);
    const archs = new Set<string>();
    const devices = list.map((e, i) => {
      if (!e || typeof e.evidence !== "string" || !e.evidence || typeof e.certificate !== "string" || !e.certificate) {
        throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence: GPU ${i} has no evidence or certificate`);
      }
      if (typeof e.nonce === "string" && e.nonce.toLowerCase() !== nonceHex) {
        throw new SidecarError("GPU_NONCE_MISMATCH", `${cmd} collect-evidence: GPU ${i} evidence was collected for a different nonce`);
      }
      archs.add(String(e.arch ?? "").toUpperCase());
      return { evidence: e.evidence, certificate: e.certificate };
    });
    const arch = [...archs][0] ?? "";
    if (archs.size !== 1 || !/^[A-Z0-9_]{2,32}$/.test(arch)) throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `${cmd} collect-evidence: the GPUs do not share one known architecture (${[...archs].join(", ") || "none"})`);
    return { arch, devices, local: await this.localState(devices.length) };
  }
}

// ---- NRAS ---------------------------------------------------------------------------------------------------------

export type NrasOptions = { fetchImpl: typeof fetch; baseUrl: string; apiKey?: string; timeoutMs: number };

/** POST /v3/attest/gpu. The answer is a detached EAT: [["JWT", "<overall>"], {"GPU-0": "<jwt>", ...}]. */
export async function nrasAttestGpu(o: NrasOptions, body: { nonce: string; arch: string; evidence_list: GpuDeviceEvidence[] }): Promise<GpuTokenSet> {
  let res: Response;
  try {
    res = await o.fetchImpl(`${normalizeIssuer(o.baseUrl)}/v3/attest/gpu`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    throw new SidecarError("GPU_VERIFIER_UNAVAILABLE", `the GPU attestation service is unreachable: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new SidecarError("GPU_VERIFIER_UNAVAILABLE", `the GPU attestation service answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const parts = Array.isArray(parsed) ? parsed : [];
  const head = parts.find((p) => Array.isArray(p) && p[0] === "JWT" && typeof p[1] === "string") as [string, string] | undefined;
  const map = parts.find((p) => p && typeof p === "object" && !Array.isArray(p)) as Record<string, unknown> | undefined;
  if (!head || !map || Object.values(map).some((t) => typeof t !== "string")) {
    throw new SidecarError("GPU_VERIFIER_UNAVAILABLE", "the GPU attestation service did not return a detached EAT ([[\"JWT\", ...], {\"GPU-0\": ...}])");
  }
  return { overall: head[1], gpus: map as Record<string, string> };
}

/** NRAS's signing keys, cached. A token signed by a key that is not in the cache forces one re-fetch (rotation). */
export class JwksCache {
  private at = 0;
  private keys: Jwk[] | null = null;
  constructor(
    private fetchImpl: typeof fetch,
    private url: string,
    private now: () => number = Date.now,
    private ttlMs = 3_600_000,
    private timeoutMs = 15_000,
  ) {}
  async get(force = false): Promise<Jwk[]> {
    if (!force && this.keys && this.now() - this.at < this.ttlMs) return this.keys;
    try {
      this.keys = await fetchNrasJwks(this.fetchImpl, this.url, this.timeoutMs);
    } catch (e) {
      throw new SidecarError("GPU_VERIFIER_UNAVAILABLE", `could not fetch the GPU attestation service's signing keys: ${(e as Error).message}`);
    }
    this.at = this.now();
    return this.keys;
  }
}

// ---- the attestor ---------------------------------------------------------------------------------------------------

export type GpuAttestorDeps = {
  collector: GpuEvidenceCollector;
  fetchImpl: typeof fetch;
  now: () => number;
  logger: Logger;
  /** The enclave keys the nonce is derived from (the same values as in the bindings). */
  keys: GpuNonceKeys;
  /** Ed25519 by the receipt key; returns base64. */
  sign: (bytes: Uint8Array) => string;
  apiKey?: string;
};

const RETRY_MS = 60_000;

export class GpuAttestor {
  private bootRecord: GpuEvidenceRecord | null = null;
  private refreshRecord: GpuEvidenceRecord | null = null;
  private seq = 0;
  private refreshFailed = false;
  private inFlight: Promise<boolean> | null = null;
  private jwks: JwksCache;
  private issuer: string;

  constructor(
    private cfg: GpuConfig,
    private d: GpuAttestorDeps,
  ) {
    this.issuer = normalizeIssuer(cfg.nrasUrl);
    this.jwks = new JwksCache(d.fetchImpl, `${this.issuer}/.well-known/jwks.json`, d.now, 3_600_000, cfg.timeoutMs);
  }

  /** One full attestation: collect for a fresh nonce, have NRAS verify, check NRAS's tokens. Throws a SidecarError on any failure. */
  private async attestOnce(seq: number): Promise<GpuEvidenceRecord> {
    const nonce_input = { issued_at: new Date(this.d.now()).toISOString(), salt: randomHex(32) };
    const nonce = await deriveGpuNonce(this.d.keys, nonce_input);
    let collected: CollectedGpuEvidence;
    try {
      collected = await this.d.collector.collect(nonce);
    } catch (e) {
      if (e instanceof SidecarError) throw e;
      throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", `GPU evidence could not be collected: ${(e as Error).message}`);
    }
    if (collected.devices.length === 0) throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", "no GPU evidence was collected");
    const { local } = collected;
    if (local.cc_state !== "on") {
      throw new SidecarError(
        local.cc_state === "off" ? "GPU_CC_MODE_OFF" : "GPU_CC_STATE_UNKNOWN",
        local.cc_state === "off" ? "the NVIDIA driver reports confidential-computing mode OFF" : "the confidential-computing state could not be read from the NVIDIA driver (nvidia-smi conf-compute -q)",
      );
    }
    if (local.devtools_mode === "on") throw new SidecarError("GPU_DEVTOOLS_MODE", "the NVIDIA driver reports DevTools mode ON: GPU memory is not protected");

    const tokens = await nrasAttestGpu(
      { fetchImpl: this.d.fetchImpl, baseUrl: this.issuer, apiKey: this.d.apiKey, timeoutMs: this.cfg.timeoutMs },
      { nonce, arch: collected.arch, evidence_list: collected.devices },
    );
    const check = (jwks: Jwk[]): Promise<TokenVerification> =>
      verifyNrasTokens(tokens, {
        nonce,
        issuer: this.issuer,
        jwks,
        nowMs: this.d.now(),
        policy: { allowedModels: this.cfg.allowedModels, minDriverVersion: this.cfg.minDriverVersion, minVbiosVersion: this.cfg.minVbiosVersion },
      });
    let v = await check(await this.jwks.get());
    if (v.failures.some((f) => f.code === "unknown_signing_key")) v = await check(await this.jwks.get(true));
    if (v.failures.length === 0 && v.gpus.length !== collected.devices.length) {
      v.failures.push({ code: "gpu_count_mismatch", message: `evidence was sent for ${collected.devices.length} GPU(s) but ${v.gpus.length} token(s) came back` });
    }
    if (v.failures.length > 0) {
      throw new SidecarError(`GPU_${v.failures[0]!.code.toUpperCase()}`, `GPU attestation did not verify: ${v.failures.map((f) => f.message).join("; ")}`);
    }

    const base = { seq, verified_at: new Date(this.d.now()).toISOString(), nonce, nonce_input, arch: collected.arch, verifier: { kind: "nras" as const, issuer: this.issuer }, local, tokens };
    const summary = await gpuSummary(base);
    return { ...base, gpus: describeGpus(v.gpus, local), summary_sha256: await gpuSummaryHash(summary), signature: { alg: "Ed25519", sig: this.d.sign(gpuSignedBytes(summary)) } };
  }

  /** The attestation the quote will commit to. Called once, before the quote is requested and before anything listens. */
  async attestBoot(): Promise<GpuEvidenceRecord> {
    this.bootRecord = await this.attestOnce(0);
    this.seq = 0;
    return this.bootRecord;
  }

  /** Attest again. False (and the endpoint stops taking new requests) when it fails; the previous record stays published. */
  refresh(): Promise<boolean> {
    this.inFlight ??= (async () => {
      try {
        const next = await this.attestOnce(this.seq + 1);
        this.seq = next.seq;
        this.refreshRecord = next;
        if (this.refreshFailed) this.d.logger("info", "GPU attestation verifies again; serving resumes");
        this.refreshFailed = false;
        return true;
      } catch (e) {
        this.refreshFailed = true;
        this.d.logger("error", "GPU re-attestation failed; new requests are refused until it verifies again", { code: e instanceof SidecarError ? e.code : "UNKNOWN", error: (e as Error).message });
        return false;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Re-attest every refresh_seconds; after a failure, retry every minute. Returns a function that stops the timer. */
  startTimer(): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(() => void this.refresh().then((ok) => schedule(ok ? this.cfg.refreshSeconds * 1000 : Math.min(RETRY_MS, this.cfg.refreshSeconds * 1000))), ms);
      (timer as { unref?: () => void }).unref?.();
    };
    schedule(this.cfg.refreshSeconds * 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  get boot(): GpuEvidenceRecord {
    if (!this.bootRecord) throw new SidecarError("GPU_EVIDENCE_UNAVAILABLE", "GPU attestation has not run");
    return this.bootRecord;
  }
  get latest(): GpuEvidenceRecord {
    return this.refreshRecord ?? this.boot;
  }
  /** bindings.gpu_evidence_sha256: fixed for the life of the process, like every other binding. */
  get evidenceSha256(): string {
    return this.boot.summary_sha256;
  }

  /** True when the last refresh failed or the newest verified evidence is older than max_age_seconds. */
  stale(): boolean {
    return this.refreshFailed || this.d.now() - Date.parse(this.latest.verified_at) > this.cfg.maxAgeSeconds * 1000;
  }

  /** The `gpu` member of the attestation document. */
  document(): GpuDocument {
    return {
      v: 1,
      mode: "nras",
      nras_url: this.issuer,
      evidence_sha256: this.evidenceSha256,
      boot: this.boot,
      refresh: this.refreshRecord,
      stale: this.stale(),
      policy: {
        allowed_models: this.cfg.allowedModels,
        min_driver_version: this.cfg.minDriverVersion ?? null,
        min_vbios_version: this.cfg.minVbiosVersion ?? null,
        refresh_seconds: this.cfg.refreshSeconds,
        max_age_seconds: this.cfg.maxAgeSeconds,
      },
      derivation: {
        nonce: 'sha256(canonical_json({v: "trellis-gpu-nonce/v1", receipt_pubkey, tls_pubkey, [hpke_pubkey], issued_at, salt})), keys as in bindings, issued_at and salt from nonce_input; NRAS echoes it as eat_nonce in every token',
        summary: 'canonical_json({v: 1, type: "trellis.gpu.evidence", seq, verified_at, nonce, nonce_input, arch, verifier, local, token_sha256: {overall, gpus}}) with token_sha256 the SHA-256 of each compact JWT',
        binding: "bindings.gpu_evidence_sha256 = sha256(summary of the boot record), so the quote's report_data commits to it",
        refresh: 'signature.sig = Ed25519(receipt key, "trellis-gpu-evidence/v1\\n" || summary), base64; the receipt key is bindings.receipt_pubkey',
      },
      limits: GPU_EVIDENCE_LIMITS,
    };
  }
}
