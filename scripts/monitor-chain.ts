// Chain-side checks for scripts/monitor.ts. Read-only: JSON-RPC reads and (optionally) public GETs; it sends no
// transaction and signs nothing. Where an address is derived from a role key in an env file, only the public key is ever
// used or printed; an RPC URL is shown as its host name.
//
// Checks (each is one boolean in the result; `skipped` says why a check could not run):
//   rpc.health, rpc.genesis          the RPC answers, is on the expected cluster, and its head is recent
//   programs.deployed                every program in deployments/<cluster>.json is an executable account
//   authority.drift                  every upgrade authority, config authority, guardian and role key is the one the record names
//   caps.within_ceilings             tab cap <= 500 USDC, credits cap <= 5,000 USDC per key, prepaid capacity <= 250,000 USDC
//   fees.zero_split                  the fee router is 0 / 10,000 bps (no fee split)
//   params.spec (mainnet only)       the timings and the minimum bond are the spec values of scripts/mainnet/params.ts
//   build.profile (mainnet only)     every deployed program answers build_profile with profile 0 and the mainnet floors (24 h
//                                    timelock, 7-day proposal expiry, 72 h pause, ...): the running binary is not a `devnet` build
//   pause.none                       no program pause is IN FORCE (flag set and its expiry ahead; a pause lapses after 72 h)
//   credits.deposits_not_paused      trellis_credits deposits are not paused
//   limiter.not_paused               trellis_credits' settlement outflows are not paused (the guardian's second brake)
//   pause.expiring                   no pause in force lapses within the warning window (default 12 h): the page that lets the
//                                    authority renew it deliberately, or let it go deliberately
//   pause.lapsed                     no pause flag is set whose pause has lapsed (the program runs again; if the incident is
//                                    not over, nobody renewed)
//   guardian.pause_ready             the guardian is in no cooldown: after a guardian pause it cannot pause that slot again for
//                                    7 days past the lapse, so until then only the authority can
//   limiter.present, limiter.rate    the outflow limiter exists at ["limiter_v2"] and its rate is the expected one (2,000 bps)
//   limiter.settle_headroom,         each allowance (host settlements, closure refunds) still holds at least 10% of what it can
//   limiter.refund_headroom          hold at once: an allowance that stays drained is outflow at the maximum rate
//   config.proposed                  no config change or authority hand-over is pending on any of the EIGHT programs (the
//                                    programs' ConfigProposed / AuthorityTransferProposed events, read as accounts)
//   proposal.changes_authority,      no live proposal would change a config authority / a guardian
//   proposal.changes_guardian
//   proposal.applicable              no proposal has become effective and can be applied right now (one transaction away)
//   proposal.expiring                no applicable proposal expires within the warning window (default 24 h): a planned
//                                    hand-over must resolve before then or start again
//   proposal.expired                 no expired proposal is still occupying a program's one proposal slot
//   signer.proposed                  no new receipt signer is waiting to be installed in trellis_anchor (SignerProposed; it
//                                    installs 24 h after it was proposed), and the signer set names a current signer
//   measurements.proposed            no registration or reinstatement is waiting in trellis_measurements (MeasurementProposed)
//   bond.reinstate_proposed          no reinstatement of a delisted or ejected bond is waiting in trellis_bond (ReinstateProposed)
//   events.read                      the recent trellis_credits transactions could all be read (bounded work per run; a
//                                    flood or a truncated log is reported, never passed over)
//   events.spent_root_delta          no recent SpentRootCommitted has a delta above the bound, above half the vault, or (with
//                                    the database) for a root the router's ledger does not know or above the ledger's total
//   events.settle_destination        every recent SettledToHost went to an allow-listed token account (known host payout
//                                    accounts, the fee vault)
//   guardian.separate                each guardian is a key of its own: not the config authority, not the deployer
//   anchor.lag                       hours since the last receipt root on chain: a ReceiptRoot account (program mode) or
//                                    the anchorer's last root memo (memo mode). In memo mode only a line read from its own
//                                    FINALIZED transaction, in a memo instruction the anchorer signed, counts: text in the
//                                    signature list is never believed, so a stranger's look-alike keeps nothing green. In
//                                    memo mode every hour gets a line (count 0 when it had no receipts); in program mode an
//                                    hour with no receipts posts none
//   anchor.memo_conflict             memo mode: the anchorer never signed two different roots for one hour (recent history)
//   anchor.memo_late                 memo mode: no recent root landed later than the lateness bound after its hour closed
//   signer.<role>.sol                SOL of the settlement, anchorer, slasher, router and facilitator relay keys above its floor
//   settlement.usdc                  USDC of the settlement wallet above its floor
//   credits.vault_covers_spend       the credits vault holds at least the committed spend not yet paid to hosts
//   credits.vault_covers_accounts    the vault holds at least (open credit balances + queued refunds - settled to hosts), read from the program's accounts
//   credits.vault_covers_ledger      with MONITOR_DATABASE_URL (PostgreSQL): the vault covers the router ledger's positive balances plus unsettled spend
//   gateway.attestation              the attested gateway's attestation is fresh (through the router when a base URL is given, else the gateway's own report)
//   sanctions.fresh                  the sanctions list is enabled and inside its age limit: read from the row the router's
//                                    sanctions-refresh job writes (MONITOR_DATABASE_URL), never from a router route (none
//                                    that carries it is on the core launch surface). Without a database to read it fails
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { SOLANA_MAINNET_CAIP2, base58Encode } from "../src/solana/constants.ts";
import { signerAddress } from "../src/solana/keys.ts";
import { DEFAULT_MAX_LATE_SECONDS, memoHints, networkNamesGenesis, networkRef, parseMemo, readSignedTransaction, sameClaim, type MemoRpc, type RootMemo } from "../src/solana/anchor-memo.ts";
import { anchorPdas, decodePendingSigner, decodeSignerSet, receiptRootHour, receiptRootPda } from "../src/solana/programs/anchor.ts";
import { bondIdl, decodePendingReinstate } from "../src/solana/programs/bond.ts";
import { decodePendingMeasurement, measurementsIdl } from "../src/solana/programs/measurements.ts";
import { allowanceNow, creditsIdl, creditsPdas, DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS, limiterBase, SETTLE_BURST_BPS, settleWindowCap, type SettleLimiter } from "../src/solana/programs/credits.ts";
import { logsTruncated } from "../src/solana/programs/encoding.ts";
import { feeRouterPdas } from "../src/solana/programs/fee-router.ts";
import { TREASURY_BPS, WORKERS_BPS } from "../src/solana/programs/fee-router.ts";
import { aciReportData, keysetDigest } from "../src/providers/aci.ts";
import { ROOT, retryingFetch } from "./devnet/lib.ts";
import { PROGRAMS, type ProgramName } from "./mainnet/lib.ts";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, PARAMS } from "./mainnet/params.ts";
import { HANDOVER_KIND, MAINNET_GUARDIAN_COOLDOWN_SECONDS, MAINNET_PROPOSAL_TTL_SECONDS, describeProfile, pauseFields, pauseView, proposalLifecycle, readPending, slotProgram, type PauseView, type Pending, type ProfileReading, type ProposalState } from "./mainnet/plan.ts";
import { expectedHolder, fundedPayer, holders, readBuildProfile, readChainState } from "./mainnet/state.ts";

export type Cluster = "devnet" | "mainnet" | "rehearsal";
export type ChainResult = {
  ok: boolean;
  at: string;
  cluster: Cluster;
  rpc: string;
  failing: string[];
  checks: Record<string, boolean>;
  values: Record<string, string | number | null>;
  details: Record<string, string>;
  skipped: Record<string, string>;
};

/** KEY=VALUE lines of an env file; `#` comments, optional quotes, later files win. Values are never logged. */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

const LAMPORTS = 1e9;
const num = (v: string | undefined, fallback: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback; };
const rpcHost = (url: string) => { try { return new URL(url).host; } catch { return "(invalid url)"; } };
const usdc = (units: bigint) => Number(units) / 1e6;

/** What the router's database knows, for the two event checks; scripts/monitor-chain.ts reads it through MONITOR_DATABASE_URL. */
export type LedgerView = {
  /** For each root (hex, no prefix) the ledger holds: its cumulative committed spend in USDC base units. */
  spentRoots(roots: string[]): Promise<Map<string, bigint>>;
  /** The wallets hosts are paid to (their USDC associated token accounts are valid settlement destinations). */
  payoutOwners(): Promise<string[]>;
};
export type ChainOptions = { env: Record<string, string | undefined>; cluster?: Cluster; base?: string | null; recordFile?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => Date; ledger?: LedgerView | null };

// ---- Pure judgments (unit-tested in test/ops-chain-rules.test.ts; chainProbe below only reads the chain and applies them) -------

type Verdicts = Record<string, { ok: boolean; detail?: string }>;
const iso = (t: number) => new Date(t * 1000).toISOString();
const span = (seconds: number) => (seconds < 3600 ? `${Math.max(0, Math.ceil(seconds / 60))} min` : seconds < 2 * 86_400 ? `${(seconds / 3600).toFixed(1)} h` : `${(seconds / 86_400).toFixed(1)} d`);

/**
 * The six pause slots, judged at `now` (the cluster's clock). `warnSeconds` is how long before a pause lapses the
 * authority is told, so that renewing it (or letting it go) is a decision and not an accident.
 */
export function appraisePauses(views: PauseView[], now: number, warnSeconds: number): { checks: Verdicts; values: Record<string, string | number | null> } {
  const values: Record<string, string | number | null> = {};
  for (const v of views) {
    values[`pause.${v.slot}.active`] = v.active ? 1 : 0;
    values[`pause.${v.slot}.until`] = v.flag ? iso(v.until) : null;
    values[`pause.${v.slot}.seconds_left`] = v.left;
    values[`pause.${v.slot}.by`] = v.flag ? v.by : null;
    values[`pause.${v.slot}.lapsed`] = v.lapsed ? 1 : 0;
    values[`pause.${v.slot}.guardian_cooldown_s`] = v.guardianInCooldown ? v.guardianReadyAt - now : 0;
  }
  const what = (v: PauseView) => `${v.slot} until ${iso(v.until)} (set by the ${v.by})`;
  const active = views.filter((v) => v.active);
  const programLevel = active.filter((v) => v.slot !== "trellis_credits.settlements");
  const settlements = active.find((v) => v.slot === "trellis_credits.settlements");
  const deposits = active.find((v) => v.slot === "trellis_credits.deposits");
  const expiring = active.filter((v) => v.left <= warnSeconds);
  const lapsed = views.filter((v) => v.lapsed);
  const cooling = views.filter((v) => v.guardianInCooldown);
  const checks: Verdicts = {
    "pause.none": { ok: programLevel.length === 0, detail: programLevel.length ? `paused: ${programLevel.map(what).join("; ")}. Each lapses by itself at the time shown unless the authority renews it.` : undefined },
    "pause.expiring": { ok: expiring.length === 0, detail: expiring.length ? `lapsing soon: ${expiring.map((v) => `${v.slot} in ${span(v.left)} (${iso(v.until)})`).join("; ")}. If the incident is not over, the AUTHORITY renews now (scripts/mainnet/pause.ts --renew; after the hand-over a Squads transaction). The guardian cannot.` : undefined },
    "pause.lapsed": { ok: lapsed.length === 0, detail: lapsed.length ? `lapsed: ${lapsed.map((v) => `${v.slot} at ${iso(v.until)}`).join("; ")}. The flag is still set but the program RUNS AGAIN. Pause it again if it should be paused; otherwise the authority clears the flag (pause.ts --unpause).` : undefined },
    "guardian.pause_ready": { ok: cooling.length === 0, detail: cooling.length ? `the guardian cannot pause ${cooling.map((v) => `${v.slot} before ${iso(v.guardianReadyAt)}`).join("; ")}: it paused there and is in its cooldown. Until then only the authority can pause these.` : undefined },
  };
  if (views.some((v) => v.slot === "trellis_credits.deposits")) checks["credits.deposits_not_paused"] = { ok: !deposits, detail: deposits ? `trellis_credits deposits are PAUSED until ${iso(deposits.until)} (set by the ${deposits.by}). Closures and refunds still work.` : undefined };
  if (views.some((v) => v.slot === "trellis_credits.settlements")) checks["limiter.not_paused"] = { ok: !settlements, detail: settlements ? `trellis_credits settlements are PAUSED until ${iso(settlements.until)} (set by the ${settlements.by}): no spent root, host payout or sweep goes through until then or until the authority resumes them. If nobody here paused them, treat the guardian or authority key as used by someone else.` : undefined };
  return { checks, values };
}

export type ProposalSeen = { program: ProgramName; pending: Pending; proposalTtl: number };
export type ProposalRow = { program: ProgramName; state: ProposalState; effectiveAt: number; expiresAt: number; toEffective: number; toExpiry: number; expiring: boolean; changesAuthority: boolean; changesGuardian: boolean; text: string };
/**
 * Every pending proposal of the deployment, judged at `now`. A proposal that would change an authority or a guardian is
 * named separately (it pages) for as long as it can still be applied; an expired one can do nothing but sit there.
 */
export function appraiseProposals(seen: ProposalSeen[], now: number, warnSeconds: number): { rows: ProposalRow[]; checks: Verdicts } {
  const rows: ProposalRow[] = seen.map(({ program, pending: x, proposalTtl }) => {
    const life = proposalLifecycle(x, now, proposalTtl);
    const changes = [x.newAuthority ? `new authority ${x.newAuthority}` : null, x.guardian ? `guardian ${x.guardian}` : null, x.other.length ? `also ${x.other.join(", ")}` : null].filter(Boolean).join(", ") || "no field set";
    const when = life.state === "pending" ? `effective ${iso(x.effectiveAt)} (in ${span(life.toEffective)})` : life.state === "applicable" ? `APPLICABLE NOW, expires ${iso(life.expiresAt)} (in ${span(life.toExpiry)})` : `EXPIRED ${iso(life.expiresAt)}`;
    return {
      program, state: life.state, effectiveAt: x.effectiveAt, expiresAt: life.expiresAt, toEffective: Math.max(0, life.toEffective), toExpiry: Math.max(0, life.toExpiry),
      expiring: life.state === "applicable" && life.toExpiry <= warnSeconds, changesAuthority: !!x.newAuthority, changesGuardian: !!x.guardian,
      text: `${program}: ${changes}; ${when}${x.timelock !== 86_400 ? ` (timelock ${x.timelock} s: NOT the mainnet build)` : ""}`,
    };
  });
  const live = rows.filter((r) => r.state !== "expired");
  const list = (rs: ProposalRow[]) => rs.map((r) => r.text).join("; ");
  const authority = live.filter((r) => r.changesAuthority), guardian = live.filter((r) => r.changesGuardian);
  const applicable = rows.filter((r) => r.state === "applicable"), expiring = rows.filter((r) => r.expiring), expired = rows.filter((r) => r.state === "expired");
  return {
    rows,
    checks: {
      "config.proposed": { ok: rows.length === 0, detail: rows.length ? `pending: ${list(rows)}. Expected only during a hand-over or a change you made; otherwise cancel it with the AUTHORITY key (the guardian cannot cancel).` : undefined },
      "proposal.changes_authority": { ok: authority.length === 0, detail: authority.length ? `a proposal would hand a config authority to another key: ${list(authority)}. If this is not the planned hand-over to the multisig vault, the authority key is in someone else's hands: cancel with it now and pause.` : undefined },
      "proposal.changes_guardian": { ok: guardian.length === 0, detail: guardian.length ? `a proposal would replace a guardian: ${list(guardian)}. The guardian cannot cancel it; only the authority can.` : undefined },
      "proposal.applicable": { ok: applicable.length === 0, detail: applicable.length ? `can be applied right now, in one transaction: ${list(applicable)}` : undefined },
      "proposal.expiring": { ok: expiring.length === 0, detail: expiring.length ? `expires soon: ${list(expiring)}. Resolve it before then or it must be proposed again (another 24 h).` : undefined },
      "proposal.expired": { ok: expired.length === 0, detail: expired.length ? `expired and not cleared: ${list(expired)}. It can no longer be applied but occupies the program's one proposal slot: clear it (scripts/mainnet/handover.ts cancel; anyone may for credits, tab, bond, capacity and rules).` : undefined },
    },
  };
}

/** A proposal of the kinds added in the third review round, as its account holds it. `what` names what would change. */
export type TimelockedSeen = { kind: "signer" | "measurement" | "reinstatement"; what: string; effectiveAt: number; proposalTtl: number };
/**
 * The proposals that put a new receipt signer in trellis_anchor, a digest on (or back on) trellis_measurements' allow-list,
 * or a delisted bond back in trellis_bond. Each waits 24 hours on chain before it can be applied and emits an event when
 * it is made and when it is applied; like a config proposal, the pending account IS the alert. One check per kind, so
 * the weekly signer rotation and a release's registrations (both expected, both announced a day ahead) can be routed
 * apart from a reinstatement, which is rare. `signerMissing`: the signer set names no current signer (it was revoked
 * and its replacement is not installed yet).
 */
export function appraiseTimelocked(seen: TimelockedSeen[], now: number, o: { signerMissing?: boolean; unread?: Partial<Record<TimelockedSeen["kind"], string>> } = {}): { checks: Verdicts; values: Record<string, number> } {
  const text = (x: TimelockedSeen) => {
    const expiresAt = x.effectiveAt + x.proposalTtl;
    const when = now < x.effectiveAt ? `can be applied from ${iso(x.effectiveAt)} (in ${span(x.effectiveAt - now)})` : now <= expiresAt ? `CAN BE APPLIED NOW, expires ${iso(expiresAt)}` : `EXPIRED ${iso(expiresAt)} (clear it)`;
    return `${x.what}; ${when}`;
  };
  const of = (kind: TimelockedSeen["kind"]) => seen.filter((x) => x.kind === kind);
  const list = (xs: TimelockedSeen[]) => xs.map(text).join("; ");
  const signers = of("signer"), entries = of("measurement"), bonds = of("reinstatement");
  const failed = (kind: TimelockedSeen["kind"]) => (o.unread?.[kind] ? `the proposals could not be read (${o.unread[kind]})` : "");
  const detail = (parts: string[]) => parts.filter(Boolean).join(". ") || undefined;
  return {
    checks: {
      "signer.proposed": {
        ok: signers.length === 0 && !o.signerMissing && !o.unread?.signer,
        detail: detail([
          signers.length ? `a new receipt signer is proposed: ${list(signers)}. Expected once a week, for the router's own next key (it is in /.well-known/trellis-receipt-keys.json); any other key means the anchorer key is in someone else's hands: cancel with it (resolve_signer(false)) inside the 24 h` : "",
          o.signerMissing ? "the signer set names NO current signer: it was revoked and its replacement is not installed yet. Roots are still posted (they record no signer); receipts verify against the router's published keys" : "",
          failed("signer"),
        ]),
      },
      "measurements.proposed": {
        ok: entries.length === 0 && !o.unread?.measurement,
        detail: detail([entries.length ? `pending in the measurement registry: ${list(entries)}. Expected only for a release you published (the label is its transparency-log entry); otherwise cancel with the registry authority (cancel_measurement_proposal) inside the 24 h` : "", failed("measurement")]),
      },
      "bond.reinstate_proposed": {
        ok: bonds.length === 0 && !o.unread?.reinstatement,
        detail: detail([bonds.length ? `a delisted or ejected bond is proposed for reinstatement: ${list(bonds)}. Only the bond authority proposes this; if you did not, cancel it (resolve_reinstate(false)) inside the 24 h` : "", failed("reinstatement")]),
      },
    },
    values: { "signer.proposals_pending": signers.length, "measurements.proposals_pending": entries.length, "bond.reinstatements_pending": bonds.length },
  };
}

/**
 * The outflow limiter against what is expected of it. `vault` is the vault's balance now (null when it could not be
 * read: the allowances are then not judged). An allowance is "drained" below `minHeadroomPct` of its ceiling (the most it
 * can hold at once, a quarter of the window's cap); it refills to there within the hour unless outflow continues at the
 * maximum rate, which is what the alert rule waits for.
 */
export function appraiseLimiter(l: SettleLimiter, vault: bigint | null, now: number, o: { windowSeconds: number; expectedRateBps: number; minHeadroomPct: number; expectedCapUnits?: bigint }): { checks: Verdicts; values: Record<string, string | number | null> } {
  const values: Record<string, string | number | null> = { "limiter.rate_bps": l.rateBps, "limiter.cap_per_window_usdc": usdc(l.capPerWindow) };
  const expectedCap = o.expectedCapUnits ?? DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS;
  const checks: Verdicts = {
    // The absolute bound on one window's outflow (round 3, R3-07): raising it is a 24 h proposal, like the rate.
    "limiter.cap": { ok: l.capPerWindow === expectedCap, detail: l.capPerWindow !== expectedCap ? `the absolute outflow cap is ${usdc(l.capPerWindow)} USDC per window, expected ${usdc(expectedCap)}${l.capPerWindow > expectedCap ? ": it was RAISED (a 24 h proposal by the authority)" : ": it was lowered (the authority can do that at once)"}. Set MONITOR_OUTFLOW_CAP_USDC if the change was deliberate.` : undefined },
    "limiter.rate": { ok: l.rateBps === o.expectedRateBps, detail: l.rateBps !== o.expectedRateBps ? `the outflow limit is ${l.rateBps} bps of the vault per window, expected ${o.expectedRateBps}${l.rateBps > o.expectedRateBps ? ": it was RAISED (a 24 h proposal by the authority)" : ": it was lowered (the authority can do that at once)"}. Set MONITOR_SETTLE_RATE_BPS if the change was deliberate.` : undefined },
  };
  if (vault === null) return { checks, values };
  for (const kind of ["settle", "refund"] as const) {
    // The cap as the program computes it (round 3, R3-07): a share of the lowest vault balance of the last window,
    // never more than the absolute cap.
    const cap = settleWindowCap(limiterBase(l, vault, now, o.windowSeconds), l.rateBps, l.capPerWindow);
    const burst = (cap * SETTLE_BURST_BPS) / 10_000n;
    const have = allowanceNow(l, kind, vault, now, o.windowSeconds);
    values[`limiter.${kind}_allowance_usdc`] = usdc(have);
    values[`limiter.${kind}_burst_usdc`] = usdc(burst);
    values[`limiter.${kind}_window_cap_usdc`] = usdc(cap);
    const ok = have * 100n >= burst * BigInt(o.minHeadroomPct);
    checks[`limiter.${kind}_headroom`] = { ok, detail: ok ? undefined : `the ${kind === "settle" ? "settlement" : "refund"} allowance holds ${usdc(have)} of at most ${usdc(burst)} USDC (the window's cap is ${usdc(cap)} USDC): ${kind === "settle" ? "host payouts are" : "closure refunds are"} running at the limiter's maximum rate` };
  }
  return { checks, values };
}

export type CreditsTx = { signature: string; blockTime: number | null; err: unknown; logs: readonly string[] | null };
export type EventFindings = {
  commits: { signature: string; hour: number; root: string; delta: bigint; spentTotal: bigint; problems: string[] }[];
  settlements: { signature: string; to: string; amount: bigint; known: boolean }[];
  /** Vault outflow seen in these transactions (settlements, refunds, sweeps), in USDC base units. */
  outflow: bigint;
  /** Transactions whose events could not be read (no logs returned, or a truncated log): never passed over silently. */
  unreadable: string[];
};
/**
 * The trellis_credits events of recent transactions, decoded with the program's own IDL and ATTRIBUTED: only what the
 * program at `programId` itself logged counts (`creditsIdl.at(programId).eventsNamed`), so a transaction that merely
 * names the program, or another program logging look-alike bytes, contributes nothing. A failed transaction changed
 * nothing and is skipped.
 *   maxDelta        a SpentRootCommitted above this is flagged whatever else is known
 *   vault           the vault's balance now; a delta above `maxVaultPct` of (vault + outflow seen since) is flagged
 *   ledgerRoots     with the database: root (hex) -> the ledger's cumulative spend; a root the ledger does not hold, or
 *                   an on-chain total above the ledger's, is flagged (a commit the router did not make)
 *   allow           the token accounts a settlement may go to
 */
export function appraiseCreditsEvents(programId: PublicKey | string, txs: CreditsTx[], o: { maxDelta: bigint; vault: bigint | null; maxVaultPct: number; allow: ReadonlySet<string>; ledgerRoots?: ReadonlyMap<string, bigint> | null }): EventFindings {
  const program = creditsIdl.at(programId);
  const out: EventFindings = { commits: [], settlements: [], outflow: 0n, unreadable: [] };
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  for (const tx of txs) {
    if (tx.err) continue;
    if (!tx.logs || logsTruncated(tx.logs)) { out.unreadable.push(tx.signature); continue; }
    for (const e of program.events(tx.logs)) {
      const d = e.data as Record<string, any>;
      if (e.name === "SpentRootCommitted") out.commits.push({ signature: tx.signature, hour: Number(d.hour), root: hex(d.root), delta: BigInt(d.spent_delta), spentTotal: BigInt(d.spent_total), problems: [] });
      else if (e.name === "SettledToHost") { const to = (d.host_token_account as PublicKey).toBase58(); out.settlements.push({ signature: tx.signature, to, amount: BigInt(d.amount), known: o.allow.has(to) }); out.outflow += BigInt(d.amount); }
      else if (e.name === "RefundPaid" || e.name === "ExpiredSwept") out.outflow += BigInt(d.amount);
    }
  }
  // What the vault can have held when a root was committed: no more than it holds now plus what left since.
  const held = o.vault === null ? null : o.vault + out.outflow;
  for (const c of out.commits) {
    if (c.delta > o.maxDelta) c.problems.push(`delta ${usdc(c.delta)} USDC is above the bound of ${usdc(o.maxDelta)} USDC`);
    if (held !== null && c.delta * 100n > held * BigInt(o.maxVaultPct)) c.problems.push(`delta ${usdc(c.delta)} USDC is more than ${o.maxVaultPct}% of what the vault holds (${usdc(held)} USDC)`);
    if (o.ledgerRoots) {
      const total = o.ledgerRoots.get(c.root);
      if (total === undefined) c.problems.push("the router's ledger holds no spent root with this hash: the router did not make this commit");
      else if (c.spentTotal > total) c.problems.push(`the chain's committed spend ${usdc(c.spentTotal)} USDC is above the ledger's ${usdc(total)} USDC for this root`);
    }
  }
  return out;
}

/**
 * The recent transactions of one address, newest first, with bounded work: at most `maxSignatures` listed and at most
 * `maxTransactions` fetched per run. No cursor is kept: every run reads the same window again (the checks stay red for
 * as long as an event is inside it). `covered` is false when the window could not be read to its end (more activity
 * than the bounds allow), and `why` says so: a flood must be a finding, not a way to push an event out of sight.
 */
export async function readRecentTransactions(conn: Pick<Connection, "getSignaturesForAddress" | "getTransaction">, address: PublicKey, o: { since: number; maxSignatures: number; maxTransactions: number }): Promise<{ txs: CreditsTx[]; listed: number; covered: boolean; why?: string }> {
  const sigs = await conn.getSignaturesForAddress(address, { limit: o.maxSignatures }, "confirmed");
  const inWindow = sigs.filter((s) => s.blockTime === null || s.blockTime === undefined || s.blockTime >= o.since);
  const reachedEnd = sigs.length < o.maxSignatures || inWindow.length < sigs.length;
  const wanted = inWindow.filter((s) => !s.err);
  const txs: CreditsTx[] = [];
  for (const s of wanted.slice(0, o.maxTransactions)) {
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    txs.push({ signature: s.signature, blockTime: s.blockTime ?? null, err: tx ? tx.meta?.err ?? null : null, logs: tx ? tx.meta?.logMessages ?? null : null });
  }
  const why = !reachedEnd ? `more than ${o.maxSignatures} transactions name the account inside the window; only the newest ${o.maxSignatures} were listed` : wanted.length > o.maxTransactions ? `${wanted.length} transactions inside the window, only the newest ${o.maxTransactions} were read` : undefined;
  return { txs, listed: sigs.length, covered: !why, why };
}

/**
 * Memo mode: what the anchorer key really signed lately. Walks the key's FINALIZED history newest first for at most
 * `pages` pages and `reads` transactions, back to `lookbackHours` ago, and counts a root line only after reading its
 * transaction and finding it in a memo instruction the anchorer signed, under a network name that names this cluster
 * (security review round 3, R3-03: a transaction that merely names the anchorer, with any memo text, is nobody's root).
 * The signature list's memo text only picks which transactions to read, and only once the node has shown that it lists
 * memo text at all. When the walk runs out of budget before it finds a root, `anchor.lag` fails: an unread history is
 * not a healthy one.
 */
export async function appraiseMemoRoots(conn: MemoRpc, anchorer: string, o: { now: number; /** The CAIP-2 network the roots must name; unset: any name that names the RPC's cluster. */ network?: string; maxLagHours?: number; maxLateSeconds?: number; lookbackHours?: number; pages?: number; reads?: number }): Promise<{ checks: Verdicts; values: Record<string, string | number | null> }> {
  const maxLag = o.maxLagHours ?? 3, maxLate = o.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS, horizon = o.now - (o.lookbackHours ?? 48) * 3600;
  const key = new PublicKey(anchorer);
  const genesis = conn.getGenesisHash ? await conn.getGenesisHash() : "";
  const lines: { signature: string; blockTime: number | null; claim: RootMemo }[] = [];
  let read = 0, complete = false, indexed = false, before: string | undefined;
  walk: for (let page = 0; page < (o.pages ?? 5); page++) {
    const batch = await conn.getSignaturesForAddress(key, { limit: 1000, ...(before ? { before } : {}) }, "finalized");
    if (batch.some((s) => typeof s.memo === "string")) indexed = true;
    for (const s of batch) {
      if (s.blockTime != null && s.blockTime < horizon) { complete = true; break walk; }
      before = s.signature;
      if (s.err) continue;
      const wanted = typeof s.memo === "string" ? memoHints(s.memo).some((t) => parseMemo(t)?.kind === "root") : !indexed;
      if (!wanted) continue;
      if (read >= (o.reads ?? 400)) break walk;
      read++;
      const r = await readSignedTransaction(conn, s.signature, "finalized");
      if (!r.ok) continue;
      for (const m of r.tx.memos) {
        const claim = parseMemo(m.text);
        if (claim?.kind === "root" && m.signers.includes(anchorer) && networkNamesGenesis(claim.network, genesis) && (!o.network || claim.network === networkRef(o.network))) lines.push({ signature: s.signature, blockTime: r.tx.blockTime, claim });
      }
    }
    if (batch.length < 1000) { complete = true; break; }
  }
  const lastHour = lines.reduce<number | null>((h, l) => (h === null || l.claim.hour > h ? l.claim.hour : h), null);
  const lag = lastHour === null ? null : Math.max(0, Math.round((o.now - (lastHour + 3600)) / 360) / 10);
  const byHour = new Map<number, RootMemo[]>();
  for (const l of lines) byHour.set(l.claim.hour, [...(byHour.get(l.claim.hour) ?? []), l.claim]);
  const doubled = [...byHour.entries()].filter(([, v]) => v.some((c) => !sameClaim(c, v[0]!))).map(([h]) => new Date(h * 1000).toISOString());
  const late = lines.filter((l) => l.blockTime == null || l.blockTime > l.claim.hour + 3600 + maxLate).map((l) => new Date(l.claim.hour * 1000).toISOString());
  const unread = complete ? "" : ` (the anchorer's history was not read through: ${read} transactions read; a flood of transactions naming the key, or an RPC that does not list memo text)`;
  return {
    checks: {
      "anchor.lag": { ok: lag !== null && lag <= maxLag, detail: lag === null ? `no root memo signed by the anchorer in its recent finalized history${unread}` : lag > maxLag ? `the last root memo the anchorer signed covers an hour that closed ${lag} h ago (limit ${maxLag} h; in memo mode every hour gets a line)${unread}` : undefined },
      "anchor.memo_conflict": { ok: doubled.length === 0, detail: doubled.length ? `the anchorer signed two different roots for: ${doubled.join(", ")}. Nothing on chain prevents that in memo mode; the earliest line is the root, and this is an incident (a second router, a restored backup, or a stolen anchorer key).` : undefined },
      "anchor.memo_late": { ok: late.length === 0, detail: late.length ? `roots that landed more than ${maxLate} s after their hour closed (verifiers refuse them): ${[...new Set(late)].join(", ")}` : undefined },
    },
    values: { "anchor.mode": "memo", "anchor.lag_hours": lag, "anchor.last_root_hour": lastHour === null ? null : new Date(lastHour * 1000).toISOString(), "anchor.memo_lines_read": lines.length, "anchor.memo_history_complete": complete ? 1 : 0 },
  };
}

export async function chainProbe(o: ChainOptions): Promise<{ code: 0 | 1 | 2; result: ChainResult }> {
  const env = o.env;
  const now = o.now?.() ?? new Date();
  const fetcher = o.fetch ?? fetch;
  const network = env.SOLANA_NETWORK;
  const cluster: Cluster = o.cluster ?? (network === SOLANA_MAINNET_CAIP2 ? "mainnet" : "devnet");
  const url = cluster === "rehearsal" ? env.REHEARSAL_RPC_URL ?? "http://127.0.0.1:8899" : env.SOLANA_RPC_URL || env.SOL_RPC_URL || (cluster === "devnet" ? "https://api.devnet.solana.com" : env.MAINNET_RPC_URL ?? "");
  const result: ChainResult = { ok: false, at: now.toISOString(), cluster, rpc: rpcHost(url), failing: [], checks: {}, values: {}, details: {}, skipped: {} };
  const set = (name: string, ok: boolean, detail?: string) => { result.checks[name] = ok; if (detail) result.details[name] = detail; };
  const skip = (name: string, why: string) => { result.skipped[name] = why; };
  const finish = (code?: 2) => {
    result.failing = Object.keys(result.checks).filter((k) => !result.checks[k]).sort();
    result.ok = result.failing.length === 0 && code !== 2;
    return { code: code ?? (result.ok ? 0 : 1), result } as { code: 0 | 1 | 2; result: ChainResult };
  };
  if (!url) { set("rpc.health", false, "no RPC URL: set SOLANA_RPC_URL (or SOL_RPC_URL)"); return finish(2); }

  // ---- RPC -----------------------------------------------------------------------------------------------------------------
  const conn = new Connection(url, { commitment: "confirmed", fetch: retryingFetch as typeof fetch, disableRetryOnRateLimit: true });
  let slot: number;
  // The cluster's own clock: what the programs compare a pause's expiry and a proposal's dates with.
  let chainNow = Math.floor(now.getTime() / 1000);
  try {
    const started = Date.now();
    const genesis = await conn.getGenesisHash();
    slot = await conn.getSlot("confirmed");
    result.values["rpc.latency_ms"] = Date.now() - started;
    result.values["rpc.slot"] = slot;
    const want = cluster === "mainnet" ? MAINNET_GENESIS_HASH : cluster === "devnet" ? DEVNET_GENESIS_HASH : null;
    set("rpc.genesis", want ? genesis === want : genesis !== MAINNET_GENESIS_HASH && genesis !== DEVNET_GENESIS_HASH, want && genesis !== want ? `the RPC is on another cluster (genesis ${genesis})` : undefined);
    const blockTime = await conn.getBlockTime(slot).catch(() => null);
    chainNow = blockTime ?? Math.floor(now.getTime() / 1000);
    const age = blockTime ? Math.round(now.getTime() / 1000 - blockTime) : null;
    result.values["rpc.head_age_s"] = age;
    const maxAge = num(env.MONITOR_RPC_MAX_HEAD_AGE_S, 120);
    set("rpc.health", age !== null && age <= maxAge, age === null ? "no block time for the head slot" : age > maxAge ? `the head is ${age} s old (limit ${maxAge} s)` : undefined);
  } catch (e) {
    set("rpc.health", false, `the RPC did not answer (${(e as Error).name})`);
    return finish(2);
  }
  if (result.checks["rpc.genesis"] === false) return finish();

  // ---- The deployment record ---------------------------------------------------------------------------------------------
  const file = o.recordFile ?? env.TRELLIS_DEPLOYMENTS_FILE ?? (cluster === "rehearsal" ? join(ROOT, ".data/mainnet-rehearsal/deployment.json") : join(ROOT, `deployments/${cluster}.json`));
  if (!existsSync(file)) { set("programs.deployed", false, `no deployment record at ${file.replace(ROOT + "/", "")}: nothing is deployed on ${cluster}`); return finish(); }
  const rec = JSON.parse(readFileSync(file, "utf8")) as { deployer?: string; tier?: string; programs?: Record<string, { programId?: string; status?: string; upgradeAuthority?: string | null }>; authorities?: Record<string, string>; accounts?: Record<string, string>; mints?: { usdc?: string }; handover?: { multisigVault?: string; resolved?: Record<string, string> } };
  const ids: Partial<Record<ProgramName, PublicKey>> = {};
  for (const p of PROGRAMS) { const id = rec.programs?.[p]?.programId; if (id) ids[p] = new PublicKey(id); }
  const recorded = PROGRAMS.filter((p) => ids[p]);
  const state = await readChainState(conn, ids);
  if (rec.tier) result.values["launch.tier"] = rec.tier;

  // A launch tier deploys only some programs (scripts/mainnet/tiers.ts); `minimal` deploys none, and says so in its record.
  const notDeployed = recorded.filter((p) => !state.programs[p].deployed || !state.programs[p].executable);
  set("programs.deployed", (recorded.length > 0 || rec.tier === "minimal") && notDeployed.length === 0, notDeployed.length ? `not deployed: ${notDeployed.join(", ")}` : recorded.length === 0 ? "tier minimal: no program is deployed (pay-per-call, memo roots)" : undefined);
  result.values["programs.count"] = recorded.length - notDeployed.length;
  const uninitialised = recorded.filter((p) => state.programs[p].deployed && !state.configs[p] && !state.legacy.includes(p));
  const legacy = recorded.filter((p) => state.legacy.includes(p));
  set("programs.initialised", uninitialised.length === 0 && legacy.length === 0, [uninitialised.length ? `deployed but not initialised: ${uninitialised.join(", ")} (only the upgrade authority can initialise it; do it now)` : "", legacy.length ? `config in the layout of an earlier build (no pause expiry): ${legacy.join(", ")}. Nothing about it is read until migrate_config has grown it (scripts/mainnet/init.ts; scripts/devnet/init.ts on devnet)` : ""].filter(Boolean).join("; ") || undefined);

  // ---- Which build is running: asked of every program (security/REREVIEW-2026-10.md RR-04) ---------------------------------------
  const a0 = rec.authorities ?? {};
  const payer = await fundedPayer(conn, [a0.settlementAuthority, a0.anchorAuthority ?? a0.anchorer, rec.deployer, a0.guardian, a0.multisigVault ?? rec.handover?.multisigVault, a0.slasher, env.MONITOR_SIMULATION_PAYER]).catch(() => null);
  const profiles: Partial<Record<ProgramName, ProfileReading>> = {};
  for (const p of recorded) if (state.programs[p].deployed) profiles[p] = await readBuildProfile(conn, p, ids[p]!, payer);
  for (const p of recorded) if (profiles[p]) { result.values[`build.${p}.profile`] = profiles[p]!.profile; result.values[`build.${p}.kind`] = profiles[p]!.kind; result.values[`build.${p}.timelock_s`] = profiles[p]!.timelock; }
  const notMainnet = recorded.filter((p) => profiles[p] && profiles[p]!.kind !== "mainnet");
  if (!Object.keys(profiles).length) { /* nothing deployed */ }
  else if (cluster === "mainnet") set("build.profile", notMainnet.length === 0, notMainnet.length ? `not the mainnet build: ${notMainnet.map((p) => `${p} (${profiles[p]!.profile === null ? profiles[p]!.problems.join("; ") : `${describeProfile(profiles[p]!)}: ${profiles[p]!.problems.join("; ")}`})`).join("; ")}. A program upgrade installed a build with other floors, or build_profile could not be read: treat as an incident.` : undefined);
  else skip("build.profile", `${cluster} may run the devnet build; reported as values (${recorded.filter((p) => profiles[p]).map((p) => `${p}: ${profiles[p]!.kind}`).join(", ")}), enforced on mainnet only`);
  const floorOf = (p: ProgramName, name: string, fallback: number) => Number(profiles[p]?.floors[name] ?? fallback);

  // ---- Authority drift ----------------------------------------------------------------------------------------------------------
  const drift: string[] = [];
  for (const h of holders(state)) {
    const want = expectedHolder(h, rec);
    if (want === undefined) { drift.push(`${h.program} ${h.role}: the record names no expected holder`); continue; }
    const have = h.role === "upgrade" && state.programs[h.program].frozen ? "none" : h.address;
    if ((want ?? "none") !== (have ?? "none")) drift.push(`${h.program} ${h.role}: ${have ?? "none"} on chain, record says ${want ?? "none"}`);
  }
  set("authority.drift", drift.length === 0, drift.length ? drift.join("; ") : undefined);
  result.values["authority.holders_checked"] = holders(state).length;

  // ---- Caps, fee split, spec parameters, pauses ----------------------------------------------------------------------------------
  const c = state.configs;
  const caps: string[] = [];
  if (c.trellis_tab && c.trellis_tab.maxCap > PARAMS.tab.maxCap) caps.push(`tab cap ${usdc(c.trellis_tab.maxCap)} USDC`);
  if (c.trellis_credits && c.trellis_credits.maxBalancePerKey > PARAMS.credits.maxBalancePerKey) caps.push(`credits cap ${usdc(c.trellis_credits.maxBalancePerKey)} USDC per key`);
  if (c.trellis_capacity && c.trellis_capacity.maxOutstandingValue > PARAMS.capacity.maxOutstandingValue) caps.push(`prepaid capacity cap ${usdc(c.trellis_capacity.maxOutstandingValue)} USDC`);
  set("caps.within_ceilings", caps.length === 0, caps.length ? `above the pre-audit ceiling: ${caps.join(", ")}` : undefined);
  if (c.trellis_tab) result.values["caps.tab_usdc"] = usdc(c.trellis_tab.maxCap);
  if (c.trellis_credits) result.values["caps.credits_per_key_usdc"] = usdc(c.trellis_credits.maxBalancePerKey);
  if (c.trellis_capacity) result.values["caps.capacity_usdc"] = usdc(c.trellis_capacity.maxOutstandingValue);
  if (c.trellis_fee_router) set("fees.zero_split", c.trellis_fee_router.workersBps === WORKERS_BPS && c.trellis_fee_router.treasuryBps === TREASURY_BPS, `workers/treasury ${c.trellis_fee_router.workersBps}/${c.trellis_fee_router.treasuryBps} bps`);
  if (cluster === "mainnet") {
    const off: string[] = [];
    if (c.trellis_credits && (c.trellis_credits.refundDelay !== PARAMS.credits.refundDelay || c.trellis_credits.creditTtl !== PARAMS.credits.creditTtl || c.trellis_credits.expiryGrace !== PARAMS.credits.expiryGrace)) off.push("credits timings");
    if (c.trellis_tab && c.trellis_tab.reclaimGrace !== PARAMS.tab.reclaimGrace) off.push("tab reclaim grace");
    if (c.trellis_bond && (c.trellis_bond.minBond !== PARAMS.bond.minBond || c.trellis_bond.unbondPeriod !== PARAMS.bond.unbondPeriod || c.trellis_bond.disputeWindow !== PARAMS.bond.disputeWindow || c.trellis_bond.disputeBlock !== PARAMS.bond.disputeBlock)) off.push("bond minimum or timings");
    set("params.spec", off.length === 0, off.length ? `differs from scripts/mainnet/params.ts: ${off.join(", ")}` : undefined);
  } else skip("params.spec", `${cluster} may run the short devnet timings (scripts/devnet/profile.ts); checked on mainnet only`);

  // ---- Pauses: in force only until their expiry; the guardian once per cooldown ------------------------------------------------
  const views = pauseFields(c, state.limiter).map((f) => pauseView(f, chainNow, floorOf(slotProgram(f.slot), "guardianPauseCooldown", MAINNET_GUARDIAN_COOLDOWN_SECONDS)));
  if (views.length) {
    const pauses = appraisePauses(views, chainNow, num(env.MONITOR_PAUSE_RENEW_WARN_HOURS, 12) * 3600);
    for (const [name, v] of Object.entries(pauses.checks)) set(name, v.ok, v.detail);
    Object.assign(result.values, pauses.values);
  }

  // ---- Pending proposals on all eight programs -------------------------------------------------------------------------------------
  // Every loosening change and every hand-over is proposed first, applies no sooner than 24 h later and expires 7 days
  // after that. A pending account IS the alert: it is either the planned hand-over or someone using the authority key.
  // trellis_anchor is read too: its authority (the anchorer key) hands itself on through the same kind of account.
  const seen: ProposalSeen[] = [];
  const unread: string[] = [];
  for (const p of recorded) {
    if (!state.programs[p].deployed) continue;
    try { const x = await readPending(conn, p, ids[p]!); if (x) seen.push({ program: p, pending: x, proposalTtl: floorOf(p, "proposalTtl", MAINNET_PROPOSAL_TTL_SECONDS) }); }
    catch (e) { unread.push(`${p} (${(e as Error).name})`); }
  }
  if (recorded.length) {
    const proposals = appraiseProposals(seen, chainNow, num(env.MONITOR_PROPOSAL_EXPIRY_WARN_HOURS, 24) * 3600);
    for (const [name, v] of Object.entries(proposals.checks)) set(name, v.ok, v.detail);
    // A pending account that could not be read is not "no proposal": the check fails with the reason.
    if (unread.length) set("config.proposed", false, `the pending account could not be read for ${unread.join(", ")}${seen.length ? `; pending: ${proposals.rows.map((r) => r.text).join("; ")}` : ""}`);
    for (const r of proposals.rows) {
      result.values[`proposal.${r.program}.state`] = r.state;
      result.values[`proposal.${r.program}.effective_at`] = iso(r.effectiveAt);
      result.values[`proposal.${r.program}.expires_at`] = iso(r.expiresAt);
      result.values[`proposal.${r.program}.seconds_to_effective`] = r.toEffective;
      result.values[`proposal.${r.program}.seconds_to_expiry`] = r.toExpiry;
      result.values[`proposal.${r.program}.changes_authority`] = r.changesAuthority ? 1 : 0;
      result.values[`proposal.${r.program}.changes_guardian`] = r.changesGuardian ? 1 : 0;
    }
  }
  result.values["config.proposals_pending"] = seen.length;

  // ---- Signer, measurement and reinstatement proposals (third review round) ----------------------------------------------------------
  // A new receipt signer, a new or reinstated registry entry and a reinstated bond each wait 24 h in an account of their own.
  {
    const timelocked: TimelockedSeen[] = [];
    const unread: Partial<Record<TimelockedSeen["kind"], string>> = {};
    let signerMissing = false;
    const ttl = (p: ProgramName) => floorOf(p, "proposalTtl", MAINNET_PROPOSAL_TTL_SECONDS);
    const all = async (program: PublicKey, idl: { accountDiscriminator(name: string): Uint8Array }, name: string) =>
      (await conn.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: base58Encode(idl.accountDiscriminator(name)) } }] })).filter((x) => x.account.owner.equals(program));
    if (ids.trellis_anchor && state.programs.trellis_anchor.deployed) {
      try {
        const pdas = anchorPdas(ids.trellis_anchor);
        const [pending, set] = await conn.getMultipleAccountsInfo([pdas.pendingSigner, pdas.signerSet], "confirmed");
        const p = pending && pending.owner.equals(ids.trellis_anchor) ? decodePendingSigner(pending.data) : null;
        if (p) timelocked.push({ kind: "signer", what: `trellis_anchor: receipt signer ${p.newSigner.toBase58()}`, effectiveAt: Number(p.effectiveAt), proposalTtl: ttl("trellis_anchor") });
        const s = set && set.owner.equals(ids.trellis_anchor) ? decodeSignerSet(set.data) : null;
        signerMissing = !!s && s.currentSigner.equals(PublicKey.default);
      } catch (e) { unread.signer = (e as Error).name; }
    }
    if (ids.trellis_measurements && state.programs.trellis_measurements.deployed) {
      try {
        for (const x of await all(ids.trellis_measurements, measurementsIdl, "PendingMeasurement")) {
          const p = decodePendingMeasurement(x.account.data);
          if (p) timelocked.push({ kind: "measurement", what: `trellis_measurements: ${p.reinstate ? "reinstate" : "register"} ${p.kind} ${Buffer.from(p.digest).toString("hex")}${p.reinstate ? "" : ` (label ${p.label || "none"})`}`, effectiveAt: Number(p.effectiveAt), proposalTtl: ttl("trellis_measurements") });
        }
      } catch (e) { unread.measurement = (e as Error).name; }
    }
    if (ids.trellis_bond && state.programs.trellis_bond.deployed) {
      try {
        for (const x of await all(ids.trellis_bond, bondIdl, "PendingReinstate")) {
          const p = decodePendingReinstate(x.account.data);
          if (p) timelocked.push({ kind: "reinstatement", what: `trellis_bond: bond ${p.bond.toBase58()}`, effectiveAt: Number(p.effectiveAt), proposalTtl: ttl("trellis_bond") });
        }
      } catch (e) { unread.reinstatement = (e as Error).name; }
    }
    const judged = appraiseTimelocked(timelocked, chainNow, { signerMissing, unread });
    if (ids.trellis_anchor && state.programs.trellis_anchor.deployed) set("signer.proposed", judged.checks["signer.proposed"]!.ok, judged.checks["signer.proposed"]!.detail);
    if (ids.trellis_measurements && state.programs.trellis_measurements.deployed) set("measurements.proposed", judged.checks["measurements.proposed"]!.ok, judged.checks["measurements.proposed"]!.detail);
    if (ids.trellis_bond && state.programs.trellis_bond.deployed) set("bond.reinstate_proposed", judged.checks["bond.reinstate_proposed"]!.ok, judged.checks["bond.reinstate_proposed"]!.detail);
    Object.assign(result.values, judged.values);
  }

  // ---- The outflow limiter (["limiter_v2"]) ------------------------------------------------------------------------------------------
  let vaultNow: bigint | null = null;
  if (ids.trellis_credits && c.trellis_credits) {
    set("limiter.present", !!state.limiter, state.limiter ? undefined : `no outflow limiter at ${state.limiterAddress} (["limiter_v2"]): settlements and refunds cannot run until init_limiter creates it`);
    if (state.limiter) {
      const info = await conn.getAccountInfo(creditsPdas(ids.trellis_credits).vault, "confirmed").catch(() => null);
      vaultNow = info && info.owner.equals(TOKEN_PROGRAM_ID) ? unpackAccount(creditsPdas(ids.trellis_credits).vault, info, TOKEN_PROGRAM_ID).amount : null;
      const limiter = appraiseLimiter(state.limiter, vaultNow, chainNow, { windowSeconds: floorOf("trellis_credits", "settleWindow", 86_400), expectedRateBps: num(env.MONITOR_SETTLE_RATE_BPS, PARAMS.credits.settleRateBps), minHeadroomPct: num(env.MONITOR_LIMITER_MIN_HEADROOM_PCT, 10), expectedCapUnits: BigInt(Math.round(num(env.MONITOR_OUTFLOW_CAP_USDC, Number(DEFAULT_OUTFLOW_CAP_PER_WINDOW_UNITS) / 1e6) * 1e6)) });
      for (const [name, v] of Object.entries(limiter.checks)) set(name, v.ok, v.detail);
      Object.assign(result.values, limiter.values);
    }
  }
  const guardians = holders(state).filter((h) => h.role === "guardian");
  const shared = guardians.filter((g) => g.address && (g.address === rec.deployer || g.address === holders(state).find((h) => h.program === g.program && h.role === "authority")?.address));
  if (guardians.length) set("guardian.separate", shared.length === 0, shared.length ? `the guardian is also the ${shared.map((g) => `${g.program} ${g.address === rec.deployer ? "deployer" : "authority"}`).join(", ")}: a pause key that is the authority protects nothing` : undefined);

  // ---- Anchor lag ------------------------------------------------------------------------------------------------------------------
  if (ids.trellis_anchor && c.trellis_anchor) {
    const lookback = Math.max(1, Math.min(24 * 30, num(env.MONITOR_ANCHOR_LOOKBACK_HOURS, 24 * 7)));
    const nowS = Math.floor(now.getTime() / 1000);
    const current = receiptRootHour(nowS + 1); // the hour that has just closed
    let lastHour: number | null = null;
    for (let i = 0; i < lookback && lastHour === null; i += 100) {
      const hours = Array.from({ length: Math.min(100, lookback - i) }, (_, k) => current - (i + k) * 3600);
      const infos = await conn.getMultipleAccountsInfo(hours.map((h) => receiptRootPda(ids.trellis_anchor!, h)), "confirmed");
      const hit = infos.findIndex((x) => !!x);
      if (hit >= 0) lastHour = hours[hit]!;
    }
    const maxLag = num(env.MONITOR_ANCHOR_MAX_LAG_HOURS, 3);
    const lag = lastHour === null ? null : Math.max(0, Math.round((nowS - (lastHour + 3600)) / 360) / 10);
    result.values["anchor.lag_hours"] = lag;
    result.values["anchor.last_root_hour"] = lastHour === null ? null : new Date(lastHour * 1000).toISOString();
    set("anchor.lag", lag !== null && lag <= maxLag, lag === null ? `no receipt root in the last ${lookback} hours` : lag > maxLag ? `last receipt root closed ${lag} h ago (limit ${maxLag} h; an hour with no receipts posts none)` : undefined);
  } else {
    // Memo mode: the roots are the anchorer's memo transactions, each read from its own finalized transaction
    // (`appraiseMemoRoots`). The newest root line the anchorer signed gives the lag; two different lines for one hour
    // in the recent history are a double post; a line that landed after the lateness bound is no anchor.
    const anchorer = env.MONITOR_ANCHORER_ADDRESS || signerAddress(env.ANCHORER_PRIVATE_KEY) || env.ANCHORER_ADDRESS || rec.authorities?.anchorer || rec.authorities?.anchorAuthority || env.MAINNET_ANCHORER;
    if (!anchorer) skip("anchor.lag", "memo mode and no anchorer address: set MONITOR_ANCHORER_ADDRESS");
    else {
      try {
        const memo = await appraiseMemoRoots(conn as unknown as MemoRpc, anchorer, { now: Math.floor(now.getTime() / 1000), network, maxLagHours: num(env.MONITOR_ANCHOR_MAX_LAG_HOURS, 3), maxLateSeconds: num(env.ANCHOR_MAX_LATE_SECONDS, DEFAULT_MAX_LATE_SECONDS) });
        for (const [name, v] of Object.entries(memo.checks)) set(name, v.ok, v.detail);
        Object.assign(result.values, memo.values);
      } catch (e) {
        skip("anchor.lag", `the anchorer's transactions could not be listed (${(e as Error).name})`);
      }
    }
  }

  // ---- Signer balances -----------------------------------------------------------------------------------------------------------
  // Public addresses come from the record (settlement, anchorer, slasher), from MONITOR_*_ADDRESS, or from the public half
  // of a role key in the env files. A monitoring box needs no secret: set the MONITOR_*_ADDRESS names there.
  const a = rec.authorities ?? {};
  const address = (override: string | undefined, secret: string | undefined, recordKey?: string) => override || signerAddress(secret) || (recordKey ? a[recordKey] : undefined) || null;
  const signers: [string, string | null, number][] = [
    ["settlement", address(env.MONITOR_SETTLEMENT_ADDRESS, env.SETTLEMENT_PRIVATE_KEY, "settlementAuthority"), num(env.MONITOR_SETTLEMENT_SOL_FLOOR, 0.05)],
    ["anchorer", address(env.MONITOR_ANCHORER_ADDRESS, env.ANCHORER_PRIVATE_KEY, a.anchorAuthority ? "anchorAuthority" : "authority"), num(env.MONITOR_ANCHORER_SOL_FLOOR, 0.05)],
    ["slasher", address(env.MONITOR_SLASHER_ADDRESS, env.SLASHER_PRIVATE_KEY, "slasher"), num(env.MONITOR_SLASHER_SOL_FLOOR, 0.02)],
    ["router", address(env.MONITOR_ROUTER_ADDRESS, env.ROUTER_PRIVATE_KEY), num(env.MONITOR_ROUTER_SOL_FLOOR, 0.05)],
    ["facilitator_relay", address(env.MONITOR_FACILITATOR_RELAY_ADDRESS, env.FACILITATOR_RELAY_PRIVATE_KEY), num(env.MONITOR_FACILITATOR_RELAY_SOL_FLOOR, 0.05)],
  ];
  for (const [role, addr, floor] of signers) {
    if (!addr) { skip(`signer.${role}.sol`, `no address: set MONITOR_${role.toUpperCase()}_ADDRESS`); continue; }
    const lamports = await conn.getBalance(new PublicKey(addr), "confirmed");
    result.values[`signer.${role}.address`] = addr;
    result.values[`signer.${role}.sol`] = Math.round((lamports / LAMPORTS) * 1e6) / 1e6;
    set(`signer.${role}.sol`, lamports / LAMPORTS >= floor, lamports / LAMPORTS < floor ? `${(lamports / LAMPORTS).toFixed(4)} SOL, floor ${floor}` : undefined);
  }
  const usdcMint = rec.mints?.usdc ?? env.USDC_ADDRESS;
  const tokenBalance = async (account: PublicKey): Promise<bigint | null> => {
    const info = await conn.getAccountInfo(account, "confirmed");
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return null;
    return unpackAccount(account, info, TOKEN_PROGRAM_ID).amount;
  };
  const settlement = signers[0]![1];
  if (settlement && usdcMint) {
    const floor = num(env.MONITOR_SETTLEMENT_USDC_FLOOR, 0);
    const bal = await tokenBalance(getAssociatedTokenAddressSync(new PublicKey(usdcMint), new PublicKey(settlement), true));
    result.values["settlement.usdc"] = bal === null ? null : usdc(bal);
    set("settlement.usdc", (bal === null ? 0 : usdc(bal)) >= floor, bal === null ? (floor > 0 ? "the settlement wallet has no USDC account" : undefined) : usdc(bal) < floor ? `${usdc(bal)} USDC, floor ${floor}` : undefined);
  } else skip("settlement.usdc", "no settlement address or USDC mint");

  // ---- Credits vault reconciliation ----------------------------------------------------------------------------------------------
  if (ids.trellis_credits && c.trellis_credits) {
    const vault = await tokenBalance(creditsPdas(ids.trellis_credits).vault);
    const unsettled = c.trellis_credits.spentTotal - c.trellis_credits.settledTotal;
    result.values["credits.vault_usdc"] = vault === null ? null : usdc(vault);
    result.values["credits.spent_unsettled_usdc"] = usdc(unsettled);
    set("credits.vault_covers_spend", vault !== null && vault >= unsettled, vault === null ? "the credits vault token account is missing" : vault < unsettled ? `vault ${usdc(vault)} USDC is below committed spend not yet settled (${usdc(unsettled)} USDC)` : undefined);
    try {
      // Every CreditAccount and RefundRequest of the program. A private RPC serves this without limits; a public one may refuse.
      const fetchAll = async (name: string) => (await conn.getProgramAccounts(ids.trellis_credits!, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: base58Encode(creditsIdl.accountDiscriminator(name)) } }] })).map((x) => creditsIdl.decodeAccount<Record<string, any>>(name, x.account.data)).filter(Boolean) as Record<string, any>[];
      const credit = await fetchAll("CreditAccount");
      const refunds = await fetchAll("RefundRequest");
      const open = credit.reduce((s, x) => s + BigInt(x.balance), 0n);
      const queued = refunds.filter((x) => !x.paid).reduce((s, x) => s + BigInt(x.amount), 0n);
      const owed = open + queued - c.trellis_credits.settledTotal;
      result.values["credits.accounts"] = credit.length;
      result.values["credits.open_balances_usdc"] = usdc(open);
      result.values["credits.queued_refunds_usdc"] = usdc(queued);
      set("credits.vault_covers_accounts", vault !== null && vault >= owed, vault !== null && vault < owed ? `vault ${usdc(vault)} USDC is below open balances + queued refunds - settled (${usdc(owed)} USDC)` : undefined);
      await ledgerCheck(env, vault, unsettled, set, skip, result);
    } catch (e) {
      skip("credits.vault_covers_accounts", `the RPC refused getProgramAccounts (${(e as Error).name}); use a private RPC`);
    }
  } else skip("credits.vault_covers_spend", "trellis_credits is not deployed or not initialised");

  // ---- What the settlement key did lately: the program's own events -----------------------------------------------------------------
  // A stolen settlement key shows up as a spent root that commits far more than was used, and as a payout to an account
  // nobody knows. Both are read from the recent transactions of the credits config account (every commit and every
  // settlement writes it), with bounded work per run and no cursor.
  if (ids.trellis_credits && c.trellis_credits) {
    const lookbackS = Math.max(600, num(env.MONITOR_EVENTS_LOOKBACK_HOURS, 6) * 3600);
    try {
      const recent = await readRecentTransactions(conn, creditsPdas(ids.trellis_credits).config, { since: chainNow - lookbackS, maxSignatures: Math.max(1, Math.min(1000, num(env.MONITOR_EVENTS_MAX_SIGNATURES, 200))), maxTransactions: Math.max(1, Math.min(500, num(env.MONITOR_EVENTS_MAX_TRANSACTIONS, 60))) });
      // The destinations a settlement may have: named token accounts, the USDC accounts of named wallets, the fee
      // router's vault, and with the database the wallets hosts are paid to.
      const ledger = o.ledger === undefined ? ledgerView(env) : o.ledger;
      const allow = new Set<string>(list(env.MONITOR_SETTLE_ALLOWLIST));
      const owners = new Set<string>(list(env.MONITOR_SETTLE_ALLOWLIST_OWNERS));
      let ledgerProblem: string | null = null;
      if (ledger) { try { for (const w of await ledger.payoutOwners()) owners.add(w); } catch (e) { ledgerProblem = `the payout addresses could not be read from the database (${(e as Error).name})`; } }
      if (usdcMint) for (const w of owners) { try { allow.add(getAssociatedTokenAddressSync(new PublicKey(usdcMint), new PublicKey(w), true).toBase58()); } catch { /* not an address: it allows nothing */ } }
      const feeVault = rec.accounts?.feeVault ?? (ids.trellis_fee_router ? feeRouterPdas(ids.trellis_fee_router).feeVault.toBase58() : null);
      if (feeVault) allow.add(feeVault);
      let ledgerRoots: Map<string, bigint> | null = null;
      const first = appraiseCreditsEvents(ids.trellis_credits, recent.txs, { maxDelta: 0n, vault: null, maxVaultPct: 100, allow });
      if (ledger && first.commits.length) { try { ledgerRoots = await ledger.spentRoots(first.commits.map((x) => x.root)); } catch (e) { ledgerProblem = `the spent roots could not be read from the database (${(e as Error).name})`; } }
      const found = appraiseCreditsEvents(ids.trellis_credits, recent.txs, { maxDelta: BigInt(Math.round(num(env.MONITOR_SPENT_DELTA_MAX_USDC, 2_500) * 1e6)), vault: vaultNow ?? await tokenBalance(creditsPdas(ids.trellis_credits).vault), maxVaultPct: Math.max(1, Math.min(100, num(env.MONITOR_SPENT_DELTA_MAX_VAULT_PCT, 50))), allow, ledgerRoots });
      result.values["events.lookback_hours"] = Math.round((lookbackS / 3600) * 10) / 10;
      result.values["events.transactions_read"] = recent.txs.length;
      result.values["events.spent_roots"] = found.commits.length;
      result.values["events.spent_root_max_delta_usdc"] = found.commits.length ? usdc(found.commits.reduce((m, x) => (x.delta > m ? x.delta : m), 0n)) : 0;
      result.values["events.settlements"] = found.settlements.length;
      result.values["events.settlements_unknown"] = found.settlements.filter((x) => !x.known).length;
      result.values["events.settle_allowlist_size"] = allow.size;
      const unreadable = [...(recent.why ? [recent.why] : []), ...(found.unreadable.length ? [`${found.unreadable.length} transaction(s) returned no log or a truncated one, so their events are unknown: ${found.unreadable.slice(0, 3).join(", ")}`] : []), ...(ledgerProblem ? [ledgerProblem] : [])];
      set("events.read", unreadable.length === 0, unreadable.length ? `${unreadable.join("; ")}. Raise MONITOR_EVENTS_MAX_SIGNATURES / MONITOR_EVENTS_MAX_TRANSACTIONS or shorten MONITOR_EVENTS_LOOKBACK_HOURS, and look at who is sending these transactions.` : undefined);
      const badCommits = found.commits.filter((x) => x.problems.length);
      set("events.spent_root_delta", badCommits.length === 0, badCommits.length ? `${badCommits.map((x) => `hour ${iso(x.hour)} (${x.signature}): ${x.problems.join("; ")}`).join(" | ")}. If the router did not commit this, the settlement key is compromised: pause settlements (pause.ts --settlements) and replace it.` : undefined);
      const unknown = found.settlements.filter((x) => !x.known);
      set("events.settle_destination", unknown.length === 0, unknown.length ? `${unknown.map((x) => `${usdc(x.amount)} USDC to ${x.to} (${x.signature})`).join("; ")}: not a known host payout account${allow.size ? "" : " (no allow-list is configured: set MONITOR_SETTLE_ALLOWLIST, MONITOR_SETTLE_ALLOWLIST_OWNERS or MONITOR_DATABASE_URL)"}. If nobody here paid it, pause settlements now (pause.ts --settlements).` : allow.size === 0 ? "no allow-list is configured: the first settlement will fail this check (MONITOR_SETTLE_ALLOWLIST, MONITOR_SETTLE_ALLOWLIST_OWNERS or MONITOR_DATABASE_URL)" : undefined);
      if (!ledger) skip("events.spent_root_ledger", "the hour's usage lives in the router's database: with MONITOR_DATABASE_URL every committed root is also held against the ledger's spent roots");
    } catch (e) {
      set("events.read", false, `the recent trellis_credits transactions could not be listed (${(e as Error).name}); the event checks did not run`);
    }
  }

  // ---- Attested gateway (through the router when a base URL is given) and sanctions (the router's database) ---------------------
  const get = async (u: string) => { try { const r = await fetcher(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) }); return { status: r.status, json: await r.json().catch(() => null) as any }; } catch { return null; } };
  const provider = env.MONITOR_GATEWAY_PROVIDER ?? "confidential-ai-gateway";
  const maxAgeMin = num(env.MONITOR_ATTESTATION_MAX_AGE_MIN, 30);
  if (o.base) {
    const r = await get(`${o.base}/api/v1/attestation/${encodeURIComponent(provider)}`);
    const d = r?.status === 200 ? r.json?.data : null;
    const ageMin = d?.attested_at ? (now.getTime() - Date.parse(d.attested_at)) / 60_000 : null;
    result.values["gateway.attestation_age_min"] = ageMin === null ? null : Math.round(ageMin * 10) / 10;
    set("gateway.attestation", d?.status === "attested" && ageMin !== null && ageMin <= maxAgeMin, !d ? `the router has no provider ${provider} (HTTP ${r?.status ?? "unreachable"})` : d.status !== "attested" ? `status ${String(d.status)}${d.reason ? ` (${String(d.reason)})` : ""}` : ageMin !== null && ageMin > maxAgeMin ? `last verified ${Math.round(ageMin)} min ago (limit ${maxAgeMin})` : undefined);
  } else {
    // No router to ask: read the gateway's own report. This shows the gateway serves a report bound to a fresh nonce
    // with an unexpired keyset; verifying the quote itself is the router's attestor.
    const attestationUrl = env.PRIVATE_AI_ATTESTATION_URL || (env.PRIVATE_AI_BASE_URL ? `${env.PRIVATE_AI_BASE_URL.replace(/\/$/, "")}/aci/attestation` : "");
    if (!attestationUrl) skip("gateway.attestation", "no router base URL and no PRIVATE_AI_ATTESTATION_URL");
    else {
      const nonce = randomBytes(32).toString("hex");
      const r = await get(`${attestationUrl}${attestationUrl.includes("?") ? "&" : "?"}nonce=${nonce}`);
      const report = r?.status === 200 ? r.json : null;
      const att = report?.attestation;
      let why: string | undefined;
      if (!report || !att) why = `the gateway returned no report (HTTP ${r?.status ?? "unreachable"})`;
      else {
        const keyset = att.workload_keyset;
        const digest = keyset && typeof keyset === "object" ? keysetDigest(keyset) : null;
        const nowS = now.getTime() / 1000;
        if (!digest || report.workload_keyset_digest !== digest) why = "the keyset digest does not match the served keyset";
        else if (att.report_data !== aciReportData(digest, nonce)) why = "the report does not bind the nonce this probe sent";
        else if (typeof keyset.not_after !== "number" || !(nowS < keyset.not_after)) why = "the keyset has expired";
        else if (typeof att.freshness?.stale_after === "number" && !(nowS < att.freshness.stale_after)) why = "the report is stale";
        else result.values["gateway.keyset_valid_hours"] = Math.round(((keyset.not_after - nowS) / 3600) * 10) / 10;
      }
      set("gateway.attestation", !why, why ?? "gateway report bound to a fresh nonce; the quote itself is verified by the router's attestor, not by this probe");
    }
  }
  // The list's age comes from the database in every case: GET /api/v1/network/sanctions is not on the core launch
  // surface (404 not_enabled), so asking the router could never pass there. No database to read is a failure, not a skip.
  const sanctions = await sanctionsCheck(env, now, sanctionsReader(env));
  result.values["sanctions.age_days"] = sanctions.ageDays;
  set("sanctions.fresh", sanctions.ok, sanctions.detail);
  return finish();
}

const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/**
 * The router's database as the event checks need it, through MONITOR_DATABASE_URL (a read-only role is enough); null
 * without one. Roots are stored as 0x-prefixed hex; payout wallets are the `payout_address` of providers paid in USDC
 * and the destinations of recorded payouts.
 */
function ledgerView(env: Record<string, string | undefined>): LedgerView | null {
  const url = pgUrl(env);
  if (!url) return null;
  const open = async () => { const { default: postgres } = await import("postgres"); return postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} }); };
  return {
    async spentRoots(roots) {
      const sql = await open();
      try {
        const wanted = roots.flatMap((r) => [r, `0x${r}`]);
        const rows = await sql`select root, total_spent_usdc::text as total from spent_roots where root in ${sql(wanted)}`;
        return new Map(rows.map((r) => [String(r.root).replace(/^0x/, "").toLowerCase(), BigInt(String(r.total))]));
      } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
    },
    async payoutOwners() {
      const sql = await open();
      try {
        const rows = await sql`select payout_address as address from providers where payout_mode = 'usdc' and payout_address is not null union select "to" as address from payouts where "to" is not null`;
        return rows.map((r) => String(r.address));
      } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
    },
  };
}

type Setter = (name: string, ok: boolean, detail?: string) => void;
type Skipper = (name: string, why: string) => void;
const pgUrl = (env: Record<string, string | undefined>) => (env.MONITOR_DATABASE_URL && /^postgres(?:ql)?:/.test(env.MONITOR_DATABASE_URL) ? env.MONITOR_DATABASE_URL : null);

/**
 * The ledger side of the reconciliation, opt-in through MONITOR_DATABASE_URL (a read-only PostgreSQL role is enough).
 * Positive account balances in the router ledger are what callers can still spend; the vault must hold them plus the
 * spend already committed on chain and not yet paid to hosts. Accounts that mirror tabs (`tab_...`) are funded by tab
 * escrows, not by the credits vault, and are left out. Ledger amounts are in pico-USD (1e-12); USDC base units are 1e-6.
 */
async function ledgerCheck(env: Record<string, string | undefined>, vault: bigint | null, unsettled: bigint, set: Setter, skip: Skipper, result: ChainResult): Promise<void> {
  const url = pgUrl(env);
  if (!url) { skip("credits.vault_covers_ledger", "the ledger lives in the router's database: set MONITOR_DATABASE_URL to a PostgreSQL URL (a read-only role is enough)"); return; }
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  try {
    const rows = await sql`select coalesce(sum(balance), 0)::text as pico from accounts where balance > 0 and id not like 'tab\_%'`;
    const liabilities = BigInt(String(rows[0]!.pico).split(".")[0]!) / 1_000_000n;
    const tolerance = BigInt(Math.round(num(env.MONITOR_LEDGER_TOLERANCE_USDC, 1) * 1e6));
    result.values["credits.ledger_liabilities_usdc"] = usdc(liabilities);
    set("credits.vault_covers_ledger", vault !== null && vault + tolerance >= liabilities + unsettled, vault !== null && vault + tolerance < liabilities + unsettled ? `vault ${usdc(vault)} USDC is below ledger balances ${usdc(liabilities)} + unsettled spend ${usdc(unsettled)} USDC` : undefined);
  } catch (e) {
    set("credits.vault_covers_ledger", false, `the ledger query failed (${(e as Error).name})`);
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
}

/** The row the router's sanctions-refresh job writes (src/network/sanctions.ts): the publication date of the loaded list. */
export const SANCTIONS_LIST_SQL = "select list_date from sanctions_meta where id = 1";
/** Reads that date: null when no list has been loaded; throws when it cannot be read. */
export type SanctionsRead = () => Promise<unknown>;
/** A list dated further ahead of this clock than this is not believed (the router refuses a future date when it loads one). */
const SANCTIONS_AHEAD_TOLERANCE_MS = 3_600_000;

/** The reader behind MONITOR_DATABASE_URL (a read-only PostgreSQL role is enough); null without one. */
export function sanctionsReader(env: Record<string, string | undefined>): SanctionsRead | null {
  const url = pgUrl(env);
  if (!url) return null;
  return async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    try {
      const rows = await sql.unsafe(SANCTIONS_LIST_SQL);
      return rows[0]?.list_date ?? null;
    } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
  };
}

/**
 * sanctions.fresh: screening is enabled in the env files and the loaded list is inside SANCTIONS_MAX_AGE_DAYS (the
 * router's own rule: closure refunds stop past it). It passes only on a date that was read: no database to read, a
 * failed read, no list, an unreadable date or a date ahead of this clock all fail.
 */
export async function sanctionsCheck(env: Record<string, string | undefined>, now: Date, read: SanctionsRead | null): Promise<{ ok: boolean; detail?: string; ageDays: number | null }> {
  const fail = (detail: string, ageDays: number | null = null) => ({ ok: false, detail, ageDays });
  if (!read) return fail("the list's age is in the router's database and no router route on the core surface carries it: set MONITOR_DATABASE_URL to a PostgreSQL URL (a read-only role is enough)");
  let value: unknown;
  try { value = await read(); } catch (e) { return fail(`the sanctions list could not be read from the database (${e instanceof Error ? e.name : "error"})`); }
  if (value === null) return fail("no sanctions list has been loaded");
  const listed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(listed)) return fail("the sanctions list's date could not be read");
  const ahead = listed - now.getTime();
  if (ahead > SANCTIONS_AHEAD_TOLERANCE_MS) return fail(`the list is dated in the future (${new Date(listed).toISOString().slice(0, 10)}): this clock or the row is wrong`);
  const age = Math.max(0, -ahead) / 86_400_000;
  const ageDays = Math.round(age * 10) / 10;
  const maxAge = num(env.SANCTIONS_MAX_AGE_DAYS, 7);
  const enabled = ["1", "true", "yes", "on"].includes(String(env.SANCTIONS_SCREENING_ENABLED ?? "").toLowerCase());
  if (!enabled) return fail("SANCTIONS_SCREENING_ENABLED is not true in the env files", ageDays);
  if (age > maxAge) return fail(`the list is ${Math.round(age)} days old (limit ${maxAge} days)`, ageDays);
  return { ok: true, ageDays };
}

/** Prometheus text for a chain result: the gauges monitoring/alerts.yml (group trellis-chain) reads. */
export function chainMetrics(r: ChainResult): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    "# HELP trellis_chain_monitor_ok 1 when every chain check passes.",
    "# TYPE trellis_chain_monitor_ok gauge",
    `trellis_chain_monitor_ok ${r.ok ? 1 : 0}`,
    "# HELP trellis_chain_check One chain check: 1 passes, 0 fails.",
    "# TYPE trellis_chain_check gauge",
    ...Object.entries(r.checks).map(([k, v]) => `trellis_chain_check{check="${esc(k)}"} ${v ? 1 : 0}`),
    "# HELP trellis_chain_last_run_timestamp_seconds When the checks last ran.",
    "# TYPE trellis_chain_last_run_timestamp_seconds gauge",
    `trellis_chain_last_run_timestamp_seconds ${Math.floor(Date.parse(r.at) / 1000)}`,
  ];
  const gauge = (name: string, help: string, rows: [string, number][]) => { if (rows.length) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows.map(([labels, v]) => `${name}${labels} ${v}`)); };
  const n = (k: string) => (typeof r.values[k] === "number" ? (r.values[k] as number) : null);
  gauge("trellis_chain_anchor_lag_hours", "Hours since the last receipt root on chain.", n("anchor.lag_hours") === null ? [] : [["", n("anchor.lag_hours")!]]);
  gauge("trellis_chain_signer_sol", "SOL balance of a role key.", Object.keys(r.values).filter((k) => /^signer\.[a-z_]+\.sol$/.test(k) && n(k) !== null).map((k) => [`{role="${k.split(".")[1]}"}`, n(k)!] as [string, number]));
  gauge("trellis_chain_settlement_usdc", "USDC balance of the settlement wallet.", n("settlement.usdc") === null ? [] : [["", n("settlement.usdc")!]]);
  gauge("trellis_chain_credits_vault_usdc", "USDC in the credits vault.", n("credits.vault_usdc") === null ? [] : [["", n("credits.vault_usdc")!]]);
  gauge("trellis_chain_credits_spent_unsettled_usdc", "Committed spend not yet settled to hosts.", n("credits.spent_unsettled_usdc") === null ? [] : [["", n("credits.spent_unsettled_usdc")!]]);
  gauge("trellis_chain_sanctions_age_days", "Age of the sanctions list in days.", n("sanctions.age_days") === null ? [] : [["", n("sanctions.age_days")!]]);
  // Pauses, by slot (trellis_credits.deposits, trellis_credits.settlements, trellis_tab, ...).
  const slots = Object.keys(r.values).filter((k) => /^pause\..+\.active$/.test(k)).map((k) => k.slice("pause.".length, -".active".length));
  const bySlot = (suffix: string) => slots.filter((x) => n(`pause.${x}.${suffix}`) !== null).map((x) => [`{slot="${esc(x)}"}`, n(`pause.${x}.${suffix}`)!] as [string, number]);
  gauge("trellis_chain_pause_active", "1 while a pause is in force (flag set and its expiry ahead).", bySlot("active"));
  gauge("trellis_chain_pause_lapsed", "1 while a pause flag is set but the pause has lapsed.", bySlot("lapsed"));
  gauge("trellis_chain_pause_seconds_left", "Seconds until a pause in force lapses by itself; 0 when none is.", bySlot("seconds_left"));
  gauge("trellis_chain_pause_set_by_guardian", "1 when the pause whose flag is set was set by the guardian (0: the authority, or not known).", slots.filter((x) => r.values[`pause.${x}.by`] !== null && r.values[`pause.${x}.by`] !== undefined).map((x) => [`{slot="${esc(x)}"}`, r.values[`pause.${x}.by`] === "guardian" ? 1 : 0] as [string, number]));
  gauge("trellis_chain_guardian_cooldown_seconds", "Seconds until the guardian may pause this slot again; 0 when it may.", bySlot("guardian_cooldown_s"));
  // Proposals, by program; absent when a program has none.
  const proposed = Object.keys(r.values).filter((k) => /^proposal\..+\.state$/.test(k)).map((k) => k.slice("proposal.".length, -".state".length));
  gauge("trellis_chain_proposals_pending", "Pending proposals (config changes and authority hand-overs) over all programs.", n("config.proposals_pending") === null ? [] : [["", n("config.proposals_pending")!]]);
  gauge("trellis_chain_proposal_state", "1 for the state a program's pending proposal is in: pending, applicable or expired.", proposed.map((x) => [`{program="${esc(x)}",state="${esc(String(r.values[`proposal.${x}.state`]))}"}`, 1] as [string, number]));
  gauge("trellis_chain_proposal_seconds_to_effective", "Seconds until a pending proposal can be applied; 0 once it can.", proposed.map((x) => [`{program="${esc(x)}"}`, n(`proposal.${x}.seconds_to_effective`) ?? 0] as [string, number]));
  gauge("trellis_chain_proposal_seconds_to_expiry", "Seconds until a proposal can no longer be applied; 0 once expired.", proposed.map((x) => [`{program="${esc(x)}"}`, n(`proposal.${x}.seconds_to_expiry`) ?? 0] as [string, number]));
  gauge("trellis_chain_proposal_changes", "1 when a program's pending proposal would change this role.", proposed.flatMap((x) => (["authority", "guardian"] as const).map((role) => [`{program="${esc(x)}",role="${role}"}`, n(`proposal.${x}.changes_${role}`) ?? 0] as [string, number])));
  // The outflow limiter and the build each program reports.
  gauge("trellis_chain_limiter_rate_bps", "Share of the credits vault that may leave per window, in bps.", n("limiter.rate_bps") === null ? [] : [["", n("limiter.rate_bps")!]]);
  for (const [metric, key, help] of [["trellis_chain_limiter_allowance_usdc", "allowance_usdc", "USDC an outflow allowance holds right now."], ["trellis_chain_limiter_burst_usdc", "burst_usdc", "The most an outflow allowance can hold at once."], ["trellis_chain_limiter_window_cap_usdc", "window_cap_usdc", "The most that can leave through an allowance over one window."]] as const)
    gauge(metric, help, (["settle", "refund"] as const).filter((kind) => n(`limiter.${kind}_${key}`) !== null).map((kind) => [`{kind="${kind}"}`, n(`limiter.${kind}_${key}`)!] as [string, number]));
  gauge("trellis_chain_build_profile", "The profile byte a deployed program reports through build_profile: 0 is the mainnet build, 1 the devnet feature.", Object.keys(r.values).filter((k) => /^build\..+\.profile$/.test(k) && n(k) !== null).map((k) => [`{program="${esc(k.slice("build.".length, -".profile".length))}"}`, n(k)!] as [string, number]));
  gauge("trellis_chain_spent_root_max_delta_usdc", "Largest spent-root delta committed inside the look-back window.", n("events.spent_root_max_delta_usdc") === null ? [] : [["", n("events.spent_root_max_delta_usdc")!]]);
  gauge("trellis_chain_settlements_unknown", "Settlements inside the look-back window that went to a token account outside the allow-list.", n("events.settlements_unknown") === null ? [] : [["", n("events.settlements_unknown")!]]);
  gauge("trellis_chain_gateway_attestation_age_minutes", "Minutes since the attested gateway last verified.", n("gateway.attestation_age_min") === null ? [] : [["", n("gateway.attestation_age_min")!]]);
  return lines.join("\n") + "\n";
}

/** A short table for people; the JSON line carries the same facts for machines. */
export function chainSummary(r: ChainResult): string {
  const names = [...new Set([...Object.keys(r.checks), ...Object.keys(r.skipped)])];
  const width = Math.max(...names.map((s) => s.length), 10);
  const rows = names.map((name) => {
    const state = name in r.checks ? (r.checks[name] ? "ok  " : "FAIL") : "skip";
    const detail = name in r.checks ? r.details[name] ?? "" : r.skipped[name];
    return `  ${state} ${name.padEnd(width)}  ${detail}`.trimEnd();
  });
  const values = Object.entries(r.values).map(([k, v]) => `  ${k.padEnd(34)} ${v === null ? "-" : v}`);
  return [`Trellis chain monitor: ${r.cluster} via ${r.rpc} at ${r.at}`, ...rows, "values", ...values, r.ok ? "result: every check passes" : `result: ${r.failing.length} failing (${r.failing.join(", ")})`].join("\n");
}
