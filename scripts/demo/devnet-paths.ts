// The money paths devnet-demo.ts does not cover, each with real devnet transactions through the router's own code:
//
//   1. x402 `exact` per call      a caller with USDC and no SOL pays one chat call: once with the router's own fee payer
//                                 (the fee payer its 402 names), once through the hosted facilitator (fee payer = the
//                                 relay key) presenting the settled signature; a replay of either payment is refused
//   2. closure refund             close_account signed by the key itself (the router signs it from the bearer secret; a
//                                 wallet only pays the fee), pay_refund by the settlement job after the delay
//   3. host bond, slash, refunds  a throwaway host posts a bond; canary evidence -> slash_evidence -> the slasher proposes,
//                                 the dispute window passes, it executes; refund pool and treasury receive the slash
//   4. host settlement            commit_spent_root, then the weekly payout job once: settle_to_host to a throwaway payout
//                                 address, bounded by committed spend, with sanctions screening on (the bundled list)
//   5. prepaid capacity (Bushels) a bonded host commits capacity; a lot is bought through POST /api/v1/bushels/buy,
//                                 redeemed, spent by a call (the receipt shows prepaid_capacity), and the after-window job
//                                 settles it. A second host fails inside its window: the job reports the shortfall, files
//                                 the claim on its bond, executes it after the dispute window and the buyer gets the price back
//   6. paid tool call             a local x402 seller (scripts/demo/x402-seller.ts) is listed and called through
//                                 POST /api/v1/tools/call; the tool receipt and a model receipt share one trace_id
//   7. $TRLS burn                 test $TRLS is minted into the fee router's vault and burn_inference_payment burns it
//   8. rulebook on chain          a rulebook with a daily maximum on what its owner commits to tabs: a tab within it is
//                                 served and closed, a further tab above it is refused at open_tab, kill_rulebook stops
//                                 new calls and top-ups, and the close for what was vouched before the kill still pays
//
// Not run: pay with a tokenized stock (docs §6) needs a Jupiter route and tokenized-stock liquidity, and devnet has neither.
//
// The slow paths rely on the DEVNET-ONLY parameter set (scripts/devnet/profile.ts: 3-minute refund delay and dispute
// window, 5-minute unbond, 2 USDC minimum bond) and on the devnet build of the programs (scripts/devnet/build.sh), the
// only build whose floors allow it. The script applies the set through the programs' config timelock when the chain
// still carries the spec values and records it in deployments/devnet.json; mainnet keeps the spec values.
//
// Every path is idempotent and resumable: what has been done is kept in <data dir>/paths-state.json (throwaway key
// seeds, signatures, ids) and a re-run picks up where it stopped. A path that is waiting (a window, the hour boundary)
// reports PENDING with the time to run again; without --no-wait the script waits for the short windows itself.
//
//   bun scripts/demo/devnet-paths.ts --dry-run       # router up, preconditions and what each path would send; nothing is spent
//   bun scripts/demo/devnet-paths.ts                 # every path; waits out the short devnet windows (a few minutes each)
//   bun scripts/demo/devnet-paths.ts --only 1,7      # chosen paths
//   bun scripts/demo/devnet-paths.ts --no-wait       # one pass, report what is pending
//   bun scripts/demo/devnet-paths.ts --wait-hour     # also wait for the next hour boundary (host settlement pays closed hours)
//   bun scripts/demo/devnet-paths.ts --redo 1        # forget what one path did and run it afresh (only for a path that
//                                                    # has finished: a bond or tab still in flight is not recovered)
//   bun scripts/demo/devnet-paths.ts --sweep         # afterwards, return what the throwaway keys still hold to the wallet
//   bun scripts/demo/devnet-paths.ts --reset         # forget the saved state (the chain is unchanged)
//
// Needs .env.devnet (bun scripts/demo/make-env.ts) and the deployer wallet with about 0.3 SOL and 8 devnet USDC; all but
// roughly 0.1 USDC stays with the wallet's own accounts (bonds are withdrawn, the closure is refunded, the slash and the
// capacity claim land in the deployer-owned treasury, refund pool and capacity refund accounts).
// DEMO_DATA_DIR=<dir> runs on another data directory than .data/devnet-demo.
import { createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createApp } from "../../src/app.ts";
import { requestHash } from "../../src/api/chat.ts";
import { walletAuthMessage } from "../../src/lib/wallet-sig.ts";
import { base58Encode } from "../../src/solana/constants.ts";
import { canaries, keys as keysTable, ledger, offers, providers, slashes } from "../../src/db/schema.ts";
import { encrypt } from "../../src/lib/util.ts";
import { serveMockProvider } from "../../src/providers/mock.ts";
import { runRegistry } from "../../src/services/registry.ts";
import { runCanaryEvidence } from "../../src/services/canary-evidence.ts";
import { GRADES } from "../../src/services/hvx.ts";
import { payClosureRefunds, postSpentRoot, runPayouts, settleHours } from "../../src/services/settlement.ts";
import { runSlasher } from "../../src/services/slasher.ts";
import { modelGrade, runBushelShortfalls } from "../../src/capacity/bushels.ts";
import { capacityChain } from "../../src/capacity/chain.ts";
import { bushelLots, bushelShortfalls } from "../../src/capacity/schema.ts";
import { isSanctioned, refreshSanctions, sanctionsStatus } from "../../src/network/sanctions.ts";
import { creditClosures } from "../../src/solana/credits-schema.ts";
import { buildPayRefundInstructions, creditsProgram, readCreditsConfig, readRefundRequest } from "../../src/solana/credits.ts";
import { loadSigner } from "../../src/solana/keys.ts";
import { bondEvents, bondLockPda, bondPdas, cancelUnbondIx, decodeBondLock, decodeHostBond, postBondIx, requestUnbondIx, withdrawBondIx } from "../../src/solana/programs/bond.ts";
import { commitCapacityIx, commitmentPda, decodeCapacityCommitment } from "../../src/solana/programs/capacity.ts";
import { creditsPdas, settleToHostIx } from "../../src/solana/programs/credits.ts";
import { burnInferencePaymentIx, decodeFeeConfig, feeRouterPdas } from "../../src/solana/programs/fee-router.ts";
import { createRulebookIx, decodeRulebook, killRulebookIx, rulebookPda } from "../../src/solana/programs/rules.ts";
import { openTabInstruction, readTab, rulebookAccounts, topUpInstruction, signVoucher, tabProgram, voucherBytes, voucherScope, type Voucher } from "../../src/solana/tab.ts";
import { encodeVoucherHeader, readTabUsage, TAB_HEADER, TAB_VOUCHER_HEADER } from "../../src/solana/tab-billing.ts";
import { runTabClose } from "../../src/solana/tab-close.ts";
import { verifyReceipt } from "../../packages/client/src/receipts.ts";
import { PROFILES, applyProfile, describeSeconds } from "../devnet/profile.ts";
import { connect, DATABASE_URL, ENV_FILE, explorer, formatUsdc, loadDevnetEnv, loadKeypair, otherDemoProcess, readJsonFile, rpc, rpcLabel, rpcUrl, secretKeyBase58, signSendConfirm, sleep, solBalance, STATE_DIR, STATE_FILE, tokenUnits, usdcUnits, waitForSignature, writePrivateFile } from "./lib.ts";
import { serveX402Seller } from "./x402-seller.ts";

// ---- Arguments -----------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, d: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY_RUN = flag("dry-run");
const NO_WAIT = flag("no-wait");
const WAIT_HOUR = flag("wait-hour");
const SWEEP = flag("sweep");
const REDO = new Set(option("redo", "").split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 8));
const ONLY = new Set(option("only", "1,2,3,4,5,6,7,8").split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 8));
const PATHS_STATE_FILE = join(STATE_DIR, "paths-state.json");
const PATHS_SUMMARY_FILE = join(STATE_DIR, "paths-summary.json");
if (flag("reset")) { rmSync(PATHS_STATE_FILE, { force: true }); rmSync(PATHS_SUMMARY_FILE, { force: true }); }
/** The longest the script waits for one short devnet window by itself. */
const MAX_SHORT_WAIT_MS = 12 * 60_000;

const STANDIN = { provider: "local-stand-in", model: "meta-llama/llama-3.3-70b-instruct" };
// Stand-in hosts of the walkthrough: local OpenAI-compatible servers, each its own provider row and model, so a path's
// calls, invoices, bond and evidence stay apart. The "8b" in a slug gives the model the small grade (G-S).
const HOSTS = {
  settle: { provider: "devnet-settle-host", name: "Devnet settle host", model: "trellis-demo/settle-probe-8b", prompt: "0.0005", completion: "0.001" },
  screened: { provider: "devnet-screened-host", name: "Devnet screened host", model: "trellis-demo/screened-probe-8b", prompt: "0.0001", completion: "0.0002" },
  slash: { provider: "devnet-slash-host", name: "Devnet slash host", model: "trellis-demo/slash-probe-8b", prompt: "0.00001", completion: "0.00002" },
  capacity: { provider: "devnet-capacity-host", name: "Devnet capacity host", model: "trellis-demo/capacity-probe-8b", prompt: "0.0000002", completion: "0.0000006" },
  shortfall: { provider: "devnet-shortfall-host", name: "Devnet shortfall host", model: "trellis-demo/shortfall-probe-8b", prompt: "0.0000002", completion: "0.0000006" },
} as const;
const SOL = (n: number) => Math.round(n * 1e9);
const HOST_SOL = 0.02;
const BOND_UNITS = usdcUnits("2");

// ---- State ---------------------------------------------------------------------------------------------------------------
type ApiKey = { secret: string; hash: string; chainKeyHash: string };
type State = {
  createdAt: string;
  /** 32-byte seeds (hex) of the walkthrough's throwaway keys, by role. Devnet only; nothing of value is held for long. */
  seeds: Record<string, string>;
  mainKey?: ApiKey & { depositSig?: string };
  sellerPort?: number;
  commitmentId?: string;
  shortfallCommitmentId?: string;
  /** Commitments of earlier (redone) runs of path 5: released before the hosts commit again. */
  pastCommitments?: string[];
  p1?: { fundSig?: string; a?: { header: string; tx: string; generationId: string; amount: string; feePayer: string; replay?: string }; b?: { transaction: string; tx: string; generationId?: string; amount: string; feePayer: string; replay?: string; bare?: string } };
  p2?: { key?: ApiKey; depositSig?: string; generationId?: string; closureId?: string; closeSig?: string; payTx?: string; refundUnits?: string; early?: string; redirect?: string };
  p3?: { fundSig?: string; bondSig?: string; generationId?: string; canaries?: boolean; evidenceRoot?: string; slashId?: string; proposal?: string; proposeTx?: string; windowEnd?: number; executeTx?: string; result?: Record<string, string>; unbondSig?: string; unbondAt?: number; withdrawSig?: string; returnSig?: string };
  p4?: { generationId?: string; screenedGenerationId?: string; callHour?: string; rootTx?: string; rootHour?: string; payoutTx?: string; payoutUnits?: string; boundCheck?: string; screened?: string };
  p5?: { fundSig?: string; bondSig?: string; commitSig?: string; commitment?: string; windowEnd?: number; lot?: string; buyTx?: string; redeemTx?: string; generationId?: string; reportTx?: string; shortfall?: string; unbondSig?: string; unbondAt?: number; withdrawSig?: string; returnSig?: string };
  p5b?: { released?: string; lockedAtCommit?: string; fundSig?: string; bondSig?: string; commitSig?: string; commitment?: string; windowEnd?: number; lot?: string; buyTx?: string; failedCall?: string; reportTx?: string; claimTx?: string; claim?: string; claimWindowEnd?: number; refundUnits?: string; shortfall?: string; executeTx?: string; unbondSig?: string; unbondAt?: number; withdrawSig?: string; returnSig?: string };
  p6?: { fundSig?: string; listing?: string; callId?: string; settleTx?: string; traceId?: string; modelGenerationId?: string };
  p7?: { mintSig?: string; burnSig?: string; units?: string; supplyBefore?: string; supplyAfter?: string };
  p8?: { rulebookId?: string; rulebook?: string; createSig?: string; a?: { tabId: string; pda?: string; openSig?: string; expiry?: number; generationId?: string; closeSig?: string }; overTabId?: string; overSig?: string; overCode?: string; b?: { tabId: string; pda?: string; openSig?: string; expiry?: number; generationId?: string; routerKilled?: string; topUpSig?: string; topUpCode?: string; closeSig?: string }; sessionSeed?: string; killSig?: string };
};
const state = readJsonFile<State>(PATHS_STATE_FILE, { createdAt: new Date().toISOString(), seeds: {} });
state.seeds ??= {};
// --redo: a path's record is dropped, so it runs from the start with fresh ids. Its throwaway keys are kept, except the
// slashed host's: a slash delists its bond for good, so path 3 starts over with a new host and the old key is kept under
// a retired name (still swept by --sweep). The capacity hosts are reused: their bonds are topped up, and the commitments
// the last run left behind are remembered so their bond locks can be released before new ones are made.
const retireSeed = (role: string) => { if (state.seeds[role]) { state.seeds[`${role}:retired:${Date.now()}`] = state.seeds[role]!; delete state.seeds[role]; } };
for (const n of REDO) {
  if (n === 5) state.pastCommitments = [...(state.pastCommitments ?? []), ...[state.p5?.commitment, state.p5b?.commitment].filter((c): c is string => !!c)];
  delete (state as Record<string, unknown>)[`p${n}`];
  if (n === 5) { delete state.p5b; delete state.commitmentId; delete state.shortfallCommitmentId; }
  if (n === 3) retireSeed("slash-host");
}
const save = () => writePrivateFile(PATHS_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
/** A throwaway keypair kept by role in the state file, so a re-run uses the same host, payer and payout address. */
const seedKey = (role: string): Keypair => {
  if (!state.seeds[role]) { state.seeds[role] = Buffer.from(Keypair.generate().secretKey.subarray(0, 32)).toString("hex"); save(); }
  return Keypair.fromSeed(Buffer.from(state.seeds[role], "hex"));
};

type Status = "pass" | "fail" | "pending" | "dry-run" | "blocked";
type Outcome = { status: Status; note: string; txs?: Record<string, string | undefined>; readyAt?: number; hourWait?: boolean; data?: Record<string, unknown> };
const pass = (note: string, txs?: Outcome["txs"], data?: Outcome["data"]): Outcome => ({ status: "pass", note, txs, data });
const pending = (note: string, readyAt: number, txs?: Outcome["txs"], hourWait = false): Outcome => ({ status: "pending", note, readyAt, txs, hourWait });
const dry = (note: string): Outcome => ({ status: "dry-run", note });
class Failed extends Error {}
/** JSON for a message: bigint values (chain amounts, ids) as decimal strings. */
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const check: (cond: unknown, what: string) => asserts cond = (cond, what) => { if (!cond) throw new Failed(what); };

// ---- Environment and wallet ------------------------------------------------------------------------------------------------
if (!existsSync(ENV_FILE)) { console.error(`Missing ${ENV_FILE}: run \`bun scripts/demo/make-env.ts\` first.`); process.exit(2); }
const busy = otherDemoProcess();
if (busy) { console.error(`The demo database under ${STATE_DIR} is open in another process: ${busy}.\nWait for it, or run this one on its own directory: DEMO_DATA_DIR=.data/devnet-paths bun scripts/demo/devnet-paths.ts`); process.exit(3); }
const fileEnv = loadDevnetEnv();
const RPC = rpcUrl(fileEnv);
const conn = connect(RPC, "confirmed");
const deployer = loadKeypair();
const ex = (kind: "tx" | "address", v: string) => explorer(kind, v, fileEnv.EXPLORER_URL);
console.log(`devnet money paths${DRY_RUN ? " (dry run: nothing is spent)" : ""}`);
console.log(`  rpc       ${rpcLabel(RPC)}`);
console.log(`  wallet    ${deployer.publicKey.toBase58()}  ${ex("address", deployer.publicKey.toBase58())}`);
console.log(`  data dir  ${STATE_DIR}`);

// Keys the router needs at start: the tool buyer wallet, and the capacity commitment on offer (its address is known before it exists).
const routerAddress = loadSigner(fileEnv.ROUTER_PRIVATE_KEY).publicKey.toBase58();
const toolsBuyer = seedKey("tools-buyer");
const capacityHost = seedKey("capacity-host");
const shortfallHost = seedKey("shortfall-host");
state.commitmentId ??= (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
state.shortfallCommitmentId ??= (BigInt(Date.now()) * 1000n + 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
save();
const capacityProgramId = new PublicKey(fileEnv.TRELLIS_CAPACITY_PROGRAM_ID);
const commitment = commitmentPda(capacityProgramId, capacityHost.publicKey, BigInt(state.commitmentId));
const shortfallCommitment = commitmentPda(capacityProgramId, shortfallHost.publicKey, BigInt(state.shortfallCommitmentId));

/** A free local port: `preferred` when nothing listens there, else one the OS picks. */
function freePort(preferred: number): number {
  for (const port of [preferred, 0]) {
    try { const s = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") }); const p = s.port ?? port; s.stop(true); return p; } catch { /* busy */ }
  }
  throw new Error("no free local port");
}
const PORT = freePort(Number(fileEnv.PORT ?? 8787));
const BASE = `http://127.0.0.1:${PORT}`;

// ---- The router, in process ---------------------------------------------------------------------------------------------------
const env: Record<string, string> = {
  ...fileEnv,
  DATABASE_URL, PORT: String(PORT), PUBLIC_BASE_URL: BASE,
  WORKERS: "false", HEALTH_PROBES: "false", CANARIES: "false", LOG_LEVEL: process.env.LOG_LEVEL ?? "error",
  // Per-call x402: payments go to the router key's USDC account (the same account tab closes pay).
  X402_PAY_TO: fileEnv.X402_PAY_TO || routerAddress,
  // The router key refuses to sponsor a payment below its SOL floor (0.05 SOL by default, security review round 3). The
  // devnet walkthroughs keep that key at about 0.05 SOL, so the floor is 0.01 SOL here.
  X402_FEE_PAYER_FLOOR_LAMPORTS: fileEnv.X402_FEE_PAYER_FLOOR_LAMPORTS || "10000000",
  // Payout and refund addresses are screened against the list bundled with the tests (test/fixtures/sanctions/sdn.xml,
  // published 2026-09-30); 30 days of age are accepted here so the bundled copy counts as current.
  SANCTIONS_SCREENING_ENABLED: "true", SANCTIONS_MAX_AGE_DAYS: "30",
  BUSHEL_CLAIM_PERIOD_S: "30", // the devnet build's claim period (14 days in the default build)
  BUSHELS_ENABLED: "true", BUSHEL_COMMITMENTS: `${commitment.toBase58()},${shortfallCommitment.toBase58()}`,
  TOOLS_MARKET_ENABLED: "true", TOOLS_TAKE_BPS: "0", TOOLS_BUYER_PRIVATE_KEY: secretKeyBase58(toolsBuyer),
  // The devnet profile's refund delay (3 minutes), for the payable time the close route shows before the chain is read.
  CREDITS_REFUND_DELAY_H: String(Number(PROFILES.devnet.refundDelayS) / 3600),
};
const { app, ctx, close } = await createApp({ env, startJobs: false });
const mocks: { stop(): void }[] = [];
async function standIn(id: string, name: string, model: string, prompt: string, completion: string, extra: Partial<typeof providers.$inferInsert> = {}) {
  const m = serveMockProvider({ name, models: [{ id: model.split("/")[1]!, slug: model, prompt, completion }] }, 0);
  mocks.push(m);
  await ctx.db.insert(providers).values({ id, name, baseUrl: m.url, apiKeyEnc: encrypt(ctx.cfg.appSecret, `${id}-key`), status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true }, ...extra })
    .onConflictDoUpdate({ target: providers.id, set: { baseUrl: m.url, ...extra } }); // status is left alone: a delisted host stays delisted
  return m;
}
const payoutWallet = seedKey("payout");
const slashHost = seedKey("slash-host");
// The Solana address the bundled sanctions list names: a payout to it must be skipped.
const LISTED_ADDRESS = /Digital Currency Address - SOL<\/idType><idNumber>\s*([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(readFileSync(join(import.meta.dir, "../../test/fixtures/sanctions/sdn.xml"), "utf8"))?.[1] ?? "";
await standIn(STANDIN.provider, "Local stand-in", STANDIN.model, "0.0000001", "0.00000032");
await standIn(HOSTS.settle.provider, HOSTS.settle.name, HOSTS.settle.model, HOSTS.settle.prompt, HOSTS.settle.completion, { payoutMode: "usdc", payoutAddress: payoutWallet.publicKey.toBase58() });
await standIn(HOSTS.screened.provider, HOSTS.screened.name, HOSTS.screened.model, HOSTS.screened.prompt, HOSTS.screened.completion, { payoutMode: "usdc", payoutAddress: LISTED_ADDRESS });
await standIn(HOSTS.slash.provider, HOSTS.slash.name, HOSTS.slash.model, HOSTS.slash.prompt, HOSTS.slash.completion, { operator: slashHost.publicKey.toBase58() });
await standIn(HOSTS.capacity.provider, HOSTS.capacity.name, HOSTS.capacity.model, HOSTS.capacity.prompt, HOSTS.capacity.completion, { operator: capacityHost.publicKey.toBase58() });
const shortfallMock = await standIn(HOSTS.shortfall.provider, HOSTS.shortfall.name, HOSTS.shortfall.model, HOSTS.shortfall.prompt, HOSTS.shortfall.completion, { operator: shortfallHost.publicKey.toBase58() });
// A redone path's stand-in host is listed again (the last run's slash delisted it in this router's database).
// (A host this script has not finished slashing yet, state.p3 without a result, is listed too: a redo that stopped early.)
const relist = [...(REDO.has(3) || (state.p3 && !state.p3.result) || !state.p3 ? [HOSTS.slash.provider] : []), ...(REDO.has(5) ? [HOSTS.capacity.provider, HOSTS.shortfall.provider] : [])];
for (const id of relist) {
  await ctx.db.update(providers).set({ status: "live" }).where(eq(providers.id, id));
  await ctx.db.update(offers).set({ status: "live" }).where(and(eq(offers.providerId, id), eq(offers.status, "disabled")));
}
await runRegistry(ctx);
await ctx.catalog.refresh();
const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch, idleTimeout: 255 });
console.log(`  router    ${BASE}  (in this process; stand-in hosts are local, not real inference)`);

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
const must = (r: { status: number; body: Json }, what: string) => { if (r.status >= 300) throw new Failed(`${what}: HTTP ${r.status} ${show(r.body).slice(0, 300)}`); return r.body; };
const CHAT = "/api/v1/chat/completions";
/**
 * X-Wallet-Auth for a JSON POST to `path`: `<address>:<unix seconds>:<signature>` over the router's v2 message (method,
 * the router's host, the path, the time and the request hash: src/lib/wallet-sig.ts, security review TR-20).
 * A bare transaction signature in X-PAYMENT is accepted only with it, signed by the wallet that paid (security review TR-07).
 */
function walletAuth(wallet: Keypair, json: unknown, path: string = CHAT): string {
  const at = Math.floor(Date.now() / 1000);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(wallet.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const message = walletAuthMessage({ method: "POST", host: new URL(ctx.cfg.publicUrl).host, path, timestamp: at, bodySha: requestHash(json as Record<string, unknown>) }); // the router's own hash of a chat request
  const signature = edSign(null, Buffer.from(message), key);
  return `${wallet.publicKey.toBase58()}:${at}:${base58Encode(new Uint8Array(signature))}`;
}
const chatBody = (host: { provider: string; model: string }, content: string, extra: Json = {}) => ({ model: host.model, provider: { only: [host.provider] }, messages: [{ role: "user", content }], max_tokens: 64, usage: { include: true }, stream: false, ...extra });
/** A generation's signed receipt, with its signature checked by packages/client against the router's published keys. */
const receiptOf = async (id: string) => {
  const receipt = must(await api(`/api/v1/receipts/${encodeURIComponent(id)}`), "GET /api/v1/receipts/:id").data as Json;
  const keys = must(await api("/api/v1/receipts/keys"), "GET /api/v1/receipts/keys");
  const v = await verifyReceipt({ id: receipt.id, payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id }, { keys: keys as { keys: import("../../packages/client/src/index.ts").JwkKey[] } });
  check(v.valid, `receipt ${id} carries a valid signature`);
  return receipt;
};

// ---- Chain helpers ---------------------------------------------------------------------------------------------------------
const usdcMint = new PublicKey(ctx.cfg.chain.usdc);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(usdcMint, owner, true);
const credits = creditsProgram(ctx.cfg)!;
const tabs = tabProgram(ctx.cfg)!;
const bondProgramId = new PublicKey(ctx.cfg.solana.programs.bond!);
const rulesProgramId = new PublicKey(ctx.cfg.solana.programs.rules!);
const feeRouterId = new PublicKey(ctx.cfg.solana.programs.feeRouter!);
const routerKp = ctx.chain.signer("router")!;
const relayKp = ctx.chain.signer("facilitator")!;
const chainNow = () => ctx.chain.blockTimestamp();
const blockhash = async () => rpc(() => conn.getLatestBlockhash("confirmed"));

/** Sign with `signers` (the first pays the fee) and wait for `commitment`. */
async function send(ixs: TransactionInstruction[], signers: Keypair[], commitment: "confirmed" | "finalized" = "confirmed"): Promise<string> {
  return (await signSendConfirm(conn, new Transaction({ feePayer: signers[0].publicKey }).add(...ixs), signers, commitment)).signature;
}
const anchorError = (logs: readonly string[] | null | undefined) => { for (const l of logs ?? []) { const m = /Error Code: (\w+)\. Error Number: (\d+)/.exec(l); if (m) return `${m[1]} (${m[2]})`; } return null; };
/** Simulate without sending: the program's error when it would revert, or null. */
async function simulate(ixs: TransactionInstruction[], feePayer: PublicKey): Promise<{ err: unknown; code: string | null }> {
  const { blockhash: recentBlockhash } = await blockhash();
  const sim = await rpc(() => conn.simulateTransaction(new Transaction({ feePayer, recentBlockhash }).add(...ixs)));
  return { err: sim.value.err, code: anchorError(sim.value.logs) };
}
/** Send a transaction that is expected to revert, without preflight, so the failure lands on chain and has an explorer link. */
async function sendExpectingRevert(ixs: TransactionInstruction[], signers: Keypair[]): Promise<{ signature: string; code: string | null }> {
  const { blockhash: recentBlockhash, lastValidBlockHeight } = await blockhash();
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash: recentBlockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const signature = await rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
  let reverted = false;
  try { await waitForSignature(conn, signature, "confirmed", 90_000); } catch (e) { if (/failed on chain/.test((e as Error).message)) reverted = true; else throw e; }
  check(reverted, `transaction ${signature} was expected to revert and did not`);
  const logs = await txLogs(signature);
  return { signature, code: anchorError(logs) };
}
async function txMeta(signature: string) {
  for (let i = 0; i < 10; i++) {
    const t = await rpc(() => conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    if (t) return t;
    await sleep(1_500);
  }
  throw new Failed(`transaction ${signature} could not be read back`);
}
const txLogs = async (signature: string) => (await txMeta(signature)).meta?.logMessages ?? [];
/** Token balance changes of a confirmed transaction, by token account address (base units). */
async function tokenDeltas(signature: string): Promise<Map<string, bigint>> {
  const t = await txMeta(signature);
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }).keySegments().flat();
  const out = new Map<string, bigint>();
  for (const b of t.meta?.postTokenBalances ?? []) out.set(keys[b.accountIndex]!.toBase58(), BigInt(b.uiTokenAmount.amount));
  for (const b of t.meta?.preTokenBalances ?? []) { const k = keys[b.accountIndex]!.toBase58(); out.set(k, (out.get(k) ?? 0n) - BigInt(b.uiTokenAmount.amount)); }
  return out;
}
/** Give a throwaway key SOL and USDC from the wallet when it holds less than asked (its USDC account is created). Returns the signature, or null when nothing was needed. */
async function fund(to: PublicKey, sol: number, units: bigint): Promise<string | null> {
  const ixs: TransactionInstruction[] = [];
  if (sol > 0 && (await solBalance(conn, to)) < sol * 0.6) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to, lamports: SOL(sol) }));
  const exists = !!(await rpc(() => conn.getAccountInfo(ata(to), "confirmed")));
  if (!exists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata(to), to, usdcMint));
  const have = exists ? await tokenUnits(conn, ata(to)) : 0n;
  if (units > have) ixs.push(createTransferCheckedInstruction(ata(deployer.publicKey), usdcMint, ata(to), deployer.publicKey, units - have, 6));
  return ixs.length ? send(ixs, [deployer]) : null;
}
/** Send a throwaway key's whole USDC balance back to the wallet (the wallet pays the fee). */
async function sweepUsdc(from: Keypair): Promise<string | null> {
  const units = await tokenUnits(conn, ata(from.publicKey));
  if (units <= 0n) return null;
  return send([createTransferCheckedInstruction(ata(from.publicKey), usdcMint, ata(deployer.publicKey), from.publicKey, units, 6)], [deployer, from]);
}
const hostBond = async (host: PublicKey) => { const info = await rpc(() => conn.getAccountInfo(bondPdas(bondProgramId, host).bond!, "confirmed")); return info ? decodeHostBond(new Uint8Array(info.data)) : null; };
/**
 * A usable bond of BOND_UNITS for a throwaway host: posted when there is none; topped up, with a pending unbond request
 * cancelled, when an earlier run of the path slashed it or withdrew it.
 */
async function ensureBond(host: Keypair): Promise<string> {
  const bond = await hostBond(host.publicKey);
  if (!bond) return postBond(host);
  const ixs: TransactionInstruction[] = [];
  if (bond.unbondAt !== 0n) ixs.push(cancelUnbondIx(bondProgramId, { host: host.publicKey }));
  if (bond.amount < BOND_UNITS) {
    await fund(host.publicKey, HOST_SOL, BOND_UNITS - bond.amount);
    ixs.push(postBondIx(bondProgramId, { host: host.publicKey, hostToken: ata(host.publicKey), mint: usdcMint, amount: BOND_UNITS - bond.amount }));
  }
  return ixs.length ? send(ixs, [deployer, host]) : "(already posted)";
}
/**
 * Commitments an earlier, redone run left for this host still lock its bond (security review TR-11). Anyone may settle
 * them with release_commitment once their window and the claim period have passed. Null when the lock is free, else
 * when to try again.
 */
async function freeBondLock(host: Keypair): Promise<number | null> {
  const chain = capacityChain(ctx);
  for (const address of state.pastCommitments ?? []) {
    const c = await chain.commitment(address);
    if (!c || !c.host.equals(host.publicKey) || c.status === "Settled") continue;
    try { await chain.releaseCommitment!({ commitment: c }); } catch { return Date.now() + 20_000; }
  }
  return null;
}
/** post_bond of BOND_UNITS by a throwaway host (it pays the rent of its bond accounts; the wallet pays the fee). */
async function postBond(host: Keypair): Promise<string> {
  return send([postBondIx(bondProgramId, { host: host.publicKey, hostToken: ata(host.publicKey), mint: usdcMint, amount: BOND_UNITS })], [deployer, host]);
}
/** request_unbond, wait out the unbond period, withdraw_bond, and send the USDC back to the wallet. Resumable through `s`. */
async function unbondAndReturn(host: Keypair, s: { unbondSig?: string; unbondAt?: number; withdrawSig?: string; returnSig?: string }): Promise<{ done: boolean; readyAt?: number }> {
  if (s.returnSig) return { done: true };
  const bond = await hostBond(host.publicKey);
  if (!s.withdrawSig && bond && bond.amount > 0n) {
    if (bond.unbondAt === 0n) { s.unbondSig = await send([requestUnbondIx(bondProgramId, { host: host.publicKey })], [deployer, host]); save(); }
    const after = await hostBond(host.publicKey);
    s.unbondAt = Number(after!.unbondAt);
    save();
    const now = await chainNow();
    if (now < s.unbondAt + 2) return { done: false, readyAt: Date.now() + (s.unbondAt + 3 - now) * 1000 };
    s.withdrawSig = await send([withdrawBondIx(bondProgramId, { host: host.publicKey, hostToken: ata(host.publicKey), mint: usdcMint })], [deployer, host]);
    save();
  }
  s.returnSig = (await sweepUsdc(host)) ?? "(nothing to return)";
  save();
  return { done: true };
}
async function ensureKey(name: string): Promise<ApiKey> {
  const r = must(await api("/api/v1/keys", { method: "POST", json: { name } }), "POST /api/v1/keys");
  return { secret: r.key, hash: r.data.hash, chainKeyHash: r.data.chain_key_hash ?? r.data.hash };
}
/** Deposit through POST /api/v1/credits/deposit-tx signed by the wallet, wait for finality and for the indexer to credit it. */
async function deposit(key: ApiKey, units: bigint): Promise<string> {
  const r = must(await api("/api/v1/credits/deposit-tx", { method: "POST", auth: key.secret, json: { amount: formatUsdc(units), payer: deployer.publicKey.toBase58() } }), "POST /api/v1/credits/deposit-tx");
  const tx = Transaction.from(Buffer.from(r.data.transaction, "base64"));
  tx.lastValidBlockHeight = r.data.expires_at_block_height;
  return (await signSendConfirm(conn, tx, [deployer], "finalized")).signature;
}
async function credited(key: ApiKey): Promise<number> {
  for (let i = 0; i < 12; i++) {
    await ctx.jobs.run("chain-indexer");
    const balance = Number(must(await api("/api/v1/credits", { auth: key.secret }), "GET /api/v1/credits").data.balance ?? 0);
    if (balance > 0) return balance;
    await sleep(5_000);
  }
  throw new Failed("the deposit is finalized but the indexer has not credited it; run again");
}
/** The x402 `exact` transaction a payer signs: one USDC TransferChecked to payTo's account, fee payer = `feePayer`. Base64, payer's signature only. */
async function exactPayment(payer: Keypair, payTo: string, feePayer: string, amount: bigint): Promise<string> {
  const { blockhash: recentBlockhash } = await blockhash();
  const tx = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash });
  tx.add(createTransferCheckedInstruction(ata(payer.publicKey), usdcMint, ata(new PublicKey(payTo)), payer.publicKey, amount, 6));
  tx.partialSign(payer);
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}
const nextHourMs = () => (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000 + 25_000;
const hourOfIso = (d: Date) => d.toISOString().slice(0, 13);

// ---- 1. x402 `exact` per call ---------------------------------------------------------------------------------------------------
async function path1(): Promise<Outcome> {
  const s = (state.p1 ??= {});
  const payer = seedKey("x402-payer");
  const body = chatBody(STANDIN, "In one short sentence, what does HTTP 402 mean?");
  const quote = async () => {
    const q = await api(CHAT, { method: "POST", json: body });
    check(q.status === 402 && Array.isArray(q.body.accepts), `an unpaid call without a key should answer 402 with x402 accepts, got ${q.status}`);
    return q.body.accepts[0] as Json;
  };
  const first = await quote();
  check(first.extra?.feePayer === routerKp.publicKey.toBase58(), "the router's 402 names its own fee payer");
  const supported = must(await api("/facilitator/supported"), "GET /facilitator/supported");
  const relay = (supported.kinds as Json[]).find((k) => k.scheme === "exact")?.extra?.feePayer as string | undefined;
  check(relay === relayKp.publicKey.toBase58(), "the hosted facilitator names its relay key as fee payer");
  if (DRY_RUN) return dry(`quote ${first.maxAmountRequired} USDC units to ${first.payTo}; would fund payer ${payer.publicKey.toBase58()} with 0.1 USDC and no SOL, pay once with the router's fee payer ${first.extra.feePayer} and once through the hosted facilitator (relay ${relay}), then replay both`);
  // 0.1 USDC: no quote is below the minimum payment (0.03 USDC by default), and this path pays twice.
  if (!s.a || !s.b) { const sig = await fund(payer.publicKey, 0, usdcUnits("0.1")); if (sig) { s.fundSig = sig; save(); } } // only while a payment is still to be made
  check((await rpc(() => conn.getBalance(payer.publicKey, "confirmed"))) === 0, "the paying wallet holds no SOL: it cannot pay a fee itself");
  const payerUsdcBefore = await tokenUnits(conn, ata(payer.publicKey));
  const paidNow: bigint[] = [];
  let madeA = false, madeB = false;

  // a. The standard x402 exchange: the 402's own fee payer (the router key) co-signs and submits.
  if (!s.a) {
    const accept = await quote();
    const amount = BigInt(accept.maxAmountRequired);
    const transaction = await exactPayment(payer, accept.payTo, accept.extra.feePayer, amount);
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: accept.network, payload: { transaction } })).toString("base64");
    const r = await api(CHAT, { method: "POST", headers: { "x-payment": header }, json: body });
    must(r, "paid POST /api/v1/chat/completions (x402 exact)");
    const settled = JSON.parse(Buffer.from(r.headers.get("x-payment-response") ?? "", "base64").toString("utf8") || "{}") as Json;
    check(settled.success === true && typeof settled.transaction === "string", "the served call carries the settlement in X-PAYMENT-RESPONSE");
    s.a = { header, tx: settled.transaction, generationId: r.headers.get("x-receipt-id") ?? r.body.id, amount: amount.toString(), feePayer: accept.extra.feePayer };
    save();
    paidNow.push(amount);
    madeA = true;
  }
  // b. Through the hosted facilitator: the relay key is the fee payer, the caller presents the settled signature.
  if (!s.b) {
    const accept = await quote();
    const minSettle = ctx.cfg.facilitator.minSettle;
    const amount = BigInt(accept.maxAmountRequired) > minSettle ? BigInt(accept.maxAmountRequired) : minSettle;
    const transaction = await exactPayment(payer, accept.payTo, relay!, amount);
    const request = { x402Version: 1, paymentPayload: { x402Version: 1, scheme: "exact", network: accept.network, payload: { transaction } }, paymentRequirements: { ...accept, maxAmountRequired: amount.toString(), extra: { feePayer: relay, decimals: 6 } } };
    const verified = must(await api("/facilitator/verify", { method: "POST", json: request }), "POST /facilitator/verify");
    check(verified.isValid === true, `the facilitator refused the payment: ${verified.invalidReason}`);
    const settled = must(await api("/facilitator/settle", { method: "POST", json: request }), "POST /facilitator/settle");
    check(settled.success === true, `the facilitator did not settle: ${settled.errorReason}`);
    s.b = { transaction, tx: settled.transaction, amount: amount.toString(), feePayer: relay! };
    save();
    paidNow.push(amount);
    madeB = true;
  }
  if (!s.b.generationId) {
    // The router reads the transfer at finalized before it credits it: wait for that, then present the signature.
    await waitForSignature(conn, s.b.tx, "finalized");
    // TR-07: the signature of a landed payment is public, so on its own it buys nothing: whoever presents it must also
    // be the wallet that paid (X-Wallet-Auth over this request).
    if (!s.b.bare) {
      const bare = await api(CHAT, { method: "POST", headers: { "x-payment": s.b.tx }, json: body });
      check(bare.status === 401 && bare.body.error?.type === "payment_not_bound_to_caller", `a bare payment signature should be refused, got ${bare.status} ${bare.body.error?.type}`);
      s.b.bare = bare.body.error.type;
      save();
    }
    const present = () => api(CHAT, { method: "POST", headers: { "x-payment": s.b!.tx, "x-wallet-auth": walletAuth(payer, body) }, json: body });
    let r = await present();
    for (let i = 0; i < 10 && r.status === 402 && r.body.error?.type === "payment_pending"; i++) { await sleep(4_000); r = await present(); }
    must(r, "POST /api/v1/chat/completions with the settled signature");
    s.b.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
  }
  // Receipts: per-call mode, the payment transaction, the payer.
  for (const [label, p] of [["router fee payer", s.a], ["hosted facilitator", s.b]] as const) {
    const receipt = await receiptOf(p.generationId!);
    check(receipt.payload.mode === "per_call" && receipt.payload.paid_with === "x402" && receipt.payload.payment_tx === p.tx && receipt.payload.payer === payer.publicKey.toBase58(), `${label}: the receipt is per_call, paid_with x402, and names the payment transaction and the payer (got paid_with ${receipt.payload.paid_with})`);
    const fee = (await txMeta(p.tx)).transaction.message.getAccountKeys().get(0)!.toBase58();
    check(fee === p.feePayer, `${label}: the transaction's fee payer is ${p.feePayer}`);
  }
  // Replays: the same payment again buys nothing and moves nothing. Presented right after it was redeemed, a payment is
  // refused as already claimed (kept in the state). On a later run of this script the x402 payload's blockhash has
  // expired as well, which the router checks first, so for a payment made in an earlier run either refusal counts.
  const refusedReplay = async (label: string, p: { replay?: string }, header: string, madeNow: boolean, signed = false) => {
    // X-Wallet-Auth is single use and carries a time in seconds: signed in the same second as the request that redeemed
    // the payment, the header itself would be the replay (401). A fresh second makes it a new header, so what is
    // refused here is the payment.
    if (signed) await sleep(1_100);
    const r = await api(CHAT, { method: "POST", headers: { "x-payment": header, ...(signed ? { "x-wallet-auth": walletAuth(payer, body) } : {}) }, json: body });
    const reason = String(r.body.payment_error ?? r.body.error?.type ?? "");
    check(r.status === 402 && (reason === "payment_already_claimed" || (!madeNow && /blockhash_expired/.test(reason))), `replaying ${label} should be refused as payment_already_claimed, got ${r.status} ${reason}`);
    if (!p.replay || reason === "payment_already_claimed") { p.replay = reason; save(); }
  };
  await refusedReplay("the x402 payment", s.a, s.a.header, madeA);
  await refusedReplay("the settled signature", s.b, s.b.tx, madeB, true); // presented by the payer itself: still spent once
  const again = await api("/facilitator/settle", { method: "POST", json: { x402Version: 1, paymentPayload: { x402Version: 1, scheme: "exact", network: ctx.cfg.chain.network, payload: { transaction: s.b.transaction } }, paymentRequirements: { scheme: "exact", network: ctx.cfg.chain.network, maxAmountRequired: s.b.amount, resource: `${BASE}${CHAT}`, description: "replay", mimeType: "application/json", payTo: ctx.cfg.x402.payTo, maxTimeoutSeconds: 60, asset: usdcMint.toBase58(), extra: { feePayer: relay, decimals: 6 } } } });
  // A settled payment is answered with the settlement it already made; a blockhash that has expired since is refused outright. Neither moves funds.
  check((again.status === 200 && again.body.transaction === s.b.tx) || again.body.success === false, "the facilitator does not settle the same payment twice");
  const payerUsdcAfter = await tokenUnits(conn, ata(payer.publicKey));
  check(payerUsdcBefore - payerUsdcAfter === paidNow.reduce((a, b) => a + b, 0n), `the payer's USDC fell by exactly what it paid in this run (${formatUsdc(payerUsdcBefore - payerUsdcAfter)} USDC), replays included`);
  for (const p of [s.a, s.b]) {
    const rows = await ctx.db.select().from(ledger).where(and(eq(ledger.accountId, `w_${payer.publicKey.toBase58()}`), eq(ledger.ref, `x402:${p.tx}`)));
    check(rows.length === 1 && rows[0]!.kind === "percall", `the payer's wallet account was credited once for payment ${p.tx.slice(0, 8)}… (${rows.length} credits)`);
  }
  return pass(`payer ${payer.publicKey.toBase58()} (0 SOL) paid ${formatUsdc(BigInt(s.a.amount))} USDC with the router as fee payer and ${formatUsdc(BigInt(s.b.amount))} USDC through the hosted facilitator (relay ${s.b.feePayer}); receipts ${s.a.generationId} and ${s.b.generationId} are per_call with payment_tx set (paid_with: x402); replays were refused (402 ${s.a.replay} for the x402 payload, 402 ${s.b.replay} for the settled signature) and moved nothing`, { "exact, router fee payer": s.a.tx, "exact, hosted facilitator": s.b.tx });
}

// ---- 2. Closure refund ---------------------------------------------------------------------------------------------------------
async function path2(): Promise<Outcome> {
  const s = (state.p2 ??= {});
  const DEPOSIT = usdcUnits("1"); // the program's smallest deposit (MIN_DEPOSIT, security review round 3)
  const cfg = await readCreditsConfig(ctx.chain.connection, credits);
  check(cfg, "trellis_credits is initialised");
  if (DRY_RUN) return dry(`refund delay on chain ${describeSeconds(cfg.refundDelay)}; would create a key, deposit ${formatUsdc(DEPOSIT)} USDC, make one call, have the router sign close_account as the key (the bearer secret is the only thing that can close it), pay its fee from the wallet and let the settlement job pay_refund after the delay`);
  if (!s.key) { s.key = await ensureKey("devnet-paths-closure"); save(); }
  if (!s.depositSig) { s.depositSig = await deposit(s.key, DEPOSIT); save(); }
  if (!s.generationId) {
    await credited(s.key);
    const r = await api(CHAT, { method: "POST", auth: s.key.secret, json: chatBody(STANDIN, "Reply with the single word: closing.") });
    must(r, "POST /api/v1/chat/completions (closure key)");
    s.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
  }
  const refundTo = ata(deployer.publicKey);
  if (!s.closeSig) {
    // The key cannot say where the refund goes (security re-review RR-05): a request that names a destination is refused.
    const thief = Keypair.generate().publicKey;
    const redirect = await api("/api/v1/credits/close", { method: "POST", auth: s.key.secret, json: { refund_to: thief.toBase58(), payer: deployer.publicKey.toBase58() } });
    check(redirect.status === 400 && redirect.body?.error?.type === "refund_destination_fixed", `a closure that names its own refund_to is refused (${redirect.status} ${redirect.body?.error?.type ?? ""})`);
    const r = must(await api("/api/v1/credits/close", { method: "POST", auth: s.key.secret, json: { payer: deployer.publicKey.toBase58() } }), "POST /api/v1/credits/close");
    const named = (r.data.refunds as Json[] | undefined) ?? [];
    check(named.length === 1 && named[0].depositor === deployer.publicKey.toBase58() && named[0].refund_to === refundTo.toBase58(), `the closure names the wallet that funded the key as the only refund destination (${show(named)})`);
    s.closureId = r.data.id;
    save();
    if (r.data.transaction) {
      const tx = Transaction.from(Buffer.from(r.data.transaction, "base64"));
      tx.lastValidBlockHeight = r.data.expires_at_block_height;
      s.closeSig = (await signSendConfirm(conn, tx, [deployer], "confirmed")).signature; // already signed by the key (the router did, from the bearer secret); this wallet only pays the fee
    } else s.closeSig = "(already registered)";
    save();
  }
  const request = await readRefundRequest(ctx.chain.connection, credits, s.key.chainKeyHash);
  check(request, "the RefundRequest exists on chain after close_account");
  const payableAt = Number(request.payableAt);
  if (!s.payTx) {
    const now = await chainNow();
    if (now < payableAt + 2) {
      // Before the delay the program refuses the refund, whoever asks.
      if (!s.early) {
        const early = await simulate(buildPayRefundInstructions(credits, { settlement: deployer.publicKey, chainKeyHash: s.key.chainKeyHash, depositor: deployer.publicKey, refundToToken: refundTo, amount: 1n }), deployer.publicKey);
        s.early = early.code ?? String(show(early.err));
        save();
      }
      const job = (await payClosureRefunds(ctx)) as Json;
      const mine = (job.closures as Json[] | undefined)?.find((c) => c.id === s.closureId);
      return pending(`close_account landed; the settlement job answers ${show(mine ?? job)} and pay_refund simulated now reverts with ${s.early}; payable at ${new Date(payableAt * 1000).toISOString()}`, Date.now() + (payableAt + 4 - now) * 1000, { close_account: s.closeSig });
    }
    // Even the settlement key cannot pay the depositor's USDC to another account: the program pins the destination to the
    // one the depositor named.
    if (!s.redirect) {
      const elsewhere = ata(slashHost.publicKey);
      const attempt = await simulate(buildPayRefundInstructions(credits, { settlement: deployer.publicKey, chainKeyHash: s.key.chainKeyHash, depositor: deployer.publicKey, refundToToken: elsewhere, amount: 1n }), deployer.publicKey);
      s.redirect = attempt.code ?? String(show(attempt.err));
      save();
    }
    const job = (await payClosureRefunds(ctx)) as Json;
    const mine = (job.closures as Json[] | undefined)?.find((c) => c.id === s.closureId);
    const [row] = await ctx.db.select().from(creditClosures).where(eq(creditClosures.id, s.closureId!));
    check(row?.status === "paid" && row.payTx, `the settlement job paid the closure (job said ${show(mine ?? job)})`);
    s.payTx = row.payTx;
    s.refundUnits = (row.amount ?? 0n).toString();
    save();
  }
  const deltas = await tokenDeltas(s.payTx);
  const refund = BigInt(s.refundUnits ?? "0");
  check(deltas.get(refundTo.toBase58()) === refund && deltas.get(creditsPdas(credits.programId).vault.toBase58()) === -refund, `pay_refund moved ${formatUsdc(refund)} USDC from the vault to the refund account`);
  const after = await readRefundRequest(ctx.chain.connection, credits, s.key.chainKeyHash);
  // pay_refund is cumulative and bounded by the request (the key's gross on-chain balance). The refund is what the key had
  // not spent, so the request records it as paid_amount; it is `paid` in full only for a key that spent nothing.
  check(after && after.paidAmount === refund && after.paid === (refund === after.amount), `the RefundRequest records ${formatUsdc(refund)} USDC paid of the ${formatUsdc(after?.amount ?? 0n)} requested`);
  check(refund < DEPOSIT && refund > DEPOSIT - 1_000n, `the refund is the deposit minus what the key spent (${formatUsdc(DEPOSIT - refund)} USDC stays in the vault for host settlement)`);
  // One refund was paid for the key, and it is this closure. (A database written before the indexer fix can hold a second
  // row for the same on-chain closure, registered when its event was indexed after the payment; the settlement job
  // closes it from the chain's RefundRequest without paying anything.)
  const closures = async () => must(await api("/api/v1/credits/close", { auth: s.key!.secret }), "GET /api/v1/credits/close").data as Json[];
  if ((await closures()).some((c) => c.status === "queued" || c.status === "registered")) await payClosureRefunds(ctx);
  const shown = await closures();
  const withPayment = shown.filter((c) => c.pay_tx);
  check(withPayment.length === 1 && withPayment[0].id === s.closureId && withPayment[0].pay_tx === s.payTx && shown.every((c) => c.status === "paid"), `GET /api/v1/credits/close shows the closure paid, once (${show(shown.map((c) => [c.id, c.status, !!c.pay_tx]))})`);
  return pass(`key ${s.key.hash.slice(0, 12)}… deposited ${formatUsdc(DEPOSIT)} USDC, spent ${formatUsdc(DEPOSIT - refund)}, closed with the key's own signature (it could name no destination: the refund is bound to the wallet that deposited; paying it elsewhere simulates as ${s.redirect ?? "not sampled"}); refused before the delay (${s.early ?? "not sampled"}), then ${formatUsdc(refund)} USDC refunded after ${describeSeconds(cfg.refundDelay)}`, { deposit: s.depositSig, close_account: s.closeSig, pay_refund: s.payTx });
}

// ---- 3. Host bond, slash, refund pool ---------------------------------------------------------------------------------------------
async function path3(mainKey: ApiKey | null): Promise<Outcome> {
  const s = (state.p3 ??= {});
  const host = slashHost;
  const bondCfg = await ctx.chain.bondConfig();
  check(bondCfg, "trellis_bond is initialised");
  if (DRY_RUN) return dry(`min bond on chain ${formatUsdc(bondCfg.minBond)} USDC, dispute window ${describeSeconds(bondCfg.disputeWindow)}, unbond ${describeSeconds(bondCfg.unbondPeriod)}; would bond ${formatUsdc(BOND_UNITS)} USDC for throwaway host ${host.publicKey.toBase58()}, file canary evidence, let the slasher propose 25% and execute after the window, then unbond the rest`);
  check(bondCfg.minBond <= BOND_UNITS, `the minimum bond (${formatUsdc(bondCfg.minBond)} USDC) is above the walkthrough's ${formatUsdc(BOND_UNITS)} USDC: apply the devnet profile`);
  check(mainKey, "a funded API key");
  if (!s.fundSig) { s.fundSig = (await fund(host.publicKey, HOST_SOL, BOND_UNITS)) ?? "(already funded)"; save(); }
  if (!s.bondSig) { s.bondSig = await ensureBond(host); save(); }
  // The fault: three canaries in a row whose logprob fingerprint does not match the declared quantization (docs §5.3).
  // The walkthrough writes those three observations itself (the stand-in host is honest and no canary run would produce
  // them); from there on the router's own jobs act: canary-evidence -> slash_evidence -> the slasher.
  if (!s.canaries) {
    const t0 = Date.now();
    const observation = (ts: Date) => ({ modelId: HOSTS.slash.model, providerId: HOSTS.slash.provider, ts, quantMatch: false, quantGuess: "int4", distance: 0.41, quality: null, detail: { declared: "bf16", source: "devnet walkthrough: seeded observation, not a canary run" } });
    await ctx.db.insert(canaries).values([observation(new Date(t0 - 120_000)), observation(new Date(t0 - 60_000))]);
    // A paying caller served inside the evidence window: what it paid is the refund share of the slash.
    const r = await api(CHAT, { method: "POST", auth: mainKey.secret, json: chatBody(HOSTS.slash, "What is 17 * 23? Reply with only the number.") });
    must(r, "POST /api/v1/chat/completions (slash host)");
    s.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    await ctx.db.insert(canaries).values(observation(new Date()));
    s.canaries = true;
    save();
  }
  if (!s.proposeTx) {
    const ev = await runCanaryEvidence(ctx);
    const written = ev.written.find((w) => w.provider === HOSTS.slash.provider);
    if (written) s.evidenceRoot = written.evidence_root;
    const out = (await runSlasher(ctx)) as Json;
    const mine = (out.proposed as Json[]).find((p) => p.provider === HOSTS.slash.provider);
    const [row] = await ctx.db.select().from(slashes).where(eq(slashes.providerId, HOSTS.slash.provider)).orderBy(desc(slashes.proposedAt)).limit(1); // the newest: a redone path leaves the last run's row behind
    check(row?.onchainId && row.txHash && row.status !== "executed", `the slasher filed the proposal on chain (slasher said ${show(mine ?? out).slice(0, 300)})`);
    s.slashId = row.id; s.proposal = row.onchainId; s.proposeTx = row.txHash; s.evidenceRoot ??= row.evidenceRoot;
    // A run resumed after the window may execute in this same pass of the slasher.
    const ran = (out.executed as Json[]).find((e) => e.id === row.id)?.chain?.hash;
    if (ran) s.executeTx = ran;
    s.windowEnd = Math.floor(row.executableAt.getTime() / 1000);
    save();
  }
  const refundPool = bondCfg.refundPool.toBase58(), treasury = bondCfg.treasury.toBase58();
  if (!s.executeTx) {
    const now = await chainNow();
    if (now < s.windowEnd! + 2) return pending(`proposal ${s.proposal} is open (25% of the bond, evidence root ${s.evidenceRoot!.slice(0, 18)}…); the dispute window ends ${new Date(s.windowEnd! * 1000).toISOString()}`, Date.now() + (s.windowEnd! + 4 - now) * 1000, { post_bond: s.bondSig, propose_slash: s.proposeTx });
    const out = (await runSlasher(ctx)) as Json;
    // The execute_slash this pass sent; or, when an earlier pass already did, the proposal account's last transaction
    // (the router keeps the proposal's signature on the slash row, not the execution's).
    const mine = (out.executed as Json[]).find((e) => e.id === s.slashId)?.chain?.hash ?? ((await ctx.chain.slashOnChain(s.proposal!))?.executed ? (await rpc(() => conn.getSignaturesForAddress(new PublicKey(s.proposal!), { limit: 5 }, "confirmed"))).find((x) => !x.err)?.signature : undefined);
    check(mine, `the slasher executed the proposal (slasher said ${show(out.executed).slice(0, 300)})`);
    s.executeTx = mine;
    save();
  }
  // What the program did with the slash, from the transaction itself.
  const executed = bondEvents(bondProgramId, await txLogs(s.executeTx!)).find((e) => e.event === "SlashExecuted")?.args as Json | undefined;
  check(executed, "the execute transaction carries SlashExecuted");
  const deltas = await tokenDeltas(s.executeTx!);
  const slashed = BigInt(executed.amount), toPool = BigInt(executed.toRefundPool), toTreasury = BigInt(executed.toTreasury);
  check(slashed === (BOND_UNITS * 2_500n) / 10_000n, `25% of the bond was slashed (${formatUsdc(slashed)} USDC)`);
  check(toPool > 0n && deltas.get(refundPool) === toPool, `the refund pool received the affected caller's share (${toPool} units)`);
  check(deltas.get(treasury) === toTreasury && toPool + toTreasury === slashed, `the treasury received the rest (${formatUsdc(toTreasury)} USDC)`);
  const bond = await hostBond(host.publicKey);
  const [slashRow] = await ctx.db.select().from(slashes).where(eq(slashes.id, s.slashId!));
  const [after] = await ctx.db.select().from(providers).where(eq(providers.id, HOSTS.slash.provider));
  check(slashRow.status === "executed" && slashRow.refunded > 0n, "the router marked the slash executed and refunded the caller on the ledger");
  check(after.status === "delisted" && (!bond || bond.delisted), "the host is delisted at the router and on chain");
  s.result = { slashed: slashed.toString(), toRefundPool: toPool.toString(), toTreasury: toTreasury.toString() };
  save();
  const txs = { post_bond: s.bondSig, propose_slash: s.proposeTx, execute_slash: s.executeTx, request_unbond: s.unbondSig, withdraw_bond: s.withdrawSig };
  const back = await unbondAndReturn(host, s);
  const note = `host ${host.publicKey.toBase58()} bonded ${formatUsdc(BOND_UNITS)} USDC; canary evidence -> slash_evidence -> proposal ${s.proposal}; executed after the window: ${formatUsdc(slashed)} USDC slashed, ${toPool} units to the refund pool ${refundPool}, ${formatUsdc(toTreasury)} USDC to the treasury ${treasury}; caller refunded on the ledger; host delisted`;
  if (!back.done) return pending(`${note}. Slash done; the remaining bond unbonds at ${new Date(s.unbondAt! * 1000).toISOString()}`, back.readyAt!, { ...txs, request_unbond: s.unbondSig });
  return pass(`${note}; the remaining bond was withdrawn and returned`, { ...txs, request_unbond: s.unbondSig, withdraw_bond: s.withdrawSig });
}

// ---- 4. Host settlement -----------------------------------------------------------------------------------------------------------
async function path4(mainKey: ApiKey | null): Promise<Outcome> {
  const s = (state.p4 ??= {});
  const payoutAta = ata(payoutWallet.publicKey);
  const list = await sanctionsStatus(ctx);
  if (DRY_RUN) return dry(`sanctions list ${list.list_date ?? "not loaded"} (${list.entry_count} addresses, stale: ${list.stale}); would make one call on ${HOSTS.settle.provider} and one on ${HOSTS.screened.provider}, close the hour, commit_spent_root and run the payout job: settle_to_host to ${payoutWallet.publicKey.toBase58()}, skipping the listed address ${LISTED_ADDRESS}`);
  check(mainKey, "a funded API key");
  check(!list.stale && (await isSanctioned(ctx, LISTED_ADDRESS)) && !(await isSanctioned(ctx, payoutWallet.publicKey.toBase58())), "sanctions screening is on with the bundled list: the listed address matches, the payout address does not");
  if (!s.generationId) {
    const r = await api(CHAT, { method: "POST", auth: mainKey.secret, json: chatBody(HOSTS.settle, "Name the capital of Australia in one word.") });
    must(r, "POST /api/v1/chat/completions (settle host)");
    s.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    const r2 = await api(CHAT, { method: "POST", auth: mainKey.secret, json: chatBody(HOSTS.screened, "Name the capital of Australia in one word.") });
    must(r2, "POST /api/v1/chat/completions (screened host)");
    s.screenedGenerationId = r2.headers.get("x-receipt-id") ?? r2.body.id;
    s.callHour = hourOfIso(new Date());
    save();
  }
  // Invoices exist for closed hours only; the spent root is committed at most once an hour.
  const hours = await settleHours(ctx);
  const root = (await postSpentRoot(ctx)) as Json;
  if (root.posted && root.tx) { s.rootTx = root.tx; s.rootHour = root.hour; save(); }
  const onchain = await ctx.chain.creditsConfigOnChain();
  check(onchain, "trellis_credits config");
  const available = onchain.spentTotal - onchain.settledTotal;
  // The bound: one unit more than committed spend allows is refused by the program.
  if (onchain.latestHour > 0n) {
    const over = await simulate([createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, payoutAta, payoutWallet.publicKey, usdcMint), settleToHostIx(credits.programId, { settlement: deployer.publicKey, hour: onchain.latestHour, amount: available + 1n, hostToken: payoutAta, mint: usdcMint })], deployer.publicKey);
    s.boundCheck = over.code ?? show(over.err);
    save();
  }
  if (!s.payoutTx) {
    if (s.callHour === hourOfIso(new Date())) return pending(`calls made (${s.generationId}); spent root ${s.rootTx ? `committed for hour ${s.rootHour}` : `not committed in this pass (${root.reason ?? "see above"})`}; committed spend ${formatUsdc(onchain.spentTotal)} USDC, settled ${formatUsdc(onchain.settledTotal)}. The host's invoice closes with the hour: run again after ${new Date(nextHourMs()).toISOString()} (or pass --wait-hour)`, nextHourMs(), { commit_spent_root: s.rootTx }, true);
    const out = (await runPayouts(ctx, 0)) as Json;
    const mine = (out.payouts as Json[]).find((p) => p.provider === HOSTS.settle.provider);
    const screened = (out.payouts as Json[]).find((p) => p.provider === HOSTS.screened.provider);
    if (screened) { s.screened = `${screened.status}: ${screened.reason}`; save(); }
    if (!mine?.tx) {
      const wait = onchain.latestHour > 0n && mine?.reason === "exceeds committed spend";
      return pending(`settle hours ${show(hours)}; the payout job answered ${show(mine ?? out.payouts).slice(0, 300)}${wait ? "; committed spend does not cover it until the next hourly root" : ""}`, nextHourMs(), { commit_spent_root: s.rootTx }, true);
    }
    s.payoutTx = mine.tx; s.payoutUnits = mine.usdc;
    save();
  }
  const paid = BigInt(s.payoutUnits!);
  const deltas = await tokenDeltas(s.payoutTx!);
  check(deltas.get(payoutAta.toBase58()) === paid && deltas.get(creditsPdas(credits.programId).vault.toBase58()) === -paid, `settle_to_host moved ${formatUsdc(paid)} USDC from the vault to the host's payout account`);
  const final = (await ctx.chain.creditsConfigOnChain())!;
  check(final.settledTotal <= final.spentTotal && final.settledTotal >= paid, `settled_total (${final.settledTotal}) stays within spent_total (${final.spentTotal})`);
  check(/SettlementExceedsCommittedSpend/.test(s.boundCheck ?? ""), `a settlement above committed spend is refused by the program (simulated: ${s.boundCheck})`);
  check(/sanctioned_address/.test(s.screened ?? ""), `the payout to the listed address was skipped (${s.screened ?? "no entry"})`);
  return pass(`spent root committed (spent_total ${formatUsdc(final.spentTotal)} USDC); the payout job paid ${formatUsdc(paid)} USDC to ${payoutWallet.publicKey.toBase58()} with settle_to_host; one unit above committed spend reverts (${s.boundCheck}); the host paying to the listed address ${LISTED_ADDRESS} was skipped (${s.screened})`, { commit_spent_root: s.rootTx, settle_to_host: s.payoutTx });
}

// ---- 5. Prepaid capacity (Bushels) ---------------------------------------------------------------------------------------------------
async function path5(mainKey: ApiKey | null): Promise<Outcome> {
  // Two hosts side by side: one that serves inside its window, one that fails inside it.
  const served = await capacityServed(mainKey);
  const short = await capacityShortfall(mainKey);
  const txs = { ...served.txs, ...Object.fromEntries(Object.entries(short.txs ?? {}).map(([k, v]) => [`${k} (failing host)`, v])) };
  const note = `${served.note}\n  Failing host: ${short.note}`;
  if (served.status === "dry-run") return dry(note);
  const waits = [served, short].filter((o) => o.status === "pending");
  if (waits.length) return pending(note, Math.min(...waits.map((o) => o.readyAt!)), txs);
  return pass(note, txs);
}

async function capacityServed(mainKey: ApiKey | null): Promise<Outcome> {
  const s = (state.p5 ??= {});
  const host = capacityHost;
  const TOKENS = 1_000_000n, BUY = 100_000n, WINDOW_S = Number(option("capacity-window", "360"));
  const grade = modelGrade(ctx, HOSTS.capacity.model);
  check(grade, `the capacity model ${HOSTS.capacity.model} has a grade`);
  const gradeIndex = GRADES.indexOf(grade);
  if (DRY_RUN) return dry(`model grade ${grade}; would bond ${formatUsdc(BOND_UNITS)} USDC for throwaway host ${host.publicKey.toBase58()}, commit ${TOKENS} tokens for ${WINDOW_S} s (commitment ${commitment.toBase58()}), buy ${BUY} tokens through POST /api/v1/bushels/buy, redeem, spend on one call and run the after-window job`);
  check(mainKey, "a funded API key");
  if (!s.fundSig) { s.fundSig = (await fund(host.publicKey, HOST_SOL, BOND_UNITS)) ?? "(already funded)"; save(); }
  if (!s.bondSig) { s.bondSig = await ensureBond(host); save(); }
  if (!s.commitSig) {
    const retry = await freeBondLock(host);
    if (retry) return pending(`an earlier commitment of host ${host.publicKey.toBase58()} still locks its bond; release_commitment is accepted once its window and the claim period have passed`, retry, {});
    const now = await chainNow();
    const windowStart = BigInt(now - 30), windowEnd = BigInt(now + WINDOW_S);
    s.commitSig = await send([commitCapacityIx(capacityProgramId, bondProgramId, { host: host.publicKey, commitmentId: BigInt(state.commitmentId!), grade: gradeIndex, tokens: TOKENS, windowStart, windowEnd })], [deployer, host]);
    s.commitment = commitment.toBase58(); s.windowEnd = Number(windowEnd);
    save();
  }
  const auth = mainKey.secret;
  if (!s.lot) {
    const open = must(await api("/api/v1/bushels/commitments"), "GET /api/v1/bushels/commitments");
    check((open.data as Json[]).some((c) => c.commitment === s.commitment), `the commitment is on offer (${show(open.data).slice(0, 200)})`);
    const lot = must(await api("/api/v1/bushels/buy", { method: "POST", auth, json: { commitment: s.commitment, tokens: Number(BUY) } }), "POST /api/v1/bushels/buy").data as Json;
    s.lot = lot.lot; s.buyTx = lot.buy_tx;
    save();
  }
  if (!s.redeemTx) {
    const lot = must(await api("/api/v1/bushels/redeem", { method: "POST", auth, json: { lot: s.lot } }), "POST /api/v1/bushels/redeem").data as Json;
    check(lot.allowance && lot.redeem_tx, "redeeming gives an allowance");
    s.redeemTx = lot.redeem_tx;
    save();
  }
  if (!s.generationId) {
    const r = await api(CHAT, { method: "POST", auth, json: chatBody(HOSTS.capacity, "What is 144 divided by 12? Reply with only the number.") });
    must(r, "POST /api/v1/chat/completions (capacity host)");
    s.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
  }
  const receipt = await receiptOf(s.generationId!);
  check(receipt.payload.prepaid_capacity?.lots?.includes(s.lot) && BigInt(receipt.payload.prepaid_capacity.tokens) > 0n && receipt.payload.cost_details?.prepaid_capacity, "the call's receipt shows prepaid_capacity: the tokens taken, the lot, and the USD it covered");
  const [lotRow] = await ctx.db.select().from(bushelLots).where(eq(bushelLots.id, s.lot!));
  if (!s.reportTx) {
    const now = await chainNow();
    if (now < s.windowEnd! + 2) return pending(`lot ${s.lot} bought for ${formatUsdc(lotRow.pricePaidUsdc)} USDC, redeemed, and ${receipt.payload.prepaid_capacity.tokens} tokens spent by ${s.generationId}; the commitment's window ends ${new Date(s.windowEnd! * 1000).toISOString()}`, Date.now() + (s.windowEnd! + 4 - now) * 1000, { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx, redeem_lot: s.redeemTx });
    await ctx.health.flush(ctx.db); // the job measures the host from the router's stored health samples
    const out = await runBushelShortfalls(ctx);
    const [record] = await ctx.db.select().from(bushelShortfalls).where(eq(bushelShortfalls.commitment, s.commitment!));
    check(record?.reportTx, `the after-window job reported the commitment (job said ${show(out)})`);
    s.reportTx = record.reportTx; s.shortfall = `${record.status}, unserved ${record.unservedTokens}, ok rate ${record.okRate}, ${record.samples} sample(s)`;
    save();
  }
  const info = await rpc(() => conn.getAccountInfo(commitment, "confirmed"));
  const c = info ? decodeCapacityCommitment(new Uint8Array(info.data)) : null;
  const [closedLot] = await ctx.db.select().from(bushelLots).where(eq(bushelLots.id, s.lot!));
  check(c?.status === "Settled" && c.unservedTokens === 0n && c.soldTokens === BUY, "the commitment is settled on chain with nothing unserved");
  check(closedLot.status === "closed", `the lot ended with its window (status ${closedLot.status})`);
  const txs = { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx, redeem_lot: s.redeemTx, report_shortfall: s.reportTx };
  const back = await unbondAndReturn(host, s);
  const note = `host ${host.publicKey.toBase58()} committed ${TOKENS} ${grade} tokens (commitment ${s.commitment}); lot ${s.lot} of ${BUY} tokens bought for ${formatUsdc(closedLot.pricePaidUsdc)} USDC from the key's prepaid balance, redeemed, ${receipt.payload.prepaid_capacity.tokens} tokens spent by ${s.generationId} (prepaid_capacity on the receipt); after the window the job reported ${s.shortfall}`;
  if (!back.done) return pending(`${note}. The host's bond unbonds at ${new Date(s.unbondAt! * 1000).toISOString()}`, back.readyAt!, { ...txs, request_unbond: s.unbondSig });
  return pass(`${note}; the bond was withdrawn and returned`, { ...txs, request_unbond: s.unbondSig, withdraw_bond: s.withdrawSig });
}

/** The under-delivery half of path 5: a host that fails inside its window pays the buyer's price back from its bond. */
async function capacityShortfall(mainKey: ApiKey | null): Promise<Outcome> {
  const s = (state.p5b ??= {});
  const host = shortfallHost;
  const TOKENS = 1_000_000n, BUY = 100_000n, WINDOW_S = Number(option("shortfall-window", "240"));
  if (DRY_RUN) return dry(`would bond ${formatUsdc(BOND_UNITS)} USDC for throwaway host ${host.publicKey.toBase58()}, commit ${TOKENS} tokens for ${WINDOW_S} s (commitment ${shortfallCommitment.toBase58()}), sell a lot of ${BUY} tokens, let the host fail one call, and after the window report the shortfall, file the claim on its bond, execute it after the dispute window and credit the buyer`);
  check(mainKey, "a funded API key");
  const auth = mainKey.secret;
  /** USDC units of this host's bond locked behind its open commitments (the ["lock", bond] account of trellis_bond). */
  const lockedNow = async () => { const i = await rpc(() => conn.getAccountInfo(bondLockPda(bondProgramId, bondPdas(bondProgramId, host.publicKey).bond!), "confirmed")); return i ? (decodeBondLock(new Uint8Array(i.data))?.locked ?? 0n) : 0n; };
  if (!s.fundSig) { s.fundSig = (await fund(host.publicKey, HOST_SOL, BOND_UNITS)) ?? "(already funded)"; save(); }
  if (!s.bondSig) { s.bondSig = await ensureBond(host); save(); }
  if (!s.commitSig) {
    const retry = await freeBondLock(host);
    if (retry) return pending(`an earlier commitment of host ${host.publicKey.toBase58()} still locks its bond; release_commitment is accepted once its window and the claim period have passed`, retry, {});
    const now = await chainNow();
    const windowEnd = BigInt(now + WINDOW_S);
    s.commitSig = await send([commitCapacityIx(capacityProgramId, bondProgramId, { host: host.publicKey, commitmentId: BigInt(state.shortfallCommitmentId!), grade: GRADES.indexOf(modelGrade(ctx, HOSTS.shortfall.model)!), tokens: TOKENS, windowStart: BigInt(now - 30), windowEnd })], [deployer, host]);
    s.commitment = shortfallCommitment.toBase58(); s.windowEnd = Number(windowEnd);
    s.lockedAtCommit = (await lockedNow()).toString(); // commit_capacity locked the commitment's value in the bond
    check(BigInt(s.lockedAtCommit) > 0n, "commit_capacity locked the commitment's value in the host's bond");
    save();
  }
  if (!s.lot) {
    const lot = must(await api("/api/v1/bushels/buy", { method: "POST", auth, json: { commitment: s.commitment, tokens: Number(BUY) } }), "POST /api/v1/bushels/buy (failing host)").data as Json;
    s.lot = lot.lot; s.buyTx = lot.buy_tx;
    save();
  }
  if (!s.failedCall) {
    // The host breaks: its one call inside the window fails, which is what the router's health samples record.
    const control = (behaviour: string) => fetch(`${shortfallMock.url}/_control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behaviour }) });
    await control("error500");
    const r = await api(CHAT, { method: "POST", auth, json: chatBody(HOSTS.shortfall, "Reply with the single word: capacity.") }).finally(() => control("ok"));
    check(r.status >= 500, `the failing host's call should fail, got ${r.status}`);
    s.failedCall = `HTTP ${r.status} ${r.body.error?.type ?? ""}`.trim();
    save();
  }
  const [bought] = await ctx.db.select().from(bushelLots).where(eq(bushelLots.id, s.lot!));
  const bondCfg = (await ctx.chain.bondConfig())!;
  if (!s.claimTx) {
    const now = await chainNow();
    // The other host's commitment (same grade) must have ended as well: while it is open the job rehomes the lot to it
    // instead of filing a claim, which is the right outcome but not the one this path shows.
    const servedEnd = state.p5?.windowEnd ?? 0;
    if (now < servedEnd + 2) return pending(`lot ${s.lot} sold against commitment ${s.commitment}; the host failed its call (${s.failedCall}); waiting for the other host's window to end as well (${new Date(servedEnd * 1000).toISOString()}), so no replacement of the grade is on offer`, Date.now() + (servedEnd + 4 - now) * 1000, { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx });
    if (now < s.windowEnd! + 2) return pending(`lot ${s.lot} sold for ${formatUsdc(bought.pricePaidUsdc)} USDC against commitment ${s.commitment}; the host failed its call (${s.failedCall}); the window ends ${new Date(s.windowEnd! * 1000).toISOString()}`, Date.now() + (s.windowEnd! + 4 - now) * 1000, { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx });
    await ctx.health.flush(ctx.db);
    const out = await runBushelShortfalls(ctx);
    const [record] = await ctx.db.select().from(bushelShortfalls).where(eq(bushelShortfalls.commitment, s.commitment!));
    const [lot] = await ctx.db.select().from(bushelLots).where(eq(bushelLots.id, s.lot!));
    check(record?.reportTx && lot.status === "claim_filed" && lot.claimRef && lot.shortfallTx, `the after-window job reported the shortfall and filed the claim (job said ${show(out)}; lot ${lot.status})`);
    s.reportTx = record.reportTx; s.claimTx = lot.shortfallTx; s.claim = lot.claimRef; s.refundUnits = lot.refundUsdc.toString();
    s.shortfall = `unserved ${record.unservedTokens} of ${record.tokens} tokens (ok rate ${record.okRate}, ${record.samples} sample(s))`;
    s.claimWindowEnd = Number((await ctx.chain.slashOnChain(lot.claimRef))!.windowEnd);
    save();
  }
  const refund = BigInt(s.refundUnits!);
  if (!s.executeTx) {
    const now = await chainNow();
    if (now < s.claimWindowEnd! + 2) return pending(`the host failed its call (${s.failedCall}); after the window the job reported ${s.shortfall} and filed claim ${s.claim} for ${formatUsdc(refund)} USDC on the host's bond; its dispute window ends ${new Date(s.claimWindowEnd! * 1000).toISOString()}`, Date.now() + (s.claimWindowEnd! + 4 - now) * 1000, { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx, report_shortfall: s.reportTx, claim_lot_shortfall: s.claimTx });
    const out = await runBushelShortfalls(ctx);
    // The execute_slash this run sent; or, when an earlier run of the job already sent it, the claim account's last transaction.
    const mine = out.executed?.find((e) => e.lot === s.lot)?.tx ?? ((await ctx.chain.slashOnChain(s.claim!))?.executed ? (await rpc(() => conn.getSignaturesForAddress(new PublicKey(s.claim!), { limit: 5 }, "confirmed"))).find((x) => !x.err)?.signature : undefined);
    check(mine, `the job executed the claim once its window had passed (job said ${show(out)})`);
    s.executeTx = mine;
    save();
  }
  const deltas = await tokenDeltas(s.executeTx);
  check(deltas.get(bondCfg.capacityRefund.toBase58()) === refund && deltas.get(bondPdas(bondProgramId, host.publicKey).vault!.toBase58()) === -refund, `execute_slash moved ${formatUsdc(refund)} USDC from the host's bond to the capacity refund account`);
  check(refund === bought.pricePaidUsdc, `the claim is the price the buyer paid for the unserved lot (${formatUsdc(refund)} USDC)`);
  const [after] = await ctx.db.select().from(bushelLots).where(eq(bushelLots.id, s.lot!));
  const [credit] = await ctx.db.select().from(ledger).where(eq(ledger.ref, `bushel:refund:${s.lot}`));
  check(after.status === "refunded" && credit?.kind === "bushel_refund" && credit.amount === refund * 1_000_000n, "the buyer's prepaid balance was credited the price back, once");
  const txs = { post_bond: s.bondSig, commit_capacity: s.commitSig, buy_lot: s.buyTx, report_shortfall: s.reportTx, claim_lot_shortfall: s.claimTx, execute_slash: s.executeTx };
  // The commitment locked its value in the host's bond (TR-11). With the claim paid and the claim period over, the job's
  // release pass settles the commitment and frees the lock; until then withdraw_bond pays out nothing that is locked.
  if (!s.released) {
    // The job's release pass may already have run in the pass that executed the claim; run it once more in case.
    const out = (await lockedNow()) === 0n ? null : await runBushelShortfalls(ctx);
    const lockedAfter = await lockedNow();
    check(lockedAfter === 0n, `the release pass freed the bond lock (locked ${s.lockedAtCommit ?? "?"} at commit, ${lockedAfter} now; job said ${show(out)})`);
    s.released = `${s.lockedAtCommit ?? "?"} at commit -> ${lockedAfter}`;
    save();
  }
  const back = await unbondAndReturn(host, s);
  const note = `host ${host.publicKey.toBase58()} committed ${TOKENS} tokens (commitment ${s.commitment}; bond lock ${s.released} units after release_commitment) and failed its call inside the window (${s.failedCall}); the job reported ${s.shortfall}, filed claim ${s.claim} and executed it after the dispute window: ${formatUsdc(refund)} USDC from the bond to the capacity refund account ${bondCfg.capacityRefund.toBase58()}, and the buyer's prepaid balance credited the same`;
  if (!back.done) return pending(`${note}. The rest of the bond unbonds at ${new Date(s.unbondAt! * 1000).toISOString()}`, back.readyAt!, { ...txs, request_unbond: s.unbondSig });
  return pass(`${note}; the rest of the bond was withdrawn and returned`, { ...txs, request_unbond: s.unbondSig, withdraw_bond: s.withdrawSig });
}

// ---- 6. Paid tool call ------------------------------------------------------------------------------------------------------------------
async function path6(mainKey: ApiKey | null): Promise<Outcome> {
  const s = (state.p6 ??= {});
  const sellerWallet = seedKey("tool-seller");
  const PRICE = usdcUnits("0.01");
  state.sellerPort = freePort(state.sellerPort ?? 8797);
  save();
  const seller = serveX402Seller({ facilitatorUrl: `${BASE}/facilitator`, payTo: sellerWallet.publicKey.toBase58(), feePayer: relayKp.publicKey.toBase58(), network: ctx.cfg.x402.network, asset: usdcMint.toBase58(), priceUnits: PRICE, port: state.sellerPort });
  try {
    const unpaid = await fetch(`${seller.url}?city=oslo`);
    check(unpaid.status === 402, "the seller answers 402 unpaid");
    await unpaid.text();
    if (DRY_RUN) return dry(`seller at ${seller.url} asks ${formatUsdc(PRICE)} USDC to ${sellerWallet.publicKey.toBase58()} (fee payer: the hosted facilitator's relay); would fund the buyer wallet ${toolsBuyer.publicKey.toBase58()} with 0.05 USDC, list the tool and call it through POST /api/v1/tools/call`);
    check(mainKey, "a funded API key");
    if (!s.callId) {
      const a = await fund(toolsBuyer.publicKey, 0, usdcUnits("0.05"));
      const b = await fund(sellerWallet.publicKey, 0, 0n); // the seller's USDC account must exist to be paid
      if (a ?? b) { s.fundSig = (a ?? b)!; save(); }
    }
    const auth = mainKey.secret;
    if (!s.listing) {
      const listed = await api("/api/v1/tools/listings", { method: "POST", auth, json: { name: "Devnet weather stand-in", summary: "A local x402 seller for the devnet walkthrough: 0.01 USDC per lookup, settled through the hosted facilitator.", resource: seller.url, method: "GET", canary: { query: "city=oslo", expect: { contains: "temp_c" } } } });
      if (listed.status === 409 && listed.body.error?.metadata?.seller_id) s.listing = listed.body.error.metadata.seller_id;
      else s.listing = must(listed, "POST /api/v1/tools/listings").data.id;
      save();
    }
    if (!s.callId) {
      const traceId = Buffer.from(Keypair.generate().publicKey.toBytes().subarray(0, 16)).toString("hex");
      const before = await tokenUnits(conn, ata(sellerWallet.publicKey));
      const r = await api("/api/v1/tools/call", { method: "POST", auth, headers: { traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01` }, json: { resource: `${seller.url}?city=oslo`, max_price: "0.02" } });
      const data = must(r, "POST /api/v1/tools/call").data as Json;
      check(data.status === "ok" && data.settle?.tx && data.response?.json?.temp_c === 21, `the tool answered and settled (${show(data).slice(0, 200)})`);
      check((await tokenUnits(conn, ata(sellerWallet.publicKey))) - before === PRICE, "the seller's USDC account received the price");
      s.callId = data.id; s.settleTx = data.settle.tx; s.traceId = data.trace_id;
      save();
    }
    const call = must(await api(`/api/v1/tools/calls/${s.callId}`, { auth }), "GET /api/v1/tools/calls/:id").data as Json;
    const claims = call.receipt?.claims as Json | undefined;
    check(call.status === "ok" && claims?.kind === "tool.call" && claims.trace_id === s.traceId && claims.settle?.tx === s.settleTx && claims.tool?.seller === sellerWallet.publicKey.toBase58() && claims.price?.units === PRICE.toString(), "the signed tool.call receipt names the seller, the price, the settlement transaction and the trace id");
    const verified = must(await api("/api/v1/receipts/verify", { method: "POST", json: { cose: call.receipt.cose } }), "POST /api/v1/receipts/verify");
    check(verified.valid === true || verified.data?.valid === true || verified.signature === "valid" || verified.data?.signature === "valid", `the tool receipt's signature verifies (${show(verified).slice(0, 160)})`);
    const settledBy = (await txMeta(s.settleTx!)).transaction.message.getAccountKeys().get(0)!.toBase58();
    check(settledBy === relayKp.publicKey.toBase58(), "the seller's payment was settled by the hosted facilitator's relay");
    // The model call of the same trace: its receipt carries the same trace_id (docs §7).
    if (!s.modelGenerationId) {
      const r = await api(CHAT, { method: "POST", auth, headers: { traceparent: `00-${s.traceId}-${s.traceId!.slice(16)}-01` }, json: chatBody(STANDIN, "The weather tool says 21 degrees in Oslo. Reply with one short sentence.") });
      must(r, "POST /api/v1/chat/completions (same trace)");
      s.modelGenerationId = r.headers.get("x-receipt-id") ?? r.body.id;
      save();
    }
    const model = await receiptOf(s.modelGenerationId!);
    check(model.payload.trace_id === s.traceId, "the model receipt carries the tool call's trace_id");
    const charged = await ctx.db.select().from(ledger).where(and(eq(ledger.kind, "tool_call"), eq(ledger.accountId, (await ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, mainKey.hash)))[0]!.accountId)));
    check(charged.length >= 1, "the key was debited the tool's price (zero markup)");
    return pass(`listing ${s.listing} (${seller.url}); call ${s.callId} paid ${formatUsdc(PRICE)} USDC from the buyer wallet ${toolsBuyer.publicKey.toBase58()} to the seller ${sellerWallet.publicKey.toBase58()}, settled by the facilitator relay, and debited the key the same amount; the tool.call receipt and the model receipt ${s.modelGenerationId} share trace_id ${s.traceId}`, { "seller payment (exact)": s.settleTx });
  } finally { seller.stop(); }
}

// ---- 7. $TRLS burn ---------------------------------------------------------------------------------------------------------------------
async function path7(): Promise<Outcome> {
  const s = (state.p7 ??= {});
  const info = await rpc(() => conn.getAccountInfo(feeRouterPdas(feeRouterId).feeConfig, "confirmed"));
  const fee = info ? decodeFeeConfig(new Uint8Array(info.data)) : null;
  check(fee, "trellis_fee_router is initialised");
  const supply = async () => BigInt((await rpc(() => conn.getTokenSupply(fee.trlsMint, "confirmed"))).value.amount);
  const decimals = await ctx.chain.tokenDecimals(fee.trlsMint.toBase58());
  const UNITS = 5n * 10n ** BigInt(decimals);
  if (DRY_RUN) return dry(`test $TRLS mint ${fee.trlsMint.toBase58()} (${decimals} decimals, supply ${await supply()}, burned so far ${fee.burnedTotal}); would mint ${UNITS} base units into the vault ${fee.trlsVault.toBase58()} and burn them with burn_inference_payment`);
  if (!s.burnSig) {
    if (!s.mintSig) { s.mintSig = await send([createMintToInstruction(fee.trlsMint, fee.trlsVault, deployer.publicKey, UNITS, [], TOKEN_2022_PROGRAM_ID)], [deployer]); save(); }
    s.units = UNITS.toString();
    s.supplyBefore = (await supply()).toString();
    s.burnSig = await send([burnInferencePaymentIx(feeRouterId, { authority: deployer.publicKey, trlsMint: fee.trlsMint, amount: UNITS })], [deployer]);
    s.supplyAfter = (await supply()).toString();
    save();
  }
  const burned = BigInt(s.units!);
  check(BigInt(s.supplyBefore!) - BigInt(s.supplyAfter!) === burned, `the mint's supply fell by ${burned} base units (${s.supplyBefore} -> ${s.supplyAfter})`);
  const after = decodeFeeConfig(new Uint8Array((await rpc(() => conn.getAccountInfo(feeRouterPdas(feeRouterId).feeConfig, "confirmed")))!.data))!;
  check(after.burnedTotal >= burned, `FeeConfig.burned_total counts it (${after.burnedTotal})`);
  check((await tokenDeltas(s.burnSig)).get(fee.trlsVault.toBase58()) === -burned, "the tokens left the fee router's $TRLS vault");
  return pass(`${Number(burned) / 10 ** decimals} test $TRLS minted into the fee router's vault and burned: supply ${s.supplyBefore} -> ${s.supplyAfter} base units, burned_total ${after.burnedTotal}`, { mint_to_vault: s.mintSig, burn_inference_payment: s.burnSig });
}

// ---- 8. Rulebook on chain ---------------------------------------------------------------------------------------------------------------
async function path8(): Promise<Outcome> {
  const s = (state.p8 ??= {});
  // The rule (src/solana/tab.ts, security review TR-04 / TR-10): a rulebook's daily maximum bounds what its owner COMMITS
  // to tabs in a day (open_tab and top_up count the escrow against it), and its kill switch stops new commitments and new
  // calls. Neither is consulted at settlement: what was served and vouched before a kill is still paid.
  const DAILY_MAX = 10_000n, CAP_A = 6_000n, CAP_B = 3_000n, CAP_OVER = 5_000n, FIRST = 4_000n, USED_B = 1_000n;
  if (DRY_RUN) return dry(`would create a rulebook (daily maximum ${formatUsdc(DAILY_MAX)} USDC), open a ${formatUsdc(CAP_A)} USDC tab bound to it and close it for ${formatUsdc(FIRST)}, show a ${formatUsdc(CAP_OVER)} USDC tab refused at open_tab (above what is left of the day), open a ${formatUsdc(CAP_B)} USDC tab, serve one call on it, kill the rulebook, show the router and top_up refusing, and show the close for what was vouched before the kill still paying the payee`);
  s.rulebookId ??= (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  s.sessionSeed ??= Buffer.from(Keypair.generate().secretKey.subarray(0, 32)).toString("hex");
  save();
  const session = Keypair.fromSeed(Buffer.from(s.sessionSeed, "hex"));
  const rulebook = rulebookPda(rulesProgramId, deployer.publicKey, BigInt(s.rulebookId));
  const rules = rulebookAccounts(rulesProgramId, rulebook);
  const readBook = async () => { const i = await rpc(() => conn.getAccountInfo(rulebook, "confirmed")); return i ? decodeRulebook(new Uint8Array(i.data)) : null; };
  if (!s.createSig) {
    const now = await chainNow();
    s.createSig = await send([createRulebookIx(rulesProgramId, { owner: deployer.publicKey, rulebookId: BigInt(s.rulebookId), params: { perCallMax: DAILY_MAX, dailyMax: DAILY_MAX, payeeAllowlistRoot: new Uint8Array(32), modelAllowlistRoot: new Uint8Array(32), askFirstAbove: 0n, expiry: BigInt(now + 2 * 86_400) } })], [deployer]);
    s.rulebook = rulebook.toBase58();
    save();
  }
  const openIx = async (tabId: string, cap: bigint, expiresIn: number) => {
    const expiry = (await chainNow()) + expiresIn;
    return { expiry, ...openTabInstruction(tabs, { payer: deployer.publicKey, payee: routerKp.publicKey, tabId: BigInt(tabId), cap, expiry: BigInt(expiry), sessionKey: session.publicKey, rulebook, rulesProgram: rulesProgramId, capUnits: ctx.cfg.solana.caps.tabUnits }) };
  };
  const open = async (t: { tabId: string; pda?: string; openSig?: string; expiry?: number }, cap: bigint, expiresIn: number) => {
    if (t.openSig) return;
    const { ix, tab, expiry } = await openIx(t.tabId, cap, expiresIn);
    t.openSig = await send([ix], [deployer]);
    t.pda = tab.toBase58(); t.expiry = expiry;
    save();
  };
  // A voucher is bound to the tab program and to this opening of the tab (Tab.created_at, read from the chain): TR-19.
  const tabHeaders = async (pda: string, v: Voucher) => {
    const onchain = await readTab(ctx.chain.connection, new PublicKey(pda), tabs);
    if (!onchain) throw new Error(`tab ${pda} is not on chain`);
    const scope = voucherScope(tabs.programId, onchain);
    return { [TAB_HEADER]: pda, [TAB_VOUCHER_HEADER]: encodeVoucherHeader(voucherBytes(v, scope), signVoucher(session, v, scope)) };
  };
  const tabChat = async (pda: string, v: Voucher) => api(CHAT, { method: "POST", headers: await tabHeaders(pda, v), json: chatBody(STANDIN, "Reply with the single word: rulebook.") });

  // Tab A: within the daily maximum. open_tab counts its escrow against the rulebook; the router serves it and its own
  // close job closes it, with no rulebook account in the close.
  const a = (s.a ??= { tabId: (BigInt(Date.now()) * 1000n + 1n).toString() });
  await open(a, CAP_A, 1_800); // expires within the hour, so the close job posts its voucher now
  const committed = await readBook();
  check(committed && committed.spentToday >= CAP_A, `open_tab counted the tab's ${formatUsdc(CAP_A)} USDC escrow against the rulebook's day (${committed?.spentToday} units committed today)`);
  const tabA = new PublicKey(a.pda!);
  const voucherA: Voucher = { tab: tabA, cumulativeUsed: FIRST, seq: 1n };
  if (!a.generationId) {
    const r = await tabChat(a.pda!, voucherA);
    must(r, "tab-billed POST /api/v1/chat/completions (rulebook tab)");
    a.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
  }
  if (!a.closeSig) {
    const out = await runTabClose(ctx);
    const usage = await readTabUsage(ctx, a.pda!);
    check(usage?.closed?.tx, `the close job closed the rulebook-bound tab (job said ${show(out)})`);
    a.closeSig = usage.closed.tx;
    save();
  }
  check((await tokenDeltas(a.closeSig)).get(ata(routerKp.publicKey).toBase58()) === FIRST, `the close paid the payee ${formatUsdc(FIRST)} USDC`);

  // A further tab of 0.005 USDC would take the day's commitments above the daily maximum: refused at open_tab, before
  // any money is escrowed or any call is served.
  if (!s.overCode) {
    s.overTabId ??= (BigInt(Date.now()) * 1000n + 3n).toString();
    save();
    const reverted = await sendExpectingRevert([(await openIx(s.overTabId, CAP_OVER, 900)).ix], [deployer]);
    s.overSig = reverted.signature; s.overCode = reverted.code ?? "(no error code in the logs)";
    save();
  }
  check(/DailyMaxExceeded/.test(s.overCode ?? ""), `open_tab above what is left of the day reverted with DailyMaxExceeded (${s.overCode})`);

  // Tab B: within what is left. One call is served and vouched, then the owner kills the rulebook.
  const b = (s.b ??= { tabId: (BigInt(Date.now()) * 1000n + 2n).toString() });
  await open(b, CAP_B, 1_800);
  const tabB = new PublicKey(b.pda!);
  const onchainB = await readTab(ctx.chain.connection, tabB, tabs);
  check(onchainB || b.closeSig, "the second tab exists on chain");
  if (onchainB) check(onchainB.rulebook?.equals(rulebook), "the second tab is bound to the rulebook");
  const voucherB: Voucher = { tab: tabB, cumulativeUsed: USED_B, seq: 1n };
  const next: Voucher = { tab: tabB, cumulativeUsed: USED_B * 2n, seq: 2n };
  if (!b.generationId) {
    const r = await tabChat(b.pda!, voucherB);
    must(r, "tab-billed POST /api/v1/chat/completions (second rulebook tab, before the kill)");
    b.generationId = r.headers.get("x-receipt-id") ?? r.body.id;
    save();
  }
  if (!s.killSig) {
    s.killSig = await send([killRulebookIx(rulesProgramId, { owner: deployer.publicKey, rulebookId: BigInt(s.rulebookId) })], [deployer]);
    save();
  }
  check((await readBook())?.killed, "the rulebook is killed on chain");
  // After the kill: no new call on the tab, no new money into it.
  if (!b.routerKilled) {
    const r = await tabChat(b.pda!, next);
    check(r.status === 402 && r.body.error?.type === "rulebook_killed", `after the kill the router refuses the tab, got ${r.status} ${r.body.error?.type}`);
    b.routerKilled = r.body.error.type;
    save();
  }
  if (!b.topUpCode) {
    const reverted = await sendExpectingRevert([topUpInstruction(tabs, { payer: deployer.publicKey, tab: tabB, amount: 1_000n, rules })], [deployer]);
    b.topUpSig = reverted.signature; b.topUpCode = reverted.code ?? "(no error code in the logs)";
    save();
  }
  check(/RulebookKilled/.test(b.topUpCode ?? ""), `top_up after the kill reverted with RulebookKilled (${b.topUpCode})`);
  // What was served before the kill is still paid: the close needs nothing from the rulebook (TR-04). Before the fix this
  // close reverted with RulebookKilled and the payer reclaimed the whole escrow.
  if (!b.closeSig) {
    const out = await runTabClose(ctx);
    const usage = await readTabUsage(ctx, b.pda!);
    check(usage?.closed?.tx, `the close job closed the tab of the killed rulebook (job said ${show(out)})`);
    b.closeSig = usage.closed.tx;
    save();
  }
  const deltasB = await tokenDeltas(b.closeSig);
  check(deltasB.get(ata(routerKp.publicKey).toBase58()) === USED_B, `the close after the kill paid the payee the ${formatUsdc(USED_B)} USDC vouched before it`);
  check(deltasB.get(ata(deployer.publicKey).toBase58()) === CAP_B - USED_B, `and returned the unused ${formatUsdc(CAP_B - USED_B)} USDC to the payer`);
  return pass(`rulebook ${s.rulebook} (daily maximum ${formatUsdc(DAILY_MAX)} USDC); tab ${a.pda} (${formatUsdc(CAP_A)} USDC committed) closed for ${formatUsdc(FIRST)} USDC by the router's close job; a further ${formatUsdc(CAP_OVER)} USDC tab was refused at open_tab with ${s.overCode}; tab ${b.pda} (${formatUsdc(CAP_B)} USDC) served one call, then kill_rulebook: the router answered 402 ${b.routerKilled}, top_up reverted with ${b.topUpCode}, and the close still paid the payee ${formatUsdc(USED_B)} USDC for what was vouched before the kill`, { create_rulebook: s.createSig, "open_tab A": a.openSig, "close A": a.closeSig, "open_tab above the daily maximum (reverted)": s.overSig, "open_tab B": b.openSig, kill_rulebook: s.killSig, "top_up B after the kill (reverted)": b.topUpSig, "close B after the kill": b.closeSig });
}

// ---- Run ---------------------------------------------------------------------------------------------------------------------------------
const TITLES: Record<number, string> = {
  1: "x402 exact per call (router fee payer, hosted facilitator, replays)",
  2: "Closure refund (close_account, pay_refund after the delay)",
  3: "Host bond, slash, refund pool",
  4: "Host settlement (commit_spent_root, settle_to_host, sanctions screening)",
  5: "Prepaid capacity (Bushels)",
  6: "Paid tool call (x402 seller, tool receipt, trace_id)",
  7: "$TRLS burn (burn_inference_payment)",
  8: "Rulebook on chain (daily maximum on commitments, kill, settlement of what was served)",
};
const results = new Map<number, Outcome>();
const report = (id: number, o: Outcome) => {
  results.set(id, o);
  console.log(`\n[${o.status.toUpperCase()}] ${id}. ${TITLES[id]}`);
  console.log(`  ${o.note}`);
  for (const [k, v] of Object.entries(o.txs ?? {})) if (v && !v.startsWith("(")) console.log(`  ${k.padEnd(24)} ${ex("tx", v)}`);
  if (o.status === "pending" && o.readyAt) console.log(`  run again after ${new Date(o.readyAt).toISOString()}`);
};
let exitCode = 0;
const startBalances = { sol: 0, usdc: 0n };
try {
  // ---- Preflight ---------------------------------------------------------------------------------------------------------------
  startBalances.sol = await solBalance(conn, deployer.publicKey);
  startBalances.usdc = await tokenUnits(conn, ata(deployer.publicKey));
  console.log(`  balances  ${startBalances.sol.toFixed(4)} SOL, ${formatUsdc(startBalances.usdc)} USDC`);
  // The devnet-only parameter set (short windows, 2 USDC minimum bond): applied here when the chain still carries the spec values.
  const ids = { trellis_credits: credits.programId, trellis_bond: bondProgramId };
  const profile = await applyProfile(conn, deployer, ids, "devnet", { dryRun: DRY_RUN, log: (l) => console.log(`  profile   ${l}`) });
  console.log(`  profile   devnet (DEVNET ONLY; mainnet keeps the spec values): ${profile.changed.length ? (DRY_RUN ? `${profile.changed.length} value(s) differ; a real run sends update_config` : "applied and recorded in deployments/devnet.json") : "already on chain"}`);
  // The bundled sanctions list, through the router's own refresh (parser, date and size checks, one transaction).
  const sdn = readFileSync(join(import.meta.dir, "../../test/fixtures/sanctions/sdn.xml"));
  const refreshed = (await refreshSanctions(ctx, (async () => new Response(sdn)) as unknown as typeof fetch).catch((e) => ({ error: (e as Error).message }))) as Json;
  console.log(`  sanctions ${refreshed.error ? `list not refreshed (${refreshed.error})` : `bundled list dated ${refreshed.list_date}, ${refreshed.entry_count} addresses`}`);
  // The prepaid key most paths spend from: the walkthrough's, else one created and funded here.
  let mainKey: ApiKey | null = state.mainKey ?? null;
  if (!mainKey) {
    const walkthrough = readJsonFile<{ key?: ApiKey }>(STATE_FILE, {}).key;
    if (walkthrough && (await api("/api/v1/credits", { auth: walkthrough.secret })).status === 200) { state.mainKey = mainKey = walkthrough; save(); }
  }
  const needsKey = [3, 4, 5, 6].some((n) => ONLY.has(n));
  if (needsKey && !DRY_RUN) {
    if (!mainKey) { state.mainKey = mainKey = await ensureKey("devnet-paths"); save(); }
    const balance = Number(must(await api("/api/v1/credits", { auth: mainKey.secret }), "GET /api/v1/credits").data.available ?? 0);
    if (balance < 0.4) {
      console.log(`  key       ${mainKey.hash.slice(0, 12)}… holds ${balance} USDC; depositing 1 USDC`);
      state.mainKey!.depositSig = await deposit(mainKey, usdcUnits("1")); save();
      await credited(mainKey);
    }
  }
  console.log(`  key       ${mainKey ? `${mainKey.hash.slice(0, 12)}… (prepaid)` : "none yet (a real run creates and funds one)"}`);
  // The payee and seller accounts a payment lands in must exist.
  if (!DRY_RUN && !(await rpc(() => conn.getAccountInfo(ata(routerKp.publicKey), "confirmed")))) await fund(routerKp.publicKey, 0, 0n);
  if (!DRY_RUN) for (const [who, kp, floor] of [["router key", routerKp, 0.01], ["facilitator relay", relayKp, 0.02]] as const) {
    if ((await solBalance(conn, kp.publicKey)) < floor) { await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: SOL(0.05) })], [deployer]); console.log(`  topped up the ${who} with 0.05 SOL for fees`); }
  }

  const runners: Record<number, () => Promise<Outcome>> = { 1: path1, 2: path2, 3: () => path3(mainKey), 4: () => path4(mainKey), 5: () => path5(mainKey), 6: () => path6(mainKey), 7: path7, 8: path8 };
  const order = [...ONLY].sort((x, y) => x - y);
  let todo = order;
  const deadline = Date.now() + (WAIT_HOUR ? 75 : 40) * 60_000;
  for (;;) {
    for (const id of todo) {
      try { report(id, await runners[id]!()); }
      catch (e) { report(id, { status: "fail", note: e instanceof Failed ? e.message : `unexpected: ${(e as Error).message}` }); }
      save();
    }
    // Every pending path whose window this run waits for (short windows always, the hour boundary with --wait-hour).
    const waiting = order.filter((id) => { const o = results.get(id)!; return o.status === "pending" && !!o.readyAt && (WAIT_HOUR || !o.hourWait) && o.readyAt - Date.now() <= (o.hourWait ? 62 * 60_000 : MAX_SHORT_WAIT_MS) && o.readyAt < deadline; });
    if (DRY_RUN || NO_WAIT || !waiting.length) break;
    const until = Math.min(...waiting.map((id) => results.get(id)!.readyAt!));
    console.log(`\nwaiting ${Math.max(1, Math.round((until - Date.now()) / 1000))} s for ${waiting.map((id) => `path ${id}`).join(", ")}…`);
    await sleep(Math.max(1_000, until - Date.now()));
    todo = waiting.filter((id) => results.get(id)!.readyAt! <= Date.now() + 1_000);
    if (!todo.length) todo = [waiting.reduce((a, b) => (results.get(a)!.readyAt! <= results.get(b)!.readyAt! ? a : b))];
  }

  // ---- --sweep: what the throwaway keys still hold goes back to the wallet ------------------------------------------------------
  if (SWEEP && !DRY_RUN) {
    const done = (n: number) => results.get(n)?.status === "pass" || !ONLY.has(n);
    // A key whose path is still waiting (a bond to withdraw, a payment to make) is left alone.
    const idle: [string, boolean][] = [["x402-payer", done(1)], ["slash-host", done(3)], ["payout", done(4)], ["capacity-host", done(5)], ["shortfall-host", done(5)], ["tools-buyer", done(6)], ["tool-seller", done(6)], ...Object.keys(state.seeds).filter((r) => r.includes(":retired:")).map((r): [string, boolean] => [r, true])];
    let usdcBack = 0n, lamportsBack = 0;
    for (const [role, ok] of idle) {
      if (!ok || !state.seeds[role]) continue;
      const kp = seedKey(role);
      const units = await tokenUnits(conn, ata(kp.publicKey));
      const lamports = await rpc(() => conn.getBalance(kp.publicKey, "confirmed"));
      const ixs: TransactionInstruction[] = [];
      if (units > 0n) ixs.push(createTransferCheckedInstruction(ata(kp.publicKey), usdcMint, ata(deployer.publicKey), kp.publicKey, units, 6));
      if (lamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: deployer.publicKey, lamports }));
      if (!ixs.length) continue;
      await send(ixs, [deployer, kp]);
      usdcBack += units; lamportsBack += lamports;
    }
    console.log(`\nsweep     ${formatUsdc(usdcBack)} USDC and ${(lamportsBack / 1e9).toFixed(4)} SOL returned from the throwaway keys (a path run afresh funds its key again)`);
  }

  // ---- Summary -------------------------------------------------------------------------------------------------------------------
  const endSol = await solBalance(conn, deployer.publicKey), endUsdc = await tokenUnits(conn, ata(deployer.publicKey));
  console.log("\nsummary");
  for (const id of order) { const o = results.get(id)!; console.log(`  ${String(id)}. ${o.status.toUpperCase().padEnd(8)} ${TITLES[id]}`); }
  console.log("  -. NOT RUN  Pay with a tokenized stock (docs §6): devnet has no tokenized stocks and no Jupiter liquidity to route a swap through");
  if (!DRY_RUN) console.log(`  wallet    ${startBalances.sol.toFixed(4)} -> ${endSol.toFixed(4)} SOL, ${formatUsdc(startBalances.usdc)} -> ${formatUsdc(endUsdc)} USDC this run (bonds and refunds still waiting come back on a later run)`);
  console.log(`  state     ${PATHS_STATE_FILE}`);
  // A dry run leaves the last real run's summary in place.
  if (!DRY_RUN) writePrivateFile(PATHS_SUMMARY_FILE, JSON.stringify({ finishedAt: new Date().toISOString(), rpc: rpcLabel(RPC), router: BASE, wallet: deployer.publicKey.toBase58(), dryRun: DRY_RUN, balances: { startSol: startBalances.sol, endSol, startUsdcUnits: startBalances.usdc.toString(), endUsdcUnits: endUsdc.toString() }, paths: order.map((id) => ({ id, title: TITLES[id], ...results.get(id), txs: Object.fromEntries(Object.entries(results.get(id)!.txs ?? {}).filter(([, v]) => v && !v.startsWith("(")).map(([k, v]) => [k, { signature: v, explorer: ex("tx", v!) }])) })) }, null, 2) + "\n");
  if (!DRY_RUN) console.log(`  summary   ${PATHS_SUMMARY_FILE}`);
  if ([...results.values()].some((o) => o.status === "fail")) exitCode = 1;
} catch (e) {
  exitCode = 1;
  console.error(`\nfailed: ${(e as Error).message}`);
} finally {
  save();
  server.stop(true);
  for (const m of mocks) m.stop();
  await close();
  process.exit(exitCode);
}
