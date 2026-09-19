import { enforceCoreKeySpec } from "../surface/request.ts";
import { compatibilityFields, keyPagination, provisionedScope } from "../provisioning/keys.ts"; // ZK6
import type { Context, Hono } from "hono";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { agentSessions, byokKeys, generations, keys, kv, ledger, teamMembers, teams } from "../db/schema.ts";
import { deriveKey, generateApiKey } from "../solana/keys.ts";
import { PublicKey } from "@solana/web3.js";
import { ADDRESS_RE } from "../solana/constants.ts";
import { buildCancelCloseByOwnerTransaction, buildCancelCloseTransaction, buildCloseAccountTransaction, buildCloseByOwnerTransaction, buildDepositTransaction, buildRegisterOwnerTransaction, buildSetRefundDestinationTransaction, closurePayableAt, readKeyCancelBlockedUntil, creditAccountAddress, creditsAccounts, creditsProgram, formatUsdc, parseUsdcAmount, readCreditAccount, readDepositorShare, readRefundRequest } from "../solana/credits.ts";
import { creditClosures, type RefundPlanItem } from "../solana/credits-schema.ts";
import { sharesAndLots } from "../solana/credits-shares.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { fastCreditFields } from "../solana/fast-credit-state.ts"; // V97
import { depositTiming } from "../solana/deposit-progress.ts"; // V97B
import { faucetDeposit, faucetEnabled } from "../solana/faucet.ts";
import { balanceOf, ensureAccount } from "../ledger/ledger.ts";
import { encrypt, uid, randomHex } from "../lib/util.ts";
import { isWalletAddress, verifyWalletSignature, WALLET_ADDRESS_RE, WALLET_SIGNATURE_RE, WALLET_SIGN_IN_STATEMENT, WALLET_SIGN_IN_VERSION, walletSignInMessage, type WalletSignIn } from "../lib/wallet-sig.ts";
import { addressBucket, readJson } from "./common.ts";
import { parseStoredTracing, sealTracing, tracingInput, tracingJson } from "../services/tracing.ts";
import { bearer, registerRootKey, requireKey, requireRole, ROLE_RANK, walletAccountId, type KeyRow, type Role } from "./auth.ts";
import { actorOf, appendAudit, type AuditDetail } from "../teams/audit.ts";
import { assertFitsOrgBudget } from "../teams/org.ts";
import { topupInput, topupJson, topupsThisWeek } from "../ledger/topup.ts";

const keySpec = z.object({
  include_byok_in_limit: z.boolean().optional(), // ZK6
  scope: z.enum(["inference", "account"]).optional(), // ZK6: create only
  name: z.string().max(100).optional(),
  limit: z.number().nonnegative().nullable().optional(), // USD (OpenRouter provisioning API name)
  budget_usd: z.number().nonnegative().nullable().optional(), // alias of limit
  limit_reset: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
  rpm: z.number().int().positive().nullable().optional(),
  tpm: z.number().int().positive().nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
  team: z.string().nullable().optional(),
  pay_with_default: z.string().max(16).nullable().optional(),
  disabled: z.boolean().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  guardrails: z
    .object({ pii: z.enum(["redact", "block"]).optional(), deny_patterns: z.array(z.string()).max(50).optional(), max_input_chars: z.number().int().positive().optional(), redact_output: z.boolean().optional() })
    .nullable()
    .optional(),
  routing: z.record(z.string(), z.unknown()).nullable().optional(),
  management: z.boolean().optional(),
  // Trace export for this key's public-lane calls; null removes it. Secrets are sealed and never returned.
  tracing: tracingInput.nullable().optional(),
  role: z.enum(["admin", "dev", "member", "viewer", "agent"]).optional(), // the key's role in its team (default member)
  // Auto top-up of the key's limit from the account's credits (src/ledger/topup.ts); null clears it. PATCH only.
  topup: topupInput.nullable().optional(),
});

export function keyJson(k: KeyRow) {
  return {
    ...compatibilityFields(k), // ZK6: additive exact counters and issuer fields
    hash: k.keyHash,
    name: k.name,
    label: k.label,
    disabled: k.disabled,
    limit: k.budget != null ? picoToUsd(k.budget) : null,
    limit_reset: k.budgetReset,
    limit_remaining: k.budget != null ? picoToUsd(k.budget - k.spent > 0n ? k.budget - k.spent : 0n) : null,
    usage: picoToUsd(k.spentTotal),
    usage_period: picoToUsd(k.spent),
    rpm: k.rpm,
    tpm: k.tpm,
    allowed_models: k.allowedModels,
    team: k.teamId,
    pay_with_default: k.payWithDefault,
    management: k.management,
    guardrails: k.guardrails,
    tracing: tracingJson(k.tracing),
    topup: topupJson(k.topup),
    chain_key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    created_at: k.createdAt.toISOString(),
    last_used: k.lastUsed?.toISOString() ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
  };
}

function depositInfo(ctx: Ctx, k: Pick<KeyRow, "chainKeyHash" | "keyAddress">) {
  const program = creditsProgram(ctx.cfg);
  const pdas = program ? creditsAccounts(program) : null;
  return {
    chain: ctx.cfg.chain.id,
    network: ctx.cfg.chain.network,
    token: ctx.cfg.chain.usdc,
    credits_contract: ctx.cfg.chain.credits ?? null,
    credits_program: ctx.cfg.chain.credits ?? null,
    credit_account: program ? creditAccountAddress(program, k.chainKeyHash).toBase58() : null,
    // The program's USDC vault (a token account PDA) and its owner, the config PDA: a Solana Pay transfer to the vault
    // names the owner as recipient. The transfer must carry the key hash (as a base58 public key) as a reference account.
    vault: pdas ? pdas.vault.toBase58() : null,
    vault_authority: pdas ? pdas.config.toBase58() : null,
    key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    cap_usdc: formatUsdc(ctx.cfg.solana.caps.creditsUnits),
    how: `POST /api/v1/credits/deposit-tx with {amount, payer} returns an unsigned Solana transaction (trellis_credits::deposit) for your wallet to sign; or send it as a Solana Pay transaction request. USDC is credited once the transaction is finalized, usually seconds. Credits are spend-only: there is no withdrawal, only an account closure refund after ${Math.round(ctx.cfg.solana.closureDelayMs / 3_600_000)}h.`,
  };
}

async function sub(ctx: Ctx, c: Context): Promise<KeyRow> {
  return requireKey(ctx, c.req.header("authorization"));
}

async function ownedKey(ctx: Ctx, caller: KeyRow, hash: string) {
  const [k] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, caller.accountId)));
  if (!k) fail(404, "Key not found.", "not_found");
  if (!caller.management) {
    // Team admins manage keys in their own team only.
    if (!caller.teamId || k.teamId !== caller.teamId) fail(403, "This key cannot manage that key.", "forbidden");
  }
  return k;
}

/** The keys.tracing update for a spec: sealed with APP_SECRET; a secret left out keeps the stored one (same type). */
function tracingPatch(ctx: Ctx, v: z.infer<typeof keySpec>, prev: unknown) {
  if (v.tracing === undefined) return {};
  return { tracing: v.tracing === null ? null : sealTracing(ctx.cfg.appSecret, v.tracing, parseStoredTracing(prev)) };
}

/** keyJson plus this router's export counters for the key's tracing destination and this UTC week's auto top-ups. */
const keyJsonWithTracing = async (ctx: Ctx, k: KeyRow) => ({ ...keyJson(k), tracing: tracingJson(k.tracing, ctx.tracing.stats(k.keyHash)), topups_this_week_usd: picoToUsd(await topupsThisWeek(ctx.db, k.keyHash)) });

/** An auto top-up rule raises a total limit: the key needs a limit, and one that does not reset each period. */
function assertTopupFits(topup: unknown, budget: bigint | null, reset: string | null) {
  if (!topup) return;
  if (budget == null) fail(400, "Auto top-up raises the key's total limit, so set `limit` too, or clear the rule with `topup: null`.", "invalid_request");
  if (reset) fail(400, "Auto top-up works with a total limit that does not reset. Set `limit_reset: null`, or clear the rule with `topup: null`.", "invalid_request");
}

/**
 * Security review R4-26: a key's rate limits may be lowered by whoever manages it, never raised above the router's
 * defaults (unauthenticated key creation used to accept any `rpm`, so a free key chose its own limit).
 */
function assertLimitsWithinDefaults(ctx: Ctx, v: z.infer<typeof keySpec>) {
  const { defaultRpm, defaultTpm } = ctx.cfg.limits;
  if (v.rpm != null && defaultRpm > 0 && v.rpm > defaultRpm) fail(400, `rpm cannot be above this router's default of ${defaultRpm}.`, "rate_limit_above_default");
  if (v.tpm != null && defaultTpm > 0 && v.tpm > defaultTpm) fail(400, `tpm cannot be above this router's default of ${defaultTpm}.`, "rate_limit_above_default");
  // Clearing a limit (null) would fall back to the default, which is allowed.
}

function applySpec(v: z.infer<typeof keySpec>) {
  const budget = v.budget_usd !== undefined ? v.budget_usd : v.limit;
  return {
    ...(v.include_byok_in_limit !== undefined ? { includeByokInLimit: v.include_byok_in_limit } : {}), // ZK6
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(budget !== undefined ? { budget: budget == null ? null : usdToPico(budget) } : {}),
    ...(v.limit_reset !== undefined ? { budgetReset: v.limit_reset } : {}),
    ...(v.rpm !== undefined ? { rpm: v.rpm } : {}),
    ...(v.tpm !== undefined ? { tpm: v.tpm } : {}),
    ...(v.allowed_models !== undefined ? { allowedModels: v.allowed_models } : {}),
    ...(v.pay_with_default !== undefined ? { payWithDefault: v.pay_with_default } : {}),
    ...(v.disabled !== undefined ? { disabled: v.disabled } : {}),
    ...(v.expires_at !== undefined ? { expiresAt: v.expires_at ? new Date(v.expires_at) : null } : {}),
    ...(v.guardrails !== undefined ? { guardrails: v.guardrails } : {}),
    ...(v.routing !== undefined ? { routing: v.routing } : {}),
  };
}

/** What an audit entry says about a key change: the fields that changed, the new limit and the lane, never guardrail
 *  phrases or other text the owner typed. */
function keyChange(spec: z.infer<typeof keySpec>, patch: ReturnType<typeof applySpec> & { management?: boolean }): AuditDetail {
  const out: AuditDetail = { fields: Object.keys(patch).sort() };
  if (patch.budget !== undefined) out.limit_usd = patch.budget == null ? null : picoToUsd(patch.budget);
  if (patch.disabled !== undefined) out.disabled = patch.disabled;
  if (patch.management !== undefined) out.management = patch.management;
  const provider = (spec.routing as { provider?: { lane?: unknown } } | null | undefined)?.provider;
  if (typeof provider?.lane === "string") out.lane = provider.lane;
  return out;
}

/** Create a virtual sub-key under `caller` (same account and balance, parent = caller). The secret is
 *  returned once; only its hash is stored. Shared by POST /api/v1/keys and Agent Sessions. */
export async function createSubKey(ctx: Ctx, caller: KeyRow, spec: z.infer<typeof keySpec>, db: Db | Tx = ctx.db) {
  const scope = await provisionedScope(ctx, caller, spec, db); // ZK6
  if (spec.management && !caller.management) fail(403, "Only a management key can create management keys.", "forbidden");
  const teamId = spec.team ?? (caller.management ? null : caller.teamId);
  // A non-management key creates keys only in its own team, and never with a role above its own.
  if (!caller.management && teamId !== caller.teamId) fail(403, "This key can create keys only in its own team.", "forbidden");
  const role = spec.role ?? "member";
  const limit = applySpec(spec).budget;
  if (teamId) {
    const [t] = await db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.ownerAccount, caller.accountId)));
    if (!t) fail(404, "Team not found.", "not_found");
    if (!caller.management) {
      // Read through `db`: an agent session creates its key inside a transaction.
      const [me] = await db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.keyHash, caller.keyHash)));
      if (ROLE_RANK[role] > ROLE_RANK[(me?.role ?? "member") as Role]) fail(403, "You cannot create a key with a role above your own.", "forbidden");
    }
    await assertFitsOrgBudget(db, teamId, limit ?? null);
  } else if (spec.role) fail(400, "`role` applies to a key in a team; set `team` too.", "invalid_request");
  const secret = generateApiKey();
  const d = deriveKey(secret);
  await db.insert(keys).values({
    keyHash: d.keyHash,
    chainKeyHash: d.chainKeyHash,
    keyAddress: d.keyAddress,
    accountId: caller.accountId,
    scope, // ZK6
    parentHash: caller.keyHash,
    label: d.label,
    teamId,
    management: !!spec.management,
    rpm: ctx.cfg.limits.defaultRpm || null,
    tpm: ctx.cfg.limits.defaultTpm || null,
    ...applySpec(spec),
    ...tracingPatch(ctx, spec, null),
  });
  if (teamId) {
    await db.insert(teamMembers).values({ teamId, keyHash: d.keyHash, role }).onConflictDoNothing();
    await appendAudit(db, teamId, await actorOf(db, caller), "key.create", d.keyHash, { role, limit_usd: limit == null ? null : picoToUsd(limit) });
  }
  const [row] = await db.select().from(keys).where(eq(keys.keyHash, d.keyHash));
  return { row, secret };
}

export function keysRoutes(app: Hono, ctx: Ctx) {
  // Create a key. Without auth: a new root key with its own (empty) balance — no account needed.
  // With a management/admin key: a virtual sub-key sharing that account's balance.
  app.post("/api/v1/keys", async (c) => {
    const rawSpec = await readJson(c);
    enforceCoreKeySpec(ctx, rawSpec); // LAUNCH_SURFACE=core: a name and limits, nothing else
    const spec = keySpec.parse(rawSpec);
    assertLimitsWithinDefaults(ctx, spec);
    if (spec.topup !== undefined) fail(400, "Set auto top-up with PATCH /api/v1/keys/:hash once the key has a limit.", "invalid_request");
    const auth = c.req.header("authorization");
    const secret = generateApiKey();
    if (!auth) {
      if (spec.scope !== undefined) fail(403, "Only a management key can set key scope.", "forbidden"); // ZK6
      const from = addressBucket(c, ctx.cfg);
      const r = await ctx.limiter.take(`newkey:${from.id}`, 1, from.scale(ctx.cfg.limits.newKeysPerHour), 3_600_000);
      if (!r.ok) fail(429, "Too many new keys from this address. Try again later.", "rate_limited");
      const k = await registerRootKey(ctx, secret, spec.name ?? "");
      const patch = { ...applySpec({ ...spec, management: undefined, team: undefined }), ...tracingPatch(ctx, spec, null) };
      if (Object.keys(patch).length) await ctx.db.update(keys).set(patch).where(eq(keys.keyHash, k.keyHash));
      const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
      return c.json({ data: keyJson(row), key: secret, deposit: depositInfo(ctx, row) }, 201);
    }
    const caller = await sub(ctx, c);
    // Devs create keys too, in their own team and within its org budget (createSubKey checks both).
    await requireRole(ctx, caller, ["owner", "admin", "dev"]);
    // R5-05: sub-keys share the account's balance but each has a request limit of its own, so an account may have only
    // SUB_KEYS_MAX of them live and create only SUB_KEYS_PER_HOUR an hour. Both are counted from the keys table itself,
    // under a lock per account (a burst cannot slip past the count, and replicas agree). Live means neither disabled nor
    // expired: deleting a key or letting it expire frees its slot at once, so an owner at the cap rotates by deleting
    // first. The hourly count includes deleted keys (each leaves a row). Deleting is never limited by either.
    const created = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sub_keys:" + caller.accountId}, 0))`);
      const mine = and(eq(keys.accountId, caller.accountId), isNotNull(keys.parentHash));
      const now = new Date();
      const [live] = await tx.select({ n: sql<number>`count(*)::int` }).from(keys).where(and(mine, eq(keys.disabled, false), or(isNull(keys.expiresAt), gt(keys.expiresAt, now))));
      const [recent] = await tx.select({ n: sql<number>`count(*)::int` }).from(keys).where(and(mine, gt(keys.createdAt, new Date(now.getTime() - 3_600_000))));
      const { subKeysMax, subKeysPerHour } = ctx.cfg.hardening;
      if ((live?.n ?? 0) >= subKeysMax) fail(409, `An account can have at most ${subKeysMax} live sub-keys. Delete one first.`, "subkey_limit_reached", { limit: subKeysMax });
      if ((recent?.n ?? 0) >= subKeysPerHour) fail(429, `An account can create at most ${subKeysPerHour} sub-keys an hour. Try again later.`, "rate_limited");
      return createSubKey(ctx, caller, spec, tx);
    });
    return c.json({ data: keyJson(created.row), key: created.secret, deposit: depositInfo(ctx, created.row) }, 201);
  });

  app.get("/api/v1/keys", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin", "viewer"]);
    const { offset, limit } = keyPagination(c.req.query()); // ZK6: disabled rows remain visible
    const rows = await ctx.db.select().from(keys).where(and(eq(keys.accountId, caller.accountId), ...(caller.management ? [] : [eq(keys.teamId, caller.teamId ?? "")]))).orderBy(desc(keys.createdAt), desc(keys.keyHash)).offset(offset).limit(limit);
    return c.json({ data: rows.map(keyJson) });
  });
  app.get("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin", "viewer"]);
    return c.json({ data: await keyJsonWithTracing(ctx, await ownedKey(ctx, caller, c.req.param("hash"))) });
  });
  app.patch("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin"]);
    const k = await ownedKey(ctx, caller, c.req.param("hash"));
    // An agent session's key is managed only through /api/v1/sessions: re-enabling it or changing its
    // budget or expiry here would contradict the session's recorded state.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, k.keyHash));
    if (session) fail(409, "This key belongs to an agent session; manage it with /api/v1/sessions.", "session_key");
    const rawSpec = await readJson(c);
    enforceCoreKeySpec(ctx, rawSpec); // LAUNCH_SURFACE=core
    const spec = keySpec.parse(rawSpec);
    assertLimitsWithinDefaults(ctx, spec);
    if (spec.scope !== undefined) fail(400, "Scope is fixed at creation; mint a new key to change it.", "invalid_request"); // ZK6
    if (k.scope === "inference" && spec.management === true) fail(403, "An inference-only key cannot gain management rights.", "forbidden"); // ZK6
    if (spec.management !== undefined && !caller.management) fail(403, "Only a management key can change management rights.", "forbidden");
    if (spec.role !== undefined) fail(400, "Change a key's role with PUT /api/v1/teams/:id/members/:hash.", "invalid_request");
    const patch = { ...applySpec(spec), ...(spec.management !== undefined ? { management: spec.management } : {}), ...tracingPatch(ctx, spec, k.tracing), ...(spec.topup !== undefined ? { topup: spec.topup } : {}) };
    assertTopupFits(patch.topup !== undefined ? patch.topup : k.topup, patch.budget !== undefined ? patch.budget : k.budget, patch.budgetReset !== undefined ? patch.budgetReset : k.budgetReset);
    // In a team with an org budget, a new limit (or a key coming back) must still fit.
    if (k.teamId && (patch.budget !== undefined || patch.disabled === false || patch.expiresAt !== undefined))
      await assertFitsOrgBudget(ctx.db, k.teamId, patch.budget !== undefined ? patch.budget : k.budget, k.keyHash);
    if (Object.keys(patch).length) await ctx.db.update(keys).set(patch).where(eq(keys.keyHash, k.keyHash));
    if (k.teamId && Object.keys(patch).length) await appendAudit(ctx.db, k.teamId, await actorOf(ctx.db, caller), "key.update", k.keyHash, keyChange(spec, patch));
    const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    return c.json({ data: await keyJsonWithTracing(ctx, row) });
  });
  app.delete("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin"]);
    const k = await ownedKey(ctx, caller, c.req.param("hash"));
    if (k.keyHash === caller.keyHash) fail(400, "A key cannot delete itself; disable it with PATCH instead.", "invalid_request");
    // Keys are disabled rather than removed: generations and on-chain balances reference them.
    await ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, k.keyHash));
    if (k.teamId && !k.disabled) await appendAudit(ctx.db, k.teamId, await actorOf(ctx.db, caller), "key.disable", k.keyHash, {});
    // A closure this key started (or anyone holding it started on chain) is not paid while the key is disabled: revoking
    // a leaked key stops it (security re-review RR-05). The balance stays in the account; an owner releases it on purpose.
    const [held] = await ctx.db.select({ id: creditClosures.id }).from(creditClosures).where(and(eq(creditClosures.chainKeyHash, k.chainKeyHash), inArray(creditClosures.status, ["queued", "registered"]), isNull(creditClosures.releasedAt)));
    return c.json({ deleted: true, data: { hash: k.keyHash, deleted: true, ...(held ? { closure_held: { id: held.id, reason: "key_disabled", release: "POST /api/v1/credits/close/release" } } : {}) } }); // ZK6
  });

  // Current key (OpenRouter GET /api/v1/key shape).
  app.get("/api/v1/key", async (c) => {
    const k = await sub(ctx, c);
    const bal = await balanceOf(ctx.db, k.accountId);
    return c.json({
      data: {
        ...keyJson(k),
        is_free_tier: false,
        rate_limit: { requests: k.rpm ?? ctx.cfg.limits.defaultRpm, interval: "1m" },
        balance: picoToUsd(bal.available),
        deposit: depositInfo(ctx, k),
      },
    });
  });

  app.get("/api/v1/credits", async (c) => {
    const k = await sub(ctx, c);
    // A session key sees its own budget, not the account's balance or deposits.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, k.keyHash));
    if (session) {
      const budget = k.budget ?? 0n;
      const left = budget - k.spentTotal > 0n ? budget - k.spentTotal : 0n;
      return c.json({ data: { total_credits: picoToUsd(budget), total_usage: picoToUsd(k.spentTotal), balance: picoToUsd(left), available: picoToUsd(left), currency: "USD", session: session.id } });
    }
    const bal = await balanceOf(ctx.db, k.accountId);
    const [dep] = await ctx.db
      .select({ n: sql<string>`coalesce(sum(${ledger.amount}), 0)` })
      .from(ledger)
      .where(and(eq(ledger.accountId, k.accountId), sql`${ledger.amount} > 0`));
    const [use] = await ctx.db
      .select({ n: sql<string>`coalesce(sum(${generations.cost}), 0)` })
      .from(generations)
      .where(eq(generations.accountId, k.accountId));
    return c.json({
      data: {
        ...await fastCreditFields(ctx, k.accountId), // V97
        ...await depositTiming(ctx), // V97D: USDC confirmation threshold and block numbers.
        total_credits: picoToUsd(BigInt(dep?.n ?? 0)),
        total_usage: picoToUsd(BigInt(use?.n ?? 0)),
        balance: picoToUsd(bal.balance),
        held: picoToUsd(bal.held),
        available: picoToUsd(bal.available),
        currency: "USDC",
        deposit: depositInfo(ctx, k),
      },
    });
  });

  // Credits are spend-only on Trellis: what a key deposits is spent on inference and never withdrawn, so the
  // self-custodial withdrawal surface of the EVM router answers 410 here.
  for (const path of ["/api/v1/credits/withdrawal-proof", "/api/v1/credits/withdraw-request", "/api/v1/credits/withdraw-cancel"])
    app.all(path, () => fail(410, "Trellis credits are spend-only: deposits are not withdrawn.", "gone"));

  // Deposit instructions for the user's wallet: an unsigned trellis_credits::deposit transaction (Solana Pay
  // transaction-request shape: { transaction, message }) that moves USDC from the payer's wallet into the program vault
  // for this key. The indexer credits the balance once the transaction is finalized. Refused above the per-key cap.
  app.post("/api/v1/credits/deposit-tx", async (c) => {
    const k = await sub(ctx, c);
    const v = z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "amount must be a USDC amount with up to 6 decimals"), payer: z.string().regex(ADDRESS_RE, "payer must be a base58 Solana address"), register_owner: z.boolean().optional() }).parse(await readJson(c));
    const program = creditsProgram(ctx.cfg);
    if (!program) ctx.chain.require("credits");
    let amount: bigint;
    try { amount = parseUsdcAmount(v.amount); } catch (e) { fail(400, (e as Error).message, "invalid_request"); }
    const onchain = await readCreditAccount(ctx.chain.connection, program!, k.chainKeyHash).catch(() => null);
    const { blockhash, lastValidBlockHeight } = await ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    // R4-25: a key with no owner wallet gets the paying wallet registered as its owner in this same transaction, signed
    // by the key (which this request carries). `register_owner: false` opts out (a wallet funding someone else's key).
    const currentOwner = onchain && !onchain.authority.equals(PublicKey.default) ? onchain.authority.toBase58() : null;
    const secret = bearer(c.req.header("authorization"));
    const derived = secret ? deriveKey(secret) : null;
    const registerOwner = v.register_owner !== false && !currentOwner && derived?.chainKeyHash === k.chainKeyHash ? { key: new PublicKey(derived.keyAddress), signAsKey: derived.account.signBytes } : undefined;
    let built: ReturnType<typeof buildDepositTransaction>;
    try {
      built = buildDepositTransaction(program!, { depositor: new PublicKey(v.payer), chainKeyHash: k.chainKeyHash, amount: amount!, currentBalance: onchain?.balance ?? 0n, capUnits: ctx.cfg.solana.caps.creditsUnits, recentBlockhash: blockhash, lastValidBlockHeight, registerOwner });
    } catch (e) { fail(400, (e as Error).message, "deposit_refused"); }
    return c.json({ data: { owner: { registers: built!.registersOwner ? v.payer : null, current: currentOwner }, transaction: built!.transaction, message: built!.message, network: ctx.cfg.chain.network, amount_usdc: v.amount, amount_units: amount!.toString(), accounts: built!.accounts, refund_to: built!.refundTo, expires_at_block_height: lastValidBlockHeight, key_hash: k.chainKeyHash, note: "If this key's credits are ever closed, what is left of this deposit is refunded to the token account it is paid from (refund_to). Only the paying wallet can change that, with POST /api/v1/credits/refund-destination-tx; the API key cannot." } });
  });

  // Account closure (§5.1): the only customer-initiated outflow. trellis_credits::close_account is authorised by the key
  // itself: its ed25519 keypair (derived from the API key) must sign, and nobody else can close a key, whoever deposited
  // to it (security review TR-05). The request carries the key, so the router signs the transaction as the key right
  // here (it keeps neither the secret nor the keypair) and returns it for `payer`, any wallet, to sign as fee payer and
  // send (Solana Pay shape). Once it lands the key is frozen for new calls and the settlement job pays the refund after
  // the program's 72h delay and a sanctions check of the accounts being paid. Not on demand, and never sent by the router.
  //
  // The key does NOT say where the refund goes (security re-review RR-05). It returns to the wallets that deposited to
  // the key, each at most what it put in, to the token account that wallet named on chain (by default the one it paid
  // from). A leaked API key can therefore ask for a closure and nothing more: it cannot redirect a balance. `refund_to`
  // in the request is refused, so no client is left believing it chose a destination.
  const refundsOf = async (program: NonNullable<ReturnType<typeof creditsProgram>>, chainKeyHash: string) => {
    const { shares } = await sharesAndLots(ctx, program, chainKeyHash).catch(() => ({ shares: new Map() as Awaited<ReturnType<typeof sharesAndLots>>["shares"] }));
    return [...shares.values()].map((sh) => ({ depositor: sh.depositor.toBase58(), refund_to: sh.refundTo.toBase58(), deposited_units: sh.deposited.toString(), refunded_units: sh.refunded.toString() }));
  };
  // `as_owner` (security review round 3, R3-06): the transaction is for the key's registered owner wallet to sign
  // instead of the key (`payer` must be that wallet). A closure asked for as owner cannot be cancelled with the key.
  const payerOnly = z.object({ payer: z.string().regex(ADDRESS_RE, "payer must be a base58 Solana address"), refund_to: z.unknown().optional(), as_owner: z.boolean().optional() });
  const isOwner = (onchain: { authority: PublicKey } | null, payer: string) => !!onchain && !onchain.authority.equals(PublicKey.default) && onchain.authority.toBase58() === payer;
  const NOT_OWNER = "as_owner needs payer to be this key's registered owner wallet (POST /api/v1/credits/owner-tx registers one).";
  const REFUND_FIXED = "A closure refund returns to the wallets that deposited to this key, to the token account each of them named; the key cannot choose or change it. Send only { payer }. A depositor changes its own destination with POST /api/v1/credits/refund-destination-tx.";
  app.post("/api/v1/credits/close", async (c) => {
    const k = await sub(ctx, c);
    const v = payerOnly.parse(await readJson(c));
    if (v.refund_to !== undefined) fail(400, REFUND_FIXED, "refund_destination_fixed");
    const secret = bearer(c.req.header("authorization"));
    const derived = secret ? deriveKey(secret) : null;
    if (!derived || derived.chainKeyHash !== k.chainKeyHash) fail(403, "Closure must be requested with the key itself.", "forbidden");
    const program = creditsProgram(ctx.cfg);
    if (!program) ctx.chain.require("credits");
    const [open] = await ctx.db.select().from(creditClosures).where(and(eq(creditClosures.chainKeyHash, k.chainKeyHash), inArray(creditClosures.status, ["queued", "registered"])));
    const onchain = await readCreditAccount(ctx.chain.connection, program!, k.chainKeyHash).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    const refunds = await refundsOf(program!, k.chainKeyHash);
    if (!onchain || onchain.closed) {
      if (open) return c.json({ data: { id: open.id, status: open.status, payer: open.authority, authority: open.authority, payable_at: open.payableAt.toISOString(), transaction: null, refunds } });
      fail(400, onchain?.closed ? "This key's credits are already closed." : "This key has no on-chain credits to close.", "nothing_to_close");
    }
    const registered = await readRefundRequest(ctx.chain.connection, program!, k.chainKeyHash).catch(() => null);
    const { blockhash, lastValidBlockHeight } = await ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (v.as_owner && !isOwner(onchain, v.payer)) fail(403, NOT_OWNER, "not_owner");
    const built = registered ? null : v.as_owner
      ? buildCloseByOwnerTransaction(program!, { owner: new PublicKey(v.payer), chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight })
      : buildCloseAccountTransaction(program!, { key: new PublicKey(derived!.keyAddress), payer: new PublicKey(v.payer), chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight, signAsKey: derived!.account.signBytes });
    const payableAt = closurePayableAt(new Date(), ctx.cfg.solana.closureDelayMs);
    let id = open?.id;
    if (!id) {
      // R4-04: a request is only a row until its transaction is signed. One wallet may have a few such rows at a time
      // (they expire CLOSURE_UNSIGNED_TTL_S after they were asked for; the refund job never waits on them).
      if (!registered) {
        const [mine] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(creditClosures).where(and(eq(creditClosures.status, "queued"), eq(creditClosures.authority, v.payer), isNull(creditClosures.plan)));
        if ((mine?.n ?? 0) >= ctx.cfg.solana.closures.maxUnsignedPerPayer)
          fail(429, `This wallet already has ${mine!.n} closure request(s) waiting to be signed. Sign one, or wait ${Math.ceil(ctx.cfg.solana.closures.unsignedTtlMs / 60_000)} minutes for them to expire.`, "too_many_unsigned_closures", undefined, { "retry-after": String(Math.ceil(ctx.cfg.solana.closures.unsignedTtlMs / 1000)) });
      }
      id = uid("close_");
      await ctx.db.insert(creditClosures).values({ id, keyHash: k.keyHash, chainKeyHash: k.chainKeyHash, keyAddress: k.keyAddress, refundTo: "", authority: v.payer, status: registered ? "registered" : "queued", payableAt });
    }
    return c.json({ data: { id, status: open?.status ?? (registered ? "registered" : "queued"), payer: v.payer, authority: v.payer, payable_at: (open?.payableAt ?? payableAt).toISOString(), transaction: built?.transaction ?? null, message: built?.message ?? null, accounts: built?.accounts ?? null, expires_at_block_height: built ? lastValidBlockHeight : null, signed_by_key: !!built?.signedByKey, requested_by: built ? (v.as_owner ? "owner" : "key") : null, owner: onchain!.authority.equals(PublicKey.default) ? null : onchain!.authority.toBase58(), refunds, note: v.as_owner ? "Sign this with the owner wallet and send it before the blockhash expires. Asked for by the owner, the closure cannot be taken back with the API key, only by the owner wallet (POST /api/v1/credits/close/cancel with as_owner). The refund returns to the wallets that deposited to this key (see refunds), after the dispute window and a sanctions check, never on demand." : "The transaction already carries the key's signature. Sign it with the payer wallet (any wallet; it pays the fee and a small rent) and send it before the blockhash expires. The refund is not sent to an address of your choosing: it returns to the wallets that deposited to this key (see refunds), after the dispute window and a sanctions check, never on demand. The key stops serving new calls once the closure is on chain. Until anything is paid you can take it back with POST /api/v1/credits/close/cancel: with the key once in 60 days, with the key's registered owner wallet at any time. If this key may have leaked, register an owner wallet first (POST /api/v1/credits/owner-tx) and close with as_owner." } }, open ? 200 : 201);
  });

  // Take a queued closure back while nothing has been paid: cancel_close. Who may (security review round 3, R3-06):
  // whoever asked for the closure, or the key's registered owner wallet; nobody else, however much they deposited. The
  // key itself only for a closure the key asked for, and once per 60 days (the program's KEY_CANCEL_COOLDOWN): two
  // holders of one key cannot keep taking each other's closure back. The default answer is the transaction signed by
  // the key; with `as_owner` it is unsigned, for the owner wallet (`payer`) to sign.
  app.post("/api/v1/credits/close/cancel", async (c) => {
    const k = await sub(ctx, c);
    const v = payerOnly.parse(await readJson(c));
    if (v.refund_to !== undefined) fail(400, REFUND_FIXED, "refund_destination_fixed"); // refused, not ignored: the caller believes it chose something
    const secret = bearer(c.req.header("authorization"));
    const derived = secret ? deriveKey(secret) : null;
    if (!derived || derived.chainKeyHash !== k.chainKeyHash) fail(403, "A closure is cancelled with the key itself.", "forbidden");
    const program = creditsProgram(ctx.cfg);
    if (!program) ctx.chain.require("credits");
    const request = await readRefundRequest(ctx.chain.connection, program!, k.chainKeyHash).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (!request) fail(400, "This key has no closure on chain to cancel.", "nothing_to_cancel");
    if (request!.paid || request!.paidAmount > 0n) fail(409, "This closure has already been paid in part or in full and can no longer be cancelled.", "refund_in_progress");
    const { blockhash, lastValidBlockHeight } = await ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (v.as_owner) {
      const onchain = await readCreditAccount(ctx.chain.connection, program!, k.chainKeyHash).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
      if (!isOwner(onchain, v.payer)) fail(403, NOT_OWNER, "not_owner");
      const built = buildCancelCloseByOwnerTransaction(program!, { owner: new PublicKey(v.payer), rentPayer: request!.rentPayer, chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight });
      return c.json({ data: { transaction: built.transaction, message: built.message, accounts: built.accounts, payer: v.payer, expires_at_block_height: lastValidBlockHeight, signed_by_key: false, note: "Sign with the owner wallet and send before the blockhash expires. Once it lands the key is open again with its balance and serves calls as before." } });
    }
    // The program would refuse these; say so before a wallet signs and pays a fee for nothing.
    if (!request!.requestedBy.equals(PublicKey.default) && request!.requestedBy.toBase58() !== derived!.keyAddress) fail(403, "This closure was asked for by the key's owner wallet: only that wallet can take it back (send as_owner with payer = the owner wallet).", "not_requester");
    const blockedUntil = await readKeyCancelBlockedUntil(ctx.chain.connection, program!, k.chainKeyHash).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (blockedUntil > BigInt(Math.floor(Date.now() / 1000))) fail(409, "This key has already taken a closure back in the last 60 days and cannot do so again yet. The key's registered owner wallet can (as_owner).", "cancel_cooldown", { retry_at: new Date(Number(blockedUntil) * 1000).toISOString() });
    const built = buildCancelCloseTransaction(program!, { key: new PublicKey(derived!.keyAddress), payer: new PublicKey(v.payer), rentPayer: request!.rentPayer, chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight, signAsKey: derived!.account.signBytes });
    return c.json({ data: { transaction: built.transaction, message: built.message, accounts: built.accounts, payer: v.payer, expires_at_block_height: lastValidBlockHeight, signed_by_key: true, note: "Sign with the payer wallet and send before the blockhash expires. Once it lands the key is open again with its balance and serves calls as before. The key can take a closure back once in 60 days; after this one, a further closure can only be taken back by the key's registered owner wallet." } });
  });

  // Register the key's owner wallet on chain (security review round 3, R3-06 and R3-23): set_key_authority, signed here
  // as the key and returned for the wallet to sign as the new owner and fee payer. First registration wins and the key
  // alone can never change it afterwards, so do this when the key is created, before it can leak. The owner can close
  // the key and cancel closures without the key; it gains no claim on the balance.
  app.post("/api/v1/credits/owner-tx", async (c) => {
    const k = await sub(ctx, c);
    const v = z.object({ owner: z.string().regex(ADDRESS_RE, "owner must be a base58 Solana address") }).parse(await readJson(c));
    const secret = bearer(c.req.header("authorization"));
    const derived = secret ? deriveKey(secret) : null;
    if (!derived || derived.chainKeyHash !== k.chainKeyHash) fail(403, "An owner wallet is registered with the key itself.", "forbidden");
    const program = creditsProgram(ctx.cfg);
    if (!program) ctx.chain.require("credits");
    const onchain = await readCreditAccount(ctx.chain.connection, program!, k.chainKeyHash).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (!onchain) fail(400, "This key has no on-chain credits yet: deposit first, then register its owner wallet.", "no_credit_account");
    if (onchain!.closed) fail(409, "This key's credits are closed.", "credits_closing");
    if (!onchain!.authority.equals(PublicKey.default)) fail(409, "This key already has an owner wallet. Only that wallet can change it, on chain, with its own signature.", "owner_already_registered", { owner: onchain!.authority.toBase58() });
    const { blockhash, lastValidBlockHeight } = await ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    const built = buildRegisterOwnerTransaction(program!, { key: new PublicKey(derived!.keyAddress), owner: new PublicKey(v.owner), chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight, signAsKey: derived!.account.signBytes });
    return c.json({ data: { transaction: built.transaction, message: built.message, accounts: built.accounts, owner: v.owner, expires_at_block_height: lastValidBlockHeight, signed_by_key: true, note: "The transaction already carries the key's signature. Sign it with the owner wallet (it also pays the fee) and send it before the blockhash expires. From then on only this wallet can change the owner, close the key without the key, or take back a closure the key cannot." } });
  });

  // A closure is not paid while its key is disabled (revoking a leaked key stops the closure it started). An owner or
  // admin of the account lets it go ahead on purpose: the refund still only returns to the wallets that funded the key.
  app.post("/api/v1/credits/close/release", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin"]);
    const v = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/, "key must be the key's hash (as listed by GET /api/v1/keys)") }).parse(await readJson(c));
    const k = await ownedKey(ctx, caller, v.key);
    const released = await ctx.db.update(creditClosures).set({ releasedAt: new Date(), reason: null }).where(and(eq(creditClosures.chainKeyHash, k.chainKeyHash), inArray(creditClosures.status, ["queued", "registered"]))).returning({ id: creditClosures.id, status: creditClosures.status, payableAt: creditClosures.payableAt });
    if (!released.length) fail(404, "That key has no open closure.", "not_found");
    return c.json({ data: released.map((r) => ({ id: r.id, status: r.status, released: true, payable_at: r.payableAt.toISOString() })) });
  });

  // Where a depositor's refunds from this key go is that depositor's decision, made with its own wallet signature:
  // an unsigned trellis_credits::set_refund_destination for `depositor` to sign and send. The API key has no say in it.
  app.post("/api/v1/credits/refund-destination-tx", async (c) => {
    const k = await sub(ctx, c);
    const v = z.object({ depositor: z.string().regex(ADDRESS_RE, "depositor must be a base58 Solana address"), refund_to: z.string().regex(ADDRESS_RE, "refund_to must be a base58 Solana address") }).parse(await readJson(c));
    const program = creditsProgram(ctx.cfg);
    if (!program) ctx.chain.require("credits");
    const depositor = new PublicKey(v.depositor);
    const share = await readDepositorShare(ctx.chain.connection, program!, k.chainKeyHash, depositor).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    if (!share) fail(404, "That wallet has not deposited to this key.", "not_found");
    const { blockhash, lastValidBlockHeight } = await ctx.chain.connection.getLatestBlockhash(ctx.cfg.solana.commitment).catch(() => fail(503, "The Solana RPC is unavailable; try again shortly.", "chain_unavailable"));
    const built = buildSetRefundDestinationTransaction(program!, { depositor, refundTo: new PublicKey(v.refund_to), chainKeyHash: k.chainKeyHash, recentBlockhash: blockhash, lastValidBlockHeight });
    return c.json({ data: { transaction: built.transaction, message: built.message, accounts: built.accounts, depositor: v.depositor, refund_to: v.refund_to, current_refund_to: share!.refundTo.toBase58(), expires_at_block_height: lastValidBlockHeight, note: "Only the depositor's own wallet can sign this. It changes where that wallet's deposits to this key are refunded; it moves nothing now." } });
  });

  app.get("/api/v1/credits/close", async (c) => {
    const k = await sub(ctx, c);
    const rows = await ctx.db.select().from(creditClosures).where(eq(creditClosures.chainKeyHash, k.chainKeyHash)).orderBy(desc(creditClosures.requestedAt)).limit(10);
    const refunds = (plan: RefundPlanItem[] | null) => (plan ?? []).map((i) => ({ depositor: i.depositor, refund_to: i.refundTo, owner: i.owner, amount_units: i.units, status: i.status, reason: i.reason ?? null, tx: i.tx ?? null }));
    return c.json({ data: rows.map((r) => ({ id: r.id, status: r.status, reason: r.reason, refund_to: r.refundTo || null, refunds: refunds(r.plan), amount_units: r.amount?.toString() ?? null, requested_at: r.requestedAt.toISOString(), payable_at: r.payableAt.toISOString(), paid_at: r.paidAt?.toISOString() ?? null, register_tx: r.registerTx, pay_tx: r.payTx, cancel_tx: r.cancelTx, released_at: r.releasedAt?.toISOString() ?? null })) });
  });

  // Test USDC faucet (FAUCET_ENABLED on localnet/devnet, or DEV_FAUCET on a loopback RPC): minted to the faucet wallet and
  // deposited to this key through trellis_credits (src/solana/faucet.ts), no wallet needed. Never on mainnet-beta.
  const faucetUse = new Map<string, number[]>();
  app.post("/api/v1/dev/faucet", async (c) => {
    if (!faucetEnabled(ctx)) fail(404, "The test USDC faucet is only available on localnet and devnet.", "not_found");
    const k = await sub(ctx, c);
    const v = z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/).default("10") }).parse(await readJson(c));
    const units = BigInt(Math.round(Number(v.amount) * 1e6));
    if (units <= 0n || units > 1000_000000n) fail(400, "Request between 0.000001 and 1000 test USDC.", "invalid_request");
    const now = Date.now();
    const recent = (faucetUse.get(k.chainKeyHash) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 20) fail(429, "Faucet limit reached for this key; try again within the hour.", "rate_limited");
    faucetUse.set(k.chainKeyHash, [...recent, now]);
    const { hash, credit } = await faucetDeposit(ctx, k.chainKeyHash, units);
    await ctx.jobs.run("chain-indexer").catch(() => undefined); // credit it now rather than on the next tick
    return c.json({ data: { amount_usdc_units: units.toString(), tx: hash, credit_account: credit, test_funds: true, network: ctx.cfg.chain.network } }, 201);
  });

  // BYOK: store an upstream provider key (encrypted at rest). Calls routed to that provider use it.
  app.post("/api/v1/byok", async (c) => {
    const k = await sub(ctx, c);
    await requireRole(ctx, k, ["owner", "admin"]);
    const v = z.object({ provider: z.string().min(1), key: z.string().min(8).max(500) }).parse(await readJson(c));
    if (!(await ctx.catalog.provider(v.provider))) fail(404, `Unknown provider ${v.provider}.`, "not_found");
    await ctx.db
      .insert(byokKeys)
      .values({ id: uid("byok_"), accountId: k.accountId, providerId: v.provider, keyEnc: encrypt(ctx.cfg.appSecret, v.key), label: `${v.key.slice(0, 4)}…${v.key.slice(-4)}` })
      .onConflictDoUpdate({ target: [byokKeys.accountId, byokKeys.providerId], set: { keyEnc: encrypt(ctx.cfg.appSecret, v.key), label: `${v.key.slice(0, 4)}…${v.key.slice(-4)}` } });
    return c.json({ data: { provider: v.provider, stored: true } }, 201);
  });
  app.get("/api/v1/byok", async (c) => {
    const k = await sub(ctx, c);
    const rows = await ctx.db.select().from(byokKeys).where(eq(byokKeys.accountId, k.accountId));
    return c.json({ data: rows.map((r) => ({ provider: r.providerId, label: r.label, created_at: r.createdAt.toISOString() })) });
  });
  app.delete("/api/v1/byok/:provider", async (c) => {
    const k = await sub(ctx, c);
    await requireRole(ctx, k, ["owner", "admin"]);
    await ctx.db.delete(byokKeys).where(and(eq(byokKeys.accountId, k.accountId), eq(byokKeys.providerId, c.req.param("provider"))));
    return c.json({ data: { provider: c.req.param("provider"), deleted: true } });
  });

  // Teams, organisations and their audit log: src/api/teams.ts.

  // Server-issued, single-use wallet login challenges (web/PORT-NOTES.md, "Wallet sign-in"). The challenge carries the
  // exact `message` to sign: a Sign-In-With-Solana text naming this router's domain (the host of PUBLIC_BASE_URL), its
  // URI, the address, the network, the nonce and the validity (src/lib/wallet-sig.ts). The wallet signs those UTF-8 bytes
  // with its ed25519 key; the router verifies the signature over the message it stored with the challenge, and over
  // nothing else: a signature over any other text, including the retired v1 form that named no site (security review
  // TR-17), does not sign in.
  const WALLET_LOGIN_WINDOW_S = 300;
  /** Sign-in keys of one wallet that stay usable; minting another disables the oldest beyond this. */
  const MAX_LIVE_SIGN_IN_KEYS = 10;
  type WalletChallenge = { address: string; origin: string; expires: number; issued: number; message?: string };
  app.post("/api/v1/auth/wallet/challenge", async (c) => {
    const v = z.object({ address: z.string().regex(WALLET_ADDRESS_RE).refine(isWalletAddress, "expected a base58 Solana address (32 bytes)") }).parse(await readJson(c));
    const from = addressBucket(c, ctx.cfg);
    const limit = await ctx.limiter.take(`wallet-login:${from.id}`, 1, from.scale(30), 60_000);
    if (!limit.ok) fail(429, "Too many wallet challenges.", "rate_limit");
    const nonce = randomHex(24);
    const issued = Date.now();
    const expires = issued + WALLET_LOGIN_WINDOW_S * 1000;
    const site = new URL(ctx.cfg.publicUrl);
    const origin = site.origin;
    const fields: WalletSignIn = { domain: site.host, address: v.address, statement: WALLET_SIGN_IN_STATEMENT, uri: origin, version: "1", chainId: ctx.cfg.chain.network, nonce, issuedAt: new Date(issued).toISOString(), expirationTime: new Date(expires).toISOString() };
    const message = walletSignInMessage(fields);
    await ctx.db.delete(kv).where(sql`${kv.key} LIKE 'wallet-login:%' AND ${kv.updatedAt} < now() - interval '10 minutes'`);
    await ctx.db.insert(kv).values({ key: `wallet-login:${nonce}`, value: { address: v.address, origin, expires, issued, message } satisfies WalletChallenge });
    return c.json({ data: { nonce, message, domain: fields.domain, uri: fields.uri, chain_id: fields.chainId, issued_at: fields.issuedAt, expires_at: fields.expirationTime, version: WALLET_SIGN_IN_VERSION } });
  });
  app.post("/api/v1/auth/wallet", async (c) => {
    const v = z
      .object({
        address: z.string().regex(WALLET_ADDRESS_RE).refine(isWalletAddress, "expected a base58 Solana address (32 bytes)"),
        nonce: z.string().regex(/^[0-9a-f]{48}$/),
        signature: z.string().regex(WALLET_SIGNATURE_RE),
        // The message the client signed, when it sends it back: it must be the issued one. Never verified in its place.
        message: z.string().max(2000).optional(),
        // Sent by v1 clients; the validity now lives in the signed message itself, so it is not read.
        timestamp: z.number().int().nonnegative().max(1e12).optional(),
        name: z.string().max(100).optional(),
      })
      .parse(await readJson(c));
    const [challenge] = await ctx.db.select().from(kv).where(eq(kv.key, `wallet-login:${v.nonce}`));
    const value = challenge?.value as WalletChallenge | undefined;
    const now = Date.now();
    if (!value || !value.message || value.expires < now || value.address !== v.address || value.origin !== new URL(ctx.cfg.publicUrl).origin)
      fail(401, "Wallet challenge is invalid, expired, or already consumed.", "invalid_wallet_auth");
    if (v.message !== undefined && v.message !== value.message) fail(401, "The signed message is not the one issued with the challenge.", "invalid_wallet_auth");
    // The signature must cover exactly the stored message: its domain, address, nonce and expiry are what was signed.
    if (!verifyWalletSignature(v.address, value.message, v.signature)) fail(401, "Signature does not match the challenge message. Sign the `message` returned by /api/v1/auth/wallet/challenge exactly as given.", "invalid_wallet_auth");
    const secret = generateApiKey();
    const d = deriveKey(secret);
    const accountId = walletAccountId(v.address);
    const row = await ctx.db.transaction(async (tx) => {
      // Single use: the row is deleted in the same transaction that issues the key, so concurrent replays lose the race.
      const used = await tx.delete(kv).where(eq(kv.key, challenge.key)).returning({ key: kv.key });
      if (!used.length || value.expires < Date.now()) fail(401, "Wallet challenge is expired or already consumed.", "invalid_wallet_auth");
      await ensureAccount(tx, accountId, "wallet", v.address);
      const [key] = await tx.insert(keys).values({ keyHash: d.keyHash, chainKeyHash: d.chainKeyHash, keyAddress: d.keyAddress, accountId, label: d.label, name: v.name ?? "wallet", management: true, rpm: ctx.cfg.limits.defaultRpm || null }).returning();
      // Every sign-in mints a key that never expires: keep the newest MAX_LIVE_SIGN_IN_KEYS of this wallet and disable
      // the rest. Sign-in keys are the wallet account's keys with no parent (keys made through the API name their parent).
      const others = await tx.select({ keyHash: keys.keyHash }).from(keys).where(and(eq(keys.accountId, accountId), isNull(keys.parentHash), eq(keys.disabled, false), ne(keys.keyHash, d.keyHash))).orderBy(desc(keys.createdAt));
      const stale = others.slice(MAX_LIVE_SIGN_IN_KEYS - 1).map((k) => k.keyHash);
      if (stale.length) await tx.update(keys).set({ disabled: true }).where(inArray(keys.keyHash, stale));
      return key;
    });
    return c.json({ data: keyJson(row), key: secret }, 201);
  });
}
