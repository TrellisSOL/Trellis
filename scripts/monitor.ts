// Read-only probe for monitoring agents (on a laptop, phone shortcut, cron or uptime checker). Two modes.
//
// HTTP probe (no chain access, no configuration):
//   bun scripts/monitor.ts <baseUrl> [--watch <seconds>] [--timeout <seconds>]
//   It only GETs public endpoints: /health, /ready, /api/v1/escrow and, when reachable, /ready/metrics.
//   Prints one JSON line per probe: { ok, at, failing: [...], checks: {...}, escrow?, metrics? }
//
// Chain checks (scripts/monitor-chain.ts lists them: RPC health, program-authority drift against
// deployments/<cluster>.json, the build profile each program reports, pauses and when they lapse, the guardian's
// cooldown, pending proposals and where each stands, the credits outflow limiter, what the settlement key committed
// and paid according to the credits program's events, anchor lag, signer SOL and USDC floors, credits vault
// reconciliation, attested gateway freshness, sanctions list age):
//   bun scripts/monitor.ts --once                         devnet: config/devnet.env.example then .env.devnet
//   bun scripts/monitor.ts --once --cluster mainnet       mainnet: config/mainnet.env.example then .env.mainnet.local
//   bun scripts/monitor.ts --once --env-file <file> ...   your own env files, later ones win (the cluster follows SOLANA_NETWORK)
//   bun scripts/monitor.ts --once --base https://<router> also ask the router (HTTP probe, gateway attestation, sanctions age)
//   bun scripts/monitor.ts --chain --watch 300 --metrics-port 9797   keep running; Prometheus gauges on 127.0.0.1:9797/metrics
//                                                         (--metrics-host 0.0.0.0 inside a container network)
//   --json prints only the JSON line. Without it --once prints a short table first.
//
// No credentials are sent, nothing is written and no transaction is built. A role key found in an env file is used
// only to compute its public address; neither it nor the RPC URL (beyond its host name) nor the base URL is printed.
// Exit codes: 0 every check passes, 1 at least one check fails, 2 unreachable (or invalid usage).

export type ProbeResult = {
  ok: boolean;
  at: string;
  failing: string[];
  checks: Record<string, boolean>;
  escrow?: { enabled: boolean; tokens?: number; stale_prices?: string[]; waiting_prices?: string[] };
  metrics?: { reachable: boolean; ready?: boolean };
};
export type ProbeOptions = { timeoutMs?: number; fetch?: typeof fetch; now?: () => Date };

const CHECK = /^[a-z][a-z0-9_-]{0,63}$/;
const SYMBOL = /^[A-Za-z0-9._-]{1,16}$/;

export function normalizeBase(input: string | undefined) {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch { return null; }
}

async function get(url: string, opts: ProbeOptions) {
  try {
    const response = await (opts.fetch ?? fetch)(url, { method: "GET", headers: { accept: "application/json, text/plain" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    return { status: response.status, text: (await response.text()).slice(0, 1_000_000) };
  } catch { return null; }
}
function json(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

export async function probe(base: string, opts: ProbeOptions = {}): Promise<{ code: 0 | 1 | 2; result: ProbeResult }> {
  const at = (opts.now?.() ?? new Date()).toISOString();
  const checks: Record<string, boolean> = {};
  const health = await get(`${base}/health`, opts);
  if (!health) return { code: 2, result: { ok: false, at, failing: ["health"], checks: { health: false } } };
  checks.health = health.status === 200 && json(health.text)?.ok === true;

  const ready = await get(`${base}/ready`, opts);
  const readyBody = ready && (ready.status === 200 || ready.status === 503) ? json(ready.text) : null;
  checks.ready = !!readyBody && ready!.status === 200 && readyBody.ok === true;
  if (readyBody && typeof readyBody.checks === "object" && readyBody.checks)
    for (const [name, value] of Object.entries(readyBody.checks as Record<string, unknown>)) {
      const key = `ready.${CHECK.test(name) ? name : "unnamed_check"}`;
      checks[key] = (checks[key] ?? true) && value === true;
    }

  const result: ProbeResult = { ok: false, at, failing: [], checks };
  const escrow = await get(`${base}/api/v1/escrow`, opts);
  const data = escrow?.status === 200 ? json(escrow.text)?.data : null;
  // On the core launch surface the escrow route is not mounted: the router answers 404 `not_enabled`, which is "this
  // feature is off here", not a failed probe (before round 5 a core deployment could never have every line `ok`).
  const notEnabled = escrow?.status === 404 && json(escrow.text)?.error?.type === "not_enabled";
  if (notEnabled) result.escrow = { enabled: false };
  else if (!data || typeof data.enabled !== "boolean") checks.escrow = false;
  else if (!data.enabled) result.escrow = { enabled: false };
  else {
    const tokens: { symbol?: unknown; price_usd?: unknown; price_source?: unknown }[] = Array.isArray(data.tokens) ? data.tokens : [];
    const unpriced = tokens.filter((t) => typeof t.price_usd !== "number" || !(t.price_usd > 0));
    const name = (t: { symbol?: unknown }) => (typeof t.symbol === "string" && SYMBOL.test(t.symbol) ? t.symbol : "unknown");
    // A pool-priced token ($TRLS) has no price whenever its pool is swinging or thin: its deposits wait and are credited
    // once the price settles, so that is reported (waiting_prices) but does not fail the probe. A feed-priced token with no price does.
    const stale = unpriced.filter((t) => t.price_source !== "window_low").map(name);
    const waiting = unpriced.filter((t) => t.price_source === "window_low").map(name);
    checks["escrow.tokens"] = tokens.length > 0;
    checks["escrow.prices"] = stale.length === 0;
    result.escrow = { enabled: true, tokens: tokens.length, stale_prices: stale, ...(waiting.length ? { waiting_prices: waiting } : {}) };
  }

  // Optional: some proxies do not expose it. Informational only, never a failing check.
  const metrics = await get(`${base}/ready/metrics`, opts);
  const readyGauge = metrics?.status === 200 ? /^trellis_ready\s+([01])\s*$/m.exec(metrics.text) : null;
  result.metrics = readyGauge ? { reachable: true, ready: readyGauge[1] === "1" } : { reachable: false };

  result.failing = Object.keys(checks).filter((k) => !checks[k]).sort();
  result.ok = result.failing.length === 0;
  return { code: result.ok ? 0 : 1, result };
}

function parseArgs(argv: string[]) {
  let base: string | undefined, watch: number | undefined, timeout = 10;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--watch") watch = Number(argv[++i]);
    else if (arg === "--timeout") timeout = Number(argv[++i]);
    else if (!base && !arg.startsWith("--")) base = arg;
    else return null;
  }
  const normalized = normalizeBase(base);
  if (!normalized || (watch !== undefined && !(watch >= 1)) || !(timeout >= 1 && timeout <= 60)) return null;
  return { base: normalized, watch, timeoutMs: timeout * 1000 };
}

type ChainArgs = { cluster?: "devnet" | "mainnet" | "rehearsal"; envFiles: string[]; base: string | null; json: boolean; watch?: number; metricsPort?: number; metricsHost: string; timeoutMs: number };
function parseChainArgs(argv: string[]): ChainArgs | null {
  const out: ChainArgs = { envFiles: [], base: null, json: false, metricsHost: "127.0.0.1", timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once" || arg === "--chain") continue;
    else if (arg === "--json") out.json = true;
    else if (arg === "--cluster") { const v = argv[++i]; if (v !== "devnet" && v !== "mainnet" && v !== "rehearsal") return null; out.cluster = v; }
    else if (arg === "--env-file") { const v = argv[++i]; if (!v) return null; out.envFiles.push(v); }
    else if (arg === "--base") { const v = normalizeBase(argv[++i]); if (!v) return null; out.base = v; }
    else if (arg === "--watch") { out.watch = Number(argv[++i]); if (!(out.watch >= 30)) return null; }
    else if (arg === "--metrics-port") { out.metricsPort = Number(argv[++i]); if (!Number.isInteger(out.metricsPort) || out.metricsPort < 1024 || out.metricsPort > 65535) return null; }
    else if (arg === "--metrics-host") { const v = argv[++i]; if (v !== "127.0.0.1" && v !== "0.0.0.0") return null; out.metricsHost = v; }
    else if (arg === "--timeout") { const t = Number(argv[++i]); if (!(t >= 1 && t <= 60)) return null; out.timeoutMs = t * 1000; }
    else return null;
  }
  return out;
}

async function runChain(argv: string[]): Promise<never> {
  const args = parseChainArgs(argv);
  if (!args) {
    console.error("Usage: bun scripts/monitor.ts --once [--cluster devnet|mainnet|rehearsal] [--env-file <file>]... [--base <https://router>] [--json]\n       bun scripts/monitor.ts --chain --watch <seconds >= 30> [--metrics-port <port>] [same options]");
    process.exit(2);
  }
  const { chainMetrics, chainProbe, chainSummary, parseEnvFile } = await import("./monitor-chain.ts");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dir, "..");
  const cluster = args.cluster;
  const files = args.envFiles.length ? args.envFiles : cluster === "mainnet" ? [resolve(root, "config/mainnet.env.example"), resolve(root, ".env.mainnet.local")] : cluster === "rehearsal" ? [] : [resolve(root, "config/devnet.env.example"), resolve(root, ".env.devnet")];
  // Env files first, then this process's environment, which wins (a container gets its settings that way, and MONITOR_*
  // floors and addresses can be set where the probe runs). Nothing read here is printed.
  const env: Record<string, string | undefined> = {};
  for (const f of files) Object.assign(env, parseEnvFile(f));
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== "") env[k] = v;
  const base = args.base ?? normalizeBase(env.MONITOR_BASE_URL);
  let latest = "";
  if (args.metricsPort) {
    Bun.serve({ hostname: args.metricsHost, port: args.metricsPort, fetch: (req) => (new URL(req.url).pathname === "/metrics" ? new Response(latest || "trellis_chain_monitor_ok 0\n", { headers: { "content-type": "text/plain; version=0.0.4" } }) : new Response("not found", { status: 404 })) });
  }
  let last: 0 | 1 | 2 = 2;
  process.on("SIGINT", () => process.exit(last));
  process.on("SIGTERM", () => process.exit(last));
  for (;;) {
    const { code, result } = await chainProbe({ env, cluster, base, timeoutMs: args.timeoutMs });
    const http = base ? await probe(base, { timeoutMs: args.timeoutMs }) : null;
    last = http && http.code > code ? http.code : code;
    latest = chainMetrics(result);
    if (!args.json) console.log(chainSummary(result) + (http ? `\nrouter probe: ${http.result.ok ? "every check passes" : `failing ${http.result.failing.join(", ")}`}` : ""));
    console.log(JSON.stringify({ ...result, ...(http ? { http: http.result } : {}), ok: result.ok && (!http || http.result.ok) }));
    if (args.watch === undefined) process.exit(last);
    await Bun.sleep(args.watch * 1000);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--once") || argv.includes("--chain")) await runChain(argv);
  const args = parseArgs(argv);
  if (!args) {
    console.error("Usage: bun scripts/monitor.ts <https://your-domain> [--watch <seconds>] [--timeout <seconds>]\n       bun scripts/monitor.ts --once [--cluster devnet|mainnet] [--base <https://your-domain>]   (chain checks; see the header of this file)");
    process.exit(2);
  }
  let last: 0 | 1 | 2 = 2;
  process.on("SIGINT", () => process.exit(last));
  process.on("SIGTERM", () => process.exit(last));
  for (;;) {
    const { code, result } = await probe(args.base, { timeoutMs: args.timeoutMs });
    last = code;
    console.log(JSON.stringify(result));
    if (args.watch === undefined) process.exit(code);
    await Bun.sleep(args.watch * 1000);
  }
}
