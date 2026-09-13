import { afterEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { attestationDocument } from "../src/attest.ts";
import { NvattestCollector, parseConfCompute, type Exec, type GpuEvidenceCollector } from "../src/attestation/gpu.ts";
import { compareDotted, deriveGpuNonce, gpuModelAllowed, gpuSummary, gpuSummaryHash, verifyGpuEvidence, type GpuDocument } from "../src/attestation/gpu-verify.ts";
import { parseTdxQuote } from "../src/attestation/tdx-quote.ts";
import { parseConfig } from "../src/config.ts";
import { bindingsObject, reportDataHex } from "../src/reportdata.ts";
import { canonicalJson, sha256Hex } from "../src/util.ts";
import { API_KEY, cleanup, dstackProvider, harness, type Harness } from "./helpers.ts";

afterEach(cleanup);

// Everything here is synthetic: a test P-384 key plays the NVIDIA Remote Attestation Service, an injected fetch serves
// its JWKS and its /v3/attest/gpu, and a fake collector plays the GPUs. No network, no hardware, no NVIDIA tools.

const NRAS = "https://nras.test";
const T0 = Date.parse("2026-10-01T00:00:00Z");

type Knobs = {
  /** Echo this instead of the request's nonce. */
  nonce?: string;
  measres?: string;
  hwmodel?: string;
  driver?: string;
  overall?: boolean;
  down?: boolean;
  /** Sign with a key that is not in the JWKS. */
  forge?: boolean;
  dbgstat?: string;
  /** Drop the last per-GPU token from the answer. */
  dropLast?: boolean;
};

function b64u(v: string | Buffer) {
  return Buffer.from(v).toString("base64url");
}

function mockNras(clock: { now: number }) {
  const real = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const other = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const kid = "test-nras-key-1";
  const knobs: Knobs = {};
  const calls = { attest: 0, jwks: 0, bodies: [] as Record<string, any>[], auth: [] as (string | null)[] };
  const sign = (claims: Record<string, unknown>, key: KeyObject = knobs.forge ? other.privateKey : real.privateKey) => {
    const input = `${b64u(JSON.stringify({ alg: "ES384", typ: "JWT", kid }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${createSign("SHA384").update(input).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(NRAS)) return fetch(input as string, init);
    if (knobs.down) throw new Error("connect ECONNREFUSED");
    if (url === `${NRAS}/.well-known/jwks.json`) {
      calls.jwks++;
      return Response.json({ keys: [{ ...real.publicKey.export({ format: "jwk" }), kid }] });
    }
    if (url === `${NRAS}/v3/attest/gpu` && init?.method === "POST") {
      calls.attest++;
      const body = JSON.parse(String(init.body));
      calls.bodies.push(body);
      calls.auth.push(new Headers(init.headers).get("authorization"));
      const iat = Math.floor(clock.now / 1000);
      const time = { iss: NRAS, iat, nbf: iat, exp: iat + 3600, "x-nvidia-ver": "3.0" };
      const eat_nonce = knobs.nonce ?? body.nonce;
      const gpus: Record<string, string> = {};
      const submods: Record<string, unknown> = {};
      (body.evidence_list as unknown[]).forEach((_, i) => {
        const jwt = sign({
          ...time,
          eat_nonce,
          measres: knobs.measres ?? "success",
          hwmodel: knobs.hwmodel ?? "GH100 A01 GSP BROM",
          ueid: `5376052640193595877411242255314912761526227532${80 + i}`,
          oemid: "5703",
          secboot: true,
          dbgstat: knobs.dbgstat ?? "disabled",
          "x-nvidia-gpu-driver-version": knobs.driver ?? "575.28",
          "x-nvidia-gpu-vbios-version": "96.00.AF.00.01",
          "x-nvidia-gpu-arch-check": true,
          "x-nvidia-gpu-attestation-report-nonce-match": true,
          "x-nvidia-gpu-attestation-report-signature-verified": true,
        });
        gpus[`GPU-${i}`] = jwt;
        submods[`GPU-${i}`] = ["DIGEST", ["SHA-256", sha256Hex(jwt)]];
      });
      const overall = sign({ ...time, sub: "NVIDIA-PLATFORM-ATTESTATION", "x-nvidia-overall-att-result": knobs.overall ?? true, submods, eat_nonce, jti: "00000000-0000-4000-8000-000000000000" });
      if (knobs.dropLast) delete gpus[`GPU-${body.evidence_list.length - 1}`];
      return Response.json([["JWT", overall], gpus]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, knobs, calls, sign: (claims: Record<string, unknown>) => sign(claims, real.privateKey) };
}

function fakeCollector(count = 1, local: Partial<{ cc_state: "on" | "off" | "unknown"; devtools_mode: "on" | "off" | "unknown" }> = {}) {
  const seen: string[] = [];
  const collector: GpuEvidenceCollector = {
    kind: "fake",
    async collect(nonce) {
      seen.push(nonce);
      return {
        arch: "HOPPER",
        devices: Array.from({ length: count }, (_, i) => ({ evidence: b64u(`spdm-report-${i}-${nonce}`), certificate: b64u(`-----BEGIN CERTIFICATE-----\ndevice ${i}\n-----END CERTIFICATE-----\n`) })),
        local: { source: "test", cc_state: local.cc_state ?? "on", devtools_mode: local.devtools_mode ?? "off", multi_gpu_mode: count > 1 ? "Protected PCIe" : "None", uuids: Array.from({ length: count }, (_, i) => `GPU-0000000${i}-aaaa-bbbb-cccc-000000000000`) },
      };
    },
  };
  return { collector, seen };
}

const GPU_ON = { cc_mode: "on", allowed_models: ["GH100"], nras_url: NRAS };

async function gpuHarness(o: { gpu?: Record<string, unknown>; count?: number; local?: Parameters<typeof fakeCollector>[1]; hardware?: boolean; setup?: (n: ReturnType<typeof mockNras>) => void; raw?: Record<string, unknown>; hpke?: true } = {}) {
  const clock = { now: T0 };
  const nras = mockNras(clock);
  o.setup?.(nras);
  const fake = fakeCollector(o.count ?? 1, o.local);
  const h = await harness({
    raw: { gpu: { ...GPU_ON, ...(o.gpu ?? {}) }, ...(o.hardware ? { attestation: { provider: "dstack" } } : {}), ...(o.raw ?? {}) },
    ...(o.hardware ? { provider: dstackProvider({ composeHash: `sha256:${"ce".repeat(32)}` }) } : {}),
    fetchImpl: nras.fetchImpl,
    gpuCollector: fake.collector,
    now: () => clock.now,
    hpke: o.hpke,
  });
  return { h, nras, fake, clock };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return null;
};

const docOf = (h: Harness) => JSON.parse(JSON.stringify(attestationDocument(h.rt, h.rt.bootEvidence, null))) as Record<string, any> & { gpu: GpuDocument | null };
const check = (doc: unknown, nras: ReturnType<typeof mockNras>, clock: { now: number }, extra: Record<string, unknown> = {}) =>
  verifyGpuEvidence(doc, { fetch: nras.fetchImpl, now: () => clock.now, issuer: NRAS, ...extra });
const codes = (r: { failures: { code: string }[] }) => r.failures.map((f) => f.code);

describe("GPU attestation gate (gpu.cc_mode on)", () => {
  test("success: the GPUs attest for a nonce derived from the enclave keys, and the document publishes the tokens", async () => {
    const { h, nras, fake, clock } = await gpuHarness({ count: 2 });
    const rt = h.rt;
    expect(rt.gpu).not.toBeNull();
    const record = rt.gpu!.boot;
    // The result shape: {gpus: [{uuid?, model, cc_state, token_sha256}], verified_at, nonce}.
    expect(record.gpus).toHaveLength(2);
    expect(record.gpus[0]).toMatchObject({ id: "GPU-0", index: 0, uuid: "GPU-00000000-aaaa-bbbb-cccc-000000000000", model: "GH100 A01 GSP BROM", cc_state: "on", driver_version: "575.28", token_sha256: sha256Hex(record.tokens.gpus["GPU-0"]!) });
    expect(record.verified_at).toBe(new Date(T0).toISOString());
    expect(record.nonce).toMatch(/^[0-9a-f]{64}$/);

    // The nonce the GPUs signed is derived from the keys the quote commits to.
    expect(fake.seen).toEqual([record.nonce]);
    expect(record.nonce).toBe(await deriveGpuNonce({ receipt_pubkey: rt.signer.publicKeyHex, tls_pubkey: rt.tls!.spkiHex }, record.nonce_input));
    // What went to NRAS is what the SDK documents: nonce, arch and the evidence list, nothing else.
    expect(nras.calls.attest).toBe(1);
    expect(Object.keys(nras.calls.bodies[0]!).sort()).toEqual(["arch", "evidence_list", "nonce"]);
    expect(nras.calls.bodies[0]).toMatchObject({ nonce: record.nonce, arch: "HOPPER" });
    expect(nras.calls.auth[0]).toBeNull();

    const doc = docOf(h);
    expect(doc.gpu).toMatchObject({ v: 1, mode: "nras", nras_url: NRAS, evidence_sha256: rt.gpu!.evidenceSha256, refresh: null, stale: false });
    expect(doc.gpu!.boot.tokens.overall.split(".")).toHaveLength(3);
    expect(doc.gpu!.limits.join(" ")).toContain("TDISP");
    expect(doc.bindings.gpu_evidence_sha256).toBe(await gpuSummaryHash(await gpuSummary(doc.gpu!.boot)));

    const v = await check(doc, nras, clock, { policy: { allowedModels: ["GH100"] } });
    expect(v.failures).toEqual([]);
    expect(v).toMatchObject({ status: "verified", ok: true, nonce: record.nonce, evidenceSha256: rt.gpu!.evidenceSha256, verifiedAt: record.verified_at });
    expect(v.gpus.map((g) => g.model)).toEqual(["GH100 A01 GSP BROM", "GH100 A01 GSP BROM"]);
    expect(v.expiresAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(v.notChecked.join(" ")).toContain("not signed by the GPU");
  });

  test("the document is served at /.well-known/trellis-attestation and /attest alike, and discovery says so", async () => {
    const { h } = await gpuHarness();
    const [a, b] = [await (await h.call("/.well-known/trellis-attestation", { key: null })).json(), await (await h.call("/attest", { key: null })).json()] as Record<string, any>[];
    expect(a.gpu.boot.summary_sha256).toBe(h.rt.gpu!.evidenceSha256);
    expect(a).toEqual(b);
    const disc = (await (await h.call("/.well-known/trellis-sidecar.json", { key: null })).json()) as Record<string, any>;
    expect(disc.endpoints.attestation).toBe("/.well-known/trellis-attestation");
    expect(disc.gpu).toMatchObject({ cc_mode: "on", evidence_sha256: h.rt.gpu!.evidenceSha256, gpus: 1, stale: false });
    expect(((await (await h.call("/healthz", { key: null })).json()) as Record<string, any>).gpu).toMatchObject({ cc_mode: "on", stale: false, gpus: 1 });
  });

  test("wrong nonce: tokens that echo another nonce stop the boot", async () => {
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.nonce = "ab".repeat(32)) }))).toBe("GPU_NONCE_MISMATCH");
  });

  test("failed measurement: measres other than success stops the boot", async () => {
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.measres = "fail") }))).toBe("GPU_MEASUREMENT_FAILED");
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.overall = false) }))).toBe("GPU_OVERALL_RESULT_FAILED");
  });

  test("model not allowed: a GPU whose hwmodel is not on gpu.allowed_models stops the boot", async () => {
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.hwmodel = "GA100 A01 GSP BROM") }))).toBe("GPU_MODEL_NOT_ALLOWED");
    expect(await codeOf(gpuHarness({ gpu: { allowed_models: ["GB100"] } }))).toBe("GPU_MODEL_NOT_ALLOWED");
    expect((await gpuHarness({ gpu: { allowed_models: ["GB100", "gh100"] } })).h.rt.gpu).not.toBeNull();
  });

  test("cc_mode on with no GPU evidence refuses to boot, before any quote is requested", async () => {
    let quotes = 0;
    const provider = dstackProvider();
    const quote = provider.quote.bind(provider);
    provider.quote = (rd) => (quotes++, quote(rd));
    const boot = (gpuExec: Exec) => harness({ raw: { gpu: GPU_ON, attestation: { provider: "dstack" } }, provider, fetchImpl: mockNras({ now: T0 }).fetchImpl, gpuExec });
    // The real collector, with no NVIDIA tools to run.
    expect(await codeOf(boot(async () => ({ code: 127, stdout: "", stderr: "nvattest: not found" })))).toBe("GPU_EVIDENCE_UNAVAILABLE");
    // The tools run but see no GPU.
    expect(await codeOf(boot(async () => ({ code: 0, stdout: JSON.stringify({ evidences: [], result_code: 0, result_message: "Ok" }), stderr: "" })))).toBe("GPU_EVIDENCE_UNAVAILABLE");
    expect(quotes).toBe(0);
  });

  test("the driver must report confidential-computing mode on, and DevTools mode off", async () => {
    expect(await codeOf(gpuHarness({ local: { cc_state: "off" } }))).toBe("GPU_CC_MODE_OFF");
    expect(await codeOf(gpuHarness({ local: { cc_state: "unknown" } }))).toBe("GPU_CC_STATE_UNKNOWN");
    expect(await codeOf(gpuHarness({ local: { devtools_mode: "on" } }))).toBe("GPU_DEVTOOLS_MODE");
  });

  test("an unreachable verifier, a forged signature, a debug-enabled GPU, a missing token and an old driver all stop the boot", async () => {
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.down = true) }))).toBe("GPU_VERIFIER_UNAVAILABLE");
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.forge = true) }))).toBe("GPU_SIGNATURE_INVALID");
    expect(await codeOf(gpuHarness({ setup: (n) => (n.knobs.dbgstat = "enabled") }))).toBe("GPU_DEBUG_ENABLED");
    expect(await codeOf(gpuHarness({ count: 2, setup: (n) => (n.knobs.dropLast = true) }))).toBe("GPU_SUBMODS_MISMATCH");
    expect(await codeOf(gpuHarness({ gpu: { min_driver_version: "580.0" } }))).toBe("GPU_DRIVER_TOO_OLD");
    expect((await gpuHarness({ gpu: { min_driver_version: "575.28", min_vbios_version: "96.00.9F.00.01" } })).h.rt.gpu).not.toBeNull();
  });
});

describe("GPU evidence binding", () => {
  test("the binding hash changes the report_data, and the quote carries it", async () => {
    const { h } = await gpuHarness({ hardware: true });
    const rt = h.rt;
    expect(rt.dev).toBe(false);
    expect(rt.bindings.gpuEvidenceSha256).toBe(rt.gpu!.evidenceSha256);
    const withGpu = reportDataHex(rt.bindings);
    const without = reportDataHex({ ...rt.bindings, gpuEvidenceSha256: undefined });
    const other = reportDataHex({ ...rt.bindings, gpuEvidenceSha256: "00".repeat(32) });
    expect(new Set([withGpu, without, other]).size).toBe(3);
    // The hardware-shaped quote's own report_data field is the one that commits to the GPU evidence.
    expect(parseTdxQuote(Buffer.from(rt.bootEvidence.quote, "hex")).reportData).toBe(withGpu);
    const doc = docOf(h);
    expect(doc.evidence.report_data.slice(0, 64)).toBe(sha256Hex(canonicalJson(doc.bindings)));
    expect(doc.bindings.gpu_evidence_sha256).toBe(doc.gpu!.boot.summary_sha256);
    // A fresh, nonce-bound quote commits to the same bindings: the GPU evidence hash never changes under a running process.
    const fresh = await rt.freshQuote(Buffer.from("ef".repeat(32), "hex"));
    expect(fresh.reportData).toBe(withGpu.slice(0, 64) + "ef".repeat(32));
  });

  test("the router's and the client's existing checks accept bindings that carry the new optional member", async () => {
    const { h } = await gpuHarness({ hardware: true });
    const doc = docOf(h);
    const router = (await import(["..", "..", "src", "services", "measurements.ts"].join("/")).catch(() => null)) as null | { bindingsCommittedIn: (rd: unknown, b: unknown) => boolean };
    if (router) expect(router.bindingsCommittedIn(doc.evidence.report_data, doc.bindings)).toBe(true);
    else console.warn("router source not loadable: skipped the bindingsCommittedIn cross-check");
    const client = (await import(["..", "..", "packages", "client", "src", "sidecar-bindings.ts"].join("/")).catch(() => null)) as null | { validSidecarBindingVersion: (b: unknown) => boolean };
    if (client) expect(client.validSidecarBindingVersion(doc.bindings)).toBe(true);
  });

  test("off mode is unchanged: no gpu section, no binding, no GPU or NRAS call, identical report data", async () => {
    for (const gpu of [undefined, { cc_mode: "off" }, { cc_mode: false }]) {
      const nras = mockNras({ now: T0 });
      const fake = fakeCollector();
      const h = await harness({ raw: gpu ? { gpu } : {}, fetchImpl: nras.fetchImpl, gpuCollector: fake.collector });
      expect(h.rt.gpu).toBeNull();
      const doc = docOf(h);
      expect(doc.gpu).toBeNull();
      expect("gpu" in doc).toBe(true);
      expect(Object.keys(doc.bindings).sort()).toEqual(["compose_hash", "image_digest", "model_digest", "receipt_pubkey", "tls_pubkey"]);
      // Byte for byte what a sidecar without this feature derives.
      const legacy = { tls_pubkey: h.rt.tls!.spkiHex, receipt_pubkey: h.rt.signer.publicKeyHex, image_digest: "", compose_hash: "", model_digest: h.model.digest };
      expect(canonicalJson(bindingsObject(h.rt.bindings))).toBe(canonicalJson(legacy));
      expect(h.rt.bootEvidence.reportData).toBe(sha256Hex(canonicalJson(legacy)) + "00".repeat(32));
      expect([nras.calls.attest, nras.calls.jwks, fake.seen.length]).toEqual([0, 0, 0]);
      expect((await h.chat({ model: "ok", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
      expect(await verifyGpuEvidence(doc)).toMatchObject({ status: "absent", ok: false, failures: [] });
      expect(((await (await h.call("/healthz", { key: null })).json()) as Record<string, any>).gpu).toEqual({ cc_mode: "off" });
    }
  });

  test("the HPKE key, when on, is part of the nonce", async () => {
    const { h } = await gpuHarness({ hpke: true });
    const r = h.rt.gpu!.boot;
    const keys = { receipt_pubkey: h.rt.signer.publicKeyHex, tls_pubkey: h.rt.tls!.spkiHex };
    expect(r.nonce).toBe(await deriveGpuNonce({ ...keys, hpke_pubkey: h.rt.hpke!.publicKeyHex }, r.nonce_input));
    expect(r.nonce).not.toBe(await deriveGpuNonce(keys, r.nonce_input));
  });
});

describe("GPU re-attestation", () => {
  const ask = (h: Harness) => h.chat({ model: "ok", messages: [{ role: "user", content: "hi" }] });

  test("a refresh publishes new tokens signed by the receipt key and leaves the bindings alone", async () => {
    const { h, nras, clock } = await gpuHarness();
    const before = docOf(h);
    clock.now += 1800_000;
    expect(await h.rt.gpu!.refresh()).toBe(true);
    const doc = docOf(h);
    expect(doc.bindings).toEqual(before.bindings);
    expect(doc.gpu!.boot).toEqual(before.gpu!.boot);
    expect(doc.gpu!.refresh).toMatchObject({ seq: 1, verified_at: new Date(clock.now).toISOString() });
    expect(doc.gpu!.refresh!.nonce).not.toBe(doc.gpu!.boot.nonce);
    expect(nras.calls.attest).toBe(2);
    expect(nras.calls.jwks).toBe(1); // cached
    // Past the boot tokens' expiry the refreshed ones still verify.
    clock.now += 2400_000;
    const v = await check(doc, nras, clock);
    expect(v.failures).toEqual([]);
    expect(v).toMatchObject({ status: "verified", nonce: doc.gpu!.refresh!.nonce, verifiedAt: doc.gpu!.refresh!.verified_at });
    // The signature is the enclave's: altering the refresh record, or signing it with anything else, fails.
    const forged = structuredClone(doc);
    forged.gpu!.refresh!.local.cc_state = "off";
    expect(codes(await check(forged, nras, clock))).toContain("refresh_signature_invalid");
    expect((await ask(h)).status).toBe(200);
  });

  test("a failed refresh stops new requests until one verifies again", async () => {
    const { h, nras, clock } = await gpuHarness();
    expect((await ask(h)).status).toBe(200);
    const forwarded = () => h.upstream.seen.filter((s) => s.method === "POST").length;
    const served = forwarded();

    nras.knobs.measres = "fail";
    clock.now += 1800_000;
    expect(await h.rt.gpu!.refresh()).toBe(false);
    expect(h.rt.gpu!.stale()).toBe(true);
    const res = await ask(h);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as Record<string, any>).error.code).toBe("attestation_stale");
    expect(forwarded()).toBe(served); // nothing reached the model server
    const health = await h.call("/healthz", { key: null });
    expect(health.status).toBe(503);
    expect(((await health.json()) as Record<string, any>).gpu.stale).toBe(true);
    // The failed attempt published nothing: the last record that verified is still the one served, marked stale.
    expect(docOf(h).gpu).toMatchObject({ refresh: null, stale: true });
    // An API key is still required before the stale answer, and the evidence stays readable.
    expect((await h.chat({ model: "ok", messages: [] }, null)).status).toBe(401);
    expect((await h.call("/attest", { key: null })).status).toBe(200);

    delete nras.knobs.measres;
    expect(await h.rt.gpu!.refresh()).toBe(true);
    expect(h.rt.gpu!.stale()).toBe(false);
    expect((await ask(h)).status).toBe(200);
    expect(docOf(h).gpu!.refresh!.seq).toBe(1);
  });

  test("evidence older than max_age_seconds is stale even if no refresh ever ran", async () => {
    const { h, clock } = await gpuHarness({ gpu: { refresh_seconds: 600, max_age_seconds: 1200 } });
    clock.now += 1200_000;
    expect(h.rt.gpu!.stale()).toBe(false);
    clock.now += 1;
    expect(h.rt.gpu!.stale()).toBe(true);
    expect((await ask(h)).status).toBe(503);
  });

  test("an unreachable verifier during refresh is a failed refresh", async () => {
    const { h, nras } = await gpuHarness();
    nras.knobs.down = true;
    expect(await h.rt.gpu!.refresh()).toBe(false);
    expect((await h.call("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", key: API_KEY })).status).toBe(503);
  });
});

describe("verifyGpuEvidence (client side)", () => {
  test("rejects evidence the quote does not commit to, swapped tokens and a nonce made for other keys", async () => {
    const { h, nras, clock } = await gpuHarness();
    const doc = docOf(h);
    expect((await check(doc, nras, clock)).ok).toBe(true);

    const unbound = structuredClone(doc);
    delete unbound.bindings.gpu_evidence_sha256;
    expect(codes(await check(unbound, nras, clock))).toContain("evidence_unbound");

    const hidden = structuredClone(doc);
    hidden.gpu = null;
    expect(await check(hidden, nras, clock)).toMatchObject({ status: "failed", failures: [{ code: "evidence_missing" }] });

    // Tokens from another (equally genuine) attestation: the hash the quote commits to no longer matches.
    const other = await gpuHarness();
    const swapped = structuredClone(doc);
    swapped.gpu!.boot.tokens = docOf(other.h).gpu!.boot.tokens;
    expect(codes(await check(swapped, nras, clock))).toContain("evidence_unbound");

    // A whole record lifted from another enclave, re-bound by a host that controls the bindings it serves: the nonce is
    // not derived from these keys. (Such bindings would also fail the caller's report_data check.)
    const lifted = structuredClone(doc);
    lifted.gpu!.boot = docOf(other.h).gpu!.boot;
    lifted.bindings.gpu_evidence_sha256 = lifted.gpu!.boot.summary_sha256;
    expect(codes(await check(lifted, other.nras, clock))).toContain("nonce_derivation_mismatch");

    const cc = structuredClone(doc);
    cc.gpu!.boot.local.cc_state = "off";
    expect(codes(await check(cc, nras, clock))).toEqual(expect.arrayContaining(["evidence_unbound", "cc_state_not_on"]));
  });

  test("trusts only its own verifier: a document cannot name the service that vouches for it", async () => {
    const { h, nras, clock } = await gpuHarness();
    const doc = docOf(h);
    // Default issuer is NVIDIA's; this evidence was "verified" by nras.test. The JWKS is given so nothing is fetched.
    const jwks = ((await (await nras.fetchImpl(`${NRAS}/.well-known/jwks.json`)).json()) as { keys: Record<string, string>[] }).keys;
    const v = await verifyGpuEvidence(doc, { now: () => clock.now, jwks });
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("issuer_mismatch");
    // And with the right issuer but keys that did not sign the tokens.
    const stranger = mockNras(clock);
    expect(codes(await check(doc, stranger, clock))).toContain("signature_invalid");
    const unreachable = await verifyGpuEvidence(doc, { issuer: NRAS, now: () => clock.now, fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    expect(codes(unreachable)).toContain("jwks_unavailable");
  });

  test("expired tokens without a refresh, and the caller's own policy, fail", async () => {
    const { h, nras, clock } = await gpuHarness();
    const doc = docOf(h);
    expect(codes(await check(doc, nras, { now: clock.now + 3_700_000 }))).toContain("token_expired");
    expect(codes(await check(doc, nras, clock, { policy: { allowedModels: ["GB100"] } }))).toEqual(["model_not_allowed"]);
    expect(codes(await check(doc, nras, clock, { policy: { minDriverVersion: "600" } }))).toEqual(["driver_too_old"]);
    expect(codes(await check(doc, nras, clock, { policy: { minVbiosVersion: "96.00.B0.00.00" } }))).toEqual(["vbios_too_old"]);
    expect((await check({ ...doc, dev: true }, nras, clock)).dev).toBe(true);
    expect(await check({ gpu: { boot: {} }, bindings: {} }, nras, clock)).toMatchObject({ status: "failed", failures: [{ code: "evidence_malformed" }] });
  });
});

describe("collector and configuration", () => {
  test("NvattestCollector runs the documented commands and reads their output", async () => {
    const nonce = "12".repeat(32);
    const ran: string[] = [];
    const exec: Exec = async (cmd, args) => {
      ran.push([cmd, ...args].join(" "));
      if (cmd === "/opt/nv/nvattest") return { code: 0, stdout: `INFO collecting\n${JSON.stringify({ evidences: [0, 1].map((i) => ({ arch: "HOPPER", nonce, evidence: `ZXZpZGVuY2U${i}`, certificate: "LS0tLS1CRUdJTg" })), result_code: 0, result_message: "Ok" })}\n`, stderr: "" };
      if (args.join(" ") === "conf-compute -q") return { code: 0, stdout: "==================== CC State Info ====================\nCC State:                   ON\nMulti-GPU Mode:             Protected PCIe\nCPU CC Capabilities:        INTEL TDX\nGPU CC Capabilities:        CC Capable\nCC GPUs Ready State:        Ready\n", stderr: "" };
      if (args.join(" ") === "conf-compute -d") return { code: 0, stdout: "DevTools Mode: OFF\n", stderr: "" };
      return { code: 0, stdout: "0, GPU-11111111-2222-3333-4444-555555555555\n1, GPU-66666666-7777-8888-9999-000000000000\n", stderr: "" };
    };
    const got = await new NvattestCollector({ exec, nvattestPath: "/opt/nv/nvattest" }).collect(nonce);
    expect(ran[0]).toBe(`/opt/nv/nvattest collect-evidence --device gpu --nonce ${nonce} --format json`);
    expect(ran.slice(1)).toEqual(["nvidia-smi conf-compute -q", "nvidia-smi conf-compute -d", "nvidia-smi --query-gpu=index,uuid --format=csv,noheader"]);
    expect(got).toEqual({
      arch: "HOPPER",
      devices: [{ evidence: "ZXZpZGVuY2U0", certificate: "LS0tLS1CRUdJTg" }, { evidence: "ZXZpZGVuY2U1", certificate: "LS0tLS1CRUdJTg" }],
      local: { source: "nvidia-smi", cc_state: "on", devtools_mode: "off", multi_gpu_mode: "Protected PCIe", uuids: ["GPU-11111111-2222-3333-4444-555555555555", "GPU-66666666-7777-8888-9999-000000000000"] },
    });
    // A missing nvidia-smi leaves the state unknown (and the gate shut); evidence collected for another nonce is refused.
    const noSmi: Exec = async (cmd, args) => (cmd === "nvattest" ? exec("/opt/nv/nvattest", args, { timeoutMs: 1 }) : { code: 127, stdout: "", stderr: "not found" });
    expect((await new NvattestCollector({ exec: noSmi }).collect(nonce)).local).toMatchObject({ cc_state: "unknown", devtools_mode: "unknown", uuids: [null, null] });
    const wrongNonce: Exec = async () => ({ code: 0, stdout: JSON.stringify({ evidences: [{ arch: "HOPPER", nonce: "ff".repeat(32), evidence: "AA", certificate: "BB" }] }), stderr: "" });
    expect(await codeOf(new NvattestCollector({ exec: wrongNonce }).collect(nonce))).toBe("GPU_NONCE_MISMATCH");
    expect(parseConfCompute("CC status: OFF\n")).toEqual({ cc_state: "off", devtools_mode: "unknown", multi_gpu_mode: null });
  });

  test("with the real collector wired through boot, a service key from the environment is sent as a bearer token", async () => {
    const clock = { now: T0 };
    const nras = mockNras(clock);
    const gpuExec: Exec = async (cmd, args) =>
      cmd === "nvattest"
        ? { code: 0, stdout: JSON.stringify({ evidences: [{ arch: "BLACKWELL", nonce: args[4], evidence: "AAAA", certificate: "BBBB" }], result_code: 0 }), stderr: "" }
        : { code: 0, stdout: args[1] === "-q" ? "CC State: ON\nMulti-GPU Mode: None\n" : args[1] === "-d" ? "DevTools Mode: OFF\n" : "0, GPU-11111111-2222-3333-4444-555555555555\n", stderr: "" };
    nras.knobs.hwmodel = "GB100 A01 GSP BROM";
    const h = await harness({ raw: { gpu: { ...GPU_ON, allowed_models: ["GB100"], nras_api_key_env: "TEST_NRAS_KEY" } }, env: { TEST_NRAS_KEY: "nvapi-test" }, fetchImpl: nras.fetchImpl, gpuExec, now: () => clock.now });
    expect(h.rt.gpu!.boot).toMatchObject({ arch: "BLACKWELL", gpus: [{ model: "GB100 A01 GSP BROM", uuid: "GPU-11111111-2222-3333-4444-555555555555", cc_state: "on" }] });
    expect(nras.calls.auth).toEqual(["Bearer nvapi-test"]);
    expect((await check(docOf(h), nras, clock)).ok).toBe(true);
  });

  test("configuration: cc_mode on needs an allow-list; unknown keys and odd values are refused", () => {
    const base = { model: { digest: `sha256:${"1".repeat(64)}` }, auth: { allow_anonymous: true } };
    const cfg = (gpu: unknown) => parseConfig({ ...base, gpu }, {}).gpu;
    const bad = (gpu: unknown) => {
      try {
        cfg(gpu);
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    };
    expect(parseConfig(base, {}).gpu).toMatchObject({ ccMode: "off", allowedModels: [], nrasUrl: "https://nras.attestation.nvidia.com", refreshSeconds: 1800, maxAgeSeconds: 3600, nvattestPath: "nvattest", nrasApiKeyEnv: "NV_ATTESTATION_SERVICE_KEY" });
    expect(cfg({ cc_mode: true, allowed_models: ["GH100"] }).ccMode).toBe("on");
    expect(cfg({ cc_mode: "on", allowed_models: ["GH100", "GB100"], nras_url: "https://nras.example/", refresh_seconds: 7200 })).toMatchObject({ nrasUrl: "https://nras.example", maxAgeSeconds: 7200 });
    expect(bad({ cc_mode: "on" })).toContain("gpu.allowed_models");
    expect(bad({ cc_mode: "maybe" })).toContain("gpu.cc_mode");
    expect(bad({ cc_mode: "on", allowed_models: ["GH100"], nras_url: "http://nras.example" })).toContain("gpu.nras_url");
    expect(bad({ cc_mode: "on", allowed_models: ["GH100"], refresh_seconds: 3600, max_age_seconds: 600 })).toContain("gpu.max_age_seconds");
    expect(bad({ cc_mode: "on", allowed_models: ["GH100"], min_driver_version: "five" })).toContain("gpu.min_driver_version");
    expect(bad({ cc_mode: "off", ccmode: "on" })).toContain("unknown setting");
  });

  test("model matching and version comparison", () => {
    expect(gpuModelAllowed("GH100 A01 GSP BROM", ["GH100"])).toBe(true);
    expect(gpuModelAllowed("gh100  a01 gsp brom", ["GH100 A01"])).toBe(true);
    expect(gpuModelAllowed("GH1000 A01", ["GH100"])).toBe(false);
    expect(gpuModelAllowed("GH100", [])).toBe(false);
    expect(compareDotted("575.28", "575.9", 10)).toBe(1);
    expect(compareDotted("570.124.03", "570.124", 10)).toBe(1);
    expect(compareDotted("96.00.AF.00.01", "96.00.9F.00.01", 16)).toBe(1);
    expect(compareDotted("96.00.9F", "96.00.9F.00.00", 16)).toBe(0);
    expect(compareDotted("575.x", "575.1", 10)).toBeNull();
  });
});
