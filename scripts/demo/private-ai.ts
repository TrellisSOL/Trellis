// The SEALED ("attested") lane against a live attested inference gateway that speaks aci/1 (src/providers/aci.ts).
//
//   bun scripts/demo/private-ai.ts             # keyless: verify the gateway's attestation with the router's own code
//   bun scripts/demo/private-ai.ts --dry-run   # the demo router on the walkthrough's database: register the gateway,
//                                              # attest it, sync its catalogue, pick a model; no paid call
//   bun scripts/demo/private-ai.ts --call      # the same, then ONE small chat completion on the attested lane, billed
//                                              # from the walkthrough key's prepaid credits; needs PRIVATE_AI_API_KEY
//
// Keyless part. Starts a router in this process on an in-memory database (no .env.devnet, no chain), then:
//   1. runs the attestor's checks one by one with the router's functions, against a fresh 32-byte nonce: the report is
//      aci/1 on TDX, the keyset digest is recomputed, report_data binds the nonce and the digest and is what the quote
//      carries, the dstack event log replays to RTMR3, each configured quote verifier accepts the quote, and the TLS key
//      the endpoint presents is one its attested keyset lists for the host
//   2. registers the gateway as provider `confidential-ai-gateway` and runs the attestor job itself (a second nonce), then
//      reads GET /api/v1/attestation/confidential-ai-gateway back
//   3. reads the gateway's public model catalogue and shows what the router would list from it
// It exits non-zero when any check, or the attestor, refuses the gateway.
//
// Quote verifiers: ATTESTATION_VERIFIERS when set; otherwise tee-cloud (the TEE cloud's public quote verifier, no
// credentials) plus whichever of dcap, dstack and intel-ta has its endpoint or key in the environment. The summary says
// which ran.
//
// Keyed part. The router is started the way devnet-demo.ts starts it (.env.devnet over config/devnet.env.example, the
// pglite database under .data/devnet-demo), so the API key that walkthrough funded pays for the call. The gateway's API key
// is read from PRIVATE_AI_API_KEY (.env.devnet, or the process environment), stored encrypted on the provider row like any
// provider credential and never printed. The call is made once: its receipt id is kept in .data/devnet-demo/private-ai.json
// and a re-run shows that receipt again (--again makes a new paid call).
//
// Options: --model <id> (default: the cheapest chat model the gateway lists inside a TEE), --max-tokens <n> (default 32),
// --base-url <url>, --attestation-url <url>, --db <DATABASE_URL> (for example pglite://memory to try the dry run without
// the walkthrough's database).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { writeDisclosure } from "../../src/api/disclosure.ts";
import type { Ctx } from "../../src/context.ts";
import { providers } from "../../src/db/schema.ts";
import { E2EE_GATEWAY_PROVIDER } from "../../src/e2ee/config.ts";
import { encrypt } from "../../src/lib/util.ts";
import { aciReportData, aciStaticModels, checkAciReport, isAciReport, keysetDigest, loadAciGateway, type AciGateway } from "../../src/providers/aci.ts";
import { boundedJson, peekProviderCertificate, providerFetch } from "../../src/providers/network.ts";
import { describePeerCertificate, loadTlsPin, type PeerCertificate } from "../../src/providers/tls-pin.ts";
import { profileOf } from "../../src/router/disclosure.ts";
import { selectProviders } from "../../src/router/select.ts";
import { normalizeSidecarReport, parseTdxQuote, runAttestor, type TdxFields } from "../../src/services/attestor.ts";
import { createVerifiers } from "../../src/services/attestor-verifiers.ts";
import { parseProviderModels, syncProvider } from "../../src/services/registry.ts";
import { verifyReceipt } from "../../packages/client/src/receipts.ts";
import { ENV_FILE, loadDevnetEnv, readJsonFile, ROOT, STATE_DIR, STATE_FILE, writePrivateFile } from "./lib.ts";

// ---- Arguments and settings --------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
const CALL = flag("call");
const DRY_RUN = flag("dry-run");
const AGAIN = flag("again");
const ROUTED = CALL || DRY_RUN; // the demo router and its database, rather than a throwaway in-memory one
const DB_OVERRIDE = option("db"); // another database than the walkthrough's: nothing about the run is remembered
const MAX_TOKENS = Math.max(1, Math.min(256, Number(option("max-tokens") ?? 32) || 32));
const PROVIDER_ID = E2EE_GATEWAY_PROVIDER;
const KEY_NAME = "PRIVATE_AI_API_KEY";
const RUN_FILE = join(STATE_DIR, "private-ai.json");
/** Paths are printed relative to the repository, so output can be shared without naming a home directory. */
const rel = (path: string) => relative(ROOT, path);

const fileEnv = loadDevnetEnv();
/** A setting from the process environment, then .env.devnet, then config/devnet.env.example. */
const setting = (name: string): string | undefined => process.env[name] || fileEnv[name] || undefined;
const BASE_URL = (option("base-url") ?? setting("PRIVATE_AI_BASE_URL") ?? "").replace(/\/$/, "");
const ATTESTATION_URL = option("attestation-url") ?? setting("PRIVATE_AI_ATTESTATION_URL") ?? (BASE_URL ? `${BASE_URL}/aci/attestation` : "");
if (!BASE_URL) { console.error("No gateway: set PRIVATE_AI_BASE_URL in your environment or .env.devnet or pass --base-url."); process.exit(2); }
/** The gateway API key. Read here, handed to encrypt() once, never logged. */
const gatewayKey = setting(KEY_NAME);
if (CALL && !gatewayKey) { console.error(`--call needs ${KEY_NAME} in ${rel(ENV_FILE)} (or the environment). Without it, run the keyless check or --dry-run.`); process.exit(2); }
if (ROUTED && !existsSync(ENV_FILE)) { console.error(`Missing ${rel(ENV_FILE)}: run \`bun scripts/demo/make-env.ts\` first.`); process.exit(2); }

// ---- Which quote verifiers run ----------------------------------------------------------------------------------------------
const VERIFIER_NEEDS: Record<string, { env: string; what: string }> = {
  dcap: { env: "TDX_VERIFIER_URL", what: "a DCAP verification service (the only one here that reports a TCB status besides intel-ta)" },
  dstack: { env: "DSTACK_VERIFIER_URL", what: "a dstack verifier service" },
  "intel-ta": { env: "INTEL_TA_API_KEY", what: "an Intel Trust Authority API key" },
};
const explicitVerifiers = option("verifiers") ?? setting("ATTESTATION_VERIFIERS");
const verifiersRun: string[] = explicitVerifiers ? explicitVerifiers.split(",").map((v) => v.trim()).filter(Boolean) : ["tee-cloud", ...Object.keys(VERIFIER_NEEDS).filter((v) => setting(VERIFIER_NEEDS[v].env))];
if (verifiersRun.includes("tee-cloud") && !setting("TEE_CLOUD_VERIFIER_URL")) {
  throw new Error("Set TEE_CLOUD_VERIFIER_URL for tee-cloud or select a configured verifier with ATTESTATION_VERIFIERS.");
}
const verifiersSkipped = ["tee-cloud", ...Object.keys(VERIFIER_NEEDS)].filter((v) => !verifiersRun.includes(v));

// ---- Output ------------------------------------------------------------------------------------------------------------------
type Status = "pass" | "FAIL" | "note";
let failures = 0;
const check = (status: Status, what: string, detail = "") => { if (status === "FAIL") failures++; console.log(`  [${status.padEnd(4)}] ${what}${detail ? `: ${detail}` : ""}`); return status === "pass"; };
const row = (label: string, value: unknown) => console.log(`  ${label.padEnd(20)} ${value ?? "(none)"}`);
const short = (hex: string | null | undefined, n = 16) => (hex ? (hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-8)}` : hex) : "(none)");
const perMillion = (usdPerToken: unknown) => { const n = Number(usdPerToken) * 1e6; return Number.isFinite(n) ? `$${n.toFixed(4).replace(/\.?0+$/, "") || "0"}` : "?"; };
type Json = Record<string, any>;

// ---- A second process on the same pglite directory would corrupt it ------------------------------------------------------------
function otherDemoRouter(): string | null {
  try {
    const out = Bun.spawnSync(["ps", "-axo", "pid=,comm=,args="]).stdout.toString();
    for (const l of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      if (!m || Number(m[1]) === process.pid || !/(^|\/)bun$/.test(m[2])) continue;
      const script = /scripts\/demo\/(devnet-demo|private-ai)\.ts(.*)$/.exec(m[3]);
      // A keyless private-ai run uses its own in-memory database and holds nothing.
      if (script && (script[1] === "devnet-demo" || /--(call|dry-run)\b/.test(script[2]))) return `pid ${m[1]} (scripts/demo/${script[1]}.ts${script[2]})`;
    }
  } catch { /* no ps: nothing to check with */ }
  return null;
}

// ---- The router, in process -----------------------------------------------------------------------------------------------------
const passThrough = ["TDX_VERIFIER_URL", "TDX_VERIFIER_KEY", "DSTACK_VERIFIER_URL", "DSTACK_VERIFIER_KEY", "INTEL_TA_API_KEY", "TEE_CLOUD_VERIFIER_URL"];
const verifierEnv: Record<string, string> = { ATTESTATION_VERIFIERS: verifiersRun.join(",") };
for (const k of passThrough) { const v = setting(k); if (v) verifierEnv[k] = v; }
const quiet = { WORKERS: "false", HEALTH_PROBES: "false", CANARIES: "false", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" };
let routerEnv: Record<string, string>;
if (ROUTED) {
  // The walkthrough's router (devnet-demo.ts), with one provider attempt per request so a call is one upstream request.
  const { [KEY_NAME]: _never, ...rest } = fileEnv;
  routerEnv = { ...rest, ...quiet, ...verifierEnv, MAX_PROVIDER_ATTEMPTS: "1", ...(DB_OVERRIDE ? { DATABASE_URL: DB_OVERRIDE } : {}) };
  const busy = !DB_OVERRIDE && routerEnv.DATABASE_URL?.startsWith("pglite://") ? otherDemoRouter() : null;
  if (busy) { console.error(`The walkthrough's database (${routerEnv.DATABASE_URL}) is open in another process: ${busy}.\nWait for it to finish (or stop it), then run this again. The keyless check (no flags) does not use that database.`); process.exit(3); }
} else {
  routerEnv = { TRELLIS_ENV: "development", DATABASE_URL: "pglite://memory", APP_SECRET: randomBytes(32).toString("hex"), ADMIN_TOKEN: randomBytes(24).toString("hex"), ...quiet, ...verifierEnv };
}

console.log(`attested gateway ${CALL ? "call" : DRY_RUN ? "dry run (no paid call)" : "check (keyless)"}`);
row("gateway", BASE_URL);
row("attestation", ATTESTATION_URL);
row("quote verifiers", `${verifiersRun.join(", ")}${verifiersSkipped.length ? `   (not run: ${verifiersSkipped.join(", ")})` : ""}`);
row("database", ROUTED ? routerEnv.DATABASE_URL : "in memory (thrown away)");
row("gateway API key", gatewayKey ? `set (${KEY_NAME})` : "not set");

const { app, ctx, close } = await createApp({ env: routerEnv, startJobs: false });
const networkPolicy = { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production };

async function api(path: string, init: RequestInit & { json?: unknown; auth?: string } = {}): Promise<{ status: number; headers: Headers; body: Json }> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.auth) headers.set("authorization", `Bearer ${init.auth}`);
  const r = await app.request(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await r.text();
  let body: Json = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: r.status, headers: r.headers, body };
}
const must = (r: { status: number; body: Json }, what: string) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };

// ---- 1. The attestor's checks, one at a time ------------------------------------------------------------------------------------
/** Mirrors attestAciGateway (src/services/attestor.ts) with the same functions, printing each result. */
async function inspect(): Promise<{ report: Json; gateway: AciGateway | null; registers: TdxFields | null }> {
  console.log("\n1. the attestor's checks, step by step");
  const nonce = randomBytes(32).toString("hex");
  const url = new URL(ATTESTATION_URL);
  url.searchParams.set("nonce", nonce);
  let presented: PeerCertificate | null = null;
  if (url.protocol === "https:") presented = describePeerCertificate(await peekProviderCertificate(url, networkPolicy, AbortSignal.timeout(20_000)));
  const res = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) }, networkPolicy);
  if (!res.ok) { check("FAIL", "attestation endpoint", `HTTP ${res.status}`); return { report: {}, gateway: null, registers: null }; }
  const report = normalizeSidecarReport((await boundedJson(res)) as Json);
  row("nonce sent", nonce);
  if (!check(isAciReport(report) ? "pass" : "FAIL", "report format", `api_version ${JSON.stringify(report.api_version)}`)) return { report, gateway: null, registers: null };
  const att = report.attestation as Json;
  check(att.tee_type === "tdx" ? "pass" : "FAIL", "TEE type", String(att.tee_type));

  let f: TdxFields;
  try {
    f = parseTdxQuote(typeof att.evidence?.quote === "string" ? att.evidence.quote : "");
    check("pass", "TDX quote parses", `${String(att.evidence.quote).replace(/^0x/, "").length / 2} bytes`);
  } catch (e) {
    check("FAIL", "TDX quote parses", (e as Error).message);
    return { report, gateway: null, registers: null };
  }

  // The binding, spelled out with the exported helpers; checkAciReport below is the check the attestor relies on.
  const digest = att.workload_keyset && typeof att.workload_keyset === "object" ? keysetDigest(att.workload_keyset) : "";
  check(digest === report.workload_keyset_digest ? "pass" : "FAIL", "keyset digest", digest === report.workload_keyset_digest ? "recomputed from the served keyset (sha256 of its JCS form), matches" : `served ${report.workload_keyset_digest}, recomputed ${digest}`);
  if (/^sha256:[0-9a-f]{64}$/.test(digest)) {
    const expected = aciReportData(digest, nonce);
    const bound = att.report_data === expected;
    const noNonce = !bound && att.report_data === aciReportData(digest, null);
    check(bound ? "pass" : "FAIL", "report_data binds this nonce and the keyset", bound ? short(expected, 12) : noNonce ? "the gateway answered with the report_data of a request WITHOUT a nonce (it ignored ?nonce=)" : `expected ${expected}, served ${att.report_data}`);
    const inQuote = f.reportData.toLowerCase() === expected + "00".repeat(32);
    check(inQuote ? "pass" : "FAIL", "the quote carries that report_data", inQuote ? "32 bytes, then 32 zero bytes" : `quote has ${f.reportData}`);
  }
  const checked = checkAciReport(report, { nonce, nowS: Math.floor(Date.now() / 1000), host: url.hostname, quoteReportData: f.reportData, quoteRtmr3: f.rtmr3 });
  if (!checked.ok) { check("FAIL", "checkAciReport (src/providers/aci.ts)", checked.reason); return { report, gateway: null, registers: f }; }
  const g = checked.gateway;
  check("pass", "checkAciReport (src/providers/aci.ts)", `keyset valid until ${new Date(g.notAfter * 1000).toISOString()}${g.staleAfter ? `, report fresh until ${new Date(g.staleAfter * 1000).toISOString()}` : ""}`);
  if (checked.eventLog) check("pass", "event log replays to the quote's RTMR3", g.composeHash ? `measured compose hash ${short(g.composeHash)}${typeof att.evidence.app_compose === "string" ? " = sha256 of the served app_compose" : ""}` : "no compose-hash event");
  else check("note", "event log", "the report carries none, so no compose hash was measured");

  // The quote itself: every configured verifier must accept it (verifyWithAll), shown here one by one.
  const input = { kind: "tdx" as const, quoteHex: checked.quoteHex, registers: f, eventLog: checked.eventLog, vmConfig: checked.vmConfig };
  const composeHashes = new Set<string>();
  for (const v of createVerifiers(ctx.cfg.attestation)) {
    try {
      const r = await v.verify(input);
      if (r.composeHash) composeHashes.add(r.composeHash);
      check(r.ok ? "pass" : "FAIL", `quote verifier ${v.name}`, r.ok ? `accepted (${r.status ?? "ok"})${r.composeHash ? `, compose hash ${short(r.composeHash)}` : ""}` : r.reason ?? "rejected");
    } catch (e) {
      check("FAIL", `quote verifier ${v.name}`, `unreachable: ${(e as Error).message}`);
    }
  }
  if (composeHashes.size && g.composeHash) check(composeHashes.size === 1 && composeHashes.has(g.composeHash) ? "pass" : "FAIL", "compose hash agrees", "the verifier's (from the quote's MRCONFIGID) and the event log's are the same");
  if (presented) {
    const listed = g.tlsSpki.includes(presented.spkiSha256);
    check(listed ? "pass" : "FAIL", "TLS key is in the attested keyset", listed ? `${url.hostname} presented SPKI sha256 ${short(presented.spkiSha256)}, which the keyset lists for that host` : `${url.hostname} presented SPKI sha256 ${presented.spkiSha256}; the keyset lists ${g.tlsSpki.join(", ") || "none"} for that host`);
  } else check("note", "TLS key", "not https, nothing to pin");
  return { report, gateway: g, registers: f };
}

// ---- 2. The attestor job on a registered provider ------------------------------------------------------------------------------
async function registerGateway() {
  const values = {
    name: "Attested gateway",
    baseUrl: BASE_URL,
    // Encrypted with APP_SECRET like every provider credential (scripts/seed.ts); null when no key is set.
    ...(gatewayKey ? { apiKeyEnc: encrypt(ctx.cfg.appSecret, gatewayKey) } : {}),
    status: "live" as const,
    // The router asks the gateway for a zero-retention, TEE-verified upstream on every request (ACI_CONSTRAINTS).
    dataPolicy: { training: false, retains_prompts: false, zdr: true },
    teeKind: "tdx",
    attestationUrl: ATTESTATION_URL,
  };
  await ctx.db.insert(providers).values({ id: PROVIDER_ID, ...values }).onConflictDoUpdate({ target: providers.id, set: { ...values, updatedAt: new Date() } });
}

async function attest(): Promise<boolean> {
  console.log(`\n2. the attestor job (src/services/attestor.ts) on provider ${PROVIDER_ID}`);
  await registerGateway();
  const { results } = await runAttestor(ctx);
  const r = (results as { provider: string; ok: boolean; reason?: string; hash?: string }[]).find((x) => x.provider === PROVIDER_ID);
  if (!check(r?.ok ? "pass" : "FAIL", "runAttestor", r?.ok ? `attested, report hash ${r.hash}` : r?.reason ?? "the attestor did not reach the provider")) return false;
  const stored = await loadAciGateway(ctx.db, PROVIDER_ID);
  const pin = await loadTlsPin(ctx.db, PROVIDER_ID);
  check(stored ? "pass" : "FAIL", "keyset stored for receipt checks", stored ? `${stored.receiptKeys.length} receipt key(s): ${stored.receiptKeys.map((k) => k.key_id).join(", ")}` : "missing");
  check(pin?.spkiOnly ? "pass" : new URL(ATTESTATION_URL).protocol === "https:" ? "FAIL" : "note", "connections pinned to the attested TLS key", pin ? `SPKI sha256 ${short(pin.spkiSha256)}` : "no pin");
  return !!stored;
}

async function attestationStatus() {
  const r = await api(`/api/v1/attestation/${PROVIDER_ID}`);
  const d = (r.body.data ?? {}) as Json;
  check(d.status === "attested" ? "pass" : "FAIL", `GET /api/v1/attestation/${PROVIDER_ID}`, `status ${d.status ?? `HTTP ${r.status}`}${d.reason ? ` (${d.reason})` : ""}, tee ${d.tee}, verifiers ${(d.verifiers ?? []).join(", ") || "none"}, attested_at ${d.attested_at}`);
  return d;
}

// ---- 3. The catalogue -----------------------------------------------------------------------------------------------------------
type Listed = { id: string; name?: string; pricing: { prompt: string; completion: string }; output_modalities?: string[]; context_length: number };
async function catalogue(): Promise<{ models: Listed[]; chat: Listed[] }> {
  console.log("\n3. the gateway's public model catalogue (GET /models, no key)");
  const pin = await loadTlsPin(ctx.db, PROVIDER_ID);
  const res = await providerFetch(`${BASE_URL}/models`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) }, { ...networkPolicy, tlsPin: pin });
  if (!res.ok) { check("FAIL", "GET /models", `HTTP ${res.status}`); return { models: [], chat: [] }; }
  const raw = (await boundedJson(res, 8 * 1024 * 1024)) as { data?: unknown[] };
  const { models, skipped } = aciStaticModels(raw);
  const parsed = parseProviderModels({ data: models });
  const listed = Array.isArray(raw.data) ? raw.data.length : 0;
  check(listed > 0 ? "pass" : "FAIL", "models listed", `${listed}; ${models.length} offered inside a TEE with a price and a context length (what the router lists)${skipped.length ? `; ${skipped.length} left out (${[...new Set(skipped.map((s) => s.reason))].join(", ")})` : ""}`);
  if (parsed.errors.length) check("FAIL", "catalogue entries the router's model schema refuses", parsed.errors.slice(0, 3).join(" | "));
  const all = models as unknown as Listed[];
  const price = (m: Listed) => Number(m.pricing.completion) + Number(m.pricing.prompt);
  const chat = all.filter((m) => (m.output_modalities ?? ["text"]).includes("text")).sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id));
  for (const m of chat.slice(0, 5)) console.log(`      ${m.id.padEnd(44)} ${perMillion(m.pricing.prompt)} in / ${perMillion(m.pricing.completion)} out per 1M tokens, context ${m.context_length}`);
  if (chat.length > 5) console.log(`      … and ${chat.length - 5} more chat model(s)`);
  return { models: all, chat };
}

function summary(report: Json, g: AciGateway | null, f: TdxFields | null) {
  console.log("\nwhat the gateway attested");
  const att = (report.attestation ?? {}) as Json;
  row("TEE type", att.tee_type);
  row("keyset digest", report.workload_keyset_digest);
  if (g) {
    row("receipt keys", g.receiptKeys.map((k) => `${k.key_id} (ed25519 ${short(k.public_key, 8)})`).join(", "));
    row("keyset valid until", new Date(g.notAfter * 1000).toISOString());
    row("source repo", g.sourceProvenance?.repo_url);
    row("source commit", g.sourceProvenance?.repo_commit);
    row("image digest", g.sourceProvenance?.image_digest ?? "(the report names none)");
    row("compose hash", g.composeHash);
    row("OS image hash", g.osImageHash);
    row("app id", g.appId);
    row("serving", g.serving);
    row("keyset endorsement", g.keysetEndorsement);
  }
  if (f) { row("MRTD", short(f.mrtd, 24)); row("RTMR3", short(f.rtmr3, 24)); }
  row("E2EE versions", (report.service_capabilities?.supported_e2ee_versions ?? []).join(", ") || "(none)");
  row("E2EE keys", (att.workload_keyset?.e2ee_public_keys ?? []).map((k: Json) => k.algo).join(", ") || "(none)");
  console.log("\nnot checked");
  const tcb = verifiersRun.some((v) => v === "dcap" || v === "intel-ta");
  if (!tcb) console.log("  - TCB status (platform patch level): the TEE cloud's verifier checks the quote's signature and certificate chain and reports no TCB status.");
  for (const v of verifiersSkipped) if (VERIFIER_NEEDS[v]) console.log(`  - ${v}: not run, it needs ${VERIFIER_NEEDS[v].what} (${VERIFIER_NEEDS[v].env}).`);
  console.log("  - Which release is acceptable: no MRTD / RTMR3 allow-list is set for this provider, and the source repo and commit are recorded, not appraised.");
  console.log("  - The key-custody signature chain and any keyset endorsement in the report: aci/1 defines no signing input the router checks.");
  console.log("  - The model servers behind the gateway: each response's gateway receipt says whether its upstream was verified, and that needs a paid call (--call).");
}

// ---- The keyed part ---------------------------------------------------------------------------------------------------------------
type RunState = { generationId?: string; model?: string; at?: string };
async function routed(models: Listed[], chat: Listed[]) {
  console.log("\n4. catalogue sync, disclosure, routing");
  await ctx.db.update(providers).set({ staticModels: models, updatedAt: new Date() }).where(eq(providers.id, PROVIDER_ID));
  const [provider] = await ctx.db.select().from(providers).where(eq(providers.id, PROVIDER_ID));
  const synced = await syncProvider(ctx, { ...provider, tlsPin: await loadTlsPin(ctx.db, PROVIDER_ID) });
  check(synced.models > 0 && !synced.errors.length ? "pass" : "FAIL", "catalogue synced", `${synced.models} offer(s) at the gateway's own prices${synced.errors.length ? `; ${synced.errors.length} refused` : ""}`);
  // The attested lane serves only providers whose retention the operator declares as resting on attestation.
  const today = new Date().toISOString().slice(0, 10);
  const source = "Operator declaration for the devnet walkthrough: the gateway's aci/1 attestation report and the zero-retention claim in its per-response receipts.";
  const view = await writeDisclosure(ctx, PROVIDER_ID, { retention: { value: "attested", source, as_of: today }, legal_hold: { active: false, source, as_of: today } });
  check(view.current.class === "attested" ? "pass" : "FAIL", "disclosure class", `${view.current.class} (attestation fresh: ${view.current.attestation_fresh})`);

  const wanted = option("model")?.toLowerCase();
  const pick = wanted ? chat.find((m) => m.id.toLowerCase() === wanted) : chat[0];
  if (!pick) { check("FAIL", "model", wanted ? `${wanted} is not a chat model the gateway lists inside a TEE` : "the gateway lists no chat model"); return; }
  const resolved = ctx.catalog.resolve(pick.id.toLowerCase());
  if (!resolved) { check("FAIL", "model", `${pick.id} is not in the router's catalogue after the sync`); return; }
  const prefs = { lane: "attested" as const, only: [PROVIDER_ID], allow_fallbacks: false };
  const sel = selectProviders({ modelId: resolved.model.id, offers: ctx.catalog.offers(resolved.model.id), prefs, modifiers: resolved.modifiers, requestParams: ["max_tokens", "stream"], estimatedTokens: 32, health: ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3, disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)), modelLane: ctx.catalog.laneOf(resolved.model), attestedBonus: ctx.cfg.routing.attestedBonus });
  const routable = sel.ordered.some((c) => c.providerId === PROVIDER_ID);
  check(routable ? "pass" : "FAIL", "attested-lane selection", routable ? `${resolved.model.id} -> ${PROVIDER_ID} (${perMillion(pick.pricing.prompt)} in / ${perMillion(pick.pricing.completion)} out per 1M tokens)` : `no provider: ${sel.excluded.map((x) => `${x.provider}: ${x.reason}`).join("; ") || "no offer"}`);

  const saved = readJsonFile<{ key?: { secret: string; hash: string } }>(STATE_FILE, {});
  const credits = saved.key ? await api("/api/v1/credits", { auth: saved.key.secret }) : null;
  const balance = credits?.status === 200 ? String(credits.body.data?.balance ?? "0") : null;
  check(balance !== null && Number(balance) > 0 ? "pass" : CALL ? "FAIL" : "note", "prepaid credits", balance !== null ? `${balance} USDC on key ${saved.key!.hash.slice(0, 12)}… (${rel(STATE_FILE)})` : "this database has no funded walkthrough key: run scripts/demo/devnet-demo.ts first");
  const body = { model: resolved.model.id, messages: [{ role: "user", content: "Reply with the single word: sealed." }], max_tokens: MAX_TOKENS, provider: prefs, usage: { include: true }, stream: false };

  const run = DB_OVERRIDE ? {} : readJsonFile<RunState>(RUN_FILE, {});
  let generationId = AGAIN ? undefined : run.generationId;
  if (DRY_RUN || !CALL) {
    console.log("\n5. the call (dry run: not sent)");
    console.log(`  POST /api/v1/chat/completions ${JSON.stringify({ ...body, messages: "[1 short user message]" })}`);
    console.log(`  ${gatewayKey ? `Run with --call to send it once.` : `Put ${KEY_NAME}=<key> in ${rel(ENV_FILE)}, then run with --call to send it once.`}`);
    if (!generationId) return;
    console.log(`  An earlier --call is on record (${generationId}); showing its receipt.`);
  } else if (generationId) {
    console.log(`\n5. the call: already made (${generationId}, ${run.at}); showing its receipt. Pass --again for a new paid call.`);
  } else {
    if (failures || !routable || balance === null) { console.log("\n5. the call: not sent, because a step above failed."); return; }
    console.log("\n5. the call (one request, attested lane)");
    const r = await api("/api/v1/chat/completions", { method: "POST", auth: saved.key!.secret, json: body });
    generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    if (generationId && !DB_OVERRIDE) writePrivateFile(RUN_FILE, JSON.stringify({ generationId, model: resolved.model.id, at: new Date().toISOString() } satisfies RunState, null, 2) + "\n");
    const text = r.body.choices?.[0]?.message?.content;
    check(r.status === 200 ? "pass" : "FAIL", "POST /api/v1/chat/completions", r.status === 200 ? `HTTP 200, lane header ${r.headers.get("x-trellis-lane")}, answer ${JSON.stringify(String(text ?? "").slice(0, 80))}, usage ${JSON.stringify(r.body.usage ?? null)}` : `HTTP ${r.status} ${JSON.stringify(r.body.error ?? r.body).slice(0, 400)}`);
    if (!generationId) return;
  }

  // The generation row is visible to the key that made the call. When the walkthrough's key has been replaced since
  // (devnet-demo.ts --reset), the earlier call is not this key's: its receipt is public and is still checked below, and
  // the token counts are read from the receipt instead.
  const own = await api(`/api/v1/generation?id=${encodeURIComponent(generationId!)}`, { auth: saved.key?.secret });
  if (own.status !== 200 && own.status !== 404) must(own, "GET /api/v1/generation");
  const g = (own.status === 200 ? own.body.data : null) as Json | null;
  if (!g) console.log(`  (the earlier call was made with a key this walkthrough no longer holds; showing its public receipt only)`);
  const receipt = must(await api(`/api/v1/receipts/${encodeURIComponent(generationId!)}`), "GET /api/v1/receipts/:id").data as Json;
  const keys = must(await api("/api/v1/receipts/keys"), "GET /api/v1/receipts/keys");
  const v = await verifyReceipt({ id: receipt.id, payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id }, { keys: keys as { keys: import("../../packages/client/src/index.ts").JwkKey[] } });
  const p = receipt.payload as Json;
  const ua = p.upstream_attestation as Json | undefined;
  console.log("\nreceipt");
  row("id", generationId);
  row("model", `${p.model} via ${p.provider}`);
  row("tokens", g ? `${g.tokens_prompt} prompt, ${g.tokens_completion} completion${g.native_tokens_reasoning ? ` (${g.native_tokens_reasoning} reasoning)` : ""}` : `${p.tokens?.prompt} prompt, ${p.tokens?.completion} completion (from the receipt)`);
  row("cost", `${p.cost} USD (upstream ${p.cost_details?.upstream}, margin ${p.cost_details?.margin})`);
  row("lane", `${p.lane}, disclosure class ${p.disclosure}`);
  row("attestation hash", p.attestation);
  check(v.valid ? "pass" : "FAIL", "receipt signature (packages/client verifyReceipt)", v.valid ? `verifies under key ${receipt.key_id}` : JSON.stringify(v.checks.filter((c) => c.status === "fail")));
  check(p.lane === "attested" ? "pass" : "FAIL", "receipt lane", String(p.lane));
  const status = await attestationStatus();
  check(p.attestation && p.attestation === status.attestation_hash ? "pass" : "note", "receipt names the provider's current attestation", p.attestation === status.attestation_hash ? String(p.attestation) : `receipt ${p.attestation}, provider now ${status.attestation_hash} (the attestor has run again since the call)`);
  if (ua) {
    check(ua.receipt_verified ? "pass" : "FAIL", "gateway receipt (signature, keyset, request and response hashes)", ua.receipt_verified ? `${ua.receipt_id} under keyset ${ua.keyset_digest}` : ua.reason ?? "not verified");
    check(ua.attested ? "pass" : "FAIL", "upstream verified inside a TEE", `result ${ua.upstream?.result}, required ${ua.upstream?.required}, claims ${Object.entries(ua.claims ?? {}).map(([k, c]) => `${k}=${(c as Json | null)?.status ?? "absent"}`).join(" ")}`);
  } else check("FAIL", "gateway receipt", "the router's receipt carries no upstream_attestation");
  const after = saved.key ? await api("/api/v1/credits", { auth: saved.key.secret }) : null;
  if (after?.status === 200) row("credits left", `${after.body.data?.balance} USDC`);
}

// ---- Run ------------------------------------------------------------------------------------------------------------------------
let exitCode = 0;
try {
  const { report, gateway, registers } = await inspect();
  const attested = gateway ? await attest() : false;
  if (attested) await attestationStatus();
  const { models, chat } = await catalogue();
  summary(report, gateway, registers);
  if (ROUTED && attested && !failures) await routed(models, chat);
  const next = CALL ? "" : DRY_RUN ? `. Next: --call${gatewayKey ? "" : `, with ${KEY_NAME} in ${rel(ENV_FILE)}`}` : `. Next: --dry-run, then --call with ${KEY_NAME} in ${rel(ENV_FILE)}`;
  console.log(failures ? `\nFAILED: ${failures} check(s) did not pass.` : `\nOK: the router's attestor accepts the gateway${next}.`);
  if (failures) exitCode = 1;
} catch (e) {
  exitCode = 1;
  console.error(`\nfailed: ${(e as Error).message}`);
} finally {
  await close().catch(() => undefined);
  process.exit(exitCode);
}
