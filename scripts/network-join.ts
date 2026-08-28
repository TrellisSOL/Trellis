#!/usr/bin/env node
// Source for the single-file host registration command served at /network/join.mjs.
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { base58Decode, base58Encode } from "../src/solana/constants.ts";
import { canonicalJson, credentialBody, hasCredentialSource, JoinError, providerId, readApiKey, redactCredentials, reject } from "./network-join-credential.ts";

const WARNING = "Use a dedicated operator wallet, not a wallet holding funds. This command signs authentication messages; it sends no transactions.";
const HELP = `node join.mjs --name NAME --endpoint https://SIDECAR --payout-address ADDRESS --models MODEL[,MODEL] [--contact CONTACT]
  --router URL          Router origin (default https://trellis.example)
  --key-file PATH       Read the operator secret key from a UTF-8 file: the base58 64-byte ed25519 key (seed || public
                        key, as wallets export it) or the solana-keygen JSON byte array
  --key-env NAME        Read it from an environment variable (default TRELLIS_OPERATOR_PRIVATE_KEY)
  --api-key-file PATH   Read the sidecar API key from a UTF-8 file (16–500 chars; chmod 600)
  --api-key-env NAME    Read the sidecar API key from an environment variable
  --credential-only ID Configure an existing host credential without signup
  --dry-run             Print canonical bodies without reading keys or sending requests; API key redacted
                        Signup credential body uses <provider_id> until the router assigns it
  --status PROVIDER_ID  Poll host status without reading a key or signing up
  --poll-count N        Status requests (default 5, maximum 100)
  --poll-interval MS    Time between status requests (default 5000, minimum 100)
Never put a secret key in command-line arguments. Requires Node 22 or later.`;
// Anything shaped like a secret key: 64+ hex digits, a base58 run of exactly 64 bytes (86 to 88 characters), or a JSON
// byte array. A 32-byte seed in base58 has the shape of an address and cannot be told apart by shape.
const KEY_SHAPES = [/(?:0x)?[a-f0-9]{64,}/gi, /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/g, /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g];
const looksLikeKey = (text: string) => KEY_SHAPES.some((shape) => new RegExp(shape.source, shape.flags.replace("g", "")).test(text));
// Also protects output from a response that reflects sensitive input. No raw exceptions are printed.
export const safeOutput = (text: string) => KEY_SHAPES.reduce((out, shape) => out.replace(shape, "[redacted]"), text).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, "");
type Options = Record<string, string | boolean>;
export type HostPayload = { name: string; endpoint: string; payout_address: string; models: string[]; contact?: string };

function options(args: string[]): Options {
  if (args.some(looksLikeKey)) reject("Secret keys must come from a file or environment variable, never arguments.");
  const flags = new Set(["--help", "--dry-run"]);
  const values = new Set(["--name", "--endpoint", "--payout-address", "--models", "--contact", "--router", "--key-file", "--key-env", "--status", "--poll-count", "--poll-interval", "--api-key-file", "--api-key-env", "--credential-only"]);
  const out: Options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key in out) reject("Duplicate command option.");
    if (flags.has(key)) out[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
    else reject("Unknown option or missing value. Run with --help.");
  }
  if (out["--key-file"] && out["--key-env"]) reject("Choose one key source: --key-file or --key-env.");
  if (out["--api-key-file"] && out["--api-key-env"]) reject("Choose one sidecar API key source: --api-key-file or --api-key-env.");
  if (out["--credential-only"] && !hasCredentialSource(out)) reject("--credential-only requires --api-key-file or --api-key-env.");
  if (out["--credential-only"] && ["--name", "--endpoint", "--payout-address", "--models", "--contact"].some((key) => out[key] !== undefined)) reject("--credential-only cannot be combined with signup options.");
  if (out["--status"] && (out["--dry-run"] || ["--name", "--endpoint", "--payout-address", "--models", "--contact", "--key-file", "--key-env", "--api-key-file", "--api-key-env", "--credential-only"].some((key) => out[key] !== undefined))) reject("--status cannot be combined with signup or key options.");
  if (!out["--status"] && (out["--poll-count"] || out["--poll-interval"])) reject("Polling options require --status.");
  return out;
}
function url(value: string, loopback = false): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return reject("Provide a valid HTTPS URL."); }
  if (parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) reject("URLs must use HTTPS and contain no credentials, query or fragment.");
  return parsed;
}
export function hostPayload(o: Options): HostPayload {
  const name = String(o["--name"] || "");
  if (!name.trim() || name.length > 60) reject("Provide --name with 1 to 60 characters.");
  const endpoint = String(o["--endpoint"] || ""); url(endpoint);
  const payout_address = String(o["--payout-address"] || "");
  if (!isAddress(payout_address)) reject("Provide --payout-address as a base58 Solana wallet address.");
  const models = String(o["--models"] || "").split(",").map((id) => id.trim());
  if (models.length < 1 || models.length > 8 || models.some((id) => !id) || new Set(models).size !== models.length) reject("Provide 1 to 8 distinct model ids with --models.");
  const contact = o["--contact"] as string | undefined;
  if (contact !== undefined && contact.length > 120) reject("Contact must be at most 120 characters.");
  return { name, endpoint, payout_address, models, ...(contact === undefined ? {} : { contact }) };
}

const isAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && decode(value)?.length === 32;
function decode(text: string): Uint8Array | null { try { return base58Decode(text); } catch { return null; } }

/** The operator wallet: its ed25519 private key (never exported again) and its base58 address. */
export type OperatorKey = { privateKey: KeyObject; address: string };
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/**
 * Decode a secret key as wallets and solana-keygen write it: base58 of the 64-byte seed || public key (or of the 32-byte
 * seed alone), or a JSON array of those bytes. A public half that does not belong to the seed is refused.
 */
export function operatorKey(raw: string): OperatorKey {
  let bytes: Uint8Array | null = null;
  const text = raw.trim();
  if (text.startsWith("[")) {
    try { const parsed: unknown = JSON.parse(text); if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Uint8Array.from(parsed as number[]); } catch { bytes = null; }
  } else if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) bytes = decode(text);
  if (!bytes || (bytes.length !== 64 && bytes.length !== 32)) return reject("The operator secret key is invalid.");
  try {
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(bytes.subarray(0, 32))]), format: "der", type: "pkcs8" });
    const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));
    if (bytes.length === 64 && Buffer.compare(Buffer.from(publicKey), Buffer.from(bytes.subarray(32))) !== 0) return reject("The operator secret key is invalid.");
    return { privateKey, address: base58Encode(publicKey) };
  } catch { return reject("The operator secret key is invalid."); } finally { bytes.fill(0); }
}

/** What an X-Wallet-Auth signature is for: the method, the router's host and the path of the one request it authorizes. */
export type WalletRequest = { method: string; host: string; path: string };
/**
 * Exactly the message verified by src/api/auth.ts walletAuth (src/lib/wallet-sig.ts walletAuthMessage): ed25519, base58, over
 * "trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unixSeconds>\n<sha256 hex of body>".
 */
export async function walletHeader(key: OperatorKey, request: WalletRequest, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  try {
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    const message = ["trellis:wallet-auth:v2", request.method.toUpperCase(), request.host.toLowerCase(), request.path, String(timestamp), hash].join("\n");
    const signature = base58Encode(new Uint8Array(sign(null, Buffer.from(message, "utf8"), key.privateKey)));
    return `${key.address}:${timestamp}:${signature}`;
  } catch { return reject("The operator secret key is invalid."); }
}
async function readKey(o: Options, env: NodeJS.ProcessEnv, remember: (secret: string) => void): Promise<OperatorKey> {
  let raw: string;
  if (o["--key-file"]) {
    let bytes: Buffer;
    try { bytes = await readFile(String(o["--key-file"])); } catch { return reject("Could not read the operator key file."); }
    try { raw = bytes.toString("utf8").trim(); } finally { bytes.fill(0); }
  } else raw = (env[String(o["--key-env"] || "TRELLIS_OPERATOR_PRIVATE_KEY")] || "").trim();
  if (!raw) reject("Provide the operator secret key through --key-file or --key-env.");
  remember(raw);
  return operatorKey(raw);
}
type Dependencies = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; out?: (line: string) => void; err?: (line: string) => void; sleep?: (ms: number) => Promise<void> };
function integer(value: string | boolean | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) reject("Polling count or interval is outside its allowed range.");
  return Number(value);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export async function runJoin(args: string[], deps: Dependencies = {}): Promise<number> {
  const secrets: string[] = [];
  const out = (line: string) => (deps.out || console.log)(safeOutput(redactCredentials(line, secrets)));
  const err = (line: string) => (deps.err || console.error)(safeOutput(redactCredentials(line, secrets)));
  err(WARNING);
  try {
    const o = options(args);
    if (o["--help"]) { out(HELP); return 0; }
    const router = url(String(o["--router"] || "https://trellis.example"), true);
    if (router.pathname !== "/") reject("--router must be an origin without a path.");
    const fetcher = deps.fetcher || fetch;
    async function request(route: string, init: RequestInit): Promise<Record<string, unknown>> {
      let response: Response;
      try { response = await fetcher(new URL(route, router), { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { return reject("Could not reach the router; no automatic signup retry was made."); }
      let doc: unknown;
      try { doc = await response.json(); } catch { return reject(`Router returned HTTP ${response.status} without valid JSON.`); }
      if (!response.ok) {
        const message = record(doc) && record(doc.error) && typeof doc.error.message === "string" ? doc.error.message : "Request refused.";
        reject(`HTTP ${response.status}: ${message}`);
      }
      if (init.method === "POST" && ![200, 201].includes(response.status)) reject(`Router returned unexpected signup HTTP ${response.status}.`);
      if (!record(doc)) return reject("Router returned an invalid host response.");
      return doc;
    }
    function report(doc: Record<string, unknown>, id?: string) {
      if (typeof doc.provider_id !== "string" || !doc.provider_id || typeof doc.status !== "string" || !Array.isArray(doc.reasons) || doc.reasons.some((reason) => typeof reason !== "string") || (id !== undefined && doc.provider_id !== id)) return reject("Router returned an invalid host response.");
      out(`Provider: ${doc.provider_id}\nStatus: ${doc.status}`);
      out(doc.reasons.length ? `Reasons:\n${doc.reasons.map((reason) => `- ${reason}`).join("\n")}` : "Reasons: none");
      if (id !== undefined) out(`Attested: ${doc.attested === true}\nProbation until: ${doc.probation_until ?? "none"}\nWeight: ${doc.weight ?? "unknown"}`);
      // Never accept a server-supplied external URL in a wallet workflow.
      const dashboard = `/hosts/?id=${encodeURIComponent(String(doc.provider_id))}`;
      if (id === undefined && doc.dashboard !== dashboard) reject("Router returned an invalid dashboard URL.");
      out(`Dashboard: ${new URL(dashboard, router).href}`);
    }
    if (o["--status"]) {
      const id = String(o["--status"]);
      const count = integer(o["--poll-count"], 5, 1, 100);
      const interval = integer(o["--poll-interval"], 5000, 100, 60_000);
      for (let i = 0; i < count; i++) {
        if (i) await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(interval);
        report(await request(`/api/v1/network/hosts/${encodeURIComponent(id)}/status`, { method: "GET" }), id);
      }
      return 0;
    }
    const id = o["--credential-only"] ? providerId(String(o["--credential-only"])) : undefined;
    const body = id === undefined ? canonicalJson(hostPayload(o)) : undefined;
    if (o["--dry-run"]) {
      if (body !== undefined) out(body);
      if (hasCredentialSource(o)) out(credentialBody(id ?? "<provider_id>"));
      return 0;
    }
    const env = deps.env || process.env;
    const apiKey = hasCredentialSource(o) ? await readApiKey(o, env, (secret) => secrets.push(secret)) : undefined;
    const key = await readKey(o, env, (secret) => secrets.push(secret));
    async function configureCredential(id: string) {
      const body = credentialBody(providerId(id), apiKey!);
      const route = `/api/v1/network/hosts/${encodeURIComponent(id)}/credential`;
      const header = await walletHeader(key, { method: "PUT", host: router.host, path: route }, body);
      const doc = await request(route, { method: "PUT", headers: { "content-type": "application/json", "X-Wallet-Auth": header }, body });
      if (doc.provider_id !== id || doc.credential_configured !== true) reject("Router returned an invalid credential response.");
      out("credential configured");
    }
    if (id !== undefined) { await configureCredential(id); return 0; }
    const header = await walletHeader(key, { method: "POST", host: router.host, path: "/api/v1/network/hosts" }, body!);
    const doc = await request("/api/v1/network/hosts", { method: "POST", headers: { "content-type": "application/json", "X-Wallet-Auth": header }, body });
    if (!["probation", "rejected", "pending"].includes(String(doc.status))) reject("Router returned an invalid signup status.");
    report(doc);
    if (apiKey !== undefined) await configureCredential(String(doc.provider_id));
    else out(`Configure the sidecar credential later: node join.mjs --router ${router.origin} --credential-only ${doc.provider_id} --key-file /path/to/operator.key --api-key-file /path/to/sidecar.key`);
    return doc.status === "rejected" ? 2 : 0;
  } catch (error) {
    err(error instanceof JoinError ? error.message : "Host registration failed.");
    return 1;
  }
}

// Works for the TypeScript source in Bun and the bundled ESM file in Node.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runJoin(process.argv.slice(2));
