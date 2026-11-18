// Rehearsal only: proves that the manifest and report written by `verify.ts --write-report` are what the router's
// production guard (src/config.ts contractPathGuards) accepts, and that a tampered pair is refused. It builds a
// production-shaped configuration in memory with throwaway secrets generated here, loads it through loadConfig and reads
// the deployment status. Nothing is started, contacted or written.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../../src/config.ts";
import { base58Encode } from "../../src/solana/constants.ts";
import { deploymentsFile, fail } from "./lib.ts";

const base = deploymentsFile("rehearsal").replace(/\.json$/, "");
const manifestFile = `${base}.manifest.json`, reportFile = `${base}.verification.json`;
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const secret = (bytes: number) => randomBytes(bytes).toString("hex");
// Only what the tier deployed is configured: the guard is loaded with the tier the manifest names.
const set = (name: string, value: string | undefined) => (value ? { [name]: value } : {});
const tier = String(manifest.launchTier ?? "full");
// The router's launch surface (src/surface, added beside the fourth review): on the default surface, `core`, a
// production router starts with tier `credits` or `minimal` only, and refuses every setting that switches another
// program on. A deployment of a larger tier is therefore loaded here as its operator would have to run it: with
// LAUNCH_SURFACE=all and the acknowledgement that surface asks for. A router build without the surface fence ignores
// both settings. (Read at run time, so that this script follows that module instead of repeating its constant.)
const surface = await import("../../src/surface/surface.ts").then((m) => ({ ack: String((m as { SURFACE_ACK?: unknown }).SURFACE_ACK ?? "") }), () => null);
const beyondCore = tier !== "credits" && tier !== "minimal";
const surfaceSettings: Record<string, string> = surface?.ack && beyondCore ? { LAUNCH_SURFACE: "all", LAUNCH_SURFACE_ACK: surface.ack } : {};
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  TRELLIS_ENV: "production",
  RUNTIME_ROLE: "api",
  AUTO_MIGRATE: "false",
  HOST: "0.0.0.0",
  // Not a reserved TLD on purpose: on .example / .test / .invalid the guard would accept a fixture without any manifest.
  PUBLIC_BASE_URL: "https://router.rehearsal-not-a-real-host.net",
  DATABASE_URL: `postgres://trellis_runtime:${secret(16)}@postgres:5432/trellis`,
  REDIS_URL: `redis://:${secret(16)}@redis:6379`,
  APP_SECRET: secret(32),
  ADMIN_TOKEN: secret(24),
  ROUTER_PRIVATE_KEY: base58Encode(Keypair.generate().secretKey),
  SOLANA_NETWORK: manifest.network,
  X402_NETWORK: manifest.network,
  USDC_ADDRESS: manifest.contracts.usdc,
  LAUNCH_TIER: tier,
  // Memo mode (no anchor program in the tier): the API names the anchorer key it publishes.
  ...(manifest.anchorMode === "memo" ? set("ANCHORER_ADDRESS", manifest.roles?.anchorAuthority ?? process.env.MAINNET_ANCHORER) : {}),
  ...set("CREDITS_ADDRESS", manifest.contracts.credits),
  ...set("CALLPAY_ADDRESS", manifest.contracts.callPay),
  ...set("PROVIDER_BOND_ADDRESS", manifest.contracts.providerBond),
  ...set("RECEIPT_ANCHOR_ADDRESS", manifest.contracts.receiptAnchor),
  ...set("TRELLIS_CREDITS_PROGRAM_ID", manifest.programs.trellis_credits),
  ...set("TRELLIS_TAB_PROGRAM_ID", manifest.programs.trellis_tab),
  ...set("TRELLIS_BOND_PROGRAM_ID", manifest.programs.trellis_bond),
  ...set("TRELLIS_ANCHOR_PROGRAM_ID", manifest.programs.trellis_anchor),
  ...set("TRELLIS_RULES_PROGRAM_ID", manifest.programs.trellis_rules),
  ...set("TRELLIS_FEE_ROUTER_PROGRAM_ID", manifest.programs.trellis_fee_router),
  ...set("TRELLIS_CAPACITY_PROGRAM_ID", manifest.programs.trellis_capacity),
  RELEASE_COMMIT: report.verifierRevision,
  DEPLOYMENT_MANIFEST: manifestFile,
  DEPLOYMENT_VERIFICATION: reportFile,
  ...surfaceSettings,
  ...over,
});

const cfg = loadConfig(env());
const status = cfg.release.deployment.status;
if (status !== "verified") fail(`the production configuration loaded, but the deployment status is ${status}, not "verified"`);
if (cfg.launch.tier !== tier) fail(`the router loaded tier ${cfg.launch.tier}, the manifest names ${tier}`);
if (cfg.launch.anchor.mode !== manifest.anchorMode) fail(`the router would anchor in ${cfg.launch.anchor.mode} mode, the deployment is ${manifest.anchorMode}`);
const on = Object.entries(cfg.launch.features).filter(([, v]) => v).map(([k]) => k);
console.log(`production configuration accepted for LAUNCH_TIER=${tier}${surfaceSettings.LAUNCH_SURFACE ? " on LAUNCH_SURFACE=all (acknowledged)" : ""}; deployment status: ${status}; anchor mode ${cfg.launch.anchor.mode}; features on: ${on.join(", ")}`);
// The router's guard reads `ok` and the checks' statuses. A recorded exception (a bypass that was accepted, something
// verify.ts could not establish) does not stop the router; it is said here so that nobody takes the report for a plain pass.
const exceptions: { id: string }[] = Array.isArray(report.exceptions) ? report.exceptions : [];
if (exceptions.length) console.log(`note: the report carries ${exceptions.length} recorded exception(s): ${exceptions.map((x) => x.id).join(", ")}. It is not a plain pass.`);

const refused = (what: string, over: Record<string, string>) => {
  try { loadConfig(env(over)); } catch (e) { console.log(`refused as required: ${what}\n    ${(e as Error).message.split("\n")[0]}`); return; }
  fail(`NOT refused: ${what}`);
};
// A tier above `credits` on the default launch surface is refused by the router itself, whatever the report says.
if (surfaceSettings.LAUNCH_SURFACE) refused(`tier ${tier} on the default (core) launch surface`, { LAUNCH_SURFACE: "", LAUNCH_SURFACE_ACK: "" });
refused("no manifest at all on a real host name", { DEPLOYMENT_MANIFEST: "", DEPLOYMENT_VERIFICATION: "" });
refused("a manifest that names another credits program", { DEPLOYMENT_MANIFEST: JSON.stringify({ ...manifest, contracts: { ...manifest.contracts, credits: manifest.contracts.usdc } }) });
// A larger tier than what is deployed is refused: the router does not pretend to have programs it lacks.
if (tier !== "full") refused(`LAUNCH_TIER=full on a ${tier} deployment`, { LAUNCH_TIER: "full" });
if (manifest.anchorMode === "memo") refused("memo mode with no anchorer key named", { ANCHORER_ADDRESS: "" });
refused("a report that failed a check", { DEPLOYMENT_VERIFICATION: JSON.stringify({ ...report, checks: [...report.checks, { id: "x", status: "fail" }] }) });
refused("a report for another network", { DEPLOYMENT_VERIFICATION: JSON.stringify({ ...report, observed: { ...report.observed, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } }) });
refused("a report with a bytecode mismatch listed", { DEPLOYMENT_VERIFICATION: JSON.stringify({ ...report, checks: report.checks.map((c: { id: string; evidence: object }) => (c.id === "contracts.source_equivalence" ? { ...c, evidence: { ...c.evidence, mismatches: ["trellis_credits"] } } : c)) }) });
