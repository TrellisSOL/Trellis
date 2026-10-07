import { deadlineFetch } from "../lib/deadline.ts";
import { sidecarHostPolicyBindings } from "../network/sidecar-bindings.ts";
import { and, desc, eq, isNotNull, inArray, or, sql } from "drizzle-orm";
import { probationDiscovery, probationRegistryFilter } from "../network/offers.ts";
import { renewHostAttestation } from "../network/renew-attestation.ts";
import { boundedJson, peekProviderCertificate, providerFetch } from "../providers/network.ts";
import { describePeerCertificate, loadTlsPin, saveTlsPin, type PeerCertificate } from "../providers/tls-pin.ts";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { attestations, kv, providers } from "../db/schema.ts";
import { canonicalJson, log, sha256 } from "../lib/util.ts";
import { createVerifiers, gpuEvidenceVerifier, verifyWithAll, type GpuEvidenceOutcome, type VerifierInput, type VerifyOutcome } from "./attestor-verifiers.ts";
import { bindingsCommittedIn, digestsFromBindings, recordMeasurement, type Digests } from "./measurements.ts";
import { classifierFromReport, policyHashFromReport } from "../router/lane.ts";
import { clearAttestedPolicy, saveAttestedPolicy } from "../providers/attested-policy.ts";
import { pruneAttestationEvents, recordAttestorRun } from "./attestation-events.ts";
import { checkAciReport, isAciReport, loadAciGateway, saveAciGateway } from "../providers/aci.ts";
import { keyPublished } from "../tlog/hooks.ts";
import { attestationBindingEntry } from "../tlog/entries.ts";

// attestor: every 10 minutes, for each provider with a TEE, fetch a fresh attestation bound to our
// nonce and verify it. Fail closed: anything unverifiable leaves the provider un-attested, and the
// private route (`provider.private` / `:private`) only ever selects freshly attested providers.
//
// Report format (NEAR-AI-style, GET <attestation_url>?nonce=<hex32>):
//   { intel_quote?: hex (TDX v4 quote), nvidia_payload?: string, signing_address?: hex,
//     nonce: hex32 } — "dev" providers return { kind: "dev", nonce, measurement } (non-production only).
//   A report that carries only `snp_report` is refused: no SEV-SNP report is verified (R5-02).
// Verification:
//   - the nonce must be bound into the TEE report_data (TDX: bytes 568..632 of the quote)
//   - the quote's certificate chain is checked by the verifiers ATTESTATION_VERIFIERS names: the DCAP service
//     (TDX_VERIFIER_URL, the default), Intel Trust Authority and/or a dstack verifier (attestor-verifiers.ts)
//   - GPU evidence is checked by NVIDIA NRAS (overall attestation result must be true)
//   - a sidecar document that claims GPU confidential computing (bindings.gpu_evidence_sha256, a `gpu` member, or a
//     provider registered as nvidia-cc) must carry NRAS tokens that verify under the router's own NRAS_ISSUER /
//     NRAS_JWKS_URL, tied to the quote-bound keys (attestor-verifiers.ts, gpu-verify-shared.ts). This runs on every
//     pass, because the tokens expire about an hour after the endpoint last refreshed them. A claim that does not
//     verify fails the whole attestation: the provider is not attested, so it is not offered on the attested lane, and
//     an attested-lane call it still served settles under the unattested_lane rule (services/makegood.ts,
//     services/slasher.ts). A provider that makes no GPU claim is attested for its CPU side exactly as before.
//   - measurements (MRTD / RTMR3) must be in the provider's allowlist when one is configured
//   - an attested gateway (aci/1) must have a measurement pin that names every identifier its evidence carries,
//     wherever ATTESTATION_REQUIRE_ALLOWLIST holds (always in production): see "Gateway measurement pin" below
//   - which protocol and TEE kind attest a provider is decided by its row and records: see "Protocol binding" below
// A sidecar attestation document ({ type: "trellis.sidecar.attestation", evidence, bindings }) is accepted as
// well: its quote must also commit to sha256(canonical_json(bindings)) in report_data, and with
// MEASUREMENTS_ENABLED the bound image/compose/model digests are recorded (services/measurements.ts).
//
// Quote-pinned TLS (providers/tls-pin.ts). An https endpoint whose certificate names an attestation reference
// (`<32 hex>.<32 hex>.attest.trellis`, a sidecar's self-signed certificate) is not checked against public CAs.
// The attestor reads that certificate without sending anything, fetches over a connection that accepts only it,
// and accepts it only if: the endpoint serves the quote whose sha256 is the reference, that quote verifies, its
// report_data commits to bindings whose tls_pubkey is this certificate's key, and the fresh nonce-bound quote binds
// the same key. The certificate is then pinned: every later call to the provider accepts only it. Anything else
// with a self-signed certificate is refused as before, and a sidecar that binds a TLS key but is reached through a
// different certificate is refused too.

//
// Protocol binding (security review round 5, R5-02). The attestor used to pick the protocol from the answer's own shape:
// an answer carrying only `snp_report` took a branch with no nonce, no allow-list and no debug check, and its success
// deleted the provider's TLS pin and gateway keyset. The invariant now:
//   1. The TEE kind is the provider row's. Only TDX quotes are verified (every verifier refuses anything else), so a
//      report without one attests nobody; a SEV-SNP report is refused outright. An aci/1 report attests only a row
//      registered as `tdx`. (Development evidence, `kind: "dev"`, is the one exception and needs ALLOW_DEV_ATTESTATION,
//      which a production router refuses to start with.)
//   2. The protocol is the provider's. A provider that holds a gateway keyset record (`aci-gateway:<provider>`), or
//      whose pin names a keyset digest, or any provider where `cfg.attestation.gatewayOnly` holds (a production router
//      on the core surface: the attested lane's only supply there is aci/1 gateways), is attested by an aci/1 report
//      and by nothing else. Only an operator removing those records changes that.
//   3. No success deletes a TLS pin or a gateway keyset. A success replaces them only with what that same evidence
//      proved (a sidecar's quote-bound certificate; a gateway's pinned keyset and the TLS key it lists). A provider that
//      holds a TLS pin and answers through a certificate that proves nothing is refused, not un-pinned.
// So in production on the core surface `attested` is only ever written by attestAciGateway, which requires https there
// and stores the keyset and the TLS key pin in the same pass.
//
// Gateway measurement pin (security review round 3, R3-15; round 5, R5-03). A gateway's receipt keys and TLS pin come
// from the keyset the gateway itself serves, and its quote only proves that some genuine TDX guest answered at that host
// name. What makes it the release an operator appraised is the pin: the kv record `attest-allow:<provider>`, written by
// deploy/production/seed-gateway.ts from the operator's settings (the admin call providers.setAttestationAllowlist
// writes MRTD and RTMR3 only, which is not a complete pin).
//
// What the pin covers (GATEWAY_PIN_FIELDS), each a list of accepted values:
//   mrtd                  the virtual firmware (TDVF) the TD was built with
//   rtmr0, rtmr1, rtmr2   the virtual hardware and firmware configuration, the kernel, and the command line and initrd
//   rtmr3                 everything the guest extended at run time (on dstack: app id, compose hash, instance id, key
//                         provider, OS image hash)
//   compose_hash, os_image_hash, app_id, key_provider
//                         the same facts read from the event log, which is replayed against RTMR3 (providers/aci.ts),
//                         when the evidence carries them
//   keyset_digest         sha256 of the workload keyset the quote's report_data binds: the receipt signing keys, the
//                         request-encryption keys and the TLS keys the endpoint may present
//
// THE INVARIANT. Where `cfg.attestation.requireAllowlist` holds, a gateway is attested only if every identifier its
// evidence carries is named by the pin and equals a pinned value, and every identifier the pin names is carried
// (gatewayPinMismatch; property-tested in test/security-r5-03-full-pin.test.ts). The attestor never writes the pin, and
// it stores a keyset or a TLS key pin only after that comparison passed. So a change in ANY pinned measurement, or in
// the keyset, fails attestation: the provider is not attested and the SEALED lane does not serve it, the stored keyset
// and TLS pin stay those of the pinned release, the readiness warning `gateway_pin_mismatch` is raised (alert
// TrellisGatewayPinMismatch), and nothing changes until the pinned release answers again or the operator appraises the
// new one and re-pins it with seed-gateway.ts. A gateway that rotates its keyset needs a re-pin: that is the price of
// never adopting a keyset unseen.
//
// What the pin does NOT cover:
//   - MRSEAM and the TDX module, the platform's TCB level, and whether the quote's signature chain is genuine: those
//     are the quote verifiers' (attestor-verifiers.ts). TDATTRIBUTES other than the debug bit, XFAM, MROWNER and
//     MROWNERCONFIG are not compared at all. MRCONFIGID is compared only as the compose hash, when a verifier reports it.
//   - Anything the registers themselves do not measure. The pin compares numbers; it does not appraise the gateway's
//     source, and `source_provenance` is recorded, not checked. RTMR3 on dstack includes the instance id, so a
//     redeployment of the same release has another RTMR3 and needs a re-pin.
//   - The upstream behind the gateway: that is what each response's receipt asserts (providers/aci.ts).
//   - Outside `requireAllowlist` (development): identifiers the pin does not list are not compared, and with no pin at
//     all the gateway attests with a warning logged once per provider and process.
// A refusal records the identifiers of the quote the verifiers accepted, which is what an operator compares against the
// release and then pins.

export type TdxFields = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

/** Every identifier an aci/1 gateway's evidence can carry, in the order they are compared and reported. */
export const GATEWAY_PIN_FIELDS = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "compose_hash", "os_image_hash", "app_id", "key_provider", "keyset_digest"] as const;
export type GatewayPinField = (typeof GATEWAY_PIN_FIELDS)[number];
/** The identifiers every aci/1 report carries. A pin without one of them is not a pin (`pinned` is false). */
const ALWAYS_CARRIED: readonly GatewayPinField[] = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "keyset_digest"];
const PIN_LABEL: Record<GatewayPinField, string> = { mrtd: "MRTD", rtmr0: "RTMR0", rtmr1: "RTMR1", rtmr2: "RTMR2", rtmr3: "RTMR3", compose_hash: "compose hash", os_image_hash: "OS image hash", app_id: "app id", key_provider: "key provider", keyset_digest: "keyset digest" };
const pinFormat = (f: GatewayPinField) => (f === "keyset_digest" ? /^sha256:[0-9a-f]{64}$/ : f === "mrtd" || f.startsWith("rtmr") ? /^[0-9a-f]{96}$/ : /^[0-9a-f]{2,1024}$/);
/** One identifier as it is compared: lower case, registers and event payloads without a 0x prefix. */
const pinValue = (f: GatewayPinField, v: unknown) => (typeof v !== "string" ? "" : f === "keyset_digest" ? v.trim().toLowerCase() : v.trim().replace(/^0x/i, "").toLowerCase());

export type MeasurementAllowlist = ({ [K in GatewayPinField]?: string[] } & { measurement?: string[] }) | null;
/** The reason an attested gateway is refused for a missing or incomplete measurement pin; readiness looks for it (services/readiness.ts). */
export const GATEWAY_UNPINNED_REASON = "an attested gateway needs a measurement allow-list that names every identifier its evidence carries (MRTD, RTMR0 to RTMR3, keyset digest; compose hash, OS image hash, app id and key provider when present); this provider's is missing or incomplete";
/** The reason a provider that is an aci/1 gateway by its records (or by configuration) is refused for any other report shape. */
export const GATEWAY_PROTOCOL_REASON = "this provider is attested as an aci/1 gateway only; a report of another shape does not attest it";

export type GatewayPin = { values: Record<GatewayPinField, string[]>; listed: Record<GatewayPinField, boolean>; pinned: boolean };

/**
 * The identifiers an allow-list names for a gateway, normalised (pinValue) with anything malformed dropped. `listed`
 * says whether each list was given at all, so a list holding only malformed entries still refuses every quote instead
 * of counting as absent. `pinned` needs at least one valid value for every identifier a report always carries.
 */
export function gatewayPin(allowlist: MeasurementAllowlist): GatewayPin {
  const given = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const values = {} as Record<GatewayPinField, string[]>;
  const listed = {} as Record<GatewayPinField, boolean>;
  for (const f of GATEWAY_PIN_FIELDS) {
    const list = given((allowlist as Record<string, unknown> | null)?.[f]);
    values[f] = list.map((x) => pinValue(f, x)).filter((x) => pinFormat(f).test(x));
    listed[f] = list.length > 0;
  }
  return { values, listed, pinned: ALWAYS_CARRIED.every((f) => values[f].length > 0) };
}

/**
 * The pin comparison (THE INVARIANT above). `evidence` holds what the verified quote and report carry (null or absent:
 * not carried). Returns null when the evidence is acceptable, else why not:
 *   changed    identifiers the pin names whose carried value is not a pinned one, or that are not carried at all
 *   unpinned   identifiers the evidence carries that the pin does not name (only where the pin is `required`)
 * A change is reported before an incomplete pin. Pure: compares, never stores.
 */
export function gatewayPinMismatch(pin: GatewayPin, evidence: { [K in GatewayPinField]?: string | null }, required: boolean): { reason: string; changed: GatewayPinField[]; unpinned: GatewayPinField[] } | null {
  const changed: GatewayPinField[] = [];
  const unpinned: GatewayPinField[] = [];
  for (const f of GATEWAY_PIN_FIELDS) {
    const carried = pinValue(f, evidence[f]);
    if (pin.listed[f]) {
      if (!carried || !pin.values[f].includes(carried)) changed.push(f);
    } else if (required && carried) unpinned.push(f);
  }
  if (changed.length) return { reason: `${PIN_LABEL[changed[0]!]} not in allowlist`, changed, unpinned };
  if (unpinned.length) return { reason: GATEWAY_UNPINNED_REASON, changed, unpinned };
  return null;
}

const warnedUnpinned = new Set<string>();
/** Forget which providers were already warned about (the warning is once per provider and process; tests share a process). */
export const forgetUnpinnedWarnings = () => warnedUnpinned.clear();

/**
 * Live providers that are attested gateways without a (complete) measurement pin: those the router holds a gateway
 * keyset for whose pin lacks an identifier every report carries, and those the attestor last refused for a missing or
 * incomplete pin (a gateway that has never been attested, or one whose evidence carries an identifier the pin omits).
 */
export async function unpinnedGateways(ctx: Ctx): Promise<string[]> {
  const live = [...ctx.catalog.providers.values()].filter((p) => p.status === "live" && !!p.teeKind && p.teeKind !== "dev" && !!p.attestationUrl);
  if (!live.length) return [];
  const rows = await ctx.db.select().from(kv).where(inArray(kv.key, live.map((p) => `attest-allow:${p.id}`)));
  const lists = new Map(rows.map((r) => [r.key, r.value as MeasurementAllowlist]));
  const out: string[] = [];
  for (const p of live) {
    const [last] = await ctx.db.select({ ok: attestations.ok, detail: attestations.detail }).from(attestations).where(eq(attestations.providerId, p.id)).orderBy(desc(attestations.id)).limit(1);
    const refused = !!last && !last.ok && (last.detail as { reason?: string } | null)?.reason === GATEWAY_UNPINNED_REASON;
    if (refused || (!!p.aci && !gatewayPin(lists.get(`attest-allow:${p.id}`) ?? null).pinned)) out.push(p.id);
  }
  return out;
}

/**
 * R5-03, the alarm: the readiness warning `gateway_pin_mismatch` (metric trellis_readiness_warning, alert
 * TrellisGatewayPinMismatch). It holds while, for some live provider, the newest attestor verdict that says anything
 * about the pin (a success, or a refusal for a changed identifier) is a refusal: so an endpoint that goes dark after
 * the change does not clear it, and it clears only when the pinned release answers again or the operator re-pins.
 * The message names the identifiers that changed and nothing a provider sent.
 */
export async function gatewayPinWarnings(ctx: Ctx): Promise<{ code: string; reason: string; message: string }[]> {
  const live = [...ctx.catalog.providers.values()].filter((p) => p.status === "live" && !!p.teeKind && p.teeKind !== "dev" && !!p.attestationUrl);
  const changed = new Set<GatewayPinField>();
  let gateways = 0;
  for (const p of live) {
    const [verdict] = await ctx.db
      .select({ ok: attestations.ok, detail: attestations.detail })
      .from(attestations)
      .where(and(eq(attestations.providerId, p.id), or(eq(attestations.ok, true), sql`(${attestations.detail} -> 'pin_changed') is not null`)))
      .orderBy(desc(attestations.id))
      .limit(1);
    if (!verdict || verdict.ok) continue;
    gateways++;
    const fields = (verdict.detail as { pin_changed?: unknown } | null)?.pin_changed;
    for (const f of GATEWAY_PIN_FIELDS) if (Array.isArray(fields) && fields.includes(f)) changed.add(f);
  }
  if (!gateways) return [];
  return [{ code: "gateway_pin_mismatch", reason: "measurement_or_keyset_changed", message: `An attested gateway's evidence no longer matches its measurement pin (${[...changed].join(", ") || "identifiers"} changed). It is not attested and the SEALED lane does not serve it; nothing was adopted. Appraise the change, then re-pin with deploy/production/seed-gateway.ts.` }];
}

export function parseTdxQuote(hex: string): TdxFields {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length < 632) throw new Error(`TDX quote too short (${b.length} bytes)`);
  const version = b.readUInt16LE(0);
  // R5-11: only version 4 is read. A version-5 quote has six more bytes (body type and size) between the header and the
  // TD report, so the offsets below would read other fields; it is refused until it is parsed at its own offsets.
  if (version !== 4) throw new Error(`unsupported quote version ${version}`);
  const body = 48;
  const at = (off: number, len: number) => b.subarray(body + off, body + off + len).toString("hex");
  return { mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), reportData: at(520, 64) };
}

export function nonceBound(reportData: string, nonce: string, signingAddress?: string) {
  const n = nonce.replace(/^0x/, "").toLowerCase();
  const rd = reportData.toLowerCase();
  if (rd.includes(n)) return true;
  if (signingAddress) {
    const bound = sha256(Buffer.concat([Buffer.from(signingAddress.replace(/^0x/, ""), "hex"), Buffer.from(n, "hex")]));
    if (rd.startsWith(bound)) return true;
  }
  return false;
}

/** Run every configured verifier over the quote. Rejections from any one of them fail the attestation. */
async function verifyQuote(ctx: Ctx, input: VerifierInput): Promise<VerifyOutcome> {
  const a = ctx.cfg.attestation;
  // R5-11: where a TCB status is required (production), a quote is accepted only if a verifier that checks one is
  // listed: `dcap` (which then refuses an answer without a status) or `intel-ta`. `tee-cloud` and `dstack` report none.
  if (a.requireTcbStatus && !a.verifiers.some((n) => n === "dcap" || n === "intel-ta")) return { ok: false, reason: "quote not verified: no configured verifier checks the platform's TCB status (ATTESTATION_VERIFIERS needs dcap or intel-ta)", verifiers: [] };
  return verifyWithAll(createVerifiers(a), input);
}

/** Map a sidecar attestation document onto the report fields this attestor reads. Anything else passes through. */
export function normalizeSidecarReport(report: Record<string, any>): Record<string, any> {
  if (report?.type !== "trellis.sidecar.attestation") return report;
  const ev = (report.evidence ?? {}) as Record<string, any>;
  const dev = report.dev === true || ev.dev === true;
  return {
    ...report,
    kind: dev ? "dev" : report.kind,
    nonce: ev.nonce ?? report.nonce,
    measurement: ev.measurements?.measurement ?? report.measurement,
    intel_quote: typeof ev.quote === "string" && !dev ? ev.quote : undefined,
    event_log: typeof ev.event_log === "string" ? ev.event_log : undefined,
    sidecar_bindings: report.bindings,
  };
}

async function verifyNvidia(ctx: Ctx, payload: string) {
  const res = await deadlineFetch(ctx.cfg.attestation.nrasUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: payload, redirect: "error" }, { ms: 30_000, what: "NRAS" }); // R4-01
  if (!res.ok) return { ok: false, reason: `NRAS HTTP ${res.status}` };
  const j = (await boundedJson(res)) as unknown;
  // NRAS returns [["JWT", "<overall token>"], {...per-GPU tokens}]; read the overall claim.
  const tokens = JSON.stringify(j).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
  for (const t of tokens) {
    try {
      const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
      if (claims["x-nvidia-overall-att-result"] === true) return { ok: true };
    } catch {
      /* next */
    }
  }
  return { ok: false, reason: "NRAS overall attestation result was not true" };
}

/** What an attestation row records about the GPU (detail.gpu); read back by GET /api/v1/attestation/:providerId. */
export function gpuRecord(g: GpuEvidenceOutcome, verifiedAt: Date) {
  return {
    claimed: g.claimed,
    cc_verified: g.verified,
    models: g.models,
    gpus: g.gpus,
    // When the router checked the evidence, when the endpoint took it, and when its tokens stop being valid.
    verified_at: g.verified ? verifiedAt.toISOString() : null,
    evidence_at: g.evidenceAt,
    expires_at: g.expiresAt,
    evidence_sha256: g.evidenceSha256,
    issuer: g.issuer,
    ...(g.verified ? {} : { failures: g.failures.slice(0, 8).map((f) => f.code) }),
  };
}

export async function attestProvider(ctx: Ctx, p: typeof providers.$inferSelect, networkAdmission = false) {
  if (!["shadow", "live"].includes(p.status) && !probationDiscovery(ctx.cfg, p)) throw new Error("Provider requires operator approval before attestation.");
  const nonce = randomBytes(32).toString("hex");
  const url = new URL(p.attestationUrl!);
  url.searchParams.set("nonce", nonce);
  let report: Record<string, any>;
  const fail = async (raw: string, extra: Record<string, unknown> = {}) => {
    const reason = String(raw).slice(0, 400); // R5-11: a reason can quote what the endpoint sent
    await ctx.db.insert(attestations).values({ providerId: p.id, ok: false, teeKind: p.teeKind, nonce, detail: { reason, ...extra } });
    await ctx.db.update(providers).set({ attested: false, updatedAt: new Date() }).where(eq(providers.id, p.id));
    await ctx.db.update(providers).set({ classifierEnabled: false }).where(eq(providers.id, p.id)); // unknown is false
    await clearAttestedPolicy(ctx.db, p.id);
    return { provider: p.id, ok: false, reason };
  };
  const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production };
  // A certificate that names an attestation reference is only as trustworthy as the quote it names: every fetch
  // below accepts exactly that certificate, and the checks further down must prove it.
  let peer: PeerCertificate | null = null;
  // The certificate the endpoint presented, whatever it names (an aci/1 gateway's key must be in its keyset).
  let presented: PeerCertificate | null = null;
  if (url.protocol === "https:") {
    try {
      const described = describePeerCertificate(await peekProviderCertificate(url, policy, AbortSignal.timeout(20_000)));
      presented = described;
      if (described.attestationRef) peer = described;
    } catch {
      peer = null; // an ordinary endpoint (or an unreachable one): the fetch below checks it against public CAs
    }
  }
  const tlsPin = peer ? { certPem: peer.certPem, spkiSha256: peer.spkiSha256 } : null;
  const getReport = async (target: URL) => {
    const res = await providerFetch(target, { redirect: "error", signal: AbortSignal.timeout(20_000) }, { ...policy, tlsPin });
    if (!res.ok) throw Object.assign(new Error(`attestation endpoint HTTP ${res.status}`), { http: true });
    return normalizeSidecarReport((await boundedJson(res)) as Record<string, any>);
  };
  try {
    report = await getReport(url);
  } catch (e) {
    return fail((e as { http?: boolean }).http ? (e as Error).message : `attestation endpoint unreachable: ${(e as Error).message}`);
  }
  // R5-11: a body that is not a JSON object is a failed attestation (it used to throw below: no row, still attested).
  if (!report || typeof report !== "object" || Array.isArray(report)) return fail("the attestation endpoint did not return a JSON object");
  const [allow] = await ctx.db.select().from(kv).where(eq(kv.key, `attest-allow:${p.id}`));
  const allowlist = (allow?.value ?? null) as MeasurementAllowlist;
  const measurements: Record<string, string> = {};
  let verifiedBy: string[] = [];
  let bound: Digests | null = null;
  let quoteHex: string | null = null;
  let bindingsCommitted = false;
  let gpu: GpuEvidenceOutcome | null = null;

  // R5-02 ("Protocol binding" in the header): the provider's records and the configuration choose the protocol, the
  // row chooses the TEE kind; the answer chooses neither.
  const aci = isAciReport(report);
  const gatewayBound = ctx.cfg.attestation.gatewayOnly === true || gatewayPin(allowlist).listed.keyset_digest || !!(await loadAciGateway(ctx.db, p.id));
  if (gatewayBound && !aci) return fail(GATEWAY_PROTOCOL_REASON);
  if (aci) {
    if (p.teeKind !== "tdx") return fail("an aci/1 report attests only a provider registered as tdx");
    if (peer) return fail("an aci/1 gateway is pinned by the key its keyset lists, not by a self-signed attestation certificate");
    return attestAciGateway(ctx, p, { url, nonce, report, presented, allowlist, fail });
  }
  // R5-02: a success below never deletes a TLS pin. A provider that holds one and now answers through a certificate
  // that proves nothing by a quote is refused instead; an operator removes the pin to change how it is reached.
  if (!peer && (await loadTlsPin(ctx.db, p.id))) return fail("the provider holds a TLS pin, and the certificate it presented is not one a quote proves");
  if (peer && (p.teeKind === "dev" || report.kind === "dev" || !report.intel_quote)) return fail("a self-signed endpoint must prove its certificate with a hardware TDX quote");
  if (p.teeKind === "dev" || report.kind === "dev") {
    if (!ctx.cfg.attestation.allowDev) return fail("dev attestation is disabled");
    if (String(report.nonce).replace(/^0x/, "") !== nonce) return fail("nonce mismatch");
    measurements.measurement = String(report.measurement ?? "");
    if (allowlist?.measurement?.length && !allowlist.measurement.includes(measurements.measurement)) return fail("measurement not in allowlist", measurements);
  } else {
    // R5-02: only TDX quotes are verified. The SEV-SNP branch that stood here bound no nonce, compared no allow-list
    // and checked no debug bit, and no configured verifier checks an SNP report: such a report attests nobody.
    if (!report.intel_quote) return fail(report.snp_report ? "report has no TEE quote this router verifies: SEV-SNP reports are not verified" : "report has no TEE quote");
    {
      let f: TdxFields;
      try {
        f = parseTdxQuote(report.intel_quote);
      } catch (e) {
        return fail(`unparseable TDX quote: ${(e as Error).message}`);
      }
      Object.assign(measurements, { mrtd: f.mrtd, rtmr0: f.rtmr0, rtmr1: f.rtmr1, rtmr2: f.rtmr2, rtmr3: f.rtmr3 });
      if (!nonceBound(f.reportData, nonce, typeof report.signing_address === "string" ? report.signing_address : undefined)) return fail("nonce is not bound into report_data", measurements);
      if (report.sidecar_bindings !== undefined) {
        bound = digestsFromBindings(report.sidecar_bindings);
        if (!bound) return fail("sidecar bindings carry no valid image, compose and model digests", measurements);
        if (!bindingsCommittedIn(f.reportData, report.sidecar_bindings)) return fail("sidecar bindings are not committed in report_data", measurements);
        bindingsCommitted = true;
      }
      const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: report.intel_quote, registers: f, eventLog: report.event_log ?? null, vmConfig: typeof report.vm_config === "string" ? report.vm_config : null });
      if (!q.ok) return fail(q.reason!, measurements);
      // A compose hash recovered from evidence a verifier validated must be the one the bindings commit to.
      if (bound && q.composeHash && q.composeHash !== bound.composeHash.slice(2)) return fail("compose hash in the bindings does not match the verified event log", measurements);
      verifiedBy = q.verifiers;
      quoteHex = report.intel_quote;
      if (allowlist?.mrtd?.length && !allowlist.mrtd.includes(f.mrtd)) return fail("MRTD not in allowlist", measurements);
      if (allowlist?.rtmr3?.length && !allowlist.rtmr3.includes(f.rtmr3)) return fail("RTMR3 not in allowlist", measurements);
      const boundKey = String((report.sidecar_bindings as Record<string, unknown> | undefined)?.tls_pubkey ?? "").toLowerCase();
      if (peer) {
        const pinned = await provePinnedCertificate(ctx, p, peer, report, getReport);
        if (pinned) return fail(pinned, measurements);
      } else if (url.protocol === "https:" && boundKey) {
        // The sidecar terminates TLS itself with the key it binds; any other certificate here is someone else's.
        return fail("the endpoint did not present the TLS key its quote binds", measurements);
      }
    }
    // GPU evidence a sidecar publishes. Only after the quote verified and its report_data committed to the bindings:
    // the evidence is tied to the enclave through those bindings (the hash of the boot record, and the keys the nonce
    // is derived from). A registration as nvidia-cc is a claim too, so such a sidecar cannot attest its CPU side only.
    const sidecarDocument = report.sidecar_bindings !== undefined;
    gpu = await gpuEvidenceVerifier(ctx.cfg.attestation).verify(report, { bindings: report.sidecar_bindings, committed: bindingsCommitted && verifiedBy.length > 0, declared: sidecarDocument && p.teeKind === "nvidia-cc" });
    if (gpu.claimed && !gpu.verified) return fail(`GPU confidential-computing evidence did not verify: ${gpu.reason}`, { ...measurements, gpu_cc_verified: false, gpu: gpuRecord(gpu, new Date()) });
    if ((p.teeKind === "nvidia-cc" && !sidecarDocument) || report.nvidia_payload) {
      if (!report.nvidia_payload) return fail("GPU evidence missing");
      const payload = typeof report.nvidia_payload === "string" ? report.nvidia_payload : JSON.stringify(report.nvidia_payload);
      if (!payload.includes(nonce)) return fail("GPU evidence is not bound to our nonce");
      const g = await verifyNvidia(ctx, payload);
      if (!g.ok) return fail(g.reason!);
    }
  }
  // Whether the report says the in-enclave hard-block classifier is on. Trusted only from committed bindings of a
  // verified hardware quote (or, outside production, from a development report); see router/lane.ts.
  const simulated = p.teeKind === "dev" || report.kind === "dev";
  const evidence = { hardwareVerified: verifiedBy.length > 0, bindingsCommitted, simulated, allowDev: ctx.cfg.attestation.allowDev };
  const classifierEnabled = classifierFromReport(report, evidence);
  // The hash of the policy that classifier enforces, under the same rule (reported as X-Trellis-Policy-Hash).
  const policyHash = policyHashFromReport(report, evidence);
  const reportHash = "0x" + sha256(canonicalJson({ report, nonce }));
  // True only for GPU evidence that verified under a hardware quote; a development report never sets it.
  const gpuCcVerified = !simulated && gpu?.verified === true;
  await ctx.db.insert(attestations).values({ providerId: p.id, ok: true, teeKind: p.teeKind ?? report.kind ?? null, reportHash, nonce, measurements, detail: { signing_address: report.signing_address ?? null, verifiers: verifiedBy, simulated: p.teeKind === "dev" || report.kind === "dev", classifier_enabled: classifierEnabled, gpu_cc_verified: gpuCcVerified, ...(gpu?.claimed ? { gpu: gpuRecord(gpu, new Date()) } : {}) } });
  // Transparency log (a no-op unless TLOG_ENABLED): the keys a hardware-verified quote bound, never simulated evidence.
  if (bindingsCommitted && verifiedBy.length && !simulated) keyPublished(ctx.db, "attestation_binding", attestationBindingEntry(p.id, report.sidecar_bindings, peer?.attestationRef ?? null));
  // A measurement is recorded only from a hardware quote a verifier accepted; never from simulated evidence.
  if (ctx.cfg.measurements.enabled && bound && quoteHex && verifiedBy.length) {
    try {
      await recordMeasurement(ctx, { providerId: p.id, digests: bound, verifiers: verifiedBy, teeKind: p.teeKind ?? report.kind ?? null, quoteHex, reportHash });
    } catch (e) {
      log.error("recording the measurement failed", { provider: p.id, error: (e as Error).message });
    }
  }
  // From now on the provider's connections accept only the certificate this attestation proved. R5-02: nothing is
  // deleted here. A provider that held a pin and presented no quote-proven certificate was refused above, and one that
  // holds a gateway keyset never reaches this path (it attests by aci/1 only).
  if (peer) await saveTlsPin(ctx.db, p.id, { certPem: peer.certPem, spkiSha256: peer.spkiSha256, attestationRef: peer.attestationRef!, pinnedAt: new Date().toISOString() });
  await ctx.db.update(providers).set({ attested: true, attestationHash: reportHash, attestedAt: new Date(), updatedAt: new Date() }).where(eq(providers.id, p.id));
  await ctx.db.update(providers).set({ classifierEnabled }).where(eq(providers.id, p.id));
  await saveAttestedPolicy(ctx.db, p.id, policyHash, reportHash);
  return { provider: p.id, ok: true, hash: reportHash, ...(networkAdmission && ctx.cfg.networkHosts.enabled ? { networkEvidence: { tee_kind: report.intel_quote ? "tdx" : p.teeKind ?? "unknown", hardware_verified: verifiedBy.length > 0, bindings_committed: bindingsCommitted, simulated, dev: simulated, gpu_cc_verified: gpuCcVerified, bindings: report.sidecar_bindings ?? {} } } : {}), gpu_cc_verified: gpuCcVerified, host_policy_bindings: { ...sidecarHostPolicyBindings(report.sidecar_bindings, { ...evidence, teeKind: p.teeKind ?? "tdx" }), gpu_cc_verified: gpuCcVerified }, ...(peer ? { tls_pin: { spki_sha256: peer.spkiSha256, attestation_ref: peer.attestationRef } } : {}) };
}

/** Verify an aci/1 gateway report (see the header comment and providers/aci.ts) and record what it established. */
async function attestAciGateway(
  ctx: Ctx,
  p: typeof providers.$inferSelect,
  o: {
    url: URL;
    nonce: string;
    report: Record<string, any>;
    presented: PeerCertificate | null;
    allowlist: MeasurementAllowlist;
    fail: (reason: string, extra?: Record<string, unknown>) => Promise<{ provider: string; ok: boolean; reason: string }>;
  },
) {
  const quoteHex = typeof o.report.attestation?.evidence?.quote === "string" ? o.report.attestation.evidence.quote : "";
  let f: TdxFields;
  try {
    f = parseTdxQuote(quoteHex);
  } catch (e) {
    return o.fail(`unparseable TDX quote: ${(e as Error).message}`);
  }
  const measurements = { mrtd: f.mrtd, rtmr0: f.rtmr0, rtmr1: f.rtmr1, rtmr2: f.rtmr2, rtmr3: f.rtmr3 };
  let checked: ReturnType<typeof checkAciReport>;
  try {
    checked = checkAciReport(o.report, { nonce: o.nonce, nowS: Math.floor(Date.now() / 1000), host: o.url.hostname, quoteReportData: f.reportData, quoteRtmr3: f.rtmr3 });
  } catch {
    // R5-11: a report shaped to break the check (nesting too deep to walk, for one) is a failed attestation, not a crash.
    return o.fail("malformed aci/1 report", measurements);
  }
  if (!checked.ok) return o.fail(checked.reason, measurements);
  const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: checked.quoteHex, registers: f, eventLog: checked.eventLog, vmConfig: checked.vmConfig });
  if (!q.ok) return o.fail(q.reason!, measurements);
  const g = checked.gateway;
  if (q.composeHash && g.composeHash && q.composeHash !== g.composeHash) return o.fail("the compose hash the verifiers report is not the one the event log measured", measurements);
  // The measurement pin (R5-03; "Gateway measurement pin" in the header states the invariant): every identifier this
  // evidence carries against the operator's pin, after the verifiers accepted the quote and before anything is stored.
  // Required where the configuration says so, enforced wherever a list is given. Nothing below this point runs, so
  // no keyset and no TLS key is adopted, unless the comparison passed.
  const carried: { [K in GatewayPinField]: string | null } = { ...measurements, compose_hash: g.composeHash ?? q.composeHash ?? null, os_image_hash: g.osImageHash, app_id: g.appId, key_provider: g.keyProvider ?? null, keyset_digest: g.keysetDigest };
  const allow = gatewayPin(o.allowlist);
  const off = gatewayPinMismatch(allow, carried, ctx.cfg.attestation.requireAllowlist);
  if (off) {
    // What the refusal records: the identifiers of the quote the verifiers accepted (each cut to the longest value a pin
    // can hold), and which of them are not as pinned. `pin_changed` is what the alarm reads (gatewayPinWarnings).
    const seen = Object.fromEntries(GATEWAY_PIN_FIELDS.filter((k) => carried[k]).map((k) => [k, carried[k]!.slice(0, 1024)]));
    return o.fail(off.reason, { ...seen, ...(off.changed.length ? { pin_changed: off.changed } : {}), ...(off.unpinned.length ? { pin_missing: off.unpinned } : {}) });
  }
  if (!allow.pinned && !warnedUnpinned.has(p.id)) {
    warnedUnpinned.add(p.id);
    log.warn("attested gateway has no complete measurement allow-list (MRTD, RTMR0 to RTMR3 and the keyset digest): any genuine TDX guest at its address is attested; production refuses this", { provider: p.id });
  }
  const https = o.url.protocol === "https:";
  if (https) {
    if (!o.presented) return o.fail("the endpoint's TLS certificate could not be read", measurements);
    if (!g.tlsSpki.includes(o.presented.spkiSha256)) return o.fail("the endpoint's TLS key is not one its attested keyset lists for this host", measurements);
  } else if (ctx.cfg.production) return o.fail("an attested gateway must be reached over https", measurements);

  const reportHash = "0x" + sha256(canonicalJson({ report: o.report, nonce: o.nonce }));
  await ctx.db.insert(attestations).values({
    providerId: p.id,
    ok: true,
    teeKind: p.teeKind ?? "tdx",
    reportHash,
    nonce: o.nonce,
    // The gateway's compose hash with the registers, so the attestation history shows each gateway release.
    measurements: { ...measurements, ...(g.composeHash ? { compose_hash: g.composeHash } : {}) },
    detail: {
      signing_address: null,
      verifiers: q.verifiers,
      simulated: false,
      classifier_enabled: false,
      aci: {
        keyset_digest: g.keysetDigest,
        workload_id: g.workloadId,
        receipt_keys: g.receiptKeys.map((k) => k.key_id),
        tls_spki_sha256: https ? o.presented!.spkiSha256 : null,
        compose_hash: g.composeHash,
        os_image_hash: g.osImageHash,
        app_id: g.appId,
        key_provider: g.keyProvider ?? null,
        source_provenance: g.sourceProvenance,
        not_after: g.notAfter,
        stale_after: g.staleAfter,
        serving: g.serving,
        keyset_endorsement: g.keysetEndorsement,
      },
    },
  });
  await saveAciGateway(ctx.db, p.id, g);
  const pin = https ? { certPem: "", spkiSha256: o.presented!.spkiSha256, attestationRef: g.keysetDigest.slice("sha256:".length), pinnedAt: new Date().toISOString(), spkiOnly: true } : null;
  if (pin) await saveTlsPin(ctx.db, p.id, pin); // R5-02: over http (never in production) a pin held from before is left alone, not deleted
  // No in-enclave classifier is bound here, so restricted variants never route to a gateway (router/lane.ts).
  await ctx.db.update(providers).set({ attested: true, attestationHash: reportHash, attestedAt: new Date(), classifierEnabled: false, updatedAt: new Date() }).where(eq(providers.id, p.id));
  await clearAttestedPolicy(ctx.db, p.id);
  return { provider: p.id, ok: true, hash: reportHash, aci: { keyset_digest: g.keysetDigest }, ...(pin ? { tls_pin: { spki_sha256: pin.spkiSha256, attestation_ref: pin.attestationRef } } : {}) };
}

/**
 * The checks that let a self-signed certificate stand in for a CA: returns a failure reason, or null when the
 * certificate is proven. The fresh, nonce-bound report has already passed every ordinary check.
 */
async function provePinnedCertificate(ctx: Ctx, p: typeof providers.$inferSelect, peer: PeerCertificate, fresh: Record<string, any>, getReport: (u: URL) => Promise<Record<string, any>>): Promise<string | null> {
  const bindsPeerKey = (bindings: unknown) => !!bindings && typeof bindings === "object" && String((bindings as Record<string, unknown>).tls_pubkey ?? "").toLowerCase() === peer.spkiHex;
  if (fresh.sidecar_bindings === undefined) return "a self-signed endpoint must serve a sidecar attestation document";
  if (!bindsPeerKey(fresh.sidecar_bindings)) return "the certificate's key is not the TLS key the quote binds";
  // The certificate names its boot quote by hash: fetch that quote (no nonce) over the same pinned connection.
  const bootUrl = new URL(p.attestationUrl!);
  bootUrl.searchParams.delete("nonce");
  let boot: Record<string, any>;
  try {
    boot = await getReport(bootUrl);
  } catch (e) {
    return `boot attestation unreachable: ${(e as Error).message}`;
  }
  const bootQuote = typeof boot.intel_quote === "string" ? boot.intel_quote.replace(/^0x/, "").toLowerCase() : "";
  if (!bootQuote || sha256(Buffer.from(bootQuote, "hex")) !== peer.attestationRef) return "the certificate's attestation reference is not the hash of the quote the endpoint serves";
  let f: TdxFields;
  try {
    f = parseTdxQuote(bootQuote);
  } catch (e) {
    return `unparseable boot quote: ${(e as Error).message}`;
  }
  if (!bindsPeerKey(boot.sidecar_bindings) || !bindingsCommittedIn(f.reportData, boot.sidecar_bindings)) return "the quote the certificate names does not bind the certificate's key";
  // One process, one set of bindings: the boot quote and the fresh one must commit to the same values.
  if (canonicalJson(boot.sidecar_bindings) !== canonicalJson(fresh.sidecar_bindings)) return "the boot and fresh quotes bind different values";
  const q = await verifyQuote(ctx, { kind: "tdx", quoteHex: bootQuote, registers: f, eventLog: boot.event_log ?? null, vmConfig: typeof boot.vm_config === "string" ? boot.vm_config : null });
  if (!q.ok) return `the quote the certificate names did not verify: ${q.reason}`;
  const bootDigests = digestsFromBindings(boot.sidecar_bindings);
  if (q.composeHash && bootDigests && q.composeHash !== bootDigests.composeHash.slice(2)) return "compose hash in the boot bindings does not match the verified evidence";
  return null;
}

export async function runAttestor(ctx: Ctx) {
  const rows = await ctx.db.select().from(providers).where(and(or(inArray(providers.status, ["shadow", "live"]), probationRegistryFilter(ctx.cfg)), isNotNull(providers.attestationUrl), isNotNull(providers.teeKind)));
  const results = [];
  for (const p of rows) {
    try {
      const startedAt = new Date();
      const result = await renewHostAttestation(ctx, p, await attestProvider(ctx, p));
      results.push(result);
      await recordAttestorRun(ctx, p, result, startedAt); // the public proof-time record; never throws
    } catch (e) {
      log.error("attestation crashed", { provider: p.id, error: (e as Error).message });
    }
  }
  await pruneAttestationEvents(ctx).catch((e) => log.warn("pruning the attestation history failed", { error: (e as Error).message }));
  await ctx.catalog.refresh();
  return { results };
}
