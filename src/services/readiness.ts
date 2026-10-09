import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { anchors, spentRoots, chainCursor, kv, providers } from "../db/schema.ts";
import type { JobSnapshot } from "./jobs.ts";
import { attestationFresh } from "../router/select.ts";
import { escrowFinality, escrowReviewsOpen, peekTrlsQuote } from "../solana/escrow.ts";
import { reconcileSpentRoots } from "./root-completeness.ts";
import { backupFresh } from "./backup.ts";
import { verifiersConfigured } from "./attestor-verifiers.ts";
import { gatewayPinWarnings, unpinnedGateways } from "./attestor.ts";
import { creditsIndexerHealth } from "../solana/credits-indexer.ts";
import { creditClosures } from "../solana/credits-schema.ts";
import { singleFlight } from "../hardening/single-flight.ts";

// One-day production timelock plus one day for review/execution. Submission failures retain the 2-minute bound.
export const ROOT_REVIEW_SLA_MS = 48 * 3_600_000;
export const CRITICAL_JOBS = ["chain-indexer", "catalog-refresh", "provider-registry", "receipts-anchor", "settlement"];
// PAYMENTS_MODE=escrow has no Trellis contracts: receipts stay signed locally, no settlement runs,
// and chain health is the escrow watcher's progress.
export const ESCROW_CRITICAL_JOBS = ["escrow-indexer", "catalog-refresh", "provider-registry", "receipts-anchor"];
// The escrow cursor follows the chain's finality point, which advances in steps (one L1 epoch, ~3,700
// Solana blocks), so allow a few steps of lag; the escrow-indexer heartbeat catches a stalled
// watcher much sooner. A finality point more than an hour behind the head means credits have stalled.
export const ESCROW_MAX_CURSOR_LAG = 12_000n;
export const ESCROW_MAX_FINALITY_LAG_S = 3_600;
export function jobReady(state: JobSnapshot | undefined, now = Date.now()) {
  if (!state || state.last_error || !state.last_success || !(state.every_ms > 0)) return false;
  const age = now - Date.parse(state.last_success);
  return Number.isFinite(age) && age >= 0 && age <= Math.max(state.every_ms * 2, 60_000);
}
function configuredEndpoint(value: string | undefined) {
  if (!value) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Readiness timeout")), 2000); })]);
  } finally { clearTimeout(timer!); }
}

export type ReadinessWarning = { code: string; reason: string; message: string };

/**
 * Conditions that do not make the router unready but that an operator should see. $TRLS deposits wait while its
 * pool price is unavailable (a swinging, thin or unreadable pool); the router keeps serving and crediting
 * everything else, so this is a warning, not a failed check. It reads the last cached price and never waits for one.
 */
export function readinessWarnings(ctx: Ctx): ReadinessWarning[] {
  const quote = peekTrlsQuote(ctx);
  return quote && !quote.available ? [{ code: "trls_price_unavailable", reason: quote.code, message: quote.message }] : [];
}

export const DEPOSIT_RECONCILIATION_KEY = "deposit_reconciliation_status";
/** What the settlement job's last deposit reconciliation found (written by runSettlement); null before its first run. */
export async function depositReconciliationStatus(db: Ctx["db"]): Promise<{ ok: boolean; checked: number; mismatches: number; at: string } | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, DEPOSIT_RECONCILIATION_KEY));
  return (row?.value as { ok: boolean; checked: number; mismatches: number; at: string } | undefined) ?? null;
}

/**
 * Conditions of the credits path that need an operator's eye without failing readiness: transactions in the indexer's
 * quarantine, a signature backlog the walk is still working through, a closure held because its key was disabled.
 */
export async function creditsWarnings(ctx: Ctx): Promise<ReadinessWarning[]> {
  const out: ReadinessWarning[] = [];
  const health = await creditsIndexerHealth(ctx);
  if (health.quarantined > 0) out.push({ code: "indexer_quarantine", reason: "transactions_quarantined", message: `${health.quarantined} transaction(s) of the credits program could not be processed and are being retried.` });
  if (health.walking) out.push({ code: "indexer_backlog", reason: "signature_backlog", message: "The credits indexer is working through a backlog of signatures; deposits are credited from chain state meanwhile." });
  const [held] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(creditClosures).where(and(eq(creditClosures.status, "registered"), eq(creditClosures.reason, "key_disabled")));
  if (held?.n) out.push({ code: "closure_held", reason: "key_disabled", message: `${held.n} account closure(s) are held because their key was disabled; an owner of the account can release them.` });
  return out;
}

/** Public readiness never exposes exception text, credentials, hostnames or RPC URLs.
 * Worker heartbeats are persisted, so API replicas can observe a separate worker. */
export async function readiness(ctx: Ctx) {
  const checks: Record<string, boolean> = {};
  const escrowMode = ctx.cfg.escrow.mode === "escrow";
  await Promise.all([
    (async () => { try { await bounded(async () => { await ctx.db.execute(sql`select 1`); }); checks.database = true; } catch { checks.database = false; } })(),
    (async () => {
      try {
        await bounded(async () => {
          await ctx.catalog.refresh();
          checks.providers = [...ctx.catalog.offersByModel.values()].some((rows) => rows.some((o) => o.status === "live" && o.provider.status === "live"));
          const livePrivateProviders = ctx.cfg.production
            ? await ctx.db.select({ teeKind: providers.teeKind }).from(providers).where(and(eq(providers.status, "live"), isNotNull(providers.teeKind)))
            : [];
          const privateRoutingEnabled = livePrivateProviders.some((p) => !!p.teeKind && p.teeKind !== "dev");
          // Every non-dev report passes through the configured quote verifiers (DCAP by default); NVIDIA confidential-computing
          // reports also require the separate NRAS verification endpoint.
          checks.private_attestation_verifiers = !privateRoutingEnabled || (
            verifiersConfigured(ctx.cfg.attestation) &&
            (!livePrivateProviders.some((p) => p.teeKind === "nvidia-cc") || configuredEndpoint(ctx.cfg.attestation.nrasUrl))
          );
          if (privateRoutingEnabled) {
            const liveAttested = [...ctx.catalog.offersByModel.values()].flat().some((o) =>
              o.status === "live" && o.provider.status === "live" && !!o.provider.teeKind && o.provider.teeKind !== "dev" &&
              attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, true));
            checks.private_attestation = liveAttested;
          }
          // An attested gateway with no measurement allow-list is not attested where one is required (always in
          // production; services/attestor.ts): not ready until an operator pins the release it appraised.
          if (ctx.cfg.attestation.requireAllowlist) checks.attested_gateway_allowlist = (await unpinnedGateways(ctx)).length === 0;
          const staleBefore = new Date(Date.now() - 120_000);
          const [anchorBacklog, rootBacklog, approvalBacklog] = await Promise.all([
            ctx.db.select({ id: anchors.index }).from(anchors).where(and(inArray(anchors.status, escrowMode ? ["pending"] : ["pending", "local"]), lt(anchors.createdAt, staleBefore))).limit(1),
            ctx.db.select({ id: spentRoots.epoch }).from(spentRoots).where(and(eq(spentRoots.status, "pending"), lt(spentRoots.createdAt, staleBefore))).limit(1),
            ctx.db.select({ id: spentRoots.epoch }).from(spentRoots).where(and(eq(spentRoots.status, "awaiting_approval"), lt(spentRoots.createdAt, new Date(Date.now() - ROOT_REVIEW_SLA_MS)))).limit(1),
          ]);
          checks.settlement_review = !approvalBacklog.length;
          checks.chain_submissions = !anchorBacklog.length && !rootBacklog.length;
          const requiredJobs = [...(escrowMode ? ESCROW_CRITICAL_JOBS : CRITICAL_JOBS), ...(privateRoutingEnabled ? ["attestor"] : [])];
          const states = await ctx.db.select().from(kv).where(inArray(kv.key, requiredJobs.map((n) => `job-health:${n}`)));
          for (const name of requiredJobs) checks[name] = jobReady(states.find((r) => r.key === `job-health:${name}`)?.value as JobSnapshot | undefined);
        });
      } catch { checks.workers = false; checks.providers = false; }
    })(),
    (async () => {
      // LAUNCH_TIER=minimal has no Trellis program to index (pay-per-call only): the chain is ready when the RPC answers
      // for the configured cluster. Every other tier needs its programs and the indexer's cursor, as before.
      const minimal = !escrowMode && ctx.cfg.launch?.tier === "minimal" && !ctx.cfg.chain.credits && !ctx.cfg.chain.callPay;
      if (!escrowMode && !minimal && !ctx.cfg.chain.credits && !ctx.cfg.chain.callPay) { checks.chain = false; return; }
      try {
        await bounded(async () => {
          if (minimal) {
            const [head, chainId] = await Promise.all([ctx.chain.blockNumber(), ctx.chain.client.getChainId()]);
            checks.chain = chainId === ctx.cfg.chain.id && head > 0n;
            return;
          }
          if (escrowMode) {
            // Escrow credits only final blocks, so the watcher is measured against the finality point.
            const [fin, chainId] = await Promise.all([escrowFinality(ctx), ctx.chain.client.getChainId()]);
            if (chainId !== ctx.cfg.chain.id) throw new Error("Chain mismatch");
            const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, "escrow"));
            checks.chain = !!cursor && fin.creditable - cursor.block <= ESCROW_MAX_CURSOR_LAG && cursor.block <= fin.head;
            checks.escrow_finality = fin.headTime - fin.finalTime <= ESCROW_MAX_FINALITY_LAG_S;
            return;
          }
          const [head, chainId] = await Promise.all([ctx.chain.blockNumber(), ctx.chain.client.getChainId()]);
          if (chainId !== ctx.cfg.chain.id) throw new Error("Chain mismatch");
          const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, "main"));
          const maxLag = Math.max(ctx.cfg.chain.confirmations + 20, 30);
          checks.chain = !!cursor && head - cursor.block <= BigInt(maxLag) && cursor.block <= head;
        });
      } catch { checks.chain = false; if (escrowMode) checks.escrow_finality = false; }
    })(),
    (async () => {
      if (!escrowMode) return;
      // A reversed credit or a final transfer that left the canonical chain stays an alert until an operator
      // marks it reviewed (escrow_deposits.reviewed_at).
      try { checks.escrow_reconciliation = (await bounded(() => escrowReviewsOpen(ctx.db))).length === 0; } catch { checks.escrow_reconciliation = false; }
    })(),
    (async () => {
      if (escrowMode) return;
      // No credits program in this launch tier: there is no custody to control, and nothing is reported as if there were.
      if (ctx.cfg.launch?.tier === "minimal" && !ctx.cfg.chain.credits) return;
      try { checks.custody_controls = await bounded(() => ctx.chain.custodyControlsReady()); } catch { checks.custody_controls = false; }
    })(),
    (async () => {
      // Every funded key is in the latest spent root and no leaf overspends its key (Credits cannot check either).
      if (escrowMode) return;
      try { checks.root_completeness = (await bounded(() => reconcileSpentRoots(ctx.db, { graceMs: ROOT_REVIEW_SLA_MS + 2 * ctx.cfg.workers.settlementIntervalMs }))).ok; } catch { checks.root_completeness = false; }
    })(),
    (async () => {
      // The settlement job stops every vault outflow when the ledger holds deposits the chain does not back
      // (`deposit_reconciliation_failed`): that state is a page, not a log line. No run yet reads as ready.
      if (escrowMode || !ctx.cfg.chain.credits) return;
      try { checks.deposit_reconciliation = (await bounded(() => depositReconciliationStatus(ctx.db)))?.ok !== false; } catch { checks.deposit_reconciliation = false; }
    })(),
    (async () => {
      // The credits indexer is holding a transaction it could not process, older than its alarm age, that touched the
      // program or may have (security re-review RR-08): deposits are still credited from chain state, but someone looks.
      if (escrowMode || !ctx.cfg.chain.credits) return;
      try { checks.credits_indexer = (await bounded(() => creditsIndexerHealth(ctx))).ok; } catch { checks.credits_indexer = false; }
    })(),
    (async () => {
      try { await bounded(() => ctx.limiter.take("readiness", 0, 1, 60_000)); checks.rate_limiter = true; } catch { checks.rate_limiter = false; }
    })(),
    (async () => {
      // Opt-in, so deployments without the scheduled off-host backup keep their current readiness.
      if (!ctx.cfg.backup.required) return;
      try { checks.backup_fresh = await bounded(() => backupFresh(ctx)); } catch { checks.backup_fresh = false; }
    })(),
  ]);
  // Program mode: the anchor program is configured. Memo mode: the anchorer key that signs the hourly line is known.
  if (!escrowMode) checks.receipt_anchor_configured = ctx.cfg.launch?.anchor.mode === "memo" && !ctx.cfg.chain.receiptAnchor ? !!ctx.cfg.launch.anchor.anchorer : !!ctx.cfg.chain.receiptAnchor;
  // R4-27: a receipt root in conflict (the anchorer key signed another root for the hour) and a root no verifier accepts
  // (late, or not signed by the key published for its hour) are failed checks for 48 hours after the hour closed; the
  // audit's alarms are warnings (services/anchor.ts `anchorHealth`).
  const anchorNotes: ReadinessWarning[] = [];
  if (!escrowMode) {
    try {
      const a = await bounded(() => import("./anchor.ts").then((m) => m.anchorHealth(ctx)));
      checks.anchor_roots_unique = a.conflicts === 0;
      checks.anchor_roots_verifiable = a.refused === 0;
      if (a.auditBehind) anchorNotes.push({ code: "anchor_audit_behind", reason: "audit_behind", message: "The audit of the anchorer key's history has not reached the head of that history for two hours; no new receipt root is posted until it has (the roots already sent are still followed by signature)." });
      if (a.unexpectedRotation) anchorNotes.push({ code: "anchor_unexpected_rotation", reason: "unexpected_rotation", message: "The anchorer key signed a hand-over to a key this router does not publish." });
      if (a.keyMisuse) anchorNotes.push({ code: "anchor_key_misuse", reason: "foreign_line", message: "The anchorer key signed a root line this router did not send and that cannot count (for an hour that had not begun, or one the key does not hold)." });
    } catch { checks.anchor_roots_unique = false; checks.anchor_roots_verifiable = false; }
  }
  const chain = !escrowMode && ctx.cfg.chain.credits ? await bounded(() => creditsWarnings(ctx)).catch(() => []) : [];
  // R3-02: a provider reported usage above a hold (services/hold-watch.ts); a warning, with its own alert rule.
  const holdsExceeded = await bounded(() => import("./hold-watch.ts").then((m) => m.holdWarnings(ctx))).catch(() => []);
  // R4-02, R4-04, R4-01: estimated settlements and the provider reconciliation, the closure-refund queue, stuck jobs.
  const round4 = await bounded(() => import("./round4-warnings.ts").then((m) => m.round4Warnings(ctx))).catch(() => []);
  // R5-03: an attested gateway's evidence no longer matches its measurement pin (services/attestor.ts); own alert rule.
  const gatewayPinNotes = await bounded(() => gatewayPinWarnings(ctx)).catch(() => []);
  return { ok: Object.values(checks).every(Boolean), checks, warnings: [...readinessWarnings(ctx), ...chain, ...holdsExceeded, ...round4, ...anchorNotes, ...gatewayPinNotes] };
}

const flights = new WeakMap<Ctx, () => ReturnType<typeof readiness>>();
/**
 * What GET /ready and /ready/metrics answer with (security review R5-05): one `readiness` computation at a time, kept
 * for READY_CACHE_MS, whoever and however many ask. A result that is not ok is kept no longer than one that is, and a
 * computation that throws is not kept at all (hardening/single-flight.ts has the invariants). Jobs and tests that need
 * the state as of now call `readiness` itself.
 */
export function cachedReadiness(ctx: Ctx): ReturnType<typeof readiness> {
  let get = flights.get(ctx);
  if (!get) flights.set(ctx, (get = singleFlight(ctx.cfg.hardening.readyCacheMs, () => readiness(ctx))));
  return get();
}
