// Check the settings of every service of deploy/production/docker-compose.yml before anything starts: each service's
// environment is loaded through the router's own validator (src/config.ts loadConfig, which enforces the production
// guards), and the things that validator cannot see across services are checked here: which service holds which signing
// key, that no key is used for two roles, that every critical job runs in exactly one worker, and that pricing is zero
// markup with the pre-audit caps.
//
//   docker compose --env-file stack.env --profile '*' config --format json | bun deploy/production/check-env.ts
//   ./bootstrap.sh --check          the same, through the application image (no bun needed on the host)
//
// Input is the resolved compose configuration on standard input, so this script reads no file of secrets itself. It
// prints setting names and verdicts only: never a value.
import { createHash } from "node:crypto";

type Service = { image?: string; command?: string[] | string | null; environment?: Record<string, string | null>; profiles?: string[] };
const input = await new Response(Bun.stdin.stream()).text();
let services: Record<string, Service>;
try { services = (JSON.parse(input) as { services: Record<string, Service> }).services; } catch { console.error("Standard input is not the JSON of `docker compose config --format json`."); process.exit(2); }

const SIGNING = ["ROUTER_PRIVATE_KEY", "FACILITATOR_RELAY_PRIVATE_KEY", "SETTLEMENT_PRIVATE_KEY", "ANCHORER_PRIVATE_KEY", "SLASHER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "MAKEGOOD_REFUND_PRIVATE_KEY", "IPX_KEEPER_PRIVATE_KEY", "IPX_ORACLE_PRIVATE_KEY"] as const;
/** Which services may hold which key (the compose file's layout). */
const ALLOWED: Record<string, string[]> = {
  ROUTER_PRIVATE_KEY: ["api", "worker-tabs"],
  FACILITATOR_RELAY_PRIVATE_KEY: ["api"],
  SETTLEMENT_PRIVATE_KEY: ["worker-settlement"],
  ANCHORER_PRIVATE_KEY: ["worker-anchor"],
  SLASHER_PRIVATE_KEY: ["worker-slasher"],
  MAKEGOOD_REFUND_PRIVATE_KEY: ["worker-makegood"],
  KEEPER_PRIVATE_KEY: [], IPX_KEEPER_PRIVATE_KEY: [], IPX_ORACLE_PRIVATE_KEY: [],
};
const CRITICAL = ["chain-indexer", "catalog-refresh", "provider-registry", "receipts-anchor", "settlement", "attestor"];
const ZERO_FEES = ["PER_CALL_MARGIN_BPS", "PROVIDER_FEE_BPS", "BYOK_FEE_BPS", "FACILITATOR_FEE_BPS", "SKILLS_FEE_BPS", "BATCH_DISCOUNT_BPS" /* R4-03: a discount is a negative fee the operator pays */];

const router = Object.entries(services).filter(([name]) => name === "api" || name.startsWith("worker-"));
if (!router.some(([n]) => n === "api")) { console.error("The configuration has no api service: pass --profile '*' to docker compose config."); process.exit(2); }
const envOf = (s: Service): Record<string, string> => Object.fromEntries(Object.entries(s.environment ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
const digest = (v: string) => createHash("sha256").update(v).digest("hex");

let failures = 0;
const rows: string[][] = [];
const result = (ok: boolean | null, what: string, detail = "") => { if (ok === false) failures++; rows.push([ok === null ? "note" : ok ? "ok" : "FAIL", what, detail]); };

// ---- 1. Each service through the router's validator, in a child process that sees only that service's environment ----------
const child = `
import { loadConfig } from "${new URL("../../src/config.ts", import.meta.url).pathname}";
try {
  const c = loadConfig();
  console.log(JSON.stringify({ ok: true, role: c.runtimeRole, jobs: c.workerJobs, production: c.production, deployment: c.release.deployment.status, network: c.chain.network, sanctions: c.sanctions.enabled, verifiers: c.attestation.verifiers }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e).split("\\n")[0].slice(0, 300) })); }
`;
type Loaded = { ok: true; role: string; jobs: string[]; production: boolean; deployment: string; network: string; sanctions: boolean; verifiers: string[] } | { ok: false; error: string };
const loaded = new Map<string, Loaded>();
// The launch surface (src/surface/): on `core`, the default, the services behind a compose profile (slasher, make-good
// payouts) run jobs that are not on the allow-list. They are not validated as part of this stack and must not
// be started; the router itself refuses their job lists in production.
const surface = envOf(services.api!).LAUNCH_SURFACE || "core";
for (const [name, svc] of router) {
  if (surface === "core" && svc.profiles?.length) {
    loaded.set(name, { ok: false, error: "not on the core launch surface" });
    result(null, `${name} (profile ${svc.profiles.join(",")})`, "not on the core launch surface: do not start this profile");
    continue;
  }
  const proc = Bun.spawnSync(["bun", "--no-env-file", "-e", child], { env: { ...envOf(svc), PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  let out: Loaded;
  try { out = JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "") as Loaded; } catch { out = { ok: false, error: "the validator did not run" }; }
  loaded.set(name, out);
  const optional = svc.profiles?.length ? ` (profile ${svc.profiles.join(",")})` : "";
  // The router's messages name settings and rules, never values.
  result(out.ok, `${name}${optional}: settings load in production mode`, out.ok ? `role ${out.role}${out.jobs.length ? `, jobs ${out.jobs.join(",")}` : ""}` : out.error);
}

// ---- 2. Keys: who holds what ------------------------------------------------------------------------------------------------
const holders = new Map<string, string[]>();
const keyDigests = new Map<string, Set<string>>();
for (const [name, svc] of router) for (const key of SIGNING) {
  const v = envOf(svc)[key];
  if (!v) continue;
  holders.set(key, [...(holders.get(key) ?? []), name]);
  keyDigests.set(key, (keyDigests.get(key) ?? new Set()).add(digest(v)));
}
for (const key of SIGNING) {
  const has = holders.get(key) ?? [];
  const stray = has.filter((s) => !ALLOWED[key]!.includes(s));
  if (has.length) result(stray.length === 0, `${key} only where it belongs`, stray.length ? `also given to ${stray.join(", ")}` : `held by ${has.join(", ")}`);
  if ((keyDigests.get(key)?.size ?? 0) > 1) result(false, `${key} is the same key wherever it appears`, "two services hold different values under this name");
}
const byDigest = new Map<string, string[]>();
for (const [key, set] of keyDigests) for (const d of set) byDigest.set(d, [...(byDigest.get(d) ?? []), key]);
const reused = [...byDigest.values()].filter((names) => names.length > 1);
result(reused.length === 0, "every signing role has its own key", reused.length ? reused.map((n) => n.join(" = ")).join("; ") : `${keyDigests.size} distinct keys`);
const always = router.filter(([, s]) => !s.profiles?.length);
result(surface === "core" ? true : null, "launch surface", surface === "core" ? "core: only the allow-listed routes and jobs exist" : "all: every feature is registered (LAUNCH_SURFACE_ACK); see security/DEFERRED.md");
// The launch tier (LAUNCH_TIER; src/solana/launch-config.ts) decides which programs exist. Without trellis_credits
// (tier minimal) the settlement worker has nothing on chain to sign for, and runs without a key.
const apiEnv = envOf(services.api!);
const tier = apiEnv.LAUNCH_TIER || "full";
const hasCredits = !!(apiEnv.TRELLIS_CREDITS_PROGRAM_ID || apiEnv.CREDITS_ADDRESS);
const memoMode = (apiEnv.ANCHOR_MODE || (apiEnv.TRELLIS_ANCHOR_PROGRAM_ID || apiEnv.RECEIPT_ANCHOR_ADDRESS ? "program" : "memo")) === "memo";
result(null, "launch tier", `${tier}; receipt roots in ${memoMode ? "memo" : "program"} mode`);
for (const [name] of always) {
  const need = name === "api" || name === "worker-tabs" ? "ROUTER_PRIVATE_KEY" : name === "worker-settlement" ? (hasCredits ? "SETTLEMENT_PRIVATE_KEY" : null) : name === "worker-anchor" ? "ANCHORER_PRIVATE_KEY" : null;
  if (need) result(!!holders.get(need)?.includes(name), `${name} has ${need}`);
}
if (!hasCredits) result(!holders.get("SETTLEMENT_PRIVATE_KEY")?.length, "no settlement key without a credits program", holders.get("SETTLEMENT_PRIVATE_KEY")?.length ? "tier minimal has no trellis_credits: leave secrets/settlement.env empty" : "tier minimal: the settlement worker runs keyless");
// Memo mode: the key that signs the roots is the anchor. The API publishes its public half (ANCHORER_ADDRESS); the
// router's validator has already refused a worker whose ANCHORER_PRIVATE_KEY is another key.
if (memoMode) result(!!apiEnv.ANCHORER_ADDRESS, "memo mode: the API names the anchorer key it publishes (ANCHORER_ADDRESS)", apiEnv.ANCHORER_ADDRESS ? "set" : "not set: proofs would name no key to check");

// ---- 3. Jobs: every critical job in exactly one always-on worker; no job twice --------------------------------------------------
const jobOwners = new Map<string, string[]>();
for (const [name, svc] of router) for (const job of (envOf(svc).WORKER_JOBS ?? "").split(",").map((j) => j.trim()).filter(Boolean)) jobOwners.set(job, [...(jobOwners.get(job) ?? []), name]);
for (const job of CRITICAL) {
  const owners = (jobOwners.get(job) ?? []).filter((o) => always.some(([n]) => n === o));
  result(owners.length === 1, `critical job ${job} runs in exactly one worker`, owners.length ? owners.join(", ") : "no always-on worker runs it");
}
const doubled = [...jobOwners.entries()].filter(([job, o]) => o.length > 1 && job !== "job-watchdog"); // every worker watches its own jobs
result(doubled.length === 0, "no job is assigned to two workers", doubled.map(([j, o]) => `${j}: ${o.join(", ")}`).join("; "));

// ---- 4. Shared settings: the same everywhere, zero markup, caps, sanctions, the domain ---------------------------------------------
const api = envOf(services.api!);
const differing = ["APP_SECRET", "PUBLIC_BASE_URL", "SOLANA_NETWORK", "DATABASE_URL", "REDIS_URL", "TRELLIS_CREDITS_PROGRAM_ID", "TRELLIS_ANCHOR_PROGRAM_ID", "SOL_RPC_URL", "LAUNCH_TIER", "ANCHOR_MODE", "ANCHORER_ADDRESS", "ANCHORER_KEYS", "ANCHOR_MEMO_V2_FROM_HOUR", "ANCHOR_MAX_LATE_SECONDS"].filter((k) => always.some(([, s]) => (envOf(s)[k] ?? "") !== (api[k] ?? "")));
result(differing.length === 0, "shared settings are identical in every service", differing.join(", "));
const fees = ZERO_FEES.filter((k) => router.some(([, s]) => Number(envOf(s)[k] ?? 0) !== 0));
result(fees.length === 0, "zero markup: every fee setting is 0", fees.length ? `not zero: ${fees.join(", ")}` : ZERO_FEES.join(", "));
const num = (k: string, d: number) => Number(api[k] ?? d);
result(num("TAB_CAP_USDC", 500) <= 500 && num("CREDITS_CAP_USDC", 5000) <= 5000 && num("BUSHEL_ISSUANCE_CAP_USD", 250_000) <= 250_000, "pre-audit caps: tab <= 500, credits <= 5,000 per key, prepaid capacity <= 250,000 USDC");
result(num("CREDITS_REFUND_DELAY_H", 72) >= 72, "closure refund delay is at least 72 h");
const apiLoaded = loaded.get("api");
if (apiLoaded?.ok) {
  result(apiLoaded.sanctions, "sanctions screening is enabled");
  result(apiLoaded.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ? true : null, "network", apiLoaded.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ? "mainnet-beta" : `${apiLoaded.network} (not mainnet-beta)`);
  result(apiLoaded.deployment === "verified" ? true : null, "deployment guard", apiLoaded.deployment === "verified" ? "verified manifest and report" : apiLoaded.deployment === "fixture" ? "fixture: PUBLIC_BASE_URL is on a reserved top-level domain, so no deployment manifest is required. Not a real launch." : apiLoaded.deployment);
  result(apiLoaded.verifiers.some((v) => v === "dcap" || v === "intel-ta") ? true : null, "quote verifiers", apiLoaded.verifiers.some((v) => v === "dcap" || v === "intel-ta") ? apiLoaded.verifiers.join(", ") : `${apiLoaded.verifiers.join(", ")}: no DCAP or Intel Trust Authority verifier, so the platform patch level (TCB status) is not checked`);
}
let host = "";
try { host = new URL(api.PUBLIC_BASE_URL ?? "").host; } catch { /* reported by the validator */ }
const domain = process.env.TRELLIS_DOMAIN ?? envOf(services.caddy ?? {}).TRELLIS_DOMAIN;
if (domain) result(host === domain || domain === "localhost", "PUBLIC_BASE_URL is the host name Caddy serves", host === domain ? host : domain === "localhost" ? "TRELLIS_DOMAIN=localhost (workstation trial)" : `PUBLIC_BASE_URL host ${host || "(none)"}, TRELLIS_DOMAIN ${domain}`);

const widths = [4, Math.max(...rows.map((r) => r[1]!.length))];
for (const r of rows) console.log(`  ${r[0]!.padEnd(widths[0]!)}  ${r[1]!.padEnd(widths[1]!)}  ${r[2]}`.trimEnd());
console.log(failures ? `\n${failures} problem(s). Nothing was started.` : "\nsettings are consistent.");
process.exit(failures ? 1 : 0);
