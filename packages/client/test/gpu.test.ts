import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson, evaluateAttestation, sha256Hex, utf8, verifyGpuEvidence, verifyProvider, type AttestDocument, type ProviderVerification, type RouterAttestation } from "../src/index.js";
import { gpuEvidence, syntheticEnclave, syntheticNras } from "./gpu-fixtures.js";
import { json } from "./helpers.js";

// The `gpu` check of evaluateAttestation, on synthetic documents: a TDX-shaped quote whose report_data commits to the
// bindings, and NVIDIA attestation tokens signed by a test key (gpu-fixtures.ts). No network: the signing keys are
// supplied, or served by a stubbed fetch.

const T0 = Date.parse("2026-10-01T00:00:00Z");
const ISSUER = "https://nras.test";
const REGS = { mrtd: "aa".repeat(48), rtmr0: "b0".repeat(48), rtmr1: "b1".repeat(48), rtmr2: "b2".repeat(48), rtmr3: "b3".repeat(48) };
const status = (v: ProviderVerification, id: string) => v.checks.find((c) => c.id === id)?.status;
const detail = (v: ProviderVerification, id: string) => v.checks.find((c) => c.id === id)?.detail ?? "";

/** A version 4 TDX quote body with the given report_data. The signature part is absent: this client never reads it. */
function quote(reportDataHex: string): string {
  const q = Buffer.alloc(700);
  q.writeUInt16LE(4, 0);
  q.writeUInt32LE(0x81, 4);
  const put = (off: number, h: string) => Buffer.from(h, "hex").copy(q, 48 + off);
  put(136, REGS.mrtd);
  put(328, REGS.rtmr0);
  put(376, REGS.rtmr1);
  put(424, REGS.rtmr2);
  put(472, REGS.rtmr3);
  put(520, reportDataHex);
  return q.toString("hex");
}

async function document(bindings: Record<string, unknown>, gpu: unknown, nonceHex: string | null = null): Promise<AttestDocument> {
  const reportData = (await sha256Hex(utf8(canonicalJson(bindings)))) + (nonceHex ?? "0".repeat(64));
  const boot = quote((await sha256Hex(utf8(canonicalJson(bindings)))) + "0".repeat(64));
  const ref = await sha256Hex(Buffer.from(boot, "hex"));
  return {
    v: 1,
    type: "trellis.sidecar.attestation",
    dev: false,
    attestation_ref: ref,
    attestation_san: `${ref.slice(0, 32)}.${ref.slice(32)}.attest.trellis`,
    evidence: { kind: "dstack", format: "tdx-quote-v4", dev: false, quote: quote(reportData), report_data: reportData, nonce: nonceHex, boot: nonceHex === null, measurements: REGS },
    bindings: bindings as AttestDocument["bindings"],
    receipt_key: { alg: "Ed25519", key_id: "0123456789abcdef", public_key: String(bindings.receipt_pubkey) },
    gpu,
  };
}

const router = (gpu?: RouterAttestation["gpu"]): RouterAttestation => ({
  provider: "gpu-provider",
  status: "attested",
  tee: "tdx",
  attested_at: new Date(T0).toISOString(),
  attestation_hash: "0x" + "12".repeat(32),
  verifiers: ["dcap"],
  measurement: null,
  checks: { quote_verified: true, digests_bound_to_quote: false, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false },
  ...(gpu ? { gpu } : {}),
  not_checked: ["That prompts stay inside the enclave."],
});

async function setup(o: { ageMs?: number; knobs?: Parameters<typeof gpuEvidence>[2]["knobs"]; refreshAgeMs?: number; by?: ReturnType<typeof syntheticNras> } = {}) {
  const nras = o.by ?? syntheticNras(ISSUER);
  const enclave = syntheticEnclave();
  const e = await gpuEvidence(nras, enclave, { nowMs: T0 - (o.ageMs ?? 60_000), knobs: o.knobs }, o.refreshAgeMs === undefined ? undefined : { nowMs: T0 - o.refreshAgeMs });
  const base = { tls_pubkey: enclave.keys.tls_pubkey, receipt_pubkey: enclave.keys.receipt_pubkey, image_digest: "sha256:" + "11".repeat(32), compose_hash: "sha256:" + "22".repeat(32), model_digest: "sha256:" + "33".repeat(32) };
  const bindings = { ...base, gpu_evidence_sha256: e.evidenceSha256 };
  return { nras, enclave, e, base, bindings, jwks: nras.jwks.keys as never, boot: await document(bindings, e.gpu) };
}
const opts = (s: { jwks: never }, extra: Record<string, unknown> = {}) => ({ now: () => T0, gpu: { issuer: ISSUER, jwks: s.jwks, ...extra } });

describe("one source for the GPU checks", () => {
  test("this package's copy is the sidecar's file, byte for byte between the markers", () => {
    const BEGIN = "// ---- shared source: begin";
    const END = "// ---- shared source: end ----\n";
    const region = (url: URL) => {
      const text = readFileSync(url, "utf8");
      expect([url.pathname.split("/").slice(-2).join("/"), text.split(BEGIN).length - 1, text.split(END).length - 1]).toEqual([url.pathname.split("/").slice(-2).join("/"), 1, 1]);
      return text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length);
    };
    const mine = region(new URL("../src/gpu.ts", import.meta.url));
    expect(mine.length).toBeGreaterThan(20_000);
    expect(mine).toBe(region(new URL("../../../sidecar/src/attestation/gpu-verify.ts", import.meta.url)));
    expect(mine).toBe(region(new URL("../../../src/services/gpu-verify-shared.ts", import.meta.url)));
  });
});

describe("evaluateAttestation: the gpu check", () => {
  test("a document without GPU evidence: not checked, said plainly, and still ok", async () => {
    const s = await setup();
    const v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: await document(s.base, null) }, opts(s));
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(status(v, "gpu")).toBe("not_checked");
    expect(detail(v, "gpu")).toMatch(/only the CPU side is attested/);
    expect(v.gpu).toBeNull();
  });

  test("GPU evidence that verifies passes, names the GPUs, and its limits are listed verbatim", async () => {
    const s = await setup();
    const v = await evaluateAttestation({ providerId: "gpu-provider", router: router({ cc_verified: true, models: ["GH100 A01 GSP BROM"], verified_at: new Date(T0).toISOString() }), boot: s.boot }, opts(s, { policy: { allowedModels: ["GH100"] } }));
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(status(v, "gpu")).toBe("pass");
    expect(detail(v, "gpu")).toMatch(/1 GPU \(GH100 A01 GSP BROM\).*https:\/\/nras\.test/);
    expect(v.gpu).toMatchObject({ status: "verified", ok: true, evidenceSha256: s.bindings.gpu_evidence_sha256 });
    expect(v.gpu!.gpus.map((g) => g.model)).toEqual(["GH100 A01 GSP BROM"]);
    const direct = await verifyGpuEvidence(s.boot, { issuer: ISSUER, jwks: s.jwks, policy: { allowedModels: ["GH100"] }, now: () => T0 });
    for (const n of direct.notChecked) expect(v.notChecked).toContain(n);
    expect(v.notChecked.join(" ")).toMatch(/Nothing hardware-enforced ties the GPU to this TD/);
  });

  test("a fresh document is checked as well, and a refresh signed by the bound key carries expired boot tokens", async () => {
    const s = await setup({ ageMs: 2 * 3_600_000, refreshAgeMs: 60_000 });
    const nonceHex = "5a".repeat(32);
    const fresh = { doc: await document(s.bindings, s.e.gpu, nonceHex), nonceHex };
    const v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: s.boot, fresh }, opts(s));
    expect(v.failures).toEqual([]);
    expect([status(v, "provider.fresh_quote"), status(v, "gpu")]).toEqual(["pass", "pass"]);
    // Without the refresh the same boot tokens are two hours old: expired.
    const stale = await setup({ ageMs: 2 * 3_600_000 });
    const w = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: stale.boot }, opts(stale));
    expect(w.ok).toBe(false);
    expect(status(w, "gpu")).toBe("fail");
    expect(detail(w, "gpu")).toMatch(/expired/);
  });

  test("it fails closed: forged tokens, a model you do not accept, evidence the quote does not commit to, a missing member", async () => {
    const forged = await setup({ knobs: { forge: true } });
    let v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: forged.boot }, opts(forged));
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(detail(v, "gpu")).toMatch(/signature does not verify/);

    const s = await setup();
    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: s.boot }, opts(s, { policy: { allowedModels: ["GB100"] } }));
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(detail(v, "gpu")).toMatch(/not on the allow-list/);

    // The gpu member is there, but the bindings (and so the quote) do not name it.
    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: await document(s.base, s.e.gpu) }, opts(s));
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(detail(v, "gpu")).toMatch(/no gpu_evidence_sha256/);

    // The bindings name evidence the document does not publish.
    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: await document(s.bindings, null) }, opts(s));
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);

    // A quote that does not commit to the bindings backs nothing, whatever the tokens say.
    const tampered = structuredClone(s.boot);
    tampered.bindings.model_digest = "sha256:" + "44".repeat(32);
    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: tampered }, opts(s));
    expect([status(v, "provider.report_data"), status(v, "gpu")]).toEqual(["fail", "fail"]);
    expect(detail(v, "gpu")).toMatch(/does not commit to the bindings/);
  });

  test("the issuer is yours, never the one the document names", async () => {
    const rogue = syntheticNras("https://rogue.example", "rogue-key");
    const s = await setup({ by: rogue });
    expect((s.e.gpu as { nras_url: string }).nras_url).toBe("https://rogue.example");
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return json(syntheticNras(ISSUER).jwks);
    }) as typeof fetch;
    const v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: s.boot }, { now: () => T0, gpu: { issuer: ISSUER, fetch: fetchImpl } });
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(fetched).toEqual([`${ISSUER}/.well-known/jwks.json`]);
    expect(detail(v, "gpu")).toMatch(/this verifier trusts https:\/\/nras\.test/);
  });

  test("keys that cannot be fetched fail the check; require makes absence a failure", async () => {
    const s = await setup();
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    let v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: s.boot }, { now: () => T0, gpu: { issuer: ISSUER, fetch: down } });
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(detail(v, "gpu")).toMatch(/signing keys of https:\/\/nras\.test could not be fetched/);

    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: await document(s.base, null) }, opts(s, { require: true }));
    expect([v.ok, status(v, "gpu")]).toEqual([false, "fail"]);
    expect(detail(v, "gpu")).toMatch(/You require GPU evidence/);
  });

  test("simulated evidence: the GPU evidence is not checked, and require is not met", async () => {
    const s = await setup();
    const dev = { ...s.boot, dev: true };
    let v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: dev }, { ...opts(s), allowSimulated: true });
    expect(status(v, "gpu")).toBe("not_checked");
    v = await evaluateAttestation({ providerId: "gpu-provider", router: router(), boot: dev }, { ...opts(s, { require: true }), allowSimulated: true });
    expect(v.ok).toBe(false);
  });
});

describe("verifyProvider", () => {
  test("fetches the signing keys with the caller's fetch, from the trusted issuer", async () => {
    const s = await setup();
    const nonceHex = "7c".repeat(32);
    const fresh = await document(s.bindings, s.e.gpu, nonceHex);
    const routes: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      routes.push(url);
      if (url === "https://router.test/api/v1/attestation/gpu-provider") return json({ data: router() });
      if (url === "https://provider.test/attest") return json(s.boot);
      if (url === `https://provider.test/attest?nonce=${nonceHex}`) return json(fresh);
      if (url === `${ISSUER}/.well-known/jwks.json`) return json(s.nras.jwks);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const v = await verifyProvider({ routerUrl: "https://router.test", providerId: "gpu-provider", attestUrl: "https://provider.test", fetch: fetchImpl, nonceHex, now: () => T0, gpu: { issuer: ISSUER } });
    expect(v.failures).toEqual([]);
    expect(status(v, "gpu")).toBe("pass");
    expect(routes.filter((u) => u.includes("jwks"))).toEqual([`${ISSUER}/.well-known/jwks.json`]);
  });
});

describe("the recorded synthetic document both clients are held to", () => {
  // fixtures/gpu-evidence.json: two GPUs, a boot record and a refresh. The Python client verifies the same bytes
  // (packages/client-py/tests/test_gpu.py) and must reach the result recorded in `expected`.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/gpu-evidence.json", import.meta.url), "utf8")) as {
    now: string;
    issuer: string;
    jwks: { keys: never };
    document: AttestDocument;
    expected: { status: "verified"; evidence_sha256: string; nonce: string; verified_at: string; expires_at: string; models: string[]; token_sha256: string[]; not_checked: string[] };
  };
  test("verifies, with exactly the recorded result", async () => {
    const now = Date.parse(fixture.now);
    const r = await verifyGpuEvidence(fixture.document, { issuer: fixture.issuer, jwks: fixture.jwks.keys, now: () => now, policy: { allowedModels: ["GH100"] } });
    expect(r.failures).toEqual([]);
    expect({ status: r.status, evidence_sha256: r.evidenceSha256, nonce: r.nonce, verified_at: r.verifiedAt, expires_at: r.expiresAt, models: r.gpus.map((g) => g.model), token_sha256: r.gpus.map((g) => g.token_sha256), not_checked: r.notChecked }).toEqual(fixture.expected);
    const v = await evaluateAttestation({ providerId: "gpu-provider", router: { ...router(), attested_at: fixture.now }, boot: fixture.document }, { now: () => now, gpu: { issuer: fixture.issuer, jwks: fixture.jwks.keys } });
    expect(v.failures).toEqual([]);
    expect(status(v, "gpu")).toBe("pass");
  });
  test("holds no private key", () => {
    const text = readFileSync(new URL("./fixtures/gpu-evidence.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/PRIVATE KEY|"d"\s*:/);
  });
});
