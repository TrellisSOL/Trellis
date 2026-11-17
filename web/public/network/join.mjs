#!/usr/bin/env node
// Trellis host registration. Source: scripts/network-join.ts. Requires Node 22 or later.
/* Bundled third-party licence notices
none: this file bundles no third-party code
*/

// scripts/network-join.ts
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// src/solana/constants.ts
var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0)
    zeros++;
  const digits = [];
  for (let i = zeros;i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0;j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = carry / 58 | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = carry / 58 | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}
function base58Decode(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1")
    zeros++;
  const bytes = [];
  for (let i = zeros;i < text.length; i++) {
    let carry = B58.indexOf(text[i]);
    if (carry < 0)
      throw new Error("not a base58 string");
    for (let j = 0;j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

// scripts/network-join-credential.ts
import { open } from "node:fs/promises";
// src/solana/rpc-redaction.ts
var configured = new Set;

// src/lib/util.ts
function canonical(value) {
  if (typeof value === "bigint")
    return value.toString();
  if (Array.isArray(value))
    return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v !== undefined) {
        if (k === "__proto__")
          Object.defineProperty(out, k, { value: canonical(v), enumerable: true, writable: true, configurable: true });
        else
          out[k] = canonical(v);
      }
    }
    return out;
  }
  return value;
}
var canonicalJson = (v) => JSON.stringify(canonical(v));
var threshold = process.env.LOG_LEVEL || "info";

// scripts/network-join-credential.ts
class JoinError extends Error {
}
var reject = (message) => {
  throw new JoinError(message);
};
var hasCredentialSource = (o) => !!(o["--api-key-file"] || o["--api-key-env"]);
function providerId(value) {
  if (!value || value.length > 100)
    reject("Provide a provider ID with 1 to 100 characters.");
  return value;
}
var credentialBody = (id, apiKey = "<redacted>") => canonicalJson({ provider_id: id, api_key: apiKey });
async function readApiKey(o, env, remember) {
  let raw;
  if (o["--api-key-file"]) {
    const file = await open(String(o["--api-key-file"]), "r").catch(() => reject("Could not read the sidecar API key file."));
    try {
      const info = await file.stat();
      if (!info.isFile())
        reject("The sidecar API key source must be a regular file.");
      if (process.platform !== "win32" && info.mode & 36)
        reject("The sidecar API key file must not be group or world readable; use chmod 600.");
      const bytes = await file.readFile();
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return reject("The sidecar API key file must contain UTF-8 text.");
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      if (error instanceof JoinError)
        throw error;
      return reject("Could not read the sidecar API key file.");
    } finally {
      await file.close();
    }
  } else
    raw = env[String(o["--api-key-env"])] || "";
  remember(raw);
  const key = raw.trim();
  remember(key);
  if (key.length < 16 || key.length > 500)
    reject("The sidecar API key must contain 16 to 500 characters after trimming.");
  return key;
}
function redactCredentials(text, secrets) {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("<redacted>");
    text = text.split(JSON.stringify(secret).slice(1, -1)).join("<redacted>");
  }
  return text;
}

// scripts/network-join.ts
var WARNING = "Use a dedicated operator wallet, not a wallet holding funds. This command signs authentication messages; it sends no transactions.";
var HELP = `node join.mjs --name NAME --endpoint https://SIDECAR --payout-address ADDRESS --models MODEL[,MODEL] [--contact CONTACT]
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
var KEY_SHAPES = [/(?:0x)?[a-f0-9]{64,}/gi, /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/g, /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g];
var looksLikeKey = (text) => KEY_SHAPES.some((shape) => new RegExp(shape.source, shape.flags.replace("g", "")).test(text));
var safeOutput = (text) => KEY_SHAPES.reduce((out, shape) => out.replace(shape, "[redacted]"), text).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, "");
function options(args) {
  if (args.some(looksLikeKey))
    reject("Secret keys must come from a file or environment variable, never arguments.");
  const flags = new Set(["--help", "--dry-run"]);
  const values = new Set(["--name", "--endpoint", "--payout-address", "--models", "--contact", "--router", "--key-file", "--key-env", "--status", "--poll-count", "--poll-interval", "--api-key-file", "--api-key-env", "--credential-only"]);
  const out = {};
  for (let i = 0;i < args.length; i++) {
    const key = args[i];
    if (key in out)
      reject("Duplicate command option.");
    if (flags.has(key))
      out[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith("--"))
      out[key] = args[++i];
    else
      reject("Unknown option or missing value. Run with --help.");
  }
  if (out["--key-file"] && out["--key-env"])
    reject("Choose one key source: --key-file or --key-env.");
  if (out["--api-key-file"] && out["--api-key-env"])
    reject("Choose one sidecar API key source: --api-key-file or --api-key-env.");
  if (out["--credential-only"] && !hasCredentialSource(out))
    reject("--credential-only requires --api-key-file or --api-key-env.");
  if (out["--credential-only"] && ["--name", "--endpoint", "--payout-address", "--models", "--contact"].some((key) => out[key] !== undefined))
    reject("--credential-only cannot be combined with signup options.");
  if (out["--status"] && (out["--dry-run"] || ["--name", "--endpoint", "--payout-address", "--models", "--contact", "--key-file", "--key-env", "--api-key-file", "--api-key-env", "--credential-only"].some((key) => out[key] !== undefined)))
    reject("--status cannot be combined with signup or key options.");
  if (!out["--status"] && (out["--poll-count"] || out["--poll-interval"]))
    reject("Polling options require --status.");
  return out;
}
function url(value, loopback = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return reject("Provide a valid HTTPS URL.");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search || parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
    reject("URLs must use HTTPS and contain no credentials, query or fragment.");
  return parsed;
}
function hostPayload(o) {
  const name = String(o["--name"] || "");
  if (!name.trim() || name.length > 60)
    reject("Provide --name with 1 to 60 characters.");
  const endpoint = String(o["--endpoint"] || "");
  url(endpoint);
  const payout_address = String(o["--payout-address"] || "");
  if (!isAddress(payout_address))
    reject("Provide --payout-address as a base58 Solana wallet address.");
  const models = String(o["--models"] || "").split(",").map((id) => id.trim());
  if (models.length < 1 || models.length > 8 || models.some((id) => !id) || new Set(models).size !== models.length)
    reject("Provide 1 to 8 distinct model ids with --models.");
  const contact = o["--contact"];
  if (contact !== undefined && contact.length > 120)
    reject("Contact must be at most 120 characters.");
  return { name, endpoint, payout_address, models, ...contact === undefined ? {} : { contact } };
}
var isAddress = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && decode(value)?.length === 32;
function decode(text) {
  try {
    return base58Decode(text);
  } catch {
    return null;
  }
}
var PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function operatorKey(raw) {
  let bytes = null;
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
        bytes = Uint8Array.from(parsed);
    } catch {
      bytes = null;
    }
  } else if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(text))
    bytes = decode(text);
  if (!bytes || bytes.length !== 64 && bytes.length !== 32)
    return reject("The operator secret key is invalid.");
  try {
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(bytes.subarray(0, 32))]), format: "der", type: "pkcs8" });
    const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));
    if (bytes.length === 64 && Buffer.compare(Buffer.from(publicKey), Buffer.from(bytes.subarray(32))) !== 0)
      return reject("The operator secret key is invalid.");
    return { privateKey, address: base58Encode(publicKey) };
  } catch {
    return reject("The operator secret key is invalid.");
  } finally {
    bytes.fill(0);
  }
}
async function walletHeader(key, request, body, timestamp = Math.floor(Date.now() / 1000)) {
  try {
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    const message = ["trellis:wallet-auth:v2", request.method.toUpperCase(), request.host.toLowerCase(), request.path, String(timestamp), hash].join(`
`);
    const signature = base58Encode(new Uint8Array(sign(null, Buffer.from(message, "utf8"), key.privateKey)));
    return `${key.address}:${timestamp}:${signature}`;
  } catch {
    return reject("The operator secret key is invalid.");
  }
}
async function readKey(o, env, remember) {
  let raw;
  if (o["--key-file"]) {
    let bytes;
    try {
      bytes = await readFile(String(o["--key-file"]));
    } catch {
      return reject("Could not read the operator key file.");
    }
    try {
      raw = bytes.toString("utf8").trim();
    } finally {
      bytes.fill(0);
    }
  } else
    raw = (env[String(o["--key-env"] || "TRELLIS_OPERATOR_PRIVATE_KEY")] || "").trim();
  if (!raw)
    reject("Provide the operator secret key through --key-file or --key-env.");
  remember(raw);
  return operatorKey(raw);
}
function integer(value, fallback, min, max) {
  if (value === undefined)
    return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max)
    reject("Polling count or interval is outside its allowed range.");
  return Number(value);
}
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function runJoin(args, deps = {}) {
  const secrets = [];
  const out = (line) => (deps.out || console.log)(safeOutput(redactCredentials(line, secrets)));
  const err = (line) => (deps.err || console.error)(safeOutput(redactCredentials(line, secrets)));
  err(WARNING);
  try {
    let report = function(doc2, id2) {
      if (typeof doc2.provider_id !== "string" || !doc2.provider_id || typeof doc2.status !== "string" || !Array.isArray(doc2.reasons) || doc2.reasons.some((reason) => typeof reason !== "string") || id2 !== undefined && doc2.provider_id !== id2)
        return reject("Router returned an invalid host response.");
      out(`Provider: ${doc2.provider_id}
Status: ${doc2.status}`);
      out(doc2.reasons.length ? `Reasons:
${doc2.reasons.map((reason) => `- ${reason}`).join(`
`)}` : "Reasons: none");
      if (id2 !== undefined)
        out(`Attested: ${doc2.attested === true}
Probation until: ${doc2.probation_until ?? "none"}
Weight: ${doc2.weight ?? "unknown"}`);
      const dashboard = `/hosts/?id=${encodeURIComponent(String(doc2.provider_id))}`;
      if (id2 === undefined && doc2.dashboard !== dashboard)
        reject("Router returned an invalid dashboard URL.");
      out(`Dashboard: ${new URL(dashboard, router).href}`);
    };
    const o = options(args);
    if (o["--help"]) {
      out(HELP);
      return 0;
    }
    const router = url(String(o["--router"] || "https://trellis.example"), true);
    if (router.pathname !== "/")
      reject("--router must be an origin without a path.");
    const fetcher = deps.fetcher || fetch;
    async function request(route, init) {
      let response;
      try {
        response = await fetcher(new URL(route, router), { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
      } catch {
        return reject("Could not reach the router; no automatic signup retry was made.");
      }
      let doc2;
      try {
        doc2 = await response.json();
      } catch {
        return reject(`Router returned HTTP ${response.status} without valid JSON.`);
      }
      if (!response.ok) {
        const message = record(doc2) && record(doc2.error) && typeof doc2.error.message === "string" ? doc2.error.message : "Request refused.";
        reject(`HTTP ${response.status}: ${message}`);
      }
      if (init.method === "POST" && ![200, 201].includes(response.status))
        reject(`Router returned unexpected signup HTTP ${response.status}.`);
      if (!record(doc2))
        return reject("Router returned an invalid host response.");
      return doc2;
    }
    if (o["--status"]) {
      const id2 = String(o["--status"]);
      const count = integer(o["--poll-count"], 5, 1, 100);
      const interval = integer(o["--poll-interval"], 5000, 100, 60000);
      for (let i = 0;i < count; i++) {
        if (i)
          await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(interval);
        report(await request(`/api/v1/network/hosts/${encodeURIComponent(id2)}/status`, { method: "GET" }), id2);
      }
      return 0;
    }
    const id = o["--credential-only"] ? providerId(String(o["--credential-only"])) : undefined;
    const body = id === undefined ? canonicalJson(hostPayload(o)) : undefined;
    if (o["--dry-run"]) {
      if (body !== undefined)
        out(body);
      if (hasCredentialSource(o))
        out(credentialBody(id ?? "<provider_id>"));
      return 0;
    }
    const env = deps.env || process.env;
    const apiKey = hasCredentialSource(o) ? await readApiKey(o, env, (secret) => secrets.push(secret)) : undefined;
    const key = await readKey(o, env, (secret) => secrets.push(secret));
    async function configureCredential(id2) {
      const body2 = credentialBody(providerId(id2), apiKey);
      const route = `/api/v1/network/hosts/${encodeURIComponent(id2)}/credential`;
      const header2 = await walletHeader(key, { method: "PUT", host: router.host, path: route }, body2);
      const doc2 = await request(route, { method: "PUT", headers: { "content-type": "application/json", "X-Wallet-Auth": header2 }, body: body2 });
      if (doc2.provider_id !== id2 || doc2.credential_configured !== true)
        reject("Router returned an invalid credential response.");
      out("credential configured");
    }
    if (id !== undefined) {
      await configureCredential(id);
      return 0;
    }
    const header = await walletHeader(key, { method: "POST", host: router.host, path: "/api/v1/network/hosts" }, body);
    const doc = await request("/api/v1/network/hosts", { method: "POST", headers: { "content-type": "application/json", "X-Wallet-Auth": header }, body });
    if (!["probation", "rejected", "pending"].includes(String(doc.status)))
      reject("Router returned an invalid signup status.");
    report(doc);
    if (apiKey !== undefined)
      await configureCredential(String(doc.provider_id));
    else
      out(`Configure the sidecar credential later: node join.mjs --router ${router.origin} --credential-only ${doc.provider_id} --key-file /path/to/operator.key --api-key-file /path/to/sidecar.key`);
    return doc.status === "rejected" ? 2 : 0;
  } catch (error) {
    err(error instanceof JoinError ? error.message : "Host registration failed.");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runJoin(process.argv.slice(2));
export {
  walletHeader,
  safeOutput,
  runJoin,
  operatorKey,
  hostPayload
};
