// Register the attested gateway (the SEALED lane's launch supply) on this router, under the router's own configuration:
// the provider row, one attestor pass, the gateway's catalogue at its own per-token prices, and (only when asked) the
// operator's retention declaration that lets the attested lane serve it.
//
//   bun deploy/production/seed-gateway.ts                 register, attest, sync the catalogue
//   bun deploy/production/seed-gateway.ts --check         read-only against the gateway: attest in a throwaway in-memory router, list models
//   bun deploy/production/seed-gateway.ts --declare "<source>"   also record the operator declaration (see below)
//
// Settings come from the environment (deploy/production/.env.production, secrets/providers.env):
//   PRIVATE_AI_BASE_URL, PRIVATE_AI_ATTESTATION_URL   the gateway's OpenAI-compatible base URL and its aci/1 attestation URL
//   PRIVATE_AI_API_KEY                                the gateway API key; stored encrypted with APP_SECRET, never printed
// bootstrap.sh runs it inside the application image, so it uses the same database and APP_SECRET as the router.
//
// It follows scripts/demo/private-ai.ts (the devnet walkthrough) step for step, without that script's devnet
// environment: the provider id is the one src/e2ee/config.ts names, the attestor is the router's own job, and the
// models are what src/providers/aci.ts accepts from the gateway's catalogue (served inside a TEE, priced, with a
// context length).
//
// Prices. The gateway's prices are copied into the provider row when this script runs; the registry job does not read
// them again. Pricing is zero markup, so run this script again whenever the gateway changes its prices or its model
// list (it is idempotent), for example daily from the host's scheduler.
//
// Measurement pin (security review round 5, R5-03). A production router attests a gateway only against a pin that names
// every identifier the gateway's evidence carries (src/services/attestor.ts, ATTESTATION_REQUIRE_ALLOWLIST): without one
// this script's attestor step fails and says so. This script is the only thing that writes the pin, and it writes
// exactly what these settings name (each a comma list of accepted values):
//   PRIVATE_AI_MRTD                                        the virtual firmware the TD was built with (96 hex)
//   PRIVATE_AI_RTMR0, PRIVATE_AI_RTMR1, PRIVATE_AI_RTMR2   virtual hardware and firmware configuration, kernel, command
//                                                          line and initrd (96 hex each)
//   PRIVATE_AI_RTMR3                                       what the guest extended at run time (96 hex)
//   PRIVATE_AI_KEYSET_DIGEST                               sha256:<64 hex> of the gateway's workload keyset: its receipt
//                                                          keys, request-encryption keys and TLS keys
//   PRIVATE_AI_COMPOSE_HASH, PRIVATE_AI_OS_IMAGE_HASH, PRIVATE_AI_APP_ID, PRIVATE_AI_KEY_PROVIDER
//                                                          the same facts as RTMR3 measures them, read from the event
//                                                          log; required whenever the gateway's evidence carries them
// The first six are always required. Run --check first: it prints, as settings, every identifier of the quote the
// verifiers accepted. Compare them with the release you appraised, set them, and run this script: it stores them before
// the provider row and the attestor pass. Set none of them and a pin stored earlier is left as it is; set some and the
// stored pin is replaced by exactly what is set (an incomplete or malformed set stores nothing).
//
// What the pin does: the attestor compares every identifier the evidence carries with it on every pass (every ten
// minutes) and never writes it. A change in ANY of them, or in the keyset, fails attestation: the gateway is not
// attested, the SEALED lane does not serve it, the keyset and TLS key the router holds stay those of the pinned release,
// and the readiness warning gateway_pin_mismatch (alert TrellisGatewayPinMismatch) is raised until the pinned release
// answers again or you re-pin. To re-pin: run --check, appraise what changed, update the settings, run this script. A
// gateway that redeploys (RTMR3 holds its instance id) or rotates its keyset needs that too; nothing is adopted unseen.
// A scheduled run with unchanged settings re-writes the same pin and adopts nothing.
//
// What the pin does not do: it compares numbers and does not appraise the gateway's source (source_provenance is
// recorded, not checked). It does not cover the TDX module (MRSEAM), the platform's patch level or the quote's
// signature chain, which are the quote verifiers' (ATTESTATION_VERIFIERS: production needs dcap or intel-ta so the TCB
// status is checked), nor TD attributes other than the debug bit, nor the upstream behind the gateway, which each
// response's receipt asserts. The admin call providers.setAttestationAllowlist writes MRTD and RTMR3 only: not a pin.
//
// --declare. The attested lane serves only providers whose retention the operator declares as resting on attestation
// (src/api/disclosure.ts). That is a statement by the operator, so it is never made silently: pass --declare with the
// source you rely on (for example the gateway's published terms and the zero-retention claim in its receipts). Confirm
// the gateway provider's terms allow reselling its API before you do (MAINNET.md).
import { desc, eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { writeDisclosure } from "../../src/api/disclosure.ts";
import { attestations, kv, providers } from "../../src/db/schema.ts";
import { E2EE_GATEWAY_PROVIDER } from "../../src/e2ee/config.ts";
import { encrypt } from "../../src/lib/util.ts";
import { aciStaticModels, loadAciGateway } from "../../src/providers/aci.ts";
import { boundedJson, providerFetch } from "../../src/providers/network.ts";
import { loadTlsPin } from "../../src/providers/tls-pin.ts";
import { GATEWAY_PIN_FIELDS, GATEWAY_UNPINNED_REASON, gatewayPin, runAttestor, type GatewayPinField } from "../../src/services/attestor.ts";
import { parseProviderModels, syncProvider } from "../../src/services/registry.ts";

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const declareAt = argv.indexOf("--declare");
const declareSource = declareAt >= 0 ? argv[declareAt + 1] : undefined;
if (declareAt >= 0 && (!declareSource || declareSource.startsWith("--") || declareSource.length < 20)) { console.error('--declare needs the source of the declaration in quotes (a sentence naming what you rely on).'); process.exit(2); }
const BASE_URL = (process.env.PRIVATE_AI_BASE_URL ?? "").replace(/\/$/, "");
const ATTESTATION_URL = process.env.PRIVATE_AI_ATTESTATION_URL || (BASE_URL ? `${BASE_URL}/aci/attestation` : "");
if (!BASE_URL) { console.error("PRIVATE_AI_BASE_URL is not set: the attested gateway's base URL."); process.exit(2); }
const gatewayKey = process.env.PRIVATE_AI_API_KEY || undefined;
/** The setting that pins each identifier (see the header). */
const PIN_SETTINGS: Record<GatewayPinField, string> = { mrtd: "PRIVATE_AI_MRTD", rtmr0: "PRIVATE_AI_RTMR0", rtmr1: "PRIVATE_AI_RTMR1", rtmr2: "PRIVATE_AI_RTMR2", rtmr3: "PRIVATE_AI_RTMR3", compose_hash: "PRIVATE_AI_COMPOSE_HASH", os_image_hash: "PRIVATE_AI_OS_IMAGE_HASH", app_id: "PRIVATE_AI_APP_ID", key_provider: "PRIVATE_AI_KEY_PROVIDER", keyset_digest: "PRIVATE_AI_KEYSET_DIGEST" };
const settingList = (name: string) => (process.env[name] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const pinSettings: { [K in GatewayPinField]?: string[] } = {};
for (const f of GATEWAY_PIN_FIELDS) if (settingList(PIN_SETTINGS[f]).length) pinSettings[f] = settingList(PIN_SETTINGS[f]);
const PROVIDER_ID = E2EE_GATEWAY_PROVIDER;

// --check never touches the router's database: a throwaway in-memory router in development mode, with the public
// quote verifier unless the environment names others.
const env = CHECK
  ? { TRELLIS_ENV: "development", DATABASE_URL: "pglite://memory", REDIS_URL: "", RUNTIME_ROLE: "all", AUTO_MIGRATE: "true", HOST: "127.0.0.1", PUBLIC_BASE_URL: "http://127.0.0.1:8787", APP_SECRET: "x".repeat(48), ATTESTATION_VERIFIERS: process.env.ATTESTATION_VERIFIERS || "tee-cloud", WORKERS: "false", WORKER_JOBS: "" }
  : undefined;
const { ctx, close } = await createApp({ ...(env ? { env } : {}), startJobs: false });
let failed = false;
const say = (ok: boolean | null, what: string, detail = "") => { if (ok === false) failed = true; console.log(`  [${ok === null ? "note" : ok ? "ok  " : "FAIL"}] ${what}${detail ? `: ${detail}` : ""}`); };
try {
  console.log(`attested gateway ${new URL(BASE_URL).host} as provider ${PROVIDER_ID}${CHECK ? "  (check only: in-memory router, nothing stored)" : ""}`);
  // The operator's measurement pin, stored before the provider row exists and before the attestor reads it, so the
  // provider is never attestable without it. Exactly what the settings name; never written by --check, and never
  // derived from what the gateway serves.
  if (!CHECK && Object.keys(pinSettings).length) {
    const pin = gatewayPin(pinSettings);
    const malformed = GATEWAY_PIN_FIELDS.filter((f) => pin.values[f].length !== (pinSettings[f]?.length ?? 0));
    if (pin.pinned && !malformed.length) {
      const value = Object.fromEntries(GATEWAY_PIN_FIELDS.filter((f) => pin.listed[f]).map((f) => [f, pin.values[f]]));
      await ctx.db.insert(kv).values({ key: `attest-allow:${PROVIDER_ID}`, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      say(true, "measurement pin", `${Object.keys(value).join(", ")} stored for ${PROVIDER_ID}`);
    } else say(false, "measurement pin", `${malformed.length ? `malformed: ${malformed.map((f) => PIN_SETTINGS[f]).join(", ")}. ` : ""}PRIVATE_AI_MRTD, PRIVATE_AI_RTMR0 to PRIVATE_AI_RTMR3 and PRIVATE_AI_KEYSET_DIGEST must all be set (registers: 96 hex characters; keyset digest: sha256:<64 hex>); nothing was stored`);
  }
  const values = {
    name: "Attested gateway",
    baseUrl: BASE_URL,
    ...(gatewayKey ? { apiKeyEnc: encrypt(ctx.cfg.appSecret, gatewayKey) } : {}),
    status: "live" as const,
    // The router asks the gateway for a zero-retention, TEE-verified upstream on every request (ACI_CONSTRAINTS).
    dataPolicy: { training: false, retains_prompts: false, zdr: true },
    teeKind: "tdx",
    attestationUrl: ATTESTATION_URL,
  };
  await ctx.db.insert(providers).values({ id: PROVIDER_ID, ...values }).onConflictDoUpdate({ target: providers.id, set: { ...values, updatedAt: new Date() } });
  say(gatewayKey ? true : null, "provider row", gatewayKey ? "API key stored encrypted" : "no PRIVATE_AI_API_KEY: registered without a key, so paid calls will fail until it is set");

  const { results } = await runAttestor(ctx);
  const r = (results as { provider: string; ok: boolean; reason?: string; hash?: string }[]).find((x) => x.provider === PROVIDER_ID);
  say(!!r?.ok, "attestor (the router's own job)", r?.ok ? `attested with verifiers ${ctx.cfg.attestation.verifiers?.join(", ") ?? "(configured)"}, report hash ${r.hash}` : r?.reason ?? "the attestor did not reach the gateway");
  // What the evidence carries, as the settings that pin it: shown by a --check that verified, and whenever the attestor
  // refused the gateway for its pin (missing, incomplete, or not matching). Only identifiers of a quote the verifiers
  // accepted are ever shown.
  {
    const [last] = await ctx.db.select().from(attestations).where(eq(attestations.providerId, PROVIDER_ID)).orderBy(desc(attestations.id)).limit(1);
    const detail = (last?.detail ?? {}) as Record<string, unknown>;
    const changed = Array.isArray(detail.pin_changed) ? (detail.pin_changed as unknown[]).filter((f): f is GatewayPinField => (GATEWAY_PIN_FIELDS as readonly unknown[]).includes(f)) : [];
    if (!r?.ok && changed.length) say(null, "not as pinned", `${changed.join(", ")}. The gateway is not attested and nothing was adopted. If you appraised this change, re-pin with the settings below`);
    if ((CHECK && r?.ok) || (!r?.ok && (r?.reason === GATEWAY_UNPINNED_REASON || changed.length))) {
      const carried = { ...detail, ...((detail.aci ?? {}) as Record<string, unknown>), ...((last?.measurements ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
      const lines = GATEWAY_PIN_FIELDS.filter((f) => typeof carried[f] === "string" && carried[f]).map((f) => `${PIN_SETTINGS[f]}=${carried[f] as string}`);
      if (lines.length) {
        say(null, "identifiers of the verified quote", "a production router attests this gateway only with every one of them pinned. Appraise the release, then set");
        for (const line of lines) console.log(`           ${line}`);
      }
    }
  }
  if (r?.ok) {
    const stored = await loadAciGateway(ctx.db, PROVIDER_ID);
    say(!!stored, "keyset stored for receipt checks", stored ? `${stored.receiptKeys.length} receipt key(s)` : "missing");
    const pin = await loadTlsPin(ctx.db, PROVIDER_ID);
    const policy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production, tlsPin: pin };
    const res = await providerFetch(`${BASE_URL}/models`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) }, policy);
    if (!res.ok) say(false, "GET /models", `HTTP ${res.status}`);
    else {
      const raw = (await boundedJson(res, 8 * 1024 * 1024)) as { data?: unknown[] };
      const { models, skipped } = aciStaticModels(raw);
      const parsed = parseProviderModels({ data: models });
      say(models.length > 0 && !parsed.errors.length, "catalogue", `${Array.isArray(raw.data) ? raw.data.length : 0} listed, ${models.length} offered inside a TEE with a price and a context length${skipped.length ? `, ${skipped.length} left out` : ""}${parsed.errors.length ? `; ${parsed.errors.length} refused by the router's model schema` : ""}`);
      await ctx.db.update(providers).set({ staticModels: models, updatedAt: new Date() }).where(eq(providers.id, PROVIDER_ID));
      const [provider] = await ctx.db.select().from(providers).where(eq(providers.id, PROVIDER_ID));
      const synced = await syncProvider(ctx, { ...provider!, tlsPin: pin });
      say(synced.models > 0 && !synced.errors.length, "catalogue synced", `${synced.models} offer(s) at the gateway's own prices${synced.errors.length ? `; ${synced.errors.length} refused` : ""}`);
    }
    if (declareSource && !CHECK) {
      const today = new Date().toISOString().slice(0, 10);
      const view = await writeDisclosure(ctx, PROVIDER_ID, { retention: { value: "attested", source: declareSource, as_of: today }, legal_hold: { active: false, source: declareSource, as_of: today } });
      say(view.current.class === "attested", "operator declaration recorded", `disclosure class ${view.current.class}`);
    } else if (!CHECK) say(null, "operator declaration", "not made: the attested lane does not serve this gateway until you run this script with --declare \"<source>\"");
  }
} finally { await close(); }
console.log(failed ? "gateway NOT ready" : CHECK ? "gateway check passed (nothing stored)" : "gateway registered");
process.exit(failed ? 1 : 0);
