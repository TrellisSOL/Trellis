import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, keys, teams } from "../db/schema.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { isWalletAddress } from "../lib/wallet-sig.ts";
import { agentIdentities } from "./schema.ts";
import { REGISTRATION_RENT_SOL, REGISTRATION_TYPE } from "./agent-registry.ts";
import { identityChain } from "./chain.ts";
import { runSubjectRegistrations } from "./subjects.ts";

// Solana Agent Registry identities for opted-in agent profiles. The owner chooses: nothing is registered until the owner
// asks, and an owner (or the default for a rulebook that allows only the unlinkable lane) can opt out, which stops every
// link the router publishes. In owner mode the router prepares the registration transaction (register + the receipt-keys
// metadata entry, the identity asset's keypair already signed) for the owner's wallet and later reads the signature; in
// registrar mode an isolated worker sends it. On-chain records are permanent once sent; registration costs the sender
// about REGISTRATION_RENT_SOL in rent.

export type IdentityRow = typeof agentIdentities.$inferSelect;
export const newIdentityId = () => randomBytes(18).toString("base64url");
export const identityIdPattern = /^[A-Za-z0-9_-]{24}$/;

export const receiptKeysUrl = (ctx: Ctx) => `${ctx.cfg.publicUrl}/.well-known/trellis-receipt-keys.json`;
export const registrationUrl = (ctx: Ctx, id: string) => `${ctx.cfg.publicUrl}/api/v1/agents/identity/${id}/registration.json`;
export const cardUrl = (ctx: Ctx, slug: string) => `${ctx.cfg.publicUrl}/api/v1/agents/profiles/${slug}`;
export const reputationUrl = (ctx: Ctx, slug: string) => `${ctx.cfg.publicUrl}/api/v1/agents/${slug}/reputation`;

/** Whether the key's own rulebook allows only the unlinkable lane: such agents are opted out unless they opt in. */
export async function unlinkableOnly(ctx: Ctx, keyHash: string) {
  const [p] = await ctx.db.select({ spec: agentPolicies.spec }).from(agentPolicies).where(eq(agentPolicies.keyHash, keyHash));
  const lanes = p?.spec.lanes;
  return !!lanes?.length && lanes.every(l => l === "unlinkable");
}

export async function identityRow(ctx: Ctx, keyHash: string) {
  const [row] = await ctx.db.select().from(agentIdentities).where(eq(agentIdentities.keyHash, keyHash));
  return row ?? null;
}

export async function optedOut(ctx: Ctx, keyHash: string, row?: IdentityRow | null) {
  const r = row === undefined ? await identityRow(ctx, keyHash) : row;
  return r?.identityOptOut ?? await unlinkableOnly(ctx, keyHash);
}

export async function ensureIdentity(ctx: Ctx, keyHash: string) {
  await ctx.db.insert(agentIdentities).values({ keyHash, id: newIdentityId() }).onConflictDoNothing();
  return (await identityRow(ctx, keyHash))!;
}

export async function identitySettingsJson(ctx: Ctx, keyHash: string) {
  const row = await identityRow(ctx, keyHash);
  const unlinkable = await unlinkableOnly(ctx, keyHash);
  return {
    identity_opt_out: row?.identityOptOut ?? unlinkable,
    identity_opt_out_default: row?.identityOptOut == null,
    unlinkable_only_rulebook: unlinkable,
    reputation_opt_in: row?.reputationOptIn ?? false,
    registration: { status: row?.status ?? "none", mode: row?.mode ?? null, registry: row?.registry ?? null, agent_id: row?.agentId ?? null, owner_address: row?.ownerAddress ?? null, tx_hash: row?.txHash ?? null, error: row?.error ?? null, registration_url: row ? registrationUrl(ctx, row.id) : null },
  };
}

export async function updateIdentitySettings(ctx: Ctx, keyHash: string, input: { identity_opt_out?: boolean; reputation_opt_in?: boolean }) {
  await ensureIdentity(ctx, keyHash);
  const set: Partial<IdentityRow> = { updatedAt: new Date() };
  if (input.identity_opt_out !== undefined) set.identityOptOut = input.identity_opt_out;
  if (input.reputation_opt_in !== undefined) set.reputationOptIn = input.reputation_opt_in;
  // An opted-out key has no pending registration: nothing is sent for it afterwards.
  if (input.identity_opt_out === true) await ctx.db.update(agentIdentities).set({ status: sql`case when ${agentIdentities.status} in ('awaiting_owner', 'queued') then 'none' else ${agentIdentities.status} end` }).where(eq(agentIdentities.keyHash, keyHash));
  await ctx.db.update(agentIdentities).set(set).where(eq(agentIdentities.keyHash, keyHash));
  return identitySettingsJson(ctx, keyHash);
}

export function registryOrFail(ctx: Ctx) {
  const { programId, id } = ctx.cfg.identity.registry;
  if (!programId || !id) fail(503, "No agent registry is configured for this router (AGENT_REGISTRY_PROGRAM_ID).", "identity_registry_unavailable");
  return { programId, id };
}

/** Wallets linked to an account: its sign-in wallet and the verified owner wallets of organisations it owns. */
export async function accountWallets(ctx: Ctx, accountId: string): Promise<string[]> {
  const [account] = await ctx.db.select({ wallet: accounts.wallet }).from(accounts).where(eq(accounts.id, accountId));
  const owned = await ctx.db.select({ wallet: teams.ownerAddress }).from(teams).where(and(eq(teams.ownerAccount, accountId), isNotNull(teams.ownerAddress), isNotNull(teams.ownerVerifiedAt)));
  return [...new Set([account?.wallet, ...owned.map(o => o.wallet)].filter((w): w is string => isWalletAddress(w)))].sort();
}

/** Wallets that may own the key's identity: the account's sign-in wallet and the verified owner wallets of organisations it owns. */
export async function ownerWallets(ctx: Ctx, keyHash: string): Promise<string[]> {
  const [k] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  return k ? accountWallets(ctx, k.accountId) : [];
}

/**
 * Owner mode: a transaction for the owner's wallet (`ownerWallet`, else the account's linked wallet). Registrar mode:
 * queue for the agent-identity worker.
 */
export async function requestRegistration(ctx: Ctx, keyHash: string, ownerWallet?: string) {
  const registry = registryOrFail(ctx);
  const [profile] = await ctx.db.select({ slug: agentProfiles.slug }).from(agentProfiles).where(eq(agentProfiles.keyHash, keyHash));
  if (!profile) fail(409, "Publish a public profile for this key before registering an identity.", "profile_required");
  const row = await ensureIdentity(ctx, keyHash);
  if (await optedOut(ctx, keyHash, row)) fail(409, "This key is opted out of identity. Set identity_opt_out to false first.", "identity_opted_out");
  if (row.status === "registered") fail(409, "This key already has a registered identity.", "identity_registered");
  if (row.status === "submitted") fail(409, "A registration transaction is already pending.", "identity_pending");
  const agentURI = registrationUrl(ctx, row.id);
  const mode = ctx.cfg.identity.mode;
  if (mode === "registrar") {
    await ctx.db.update(agentIdentities).set({ status: "queued", mode, registry: registry.id, agentId: null, ownerAddress: null, error: null, txHash: null, updatedAt: new Date() }).where(eq(agentIdentities.keyHash, keyHash));
    return { status: "queued", mode, agent_uri: agentURI, registry: registry.id };
  }
  const wallets = await ownerWallets(ctx, keyHash);
  const owner = ownerWallet ?? wallets[0];
  if (!owner) fail(409, "No wallet to own the identity: sign in with a wallet, or send `owner_wallet` (a base58 Solana address) with the request.", "identity_owner_wallet_required");
  let prepared;
  try {
    prepared = await identityChain(ctx).prepareRegistration(owner, agentURI, receiptKeysUrl(ctx));
  } catch (e) {
    log.warn("identity registration not prepared", { error: (e as Error).message.slice(0, 160) });
    fail(503, "The agent registry could not be reached to prepare the transaction; try again shortly.", "identity_registry_unavailable");
  }
  // The asset keypair signed the transaction and is gone; its public key is the agent id this registration will have.
  await ctx.db.update(agentIdentities).set({ status: "awaiting_owner", mode, registry: registry.id, agentId: prepared.asset, ownerAddress: owner, error: null, txHash: null, updatedAt: new Date() }).where(eq(agentIdentities.keyHash, keyHash));
  return {
    status: "awaiting_owner", mode, agent_uri: agentURI, registry: registry.id, agent_id: prepared.asset,
    transaction: { network: ctx.cfg.chain.network, program_id: registry.programId, fee_payer: prepared.feePayer, transaction: prepared.transaction, expires_at_block_height: prepared.expiresAtBlockHeight, rent_sol: REGISTRATION_RENT_SOL, instructions: prepared.instructions },
    next: "Sign and send this transaction from the wallet that should own the identity before it expires, then POST its signature as tx_hash to /identity/confirm. An expired transaction is replaced by requesting again.",
  };
}

async function recordRegistration(ctx: Ctx, row: IdentityRow, signature: string, r: { agentId: string; owner: string; agentURI: string }) {
  if (r.agentURI !== registrationUrl(ctx, row.id)) return false;
  await ctx.db.update(agentIdentities).set({ status: "registered", agentId: r.agentId, ownerAddress: r.owner, txHash: signature, error: null, updatedAt: new Date() }).where(eq(agentIdentities.keyHash, row.keyHash));
  return true;
}

/** Owner mode: read the owner's transaction and keep the agent id it registered for this key's registration file. */
export async function confirmRegistration(ctx: Ctx, keyHash: string, signature: string) {
  registryOrFail(ctx);
  const row = await identityRow(ctx, keyHash);
  if (!row || row.status !== "awaiting_owner") fail(409, "No owner registration is waiting for this key; request one first.", "identity_not_requested");
  if (await optedOut(ctx, keyHash, row)) fail(409, "This key is opted out of identity.", "identity_opted_out");
  const r = await identityChain(ctx).registration(signature);
  if (r.status === "pending") fail(409, "The transaction is not confirmed yet; try again shortly.", "identity_tx_pending");
  if (r.status === "failed") fail(422, r.reason === "reverted" ? "The transaction failed on chain." : "The transaction did not register an identity in the configured registry.", "identity_tx_invalid");
  if (!await recordRegistration(ctx, row, signature, r)) fail(422, "The transaction registered a different agent URI than this key's registration file.", "identity_uri_mismatch");
  return identitySettingsJson(ctx, keyHash);
}

/**
 * Registrar worker (job agent-identity): confirm submitted registrations, then send queued ones; agent keys first, then
 * network hosts and tool listings (`subjects`, counted apart).
 */
export async function runAgentIdentity(ctx: Ctx, limit = 10) {
  if (!ctx.cfg.identity.enabled || ctx.cfg.identity.mode !== "registrar" || !ctx.cfg.identity.registry.programId) return { skipped: "not configured" };
  const chain = identityChain(ctx);
  let sent = 0, confirmed = 0, failed = 0;
  const submitted = await ctx.db.select().from(agentIdentities).where(eq(agentIdentities.status, "submitted")).limit(limit);
  for (const row of submitted) {
    const r = await chain.registration(row.txHash!);
    if (r.status === "pending") continue;
    if (r.status === "ok" && await recordRegistration(ctx, row, row.txHash!, r)) { confirmed++; continue; }
    failed++;
    await ctx.db.update(agentIdentities).set({ status: "failed", error: r.status === "failed" ? r.reason : "uri_mismatch", updatedAt: new Date() }).where(eq(agentIdentities.keyHash, row.keyHash));
  }
  const queued = await ctx.db.select({ row: agentIdentities }).from(agentIdentities).innerJoin(keys, eq(keys.keyHash, agentIdentities.keyHash))
    .where(and(eq(agentIdentities.status, "queued"), eq(keys.disabled, false))).limit(limit);
  for (const { row } of queued) {
    if (await optedOut(ctx, row.keyHash, row)) continue;
    try {
      const { signature, asset } = await chain.register(registrationUrl(ctx, row.id), receiptKeysUrl(ctx));
      await ctx.db.update(agentIdentities).set({ status: "submitted", txHash: signature, agentId: asset, ownerAddress: ctx.cfg.identity.registrar ?? null, updatedAt: new Date() }).where(and(eq(agentIdentities.keyHash, row.keyHash), eq(agentIdentities.status, "queued")));
      sent++;
    } catch (e) {
      failed++;
      log.warn("identity registration not sent", { error: (e as Error).name });
      await ctx.db.update(agentIdentities).set({ status: "failed", error: "send_failed", updatedAt: new Date() }).where(eq(agentIdentities.keyHash, row.keyHash));
    }
  }
  return { sent, confirmed, failed, subjects: await runSubjectRegistrations(ctx, chain, limit) };
}

/** The links an agent card carries when identity is on and the key has not opted out. */
export async function cardIdentity(ctx: Ctx, keyHash: string, slug: string) {
  const row = await identityRow(ctx, keyHash);
  if (await optedOut(ctx, keyHash, row)) return { opted_out: true as const };
  return {
    card: cardUrl(ctx, slug),
    receipt_keys: receiptKeysUrl(ctx),
    receipt_key_id: ctx.signer.keyId,
    registration: row ? registrationUrl(ctx, row.id) : null,
    // The ERC-8004-compatible record in the Solana Agent Registry: the registry id and the identity asset (agent id).
    erc8004: { registry: ctx.cfg.identity.registry.id, agent_id: row?.status === "registered" ? row.agentId : null, status: row?.status ?? "none" },
  };
}

/** Registration file (ERC-8004 registration-v1) for the public registration URL; null when unknown or opted out. */
export async function registrationFile(ctx: Ctx, id: string) {
  const [row] = await ctx.db.select().from(agentIdentities).where(eq(agentIdentities.id, id));
  if (!row || await optedOut(ctx, row.keyHash, row)) return null;
  const [found] = await ctx.db.select({ profile: agentProfiles }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash))
    .where(and(eq(agentProfiles.keyHash, row.keyHash), eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`));
  const p = found?.profile;
  const services: { name: string; endpoint: string; version?: string }[] = [];
  if (p) {
    services.push({ name: "web", endpoint: `${ctx.cfg.siteUrl}/agents/profile/?id=${p.slug}` }, { name: "trellis-card", endpoint: cardUrl(ctx, p.slug), version: "1" });
    if (p.settings.endpoint) services.push({ name: "agent", endpoint: p.settings.endpoint });
    if (p.settings.payout_wallet) services.push({ name: "agentWallet", endpoint: `${ctx.cfg.chain.network}:${p.settings.payout_wallet}` });
    if (ctx.cfg.identity.paidFeedback && row.reputationOptIn) services.push({ name: "trellis-reputation", endpoint: reputationUrl(ctx, p.slug), version: "1" });
  }
  services.push({ name: "trellis-receipt-keys", endpoint: receiptKeysUrl(ctx) });
  const registry = row.registry ?? ctx.cfg.identity.registry.id;
  return {
    type: REGISTRATION_TYPE,
    name: p?.settings.name ?? "Unlisted agent",
    description: p?.settings.description ?? "",
    services,
    active: !!p,
    registrations: row.status === "registered" && row.agentId && registry ? [{ agentId: row.agentId, agentRegistry: registry }] : [],
    supportedTrust: ctx.cfg.identity.paidFeedback && row.reputationOptIn ? ["reputation"] : [],
    trellis: { notice: "Owner-supplied profile fields. Trellis links its receipt keys and, when the owner opts in, reputation backed by paid receipts. This file does not verify the agent's abilities." },
  };
}

/** Keys (among those given) whose owners opted in to reputation and not out of identity links. */
export async function reputationOptedIn(ctx: Ctx, keyHashes: string[]) {
  if (!keyHashes.length) return new Set<string>();
  const rows = await ctx.db.select({ keyHash: agentIdentities.keyHash }).from(agentIdentities).where(and(inArray(agentIdentities.keyHash, keyHashes), eq(agentIdentities.reputationOptIn, true)));
  return new Set(rows.map(r => r.keyHash));
}
