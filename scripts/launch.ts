// One command to run all of Trellis on this machine: three mock model providers, the router, and the website
// served at /. TODO(solana): a local validator with the Anchor programs deployed; until then payments are placeholders.
//   bun run launch              # http://127.0.0.1:8787
//   bun run launch --fresh      # wipe the local database first
//   bun run launch --open       # also open the site in the default browser
//   bun run launch --port 8800  # serve on another port
// If it is already running, it prints the address instead of starting a second copy.
// The database and the admin token persist in .data/ between runs. Everything here is local test
// infrastructure: mock providers and mock models.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const DATA = resolve(ROOT, ".data");
const WEB = resolve(ROOT, "web");
const CHAIN_ID = 101; // wallet-adapter id of mainnet-beta; the local launch has no chain yet (TODO(solana): solana-test-validator)
const DB_DIR = resolve(DATA, "pglite-launch");
const SECRETS_FILE = resolve(DATA, "launch.env");
const ENV_LOCAL = resolve(ROOT, ".env.local");
const PROVIDER_PORTS = [9101, 9102, 9103];

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const openBrowser = args.includes("--open");
const portArg = args.indexOf("--port");
const PORT_FIXED = portArg >= 0 || !!process.env.PORT;
let PORT = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT ?? 8787);
let URL_BASE = `http://127.0.0.1:${PORT}`;

const children: { name: string; proc: Subprocess; signal: NodeJS.Signals }[] = [];
let stopping = false;
const say = (msg: string) => console.log(`[launch] ${msg}`);

function die(msg: string): never {
  console.error(`[launch] ${msg}`);
  void shutdown(1);
  throw new Error(msg);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  // Router first (it may be writing), then providers.
  for (const c of [...children].reverse()) {
    if (c.proc.exitCode !== null) continue;
    c.proc.kill(c.signal);
    await Promise.race([c.proc.exited, Bun.sleep(8_000)]);
    if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

function spawn(name: string, cmd: string[], opts: { env?: Record<string, string>; log?: string; signal?: NodeJS.Signals } = {}) {
  const out = opts.log ? Bun.file(opts.log) : "inherit";
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...opts.env }, stdout: out, stderr: out, stdin: "ignore" });
  children.push({ name, proc, signal: opts.signal ?? "SIGTERM" });
  void proc.exited.then((code) => {
    if (!stopping) {
      console.error(`[launch] ${name} exited unexpectedly (code ${code})${opts.log ? `; see ${opts.log}` : ""}. Stopping.`);
      void shutdown(1);
    }
  });
  return proc;
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  if (code !== 0) die(`${cmd.join(" ")} failed (exit ${code}).`);
}

async function listening(port: number) {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {}, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(250);
  }
  die(`${what} did not come up within ${timeoutMs / 1000}s.`);
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
  }
  return out;
}

function newestMtime(dir: string): number {
  let t = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name.startsWith(".")) continue;
    const p = resolve(dir, name.name);
    t = Math.max(t, name.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return t;
}

async function buildWebsite() {
  const index = resolve(WEB, "out/index.html");
  const sources = ["app", "components", "lib", "public"].map((d) => resolve(WEB, d)).filter(existsSync);
  const stale = !existsSync(index) || Math.max(...sources.map(newestMtime), statSync(resolve(WEB, "package.json")).mtimeMs) > statSync(index).mtimeMs;
  if (!stale) return say("website build is up to date");
  if (!Bun.which("pnpm")) {
    if (existsSync(index)) return say("website sources changed but pnpm is not installed; serving the existing build");
    return say("pnpm is not installed, so the website cannot be built; the router will serve its small built-in page");
  }
  if (!existsSync(resolve(WEB, "node_modules"))) {
    say("installing website dependencies (first run)…");
    await run(["pnpm", "install", "--frozen-lockfile"], WEB);
  }
  say("building the website…");
  await run(["pnpm", "build"], WEB);
}

/** An Trellis router started by this launcher (local chain + test faucet) already serving on a nearby port? */
async function runningInstance(): Promise<string | null> {
  for (let port = 8787; port < 8807; port++) {
    if (!(await listening(port))) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(1500) });
      const d = ((await r.json()) as { data?: { dev_faucet?: boolean; chain?: { chain_id?: number } } }).data;
      if (d?.dev_faucet && d.chain?.chain_id === CHAIN_ID) return `http://127.0.0.1:${port}`;
    } catch {
      /* not ours */
    }
  }
  return null;
}

function openUrl(url: string) {
  Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

async function main() {
  const existing = fresh ? null : await runningInstance();
  if (existing) {
    console.log(`\n  Trellis is already running: ${existing}/  (dashboard: ${existing}/dashboard/)\n  Stop it with Ctrl-C in the terminal that started it, then run this again to restart.\n`);
    if (openBrowser) openUrl(existing + "/");
    process.exit(0);
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die("--port needs a port number.");
  if (await listening(PORT)) {
    if (PORT_FIXED) die(`port ${PORT} is already in use. Stop whatever is using it or pick another --port.`);
    const first = PORT;
    while (PORT < first + 20 && (await listening(PORT))) PORT++;
    if (await listening(PORT)) die(`ports ${first}-${PORT} are all in use; pass --port.`);
    URL_BASE = `http://127.0.0.1:${PORT}`;
    say(`port ${first} is busy (another program), using ${PORT} instead`);
  }
  for (const port of PROVIDER_PORTS) if (await listening(port)) die(`port ${port} (mock providers) is already in use — is another "bun run launch" still running? Stop it and retry.`);
  mkdirSync(DATA, { recursive: true });

  if (fresh) {
    say("--fresh: removing the launch database");
    rmSync(DB_DIR, { recursive: true, force: true });
  }

  await buildWebsite();

  // ---- chain
  // TODO(solana): start a local validator (solana-test-validator) and deploy the Anchor programs here. Until then the
  // router runs with the Solana placeholder layer: no deposits, no per-call payments, so every key's balance stays 0.
  // The paid flow (deposit, call, receipt, tab) runs against devnet: scripts/demo/README.md.
  say("no local chain yet: payments run as placeholders (TODO(solana))");

  // ---- secrets for this local install (never committed; .data/ is ignored)
  if (!existsSync(SECRETS_FILE)) {
    writeFileSync(SECRETS_FILE, `APP_SECRET=${randomBytes(32).toString("hex")}\nADMIN_TOKEN=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  }
  const local = readEnvFile(ENV_LOCAL);
  const env: Record<string, string> = {
    ...local,
    ...readEnvFile(SECRETS_FILE),
    TRELLIS_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PUBLIC_BASE_URL: URL_BASE,
    DATABASE_URL: `pglite://${DB_DIR}`,
    EXPLORER_URL: "",
    CHAIN_START_BLOCK: local.DEPLOY_BLOCK ?? "0",
    ALLOW_DEV_ATTESTATION: "true",
    CANARIES: "false",
    // Faster than production so the full flow is visible within minutes.
    ANCHOR_INTERVAL_MS: "120000",
    SETTLEMENT_INTERVAL_MS: "300000",
    PAYWITH_THRESHOLD_USD: "0.000001",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    WEB_DIR: resolve(WEB, "out"),
  };

  // ---- mock providers, then seed them (the database is single-process, so seed before the router)
  say("starting three mock model providers (ports 9101-9103)");
  spawn("mock providers", ["bun", "scripts/mock-providers.ts"], { log: resolve(DATA, "launch-providers.log") });
  await waitFor("the mock providers", async () => (await Promise.all(PROVIDER_PORTS.map(listening))).every(Boolean), 20_000);
  await run(["bun", "scripts/seed.ts", "config/providers.local.yaml"], ROOT, env);

  // ---- router + website
  say(`starting the router on ${URL_BASE}`);
  spawn("router", ["bun", "src/index.ts"], { env });
  await waitFor("the router", async () => (await fetch(`${URL_BASE}/health`)).ok, 60_000);

  console.log(`
  Trellis is running locally.

    Website    ${URL_BASE}/
    Dashboard  ${URL_BASE}/dashboard/
    API        ${URL_BASE}/api/v1   (OpenAI/OpenRouter-compatible)
    Chain      none yet (chain id ${CHAIN_ID}; payments are placeholders)

  Try it: the website, docs, model list and dashboard, and creating a key. Model calls answer 402 (no balance):
  with no local chain there is nothing to deposit on. The paid flow runs against devnet (scripts/demo/README.md).
  All money and models here are test fixtures.

  Local credentials are stored in .data/launch.env.
  Your chain, keys and balances are kept in .data/ between runs; "bun run launch --fresh" starts over.
  Press Ctrl-C to stop everything.
`);
  if (openBrowser) openUrl(URL_BASE + "/");
}

main().catch((e) => {
  if (!stopping) {
    console.error(`[launch] ${(e as Error).message}`);
    void shutdown(1);
  }
});
