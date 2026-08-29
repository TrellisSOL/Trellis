// The router against devnet, end to end, with a real wallet. Starts the router in this process (its own pglite database
// under .data/devnet-demo, no Redis, a local OpenAI-compatible stand-in provider so chat calls need no model host) and then:
//
//   a. creates an API key through the router API
//   b. builds the USDC deposit with POST /api/v1/credits/deposit-tx, signs it with the deployer wallet, sends it and
//      waits for finality
//   c. runs the credits indexer and shows the ledger balance
//   d. makes a chat completion with usage.include
//   e. fetches /api/v1/generation?id= and the signed receipt, and verifies the signature with packages/client
//   f. runs the receipts-anchor job (roots close on the hour: --wait-anchor waits for the boundary) and checks the
//      receipt's Merkle path against the ReceiptRoot trellis_anchor holds on devnet
//   g. opens a tab (payer: the deployer; payee: the router signing key) with a session key, signs a voucher, makes a
//      tab-billed call and closes the tab through the hosted facilitator
//   h. prints a summary with explorer links and writes .data/devnet-demo/summary.json
//
// Every step is idempotent and resumable: what has been done is kept in .data/devnet-demo/state.json and a re-run picks up
// where it stopped (the API key, the deposit signature, the open tab). Spending steps are skipped while the deployer's
// USDC token account is empty, and the summary says what to do. Needs .env.devnet (bun scripts/demo/make-env.ts).
//
//   bun scripts/demo/devnet-demo.ts --dry-run       # start the router, create the key, build the deposit; spend nothing
//   bun scripts/demo/devnet-demo.ts                 # the whole walkthrough
//   bun scripts/demo/devnet-demo.ts --wait-anchor   # also wait for the hourly root before verifying the receipt
//   bun scripts/demo/devnet-demo.ts --serve         # keep the router (and the dashboard at /) running afterwards
//   bun scripts/demo/devnet-demo.ts --reset         # forget the saved state (the key, the tab); the chain is unchanged
//   bun scripts/demo/devnet-demo.ts --reset-tab     # forget only the saved tab: the next run opens, vouches and closes a new one
//
// Options: --deposit <usdc> (default 1), --tab-cap <usdc> (default 0.5), --voucher <usdc> (default 0.02).
import { verifyRootMemo } from "../../src/solana/anchor-memo.ts";
import { existsSync, rmSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createApp } from "../../src/app.ts";
import { providers } from "../../src/db/schema.ts";
import { encrypt } from "../../src/lib/util.ts";
import { serveMockProvider } from "../../src/providers/mock.ts";
import { runRegistry } from "../../src/services/registry.ts";
import { creditsProgram, readCreditAccount } from "../../src/solana/credits.ts";
import { receiptRootHour } from "../../src/solana/programs/anchor.ts";
import { buildCloseTransaction, openTabInstruction, readTab, signVoucher, tabProgram, voucherBytes, voucherScope, wireVoucher, type Voucher } from "../../src/solana/tab.ts";
import { encodeVoucherHeader, TAB_HEADER, TAB_VOUCHER_HEADER } from "../../src/solana/tab-billing.ts";
import { verifyMerkleProof, verifyReceipt } from "../../packages/client/src/receipts.ts";
import { connect, DATABASE_URL, ENV_FILE, explorer, formatUsdc, loadDevnetEnv, loadKeypair, readJsonFile, rpc, rpcLabel, rpcUrl, signSendConfirm, sleep, solBalance, STATE_DIR, STATE_FILE, SUMMARY_FILE, tokenUnits, usdcUnits, writePrivateFile } from "./lib.ts";

// ---- Arguments -----------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, d: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY_RUN = flag("dry-run");
const WAIT_ANCHOR = flag("wait-anchor");
const SERVE = flag("serve");
if (flag("reset")) { rmSync(STATE_FILE, { force: true }); rmSync(SUMMARY_FILE, { force: true }); }
const DEPOSIT_UNITS = usdcUnits(option("deposit", "1"));
const TAB_CAP_UNITS = usdcUnits(option("tab-cap", "0.5"));
const VOUCHER_UNITS = usdcUnits(option("voucher", "0.02")); // >= the facilitator's 0.01 USDC minimum settlement
const MODEL = "meta-llama/llama-3.3-70b-instruct";
const PROVIDER_ID = "local-stand-in";
const ROUTER_FLOOR_SOL = 0.01, RELAY_FLOOR_SOL = 0.03, TOP_UP_SOL = 0.05;

// ---- State ---------------------------------------------------------------------------------------------------------------
type Tab = { tabId: string; sessionSeedHex: string; pda?: string; openSig?: string; /** Tab.created_at as the chain recorded it: part of what a voucher signs. */ createdAt?: string; chatGenerationId?: string; voucherSeq?: string; closeSig?: string };
type State = { createdAt: string; key?: { secret: string; hash: string; chainKeyHash: string }; depositSig?: string; depositUnits?: string; generationId?: string; tab?: Tab };
const state = readJsonFile<State>(STATE_FILE, { createdAt: new Date().toISOString() });
const save = () => writePrivateFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
if (flag("reset-tab") && state.tab) { delete state.tab; save(); }

type StepStatus = "done" | "skipped" | "blocked" | "pending" | "dry-run";
type Step = { id: string; title: string; status: StepStatus; note?: string; tx?: string; links?: Record<string, string>; data?: Record<string, unknown> };
const steps: Step[] = [];
const step = (s: Step) => { steps.push(s); const tag = s.status.toUpperCase().padEnd(8); console.log(`[${tag}] ${s.id}. ${s.title}${s.note ? ` — ${s.note}` : ""}`); if (s.tx) console.log(`           tx ${s.tx}`); for (const [k, v] of Object.entries(s.links ?? {})) console.log(`           ${k.padEnd(10)} ${v}`); return s; };

// ---- Environment and wallet ------------------------------------------------------------------------------------------------
if (!existsSync(ENV_FILE)) { console.error(`Missing ${ENV_FILE}: run \`bun scripts/demo/make-env.ts\` first.`); process.exit(2); }
const env = loadDevnetEnv();
const RPC = rpcUrl(env);
const conn = connect(RPC, "confirmed");
const deployer = loadKeypair();
const ex = (kind: "tx" | "address", v: string) => explorer(kind, v, env.EXPLORER_URL);
console.log(`devnet walkthrough${DRY_RUN ? " (dry run: nothing is spent)" : ""}`);
console.log(`  rpc       ${rpcLabel(RPC)}`);
console.log(`  wallet    ${deployer.publicKey.toBase58()}  ${ex("address", deployer.publicKey.toBase58())}`);

// ---- The router, in process ---------------------------------------------------------------------------------------------------
// DATABASE_URL follows DEMO_DATA_DIR (lib.ts), so a second walkthrough can run beside this one on its own directory.
const { app, ctx, close } = await createApp({ env: { ...env, DATABASE_URL, WORKERS: "false", HEALTH_PROBES: "false", CANARIES: "false", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" }, startJobs: false });
const stand = serveMockProvider({ name: "Local stand-in", models: [{ id: "llama-3.3-70b", slug: MODEL, prompt: "0.0000001", completion: "0.00000032" }] }, 0);
await ctx.db.insert(providers).values({ id: PROVIDER_ID, name: "Local stand-in", baseUrl: stand.url, apiKeyEnc: encrypt(ctx.cfg.appSecret, "local-stand-in-key"), status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true } })
  .onConflictDoUpdate({ target: providers.id, set: { baseUrl: stand.url, status: "live" } });
await runRegistry(ctx);
await ctx.catalog.refresh();
let server: ReturnType<typeof Bun.serve>;
try { server = Bun.serve({ hostname: ctx.cfg.host, port: ctx.cfg.port, fetch: app.fetch, idleTimeout: 255 }); }
catch { server = Bun.serve({ hostname: ctx.cfg.host, port: 0, fetch: app.fetch, idleTimeout: 255 }); console.log(`  port ${ctx.cfg.port} is busy; listening on ${server.port} instead`); }
const BASE = `http://${server.hostname}:${server.port}`;
// The launch surface (src/surface/): `core` is the default and the launch. Steps of features that are not on it are
// skipped with a "not in core" line; LAUNCH_SURFACE=all runs the whole walkthrough.
const CORE = ctx.surface?.core ?? false;
const MEMO = ctx.cfg.launch.anchor.mode === "memo";
console.log(`  surface   ${ctx.cfg.surface}${CORE ? " (core: tabs and the hosted facilitator are skipped; receipt roots are memo transactions)" : ""}`);
if (ctx.cfg.surfaceIgnored.length) console.log(`  ignored   ${ctx.cfg.surfaceIgnored.map((s) => s.setting).join(", ")} (settings of features that are not in core)`);
const NOT_IN_CORE = "not in core: this feature is not on the core launch surface (run with LAUNCH_SURFACE=all)";
console.log(`  router    ${BASE}  (dashboard at / when web/out is built; status at /api/v1/status)`);
console.log(`  provider  ${PROVIDER_ID} at ${stand.url} (local stand-in, not real inference)`);

type Json = Record<string, any>;
async function api(path: string, init: RequestInit & { json?: unknown; auth?: string } = {}): Promise<{ status: number; headers: Headers; body: Json }> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.auth) headers.set("authorization", `Bearer ${init.auth}`);
  const r = await fetch(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await r.text();
  let body: Json = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, headers: r.headers, body };
}
const must = (r: { status: number; body: Json }, what: string) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };

const summary: Record<string, unknown> = { startedAt: new Date().toISOString(), rpc: rpcLabel(RPC), router: BASE, wallet: deployer.publicKey.toBase58(), dryRun: DRY_RUN };
let exitCode = 0;
const shutdown = async () => {
  summary.steps = steps;
  summary.finishedAt = new Date().toISOString();
  writePrivateFile(SUMMARY_FILE, JSON.stringify(summary, null, 2) + "\n");
  save();
  if (SERVE) { console.log(`\nrouter still listening at ${BASE}; Ctrl-C to stop`); return; }
  server.stop(true);
  stand.stop();
  await close();
  process.exit(exitCode);
};

try {
  // ---- Preflight: balances ---------------------------------------------------------------------------------------------------
  const credits = creditsProgram(ctx.cfg)!;
  const tabs = tabProgram(ctx.cfg)!; // null in core: only step g uses it
  const usdcMint = new PublicKey(ctx.cfg.chain.usdc);
  const payerUsdc = getAssociatedTokenAddressSync(usdcMint, deployer.publicKey, true);
  const sol = await solBalance(conn, deployer.publicKey);
  const usdc = await tokenUnits(conn, payerUsdc);
  console.log(`  balances  ${sol.toFixed(4)} SOL, ${formatUsdc(usdc)} USDC (${usdcMint.toBase58()})`);
  summary.balances = { sol, usdcUnits: usdc.toString() };
  const needUsdc = DEPOSIT_UNITS + (CORE ? 0n : TAB_CAP_UNITS);
  const usdcBlocked = usdc < needUsdc && !(state.depositSig && state.tab?.openSig);
  if (usdcBlocked) {
    console.log(`\n  The wallet holds ${formatUsdc(usdc)} devnet USDC; the walkthrough spends ${formatUsdc(needUsdc)} (deposit ${formatUsdc(DEPOSIT_UNITS)} + tab cap ${formatUsdc(TAB_CAP_UNITS)}).`);
    console.log(`  Circle's devnet USDC has no programmatic faucet: open https://faucet.circle.com, choose Solana Devnet and send USDC to`);
    console.log(`  ${deployer.publicKey.toBase58()}, then run this script again. Steps that need no USDC run now.\n`);
    summary.blocked = { usdc: true, needUnits: needUsdc.toString(), faucet: "https://faucet.circle.com", to: deployer.publicKey.toBase58() };
  }

  // ---- a. API key ----------------------------------------------------------------------------------------------------------
  if (state.key && (await api("/api/v1/credits", { auth: state.key.secret })).status === 200) {
    step({ id: "a", title: "API key", status: "done", note: `reusing key ${state.key.hash.slice(0, 12)}… from ${STATE_FILE}` });
  } else {
    const r = must(await api("/api/v1/keys", { method: "POST", json: { name: "devnet-walkthrough" } }), "POST /api/v1/keys");
    state.key = { secret: r.key, hash: r.data.hash, chainKeyHash: r.data.chain_key_hash ?? r.data.hash };
    save();
    step({ id: "a", title: "API key", status: "done", note: `key hash ${state.key.hash.slice(0, 12)}… (secret kept in ${STATE_FILE})`, data: { deposit: r.deposit } });
  }
  const key = state.key!;
  summary.key = { hash: key.hash, chainKeyHash: key.chainKeyHash };

  // ---- Funding the router signing key and the facilitator relay with SOL (fees only) ----------------------------------------------
  const routerKp = ctx.chain.signer("router")!;
  const relayKp = CORE ? null : ctx.chain.signer("facilitator")!; // the hosted facilitator's relay key: not in core
  const payeeUsdc = getAssociatedTokenAddressSync(usdcMint, routerKp.publicKey, true);
  {
    const [routerSol, relaySol] = await Promise.all([solBalance(conn, routerKp.publicKey), relayKp ? solBalance(conn, relayKp.publicKey) : Promise.resolve(Infinity)]);
    const payeeAta = await rpc(() => conn.getAccountInfo(payeeUsdc, "confirmed"));
    const ixs = [];
    if (routerSol < ROUTER_FLOOR_SOL) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: routerKp.publicKey, lamports: Math.round(TOP_UP_SOL * 1e9) }));
    if (relayKp && relaySol < RELAY_FLOOR_SOL) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: relayKp.publicKey, lamports: Math.round(TOP_UP_SOL * 1e9) }));
    if (!payeeAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, payeeUsdc, routerKp.publicKey, usdcMint));
    const note = `router ${routerKp.publicKey.toBase58().slice(0, 8)}… ${routerSol.toFixed(4)} SOL, relay ${relayKp ? `${relayKp.publicKey.toBase58().slice(0, 8)}… ${relaySol.toFixed(4)} SOL` : "not in core"}, payee USDC account ${payeeAta ? "exists" : "missing"}`;
    if (!ixs.length) step({ id: "0", title: "Fund the router key and the facilitator relay (SOL for fees)", status: "done", note });
    else if (DRY_RUN) step({ id: "0", title: "Fund the router key and the facilitator relay (SOL for fees)", status: "dry-run", note: `${note}; would send ${ixs.length} instruction(s) from the wallet` });
    else {
      const sent = await signSendConfirm(conn, new Transaction({ feePayer: deployer.publicKey }).add(...ixs), [deployer], "confirmed");
      step({ id: "0", title: "Fund the router key and the facilitator relay (SOL for fees)", status: "done", note, tx: sent.signature, links: { explorer: ex("tx", sent.signature) } });
    }
  }

  // ---- b. Deposit --------------------------------------------------------------------------------------------------------------
  if (state.depositSig) {
    step({ id: "b", title: `Deposit ${formatUsdc(BigInt(state.depositUnits ?? DEPOSIT_UNITS))} USDC through trellis_credits`, status: "done", note: "already sent", tx: state.depositSig, links: { explorer: ex("tx", state.depositSig) } });
  } else {
    const r = must(await api("/api/v1/credits/deposit-tx", { method: "POST", auth: key.secret, json: { amount: formatUsdc(DEPOSIT_UNITS), payer: deployer.publicKey.toBase58() } }), "POST /api/v1/credits/deposit-tx");
    const tx = Transaction.from(Buffer.from(r.data.transaction, "base64"));
    const links = { credit: ex("address", r.data.accounts.credit), vault: ex("address", r.data.accounts.vault) };
    if (DRY_RUN) step({ id: "b", title: `Deposit ${formatUsdc(DEPOSIT_UNITS)} USDC through trellis_credits`, status: "dry-run", note: `unsigned transaction built (${tx.instructions.length} instruction, ${r.data.message}); stopping before spending`, links });
    else if (usdc < DEPOSIT_UNITS) step({ id: "b", title: `Deposit ${formatUsdc(DEPOSIT_UNITS)} USDC through trellis_credits`, status: "blocked", note: `unsigned transaction built; the wallet holds ${formatUsdc(usdc)} USDC`, links });
    else {
      tx.lastValidBlockHeight = r.data.expires_at_block_height;
      const sent = await signSendConfirm(conn, tx, [deployer], "finalized");
      state.depositSig = sent.signature;
      state.depositUnits = DEPOSIT_UNITS.toString();
      save();
      step({ id: "b", title: `Deposit ${formatUsdc(DEPOSIT_UNITS)} USDC through trellis_credits`, status: "done", note: "finalized", tx: sent.signature, links: { explorer: ex("tx", sent.signature), ...links } });
    }
  }
  const depositDone = !!state.depositSig;
  if (depositDone) summary.deposit = { signature: state.depositSig, units: state.depositUnits, explorer: ex("tx", state.depositSig!) };

  // ---- c. Indexer and ledger balance ---------------------------------------------------------------------------------------------
  let balance = "0";
  if (depositDone) {
    let credited = false;
    for (let i = 0; i < 12 && !credited; i++) {
      await ctx.jobs.run("chain-indexer");
      const r = must(await api("/api/v1/credits", { auth: key.secret }), "GET /api/v1/credits");
      balance = String(r.data.balance ?? "0");
      credited = Number(balance) > 0;
      if (!credited) await sleep(5_000);
    }
    const onchain = await readCreditAccount(ctx.chain.connection, credits, key.chainKeyHash).catch(() => null);
    step({ id: "c", title: "Credits indexer and ledger balance", status: credited ? "done" : "pending", note: `ledger balance ${balance} USDC; on-chain credit account ${onchain ? `${formatUsdc(onchain.balance)} USDC` : "not readable yet"}` });
    summary.ledger = { balance, onchainUnits: onchain?.balance.toString() ?? null };
    if (!credited) throw new Error("the deposit is finalized but the indexer has not credited it; re-run to try again");
  } else {
    await ctx.jobs.run("chain-indexer").catch(() => undefined);
    step({ id: "c", title: "Credits indexer and ledger balance", status: DRY_RUN ? "dry-run" : "blocked", note: "indexer ran (nothing of ours to credit yet)" });
  }

  // ---- d. Chat completion ---------------------------------------------------------------------------------------------------------
  if (depositDone && !state.generationId) {
    const r = await api("/api/v1/chat/completions", { method: "POST", auth: key.secret, json: { model: MODEL, messages: [{ role: "user", content: "In one short sentence, what is a Merkle root?" }], usage: { include: true }, stream: false } });
    must(r, "POST /api/v1/chat/completions");
    state.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
    step({ id: "d", title: "Chat completion (prepaid credits, usage.include)", status: "done", note: `receipt ${state.generationId}; usage ${JSON.stringify(r.body.usage ?? null)}` });
  } else if (state.generationId) step({ id: "d", title: "Chat completion (prepaid credits, usage.include)", status: "done", note: `already made: receipt ${state.generationId}` });
  else step({ id: "d", title: "Chat completion (prepaid credits, usage.include)", status: DRY_RUN ? "dry-run" : "blocked", note: "needs a credited deposit" });

  // ---- e. Generation and receipt ---------------------------------------------------------------------------------------------------
  let receipt: Json | null = null;
  if (state.generationId) {
    const g = must(await api(`/api/v1/generation?id=${encodeURIComponent(state.generationId)}`, { auth: key.secret }), "GET /api/v1/generation");
    receipt = must(await api(`/api/v1/receipts/${encodeURIComponent(state.generationId)}`), "GET /api/v1/receipts/:id").data;
    const keys = must(await api("/api/v1/receipts/keys"), "GET /api/v1/receipts/keys");
    const v = await verifyReceipt({ id: receipt!.id, payload: receipt!.payload, sig: receipt!.sig, key_id: receipt!.key_id }, { keys: keys as { keys: import("../../packages/client/src/index.ts").JwkKey[] } });
    step({ id: "e", title: "Generation and signed receipt", status: v.valid ? "done" : "pending", note: `model ${g.data.model} via ${g.data.provider_name}; receipt key ${receipt!.key_id}; signature ${v.valid ? "verifies" : "does not verify"} (packages/client verifyReceipt)`, links: { receipt: `${BASE}/api/v1/receipts/${state.generationId}` } });
    summary.receipt = { id: state.generationId, keyId: receipt!.key_id, signatureValid: v.valid, cost: g.data.total_cost ?? g.data.cost ?? null };
    if (!v.valid) throw new Error(`receipt ${state.generationId} did not verify: ${JSON.stringify(v.checks)}`);
  } else step({ id: "e", title: "Generation and signed receipt", status: DRY_RUN ? "dry-run" : "blocked", note: "no receipt yet" });

  // ---- f. Hourly root on trellis_anchor -----------------------------------------------------------------------------------------------
  await ctx.jobs.run("receipt-key-rotation").catch(() => undefined); // records the pinned receipt key as the SignerSet's current signer
  const anchorOnce = async () => { const r = (await ctx.jobs.run("receipts-anchor")) as Json; return r?.anchor as Json | undefined; };
  let anchorResult = DRY_RUN ? undefined : await anchorOnce(); // a dry run sends nothing, not even an empty hour's root
  if (state.generationId) {
    const proofOf = async () => must(await api(`/api/v1/receipts/${encodeURIComponent(state.generationId!)}/proof?v=1`), "GET /api/v1/receipts/:id/proof").data as Json;
    let proof = await proofOf();
    if (!proof.rooted && WAIT_ANCHOR) {
      const nextHour = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
      console.log(`           waiting for the hour boundary at ${new Date(nextHour).toISOString()} (roots close on the hour)…`);
      while (!proof.rooted) {
        await sleep(Math.max(15_000, Math.min(120_000, nextHour + 20_000 - Date.now())));
        anchorResult = await anchorOnce();
        proof = await proofOf();
      }
    }
    if (proof.rooted && MEMO) {
      // Memo mode (the core launch): the root is a memo transaction signed by the anchorer key. It counts once it is
      // finalized; the router's own verifier (the rules the published verifiers apply) checks it against the cluster.
      const path = verifyMerkleProof(proof.leaf, proof.proof, proof.root);
      const anchors = ctx.cfg.launch.anchor;
      let verdict: { ok: boolean; status?: string; reason?: string | null; earliest?: boolean | null } = { ok: false, status: "pending", reason: "the root has not been posted yet" };
      for (let i = 0; i < 12 && proof.tx && !verdict.ok; i++) {
        // A row whose line was sent and is not final yet names its transaction and no line: nothing to verify until the job has confirmed it.
        if (proof.memo) verdict = await verifyRootMemo(conn as never, { signature: proof.tx, network: ctx.cfg.chain.network, hour: proof.hour, count: proof.count, root: proof.root, line: proof.memo, anchorers: anchors.anchorers, v2FromHour: anchors.memoV2FromHour });
        if (!verdict.ok) { await sleep(5_000); await anchorOnce(); proof = await proofOf(); }
      }
      step({ id: "f", title: "Hourly receipt root as a memo transaction (anchorer key)", status: path && verdict.ok ? "done" : "pending", note: `anchor #${proof.anchor_index}, hour ${new Date(proof.hour * 1000).toISOString()}, anchorer ${proof.anchorer}; merkle path ${path ? "valid" : "INVALID"}; memo ${verdict.ok ? `verified on chain (earliest: ${verdict.earliest})` : `not verified yet (${verdict.status}: ${verdict.reason ?? ""})`}`, ...(proof.tx ? { tx: proof.tx, links: { explorer: ex("tx", proof.tx) } } : {}) });
      summary.anchor = { mode: "memo", index: proof.anchor_index, hour: proof.hour, root: proof.root, tx: proof.tx ?? null, merklePathValid: path, memoVerified: verdict.ok, status: verdict.status ?? null };
    } else if (proof.rooted) {
      const path = verifyMerkleProof(proof.leaf, proof.proof, proof.root);
      const hour = receiptRootHour(Math.floor(Date.parse(proof.window.to) / 1000));
      const onchain = await ctx.chain.anchorOnChain(hour);
      const matches = !!onchain && onchain.root.toLowerCase() === String(proof.root).toLowerCase();
      step({ id: "f", title: "Hourly receipt root on trellis_anchor", status: path && matches ? "done" : "pending", note: `anchor #${proof.anchor_index}, hour ${new Date(hour * 1000).toISOString()}, ${proof.leaf_index != null ? `leaf ${proof.leaf_index}` : ""}; Merkle path ${path ? "verifies" : "FAILS"}; on-chain ReceiptRoot ${onchain ? (matches ? "matches" : "DIFFERS") : "not posted yet"}${proof.status !== "confirmed" ? ` (router status ${proof.status})` : ""}`, tx: proof.tx ?? undefined, links: proof.tx ? { explorer: ex("tx", proof.tx) } : {} });
      summary.anchor = { index: proof.anchor_index, hour, root: proof.root, tx: proof.tx, merklePathValid: path, onchainMatches: matches, onchain };
    } else {
      const nextHour = new Date((Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000).toISOString();
      step({ id: "f", title: "Hourly receipt root on trellis_anchor", status: "pending", note: `the receipt is not rooted yet: roots close on the hour, so run again after ${nextHour} (or pass --wait-anchor); anchor job said ${JSON.stringify(anchorResult ?? null)}` });
      summary.anchor = { pending: true, retryAfter: nextHour };
    }
  } else step({ id: "f", title: "Hourly receipt root on trellis_anchor", status: DRY_RUN ? "dry-run" : "blocked", note: `anchor job ran: ${JSON.stringify(anchorResult ?? null)}` });

  // ---- g. Tab: open, voucher, tab-billed call, close through the facilitator -------------------------------------------------------------
  const tabTitle = "Tab: open with a session key, voucher, tab-billed call, close via the facilitator";
  if (CORE) step({ id: "g", title: tabTitle, status: "skipped", note: NOT_IN_CORE });
  else if (DRY_RUN) step({ id: "g", title: tabTitle, status: "dry-run", note: `would open a ${formatUsdc(TAB_CAP_UNITS)} USDC tab to payee ${routerKp.publicKey.toBase58()} and close it through ${BASE}/facilitator/settle` });
  else if (!state.tab && usdc < TAB_CAP_UNITS) step({ id: "g", title: tabTitle, status: "blocked", note: `needs ${formatUsdc(TAB_CAP_UNITS)} USDC in the wallet for the tab cap` });
  else {
    const t: Tab = state.tab ?? { tabId: (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString(), sessionSeedHex: Buffer.from(Keypair.generate().secretKey.subarray(0, 32)).toString("hex") };
    state.tab = t;
    save();
    const session = Keypair.fromSeed(Buffer.from(t.sessionSeedHex, "hex"));
    const network = ctx.cfg.chain.network;
    // open
    if (!t.openSig) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
      const { ix, tab } = openTabInstruction(tabs, { payer: deployer.publicKey, payee: routerKp.publicKey, tabId: BigInt(t.tabId), cap: TAB_CAP_UNITS, expiry, sessionKey: session.publicKey, capUnits: ctx.cfg.solana.caps.tabUnits });
      const sent = await signSendConfirm(conn, new Transaction({ feePayer: deployer.publicKey }).add(ix), [deployer], "confirmed");
      t.pda = tab.toBase58();
      t.openSig = sent.signature;
      save();
      console.log(`           tab ${t.pda} opened (cap ${formatUsdc(TAB_CAP_UNITS)} USDC, session key ${session.publicKey.toBase58()})`);
    }
    const tabPk = new PublicKey(t.pda!);
    // voucher + tab-billed call
    // The voucher is bound to the tab program and to this opening of the tab (Tab.created_at, read from the chain): TR-19.
    const voucher: Voucher = { tab: tabPk, cumulativeUsed: VOUCHER_UNITS, seq: 1n };
    const opened = t.createdAt ? null : await readTab(ctx.chain.connection, tabPk, tabs);
    if (!t.createdAt) {
      if (!opened) throw new Error("the tab is not on chain: run with --reset-tab to open a new one");
      t.createdAt = opened.createdAt.toString();
      save();
    }
    const scope = voucherScope(tabs.programId, { createdAt: BigInt(t.createdAt) });
    const sig = signVoucher(session, voucher, scope);
    if (!t.chatGenerationId) {
      const r = await api("/api/v1/chat/completions", { method: "POST", headers: { [TAB_HEADER]: t.pda!, [TAB_VOUCHER_HEADER]: encodeVoucherHeader(voucherBytes(voucher, scope), sig) }, json: { model: MODEL, messages: [{ role: "user", content: "Reply with the single word: tab." }], usage: { include: true } } });
      must(r, "tab-billed POST /api/v1/chat/completions");
      t.chatGenerationId = r.headers.get("x-receipt-id") ?? r.body.id;
      t.voucherSeq = "1";
      save();
    }
    // close through the facilitator: the payee signs [Ed25519(voucher), close] with the relay as fee payer
    if (!t.closeSig) {
      const onchain = await readTab(ctx.chain.connection, tabPk, tabs);
      if (!onchain) { t.closeSig = "(already closed)"; save(); }
      else {
        const { blockhash, lastValidBlockHeight } = await rpc(() => conn.getLatestBlockhash("confirmed"));
        const closeTx = buildCloseTransaction(tabs, onchain, voucher, sig, { feePayer: relayKp!.publicKey, recentBlockhash: blockhash, lastValidBlockHeight });
        closeTx.partialSign(routerKp);
        const transaction = Buffer.from(closeTx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
        const body = {
          x402Version: 2,
          paymentPayload: { x402Version: 2, accepted: { scheme: "tab", network }, payload: { voucher: wireVoucher(voucher, sig, session.publicKey), transaction } },
          paymentRequirements: { scheme: "tab", network, maxAmountRequired: VOUCHER_UNITS.toString(), resource: `${BASE}/api/v1/chat/completions`, description: "tab close", mimeType: "application/json", payTo: routerKp.publicKey.toBase58(), maxTimeoutSeconds: 60, asset: usdcMint.toBase58(), extra: { feePayer: relayKp!.publicKey.toBase58() } },
        };
        const verify = must(await api("/facilitator/verify", { method: "POST", json: body }), "POST /facilitator/verify");
        if (!verify.isValid) throw new Error(`facilitator refused the close: ${verify.invalidReason}`);
        const settled = must(await api("/facilitator/settle", { method: "POST", json: body }), "POST /facilitator/settle");
        if (!settled.success) throw new Error(`facilitator settle failed: ${settled.errorReason}`);
        t.closeSig = settled.transaction;
        save();
      }
    }
    step({ id: "g", title: tabTitle, status: "done", note: `tab ${t.pda} (cap ${formatUsdc(TAB_CAP_UNITS)} USDC), voucher ${formatUsdc(VOUCHER_UNITS)} USDC seq ${t.voucherSeq}, tab-billed receipt ${t.chatGenerationId}; closed ${t.closeSig}`, links: { open: ex("tx", t.openSig!), tab: ex("address", t.pda!), ...(t.closeSig?.startsWith("(") ? {} : { close: ex("tx", t.closeSig!) }) } });
    summary.tab = { pda: t.pda, openTx: t.openSig, closeTx: t.closeSig, voucherUnits: VOUCHER_UNITS.toString(), receipt: t.chatGenerationId, payee: routerKp.publicKey.toBase58(), sessionKey: session.publicKey.toBase58() };
  }

  // ---- h. Summary -----------------------------------------------------------------------------------------------------------------------
  console.log("\nsummary");
  console.log(`  router        ${BASE}`);
  console.log(`  wallet        ${ex("address", deployer.publicKey.toBase58())}`);
  console.log(`  credits       ${ex("address", ctx.cfg.chain.credits!)}`);
  if (MEMO) console.log(`  anchorer      ${ex("address", ctx.cfg.launch.anchor.anchorer ?? "")} (receipt roots are its memo transactions)`);
  else console.log(`  anchor        ${ex("address", ctx.cfg.chain.receiptAnchor!)}`);
  if (!CORE) console.log(`  tab program   ${ex("address", ctx.cfg.solana.programs.tab!)}`);
  const skipped = steps.filter((s) => s.status === "skipped").map((s) => s.id);
  if (skipped.length) console.log(`  not in core: steps ${skipped.join(", ")}`);
  for (const s of steps) if (s.tx) console.log(`  ${s.id}. ${s.status.padEnd(8)} ${ex("tx", s.tx)}`);
  const blocked = steps.filter((s) => s.status === "blocked").map((s) => s.id);
  const pending = steps.filter((s) => s.status === "pending").map((s) => s.id);
  if (blocked.length) console.log(`  blocked on devnet USDC: steps ${blocked.join(", ")} (see above)`);
  if (pending.length) console.log(`  pending: steps ${pending.join(", ")} (run again later; the state is kept)`);
  console.log(`  state ${STATE_FILE}\n  summary ${SUMMARY_FILE}`);
} catch (e) {
  exitCode = 1;
  console.error(`\nfailed: ${(e as Error).message}`);
  summary.error = (e as Error).message;
} finally {
  await shutdown();
}
